<template>
  <div class="result-visualizer">
    <el-form label-width="100px" size="small">
      <!-- 统计信息 -->
      <el-form-item label="统计信息" v-if="hasResults">
        <div class="statistics">
          <div class="stat-item">
            <span class="stat-label">总网格（体素）:</span>
            <span class="stat-value">{{ statistics.totalPoints.toLocaleString() }}</span>
          </div>
          <div class="stat-item" v-if="statistics.bboxCells != null">
            <span class="stat-label">矩形范围体素:</span>
            <span class="stat-value">{{ statistics.bboxCells.toLocaleString() }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">到达:</span>
            <span class="stat-value" style="color: #67c23a">
              {{ statistics.visiblePoints.toLocaleString() }}
            </span>
          </div>
          <div class="stat-item">
            <span class="stat-label">未到达:</span>
            <span class="stat-value" style="color: #f56c6c">
              {{ statistics.invisiblePoints.toLocaleString() }}
            </span>
          </div>
          <div class="stat-item">
            <span class="stat-label">到达比例:</span>
            <span class="stat-value" style="color: #409eff">
              {{ (statistics.visibilityRatio * 100).toFixed(2) }}%
            </span>
          </div>
          <div class="stat-item">
            <span class="stat-label">基站数:</span>
            <span class="stat-value">{{ stationCountDisplay }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">覆盖面积:</span>
            <span class="stat-value">{{ coveredAreaDisplay }}</span>
          </div>
        </div>
      </el-form-item>

      <el-form-item label="分层统计" v-if="hasResults && layerStats.length > 0">
        <el-table :data="layerStats" border size="small" max-height="280" class="layer-table">
          <el-table-column prop="layerIndex" label="层" width="52" />
          <el-table-column label="到达" width="100">
            <template #default="{ row }">
              {{ (row.visiblePoints ?? 0).toLocaleString() }}
            </template>
          </el-table-column>
          <el-table-column label="未到达" width="100">
            <template #default="{ row }">
              {{ (row.invisiblePoints ?? 0).toLocaleString() }}
            </template>
          </el-table-column>
          <el-table-column label="高度(m)" min-width="120">
            <template #default="{ row }">
              {{ formatZRange(row) }}
            </template>
          </el-table-column>
        </el-table>
      </el-form-item>

      <el-divider />

      <el-form-item>
        <el-button type="primary" @click="exportResults">
          <el-icon><Download /></el-icon>
          导出结果
        </el-button>
        <el-button @click="clearResults">清除结果</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Download } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useAnalysisStore } from '../stores/analysis'
import { useMapStore } from '../stores/map'

const analysisStore = useAnalysisStore()
const mapStore = useMapStore()

const hasResults = computed(() => {
  return analysisStore.analysisResult !== null
})

const statistics = computed(() => {
  return (
    analysisStore.stats || {
      totalPoints: 0,
      visiblePoints: 0,
      invisiblePoints: 0,
      visibilityRatio: 0
    }
  )
})

const layerStats = computed(() => analysisStore.layerStats || [])

const stationCountDisplay = computed(() => {
  const s = statistics.value.stationCount
  if (typeof s === 'number' && Number.isFinite(s)) return String(s)
  return String(analysisStore.stationCount ?? 0)
})

function formatAreaM2(m2) {
  if (!Number.isFinite(m2)) return '-'
  if (m2 >= 1e6) return `${(m2 / 1e6).toFixed(3)} km²`
  return `${m2.toFixed(0)} m²`
}

const coveredAreaDisplay = computed(() =>
  formatAreaM2(statistics.value.coveredAreaM2)
)

function formatZRange(row) {
  const a = row.zMin
  const b = row.zMax
  if (Number.isFinite(a) && Number.isFinite(b)) return `${a.toFixed(1)} ~ ${b.toFixed(1)}`
  return '-'
}

const exportResults = () => {
  if (!analysisStore.analysisResult) {
    ElMessage.warning('没有可导出的结果')
    return
  }
  const payload = {
    stats: analysisStore.stats,
    layerStats: analysisStore.layerStats,
    results: analysisStore.analysisResult
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json'
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'analysis-results.json'
  a.click()
  URL.revokeObjectURL(url)
  ElMessage.success('结果已导出为 analysis-results.json')
}

const clearResults = () => {
  analysisStore.clearResults()
  if (mapStore.viewer) {
    void mapStore.restoreBeiDouBaseGrid()
  }
  ElMessage.info('结果已清除')
}
</script>

<style scoped>
.result-visualizer {
  padding: 8px 0;
  text-align: center;
}

.result-visualizer :deep(.el-form-item) {
  text-align: left;
  margin-bottom: 20px;
}

.result-visualizer :deep(.el-form-item__label) {
  text-align: left;
}

.statistics {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: #f5f7fa;
  border-radius: 4px;
}

.stat-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.stat-label {
  font-size: 12px;
  color: #666;
}

.stat-value {
  font-size: 14px;
  font-weight: 600;
  color: #333;
}

.layer-table {
  width: 100%;
}
</style>
