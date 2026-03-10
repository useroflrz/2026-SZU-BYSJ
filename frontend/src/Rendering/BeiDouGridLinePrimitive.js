import * as Cesium from 'cesium'

/**
 * BeiDouGridLinePrimitive
 * 使用屏幕空间扩展实现“像素级恒宽”的线段渲染
 *
 * 设计要点：
 * - 输入：modelMatrix（通常为 ENU 矩阵）、线段数组 { start: Cartesian3, end: Cartesian3 }
 * - 每条线段由 4 个顶点组成（两个端点 × 上下两侧），在 VS 中按 NDC 空间扩展线宽
 * - 线宽以像素为单位，不随相机远近变化
 */
export class BeiDouGridLinePrimitive {
  /**
   * @param {Cesium.Matrix4} modelMatrix ENU 或世界坐标变换矩阵
   * @param {{ start: Cesium.Cartesian3, end: Cesium.Cartesian3 }[]} segments 线段集合（本地坐标系）
   * @param {object} options
   * @param {Cesium.Scene} options.scene
   * @param {Cesium.Color} [options.color]
   * @param {number} [options.lineWidth] 像素线宽
   * @param {number} [options.boundingRadius] 包围球半径
   * @param {boolean} [options.debug]
   */
  constructor(modelMatrix, segments, options = {}) {
    this.show = true
    this.modelMatrix = Cesium.Matrix4.clone(modelMatrix)
    this.segments = segments || []
    this._scene = options.scene
    this._debug = !!options.debug

    this._color = options.color || Cesium.Color.WHITE
    this._lineWidth = typeof options.lineWidth === 'number' ? options.lineWidth : 1.5

    this._boundingRadius =
      typeof options.boundingRadius === 'number' && options.boundingRadius > 0
        ? options.boundingRadius
        : this._estimateBoundingRadius()

    this._referencePosition = Cesium.Matrix4.getTranslation(
      this.modelMatrix,
      new Cesium.Cartesian3()
    )
    this._referenceRotation = Cesium.Matrix4.getMatrix3(
      this.modelMatrix,
      new Cesium.Matrix3()
    )

    // 资源句柄
    this._vertexArray = undefined
    this._shaderProgram = undefined
    this._uniformMap = undefined
    this._renderState = undefined
    this._drawCommand = undefined
    this._positionStartBuffer = undefined
    this._positionEndBuffer = undefined
    this._tBuffer = undefined
    this._expandBuffer = undefined
    this._indexBuffer = undefined
    this._boundingVolume = undefined
  }

  _estimateBoundingRadius() {
    if (!this.segments || this.segments.length === 0) return 1.0
    let maxDist = 0.0
    const scratch = new Cesium.Cartesian3()
    for (const seg of this.segments) {
      if (!seg || !seg.start || !seg.end) continue
      const len = Cesium.Cartesian3.distance(seg.start, seg.end)
      if (len > maxDist) maxDist = len
      Cesium.Cartesian3.add(seg.start, seg.end, scratch)
    }
    return Math.max(1.0, maxDist * 1.5)
  }

  _createBuffers(context) {
    const segmentCount = this.segments.length
    if (segmentCount === 0) return

    // 每条线段 4 个顶点（t=0/1 × expandDir=±1）
    const VERTS_PER_SEG = 4
    const INDICES_PER_SEG = 6
    const vertexCount = segmentCount * VERTS_PER_SEG
    const indexCount = segmentCount * INDICES_PER_SEG

    const positionStartArray = new Float32Array(vertexCount * 3)
    const positionEndArray = new Float32Array(vertexCount * 3)
    const tArray = new Float32Array(vertexCount)
    const expandArray = new Float32Array(vertexCount)

    let v = 0
    for (let i = 0; i < segmentCount; i++) {
      const seg = this.segments[i]
      const s = seg.start
      const e = seg.end

      // 顶点布局：
      // 0: t=0, expand=+1
      // 1: t=1, expand=+1
      // 2: t=0, expand=-1
      // 3: t=1, expand=-1
      const configs = [
        { t: 0.0, expand: 1.0 },
        { t: 1.0, expand: 1.0 },
        { t: 0.0, expand: -1.0 },
        { t: 1.0, expand: -1.0 }
      ]

      for (let k = 0; k < VERTS_PER_SEG; k++) {
        const { t, expand } = configs[k]
        const base = v * 3
        positionStartArray[base + 0] = s.x
        positionStartArray[base + 1] = s.y
        positionStartArray[base + 2] = s.z
        positionEndArray[base + 0] = e.x
        positionEndArray[base + 1] = e.y
        positionEndArray[base + 2] = e.z
        tArray[v] = t
        expandArray[v] = expand
        v++
      }
    }

    // 索引：每 4 个顶点组成 2 个三角形
    const useUint32 = vertexCount > 65535
    const indices = useUint32
      ? new Uint32Array(indexCount)
      : new Uint16Array(indexCount)

    let idx = 0
    for (let i = 0; i < segmentCount; i++) {
      const base = i * VERTS_PER_SEG
      // 三角形：0-1-2, 1-3-2
      indices[idx++] = base + 0
      indices[idx++] = base + 1
      indices[idx++] = base + 2
      indices[idx++] = base + 1
      indices[idx++] = base + 3
      indices[idx++] = base + 2
    }

    this._positionStartBuffer = Cesium.Buffer.createVertexBuffer({
      context,
      typedArray: positionStartArray,
      usage: Cesium.BufferUsage.STATIC_DRAW
    })
    this._positionEndBuffer = Cesium.Buffer.createVertexBuffer({
      context,
      typedArray: positionEndArray,
      usage: Cesium.BufferUsage.STATIC_DRAW
    })
    this._tBuffer = Cesium.Buffer.createVertexBuffer({
      context,
      typedArray: tArray,
      usage: Cesium.BufferUsage.STATIC_DRAW
    })
    this._expandBuffer = Cesium.Buffer.createVertexBuffer({
      context,
      typedArray: expandArray,
      usage: Cesium.BufferUsage.STATIC_DRAW
    })

    this._indexBuffer = Cesium.Buffer.createIndexBuffer({
      context,
      typedArray: indices,
      usage: Cesium.BufferUsage.STATIC_DRAW,
      indexDatatype: useUint32
        ? Cesium.IndexDatatype.UNSIGNED_INT
        : Cesium.IndexDatatype.UNSIGNED_SHORT
    })

    const attributeLocations = {
      a_start: 0,
      a_end: 1,
      a_t: 2,
      a_expandDir: 3
    }

    this._vertexArray = new Cesium.VertexArray({
      context,
      attributes: [
        {
          index: attributeLocations.a_start,
          vertexBuffer: this._positionStartBuffer,
          componentsPerAttribute: 3,
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          offset: 0,
          stride: 0,
          normalize: false
        },
        {
          index: attributeLocations.a_end,
          vertexBuffer: this._positionEndBuffer,
          componentsPerAttribute: 3,
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          offset: 0,
          stride: 0,
          normalize: false
        },
        {
          index: attributeLocations.a_t,
          vertexBuffer: this._tBuffer,
          componentsPerAttribute: 1,
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          offset: 0,
          stride: 0,
          normalize: false
        },
        {
          index: attributeLocations.a_expandDir,
          vertexBuffer: this._expandBuffer,
          componentsPerAttribute: 1,
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          offset: 0,
          stride: 0,
          normalize: false
        }
      ],
      indexBuffer: this._indexBuffer
    })

    // 顶点着色器：在屏幕空间扩展线宽
    const vs = `
    attribute vec3 a_start;
    attribute vec3 a_end;
    attribute float a_t;
    attribute float a_expandDir;

    uniform mat3 u_referenceRotation;
    uniform vec3 u_referenceRelativeToEye;
    uniform float u_lineWidth;
    uniform vec3 u_color;

    varying vec3 v_color;

    void main() {
      // 1. RTE + 视图/投影，计算裁剪空间起点/终点
      vec3 worldStart = u_referenceRotation * a_start + u_referenceRelativeToEye;
      vec3 worldEnd   = u_referenceRotation * a_end   + u_referenceRelativeToEye;

      vec3 startEC = czm_viewRotation * worldStart;
      vec3 endEC   = czm_viewRotation * worldEnd;

      vec4 clipStart = czm_projection * vec4(startEC, 1.0);
      vec4 clipEnd   = czm_projection * vec4(endEC, 1.0);

      // 在线段上插值当前顶点位置
      vec4 clipPos = mix(clipStart, clipEnd, a_t);

      // 2. 在 NDC 空间中计算垂直方向
      vec2 ndcStart = clipStart.xy / clipStart.w;
      vec2 ndcEnd   = clipEnd.xy   / clipEnd.w;

      vec2 lineDir = normalize(ndcEnd - ndcStart);
      vec2 perpDir = vec2(-lineDir.y, lineDir.x);

      // 3. 根据视口尺寸，以像素为单位扩展线宽
      vec2 viewportSize = czm_viewport.zw; // xy 为原点，zw 为宽高
      float halfWidth = u_lineWidth * 0.5;
      vec2 offsetNdc = perpDir * (halfWidth / viewportSize) * a_expandDir;

      // 4. 把 NDC 偏移还原到裁剪空间
      vec2 clipOffset = offsetNdc * clipPos.w;
      // 为避免与底面完全共面导致 Z-Fighting，把线条整体向相机方向轻微偏移一小段深度
      float depthEpsilon = 1e-6;
      float adjustedZ = clipPos.z - depthEpsilon * clipPos.w;
      gl_Position = vec4(clipPos.xy + clipOffset, adjustedZ, clipPos.w);

      v_color = u_color;
    }
    `

    const fs = `
    varying vec3 v_color;
    void main() {
      gl_FragColor = vec4(v_color, 1.0);
    }
    `

    this._shaderProgram = Cesium.ShaderProgram.fromCache({
      context,
      vertexShaderSource: vs,
      fragmentShaderSource: fs,
      attributeLocations
    })

    const scratchRelative = new Cesium.Cartesian3()
    const referencePosition = this._referencePosition
    const referenceRotation = this._referenceRotation
    const scene = this._scene
    const that = this

    this._uniformMap = {
      u_referenceRelativeToEye() {
        if (!scene?.camera) return Cesium.Cartesian3.ZERO
        Cesium.Cartesian3.subtract(referencePosition, scene.camera.positionWC, scratchRelative)
        return scratchRelative
      },
      u_referenceRotation() {
        return referenceRotation
      },
      u_lineWidth() {
        return that._lineWidth
      },
      u_color() {
        return that._color
      }
    }

    this._renderState = Cesium.RenderState.fromCache({
      depthTest: { enabled: true },
      // 线条作为覆盖层，不再写入深度缓冲，避免影响后续渲染
      depthMask: false,
      blending: Cesium.BlendingState.ALPHA_BLEND
    })

    this._boundingVolume = new Cesium.BoundingSphere(
      this._referencePosition,
      this._boundingRadius
    )

    this._drawCommand = new Cesium.DrawCommand({
      vertexArray: this._vertexArray,
      shaderProgram: this._shaderProgram,
      uniformMap: this._uniformMap,
      renderState: this._renderState,
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      boundingVolume: this._boundingVolume,
      pass: Cesium.Pass.TRANSLUCENT,
      // 确保在体素/底面之后绘制，使线条覆盖在表面之上
      renderOrder: 2
    })
  }

  update(frameState) {
    if (!this.show || !this._scene || this.segments.length === 0) return

    if (!this._drawCommand) {
      if (this._debug) {
        console.debug('[BeiDouGridLinePrimitive] create drawCommand', {
          segmentCount: this.segments.length
        })
      }
      this._createBuffers(frameState.context)
      if (!this._drawCommand) return
    }

    frameState.commandList.push(this._drawCommand)
  }

  destroy() {
    try {
      if (this._shaderProgram?.isDestroyed?.() === false) this._shaderProgram.destroy?.()
      if (this._vertexArray?.isDestroyed?.() === false) this._vertexArray.destroy?.()
      if (this._positionStartBuffer?.isDestroyed?.() === false) this._positionStartBuffer.destroy?.()
      if (this._positionEndBuffer?.isDestroyed?.() === false) this._positionEndBuffer.destroy?.()
      if (this._tBuffer?.isDestroyed?.() === false) this._tBuffer.destroy?.()
      if (this._expandBuffer?.isDestroyed?.() === false) this._expandBuffer.destroy?.()
      if (this._indexBuffer?.isDestroyed?.() === false) this._indexBuffer.destroy?.()
    } catch (e) {
      console.warn('[BeiDouGridLinePrimitive] destroy error:', e)
    }

    this._shaderProgram = undefined
    this._vertexArray = undefined
    this._positionStartBuffer = undefined
    this._positionEndBuffer = undefined
    this._tBuffer = undefined
    this._expandBuffer = undefined
    this._indexBuffer = undefined
    this._drawCommand = undefined
    return undefined
  }

  /**
   * 调试信息：用于定位“线存在但看不到/不成网格”的渲染问题
   */
  getDebugInfo() {
    const renderState = this._renderState
    const depthTestEnabled = !!renderState?.depthTest?.enabled
    const depthMask = renderState?.depthMask

    return {
      segmentCount: this.segments?.length || 0,
      lineWidth: this._lineWidth,
      color: this._color,
      boundingRadius: this._boundingRadius,
      resources: {
        vertexArray: !!this._vertexArray,
        shaderProgram: !!this._shaderProgram,
        drawCommand: !!this._drawCommand,
        buffers: {
          positionStart: !!this._positionStartBuffer,
          positionEnd: !!this._positionEndBuffer,
          t: !!this._tBuffer,
          expand: !!this._expandBuffer,
          index: !!this._indexBuffer
        }
      },
      renderState: {
        depthTestEnabled,
        depthMask,
        blending: !!renderState?.blending
      },
      drawCommand: this._drawCommand
        ? {
            pass: this._drawCommand.pass,
            renderOrder: this._drawCommand.renderOrder,
            primitiveType: this._drawCommand.primitiveType
          }
        : null
    }
  }
}

