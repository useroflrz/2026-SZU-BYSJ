import { defineStore } from 'pinia'

export const useAnalysisStore = defineStore('analysis', {
  state: () => ({
    stations: [],
    analysisResult: null,
    analysisProgress: 0,
    isAnalyzing: false,
    stats: null,
    gridMeta: null,
    layerStats: []
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

    async runAnalysis(params) {
      this.isAnalyzing = true
      this.analysisProgress = 0
      this.stats = null
      this.layerStats = []

      // 模拟：按网格点生成可见性结果，简单随机
      const total = this.gridMeta ? this.gridMeta.totalEstimate || 0 : 0

      // 先根据简单规则给每个格网点生成可视性结果
      const baseResults = []

      // 如果有格网元数据，则根据高度映射出所属层索引，便于结果按层统计/筛选
      let results = baseResults
      const meta = this.gridMeta
      if (meta && typeof meta.zMin === 'number' && typeof meta.dz === 'number' && meta.dz > 0) {
        const layerCount = meta.zCount || Math.max(1, Math.floor((meta.zMax - meta.zMin) / meta.dz))
        results = baseResults.map((pt) => {
          const rawIndex = Math.round((pt.height - meta.zMin) / meta.dz)
          const layerIndex = Math.min(
            Math.max(rawIndex, 0),
            layerCount - 1
          )
          return {
            ...pt,
            layerIndex
          }
        })
      }

      // 伪进度
      for (let p = 0; p <= 100; p += 10) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => setTimeout(resolve, 80))
        this.analysisProgress = p
      }

      this.analysisResult = results

      // 全局统计
      const visible = results.filter(r => r.visible).length
      this.stats = {
        totalPoints: total,
        visiblePoints: visible,
        invisiblePoints: total - visible,
        visibilityRatio: total === 0 ? 0 : visible / total
      }

      // 按层统计（仅当存在 layerIndex 时）
      if (results.length > 0 && typeof results[0].layerIndex === 'number') {
        const maxLayer = results.reduce(
          (acc, r) => (typeof r.layerIndex === 'number' ? Math.max(acc, r.layerIndex) : acc),
          0
        )
        const layerCount = maxLayer + 1
        const layerStats = Array.from({ length: layerCount }, (_, idx) => ({
          layerIndex: idx,
          totalPoints: 0,
          visiblePoints: 0,
          invisiblePoints: 0,
          visibilityRatio: 0,
          zMin: meta ? meta.zMin + idx * (meta.dz || 0) : null,
          zMax: meta ? meta.zMin + (idx + 1) * (meta.dz || 0) : null
        }))

        results.forEach((r) => {
          const li = typeof r.layerIndex === 'number' ? r.layerIndex : 0
          const stat = layerStats[li]
          stat.totalPoints += 1
          if (r.visible) {
            stat.visiblePoints += 1
          } else {
            stat.invisiblePoints += 1
          }
        })

        this.layerStats = layerStats.map((s) => ({
          ...s,
          visibilityRatio: s.totalPoints === 0 ? 0 : s.visiblePoints / s.totalPoints
        }))
      } else {
        this.layerStats = []
      }
      this.isAnalyzing = false
      return results
    },

    clearResults() {
      this.analysisResult = null
      this.analysisProgress = 0
      this.isAnalyzing = false
      this.stats = null
      this.layerStats = []
    },

    clearAll() {
      this.stations = []
      this.gridPoints = []
      this.clearResults()
    }
  }
})

