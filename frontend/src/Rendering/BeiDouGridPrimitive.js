/**
 * BeiDouGridPrimitive.js
 *
 * 基于 Cesium DrawCommand + VertexArray + GPU 实例化绘制的大规模空间格网图元。
 * 在选定矩形区域内按格子宽高(dx,dy,dz)和高度范围(zMin~zMax)生成 3D 格网，
 * 仅保留一个单位格子的几何顶点，其余通过实例矩阵(instance matrix)由 GPU 一次性渲染，支持百万级不卡顿。
 *
 * 使用方式见 map.js showBeiDouGrid() 中大规模分支。
 */

import * as Cesium from 'cesium'

export const SIGNAL_STATION_HARD_LIMIT = 1000

// WebGL 规范保证的每次 instanced draw 最大实例数，超过则分批
const MAX_INSTANCES_PER_DRAW = 65535

/** GLSL smoothstep 等价，用于线框随屏幕尺度混合 */
function smoothStep(edge0, edge1, x) {
  const denom = Math.max(edge1 - edge0, 1e-9)
  const t = Cesium.Math.clamp((x - edge0) / denom, 0.0, 1.0)
  return t * t * (3.0 - 2.0 * t)
}

const scratchTranslation = new Cesium.Matrix4()
const scratchInstanceMatrix = new Cesium.Matrix4()

/**
 * 根据矩形边界和格网参数生成实例矩阵数据与单位几何，供 BeiDouGridPrimitive 使用。
 * 支持按层或按批拆分，减轻单次生成压力。
 *
 * @param {Object} bounds - 矩形范围 { minLon, minLat, maxLon, maxLat }（度）
 * @param {Object} gridParams - { dx, dy, dz, zMin, zMax } 单位：米
 * @param {Object} [options] - { origin: 'minCorner' }
 * @param {number[]} [options.hiddenInstanceIndices] - instanced 模式下：需要隐藏的实例索引（将实例矩阵缩放退化为不可见）。
 * @returns {{ modelMatrix: Cesium.Matrix4, geometry: Cesium.Geometry, matrixData: Float32Array, instanceCount: number, batches: Array<{ matrixData: Float32Array, instanceCount: number }> }}
 */
export function createGridInstancesFromBounds(bounds, gridParams, options = {}) {
  const { dx, dy, dz, zMin, zMax } = gridParams
  if (![dx, dy, dz, zMin, zMax].every(Number.isFinite)) {
    throw new Error('格网参数包含非数值（dx/dy/dz/zMin/zMax）')
  }
  if (dx <= 0 || dy <= 0 || dz <= 0) {
    throw new Error('格网尺寸必须为正数（dx/dy/dz）')
  }
  if (zMax <= zMin) {
    throw new Error('高度范围无效：zMax 必须大于 zMin')
  }

  const centerLatDeg = (bounds.minLat + bounds.maxLat) * 0.5
  const centerLatRad = Cesium.Math.toRadians(centerLatDeg)
  const metersPerDegLat = 111000.0
  const metersPerDegLon = 111000.0 * Math.cos(centerLatRad)

  const rawWidthM = Math.max(0, (bounds.maxLon - bounds.minLon) * metersPerDegLon)
  const rawHeightM = Math.max(0, (bounds.maxLat - bounds.minLat) * metersPerDegLat)

  const gridZ = options.gridZ ?? Math.max(1, Math.ceil((zMax - zMin) / dz))
  const gridX = options.gridX ?? Math.max(1, Math.ceil(rawWidthM / dx))
  const gridY = options.gridY ?? Math.max(1, Math.ceil(rawHeightM / dy))
  const total = gridX * gridY * gridZ
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error('格网规模计算失败（请检查边界与格网尺寸）')
  }

  const originLon = bounds.minLon
  const originLat = bounds.minLat
  // ENU 原点使用“起点地形高度”，确保后续局部 Z 偏移能映射到离地高度语义。
  const originGroundHeight = options.originGroundHeight ?? 0
  const groundHeights = options.groundHeights ?? null

  const colActiveForGround = options.columnActive
  const useColMaskForGround =
    colActiveForGround &&
    (colActiveForGround.length === gridX * gridY ||
      (typeof colActiveForGround.length === 'number' && colActiveForGround.length >= gridX * gridY))

  let groundMin = originGroundHeight
  let groundMax = originGroundHeight
  if (groundHeights && groundHeights.length === gridX * gridY) {
    if (useColMaskForGround) {
      for (let i = 0; i < groundHeights.length; i++) {
        if (colActiveForGround[i] < 0.5) continue
        const h = groundHeights[i]
        if (!Number.isFinite(h)) continue
        if (h < groundMin) groundMin = h
        if (h > groundMax) groundMax = h
      }
    } else {
      for (let i = 0; i < groundHeights.length; i++) {
        const h = groundHeights[i]
        if (!Number.isFinite(h)) continue
        if (h < groundMin) groundMin = h
        if (h > groundMax) groundMax = h
      }
    }
  } else {
    // 若 groundHeights 不合法，则退化为“椭球高度”（groundHeights - originGroundHeight 恒为 0）
    groundMin = originGroundHeight
    groundMax = originGroundHeight
  }

  const originCartesian = Cesium.Cartesian3.fromDegrees(originLon, originLat, originGroundHeight)
  const originENU = Cesium.Transforms.eastNorthUpToFixedFrame(originCartesian)

  const halfWidth = dx * 0.5
  const halfLength = dy * 0.5
  const halfHeight = dz * 0.5

  const boxGeometry = new Cesium.BoxGeometry({
    vertexFormat: Cesium.VertexFormat.POSITION_ONLY,
    minimum: new Cesium.Cartesian3(-halfWidth, -halfLength, -halfHeight),
    maximum: new Cesium.Cartesian3(halfWidth, halfLength, halfHeight)
  })
  const geometry = Cesium.BoxGeometry.createGeometry(boxGeometry)
  if (!geometry) {
    const emptySphere = new Cesium.BoundingSphere(
      Cesium.Matrix4.multiplyByPoint(originENU, Cesium.Cartesian3.ZERO, new Cesium.Cartesian3()),
      1
    )
    return {
      modelMatrix: originENU,
      geometry: null,
      matrixData: new Float32Array(0),
      instanceCount: 0,
      batches: [],
      boundingSphere: emptySphere
    }
  }

  const matrixData = new Float32Array(16 * total)
  const matrixArray = new Float32Array(16)

  // instanced mask: 将特定实例缩放退化为 0，避免在场景中渲染出对应格网。
  const hiddenInstanceFlags =
    Array.isArray(options.hiddenInstanceIndices) && options.hiddenInstanceIndices.length > 0
      ? (() => {
          const flags = new Uint8Array(total)
          for (let i = 0; i < options.hiddenInstanceIndices.length; i++) {
            const idx = options.hiddenInstanceIndices[i]
            if (!Number.isFinite(idx)) continue
            if (idx < 0 || idx >= total) continue
            flags[idx] = 1
          }
          return flags
        })()
      : null

  const colActive = options.columnActive
  const useColMask =
    colActive &&
    (colActive.length === gridX * gridY ||
      (typeof colActive.length === 'number' && colActive.length >= gridX * gridY))

  // 柱被掩膜剔除时：整块柱的 gridZ 个实例共享同一“零缩放”世界矩阵，避免逐层 Matrix4 运算。
  Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.ZERO, scratchTranslation)
  scratchTranslation[0] = 0
  scratchTranslation[5] = 0
  scratchTranslation[10] = 0
  Cesium.Matrix4.multiply(originENU, scratchTranslation, scratchInstanceMatrix)
  const hiddenMatrixFlat = new Float32Array(16)
  Cesium.Matrix4.toArray(scratchInstanceMatrix, hiddenMatrixFlat)

  const planeStride = gridX * gridY
  for (let iy = 0; iy < gridY; iy++) {
    for (let ix = 0; ix < gridX; ix++) {
      const colIndex = iy * gridX + ix
      if (useColMask && colActive[colIndex] < 0.5) {
        const baseCol = iy * gridX + ix
        for (let iz = 0; iz < gridZ; iz++) {
          const instanceIndex = iz * planeStride + baseCol
          matrixData.set(hiddenMatrixFlat, instanceIndex * 16)
        }
        continue
      }

      const localX = (ix + 0.5) * dx
      const localY = (iy + 0.5) * dy
      const groundH =
        groundHeights && groundHeights.length === gridX * gridY
          ? groundHeights[colIndex]
          : originGroundHeight

      for (let iz = 0; iz < gridZ; iz++) {
        const localZ = zMin + (iz + 0.5) * dz + (groundH - originGroundHeight)
        Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(localX, localY, localZ), scratchTranslation)

        const instanceIndex = iz * planeStride + colIndex
        let hide = hiddenInstanceFlags && hiddenInstanceFlags[instanceIndex] === 1
        if (hide) {
          scratchTranslation[0] = 0
          scratchTranslation[5] = 0
          scratchTranslation[10] = 0
        }
        Cesium.Matrix4.multiply(originENU, scratchTranslation, scratchInstanceMatrix)
        Cesium.Matrix4.toArray(scratchInstanceMatrix, matrixArray)
        matrixData.set(matrixArray, instanceIndex * 16)
      }
    }
  }

  const batches = []
  for (let offset = 0; offset < total; offset += MAX_INSTANCES_PER_DRAW) {
    const count = Math.min(MAX_INSTANCES_PER_DRAW, total - offset)
    batches.push({
      matrixData: matrixData.subarray(offset * 16, (offset + count) * 16),
      instanceCount: count
    })
  }

  const centerGroundHeight = (groundMin + groundMax) * 0.5
  const localCenter = new Cesium.Cartesian3(
    gridX * dx * 0.5,
    gridY * dy * 0.5,
    // zMin: 离地基准；(groundMax/Min) 用于近似覆盖贴地起伏
    zMin + (gridZ * dz) * 0.5 + (centerGroundHeight - originGroundHeight)
  )
  const worldCenter = Cesium.Matrix4.multiplyByPoint(
    originENU,
    localCenter,
    new Cesium.Cartesian3()
  )
  const halfDiag = Math.sqrt(
    (gridX * dx) ** 2 +
      (gridY * dy) ** 2 +
      // 考虑地形起伏：z 总范围 = 网格高度 + groundHeight(最大-最小)
      ((gridZ * dz + (groundMax - groundMin)) ** 2)
  ) * 0.5
  const boundingSphere = new Cesium.BoundingSphere(worldCenter, halfDiag)

  return {
    modelMatrix: originENU,
    geometry,
    matrixData,
    instanceCount: total,
    batches,
    boundingSphere
  }
}

// 不声明 czm_viewProjection，由 Cesium ShaderSource 自动注入
const VS_SOURCE = `
attribute vec3 position;
attribute vec4 instanceMatrix0;
attribute vec4 instanceMatrix1;
attribute vec4 instanceMatrix2;
attribute vec4 instanceMatrix3;
attribute float instanceVisible;
varying vec3 v_localPos;
varying float v_instanceVisible;
varying vec3 v_worldCenter;
void main() {
  mat4 instanceMatrix = mat4(instanceMatrix0, instanceMatrix1, instanceMatrix2, instanceMatrix3);
  v_localPos = position;
  v_instanceVisible = instanceVisible;
  v_worldCenter = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  gl_Position = czm_viewProjection * instanceMatrix * vec4(position, 1.0);
}
`

// 线框：优先「盒体 + 片元 fwidth」实现近似像素恒定线宽（无额外线段几何，适合百万实例）。
// 备选为物体空间 edgeRatio（无 OES_standard_derivatives / 非 WEBGL_2 时回退）。
// 显式线段 + NDC 扩展（每盒 12 边）几何量约为当前方案的十余倍，未采用。
const FS_SOURCE = `
#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif
precision mediump float;
uniform vec4 u_fillColor;
uniform vec4 u_outlineColor;
uniform vec3 u_halfSize;
uniform float u_wireframeShow;
uniform float u_wireframeEdgeRatio;
uniform float u_lineWidthPx;
uniform float u_outlineMix;
varying vec3 v_localPos;
varying float v_instanceVisible;
varying vec3 v_worldCenter;

// signal strength uniforms (FSPL-based)
#define MAX_SIGNAL_STATIONS ${SIGNAL_STATION_HARD_LIMIT}
uniform float u_signalMode;
uniform float u_signalAlpha;
uniform float u_freqMHz;
uniform float u_minDistM;
uniform float u_maxDistM;
uniform float u_signalGamma;
uniform float u_signalBands;
uniform float u_eirpDbm;
uniform float u_rxGainDbi;
uniform float u_miscLossDb;
uniform float u_stationCount;
uniform vec3 u_stationPositions[MAX_SIGNAL_STATIONS];

float edgeMaskFromLocalPos(vec3 localPos, vec3 halfSize, float edgeRatio) {
  vec3 safeHalf = max(halfSize, vec3(0.0001));
  vec3 n = abs(localPos) / safeHalf;
  vec3 nearEdge = step(vec3(1.0 - edgeRatio), n);
  float edgeOnXFace = nearEdge.x * max(nearEdge.y, nearEdge.z);
  float edgeOnYFace = nearEdge.y * max(nearEdge.x, nearEdge.z);
  float edgeOnZFace = nearEdge.z * max(nearEdge.x, nearEdge.y);
  return clamp(max(edgeOnXFace, max(edgeOnYFace, edgeOnZFace)), 0.0, 1.0);
}

#if defined(WEBGL_2) || defined(GL_OES_standard_derivatives)
float edgeMaskScreenSpace(vec3 localPos, vec3 halfSize, float lineWidthPx) {
  vec3 safeHalf = max(halfSize, vec3(0.0001));
  vec3 ax = abs(localPos);
  vec3 n = ax / safeHalf;
  float distRim;
  if (n.x >= n.y && n.x >= n.z) {
    distRim = min(safeHalf.y - ax.y, safeHalf.z - ax.z);
  } else if (n.y >= n.x && n.y >= n.z) {
    distRim = min(safeHalf.x - ax.x, safeHalf.z - ax.z);
  } else {
    distRim = min(safeHalf.x - ax.x, safeHalf.y - ax.y);
  }
  distRim = max(distRim, 0.0);
  float dw = fwidth(distRim);
  dw = max(dw, 1e-6);
  float pxDist = distRim / dw;
  float halfW = lineWidthPx * 0.5;
  return clamp(1.0 - smoothstep(halfW - 0.5, halfW + 1.0, pxDist), 0.0, 1.0);
}
#endif

void main() {
  if (v_instanceVisible < 0.5) discard;
  float edgeMask;
#if defined(WEBGL_2) || defined(GL_OES_standard_derivatives)
  edgeMask = edgeMaskScreenSpace(v_localPos, u_halfSize, u_lineWidthPx) * u_wireframeShow;
#else
  edgeMask = edgeMaskFromLocalPos(v_localPos, u_halfSize, u_wireframeEdgeRatio) * u_wireframeShow;
#endif
  vec4 baseFill = u_fillColor;
  if (u_signalMode > 0.5) {
    float bestD = 1e20;
    float dMin = max(u_minDistM, 0.1);
    float dMax = max(u_maxDistM, dMin + 0.1);
    float count = clamp(u_stationCount, 0.0, float(MAX_SIGNAL_STATIONS));
    for (int i = 0; i < MAX_SIGNAL_STATIONS; i++) {
      if (float(i) >= count) break;
      vec3 s = u_stationPositions[i];
      float di = length(v_worldCenter - s);
      bestD = min(bestD, di);
    }
    bestD = clamp(bestD, dMin, dMax);
    // 对数距离映射：避免把「最强」锚在过近距离时，绝大部分格元都挤在红色端
    float tMap = 1.0 - (log(bestD / dMin) / max(1e-6, log(dMax / dMin)));
    tMap = clamp(tMap, 0.0, 1.0);
    float g = max(u_signalGamma, 0.2);
    tMap = pow(max(tMap, 1e-5), g);
    if (u_signalBands >= 1.5) {
      float n = floor(u_signalBands + 0.5);
      tMap = floor(tMap * n) / max(n - 1.0, 1.0);
    }
    vec3 col = mix(vec3(0.96, 0.35, 0.35), vec3(0.22, 0.78, 0.36), tMap);
    baseFill = vec4(col, clamp(u_signalAlpha, 0.0, 1.0));
  }
  float outlineW = clamp(u_outlineMix, 0.0, 1.0);
  vec4 mixedColor = mix(baseFill, u_outlineColor, edgeMask * outlineW);
  gl_FragColor = mixedColor;
}
`

// GPU 拾取：WebGL2，片元输出 instanceId+1 编码为 RGB
const PICK_VS_SOURCE = `
attribute vec3 position;
attribute vec4 instanceMatrix0;
attribute vec4 instanceMatrix1;
attribute vec4 instanceMatrix2;
attribute vec4 instanceMatrix3;
uniform mat4 u_viewProjection;
uniform float u_batchBaseInstanceId;
varying float v_instanceId;
void main() {
  mat4 instanceMatrix = mat4(instanceMatrix0, instanceMatrix1, instanceMatrix2, instanceMatrix3);
  gl_Position = u_viewProjection * instanceMatrix * vec4(position, 1.0);
  v_instanceId = u_batchBaseInstanceId + float(gl_InstanceID);
}
`

// WebGL1：无 gl_InstanceID，用 attribute 传入 instanceId
const PICK_VS_SOURCE_WEBGL1 = `
attribute vec3 position;
attribute vec4 instanceMatrix0;
attribute vec4 instanceMatrix1;
attribute vec4 instanceMatrix2;
attribute vec4 instanceMatrix3;
attribute float a_instanceId;
uniform mat4 u_viewProjection;
varying float v_instanceId;
void main() {
  mat4 instanceMatrix = mat4(instanceMatrix0, instanceMatrix1, instanceMatrix2, instanceMatrix3);
  gl_Position = u_viewProjection * instanceMatrix * vec4(position, 1.0);
  v_instanceId = a_instanceId;
}
`

const PICK_FS_SOURCE = `
precision highp float;
varying float v_instanceId;
void main() {
  float id = v_instanceId + 1.0;
  float r = floor(mod(id, 256.0)) / 255.0;
  float g = floor(mod(id / 256.0, 256.0)) / 255.0;
  float b = floor(mod(id / 65536.0, 256.0)) / 255.0;
  gl_FragColor = vec4(r, g, b, 1.0);
}
`

const INSTANCE_ID_ATTRIB_LOCATION = 6

function createPickShaderProgram(gl, webgl1) {
  const vsSource = webgl1 ? PICK_VS_SOURCE_WEBGL1 : PICK_VS_SOURCE
  const vs = gl.createShader(gl.VERTEX_SHADER)
  gl.shaderSource(vs, vsSource)
  gl.compileShader(vs)
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    console.error('[BeiDouGridPrimitive] Pick VS compile:', gl.getShaderInfoLog(vs))
    gl.deleteShader(vs)
    return null
  }
  const fs = gl.createShader(gl.FRAGMENT_SHADER)
  gl.shaderSource(fs, PICK_FS_SOURCE)
  gl.compileShader(fs)
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    console.error('[BeiDouGridPrimitive] Pick FS compile:', gl.getShaderInfoLog(fs))
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    return null
  }
  const program = gl.createProgram()
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.bindAttribLocation(program, 0, 'position')
  gl.bindAttribLocation(program, 2, 'instanceMatrix0')
  gl.bindAttribLocation(program, 3, 'instanceMatrix1')
  gl.bindAttribLocation(program, 4, 'instanceMatrix2')
  gl.bindAttribLocation(program, 5, 'instanceMatrix3')
  if (webgl1) gl.bindAttribLocation(program, INSTANCE_ID_ATTRIB_LOCATION, 'a_instanceId')
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('[BeiDouGridPrimitive] Pick program link:', gl.getProgramInfoLog(program))
    gl.deleteProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    return null
  }
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  return program
}

/**
 * 大规模北斗格网图元：单几何 + 实例矩阵数组，GPU 实例化绘制。
 */
export class BeiDouGridPrimitive {
  constructor(modelMatrix, _unused, geometry, options = {}) {
    this._modelMatrix = modelMatrix
    this._geometry = geometry
    this._scene = options.scene
    this._matrixData = options.matrixData
    this._instanceCount = options.instanceCount
    this._batches = options.batches || []
    this._boundingSphere = options.boundingSphere || null
    this._wireframe = options.wireframe || {}
    this._debug = !!options.debug

    this.show = true
    this._commandList = []
    this._ready = false
    this._destroyed = false
    this._batchBaseIndices = []
    this._pickReady = false
    this._pickFbo = null
    this._pickTexture = null
    this._pickDepth = null
    this._pickShaderProgram = null
    this._pickVertexArrays = []
    this._pickPositionBuffer = null
    this._pickIndexBuffer = null
    this._pickWebGL1 = false
    this._pickVaoExt = null
    this._pickInstancedExt = null
    this._visibilityByBatch = []
    this._visibilityBuffers = []
    this._signal = {
      enabled: false,
      alpha: 0.12,
      freqMHz: 1400.0,
      minDistM: 120.0,
      maxDistM: 5000.0,
      signalGamma: 0.4,
      signalBands: 0.0,
      eirpDbm: 43.0,
      rxGainDbi: 0.0,
      miscLossDb: 0.0,
      stationsEcef: []
    }
    this._signalUniformStations = new Array(SIGNAL_STATION_HARD_LIMIT)
    for (let i = 0; i < SIGNAL_STATION_HARD_LIMIT; i++) {
      this._signalUniformStations[i] = new Cesium.Cartesian3(0.0, 0.0, 0.0)
    }
    /** 线框在 mix 中的权重上限，每帧由屏幕尺度更新 */
    this._outlineMix = 1.0
  }

  get isDestroyed() {
    return this._destroyed
  }

  get ready() {
    return this._ready
  }

  setWireframeStyle(style = {}) {
    if (!this._wireframe) this._wireframe = {}
    if (style.color instanceof Cesium.Color) this._wireframe.color = style.color
    if (style.fillColor instanceof Cesium.Color) this._wireframe.fillColor = style.fillColor
    if (typeof style.show === 'boolean') this._wireframe.show = style.show
    if (Number.isFinite(style.edgeRatio)) {
      this._wireframe.edgeRatio = Cesium.Math.clamp(style.edgeRatio, 0.005, 0.2)
    }
    if (Number.isFinite(style.lineWidthPx)) {
      this._wireframe.lineWidthPx = Cesium.Math.clamp(style.lineWidthPx, 0.5, 8.0)
    }
    if (typeof style.outlineScreenFadeEnabled === 'boolean') {
      this._wireframe.outlineScreenFadeEnabled = style.outlineScreenFadeEnabled
    }
    if (Number.isFinite(style.outlineScreenPxMin)) {
      this._wireframe.outlineScreenPxMin = Math.max(1.0, style.outlineScreenPxMin)
    }
    if (Number.isFinite(style.outlineScreenPxMax)) {
      this._wireframe.outlineScreenPxMax = Math.max(1.0, style.outlineScreenPxMax)
    }
    const wMin = this._wireframe.outlineScreenPxMin
    const wMax = this._wireframe.outlineScreenPxMax
    if (Number.isFinite(wMin) && Number.isFinite(wMax) && wMin >= wMax) {
      this._wireframe.outlineScreenPxMax = wMin + 1.0
    }
  }

  setSignalParams(params = {}) {
    if (!this._signal) this._signal = {}
    if (typeof params.enabled === 'boolean') this._signal.enabled = params.enabled
    if (Number.isFinite(params.alpha)) this._signal.alpha = Cesium.Math.clamp(params.alpha, 0.0, 1.0)
    if (Number.isFinite(params.freqMHz)) this._signal.freqMHz = Math.max(1.0, params.freqMHz)
    if (Number.isFinite(params.minDistM)) this._signal.minDistM = Math.max(0.1, params.minDistM)
    if (Number.isFinite(params.maxDistM)) this._signal.maxDistM = Math.max(this._signal.minDistM + 0.1, params.maxDistM)
    if (Number.isFinite(params.signalGamma)) {
      this._signal.signalGamma = Cesium.Math.clamp(params.signalGamma, 0.25, 3.0)
    }
    if (Number.isFinite(params.signalBands)) {
      this._signal.signalBands = Cesium.Math.clamp(params.signalBands, 0.0, 16.0)
    }
    if (Number.isFinite(params.eirpDbm)) {
      this._signal.eirpDbm = Cesium.Math.clamp(params.eirpDbm, -60.0, 90.0)
    }
    if (Number.isFinite(params.rxGainDbi)) {
      this._signal.rxGainDbi = Cesium.Math.clamp(params.rxGainDbi, -20.0, 40.0)
    }
    if (Number.isFinite(params.miscLossDb)) {
      this._signal.miscLossDb = Cesium.Math.clamp(params.miscLossDb, 0.0, 80.0)
    }
    if (Array.isArray(params.stationsEcef)) {
      const out = []
      for (let i = 0; i < params.stationsEcef.length && out.length < SIGNAL_STATION_HARD_LIMIT; i++) {
        const p = params.stationsEcef[i]
        if (!p) continue
        const x = Number(p.x)
        const y = Number(p.y)
        const z = Number(p.z)
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
        out.push(new Cesium.Cartesian3(x, y, z))
      }
      this._signal.stationsEcef = out
      for (let i = 0; i < SIGNAL_STATION_HARD_LIMIT; i++) {
        const src = out[i]
        const dst = this._signalUniformStations[i]
        if (src) {
          dst.x = src.x
          dst.y = src.y
          dst.z = src.z
        } else {
          dst.x = 0.0
          dst.y = 0.0
          dst.z = 0.0
        }
      }
    }
  }

  _ensureBoundingSphere() {
    if (this._boundingSphere) return
    if (!this._modelMatrix) return
    const origin = new Cesium.Cartesian3()
    Cesium.Matrix4.getTranslation(this._modelMatrix, origin)
    this._boundingSphere = new Cesium.BoundingSphere(origin, 1e6)
  }

  _buildPickResources(context) {
    if (this._pickReady || !this._geometry || !this._batches?.length) return
    let gl = context._gl || context.gl || context
    for (const key of ['_gl', 'gl']) {
      if (context[key]) {
        gl = context[key]
        break
      }
    }
    if (!gl) return

    const hasNativeVAO = typeof gl.createVertexArray === 'function'
    let vaoExt = null
    let instancedExt = null
    if (!hasNativeVAO) {
      vaoExt = gl.getExtension('OES_vertex_array_object')
      instancedExt = gl.getExtension('ANGLE_instanced_arrays')
      if (!vaoExt || !instancedExt) {
        return
      }
      this._pickWebGL1 = true
      this._pickVaoExt = vaoExt
      this._pickInstancedExt = instancedExt
    }

    const webgl1 = this._pickWebGL1
    this._pickShaderProgram = createPickShaderProgram(gl, webgl1)
    if (!this._pickShaderProgram) return

    const posAttr = this._geometry.attributes.position
    if (!posAttr || !posAttr.values) return
    const positions = posAttr.values
    const isDouble = posAttr.componentDatatype === Cesium.ComponentDatatype.DOUBLE
    const posF32 = isDouble ? new Float32Array(positions.length) : positions
    if (isDouble) {
      for (let i = 0; i < positions.length; i++) posF32[i] = positions[i]
    }
    this._pickPositionBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this._pickPositionBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, posF32, gl.STATIC_DRAW)

    const indices = this._geometry.indices
    this._pickIndexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._pickIndexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)
    const indexCount = indices.length
    const indexType = indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT

    const stride = 16 * 4
    const bindVao = (vao) => {
      if (hasNativeVAO) gl.bindVertexArray(vao)
      else if (vaoExt) vaoExt.bindVertexArrayOES(vao)
    }
    const createVao = () => (hasNativeVAO ? gl.createVertexArray() : vaoExt.createVertexArrayOES())

    for (let b = 0; b < this._batches.length; b++) {
      const batch = this._batches[b]
      const instanceBuffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, batch.matrixData, gl.STATIC_DRAW)

      let instanceIdBuffer = null
      if (webgl1) {
        const base = this._batchBaseIndices[b]
        const ids = new Float32Array(batch.instanceCount)
        for (let i = 0; i < batch.instanceCount; i++) ids[i] = base + i
        instanceIdBuffer = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, instanceIdBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, ids, gl.STATIC_DRAW)
      }

      const vao = createVao()
      bindVao(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this._pickPositionBuffer)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer)
      for (let row = 0; row < 4; row++) {
        const loc = 2 + row
        gl.enableVertexAttribArray(loc)
        gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, stride, row * 16)
        this._setAttribDivisor(gl, loc, 1)
    }
      if (webgl1 && instanceIdBuffer) {
        gl.bindBuffer(gl.ARRAY_BUFFER, instanceIdBuffer)
        gl.enableVertexAttribArray(INSTANCE_ID_ATTRIB_LOCATION)
        gl.vertexAttribPointer(INSTANCE_ID_ATTRIB_LOCATION, 1, gl.FLOAT, false, 0, 0)
        this._setAttribDivisor(gl, INSTANCE_ID_ATTRIB_LOCATION, 1)
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._pickIndexBuffer)
      bindVao(null)
      this._pickVertexArrays.push({
        vao,
        instanceBuffer,
        instanceIdBuffer,
        instanceCount: batch.instanceCount,
        indexCount,
        indexType
      })
    }
    this._pickReady = true
  }

  _setAttribDivisor(gl, index, divisor) {
    if (typeof gl.vertexAttribDivisor === 'function') {
      gl.vertexAttribDivisor(index, divisor)
    } else if (this._pickInstancedExt) {
      this._pickInstancedExt.vertexAttribDivisorANGLE(index, divisor)
    }
  }

  _ensurePickFbo(gl, width, height) {
    if (this._pickFbo && this._pickWidth === width && this._pickHeight === height) return
    this._releasePickFbo(gl)
    this._pickWidth = width
    this._pickHeight = height
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    const depth = gl.createRenderbuffer()
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth)
    const depthFormat = gl.DEPTH_COMPONENT16 || gl.DEPTH_COMPONENT
    gl.renderbufferStorage(gl.RENDERBUFFER, depthFormat, width, height)
    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.deleteFramebuffer(fbo)
      gl.deleteTexture(tex)
      gl.deleteRenderbuffer(depth)
      return
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this._pickTexture = tex
    this._pickDepth = depth
    this._pickFbo = fbo
  }

  _releasePickFbo(gl) {
    if (!gl) return
    if (this._pickFbo) {
      gl.deleteFramebuffer(this._pickFbo)
      this._pickFbo = null
    }
    if (this._pickTexture) {
      gl.deleteTexture(this._pickTexture)
      this._pickTexture = null
    }
    if (this._pickDepth) {
      gl.deleteRenderbuffer(this._pickDepth)
      this._pickDepth = null
    }
  }

  _buildResources(context) {
    if (!this._geometry || !this._batches?.length) return

    const posAttr = this._geometry.attributes.position
    if (!posAttr || !posAttr.values) return

    const positions = posAttr.values
    const isDouble = posAttr.componentDatatype === Cesium.ComponentDatatype.DOUBLE
    const posF32 = isDouble
      ? new Float32Array(positions.length)
      : positions
    if (isDouble) {
      for (let i = 0; i < positions.length; i++) posF32[i] = positions[i]
    }

    const positionBuffer = Cesium.Buffer.createVertexBuffer({
      context,
      typedArray: posF32,
      usage: Cesium.BufferUsage.STATIC_DRAW
    })

    const indices = this._geometry.indices
    const indexBuffer = Cesium.Buffer.createIndexBuffer({
      context,
      typedArray: indices,
      usage: Cesium.BufferUsage.STATIC_DRAW,
      indexDatatype:
        indices instanceof Uint32Array
          ? Cesium.IndexDatatype.UNSIGNED_INT
          : Cesium.IndexDatatype.UNSIGNED_SHORT
    })

    const attributeLocations = {
      position: 0,
      instanceMatrix0: 2,
      instanceMatrix1: 3,
      instanceMatrix2: 4,
      instanceMatrix3: 5,
      instanceVisible: 6
    }

    // 使用 ShaderSource 以确保 Cesium 内置变量（czm_*）与默认 precision/defines 正确注入
    const vertexShaderSource = new Cesium.ShaderSource({
      sources: [VS_SOURCE]
    })
    const fragmentShaderSource = new Cesium.ShaderSource({
      sources: [FS_SOURCE]
    })

    const shaderProgram = context.shaderCache.getShaderProgram({
      context,
      vertexShaderSource,
      fragmentShaderSource,
      attributeLocations
    })

    const wireframe = this._wireframe || {}
    const fillColor =
      wireframe.fillColor instanceof Cesium.Color
        ? wireframe.fillColor
        : new Cesium.Color(0.0, 0.9, 1.0, 0.25)
    const outlineColor =
      wireframe.color instanceof Cesium.Color
        ? wireframe.color
        : Cesium.Color.BLACK.withAlpha(0.7)
    const halfSize = wireframe.halfSize instanceof Cesium.Cartesian3
      ? wireframe.halfSize
      : new Cesium.Cartesian3(50.0, 50.0, 25.0)
    const edgeRatio = Number.isFinite(wireframe.edgeRatio)
      ? Cesium.Math.clamp(wireframe.edgeRatio, 0.005, 0.2)
      : 0.04
    const lineWidthPxDefault = Number.isFinite(wireframe.lineWidthPx)
      ? Cesium.Math.clamp(wireframe.lineWidthPx, 0.5, 8.0)
      : 1.25

    const uniformMap = {
      u_fillColor: () => {
        return this._wireframe?.fillColor || fillColor
      },
      u_outlineColor: () => {
        return this._wireframe?.color || outlineColor
      },
      u_halfSize: () => {
        return this._wireframe?.halfSize || halfSize
      },
      u_wireframeShow: () => {
        return this._wireframe?.show === false ? 0.0 : 1.0
      },
      u_wireframeEdgeRatio: () => {
        const ratio = this._wireframe?.edgeRatio
        return Number.isFinite(ratio) ? Cesium.Math.clamp(ratio, 0.005, 0.2) : edgeRatio
      },
      u_lineWidthPx: () => {
        const w = this._wireframe?.lineWidthPx
        return Number.isFinite(w) ? Cesium.Math.clamp(w, 0.5, 8.0) : lineWidthPxDefault
      },
      u_outlineMix: () => {
        const m = this._outlineMix
        return Number.isFinite(m) ? Cesium.Math.clamp(m, 0.0, 1.0) : 1.0
      },
      u_signalMode: () => {
        return this._signal?.enabled ? 1.0 : 0.0
      },
      u_signalAlpha: () => {
        const a = this._signal?.alpha
        return Number.isFinite(a) ? Cesium.Math.clamp(a, 0.0, 1.0) : 0.12
      },
      u_freqMHz: () => {
        const f = this._signal?.freqMHz
        return Number.isFinite(f) ? Math.max(1.0, f) : 1400.0
      },
      u_minDistM: () => {
        const d = this._signal?.minDistM
        return Number.isFinite(d) ? Math.max(0.1, d) : 120.0
      },
      u_maxDistM: () => {
        const d = this._signal?.maxDistM
        const minD = Number.isFinite(this._signal?.minDistM) ? Math.max(0.1, this._signal.minDistM) : 10.0
        return Number.isFinite(d) ? Math.max(minD + 0.1, d) : 5000.0
      },
      u_signalGamma: () => {
        const g = this._signal?.signalGamma
        return Number.isFinite(g) ? Cesium.Math.clamp(g, 0.25, 3.0) : 0.4
      },
      u_signalBands: () => {
        const b = this._signal?.signalBands
        return Number.isFinite(b) ? Cesium.Math.clamp(b, 0.0, 16.0) : 0.0
      },
      u_eirpDbm: () => {
        const v = this._signal?.eirpDbm
        return Number.isFinite(v) ? Cesium.Math.clamp(v, -60.0, 90.0) : 43.0
      },
      u_rxGainDbi: () => {
        const v = this._signal?.rxGainDbi
        return Number.isFinite(v) ? Cesium.Math.clamp(v, -20.0, 40.0) : 0.0
      },
      u_miscLossDb: () => {
        const v = this._signal?.miscLossDb
        return Number.isFinite(v) ? Cesium.Math.clamp(v, 0.0, 80.0) : 0.0
      },
      u_stationCount: () => {
        const n = this._signal?.stationsEcef?.length || 0
        return Math.max(0.0, Math.min(SIGNAL_STATION_HARD_LIMIT, n))
      },
      u_stationPositions: () => {
        return this._signalUniformStations
      }
    }

    const renderState = Cesium.RenderState.fromCache({
      depthTest: { enabled: true },
      depthMask: false,
      blending: {
        enabled: true,
        equationRgb: Cesium.WebGLConstants.FUNC_ADD,
        equationAlpha: Cesium.WebGLConstants.FUNC_ADD,
        functionSourceRgb: Cesium.WebGLConstants.SRC_ALPHA,
        functionSourceAlpha: Cesium.WebGLConstants.SRC_ALPHA,
        functionDestinationRgb: Cesium.WebGLConstants.ONE_MINUS_SRC_ALPHA,
        functionDestinationAlpha: Cesium.WebGLConstants.ONE_MINUS_SRC_ALPHA
      }
    })

    this._commandList = []
    this._visibilityByBatch = []
    this._visibilityBuffers = []
    const componentDatatype = Cesium.ComponentDatatype.FLOAT
    const stride = 16 * 4

    for (let b = 0; b < this._batches.length; b++) {
      const batch = this._batches[b]
      const instanceBuffer = Cesium.Buffer.createVertexBuffer({
        context,
        typedArray: batch.matrixData,
        usage: Cesium.BufferUsage.STATIC_DRAW
      })
      const visibilityArray = new Float32Array(batch.instanceCount)
      visibilityArray.fill(1.0)
      const visibilityBuffer = Cesium.Buffer.createVertexBuffer({
        context,
        typedArray: visibilityArray,
        usage: Cesium.BufferUsage.DYNAMIC_DRAW
      })
      this._visibilityByBatch.push(visibilityArray)
      this._visibilityBuffers.push(visibilityBuffer)

      const attributes = [
        {
          index: 0,
          vertexBuffer: positionBuffer,
          componentDatatype,
          componentsPerAttribute: 3
        },
        {
          index: 2,
          vertexBuffer: instanceBuffer,
          componentDatatype,
          componentsPerAttribute: 4,
          offsetInBytes: 0,
          strideInBytes: stride,
          instanceDivisor: 1
        },
        {
          index: 3,
          vertexBuffer: instanceBuffer,
          componentDatatype,
          componentsPerAttribute: 4,
          offsetInBytes: 16,
          strideInBytes: stride,
          instanceDivisor: 1
        },
        {
          index: 4,
          vertexBuffer: instanceBuffer,
          componentDatatype,
          componentsPerAttribute: 4,
          offsetInBytes: 32,
          strideInBytes: stride,
          instanceDivisor: 1
        },
        {
          index: 5,
          vertexBuffer: instanceBuffer,
          componentDatatype,
          componentsPerAttribute: 4,
          offsetInBytes: 48,
          strideInBytes: stride,
          instanceDivisor: 1
        },
        {
          index: 6,
          vertexBuffer: visibilityBuffer,
          componentDatatype,
          componentsPerAttribute: 1,
          offsetInBytes: 0,
          strideInBytes: 4,
          instanceDivisor: 1
        }
      ]

      const vertexArray = new Cesium.VertexArray({
        context,
        attributes,
        indexBuffer
      })

      const command = new Cesium.DrawCommand({
        boundingVolume: this._boundingSphere,
        modelMatrix: Cesium.Matrix4.IDENTITY,
        primitiveType: Cesium.PrimitiveType.TRIANGLES,
        vertexArray,
        count: indexBuffer.numberOfIndices,
        instanceCount: batch.instanceCount,
        shaderProgram,
        uniformMap: { ...uniformMap },
        renderState,
        pass: Cesium.Pass.TRANSLUCENT,
        cull: true,
        occlude: true
      })
      this._commandList.push(command)
    }

    let base = 0
    this._batchBaseIndices = this._batches.map((batch) => {
      const b = base
      base += batch.instanceCount
      return b
    })

    this._ready = true
  }

  _syncVisibilityBatch(batchIndex) {
    const buffer = this._visibilityBuffers?.[batchIndex]
    const values = this._visibilityByBatch?.[batchIndex]
    if (!buffer || !values) return
    try {
      buffer.copyFromArrayView(values)
    } catch (e) {
      // ignore
    }
  }

  setAllInstancesVisibility(visible) {
    const value = visible ? 1.0 : 0.0
    for (let b = 0; b < this._visibilityByBatch.length; b++) {
      this._visibilityByBatch[b].fill(value)
      this._syncVisibilityBatch(b)
    }
  }

  setInstancesVisibilityByIndices(indices, visible) {
    if (!Array.isArray(indices) && !(indices instanceof Uint32Array) && !(indices instanceof Int32Array)) return
    const value = visible ? 1.0 : 0.0
    const changedBatches = new Set()
    for (let i = 0; i < indices.length; i++) {
      const globalIndex = indices[i]
      if (!Number.isFinite(globalIndex) || globalIndex < 0 || globalIndex >= this._instanceCount) continue
      const batchIndex = Math.floor(globalIndex / MAX_INSTANCES_PER_DRAW)
      const localIndex = globalIndex - batchIndex * MAX_INSTANCES_PER_DRAW
      const batchValues = this._visibilityByBatch[batchIndex]
      if (!batchValues || localIndex >= batchValues.length) continue
      batchValues[localIndex] = value
      changedBatches.add(batchIndex)
    }
    changedBatches.forEach((b) => this._syncVisibilityBatch(b))
  }

  /**
   * 按典型格元在屏幕上的近似像素宽度调制线框 mix，缓解密格「屏上密纹」。
   * @param {*} frameState - Cesium FrameState
   */
  _updateOutlineMixForScreenScale(frameState) {
    const wf = this._wireframe
    if (wf?.outlineScreenFadeEnabled === false) {
      this._outlineMix = 1.0
      return
    }
    this._ensureBoundingSphere()
    const sphere = this._boundingSphere
    const camera = frameState.camera
    const context = frameState.context
    if (!sphere || !camera || !context) {
      this._outlineMix = 1.0
      return
    }
    const frustum = camera.frustum
    if (!(frustum instanceof Cesium.PerspectiveFrustum)) {
      this._outlineMix = 1.0
      return
    }
    const fovy = frustum.fovy
    if (!Number.isFinite(fovy) || fovy <= 0.0) {
      this._outlineMix = 1.0
      return
    }
    const canvasHeight = context.drawingBufferHeight
    if (!Number.isFinite(canvasHeight) || canvasHeight <= 0.0) {
      this._outlineMix = 1.0
      return
    }
    const dist = Math.max(
      Cesium.Cartesian3.distance(camera.positionWC, sphere.center),
      1.0
    )
    const tanHalf = Math.tan(fovy * 0.5)
    if (!Number.isFinite(tanHalf) || tanHalf <= 1e-12) {
      this._outlineMix = 1.0
      return
    }
    const pixelsPerMeter = canvasHeight * 0.5 / (dist * tanHalf)
    const half = wf?.halfSize
    let cellSizeM = 1.0
    if (half instanceof Cesium.Cartesian3) {
      cellSizeM = 2.0 * Math.max(Math.abs(half.x), Math.abs(half.y))
    }
    if (!Number.isFinite(cellSizeM) || cellSizeM <= 0.0) {
      cellSizeM = 1.0
    }
    const cellPx = cellSizeM * pixelsPerMeter
    let pxMin = Number.isFinite(wf?.outlineScreenPxMin) ? wf.outlineScreenPxMin : 10.0
    let pxMax = Number.isFinite(wf?.outlineScreenPxMax) ? wf.outlineScreenPxMax : 32.0
    pxMin = Math.max(1.0, pxMin)
    pxMax = Math.max(pxMin + 1.0, pxMax)
    this._outlineMix = smoothStep(pxMin, pxMax, cellPx)
  }

  update(frameState) {
    if (this._destroyed || !this.show) return
    if (!frameState.passes.render) return
    if (!this._geometry || !this._batches?.length) return

    const context = frameState.context
    if (!context.instancedArrays) return

    if (!this._ready) {
      this._ensureBoundingSphere()
      this._buildResources(context)
    }
    if (!this._ready || !this._commandList.length) return

    this._updateOutlineMixForScreenScale(frameState)

    const commandList = frameState.commandList
    for (let i = 0; i < this._commandList.length; i++) {
      const cmd = this._commandList[i]
      cmd.boundingVolume = this._boundingSphere
      commandList.push(cmd)
    }
  }

  /**
   * GPU 拾取：在给定屏幕坐标处渲染 ID 缓冲并读回命中的 instance 索引。
   * @param {Cesium.Scene} scene - 当前场景（用于 context 与相机）
   * @param {number} x - 屏幕 x（canvas 内坐标，与 movement.position.x 一致）
   * @param {number} y - 屏幕 y（canvas 内坐标，原点在左上）
   * @returns {number} 命中的 globalInstanceId（0 到 instanceCount-1），未命中返回 -1
   */
  pick(scene, x, y) {
    if (this._destroyed || !scene) return -1
    const context = scene.context || scene._context
    if (!context) {
      if (this._debug) console.warn('[BeiDouGridPrimitive] pick: no scene context')
      return -1
    }
    let gl = context._gl || context.gl || context
    for (const key of ['_gl', 'gl']) {
      if (context[key]) {
        gl = context[key]
        break
      }
    }
    if (!gl) {
      if (this._debug) console.warn('[BeiDouGridPrimitive] pick: no WebGL context')
      return -1
    }

    if (!this._ready) {
      this._ensureBoundingSphere()
      this._buildResources(context)
    }
    if (!this._ready || !this._batches?.length || !this._batchBaseIndices?.length) return -1

    this._buildPickResources(context)
    if (!this._pickReady || !this._pickShaderProgram || !this._pickVertexArrays.length) return -1

    const canvas = scene.canvas || scene._canvas
    if (!canvas) {
      if (this._debug) console.warn('[BeiDouGridPrimitive] pick: no scene.canvas')
      return -1
    }
    const w = gl.drawingBufferWidth
    const h = gl.drawingBufferHeight
    const scaleX = w / (canvas.clientWidth || 1)
    const scaleY = h / (canvas.clientHeight || 1)
    const xCanvas = x
    const yCanvas = y
    const xDraw = xCanvas * scaleX
    const yDraw = yCanvas * scaleY
    if (xDraw < 0 || xDraw >= w || yDraw < 0 || yDraw >= h) return -1

    this._ensurePickFbo(gl, w, h)
    if (!this._pickFbo) return -1

    const camera = scene.camera
    const viewProjection = Cesium.Matrix4.multiply(
      camera.frustum.projectionMatrix,
      camera.viewMatrix,
      new Cesium.Matrix4()
    )

    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING)
    const prevViewport = gl.getParameter(gl.VIEWPORT)
    const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM)
    const vaoExt = this._pickVaoExt
    const prevVao = vaoExt
      ? gl.getParameter(vaoExt.VERTEX_ARRAY_BINDING_OES)
      : (typeof gl.VERTEX_ARRAY_BINDING !== 'undefined' ? gl.getParameter(gl.VERTEX_ARRAY_BINDING) : null)
    const instancedExt = this._pickInstancedExt
    const bindVao = (vao) => {
      if (vaoExt) vaoExt.bindVertexArrayOES(vao)
      else if (gl.bindVertexArray) gl.bindVertexArray(vao)
    }
    const drawInstanced = (mode, count, type, offset, instanceCount) => {
      if (instancedExt) {
        instancedExt.drawElementsInstancedANGLE(mode, count, type, offset, instanceCount)
      } else {
        gl.drawElementsInstanced(mode, count, type, offset, instanceCount)
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._pickFbo)
    gl.viewport(0, 0, w, h)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.DEPTH_TEST)
    gl.depthMask(true)
    gl.depthFunc(gl.LESS)

    gl.useProgram(this._pickShaderProgram)
    const uViewProjection = gl.getUniformLocation(this._pickShaderProgram, 'u_viewProjection')
    const uBatchBase = gl.getUniformLocation(this._pickShaderProgram, 'u_batchBaseInstanceId')
    const viewProjectionArray = Cesium.Matrix4.toArray(viewProjection, [])

    for (let b = 0; b < this._pickVertexArrays.length; b++) {
      const batch = this._pickVertexArrays[b]
      gl.uniformMatrix4fv(uViewProjection, false, viewProjectionArray)
      if (uBatchBase) gl.uniform1f(uBatchBase, this._batchBaseIndices[b])
      bindVao(batch.vao)
      drawInstanced(gl.TRIANGLES, batch.indexCount, batch.indexType, 0, batch.instanceCount)
    }

    const pixel = new Uint8Array(4)
    const readX = Math.floor(xDraw)
    const readY = Math.floor(h - 1 - yDraw)
    gl.readPixels(readX, readY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)

    bindVao(prevVao ?? null)
    gl.useProgram(prevProgram)
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3])
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo)

    const r = pixel[0]
    const g = pixel[1]
    const b = pixel[2]
    const encoded = r + g * 256 + b * 65536
    const globalInstanceId = encoded - 1
    if (globalInstanceId < 0 || globalInstanceId >= this._instanceCount) return -1
    return globalInstanceId
  }

  destroy() {
    if (this._destroyed) return
    const context = this._scene?.context || this._scene?._context
    const gl = context?._gl || context
    if (gl) this._releasePickFbo(gl)
    if (this._pickVertexArrays?.length && gl) {
      const vaoExt = this._pickVaoExt
      this._pickVertexArrays.forEach(({ vao, instanceBuffer, instanceIdBuffer }) => {
        if (vaoExt) vaoExt.deleteVertexArrayOES(vao)
        else if (gl.deleteVertexArray) gl.deleteVertexArray(vao)
        gl.deleteBuffer(instanceBuffer)
        if (instanceIdBuffer) gl.deleteBuffer(instanceIdBuffer)
      })
      this._pickVertexArrays = []
    }
    if (this._pickPositionBuffer && gl) {
      gl.deleteBuffer(this._pickPositionBuffer)
      this._pickPositionBuffer = null
    }
    if (this._pickIndexBuffer && gl) {
      gl.deleteBuffer(this._pickIndexBuffer)
      this._pickIndexBuffer = null
    }
    if (this._pickShaderProgram && gl) {
      gl.deleteProgram(this._pickShaderProgram)
      this._pickShaderProgram = null
    }
    this._commandList = []
    this._geometry = null
    this._batches = []
    this._matrixData = null
    this._visibilityByBatch = []
    if (this._visibilityBuffers?.length) {
      this._visibilityBuffers.forEach((buf) => {
        try { buf.destroy?.() } catch (e) {}
      })
    }
    this._visibilityBuffers = []
    this._pickReady = false
    this._destroyed = true
  }
}
