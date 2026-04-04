import { defineStore } from 'pinia'
import {
  createGridViewshedJob,
  getGridViewshedJobResult,
  getGridViewshedJobStatus
} from '../Analysis/apiClient'

export const useAnalysisStore = defineStore('analysis', {
  state: () => ({
    stations: [],
    analysisResult: null,
    analysisProgress: 0,
    isAnalyzing: false,
    stats: null,
    gridMeta: null,
    layerStats: [],
    // 当前分析类型：固定使用格网可视域后端分析
    analysisType: null,
    preferredAnalysisMode: 'grid-viewshed-1_4ghz',
    gridViewshedResult: null
  }),

  getters: {
    stationCount: (state) => state.stations.length,
    hasResults: (state) => state.analysisResult !== null
  },

  actions: {
    setStations(stations) {
      this.stations = (stations || []).map((s, idx) => ({
        id: s.id || `${Date.now()}-${idx}`,
        ...s,
        position: s.position ? { ...s.position } : s.position
      }))
    },

    setGridMeta(meta) {
      this.gridMeta = meta ? { ...meta } : null
    },

    setPreferredAnalysisMode(mode) {
      this.preferredAnalysisMode = mode || 'grid-viewshed-1_4ghz'
    },

    addStation(station) {
      this.stations.push({
        id: station.id || Date.now().toString(),
        ...station
      })
    },

    removeStation(stationId) {
      this.stations = this.stations.filter(s => s.id !== stationId)
    },

    updateStation(stationId, updates) {
      const index = this.stations.findIndex(s => s.id === stationId)
      if (index !== -1) {
        this.stations[index] = { ...this.stations[index], ...updates }
      }
    },


    setAnalysisResult(result) {
      this.analysisResult = result
    },

    setAnalysisProgress(progress) {
      this.analysisProgress = progress
    },

    setIsAnalyzing(isAnalyzing) {
      this.isAnalyzing = isAnalyzing
    },

    _sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms))
    },

    async _toNumberArrayChunked(source, chunkSize = 50000) {
      if (!source || !Number.isFinite(source.length) || source.length <= 0) return []
      if (Array.isArray(source)) return source

      const len = source.length
      const out = new Array(len)
      for (let i = 0; i < len; i += chunkSize) {
        const end = Math.min(len, i + chunkSize)
        for (let j = i; j < end; j++) out[j] = source[j]
        // 让出主线程，避免大数组转换导致页面假死
        // eslint-disable-next-line no-await-in-loop
        await this._sleep(0)
      }
      return out
    },

    _buildCompactResultFromBackend(payload) {
      const total = payload?.total || 0
      const gridX = payload?.gridX || 0
      const gridY = payload?.gridY || 0
      const gridZ = payload?.gridZ || 0
      const uncovered = Array.isArray(payload?.uncoveredIndices) ? payload.uncoveredIndices : []

      return {
        type: 'gridViewshedCompact',
        total,
        gridX,
        gridY,
        gridZ,
        uncoveredIndices: uncovered,
        stats: payload?.stats || {
          totalPoints: total,
          visiblePoints: 0,
          invisiblePoints: total,
          visibilityRatio: 0
        },
        layerStats: payload?.layerStats || []
      }
    },

    async runGridViewshedAnalysis(params) {
      this.isAnalyzing = true
      this.analysisProgress = 0
      this.stats = null
      this.layerStats = []
      this.analysisType = 'grid-viewshed-1_4ghz'

      // 动态引入 mapStore，避免循环依赖初始化问题
      const { useMapStore } = await import('./map')
      const mapStore = useMapStore()

      const gridMeta = mapStore.beiDouGridMeta || this.gridMeta
      const stations = this.stations || []

      if (!gridMeta || stations.length === 0) {
        this.isAnalyzing = false
        this.analysisResult = []
        this.stats = {
          totalPoints: 0,
          visiblePoints: 0,
          invisiblePoints: 0,
          visibilityRatio: 0
        }
        this.layerStats = []
        return []
      }

      const payload = {
        stations: stations.map((s) => {
          const lon = s.position?.lon ?? s.lon
          const lat = s.position?.lat ?? s.lat
          const absHeight = s.meta?.absoluteHeight
          const groundHeight = s.meta?.groundHeight
          const h = typeof absHeight === 'number' ? absHeight : (groundHeight ?? 0) + (s.position?.height ?? 0)
          return { lon, lat, height: h }
        }).filter(tx => Number.isFinite(tx.lon) && Number.isFinite(tx.lat) && Number.isFinite(tx.height)),
        gridMeta: {
          gridX: gridMeta.gridX,
          gridY: gridMeta.gridY,
          gridZ: gridMeta.gridZ,
          dx: gridMeta.dx,
          dy: gridMeta.dy,
          dz: gridMeta.dz,
          zMinRel: gridMeta.zMinRel ?? gridMeta.zMin ?? 0,
          originLon: gridMeta.originLon,
          originLat: gridMeta.originLat,
          originGroundHeight: gridMeta.originGroundHeight ?? 0,
          groundHeights: await this._toNumberArrayChunked(gridMeta.groundHeights || [])
        },
        params: {
          maxDistance: params.maxDistance || 10000,
          clearance: params.clearance || 3,
          losSamplesMin: params.losSamplesMin || 8,
          losSamplesMax: params.losSamplesMax || 40,
          progressBatchCells: params.progressBatchCells || 10000
        }
      }

      const created = await createGridViewshedJob(payload)
      const jobId = created.jobId
      let status = created.status
      while (status === 'queued' || status === 'running') {
        // eslint-disable-next-line no-await-in-loop
        await this._sleep(500)
        // eslint-disable-next-line no-await-in-loop
        const s = await getGridViewshedJobStatus(jobId)
        status = s.status
        this.analysisProgress = Math.max(0, Math.min(100, Math.round(s.progress || 0)))
      }
      const resultResp = await getGridViewshedJobResult(jobId)
      if (resultResp.status !== 'done' || !resultResp.result) {
        throw new Error(resultResp.error || '后端分析失败')
      }
      const compactResult = this._buildCompactResultFromBackend(resultResp.result)

      this.analysisResult = compactResult
      this.stats = compactResult?.stats || {
        totalPoints: 0,
        visiblePoints: 0,
        invisiblePoints: 0,
        visibilityRatio: 0
      }
      this.layerStats = compactResult?.layerStats || []

      this.isAnalyzing = false
      this.analysisProgress = 100
      this.gridViewshedResult = compactResult
      return compactResult
    },

    clearResults() {
      this.analysisResult = null
      this.analysisProgress = 0
      this.isAnalyzing = false
      this.stats = null
      this.layerStats = []
      this.analysisType = null
      this.gridViewshedResult = null
    },

    clearAll() {
      this.stations = []
      this.clearResults()
    }
  }
})

