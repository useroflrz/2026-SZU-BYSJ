import { defineStore } from 'pinia'

export const useAnalysisStore = defineStore('analysis', {
  state: () => ({
    stations: [],
    gridPoints: [],
    analysisResult: null,
    analysisProgress: 0,
    isAnalyzing: false,
    stats: null,
    gridMeta: null,
    layerStats: []
  }),

  getters: {
    stationCount: (state) => state.stations.length,
    gridPointCount: (state) => state.gridPoints.length,
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

    generateGrid(bounds, { dx, dy, dz, zMin, zMax }) {
      // 将经纬度范围转换为粗略米（考虑纬度对经度长度的影响）
      const centerLatDeg = (bounds.minLat + bounds.maxLat) * 0.5
      const centerLatRad = (centerLatDeg * Math.PI) / 180.0
      const metersPerDegLat = 111000.0
      const metersPerDegLon = 111000.0 * Math.cos(centerLatRad)

      const widthM = Math.max(
        0,
        (bounds.maxLon - bounds.minLon) * metersPerDegLon
      )
      const heightM = Math.max(
        0,
        (bounds.maxLat - bounds.minLat) * metersPerDegLat
      )

      // 根据选定区域面积和格网尺寸计算格网数量，使用向上取整使格网完全覆盖选定区域
      // 按用户给定的 dx/dy/dz 严格生成格网，不再自动放大步长
      const zCount = Math.max(1, Math.ceil((zMax - zMin) / dz))

      const xCount = Math.max(1, Math.ceil(widthM / dx))
      const yCount = Math.max(1, Math.ceil(heightM / dy))
      const total = xCount * yCount * zCount
      const capped = false

      const lonStep = dx / Math.max(1e-9, metersPerDegLon)
      const latStep = dy / metersPerDegLat
      // 格网中心从边界内半格起步，使格网均匀铺满并覆盖区域
      const lonStart = bounds.minLon + 0.5 * lonStep
      const latStart = bounds.minLat + 0.5 * latStep

      const points = []
      for (let ix = 0; ix < xCount; ix++) {
        for (let iy = 0; iy < yCount; iy++) {
          for (let iz = 0; iz < zCount; iz++) {
            const lon = lonStart + ix * lonStep
            const lat = latStart + iy * latStep
            const height = zMin + iz * dz
            points.push({ lon, lat, height })
          }
        }
      }

      this.gridPoints = points

      // 记录格网元数据，供后续按层统计与筛选
      this.gridMeta = {
        bounds,
        dx,
        dy,
        dz,
        zMin,
        zMax,
        xCount,
        yCount,
        zCount,
        totalEstimate: total,
        sampledCount: points.length
      }

      return {
        sampledCount: points.length,
        totalEstimate: total,
        layerCount: zCount,
        pointsPerLayerEstimate: xCount * yCount,
        capped,
        usedDx: dx,
        usedDy: dy
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
      const total = this.gridPoints.length

      // 先根据简单规则给每个格网点生成可视性结果
      const baseResults = this.gridPoints.map(pt => ({
        ...pt,
        visible: Math.random() > 0.35 // 约 65% 可视（示意用）
      }))

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

