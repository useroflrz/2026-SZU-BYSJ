import { defineStore } from 'pinia'
import * as Cesium from 'cesium'
import { markRaw, toRaw } from 'vue'
import { BeiDouGridPrimitive, createGridInstancesFromBounds } from '../Rendering/BeiDouGridPrimitive'

async function sampleGridGroundHeights(viewer, normalizedBounds, originLon, originLat, dx, dy, gridX, gridY, options = {}) {
  const {
    batchSize = 200,
    defaultHeight = 0
  } = options

  // Cesium 在某些 Vue3 情况下，若 viewer 是响应式 Proxy，会在 tile availability 计算阶段触发渲染停止错误。
  // 这里强制解包，确保传入 Cesium 的 viewer/terrainProvider 是“原始对象”。
  const rawViewer = toRaw(viewer)
  const terrainProvider = rawViewer?.terrainProvider
  const groundHeights = new Float32Array(gridX * gridY)

  if (!terrainProvider || gridX <= 0 || gridY <= 0) {
    groundHeights.fill(defaultHeight)
    return { originGroundHeight: defaultHeight, groundHeights }
  }

  try {
    // 预等待 terrain 可用性，避免部分情况下 sampleTerrainMostDetailed 直接失败
    if (terrainProvider.readyPromise) {
      await terrainProvider.readyPromise
    }
  } catch (e) {
    // ignore and fallback to defaultHeight
  }

  const centerLatDeg = (normalizedBounds.minLat + normalizedBounds.maxLat) * 0.5
  const centerLatRad = Cesium.Math.toRadians(centerLatDeg)
  const metersPerDegLat = 111000.0
  const metersPerDegLon = 111000.0 * Math.cos(centerLatRad)
  const safeMetersPerDegLon = Math.max(1e-9, metersPerDegLon)

  const safeSample = async (cartos) => {
    // sampleTerrainMostDetailed 会原地更新 cartos[i].height
    return Cesium.sampleTerrainMostDetailed(terrainProvider, cartos)
  }

  let originGroundHeight = defaultHeight
  try {
    const originCarto = Cesium.Cartographic.fromDegrees(originLon, originLat)
    await safeSample([originCarto])
    originGroundHeight = Number.isFinite(originCarto.height) ? originCarto.height : defaultHeight
  } catch (e) {
    originGroundHeight = defaultHeight
  }

  // 按 (ix,iy) 的柱中心点采样地形高度（gridZ 层不参与采样，避免乘法爆炸）
  const totalCols = gridX * gridY
  for (let start = 0; start < totalCols; start += batchSize) {
    const end = Math.min(totalCols, start + batchSize)
    const cartos = []
    const idxs = []

    for (let linear = start; linear < end; linear++) {
      const ix = linear % gridX
      const iy = Math.floor(linear / gridX)

      const localX = (ix + 0.5) * dx
      const localY = (iy + 0.5) * dy
      const lon = originLon + localX / safeMetersPerDegLon
      const lat = originLat + localY / metersPerDegLat

      cartos.push(Cesium.Cartographic.fromDegrees(lon, lat))
      idxs.push(linear)
    }

    try {
      await safeSample(cartos)
      for (let j = 0; j < cartos.length; j++) {
        const h = cartos[j]?.height
        groundHeights[idxs[j]] = Number.isFinite(h) ? h : defaultHeight
      }
    } catch (e) {
      // 采样批失败时，回退这批柱为默认高度，保证功能可用
      for (let linear = start; linear < end; linear++) {
        groundHeights[linear] = defaultHeight
      }
    }
  }

  return { originGroundHeight, groundHeights }
}

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
    // instanced 模式下的选中格子高亮框：用 Entity 实现，避免 Primitive destroy 带来的拾取竞态
    beiDouGridSelectedOverlay: null, // entityId (string) or null
    selectedBeiDouCellId: null,
    selectedBeiDouCellInfo: null
  }),

  getters: {
    hasViewer: (state) => state.viewer !== null,
    layerCount: (state) => state.layers.length
  },

  actions: {
    schedulePrimitiveDestroy(primitive) {
      if (!primitive) return
      try {
        const isDestroyed =
          typeof primitive.isDestroyed === 'function' ? primitive.isDestroyed() : false
        if (isDestroyed) return

        const doDestroy = () => {
          try {
            if (typeof primitive.destroy === 'function') primitive.destroy()
          } catch (e) {
            // ignore
          }
        }

        // 延迟到下一帧再销毁，避免 Cesium 在同一帧的 pick/render 过程中仍引用对象
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(() => doDestroy())
        } else {
          setTimeout(doDestroy, 0)
        }
      } catch (e) {
        // ignore
      }
    },

    setViewer(viewer) {
      // markRaw 避免把 Cesium Viewer 包进 Vue 响应式系统（可减少/避免异步 tile 计算的竞态问题）。
      this.viewer = markRaw(viewer)
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
    async showBeiDouGrid(bounds, gridParams) {
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

      // 采样地形高度：用户输入的 zMin/zMax 是“离地高度（相对 terrain）”，
      // 因此需要把每个 (ix,iy) 柱的地形高度 groundHeight 映射到 ENU 的 Up 轴偏移。
      const { originGroundHeight, groundHeights } = await sampleGridGroundHeights(
        this.viewer,
        normalizedBounds,
        originLon,
        originLat,
        dx,
        dy,
        gridX,
        gridY,
        { batchSize: 200, defaultHeight: 0 }
      )

      const zMinRel = zMin
      const originCartesian = Cesium.Cartesian3.fromDegrees(originLon, originLat, originGroundHeight)
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
            const colIndex = iy * gridX + ix
            const groundH = groundHeights?.[colIndex] ?? originGroundHeight
            for (let iz = 0; iz < gridZ; iz++) {
              const centerZRel = zMinRel + (iz + 0.5) * dz + (groundH - originGroundHeight)
              const localTranslation = new Cesium.Cartesian3(
                (ix + 0.5) * dx,
                (iy + 0.5) * dy,
                centerZRel
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
          {
            origin: 'minCorner',
            originGroundHeight,
            groundHeights,
            gridX,
            gridY,
            gridZ
          }
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
              fillColor: baseFillColor,
              color: baseOutlineColor,
              halfSize: new Cesium.Cartesian3(halfWidth, halfLength, halfHeight),
              edgeRatio: 0.01,
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
        // 用户输入的离地高度（相对 terrain 的“离地高度”语义）
        zMin,
        zMax,
        zMinRel: zMin,
        zMaxRel: zMax,
        // ENU 原点（originLon,originLat）处：绝对椭球高度 = originGroundHeight + zMin
        zStartAbsOrigin: originGroundHeight + zMin,
        gridX,
        gridY,
        gridZ,
        renderedCount,
        renderStep: 1,
        originGroundHeight,
        originLon,
        originLat,
        originCartesian,
        originENU,
        groundHeights,
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
      // selected overlay 用 Entity，避免 destroy 相关竞态
      if (this.beiDouGridSelectedOverlay && this.viewer?.entities) {
        try {
          this.viewer.entities.removeById(this.beiDouGridSelectedOverlay)
        } catch (e) {
          // ignore
        }
      }
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
            if (this.viewer?.entities) {
              this.viewer.entities.removeById(this.beiDouGridSelectedOverlay)
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
          const {
            zMin: zMinRel,
            dx: metaDx,
            dy: metaDy,
            dz: metaDz,
            originENU,
            originGroundHeight,
            groundHeights,
            gridX: metaGridX
          } = this.beiDouGridMeta

          let lon = 0, lat = 0, height = 0
          try {
            const colIndex = iy * metaGridX + ix
            const groundH = groundHeights?.[colIndex] ?? originGroundHeight
            const localCenter = new Cesium.Cartesian3(
              (ix + 0.5) * metaDx,
              (iy + 0.5) * metaDy,
              zMinRel + (iz + 0.5) * metaDz + (groundH - originGroundHeight)
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
              const halfW = metaDx * 0.5
              const halfL = metaDy * 0.5
              const halfH = metaDz * 0.5
              const colIndex = iy * metaGridX + ix
              const groundH = groundHeights?.[colIndex] ?? originGroundHeight
              const localTranslation = new Cesium.Cartesian3(
                (ix + 0.5) * metaDx,
                (iy + 0.5) * metaDy,
                zMinRel + (iz + 0.5) * metaDz + (groundH - originGroundHeight)
              )
              const modelMatrix = Cesium.Matrix4.multiplyByTranslation(
                originENU,
                localTranslation,
                new Cesium.Matrix4()
              )
              // Entity box 用 position + orientation，而不是 Primitive 的 destroy/recreate
              const worldCenter = Cesium.Matrix4.getTranslation(modelMatrix, new Cesium.Cartesian3())
              const rot = Cesium.Matrix3.fromMatrix4(modelMatrix, new Cesium.Matrix3())
              const orientation = Cesium.Quaternion.fromRotationMatrix(rot, new Cesium.Quaternion())

              const overlayEntityId = 'beidou-grid-selected-overlay'
              let overlayEntity = this.viewer.entities.getById(overlayEntityId)
              const metaOutlineColor = this.beiDouGridMeta?.outlineColor
              const selectedOutlineColor = Cesium.Color.RED.withAlpha(
                Number.isFinite(metaOutlineColor?.alpha) ? metaOutlineColor.alpha : 0.95
              )
              if (!overlayEntity) {
                overlayEntity = this.viewer.entities.add({
                  id: overlayEntityId,
                  name: '北斗格网选中高亮',
                  position: worldCenter,
                  orientation,
                  box: {
                    dimensions: new Cesium.Cartesian3(metaDx, metaDy, metaDz),
                    fill: false,
                    outline: true,
                    // 选中单元边框固定红色，透明度沿用当前边框透明度设置。
                    outlineColor: selectedOutlineColor,
                    outlineWidth: 2
                  }
                })
                this.beiDouGridSelectedOverlay = overlayEntityId
              } else {
                overlayEntity.position = worldCenter
                overlayEntity.orientation = orientation
                if (overlayEntity.box) {
                  overlayEntity.box.dimensions = new Cesium.Cartesian3(metaDx, metaDy, metaDz)
                  overlayEntity.box.outlineColor = selectedOutlineColor
                }
              }
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