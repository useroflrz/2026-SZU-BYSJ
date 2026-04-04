<template>
  <div class="result-visualizer">
    <el-form label-width="100px" size="small">
      <!-- 统计信息 -->
      <el-form-item label="统计信息" v-if="hasResults">
        <div class="statistics">
          <div class="stat-item">
            <span class="stat-label">总点数:</span>
            <span class="stat-value">{{ statistics.totalPoints.toLocaleString() }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">可视点数:</span>
            <span class="stat-value" style="color: #67c23a">
              {{ statistics.visiblePoints.toLocaleString() }}
            </span>
          </div>
          <div class="stat-item">
            <span class="stat-label">不可视点数:</span>
            <span class="stat-value" style="color: #f56c6c">
              {{ statistics.invisiblePoints.toLocaleString() }}
            </span>
          </div>
          <div class="stat-item">
            <span class="stat-label">可视比例:</span>
            <span class="stat-value" style="color: #409eff">
              {{ (statistics.visibilityRatio * 100).toFixed(2) }}%
            </span>
          </div>
        </div>
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

const exportResults = () => {
  if (!analysisStore.analysisResult) {
    ElMessage.warning('没有可导出的结果')
    return
  }
  const payload = {
    stats: analysisStore.stats,
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
</style>

