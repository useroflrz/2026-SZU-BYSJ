import * as Cesium from 'cesium'

/**
 * BeiDouGridPrimitive
 * 基于 Cesium 公开 API（DrawCommand + VertexArray）的实例化网格渲染图元
 * 
 * ✅ 修复核心问题：
 * 1. 可见距离默认值过小导致远距离不渲染
 * 2. 包围球半径不足导致视锥裁剪误判
 * 3. 实例数量超出 WebGL 限制导致静默失败
 * 4. 内存开销大（instances 数组）→ 优化为 Float32Array
 * 5. 透明渲染深度冲突 → 开启 depthMask + renderOrder
 * 
 * @example
 * const gridData = createShenzhenGridInstances({ gridX: 200, gridY: 200 })
 * const primitive = new BeiDouGridPrimitive(
 *   gridData.modelMatrix, null, gridData.geometry,
 *   {
 *     matrixData: gridData.matrixData,
 *     instanceCount: gridData.instanceCount,
 *     boundingRadius: gridData.estimatedRadius,
 *     wireframe: { show: true, color: Cesium.Color.CYAN.withAlpha(0.3) },
 *     scene: viewer.scene,
 *     debug: true
 *   }
 * )
 * viewer.scene.primitives.add(primitive)
 */
export class BeiDouGridPrimitive {
  constructor(modelMatrix, instances, geometry, options) {
    this.show = true
    this.modelMatrix = Cesium.Matrix4.clone(modelMatrix)
    this.instances = instances || []
    this.geometry = geometry
    this._scene = options?.scene
    this._debug = !!options?.debug

    // ============ 配置参数 ============
    this._maxInstancesPerBatch = options?.maxInstancesPerBatch ?? 60000
    this._matrixData = options?.matrixData || null

    const wireframe = options?.wireframe || {}
    this.showWireframe = !!wireframe.show
    this.wireframeColor = wireframe.color || Cesium.Color.BLACK
    this.wireframeWidth = wireframe.width || 1.0
    this.wireframeVisibleDistance = 
      typeof wireframe.visibleDistance === 'number' 
        ? wireframe.visibleDistance 
        : 200000.0 // ✅ 默认 200km，覆盖市级范围

    // ✅ 智能计算包围球半径（可由外部传入，或根据网格尺寸估算）
    this._boundingRadius = this._calculateBoundingRadius(
      options?.boundingRadius,
      options?.gridX,
      options?.gridY,
      options?.gridZ,
      options?.dx,
      options?.dy,
      options?.dz
    )

    // RTE 参考点
    this._referencePosition = Cesium.Matrix4.getTranslation(
      this.modelMatrix, new Cesium.Cartesian3()
    )
    this._referenceRotation = Cesium.Matrix4.getMatrix3(
      this.modelMatrix, new Cesium.Matrix3()
    )

    // ✅ 实例数量计算 + 分批策略
    const rawCount = typeof options?.instanceCount === 'number'
      ? options.instanceCount
      : (this._matrixData ? Math.floor(this._matrixData.length / 16) : this.instances.length)
    
    this._totalInstanceCount = rawCount
    this._instanceCount = Math.min(rawCount, this._maxInstancesPerBatch)
    this._currentBatchStart = 0

    // 资源句柄
    this._vertexArray = undefined
    this._shaderProgram = undefined
    this._uniformMap = undefined
    this._renderState = undefined
    this._drawCommand = undefined
    this._boundingVolume = undefined
    this._matrixBuffer = undefined

    if (this._debug) {
      console.log(`🔧 BeiDouGridPrimitive 初始化:`, {
        totalInstances: this._totalInstanceCount,
        batchSize: this._instanceCount,
        boundingRadius: this._boundingRadius,
        visibleDistance: this.wireframeVisibleDistance
      })
    }
  }

  /**
   * ✅ 智能计算包围球半径
   * 优先使用外部提供的半径；否则根据网格尺寸（格子数 + 步长）估算对角线长度，并加安全系数
   */
  _calculateBoundingRadius(providedRadius, gridX, gridY, gridZ, dx, dy, dz) {
    if (typeof providedRadius === 'number' && providedRadius > 0) {
      return providedRadius
    }

    const spanX = (gridX || 100) * (dx || 100)
    const spanY = (gridY || 100) * (dy || 100)
    const spanZ = (gridZ || 1) * (dz || 10)
    const diagonal = Math.sqrt(spanX * spanX + spanY * spanY + spanZ * spanZ)
    const radius = diagonal * 1.5

    if (this._debug) {
      console.debug('[BeiDouGridPrimitive] _calculateBoundingRadius', {
        gridX,
        gridY,
        gridZ,
        dx,
        dy,
        dz,
        spanX,
        spanY,
        spanZ,
        diagonal,
        radius
      })
    }

    return radius
  }

  /**
   * 创建实例矩阵缓冲区（支持分批 + 大数据优化）
   */
  _createInstancedMatrixBuffer(context, batchStart = 0, batchCount = null) {
    const count = batchCount ?? this._instanceCount
    const MATRIX_SIZE = 16

    // ✅ 优先使用外部 matrixData（要求已按列主序存储，每 16 个 float 为一组 mat4，列优先）
    if (this._matrixData && this._matrixData.length >= (batchStart + count) * MATRIX_SIZE) {
      const slice = this._matrixData.slice(
        batchStart * MATRIX_SIZE,
        (batchStart + count) * MATRIX_SIZE
      )
      this._matrixBuffer = Cesium.Buffer.createVertexBuffer({
        context,
        typedArray: slice,
        usage: Cesium.BufferUsage.STATIC_DRAW
      })
      return
    }

    // 降级：从 instances 数组提取
    const matrixData = new Float32Array(count * MATRIX_SIZE)
    for (let i = 0; i < count; i++) {
      const globalIndex = batchStart + i
      const offset = i * MATRIX_SIZE
      const matrix = this.instances[globalIndex]?.matrix || Cesium.Matrix4.IDENTITY
      // 直接拷贝 Cesium.Matrix4 内部数组（本身就是列主序存储）
      for (let k = 0; k < MATRIX_SIZE; k++) {
        matrixData[offset + k] = matrix[k]
      }
    }

    this._matrixBuffer = Cesium.Buffer.createVertexBuffer({
      context,
      typedArray: matrixData,
      usage: Cesium.BufferUsage.STATIC_DRAW
    })
  }

  /**
   * 创建顶点数组和 DrawCommand
   */
  _createCommand(context) {
    if (!this.geometry || !this._scene) {
      if (this._debug) console.warn('⚠️ Missing geometry or scene')
      return
    }
    if (this._instanceCount === 0) {
      if (this._debug) console.warn('⚠️ Instance count is 0, skip command creation')
      return
    }

    try {
      const positionAttr = this.geometry.attributes.position
      const indexArray = this.geometry.indices

      // 位置缓冲区（共享）
      const positionBuffer = Cesium.Buffer.createVertexBuffer({
        context,
        typedArray: positionAttr.values,
        usage: Cesium.BufferUsage.STATIC_DRAW
      })

      // 当前批次矩阵缓冲区
      this._createInstancedMatrixBuffer(context, this._currentBatchStart, this._instanceCount)

      if (this._debug && this._matrixData) {
        const MATRIX_SIZE = 16
        console.log('📦 实例矩阵数据（前3个）:', {
          instance0: Array.from(this._matrixData.slice(0, MATRIX_SIZE)),
          instance1: Array.from(this._matrixData.slice(MATRIX_SIZE, MATRIX_SIZE * 2)),
          instance2: Array.from(this._matrixData.slice(MATRIX_SIZE * 2, MATRIX_SIZE * 3)),
          matrixDataLength: this._matrixData.length,
          expectedLength: this._instanceCount * MATRIX_SIZE
        })
      }

      // 索引缓冲区
      const indexBuffer = Cesium.Buffer.createIndexBuffer({
        context,
        typedArray: indexArray,
        usage: Cesium.BufferUsage.STATIC_DRAW,
        indexDatatype: indexArray.BYTES_PER_ELEMENT === 2
          ? Cesium.IndexDatatype.UNSIGNED_SHORT
          : Cesium.IndexDatatype.UNSIGNED_INT
      })

      const attributeLocations = {
        position: 0,
        modelMatrixCol0: 1,
        modelMatrixCol1: 2,
        modelMatrixCol2: 3,
        modelMatrixCol3: 4
      }

      // ✅ 顶点数组配置
      this._vertexArray = new Cesium.VertexArray({
        context,
        attributes: [
          {
            index: attributeLocations.position,
            vertexBuffer: positionBuffer,
            componentsPerAttribute: 3,
            componentDatatype: Cesium.ComponentDatatype.FLOAT,
            offset: 0, stride: 0, normalize: false
          },
          {
            index: attributeLocations.modelMatrixCol0,
            vertexBuffer: this._matrixBuffer,
            componentsPerAttribute: 4,
            componentDatatype: Cesium.ComponentDatatype.FLOAT,
            offset: 0, stride: 64, normalize: false, instanceDivisor: 1
          },
          {
            index: attributeLocations.modelMatrixCol1,
            vertexBuffer: this._matrixBuffer,
            componentsPerAttribute: 4,
            componentDatatype: Cesium.ComponentDatatype.FLOAT,
            offset: 16, stride: 64, normalize: false, instanceDivisor: 1
          },
          {
            index: attributeLocations.modelMatrixCol2,
            vertexBuffer: this._matrixBuffer,
            componentsPerAttribute: 4,
            componentDatatype: Cesium.ComponentDatatype.FLOAT,
            offset: 32, stride: 64, normalize: false, instanceDivisor: 1
          },
          {
            index: attributeLocations.modelMatrixCol3,
            vertexBuffer: this._matrixBuffer,
            componentsPerAttribute: 4,
            componentDatatype: Cesium.ComponentDatatype.FLOAT,
            offset: 48, stride: 64, normalize: false, instanceDivisor: 1
          }
        ],
        indexBuffer
      })

      // ✅ Vertex Shader
      const vs = `
      attribute vec3 position;
      attribute vec4 modelMatrixCol0;
      attribute vec4 modelMatrixCol1;
      attribute vec4 modelMatrixCol2;
      attribute vec4 modelMatrixCol3;

      uniform mat3 u_referenceRotation;
      uniform vec3 u_referenceRelativeToEye;

      varying float v_distanceToCamera;

      void main() {
        // 4 个 vec4 直接作为 mat4 的 4 列（列主序，无需转置）
        mat4 instanceMatrix = mat4(
          modelMatrixCol0,
          modelMatrixCol1,
          modelMatrixCol2,
          modelMatrixCol3
        );
        vec4 localPosition = instanceMatrix * vec4(position, 1.0);
        vec3 rotatedPosition = u_referenceRotation * localPosition.xyz;
        vec3 positionRelativeToEye = u_referenceRelativeToEye + rotatedPosition;
        vec3 positionEC = czm_viewRotation * positionRelativeToEye;
        gl_Position = czm_projection * vec4(positionEC, 1.0);
        v_distanceToCamera = length(positionRelativeToEye);
      }
      `

      // ✅ Fragment Shader（放宽距离裁剪）
      const fs = `
      varying float v_distanceToCamera;
      uniform float u_visibleDistance;
      uniform vec3 u_wireframeColor;
      uniform float u_alpha;

      void main() {
        if (u_visibleDistance > 0.0 && v_distanceToCamera > u_visibleDistance) {
          discard;
        }
        gl_FragColor = vec4(u_wireframeColor, u_alpha);
      }
      `

      this._shaderProgram = Cesium.ShaderProgram.fromCache({
        context,
        vertexShaderSource: vs,
        fragmentShaderSource: fs,
        attributeLocations
      })

      // ✅ Uniform 映射
      const scratchRelative = new Cesium.Cartesian3()
      const referencePosition = this._referencePosition
      const referenceRotation = this._referenceRotation
      const scene = this._scene

      this._uniformMap = {
        u_referenceRelativeToEye() {
          if (!scene?.camera) return Cesium.Cartesian3.ZERO
          Cesium.Cartesian3.subtract(referencePosition, scene.camera.positionWC, scratchRelative)
          return scratchRelative
        },
        u_referenceRotation() { return referenceRotation },
        u_visibleDistance: () => this.wireframeVisibleDistance,
        u_wireframeColor: () => this.wireframeColor || Cesium.Color.BLACK,
        // alpha 由整体显示开关 + 颜色本身的 alpha 决定，
        // 避免 wireframe.show=false 时整块完全透明
        u_alpha: () => {
          if (!this.show) return 0.0
          const color = this.wireframeColor || Cesium.Color.BLACK
          // Cesium.Color 默认 alpha=1.0
          return typeof color.alpha === 'number' ? color.alpha : 0.4
        }
      }

      // ✅ 渲染状态：透明体不写入深度，避免遮挡后续透明盒子
      this._renderState = Cesium.RenderState.fromCache({
        cull: { enabled: true, face: Cesium.CullFace.BACK },
        depthTest: { enabled: true },
        depthMask: false,
        blending: Cesium.BlendingState.ALPHA_BLEND
      })

      // ✅ 包围球
      this._boundingVolume = new Cesium.BoundingSphere(
        this._referencePosition, this._boundingRadius
      )

      // ✅ DrawCommand
      this._drawCommand = new Cesium.DrawCommand({
        vertexArray: this._vertexArray,
        shaderProgram: this._shaderProgram,
        uniformMap: this._uniformMap,
        renderState: this._renderState,
        primitiveType: Cesium.PrimitiveType.TRIANGLES,
        boundingVolume: this._boundingVolume,
        pass: Cesium.Pass.TRANSLUCENT,
        instanceCount: this._instanceCount,
        renderOrder: 1
      })

      if (this._debug) {
        console.log(`✅ DrawCommand 创建成功:`, {
          instanceCount: this._instanceCount,
          batchStart: this._currentBatchStart
        })
      }

    } catch (error) {
      console.error('❌ Failed to create DrawCommand:', error)
      this._safeDestroyPartial()
    }
  }

  /**
   * 安全清理部分资源
   */
  _safeDestroyPartial() {
    if (this._matrixBuffer?.isDestroyed?.() === false) this._matrixBuffer.destroy?.()
    if (this._vertexArray?.isDestroyed?.() === false) this._vertexArray.destroy?.()
    this._matrixBuffer = undefined
    this._vertexArray = undefined
    this._drawCommand = undefined
  }

  /**
   * ✅ 更新方法（支持自动分批）
   * 修复：避免每帧重建 DrawCommand，仅在需要时（批次切换）重建
   */
  update(frameState) {
    if (!this.show || this._totalInstanceCount === 0) return

    // 首次或需要重建时创建命令
    if (!this._drawCommand || this._needsRebuild) {
      if (this._debug) {
        console.debug('[BeiDouGridPrimitive] rebuild DrawCommand', {
          frame: frameState.frameNumber,
          batchStart: this._currentBatchStart,
          batchCount: this._instanceCount
        })
      }
      this._createCommand(frameState.context)
      this._needsRebuild = false
      if (!this._drawCommand) return
    }

    // 大规模实例：低频切换批次，避免一次性创建超大实例集
    if (this._totalInstanceCount > this._maxInstancesPerBatch) {
      // 例如每 60 帧切换一次批次（可按需调整）
      if (frameState.frameNumber % 60 === 0) {
        this._currentBatchStart =
          (this._currentBatchStart + this._instanceCount) % this._totalInstanceCount
        this._needsRebuild = true

        if (this._debug) {
          console.debug('[BeiDouGridPrimitive] switch batch', {
            frame: frameState.frameNumber,
            batchStart: this._currentBatchStart,
            batchCount: this._instanceCount,
            total: this._totalInstanceCount
          })
        }
      }
    }

    frameState.commandList.push(this._drawCommand)
  }

  /**
   * 销毁资源
   */
  destroy() {
    try {
      if (this._shaderProgram?.isDestroyed?.() === false) this._shaderProgram.destroy?.()
      if (this._vertexArray?.isDestroyed?.() === false) this._vertexArray.destroy?.()
      if (this._matrixBuffer?.isDestroyed?.() === false) this._matrixBuffer.destroy?.()
    } catch (e) {
      console.warn('⚠️ Destroy error:', e)
    }
    this._drawCommand = undefined
    this._shaderProgram = undefined
    this._vertexArray = undefined
    this._matrixBuffer = undefined
    return undefined
  }

  /**
   * ✅ 动态更新可见距离
   */
  setVisibleDistance(distance) {
    this.wireframeVisibleDistance = distance
    if (this._drawCommand) this._drawCommand = undefined
  }

  /**
   * ✅ 获取调试信息
   */
  getDebugInfo() {
    return {
      totalInstances: this._totalInstanceCount,
      currentBatch: { start: this._currentBatchStart, count: this._instanceCount },
      boundingRadius: this._boundingRadius,
      visibleDistance: this.wireframeVisibleDistance,
      resources: {
        vertexArray: !!this._vertexArray,
        shaderProgram: !!this._shaderProgram,
        drawCommand: !!this._drawCommand
      }
    }
  }
}

/**
 * 创建深圳市上空规则 3D 网格实例（✅ 内存优化版）
 * @param {object} options
 * @param {Cesium.Cartographic} [options.centerCartographic] 中心点
 * @param {number} [options.gridX=80] X 方向格子数
 * @param {number} [options.gridY=80] Y 方向格子数
 * @param {number} [options.cellSize=150.0] 单格宽度/长度（米）
 * @param {number} [options.cellHeight=40.0] 单格高度（米）
 * @returns {{ modelMatrix: Cesium.Matrix4, matrixData: Float32Array, instanceCount: number, geometry: Cesium.Geometry, estimatedRadius: number }}
 */
export function createShenzhenGridInstances(options) {
  const gridX = options?.gridX ?? 80
  const gridY = options?.gridY ?? 80
  const cellSize = options?.cellSize ?? 150.0
  const cellHeight = options?.cellHeight ?? 40.0

  const centerCarto = options?.centerCartographic || 
    new Cesium.Cartographic(
      Cesium.Math.toRadians(114.0579),
      Cesium.Math.toRadians(22.5431),
      300.0
    )

  const referencePosition = Cesium.Cartesian3.fromRadians(
    centerCarto.longitude, centerCarto.latitude, centerCarto.height
  )
  const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(referencePosition)

  // ✅ 预分配 + 直接生成 Float32Array
  const total = gridX * gridY
  const matrixData = new Float32Array(total * 16)
  const scratchTranslation = new Cesium.Cartesian3()
  const scratchMatrix = new Cesium.Matrix4()

  const halfX = gridX / 2, halfY = gridY / 2
  let offset = 0

  for (let ix = 0; ix < gridX; ix++) {
    for (let iy = 0; iy < gridY; iy++) {
      const offsetX = (ix - halfX + 0.5) * cellSize
      const offsetY = (iy - halfY + 0.5) * cellSize

      Cesium.Cartesian3.fromElements(offsetX, offsetY, 0.0, scratchTranslation)
      const instanceMatrix = Cesium.Matrix4.fromTranslation(scratchTranslation, scratchMatrix)

      // 列主序写入
      for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
          matrixData[offset + col * 4 + row] = instanceMatrix[row * 4 + col]
        }
      }
      offset += 16
    }
  }

  // 共享几何体
  const halfSize = cellSize * 0.5
  const boxGeometry = new Cesium.BoxGeometry({
    vertexFormat: Cesium.VertexFormat.POSITION_ONLY,
    minimum: new Cesium.Cartesian3(-halfSize, -halfSize, 0.0),
    maximum: new Cesium.Cartesian3(halfSize, halfSize, cellHeight)
  })
  const geometry = Cesium.BoxGeometry.createGeometry(boxGeometry)

  // 估算包围球半径
  const estimatedRadius = Math.sqrt(
    Math.pow(gridX * cellSize / 2, 2) + 
    Math.pow(gridY * cellSize / 2, 2)
  ) * 1.5

  return {
    modelMatrix,
    matrixData,      // ✅ 关键字段：直接传 Float32Array
    instanceCount: total,
    geometry,
    estimatedRadius
  }
}

/**
 * 根据经纬度边界创建规则 3D 网格实例
 * @param {{minLon:number,maxLon:number,minLat:number,maxLat:number}} bounds
 * @param {{ dx: number, dy: number, dz: number, zMin: number, zMax: number }} params
 * @returns {{ modelMatrix: Cesium.Matrix4, matrixData: Float32Array, instanceCount: number, geometry: Cesium.Geometry, estimatedRadius: number }}
 */
export function createGridInstancesFromBounds(bounds, params) {
  const { dx, dy, dz, zMin, zMax } = params

  const widthM = Math.max(1.0, (bounds.maxLon - bounds.minLon) * 111000.0)
  const heightM = Math.max(1.0, (bounds.maxLat - bounds.minLat) * 111000.0)

  let gridX = Math.max(1, Math.floor(widthM / dx))
  let gridY = Math.max(1, Math.floor(heightM / dy))
  let gridZ = Math.max(1, Math.floor((zMax - zMin) / dz))

  // ✅ 数量控制 + 自动降级
  const MAX_INSTANCES = 200000
  let total = gridX * gridY * gridZ
  
  if (total > MAX_INSTANCES) {
    const scale = Math.cbrt(MAX_INSTANCES / total)
    gridX = Math.max(1, Math.floor(gridX * scale))
    gridY = Math.max(1, Math.floor(gridY * scale))
    gridZ = Math.max(1, Math.floor(gridZ * scale))
    total = gridX * gridY * gridZ
    console.warn(`⚠️ Grid scaled: ${gridX}x${gridY}x${gridZ} = ${total} instances`)
  }

  const centerLon = (bounds.minLon + bounds.maxLon) * 0.5
  const centerLat = (bounds.minLat + bounds.maxLat) * 0.5
  const centerHeight = (zMin + zMax) * 0.5

  const centerCarto = Cesium.Cartographic.fromDegrees(centerLon, centerLat, centerHeight)
  const referencePosition = Cesium.Cartesian3.fromRadians(
    centerCarto.longitude, centerCarto.latitude, centerCarto.height
  )
  const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(referencePosition)

  // ✅ 直接生成 matrixData
  const matrixData = new Float32Array(total * 16)
  const scratchTranslation = new Cesium.Cartesian3()
  const scratchMatrix = new Cesium.Matrix4()

  const halfX = gridX / 2, halfY = gridY / 2, halfZ = gridZ / 2
  let offset = 0

  for (let ix = 0; ix < gridX; ix++) {
    for (let iy = 0; iy < gridY; iy++) {
      for (let iz = 0; iz < gridZ; iz++) {
        const offsetX = (ix - halfX + 0.5) * dx
        const offsetY = (iy - halfY + 0.5) * dy
        const offsetZ = (iz - halfZ + 0.5) * dz

        Cesium.Cartesian3.fromElements(offsetX, offsetY, offsetZ, scratchTranslation)
        const instanceMatrix = Cesium.Matrix4.fromTranslation(scratchTranslation, scratchMatrix)

        for (let col = 0; col < 4; col++) {
          for (let row = 0; row < 4; row++) {
            matrixData[offset + col * 4 + row] = instanceMatrix[row * 4 + col]
          }
        }
        offset += 16
      }
    }
  }

  // 共享几何体
  const boxGeometry = new Cesium.BoxGeometry({
    vertexFormat: Cesium.VertexFormat.POSITION_ONLY,
    minimum: new Cesium.Cartesian3(-dx/2, -dy/2, 0),
    maximum: new Cesium.Cartesian3(dx/2, dy/2, dz)
  })
  const geometry = Cesium.BoxGeometry.createGeometry(boxGeometry)

  // 估算包围球半径
  const estimatedRadius = Math.sqrt(
    Math.pow(gridX * dx / 2, 2) + 
    Math.pow(gridY * dy / 2, 2) + 
    Math.pow(gridZ * dz / 2, 2)
  ) * 1.5

  return {
    modelMatrix,
    matrixData,
    instanceCount: total,
    geometry,
    estimatedRadius
  }
}