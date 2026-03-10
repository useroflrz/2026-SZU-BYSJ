import { defineStore } from 'pinia'
import * as Cesium from 'cesium'
import { BeiDouGridPrimitive } from '../Rendering/BeiDouGridPrimitive'
import { BeiDouGridLinePrimitive } from '../Rendering/BeiDouGridLinePrimitive'

// 简单的实体/集合管理器，集中存储各类图层的 ids，便于销毁/显隐
const defaultLayerState = () => ({
  regionEntityId: null,
  stationEntityIds: [],
  gridEntityIds: [],
  resultEntityIds: []
})

export const useMapStore = defineStore('map', {
  state: () => ({
    viewer: null,
    center: { lon: 114.0579, lat: 22.5431 },
    zoom: 15,
    layers: [],
    selectedRegion: null,
    dsmLoaded: false,
    layerState: defaultLayerState(),
    beiDouGridPrimitive: null,
    beiDouGridOutlinePrimitive: null,
    beiDouGridInstancedPrimitives: [],
    beiDouGridMeta: null,
    selectedBeiDouCellId: null,
    selectedBeiDouCellInfo: null
  }),

  getters: {
    hasViewer: (state) => state.viewer !== null,
    layerCount: (state) => state.layers.length
  },

  actions: {
    setViewer(viewer) {
      this.viewer = viewer
    },

    setCenter(lon, lat) {
      this.center = { lon, lat }
    },

    setZoom(zoom) {
      this.zoom = zoom
    },

    async loadDSM(url) {
      // TODO: 实现DSM加载逻辑
      this.dsmLoaded = true
    },

    addLayer(layer) {
      this.layers.push(layer)
    },

    removeLayer(layerId) {
      this.layers = this.layers.filter(l => l.id !== layerId)
    },

    setRegion(region) {
      this.selectedRegion = region
    },

    clearLayers() {
      this.layers = []
      this.clearAllEntities()
    },

    clearAllEntities() {
      if (!this.viewer) return
      this.layerState.stationEntityIds.forEach(id => this.viewer.entities.removeById(id))
      this.layerState.gridEntityIds.forEach(id => this.viewer.entities.removeById(id))
      this.layerState.resultEntityIds.forEach(id => this.viewer.entities.removeById(id))
      if (this.layerState.regionEntityId) {
        this.viewer.entities.removeById(this.layerState.regionEntityId)
      }
      this.layerState = defaultLayerState()
      // 同时清除北斗格网 Primitive
      this.clearBeiDouGrid()
    },

    flyToCenter(lon, lat, height = 3000) {
      if (!this.viewer) return
      this.viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, height)
      })
    },

    drawRegion(bounds, name) {
      if (!this.viewer || !bounds) return
      // 移除旧区域
      if (this.layerState.regionEntityId) {
        this.viewer.entities.removeById(this.layerState.regionEntityId)
      }

      const rectangle = Cesium.Rectangle.fromDegrees(
        bounds.minX,
        bounds.minY,
        bounds.maxX,
        bounds.maxY
      )

      const entity = this.viewer.entities.add({
        name: name || '选定区域',
        rectangle: {
          coordinates: rectangle,
          material: new Cesium.Color(0.16, 0.53, 0.96, 0.2),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#409EFF'),
          outlineWidth: 2
        }
      })

      this.layerState.regionEntityId = entity.id
      this.setRegion({ name, bounds })
    },

    clearRegionLayer() {
      if (this.viewer && this.layerState.regionEntityId) {
        this.viewer.entities.removeById(this.layerState.regionEntityId)
      }
      this.layerState.regionEntityId = null
      this.selectedRegion = null
    },

    setStations(stations) {
      if (!this.viewer) return
      // 清除旧的站点实体
      this.layerState.stationEntityIds.forEach(id => this.viewer.entities.removeById(id))
      this.layerState.stationEntityIds = []

      stations.forEach(st => {
        const height = st.position?.height || 0
        const entity = this.viewer.entities.add({
          name: st.name || '站点',
          position: Cesium.Cartesian3.fromDegrees(
            st.position.lon,
            st.position.lat,
            height
          ),
          billboard: {
            image: 'https://unpkg.com/ionicons@5.5.2/dist/svg/radio-outline.svg',
            scale: 0.8,
            color: Cesium.Color.fromCssColorString('#409EFF'),
            heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND
          },
          label: {
            text: st.name || '站点',
            font: '14px sans-serif',
            fillColor: Cesium.Color.WHITE,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            outlineWidth: 2,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -20),
            heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND
          }
        })
        this.layerState.stationEntityIds.push(entity.id)
      })
    },

    setGridPoints(points) {
      if (!this.viewer) return
      this.layerState.gridEntityIds.forEach(id => this.viewer.entities.removeById(id))
      this.layerState.gridEntityIds = []

      points.forEach(pt => {
        const entity = this.viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, pt.height || 0),
          point: {
            pixelSize: 4,
            color: Cesium.Color.fromCssColorString('#67C23A').withAlpha(0.8)
          }
        })
        this.layerState.gridEntityIds.push(entity.id)
      })
    },

    setResultPoints(points, options = {}) {
      if (!this.viewer) return
      const { colorScheme = 'green_red', pointSize = 4, filterHeightRange = null } = options
      this.layerState.resultEntityIds.forEach(id => this.viewer.entities.removeById(id))
      this.layerState.resultEntityIds = []

      const colorByScheme = (visible) => {
        if (colorScheme === 'blue_gray') {
          return visible
            ? Cesium.Color.fromCssColorString('#409EFF').withAlpha(0.9)
            : Cesium.Color.fromCssColorString('#909399').withAlpha(0.7)
        }
        if (colorScheme === 'gradient') {
          return visible
            ? Cesium.Color.fromCssColorString('#67C23A').withAlpha(0.9)
            : Cesium.Color.fromCssColorString('#F56C6C').withAlpha(0.9)
        }
        return visible
          ? Cesium.Color.fromCssColorString('#67C23A').withAlpha(0.9)
          : Cesium.Color.fromCssColorString('#F56C6C').withAlpha(0.9)
      }

      points.forEach(pt => {
        if (filterHeightRange) {
          const [minH, maxH] = filterHeightRange
          if (pt.height < minH || pt.height > maxH) return
        }
        const entity = this.viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, pt.height || 0),
          point: {
            pixelSize: pointSize,
            color: colorByScheme(pt.visible)
          }
        })
        this.layerState.resultEntityIds.push(entity.id)
      })
    },

    setResultLayerVisibility(show) {
      if (!this.viewer) return
      this.layerState.resultEntityIds.forEach(id => {
        const entity = this.viewer.entities.getById(id)
        if (entity) entity.show = show
      })
    },

    setStationLayerVisibility(show) {
      if (!this.viewer) return
      this.layerState.stationEntityIds.forEach(id => {
        const entity = this.viewer.entities.getById(id)
        if (entity) entity.show = show
      })
    },

    setGridLayerVisibility(show) {
      if (!this.viewer) return
      this.layerState.gridEntityIds.forEach(id => {
        const entity = this.viewer.entities.getById(id)
        if (entity) entity.show = show
      })
    },

    /**
     * 使用 Cesium 官方 Primitive/GeometryInstance API 展示北斗 3D 网格
     */
    showBeiDouGrid(bounds, gridParams) {
      if (!this.viewer) {
        console.warn('[map] showBeiDouGrid: viewer 未初始化，格网未渲染。请确保地图已加载完成。')
        return null
      }

      this.clearBeiDouGrid()

      const {
        dx,
        dy,
        dz,
        zMin,
        zMax,
        fillColor,
        fillOpacity,
        outlineColor,
        outlineOpacity
      } = gridParams

      const __debugBeiDou = !!import.meta.env?.DEV
      if (__debugBeiDou) {
        console.groupCollapsed('[BeiDouGrid] showBeiDouGrid')
        console.log('📊 Grid Params:', {
          dx,
          dy,
          dz,
          zMin,
          zMax,
          bounds
        })
      }

      const centerLatDeg = (bounds.minLat + bounds.maxLat) * 0.5
      const centerLatRad = Cesium.Math.toRadians(centerLatDeg)
      const metersPerDegLat = 111000.0
      const metersPerDegLon = 111000.0 * Math.cos(centerLatRad)

      const rawWidthM = Math.max(0.0, (bounds.maxLon - bounds.minLon) * metersPerDegLon)
      const rawHeightM = Math.max(0.0, (bounds.maxLat - bounds.minLat) * metersPerDegLat)

      const gridZ = Math.max(1, Math.ceil((zMax - zMin) / dz))
      const gridX = Math.max(1, Math.ceil(rawWidthM / dx))
      const gridY = Math.max(1, Math.ceil(rawHeightM / dy))
      const total = gridX * gridY * gridZ

      const MAX_GEOMETRY_INSTANCES = 120000
      const useInstancing = total > MAX_GEOMETRY_INSTANCES
      let renderedCount = 0
      const capped = false

      if (__debugBeiDou) {
        console.log('🧮 Grid Derived:', {
          centerLatDeg,
          metersPerDegLat,
          metersPerDegLon,
          rawWidthM,
          rawHeightM,
          gridX,
          gridY,
          gridZ,
          total,
          MAX_GEOMETRY_INSTANCES,
          useInstancing
        })
      }

      const originLon = bounds.minLon
      const originLat = bounds.minLat
      const zStart = zMin
      const originCartesian = Cesium.Cartesian3.fromDegrees(originLon, originLat, zStart)
      const originENU = Cesium.Transforms.eastNorthUpToFixedFrame(originCartesian)

      if (import.meta.env?.DEV) {
        const originCartesianJson = {
          x: originCartesian.x,
          y: originCartesian.y,
          z: originCartesian.z
        }
        console.log('🌍 格网原点:', {
          originLon,
          originLat,
          zStart,
          originCartesian: originCartesianJson,
          bounds
        })
      }

      const halfWidth = dx * 0.5
      const halfLength = dy * 0.5
      const halfHeight = dz * 0.5

      const baseFillColor = (fillColor
        ? Cesium.Color.fromCssColorString(fillColor)
        : new Cesium.Color(0.0, 0.9, 1.0, 1.0)
      ).withAlpha(
        typeof fillOpacity === 'number' ? fillOpacity : 0.25
      )

      const baseOutlineColor = (outlineColor
        ? Cesium.Color.fromCssColorString(outlineColor)
        : Cesium.Color.BLACK
      ).withAlpha(
        typeof outlineOpacity === 'number' ? outlineOpacity : 0.8
      )

      if (!useInstancing) {
        const baseGeometry = new Cesium.BoxGeometry({
          vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          minimum: new Cesium.Cartesian3(-halfWidth, -halfLength, -halfHeight),
          maximum: new Cesium.Cartesian3(halfWidth, halfLength, halfHeight)
        })

        const baseOutlineGeometry = new Cesium.BoxOutlineGeometry({
          minimum: new Cesium.Cartesian3(-halfWidth, -halfLength, -halfHeight),
          maximum: new Cesium.Cartesian3(halfWidth, halfLength, halfHeight)
        })

        const geometryInstances = []
        const outlineGeometryInstances = []
        for (let ix = 0; ix < gridX; ix++) {
          for (let iy = 0; iy < gridY; iy++) {
            for (let iz = 0; iz < gridZ; iz++) {
              const localTranslation = new Cesium.Cartesian3(
                (ix + 0.5) * dx,
                (iy + 0.5) * dy,
                (iz + 0.5) * dz
              )
              const modelMatrix = Cesium.Matrix4.multiplyByTranslation(
                originENU,
                localTranslation,
                new Cesium.Matrix4()
              )
              const id = `beidou-cell-${ix}-${iy}-${iz}`

              geometryInstances.push(
                new Cesium.GeometryInstance({
                  geometry: baseGeometry,
                  modelMatrix,
                  id,
                  attributes: {
                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(baseFillColor)
                  }
                })
              )
              outlineGeometryInstances.push(
                new Cesium.GeometryInstance({
                  geometry: baseOutlineGeometry,
                  modelMatrix,
                  id,
                  attributes: {
                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(baseOutlineColor)
                  }
                })
              )
              renderedCount++
            }
          }
        }

        const primitive = new Cesium.Primitive({
          geometryInstances,
          appearance: new Cesium.PerInstanceColorAppearance({
            translucent: true,
            closed: false
          }),
          asynchronous: true
        })
        this.viewer.scene.primitives.add(primitive)
        this.beiDouGridPrimitive = primitive

        let outlinePrimitive = null
        if (outlineGeometryInstances.length > 0) {
          outlinePrimitive = new Cesium.Primitive({
            geometryInstances: outlineGeometryInstances,
            appearance: new Cesium.PerInstanceColorAppearance({
              translucent: true,
              flat: true
            }),
            asynchronous: true
          })
          this.viewer.scene.primitives.add(outlinePrimitive)
        }
        this.beiDouGridOutlinePrimitive = outlinePrimitive
      } else {
        // ✅ 超大规模：GPU 实例化（完整渲染，无抽样空洞）
        const scene = this.viewer.scene

        // ✅ 修复：包围球半径计算（1.5 倍对角线，避免视锥裁剪）
        const extentWidthM = gridX * dx
        const extentHeightM = gridY * dy
        const extentDepthM = gridZ * dz
        const diagonalM = Math.sqrt(
          extentWidthM * extentWidthM +
            extentHeightM * extentHeightM +
            extentDepthM * extentDepthM
        )
        const boundingRadius = diagonalM * 1.5

        const boxGeometry = new Cesium.BoxGeometry({
          vertexFormat: Cesium.VertexFormat.POSITION_ONLY,
          minimum: new Cesium.Cartesian3(-halfWidth, -halfLength, -halfHeight),
          maximum: new Cesium.Cartesian3(halfWidth, halfLength, halfHeight)
        })
        const geometry = Cesium.BoxGeometry.createGeometry(boxGeometry)

        const INSTANCES_PER_CHUNK = 250000
        const totalInstances = total
        let created = 0
        const primitives = []

        const writeInstanceMatrix = (arr, offsetFloats, tx, ty, tz) => {
          // 列主序：先写第 0 列 [1,0,0,0]，再第 1 列 [0,1,0,0]，第 2 列 [0,0,1,0]，最后平移列 [tx,ty,tz,1]
          arr[offsetFloats + 0] = 1;  arr[offsetFloats + 1] = 0;  arr[offsetFloats + 2] = 0;  arr[offsetFloats + 3] = 0   // col0
          arr[offsetFloats + 4] = 0;  arr[offsetFloats + 5] = 1;  arr[offsetFloats + 6] = 0;  arr[offsetFloats + 7] = 0   // col1
          arr[offsetFloats + 8] = 0;  arr[offsetFloats + 9] = 0;  arr[offsetFloats + 10] = 1; arr[offsetFloats + 11] = 0  // col2
          arr[offsetFloats + 12] = tx; arr[offsetFloats + 13] = ty; arr[offsetFloats + 14] = tz; arr[offsetFloats + 15] = 1 // col3
        }

        const totalXY = gridX * gridY
        if (import.meta.env?.DEV) {
          console.debug('[BeiDou] instancing mode enabled', {
            totalInstances,
            gridX,
            gridY,
            gridZ,
            dx,
            dy,
            dz,
            instancesPerChunk: INSTANCES_PER_CHUNK
          })
        }

        while (created < totalInstances) {
          const remaining = totalInstances - created
          const chunkCount = Math.min(INSTANCES_PER_CHUNK, remaining)
          const matrixData = new Float32Array(chunkCount * 16)

          for (let i = 0; i < chunkCount; i++) {
            const linear = created + i
            const xy = Math.floor(linear / gridZ)
            const iz = linear - xy * gridZ
            const ix = Math.floor(xy / gridY)
            const iy = xy - ix * gridY

            const tx = (ix + 0.5) * dx
            const ty = (iy + 0.5) * dy
            const tz = (iz + 0.5) * dz
            writeInstanceMatrix(matrixData, i * 16, tx, ty, tz)
          }

          // ✅ 修复：添加 wireframe.show: true + color + maxInstancesPerBatch + debug
          const instanced = new BeiDouGridPrimitive(originENU, null, geometry, {
            scene,
            matrixData,
            instanceCount: chunkCount,
            boundingRadius,
            wireframe: {
              show: true,              // 🔥 关键修复：必须为 true，否则 alpha=0
              color: baseFillColor,    // ✅ 使用用户配置的颜色
              visibleDistance: 1e9     // ✅ 超大可见距离
            },
            maxInstancesPerBatch: 60000,  // ✅ 明确批次大小
            debug: import.meta.env?.DEV   // ✅ 开发环境输出日志
          })
          if (this.viewer && this.viewer.scene && this.viewer.scene.primitives) {
            scene.primitives.add(instanced)
          } else if (import.meta.env?.DEV) {
            console.warn('[BeiDou] scene.primitives not available when adding instanced primitive')
          }
          primitives.push(instanced)
          created += chunkCount
        }

        this.beiDouGridInstancedPrimitives = primitives
        this.beiDouGridPrimitive = primitives[0] || null

        // 使用屏幕空间扩展的线段 Primitive 绘制底部格网线（像素级恒宽）
        const lineSegments = []
        // 底面 z 为 0（局部 ENU），对应 world zStart
        const zLocal = 0.0
        // 垂直方向线（沿 y）
        for (let ix = 0; ix <= gridX; ix++) {
          const x = ix * dx
          const start = new Cesium.Cartesian3(x, 0.0, zLocal)
          const end = new Cesium.Cartesian3(x, gridY * dy, zLocal)
          lineSegments.push({ start, end })
        }
        // 水平方向线（沿 x）
        for (let iy = 0; iy <= gridY; iy++) {
          const y = iy * dy
          const start = new Cesium.Cartesian3(0.0, y, zLocal)
          const end = new Cesium.Cartesian3(gridX * dx, y, zLocal)
          lineSegments.push({ start, end })
        }

        if (__debugBeiDou) {
          console.log('🧵 Grid Lines (instanced bottom):', {
            zLocal,
            verticalCount: gridX + 1,
            horizontalCount: gridY + 1,
            totalSegments: lineSegments.length,
            // 只打印范围，避免输出海量对象
            extentLocal: {
              xMin: 0,
              xMax: gridX * dx,
              yMin: 0,
              yMax: gridY * dy
            },
            boundingRadius
          })
        }

        let outlinePrimitive = null
        if (lineSegments.length > 0) {
          outlinePrimitive = new BeiDouGridLinePrimitive(originENU, lineSegments, {
            scene,
            color: baseOutlineColor,
            lineWidth: 1.5,
            boundingRadius,
            debug: import.meta.env?.DEV
          })
          scene.primitives.add(outlinePrimitive)
        }
        this.beiDouGridOutlinePrimitive = outlinePrimitive
        renderedCount = total

        if (__debugBeiDou) {
          console.log('🎯 Primitive Debug:', this.beiDouGridPrimitive?.getDebugInfo?.())
          console.log('🧾 Outline Debug:', this.beiDouGridOutlinePrimitive?.getDebugInfo?.())
        }
      }

      this.beiDouGridMeta = {
        bounds,
        dx,
        dy,
        dz,
        zMin,
        zMax,
        gridX,
        gridY,
        gridZ,
        renderedCount,
        renderStep: 1,
        zStart,
        originLon,
        originLat,
        originCartesian,
        originENU,
        fillColor: baseFillColor,
        outlineColor: baseOutlineColor,
        renderMode: useInstancing ? 'instanced' : 'geometryInstances'
      }

      const result = {
        total,
        renderedCount,
        layerCount: gridZ,
        pointsPerLayer: gridX * gridY,
        capped,
        usedDx: dx,
        usedDy: dy
      }

      if (__debugBeiDou) {
        console.log('🔍 Render Result:', result)
        console.log('📦 Meta Info:', this.beiDouGridMeta)
        console.groupEnd()
      }

      return result
    },

    clearBeiDouGrid() {
      if (!this.viewer) return

      const removePrimitiveSafe = (primitive) => {
        if (!primitive) return
        try {
          if (typeof primitive.isDestroyed === 'function') {
            if (!primitive.isDestroyed()) {
              this.viewer.scene.primitives.remove(primitive)
              if (typeof primitive.destroy === 'function') {
                primitive.destroy()
              }
            }
          } else {
            this.viewer.scene.primitives.remove(primitive)
            if (typeof primitive.destroy === 'function') {
              primitive.destroy()
            }
          }
        } catch (e) {
          // 忽略已销毁对象的错误
        }
      }

      removePrimitiveSafe(this.beiDouGridPrimitive)
      removePrimitiveSafe(this.beiDouGridOutlinePrimitive)
      if (Array.isArray(this.beiDouGridInstancedPrimitives)) {
        this.beiDouGridInstancedPrimitives.forEach(p => removePrimitiveSafe(p))
      }

      this.beiDouGridPrimitive = null
      this.beiDouGridOutlinePrimitive = null
      this.beiDouGridInstancedPrimitives = []
      this.beiDouGridMeta = null
      this.selectedBeiDouCellId = null
      this.selectedBeiDouCellInfo = null
    },

    /**
     * 选中或取消选中某个北斗格网单元
     */
    selectBeiDouCell(cellId) {
      if (!this.viewer || !this.beiDouGridPrimitive) return

      const primitive = this.beiDouGridPrimitive
      if (this.beiDouGridMeta && this.beiDouGridMeta.renderMode === 'instanced') {
        this.selectedBeiDouCellId = null
        this.selectedBeiDouCellInfo = null
        return
      }

      if (this.selectedBeiDouCellId) {
        try {
          const prevAttr = primitive.getGeometryInstanceAttributes(this.selectedBeiDouCellId)
          if (prevAttr && prevAttr.color) {
            const baseColor = this.beiDouGridMeta?.fillColor || new Cesium.Color(0.0, 0.9, 1.0, 0.25)
            prevAttr.color = Cesium.ColorGeometryInstanceAttribute.toValue(baseColor)
          }
        } catch (e) {
          // ignore
        }
      }

      if (!cellId) {
        this.selectedBeiDouCellId = null
        this.selectedBeiDouCellInfo = null
        return
      }

      try {
        const attr = primitive.getGeometryInstanceAttributes(cellId)
        if (attr && attr.color) {
          attr.color = Cesium.ColorGeometryInstanceAttribute.toValue(
            new Cesium.Color(1.0, 0.0, 0.0, 0.8)
          )
          this.selectedBeiDouCellId = cellId
        }
      } catch (e) {
        // ignore
      }

      if (this.beiDouGridMeta) {
        const parts = cellId.split('-')
        if (parts.length === 5) {
          const ix = parseInt(parts[2], 10)
          const iy = parseInt(parts[3], 10)
          const iz = parseInt(parts[4], 10)
          const { zStart, dx: metaDx, dy: metaDy, dz: metaDz, originENU } = this.beiDouGridMeta

          let lon = 0, lat = 0, height = zStart + (iz + 0.5) * metaDz
          try {
            const localCenter = new Cesium.Cartesian3(
              (ix + 0.5) * metaDx,
              (iy + 0.5) * metaDy,
              (iz + 0.5) * metaDz
            )
            const world = Cesium.Matrix4.multiplyByPoint(originENU, localCenter, new Cesium.Cartesian3())
            const carto = Cesium.Cartographic.fromCartesian(world)
            lon = Cesium.Math.toDegrees(carto.longitude)
            lat = Cesium.Math.toDegrees(carto.latitude)
            height = carto.height
          } catch (e) {
            // ignore
          }

          this.selectedBeiDouCellInfo = {
            ix, iy, iz, lon, lat, height,
            dx: metaDx, dy: metaDy, dz: metaDz
          }
        }
      }
    }
  }
})