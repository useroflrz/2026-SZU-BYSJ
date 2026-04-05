import { defineStore } from 'pinia'
import * as Cesium from 'cesium'
import { markRaw, toRaw } from 'vue'
import { BeiDouGridPrimitive, createGridInstancesFromBounds } from '../Rendering/BeiDouGridPrimitive'
import { runColumnMaskJobAndWait } from '../Analysis/apiClient'
import {
  buildColumnActiveMask,
  decodeColumnActiveFloat32B64,
  simplifyMultiPolygonCoordinates
} from '../utils/gridColumnClip'

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
  regionClipEntityIds: [],
  stationEntityIds: [],
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
    beiDouGridResultPrimitive: null,
    beiDouGridResultOutlinePrimitive: null,
    beiDouGridResultInstancedPrimitives: [],
    beiDouGridMeta: null,
    // 后端分析后的紧凑结果快照（用于结果导出/复位）
    beiDouLastCompactResult: null,
    // instanced 模式下的选中格子高亮：使用官方 Primitive + GeometryInstance
    beiDouGridSelectedPrimitive: null,
    selectedBeiDouCellId: null,
    selectedBeiDouCellInfo: null
  }),

  getters: {
    hasViewer: (state) => state.viewer !== null,
    layerCount: (state) => state.layers.length,
    /** 分析结果层在时优先用结果 Primitive，否则用格网生成层（便于拾取/选中） */
    activeBeiDouCellPrimitive: (state) => {
      const r = state.beiDouGridResultPrimitive
      if (r != null && r.show !== false) return r
      return state.beiDouGridPrimitive
    },
    activeBeiDouCellOutlinePrimitive: (state) => {
      const r = state.beiDouGridResultPrimitive
      if (r != null && r.show !== false) return state.beiDouGridResultOutlinePrimitive
      return state.beiDouGridOutlinePrimitive
    }
  },

  actions: {
    schedulePrimitiveDestroy(primitive) {
      if (!primitive) return
      try {
        const isDestroyed =
          typeof primitive.isDestroyed === 'function' ? primitive.isDestroyed() : false
        if (isDestroyed) return

        // Cesium 官方 Primitive 的生命周期交给 PrimitiveCollection 管理，
        // remove() 后再手动 destroy() 容易触发渲染帧中的 destroyed 引用错误。
        if (primitive instanceof Cesium.Primitive) return

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

    removeRegionClipEntities() {
      if (!this.viewer) return
      const ids = this.layerState.regionClipEntityIds || []
      for (const id of ids) {
        try {
          this.viewer.entities.removeById(id)
        } catch (e) {
          // ignore
        }
      }
      this.layerState.regionClipEntityIds = []
    },

    clearAllEntities() {
      if (!this.viewer) return
      this.layerState.stationEntityIds.forEach(id => this.viewer.entities.removeById(id))
      this.layerState.resultEntityIds.forEach(id => this.viewer.entities.removeById(id))
      if (this.layerState.regionEntityId) {
        this.viewer.entities.removeById(this.layerState.regionEntityId)
      }
      this.removeRegionClipEntities()
      this.layerState = defaultLayerState()
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

      this.removeRegionClipEntities()
      const clip = this.selectedRegion?.clipGeoJson
      if (clip?.type === 'MultiPolygon' && Array.isArray(clip.coordinates)) {
        const fill = Cesium.Color.fromCssColorString('#67C23A').withAlpha(0.18)
        const outline = Cesium.Color.fromCssColorString('#67C23A').withAlpha(0.85)
        for (const poly of clip.coordinates) {
          const outer = poly && poly[0]
          if (!outer || outer.length < 3) continue
          const flat = []
          for (const pt of outer) {
            if (Number.isFinite(pt[0]) && Number.isFinite(pt[1])) flat.push(pt[0], pt[1])
          }
          if (flat.length < 6) continue
          const ent = this.viewer.entities.add({
            name: `${name || '区域'} — 行政边界`,
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)),
              height: 0,
              heightReference: Cesium.HeightReference.NONE,
              material: fill,
              outline: true,
              outlineColor: outline
            }
          })
          this.layerState.regionClipEntityIds.push(ent.id)
        }
      }

      const bStore = {
        minX: minLon,
        minY: minLat,
        maxX: maxLon,
        maxY: maxLat
      }
      this.setRegion({
        ...this.selectedRegion,
        name: name || this.selectedRegion?.name,
        bounds: bStore,
        area: this.selectedRegion?.area
      })
    },

    clearRegionLayer() {
      if (this.viewer && this.layerState.regionEntityId) {
        this.viewer.entities.removeById(this.layerState.regionEntityId)
      }
      this.layerState.regionEntityId = null
      this.removeRegionClipEntities()
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
            scale: 0.5,
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

    setResultPoints(points, options = {}) {
      if (!this.viewer) return
      const { colorScheme = 'green_red', pointSize = 4, filterHeightRange = null } = options
      this.layerState.resultEntityIds.forEach(id => this.viewer.entities.removeById(id))
      this.layerState.resultEntityIds = []

      const colorByScheme = (visible) => {
        if (colorScheme === 'uncovered') {
          return visible
            ? Cesium.Color.fromCssColorString('#67C23A').withAlpha(0.08)
            : Cesium.Color.fromCssColorString('#F56C6C').withAlpha(0.95)
        }
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

    clearBeiDouResultGrid() {
      if (!this.viewer) return
      const removePrimitiveSafe = (primitive) => {
        if (!primitive) return
        try {
          const inScene = this.viewer.scene?.primitives?.contains?.(primitive) === true
          if (inScene) {
            this.viewer.scene.primitives.remove(primitive)
            return
          }
          if (typeof primitive.isDestroyed === 'function' && !primitive.isDestroyed()) {
            this.schedulePrimitiveDestroy(primitive)
          }
        } catch (e) {
          // ignore
        }
      }

      removePrimitiveSafe(this.beiDouGridResultPrimitive)
      removePrimitiveSafe(this.beiDouGridResultOutlinePrimitive)
      if (Array.isArray(this.beiDouGridResultInstancedPrimitives)) {
        this.beiDouGridResultInstancedPrimitives.forEach((p) => removePrimitiveSafe(p))
      }
      this.beiDouGridResultPrimitive = null
      this.beiDouGridResultOutlinePrimitive = null
      this.beiDouGridResultInstancedPrimitives = []
    },

    async restoreBeiDouBaseGrid() {
      if (!this.viewer || !this.beiDouGridMeta) return
      this.beiDouLastCompactResult = null
      this.clearBeiDouResultGrid()
      if (this.beiDouGridPrimitive) this.beiDouGridPrimitive.show = true
      if (this.beiDouGridOutlinePrimitive) this.beiDouGridOutlinePrimitive.show = true
      if (Array.isArray(this.beiDouGridInstancedPrimitives)) {
        this.beiDouGridInstancedPrimitives.forEach((p) => {
          if (p) p.show = true
        })
      }
      if (this.viewer?.scene?.requestRender) this.viewer.scene.requestRender()
    },

    async renderBeiDouUncoveredGridFromCompactResult(compactResult) {
      if (!this.viewer || !this.beiDouGridMeta) return
      const isCompactResult = compactResult?.type === 'gridViewshedCompact'
      if (!isCompactResult) return

      const meta = this.beiDouGridMeta
      const uncoveredIndicesRaw = Array.isArray(compactResult.uncoveredIndices)
        ? compactResult.uncoveredIndices
        : []
      const totalCells = meta.gridX * meta.gridY * meta.gridZ
      const hiddenSet = new Set()
      const uncoveredIndices = []
      for (let i = 0; i < uncoveredIndicesRaw.length; i++) {
        const idx = uncoveredIndicesRaw[i]
        if (!Number.isFinite(idx) || idx < 0 || idx >= totalCells || hiddenSet.has(idx)) continue
        hiddenSet.add(idx)
        uncoveredIndices.push(idx)
      }

      this.beiDouLastCompactResult = compactResult

      const uncoveredColor = Cesium.Color.fromCssColorString('#F56C6C').withAlpha(0.95)
      const hiddenIndices = []
      for (let idx = 0; idx < totalCells; idx++) {
        if (!hiddenSet.has(idx)) hiddenIndices.push(idx)
      }

      // 隐藏“格网生成”的蓝色本体，仅显示结果层
      if (this.beiDouGridPrimitive) this.beiDouGridPrimitive.show = false
      if (this.beiDouGridOutlinePrimitive) this.beiDouGridOutlinePrimitive.show = false
      if (Array.isArray(this.beiDouGridInstancedPrimitives)) {
        this.beiDouGridInstancedPrimitives.forEach((p) => {
          if (p) p.show = false
        })
      }

      const renderInfo = await this.showBeiDouGrid(meta.bounds, {
        dx: meta.dx,
        dy: meta.dy,
        dz: meta.dz,
        zMin: meta.zMin,
        zMax: meta.zMax,
        fillColor: '#F56C6C',
        fillOpacity: 0.95,
        outlineColor: '#F56C6C',
        outlineOpacity: Number.isFinite(meta.baseOutlineColor?.alpha) ? meta.baseOutlineColor.alpha : 0.95,
        hiddenInstanceIndices: hiddenIndices,
        columnActive: meta.columnActive,
        appendMode: true,
        saveAsResultLayer: true
      })
      if (!renderInfo) return

      if (this.viewer?.scene?.requestRender) this.viewer.scene.requestRender()
    },

    setStationLayerVisibility(show) {
      if (!this.viewer) return
      this.layerState.stationEntityIds.forEach(id => {
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

      const appendMode = gridParams?.appendMode === true
      const saveAsResultLayer = gridParams?.saveAsResultLayer === true
      if (!appendMode) {
        this.clearBeiDouGrid()
      } else {
        this.clearBeiDouResultGrid()
      }

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
        outlineOpacity,
        hiddenInstanceIndices
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
      const bboxCellTotal = gridX * gridY * gridZ

      const sr = this.selectedRegion
      const bEq =
        sr?.bounds &&
        Math.abs((sr.bounds.minX ?? sr.bounds.minLon) - minLon) < 1e-7 &&
        Math.abs((sr.bounds.minY ?? sr.bounds.minLat) - minLat) < 1e-7 &&
        Math.abs((sr.bounds.maxX ?? sr.bounds.maxLon) - maxLon) < 1e-7 &&
        Math.abs((sr.bounds.maxY ?? sr.bounds.maxLat) - maxLat) < 1e-7
      const clip = bEq && sr?.clipGeoJson?.type === 'MultiPolygon' ? sr.clipGeoJson : null
      const rawClipCoords =
        clip?.coordinates && Array.isArray(clip.coordinates) && clip.coordinates.length
          ? clip.coordinates
          : null

      let columnActive
      if (gridParams.columnActive && gridParams.columnActive.length === gridX * gridY) {
        columnActive =
          gridParams.columnActive instanceof Float32Array
            ? gridParams.columnActive
            : Float32Array.from(gridParams.columnActive)
      } else if (rawClipCoords) {
        try {
          const maskResult = await runColumnMaskJobAndWait({
            minLon,
            minLat,
            maxLon,
            maxLat,
            dx,
            dy,
            gridX,
            gridY,
            clipMultiPolygonCoordinates: rawClipCoords
          })
          columnActive = decodeColumnActiveFloat32B64(maskResult.columnActiveB64)
          if (columnActive.length !== gridX * gridY) {
            throw new Error('columnActive length mismatch')
          }
        } catch (e) {
          console.warn('[map] 后端柱掩膜失败，改在前端计算（可能短暂卡顿）', e)
          const multiCoordsLocal = simplifyMultiPolygonCoordinates(rawClipCoords, 2500)
          columnActive = buildColumnActiveMask({
            originLon: minLon,
            originLat: minLat,
            gridX,
            gridY,
            dx,
            dy,
            centerLatDeg,
            multiPolygonCoordinates: multiCoordsLocal
          })
        }
      } else {
        columnActive = buildColumnActiveMask({
          originLon: minLon,
          originLat: minLat,
          gridX,
          gridY,
          dx,
          dy,
          centerLatDeg,
          multiPolygonCoordinates: null
        })
      }

      let activeColumns = 0
      for (let c = 0; c < columnActive.length; c++) {
        if (columnActive[c] > 0.5) activeColumns++
      }
      const activeCellTotal = activeColumns * gridZ
      const total = bboxCellTotal

      if (activeColumns === 0) {
        console.warn('[map] showBeiDouGrid: 当前边界与裁剪多边形下无有效柱（请检查 SHP 与边界是否一致）')
        return null
      }

      const MAX_GEOMETRY_INSTANCES = 120000
      const useInstancing = total > MAX_GEOMETRY_INSTANCES
      let renderedCount = 0
      const capped = false
      const hiddenFlags =
        Array.isArray(hiddenInstanceIndices) && hiddenInstanceIndices.length > 0
          ? (() => {
              const flags = new Uint8Array(total)
              for (let i = 0; i < hiddenInstanceIndices.length; i++) {
                const idx = hiddenInstanceIndices[i]
                if (!Number.isFinite(idx) || idx < 0 || idx >= total) continue
                flags[idx] = 1
              }
              return flags
            })()
          : null

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
        typeof fillOpacity === 'number' ? fillOpacity : 0.05
      )

      const baseOutlineColor = (outlineColor
        ? Cesium.Color.fromCssColorString(outlineColor)
        : Cesium.Color.BLACK
      ).withAlpha(
        typeof outlineOpacity === 'number' ? outlineOpacity : 0.95
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
        const yieldEveryInstances = 2500
        let instancesSinceYield = 0
        for (let ix = 0; ix < gridX; ix++) {
          for (let iy = 0; iy < gridY; iy++) {
            const colIndex = iy * gridX + ix
            if (columnActive[colIndex] < 0.5) continue
            const groundH = groundHeights?.[colIndex] ?? originGroundHeight
            for (let iz = 0; iz < gridZ; iz++) {
              const instanceIndex = iz * gridX * gridY + iy * gridX + ix
              if (hiddenFlags && hiddenFlags[instanceIndex] === 1) continue
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
              instancesSinceYield++
              if (instancesSinceYield >= yieldEveryInstances) {
                instancesSinceYield = 0
                await new Promise((r) => setTimeout(r, 0))
              }
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
        if (saveAsResultLayer) this.beiDouGridResultPrimitive = primitive
        else this.beiDouGridPrimitive = primitive

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
        if (saveAsResultLayer) this.beiDouGridResultOutlinePrimitive = outlinePrimitive
        else this.beiDouGridOutlinePrimitive = outlinePrimitive
      } else {
        // ✅ 超大规模：GPU 实例化（单几何 + batches）
        await new Promise((r) => setTimeout(r, 0))
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
            gridZ,
            hiddenInstanceIndices,
            columnActive
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
              lineWidthPx: 1.25,
              visibleDistance: 1e9
            },
            debug: import.meta.env?.DEV
          }
        )

        scene.primitives.add(primitive)
        if (saveAsResultLayer) {
          this.beiDouGridResultPrimitive = primitive
          this.beiDouGridResultInstancedPrimitives = [primitive]
          this.beiDouGridResultOutlinePrimitive = null
        } else {
          this.beiDouGridPrimitive = primitive
          this.beiDouGridInstancedPrimitives = [primitive]
          this.beiDouGridOutlinePrimitive = null
        }
        renderedCount = activeCellTotal
      }

      if (!saveAsResultLayer) {
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
          columnActive: new Float32Array(columnActive),
          activeColumns,
          activeCellTotal,
          bboxCellTotal,
          fillColor: baseFillColor,
          outlineColor: baseOutlineColor,
          baseFillColor,
          baseOutlineColor,
          renderMode: useInstancing ? 'instanced' : 'geometryInstances'
        }
      }

      const result = {
        total: activeCellTotal,
        bboxCellTotal,
        activeColumns,
        activeCellTotal,
        renderedCount,
        layerCount: gridZ,
        pointsPerLayer: activeColumns,
        bboxColumns: gridX * gridY,
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
          const inScene = this.viewer.scene?.primitives?.contains?.(primitive) === true
          if (inScene) {
            this.viewer.scene.primitives.remove(primitive)
            return
          }
          if (typeof primitive.isDestroyed === 'function') {
            if (!primitive.isDestroyed()) {
              this.schedulePrimitiveDestroy(primitive)
            }
          } else {
            this.schedulePrimitiveDestroy(primitive)
          }
        } catch (e) {
          // 忽略已销毁对象的错误
        }
      }

      removePrimitiveSafe(this.beiDouGridPrimitive)
      removePrimitiveSafe(this.beiDouGridOutlinePrimitive)
      removePrimitiveSafe(this.beiDouGridResultPrimitive)
      removePrimitiveSafe(this.beiDouGridResultOutlinePrimitive)
      removePrimitiveSafe(this.beiDouGridSelectedPrimitive)
      if (Array.isArray(this.beiDouGridInstancedPrimitives)) {
        this.beiDouGridInstancedPrimitives.forEach(p => removePrimitiveSafe(p))
      }
      if (Array.isArray(this.beiDouGridResultInstancedPrimitives)) {
        this.beiDouGridResultInstancedPrimitives.forEach(p => removePrimitiveSafe(p))
      }

      this.beiDouGridPrimitive = null
      this.beiDouGridOutlinePrimitive = null
      this.beiDouGridInstancedPrimitives = []
      this.beiDouGridResultPrimitive = null
      this.beiDouGridResultOutlinePrimitive = null
      this.beiDouGridResultInstancedPrimitives = []
      this.beiDouGridMeta = null
      this.beiDouGridSelectedPrimitive = null
      this.selectedBeiDouCellId = null
      this.selectedBeiDouCellInfo = null

      this.beiDouLastCompactResult = null
    },

    /**
     * 选中或取消选中某个北斗格网单元
     */
    selectBeiDouCell(cellId) {
      const primitive = this.activeBeiDouCellPrimitive
      if (!this.viewer || !primitive) return

      const outlinePrimitive = this.activeBeiDouCellOutlinePrimitive
      const isInstanced = this.beiDouGridMeta && this.beiDouGridMeta.renderMode === 'instanced'
      const requestRenderSafe = () => {
        try {
          if (this.viewer?.scene?.requestRender) this.viewer.scene.requestRender()
        } catch (e) {
          // ignore
        }
      }

      // geometryInstances 模式才支持逐实例改色
      if (!isInstanced && this.selectedBeiDouCellId) {
        try {
          const prevAttr = primitive.getGeometryInstanceAttributes(this.selectedBeiDouCellId)
          if (prevAttr && prevAttr.color) {
            const baseColor = this.beiDouGridMeta?.fillColor || new Cesium.Color(0.0, 0.9, 1.0, 0.05)
            prevAttr.color = Cesium.ColorGeometryInstanceAttribute.toValue(baseColor)
          }
        } catch (e) {
          // ignore
        }
        try {
          if (outlinePrimitive) {
            const prevOutlineAttr = outlinePrimitive.getGeometryInstanceAttributes(this.selectedBeiDouCellId)
            if (prevOutlineAttr && prevOutlineAttr.color) {
              const baseOutlineColor = this.beiDouGridMeta?.outlineColor || Cesium.Color.BLACK.withAlpha(0.95)
              prevOutlineAttr.color = Cesium.ColorGeometryInstanceAttribute.toValue(baseOutlineColor)
            }
          }
        } catch (e) {
          // ignore
        }
      }

      if (!cellId) {
        if (this.beiDouGridSelectedPrimitive) {
          try {
            // 不释放资源，仅隐藏高亮 Primitive，便于后续复用。
            this.beiDouGridSelectedPrimitive.show = false
          } catch (e) {
            // ignore
          }
        }
        this.selectedBeiDouCellId = null
        this.selectedBeiDouCellInfo = null
        requestRenderSafe()
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
        try {
          if (outlinePrimitive) {
            const attr = outlinePrimitive.getGeometryInstanceAttributes(cellId)
            if (attr && attr.color) {
              const metaOutlineColor = this.beiDouGridMeta?.outlineColor
              const selectedOutlineColor = Cesium.Color.RED.withAlpha(
                Number.isFinite(metaOutlineColor?.alpha) ? metaOutlineColor.alpha : 0.95
              )
              attr.color = Cesium.ColorGeometryInstanceAttribute.toValue(selectedOutlineColor)
            }
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

          // instanced 模式：使用官方 Primitive + GeometryInstance 创建单格线框高亮
          if (isInstanced) {
            try {
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

              const metaOutlineColor = this.beiDouGridMeta?.outlineColor
              const selectedOutlineColor = Cesium.Color.RED.withAlpha(
                Number.isFinite(metaOutlineColor?.alpha) ? metaOutlineColor.alpha : 0.95
              )
              if (this.beiDouGridSelectedPrimitive) {
                // 复用已有 Primitive：仅更新 modelMatrix / 颜色 / 显示状态。
                this.beiDouGridSelectedPrimitive.modelMatrix = modelMatrix
                this.beiDouGridSelectedPrimitive.show = true
                try {
                  const attr = this.beiDouGridSelectedPrimitive.getGeometryInstanceAttributes('beidou-selected-cell')
                  if (attr && attr.color) {
                    attr.color = Cesium.ColorGeometryInstanceAttribute.toValue(selectedOutlineColor)
                  }
                } catch (e) {
                  // ignore attribute update errors
                }
              } else {
                const highlightGeometry = new Cesium.BoxOutlineGeometry({
                  minimum: new Cesium.Cartesian3(-metaDx * 0.5, -metaDy * 0.5, -metaDz * 0.5),
                  maximum: new Cesium.Cartesian3(metaDx * 0.5, metaDy * 0.5, metaDz * 0.5)
                })
                const highlightInstance = new Cesium.GeometryInstance({
                  id: 'beidou-selected-cell',
                  geometry: highlightGeometry,
                  modelMatrix: Cesium.Matrix4.IDENTITY,
                  attributes: {
                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(selectedOutlineColor)
                  }
                })
                const highlightPrimitive = new Cesium.Primitive({
                  geometryInstances: [highlightInstance],
                  modelMatrix,
                  appearance: new Cesium.PerInstanceColorAppearance({
                    translucent: true,
                    flat: true
                  })
                })
                this.viewer.scene.primitives.add(highlightPrimitive)
                this.beiDouGridSelectedPrimitive = highlightPrimitive
              }
            } catch (e) {
              // ignore highlight primitive errors
              this.beiDouGridSelectedPrimitive = null
            }
          }
        }
      }
      requestRenderSafe()
    }
  }
})