<template>
  <div class="result-visualizer">
    <el-form label-width="100px" size="small">
      <el-form-item label="可视化方式">
        <el-radio-group v-model="visualizationMode">
          <el-radio label="pointcloud">点云渲染</el-radio>
          <el-radio label="heatmap">热力图</el-radio>
          <el-radio label="chart">统计图表</el-radio>
        </el-radio-group>
      </el-form-item>

      <el-divider />

      <!-- 点云渲染选项 -->
      <template v-if="visualizationMode === 'pointcloud'">
        <el-form-item label="颜色方案">
          <el-select v-model="colorScheme" style="width: 100%">
            <el-option label="绿色=可视, 红色=不可视" value="green_red" />
            <el-option label="蓝色=可视, 灰色=不可视" value="blue_gray" />
            <el-option label="按可视比例渐变" value="gradient" />
          </el-select>
        </el-form-item>
        <el-form-item label="点大小">
          <el-slider v-model="pointSize" :min="1" :max="10" />
        </el-form-item>
        <el-form-item label="按层高筛选">
          <el-checkbox v-model="filterByHeight">启用层高筛选</el-checkbox>
        </el-form-item>
        <el-form-item v-if="filterByHeight" label="高度范围">
          <el-slider
            v-model="heightRange"
            range
            :min="0"
            :max="500"
            :step="10"
          />
        </el-form-item>
      </template>

      <!-- 热力图选项 -->
      <template v-if="visualizationMode === 'heatmap'">
        <el-form-item label="热力图类型">
          <el-select v-model="heatmapType" style="width: 100%">
            <el-option label="基于可视比例" value="visibility_ratio" />
            <el-option label="基于可视点数" value="visible_count" />
          </el-select>
        </el-form-item>
        <el-form-item label="透明度">
          <el-slider v-model="opacity" :min="0" :max="100" />
        </el-form-item>
      </template>

      <!-- 图层控制 -->
      <el-divider />
      <el-form-item label="图层控制">
        <div class="layer-controls">
          <el-checkbox v-model="showResultLayer">显示结果图层</el-checkbox>
          <el-checkbox v-model="showStationLayer">显示站点图层</el-checkbox>
          <el-checkbox v-model="showDSMLayer">显示DSM图层</el-checkbox>
        </div>
      </el-form-item>
      <el-form-item label="图层透明度">
        <el-slider v-model="layerOpacity" :min="0" :max="100" />
      </el-form-item>

      <!-- 按层查看未覆盖格网 -->
      <el-divider v-if="layerStats.length > 0" />
      <el-form-item v-if="layerStats.length > 0" label="未覆盖层选择">
        <el-select
          v-model="selectedLayerIndex"
          placeholder="选择存在未覆盖格网的层"
          style="width: 100%"
        >
          <el-option
            v-for="layer in layerStats"
            v-if="layer.invisiblePoints > 0"
            :key="layer.layerIndex"
            :label="`第 ${layer.layerIndex + 1} 层 未覆盖 ${layer.invisiblePoints.toLocaleString()} / ${layer.totalPoints.toLocaleString()}`"
            :value="layer.layerIndex"
          />
        </el-select>
      </el-form-item>
      <el-form-item v-if="layerStats.length > 0" label="显示内容">
        <el-checkbox v-model="showUncoveredOnly">
          只显示所选层未覆盖格网（其他格网隐藏）
        </el-checkbox>
      </el-form-item>

      <!-- 统计信息 -->
      <el-divider />
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
import { ref, computed, watchEffect } from 'vue'
import { Download } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useAnalysisStore } from '../stores/analysis'
import { useMapStore } from '../stores/map'

const analysisStore = useAnalysisStore()
const mapStore = useMapStore()
const visualizationMode = ref('pointcloud')
const colorScheme = ref('green_red')
const pointSize = ref(3)
const filterByHeight = ref(false)
const heightRange = ref([0, 500])
const heatmapType = ref('visibility_ratio')
const opacity = ref(80)
const showResultLayer = ref(true)
const showStationLayer = ref(true)
const showDSMLayer = ref(true)
const layerOpacity = ref(100)
const showUncoveredOnly = ref(false)
const selectedLayerIndex = ref(null)

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
    mapStore.setResultPoints([])
  }
  ElMessage.info('结果已清除')
}

const applyVisualization = () => {
  if (!analysisStore.analysisResult || !mapStore.viewer) return
  let points = analysisStore.analysisResult

  // 如果勾选了“只显示该层未覆盖格网”，则在当前选择的层中，仅保留不可视点
  if (showUncoveredOnly.value && selectedLayerIndex.value !== null) {
    const targetLayer = selectedLayerIndex.value
    points = points.filter((pt) => pt.layerIndex === targetLayer && pt.visible === false)
  }

  mapStore.setResultPoints(points, {
    colorScheme: colorScheme.value,
    pointSize: pointSize.value,
    filterHeightRange: filterByHeight.value ? heightRange.value : null
  })
  mapStore.setResultLayerVisibility(showResultLayer.value)
  mapStore.setStationLayerVisibility(showStationLayer.value)
  mapStore.setGridLayerVisibility(showDSMLayer.value)
}

watchEffect(applyVisualization)
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

.result-visualizer :deep(.el-radio-group) {
  display: flex;
  flex-direction: row;
  gap: 16px;
  justify-content: flex-start;
}

.layer-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
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

