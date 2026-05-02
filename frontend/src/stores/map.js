import { defineStore } from 'pinia'
import * as Cesium from 'cesium'
import { markRaw, toRaw } from 'vue'
import { BeiDouGridPrimitive, createGridInstancesFromBounds, SIGNAL_STATION_HARD_LIMIT } from '../Rendering/BeiDouGridPrimitive'
import { runColumnMaskJobAndWait, sampleLocalDemGrid } from '../Analysis/apiClient'
import {
  buildColumnActiveMask,
  decodeColumnActiveFloat32B64,
  simplifyMultiPolygonCoordinates
} from '../utils/gridColumnClip'

/** 与 Cesium.Globe#terrainExaggeration / terrainExaggerationRelativeHeight 一致（椭球高程，米） */
function applyGlobeTerrainExaggerationToHeightMeters(heightMeters, globe) {
  if (!Number.isFinite(heightMeters)) return heightMeters
  if (!globe) return heightMeters
  const R = Number.isFinite(globe.terrainExaggerationRelativeHeight)
    ? globe.terrainExaggerationRelativeHeight
    : 0
  const E = Number.isFinite(globe.terrainExaggeration) ? globe.terrainExaggeration : 1
  return R + E * (heightMeters - R)
}

async function sampleGridGroundHeights(viewer, normalizedBounds, originLon, originLat, dx, dy, gridX, gridY, options = {}) {
  const {
    batchSize = 500,
    defaultHeight = 0,
    columnActive = null,
    onProgress = null
  } = options

  // Cesium 在某些 Vue3 情况下，若 viewer 是响应式 Proxy，会在 tile availability 计算阶段触发渲染停止错误。
  // 这里强制解包，确保传入 Cesium 的 viewer/terrainProvider 是“原始对象”。
  const rawViewer = toRaw(viewer)
  const terrainProvider = rawViewer?.terrainProvider
  const groundHeights = new Float32Array(gridX * gridY)
  groundHeights.fill(defaultHeight)

  const report = (current, total) => {
    if (typeof onProgress === 'function' && total > 0) {
      onProgress({ current, total })
    }
  }

  if (!terrainProvider || gridX <= 0 || gridY <= 0) {
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

  // 按 (ix,iy) 的柱中心点采样地形高度（gridZ 层不参与采样，避免乘法爆炸）。
  // 若提供 columnActive，仅对有效柱采样，显著减少 SHP 裁剪后大 bbox 下的瓦片请求次数。
  const totalCols = gridX * gridY
  let activeLinear = null
  if (columnActive && columnActive.length === gridX * gridY) {
    let n = 0
    for (let i = 0; i < totalCols; i++) {
      if (columnActive[i] > 0.5) n++
    }
    activeLinear = new Uint32Array(n)
    let w = 0
    for (let i = 0; i < totalCols; i++) {
      if (columnActive[i] > 0.5) activeLinear[w++] = i
    }
  }
  const toSampleCount = activeLinear ? activeLinear.length : totalCols
  let sampledSoFar = 0

  const sampleBatch = async (idxs) => {
    if (idxs.length === 0) return
    const cartos = []
    for (let b = 0; b < idxs.length; b++) {
      const linear = idxs[b]
      const ix = linear % gridX
      const iy = Math.floor(linear / gridX)
      const localX = (ix + 0.5) * dx
      const localY = (iy + 0.5) * dy
      const lon = originLon + localX / safeMetersPerDegLon
      const lat = originLat + localY / metersPerDegLat
      cartos.push(Cesium.Cartographic.fromDegrees(lon, lat))
    }
    try {
      await safeSample(cartos)
      for (let j = 0; j < cartos.length; j++) {
        const h = cartos[j]?.height
        groundHeights[idxs[j]] = Number.isFinite(h) ? h : defaultHeight
      }
    } catch (e) {
      for (let b = 0; b < idxs.length; b++) {
        groundHeights[idxs[b]] = defaultHeight
      }
    }
    sampledSoFar += idxs.length
    report(sampledSoFar, toSampleCount)
  }

  if (activeLinear) {
    for (let start = 0; start < activeLinear.length; start += batchSize) {
      const end = Math.min(activeLinear.length, start + batchSize)
      await sampleBatch(activeLinear.subarray(start, end))
    }
  } else {
    for (let start = 0; start < totalCols; start += batchSize) {
      const end = Math.min(totalCols, start + batchSize)
      const idxs = new Uint32Array(end - start)
      for (let k = 0, linear = start; linear < end; linear++, k++) {
        idxs[k] = linear
      }
      await sampleBatch(idxs)
    }
  }

  return { originGroundHeight, groundHeights }
}

async function sampleGridGroundHeightsFromLocalDem(
  demFile,
  normalizedBounds,
  originLon,
  originLat,
  dx,
  dy,
  gridX,
  gridY,
  options = {}
) {
  const { defaultHeight = 0, columnActive = null, onProgress = null } = options
  if (!demFile) {
    throw new Error('本地DEM文件未选择')
  }
  const encodeFloat32ToB64 = (arr) => {
    if (!(arr instanceof Float32Array)) return null
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
    let binary = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const sub = bytes.subarray(i, Math.min(bytes.length, i + CHUNK))
      binary += String.fromCharCode(...sub)
    }
    return btoa(binary)
  }
  const decodeFloat32B64 = (b64) => {
    const bin = atob(b64 || '')
    const buf = new ArrayBuffer(bin.length)
    const view = new Uint8Array(buf)
    for (let i = 0; i < bin.length; i++) {
      view[i] = bin.charCodeAt(i)
    }
    return new Float32Array(buf)
  }

  const payload = {
    minLon: normalizedBounds.minLon,
    minLat: normalizedBounds.minLat,
    maxLon: normalizedBounds.maxLon,
    maxLat: normalizedBounds.maxLat,
    originLon,
    originLat,
    dx,
    dy,
    gridX,
    gridY,
    defaultHeight,
    columnActiveB64: columnActive ? encodeFloat32ToB64(columnActive) : null
  }
  const resp = await sampleLocalDemGrid(payload, demFile)
  const groundHeights = decodeFloat32B64(resp.groundHeightsB64)
  if (groundHeights.length !== gridX * gridY) {
    throw new Error('后端返回的DEM高程数组长度不匹配')
  }
  if (typeof onProgress === 'function') {
    onProgress({ current: resp.sampledColumns ?? groundHeights.length, total: resp.totalColumns ?? groundHeights.length })
  }
  const originHeight = Number(resp.originGroundHeight)
  return {
    originGroundHeight: Number.isFinite(originHeight) ? originHeight : defaultHeight,
    groundHeights
  }
}

// 简单的实体/集合管理器，集中存储各类图层的 ids，便于销毁/显隐
const defaultLayerState = () => ({
  regionEntityId: null,
  regionClipEntityIds: [],
  stationEntityIds: [],
  resultEntityIds: []
})

function normalizeBounds(bounds) {
  const b = bounds || {}
  const minLon = b.minX ?? b.minLon
  const minLat = b.minY ?? b.minLat
  const maxLon = b.maxX ?? b.maxLon
  const maxLat = b.maxY ?? b.maxLat
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return null
  return { minLon, minLat, maxLon, maxLat }
}

function hashClipCoordinates(coords) {
  if (!coords || !Array.isArray(coords) || coords.length === 0) return 'no-clip'
  let h = 2166136261 >>> 0 // FNV-1a basis
  let samples = 0
  const maxSamples = 5000
  const mix = (n) => {
    const x = (n * 1e6) | 0
    h ^= x >>> 0
    h = Math.imul(h, 16777619) >>> 0
  }
  // coords: MultiPolygon -> [ [ [ [lon,lat], ... ] ] , ... ]
  for (let p = 0; p < coords.length && samples < maxSamples; p++) {
    const poly = coords[p]
    if (!poly || !Array.isArray(poly) || poly.length === 0) continue
    const ring = poly[0]
    if (!ring || !Array.isArray(ring)) continue
    for (let i = 0; i < ring.length && samples < maxSamples; i++) {
      const pt = ring[i]
      if (!pt || pt.length < 2) continue
      const lon = pt[0]
      const lat = pt[1]
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
      mix(lon)
      mix(lat)
      samples++
    }
  }
  return `clip-${h.toString(16)}-${samples}`
}

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
    selectedBeiDouCellInfo: null,
    // 信号强度模拟图层（独立于北斗格网/分析结果）
    signalStrengthLayer: null,
    // 格网“数据集”缓存：同一 bounds + dx/dy/dz + zMin/zMax + clip 下复用后端掩膜与地形采样结果
    beiDouGridDatasetCache: markRaw(new Map()),
    localDemFile: null,
    localDemVersion: 0
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

    setLocalDemFile(file) {
      this.localDemFile = markRaw(file || null)
      this.localDemVersion += 1
    },

    clearLocalDemFile() {
      this.localDemFile = null
      this.localDemVersion += 1
    },

    _getSignalTargetPrimitive() {
      const p = this.beiDouGridPrimitive
      if (p && typeof p.setSignalParams === 'function') return p
      return null
    },

    clearSignalStrengthGrid() {
      const p = this._getSignalTargetPrimitive()
      if (p) {
        p.setSignalParams({ enabled: false })
      }
      this.signalStrengthLayer = null
      try {
        if (this.viewer?.scene?.requestRender) this.viewer.scene.requestRender()
      } catch (e) {
        // ignore
      }
    },

    setSignalStrengthVisibility(show) {
      const layer = this.signalStrengthLayer
      if (!layer) return
      const p = this._getSignalTargetPrimitive()
      if (!p) {
        layer.show = !!show
        return
      }
      try {
        p.show = true
      } catch (e) {
        // ignore
      }
      if (show) {
        const cachedParams = layer.signalParams || {}
        p.setSignalParams({
          ...cachedParams,
          enabled: true
        })
      } else {
        p.setSignalParams({ enabled: false })
      }
      layer.show = !!show
      try {
        if (this.viewer?.scene?.requestRender) this.viewer.scene.requestRender()
      } catch (e) {
        // ignore
      }
    },

    async showSignalStrengthGrid(params = {}) {
      if (!this.viewer) throw new Error('viewer 未初始化')
      if (!this.beiDouGridMeta) {
        throw new Error('请先在“格网配置”中生成格网')
      }

      const stationsRaw = Array.isArray(params.stations) ? params.stations : []
      if (stationsRaw.length === 0) throw new Error('未提供基站')
      const freqMHz = Number(params.freqMHz)
      if (!Number.isFinite(freqMHz) || freqMHz <= 0) throw new Error('频率无效')
      const opacity = Number(params.opacity)
      if (!Number.isFinite(opacity) || opacity <= 0) throw new Error('透明度无效')
      const requestedMaxStations = Math.floor(Number(params.maxStations))
      const stationCountUpperBound = stationsRaw.length
      const maxStations = Math.max(
        1,
        Math.min(
          SIGNAL_STATION_HARD_LIMIT,
          stationCountUpperBound,
          Number.isFinite(requestedMaxStations) ? requestedMaxStations : stationCountUpperBound
        )
      )

      // 若当前是 geometryInstances 模式，复用当前参数重建为 instanced（仍是“格网配置”的同一套格网）
      if (!this._getSignalTargetPrimitive()) {
        const meta = this.beiDouGridMeta
        await this.showBeiDouGrid(meta.bounds, {
          dx: meta.dx,
          dy: meta.dy,
          dz: meta.dz,
          zMin: meta.zMin,
          zMax: meta.zMax,
          fillColor: '#67C23A',
          fillOpacity: meta.baseFillColor?.alpha ?? 0.05,
          outlineColor: '#000000',
          outlineOpacity: meta.baseOutlineColor?.alpha ?? 0.95,
          columnActive: meta.columnActive,
          renderModeOverride: 'instanced',
          elevationMode: meta.elevationMode || 'terrain'
        })
      }

      const primitive = this._getSignalTargetPrimitive()
      if (!primitive) throw new Error('当前格网不支持信号着色')

      const stations = stationsRaw
        .map((s) => ({
          lon: Number(s.lon ?? s.position?.lon),
          lat: Number(s.lat ?? s.position?.lat),
          height: Number(s.height ?? s.position?.height ?? 0)
        }))
        .filter((s) => Number.isFinite(s.lon) && Number.isFinite(s.lat) && Number.isFinite(s.height))
      if (stations.length === 0) throw new Error('基站坐标无效')

      const stationCart = []
      for (let i = 0; i < stations.length && stationCart.length < maxStations; i++) {
        const s = stations[i]
        stationCart.push(Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.height))
      }

      const m = this.beiDouGridMeta
      const gridDiagM = Math.sqrt(
        (m.gridX * m.dx) ** 2 +
        (m.gridY * m.dy) ** 2 +
        (m.gridZ * m.dz) ** 2
      )
      const maxDistM = Number.isFinite(params.radiusM) && params.radiusM > 0
        ? params.radiusM
        : Math.max(100.0, gridDiagM)

      const signalGamma = Number(params.signalGamma)
      const signalBands = Number(params.signalBands)
      const eirpDbm = Number(params.eirpDbm)
      const rxGainDbi = Number(params.rxGainDbi)
      const miscLossDb = Number(params.miscLossDb)

      const minDistMRaw = Number(params.minDistM)
      let resolvedMinDistM = Number.isFinite(minDistMRaw) ? Math.max(10.0, minDistMRaw) : 120.0
      if (resolvedMinDistM >= maxDistM) {
        resolvedMinDistM = Math.max(10.0, maxDistM * 0.15)
      }
      const signalParams = {
        enabled: true,
        freqMHz,
        minDistM: resolvedMinDistM,
        maxDistM,
        alpha: opacity,
        signalGamma: Number.isFinite(signalGamma) ? signalGamma : 0.4,
        signalBands: Number.isFinite(signalBands) ? signalBands : 0.0,
        eirpDbm: Number.isFinite(eirpDbm) ? eirpDbm : 43.0,
        rxGainDbi: Number.isFinite(rxGainDbi) ? rxGainDbi : 0.0,
        miscLossDb: Number.isFinite(miscLossDb) ? miscLossDb : 0.0,
        stationsEcef: stationCart
      }
      primitive.setSignalParams(signalParams)

      this.signalStrengthLayer = markRaw({
        type: 'signal-strength',
        show: true,
        source: 'beidou-existing-grid',
        freqMHz,
        stationCount: stationCart.length,
        requestedMaxStations: maxStations,
        signalParams
      })
      try {
        if (this.viewer?.scene?.requestRender) this.viewer.scene.requestRender()
      } catch (e) {
        // ignore
      }
      return this.signalStrengthLayer
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
            scale: 0.3,
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
        const rawPrimitive = toRaw(primitive)
        if (!rawPrimitive) return
        try {
          const primitives = this.viewer.scene?.primitives
          // 先直接尝试从集合移除，避免 contains 在部分对象/版本下不可靠造成漏删。
          const removed = !!primitives?.remove?.(rawPrimitive)
          if (removed) return
          if (typeof rawPrimitive.isDestroyed === 'function' && !rawPrimitive.isDestroyed()) {
            this.schedulePrimitiveDestroy(rawPrimitive)
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
        fillOpacity: 0.05,
        outlineColor: '#F56C6C',
        outlineOpacity: 0.8,
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

    _buildBeiDouGridDatasetKey(normalizedBounds, gridParams, clipHash, elevationMode = 'terrain', localDemVersion = 0) {
      const b = normalizedBounds
      const dx = gridParams?.dx
      const dy = gridParams?.dy
      const dz = gridParams?.dz
      const zMin = gridParams?.zMin
      const zMax = gridParams?.zMax
      return [
        `b=${b.minLon.toFixed(7)},${b.minLat.toFixed(7)},${b.maxLon.toFixed(7)},${b.maxLat.toFixed(7)}`,
        `dx=${Number(dx).toFixed(4)}`,
        `dy=${Number(dy).toFixed(4)}`,
        `dz=${Number(dz).toFixed(4)}`,
        `zMin=${Number(zMin).toFixed(4)}`,
        `zMax=${Number(zMax).toFixed(4)}`,
        `elev=${elevationMode}`,
        `dem=${Number(localDemVersion)}`,
        clipHash || 'no-clip'
      ].join('|')
    },

    /**
     * 准备（或复用）格网数据集：柱掩膜 + 地形采样。三种渲染模式共享同一 dataset。
     * @returns {Promise<{ key: string, normalizedBounds: any, dx:number,dy:number,dz:number,zMin:number,zMax:number,gridX:number,gridY:number,gridZ:number,originLon:number,originLat:number,originGroundHeight:number,groundHeights:Float32Array,columnActive:Float32Array,activeColumns:number,activeCellTotal:number,bboxCellTotal:number }>}
     */
    async prepareBeiDouGridDataset(bounds, gridParams, options = {}) {
      if (!this.viewer) return null
      const normalizedBounds = normalizeBounds(bounds)
      if (!normalizedBounds) return null

      const {
        dx,
        dy,
        dz,
        zMin,
        zMax,
        onTerrainSampleProgress,
        elevationMode = 'terrain'
      } = gridParams || {}
      if (![dx, dy, dz, zMin, zMax].every(Number.isFinite)) return null

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
        Math.abs((sr.bounds.minX ?? sr.bounds.minLon) - normalizedBounds.minLon) < 1e-7 &&
        Math.abs((sr.bounds.minY ?? sr.bounds.minLat) - normalizedBounds.minLat) < 1e-7 &&
        Math.abs((sr.bounds.maxX ?? sr.bounds.maxLon) - normalizedBounds.maxLon) < 1e-7 &&
        Math.abs((sr.bounds.maxY ?? sr.bounds.maxLat) - normalizedBounds.maxLat) < 1e-7
      const clip = bEq && sr?.clipGeoJson?.type === 'MultiPolygon' ? sr.clipGeoJson : null
      const rawClipCoords =
        clip?.coordinates && Array.isArray(clip.coordinates) && clip.coordinates.length
          ? clip.coordinates
          : null
      const clipHash = hashClipCoordinates(rawClipCoords)
      const resolvedElevationMode = elevationMode === 'localDem' ? 'localDem' : 'terrain'
      const key = this._buildBeiDouGridDatasetKey(
        normalizedBounds,
        gridParams,
        clipHash,
        resolvedElevationMode,
        resolvedElevationMode === 'localDem' ? this.localDemVersion : 0
      )

      const cached = this.beiDouGridDatasetCache?.get?.(key)
      if (cached) {
        return cached
      }

      // 1) 柱掩膜（同一个 key 只算一次：后端优先，失败回退前端）
      let columnActive = null
      if (gridParams.columnActive && gridParams.columnActive.length === gridX * gridY) {
        columnActive =
          gridParams.columnActive instanceof Float32Array
            ? gridParams.columnActive
            : Float32Array.from(gridParams.columnActive)
      } else if (rawClipCoords) {
        try {
          const maskResult = await runColumnMaskJobAndWait({
            minLon: normalizedBounds.minLon,
            minLat: normalizedBounds.minLat,
            maxLon: normalizedBounds.maxLon,
            maxLat: normalizedBounds.maxLat,
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
            originLon: normalizedBounds.minLon,
            originLat: normalizedBounds.minLat,
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
          originLon: normalizedBounds.minLon,
          originLat: normalizedBounds.minLat,
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

      // 2) 高程采样（同一个 key 只采样一次）
      const originLon = normalizedBounds.minLon
      const originLat = normalizedBounds.minLat
      let sampledResult = null
      if (resolvedElevationMode === 'localDem') {
        if (!this.localDemFile) {
          throw new Error('本地DEM模式未加载GeoTIFF，请先在格网生成实验中加载DEM文件')
        }
        sampledResult = await sampleGridGroundHeightsFromLocalDem(
          this.localDemFile,
          normalizedBounds,
          originLon,
          originLat,
          dx,
          dy,
          gridX,
          gridY,
          {
            defaultHeight: 0,
            columnActive,
            onProgress: onTerrainSampleProgress
          }
        )
      } else {
        sampledResult = await sampleGridGroundHeights(
          this.viewer,
          normalizedBounds,
          originLon,
          originLat,
          dx,
          dy,
          gridX,
          gridY,
          {
            batchSize: options.batchSize ?? 500,
            defaultHeight: 0,
            columnActive,
            onProgress: onTerrainSampleProgress
          }
        )
      }
      const { originGroundHeight, groundHeights } = sampledResult

      const dataset = markRaw({
        type: 'beidou-grid-dataset',
        key,
        normalizedBounds,
        dx,
        dy,
        dz,
        zMin,
        zMax,
        gridX,
        gridY,
        gridZ,
        bboxCellTotal,
        activeColumns,
        activeCellTotal,
        originLon,
        originLat,
        originGroundHeight,
        groundHeights: markRaw(groundHeights),
        columnActive: markRaw(new Float32Array(columnActive)),
        clipHash,
        elevationMode: resolvedElevationMode,
        createdAt: Date.now()
      })
      try {
        this.beiDouGridDatasetCache.set(key, dataset)
        // 简单容量控制：避免长时间跑批导致内存无限增长
        const MAX_CACHE_ITEMS = 25
        if (this.beiDouGridDatasetCache.size > MAX_CACHE_ITEMS) {
          let oldestKey = null
          let oldestTs = Number.POSITIVE_INFINITY
          for (const [k, v] of this.beiDouGridDatasetCache.entries()) {
            const ts = v?.createdAt
            if (Number.isFinite(ts) && ts < oldestTs) {
              oldestTs = ts
              oldestKey = k
            }
          }
          if (oldestKey && oldestKey !== key) {
            this.beiDouGridDatasetCache.delete(oldestKey)
          }
        }
      } catch (e) {
        // ignore cache set failures
      }
      return dataset
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

      const normalizedBounds = normalizeBounds(bounds)
      if (!normalizedBounds) {
        console.warn('[map] showBeiDouGrid: bounds 无效，格网未渲染。', bounds)
        return null
      }

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
        hiddenInstanceIndices,
        onTerrainSampleProgress,
        renderModeOverride,
        elevationMode = 'terrain'
      } = gridParams

      const __debugBeiDou = !!import.meta.env?.DEV
      if (__debugBeiDou) {
        console.groupCollapsed('[BeiDouGrid] showBeiDouGrid')
        console.log('📊 Grid Params:', { dx, dy, dz, zMin, zMax, bounds: normalizedBounds, renderModeOverride })
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

      const dataset = await this.prepareBeiDouGridDataset(normalizedBounds, {
        ...gridParams,
        dx,
        dy,
        dz,
        zMin,
        zMax,
        onTerrainSampleProgress,
        elevationMode
      })
      if (!dataset) return null
      const columnActive = dataset.columnActive
      const activeColumns = dataset.activeColumns
      const activeCellTotal = dataset.activeCellTotal
      const total = bboxCellTotal

      if (activeColumns === 0) {
        console.warn('[map] showBeiDouGrid: 当前边界与裁剪多边形下无有效柱（请检查 SHP 与边界是否一致）')
        return null
      }

      const MAX_GEOMETRY_INSTANCES = 120000
      const normalizedRenderModeOverride =
        renderModeOverride === 'geometryInstances' || renderModeOverride === 'instanced'
          ? renderModeOverride
          : 'auto'
      const useInstancing =
        normalizedRenderModeOverride === 'instanced'
          ? true
          : normalizedRenderModeOverride === 'geometryInstances'
            ? false
            : total > MAX_GEOMETRY_INSTANCES
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

      const originLon = dataset.originLon
      const originLat = dataset.originLat

      // 采样地形高度（dataset 内为真实椭球高程，供后端分析）；渲染时按 Globe 夸张系数变换以贴合当前地形显示
      const originGroundHeightRaw = dataset.originGroundHeight
      const groundHeightsRaw = dataset.groundHeights
      const isTerrainDataset = dataset.elevationMode !== 'localDem'
      const globeRg = isTerrainDataset ? toRaw(this.viewer)?.scene?.globe : null
      const originGroundHeightRender = applyGlobeTerrainExaggerationToHeightMeters(originGroundHeightRaw, globeRg)
      let groundHeightsRender = groundHeightsRaw
      if (groundHeightsRaw && groundHeightsRaw.length === gridX * gridY) {
        groundHeightsRender = new Float32Array(groundHeightsRaw.length)
        for (let gi = 0; gi < groundHeightsRaw.length; gi++) {
          groundHeightsRender[gi] = applyGlobeTerrainExaggerationToHeightMeters(groundHeightsRaw[gi], globeRg)
        }
      }

      const zMinRel = zMin
      const originCartesian = Cesium.Cartesian3.fromDegrees(originLon, originLat, originGroundHeightRender)
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
            const groundH = groundHeightsRender?.[colIndex] ?? originGroundHeightRender
            for (let iz = 0; iz < gridZ; iz++) {
              const instanceIndex = iz * gridX * gridY + iy * gridX + ix
              if (hiddenFlags && hiddenFlags[instanceIndex] === 1) continue
              const centerZRel = zMinRel + (iz + 0.5) * dz + (groundH - originGroundHeightRender)
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
        const primitiveRaw = markRaw(primitive)
        this.viewer.scene.primitives.add(primitiveRaw)
        if (saveAsResultLayer) this.beiDouGridResultPrimitive = primitiveRaw
        else this.beiDouGridPrimitive = primitiveRaw

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
          outlinePrimitive = markRaw(outlinePrimitive)
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
            originGroundHeight: originGroundHeightRender,
            groundHeights: groundHeightsRender,
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
              visibleDistance: 1e9,
              outlineScreenFadeEnabled: true,
              outlineScreenPxMin: 10,
              outlineScreenPxMax: 32
            },
            debug: import.meta.env?.DEV
          }
        )

        const primitiveRaw = markRaw(primitive)
        scene.primitives.add(primitiveRaw)
        if (saveAsResultLayer) {
          this.beiDouGridResultPrimitive = primitiveRaw
          this.beiDouGridResultInstancedPrimitives = [primitiveRaw]
          this.beiDouGridResultOutlinePrimitive = null
        } else {
          this.beiDouGridPrimitive = primitiveRaw
          this.beiDouGridInstancedPrimitives = [primitiveRaw]
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
          // ENU 原点（originLon,originLat）处：真实采样椭球高度 + zMin（与后端分析一致，不含地形夸张）
          zStartAbsOrigin: originGroundHeightRaw + zMin,
          gridX,
          gridY,
          gridZ,
          renderedCount,
          renderStep: 1,
          originGroundHeight: originGroundHeightRaw,
          originLon,
          originLat,
          originCartesian,
          originENU,
          groundHeights: groundHeightsRaw,
          columnActive: new Float32Array(columnActive),
          elevationMode: dataset.elevationMode || elevationMode,
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
        const rawPrimitive = toRaw(primitive)
        if (!rawPrimitive) return
        try {
          const primitives = this.viewer.scene?.primitives
          // 先直接尝试从集合移除，避免 contains 在部分对象/版本下不可靠造成漏删。
          const removed = !!primitives?.remove?.(rawPrimitive)
          if (removed) return
          if (typeof rawPrimitive.isDestroyed === 'function') {
            if (!rawPrimitive.isDestroyed()) {
              this.schedulePrimitiveDestroy(rawPrimitive)
            }
          } else {
            this.schedulePrimitiveDestroy(rawPrimitive)
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
      this.signalStrengthLayer = null

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
            originGroundHeight: ogRawMeta,
            groundHeights: ghRawMeta,
            gridX: metaGridX,
            originLon: olonMeta,
            originLat: olatMeta
          } = this.beiDouGridMeta

          const globePick = toRaw(this.viewer)?.scene?.globe
          const originGrMeta = applyGlobeTerrainExaggerationToHeightMeters(ogRawMeta, globePick)
          const colIndexPick = iy * metaGridX + ix
          const groundGrMeta = applyGlobeTerrainExaggerationToHeightMeters(
            ghRawMeta?.[colIndexPick] ?? ogRawMeta,
            globePick
          )
          const originCartesianPick = Cesium.Cartesian3.fromDegrees(olonMeta, olatMeta, originGrMeta)
          const originENUPick = Cesium.Transforms.eastNorthUpToFixedFrame(originCartesianPick)

          let lon = 0, lat = 0, height = 0
          try {
            const localCenter = new Cesium.Cartesian3(
              (ix + 0.5) * metaDx,
              (iy + 0.5) * metaDy,
              zMinRel + (iz + 0.5) * metaDz + (groundGrMeta - originGrMeta)
            )
            const world = Cesium.Matrix4.multiplyByPoint(originENUPick, localCenter, new Cesium.Cartesian3())
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
              const localTranslation = new Cesium.Cartesian3(
                (ix + 0.5) * metaDx,
                (iy + 0.5) * metaDy,
                zMinRel + (iz + 0.5) * metaDz + (groundGrMeta - originGrMeta)
              )
              const modelMatrix = Cesium.Matrix4.multiplyByTranslation(
                originENUPick,
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