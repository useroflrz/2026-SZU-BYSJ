import { defineStore } from 'pinia'
import * as Cesium from 'cesium'
import { BeiDouGridPrimitive, createGridInstancesFromBounds } from '../Rendering/BeiDouGridPrimitive'

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
    beiDouGridSelectedOverlay: null,
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
      // 选定区域后立即创建/更新“蓝色矩形预览”，在用户点击“确认区域”后再移除预览矩形
      const b = bounds
      const minLon = b.minX ?? b.minLon
      const minLat = b.minY ?? b.minLat
      const maxLon = b.maxX ?? b.maxLon
      const maxLat = b.maxY ?? b.maxLat
      if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return

      // 先移除旧的预览矩形
      if (this.layerState.regionEntityId) {
        try {
          this.viewer.entities.removeById(this.layerState.regionEntityId)
        } catch (e) {
          // ignore
        }
        this.layerState.regionEntityId = null
      }

      const rect = Cesium.Rectangle.fromDegrees(minLon, minLat, maxLon, maxLat)
      const entity = this.viewer.entities.add({
        name: name || '区域预览',
        rectangle: {
          coordinates: rect,
          material: Cesium.Color.fromCssColorString('#409EFF').withAlpha(0.15),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#409EFF').withAlpha(0.95),
          // 避免 Entity 贴地轮廓/heightReference 警告
          height: 0.0,
          heightReference: Cesium.HeightReference.NONE
        }
      })
      this.layerState.regionEntityId = entity.id

      // 同步写入已选区域参数（供格网/分析联动）
      this.setRegion({ name, bounds })
    },

    clearRegionLayer() {
      if (this.viewer && this.layerState.regionEntityId) {
        this.viewer.entities.removeById(this.layerState.regionEntityId)
      }
      this.layerState.regionEntityId = null
      this.selectedRegion = null
    },

    /**
     * 仅移除地图上的“区域预览矩形”，不清空已确认的 selectedRegion。
     * RegionSelector 在确认区域后会调用此方法。
     */
    removeRegionRectangleOnly() {
      if (this.viewer && this.layerState.regionEntityId) {
        try {
          this.viewer.entities.removeById(this.layerState.regionEntityId)
        } catch (e) {
          // 忽略已被移除/销毁导致的异常
        }
      }
      this.layerState.regionEntityId = null
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

      // bounds 兼容：可能是 minX/minY/maxX/maxY
      const b = bounds || {}
      const minLon = b.minX ?? b.minLon
      const minLat = b.minY ?? b.minLat
      const maxLon = b.maxX ?? b.maxLon
      const maxLat = b.maxY ?? b.maxLat
      if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
        console.warn('[map] showBeiDouGrid: bounds 无效，格网未渲染。', bounds)
        return null
      }
      const normalizedBounds = { minLon, minLat, maxLon, maxLat }

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
        console.log('📊 Grid Params:', { dx, dy, dz, zMin, zMax, bounds: normalizedBounds })
      }

      const centerLatDeg = (normalizedBounds.minLat + normalizedBounds.maxLat) * 0.5
      const centerLatRad = Cesium.Math.toRadians(centerLatDeg)
      const metersPerDegLat = 111000.0
      const metersPerDegLon = 111000.0 * Math.cos(centerLatRad)

      const rawWidthM = Math.max(0.0, (normalizedBounds.maxLon - normalizedBounds.minLon) * metersPerDegLon)
      const rawHeightM = Math.max(0.0, (normalizedBounds.maxLat - normalizedBounds.minLat) * metersPerDegLat)

      const gridZ = Math.max(1, Math.ceil((zMax - zMin) / dz))
      const gridX = Math.max(1, Math.ceil(rawWidthM / dx))
      const gridY = Math.max(1, Math.ceil(rawHeightM / dy))
      const total = gridX * gridY * gridZ

      const MAX_GEOMETRY_INSTANCES = 120000
      const useInstancing = total > MAX_GEOMETRY_INSTANCES
      let renderedCount = 0
      const capped = false

      if (__debugBeiDou) {
        console.log('🧮 Grid Derived:', { gridX, gridY, gridZ, total, useInstancing })
      }

      const originLon = normalizedBounds.minLon
      const originLat = normalizedBounds.minLat
      const zStart = zMin
      const originCartesian = Cesium.Cartesian3.fromDegrees(originLon, originLat, zStart)
      const originENU = Cesium.Transforms.eastNorthUpToFixedFrame(originCartesian)

      // debug-only origin print removed (kept minimal)

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
        // ✅ 超大规模：GPU 实例化（单几何 + batches）
        const scene = this.viewer.scene
        const gridData = createGridInstancesFromBounds(
          normalizedBounds,
          { dx, dy, dz, zMin, zMax },
          { origin: 'minCorner' }
        )

        const primitive = new BeiDouGridPrimitive(
          gridData.modelMatrix,
          null,
          gridData.geometry,
          {
            scene,
            matrixData: gridData.matrixData,
            instanceCount: gridData.instanceCount,
            batches: gridData.batches,
            boundingSphere: gridData.boundingSphere,
            wireframe: {
              show: true,
              color: baseFillColor,
              visibleDistance: 1e9
            },
            debug: import.meta.env?.DEV
          }
        )

        scene.primitives.add(primitive)
        this.beiDouGridPrimitive = primitive
        this.beiDouGridInstancedPrimitives = [primitive]
        this.beiDouGridOutlinePrimitive = null
        renderedCount = gridData.instanceCount
      }

      this.beiDouGridMeta = {
        bounds: normalizedBounds,
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
      removePrimitiveSafe(this.beiDouGridSelectedOverlay)
      if (Array.isArray(this.beiDouGridInstancedPrimitives)) {
        this.beiDouGridInstancedPrimitives.forEach(p => removePrimitiveSafe(p))
      }

      this.beiDouGridPrimitive = null
      this.beiDouGridOutlinePrimitive = null
      this.beiDouGridInstancedPrimitives = []
      this.beiDouGridMeta = null
      this.beiDouGridSelectedOverlay = null
      this.selectedBeiDouCellId = null
      this.selectedBeiDouCellInfo = null
    },

    /**
     * 选中或取消选中某个北斗格网单元
     */
    selectBeiDouCell(cellId) {
      if (!this.viewer || !this.beiDouGridPrimitive) return

      const primitive = this.beiDouGridPrimitive
      const isInstanced = this.beiDouGridMeta && this.beiDouGridMeta.renderMode === 'instanced'

      // geometryInstances 模式才支持逐实例改色
      if (!isInstanced && this.selectedBeiDouCellId) {
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
        if (this.beiDouGridSelectedOverlay) {
          try {
            this.viewer.scene.primitives.remove(this.beiDouGridSelectedOverlay)
            if (typeof this.beiDouGridSelectedOverlay.destroy === 'function') {
              this.beiDouGridSelectedOverlay.destroy()
            }
          } catch (e) {
            // ignore
          }
          this.beiDouGridSelectedOverlay = null
        }
        this.selectedBeiDouCellId = null
        this.selectedBeiDouCellInfo = null
        return
      }

      if (!isInstanced) {
        try {
          const attr = primitive.getGeometryInstanceAttributes(cellId)
          if (attr && attr.color) {
            attr.color = Cesium.ColorGeometryInstanceAttribute.toValue(
              new Cesium.Color(1.0, 0.0, 0.0, 0.8)
            )
          }
        } catch (e) {
          // ignore
        }
      }

      // instanced 模式无法逐格改色，但依然记录选中信息（GPU 拾取）
      this.selectedBeiDouCellId = cellId

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

          // instanced 模式：用单独的覆盖 Primitive 高亮选中格子（只渲染 1 个盒子）
          if (isInstanced) {
            try {
              if (this.beiDouGridSelectedOverlay) {
                this.viewer.scene.primitives.remove(this.beiDouGridSelectedOverlay)
                if (typeof this.beiDouGridSelectedOverlay.destroy === 'function') {
                  this.beiDouGridSelectedOverlay.destroy()
                }
              }

              const halfW = metaDx * 0.5
              const halfL = metaDy * 0.5
              const halfH = metaDz * 0.5
              const overlayGeom = new Cesium.BoxOutlineGeometry({
                minimum: new Cesium.Cartesian3(-halfW, -halfL, -halfH),
                maximum: new Cesium.Cartesian3(halfW, halfL, halfH)
              })

              const localTranslation = new Cesium.Cartesian3(
                (ix + 0.5) * metaDx,
                (iy + 0.5) * metaDy,
                (iz + 0.5) * metaDz
              )
              const modelMatrix = Cesium.Matrix4.multiplyByTranslation(
                originENU,
                localTranslation,
                new Cesium.Matrix4()
              )

              const overlayInstance = new Cesium.GeometryInstance({
                geometry: overlayGeom,
                modelMatrix,
                attributes: {
                  color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                    Cesium.Color.YELLOW.withAlpha(0.95)
                  )
                }
              })

              const overlay = new Cesium.Primitive({
                geometryInstances: overlayInstance,
                appearance: new Cesium.PerInstanceColorAppearance({
                  translucent: true,
                  flat: true
                }),
                asynchronous: true
              })
              this.viewer.scene.primitives.add(overlay)
              this.beiDouGridSelectedOverlay = overlay
            } catch (e) {
              // ignore overlay errors
              this.beiDouGridSelectedOverlay = null
            }
          }
        }
      }
    }
  }
})