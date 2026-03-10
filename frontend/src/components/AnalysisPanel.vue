<template>
  <div class="analysis-panel">
    <el-form :model="form" label-width="120px" size="small">
      <el-form-item label="分析模式">
        <el-radio-group v-model="analysisMode">
          <el-radio label="quick">快速模式</el-radio>
          <el-radio label="advanced">高级模式</el-radio>
        </el-radio-group>
      </el-form-item>

      <el-divider />

      <!-- 基础参数 -->
      <el-form-item label="发射端高度字段">
        <el-select v-model="form.txHeightField" style="width: 100%" placeholder="请选择">
          <el-option label="站点高度" value="station_height" />
          <el-option label="绝对海拔" value="absolute" />
          <el-option label="相对地面" value="relative" />
        </el-select>
      </el-form-item>

      <el-form-item label="接收端高度字段">
        <el-select v-model="form.rxHeightField" style="width: 100%" placeholder="请选择">
          <el-option label="格网点高度" value="grid_height" />
          <el-option label="绝对海拔" value="absolute" />
          <el-option label="相对地面" value="relative" />
        </el-select>
      </el-form-item>

      <el-form-item label="频段(GHz)">
        <el-input-number
          v-model="form.frequency"
          :min="0.1"
          :step="0.1"
          :precision="2"
          style="width: 100%"
          placeholder="请输入频段"
        />
      </el-form-item>

      <!-- 高级参数 -->
      <template v-if="analysisMode === 'advanced'">
        <el-divider />
        <el-form-item label="考虑地球曲率">
          <el-switch v-model="form.considerCurvature" />
        </el-form-item>
        <el-form-item label="路径损耗阈值(dB)">
          <el-input-number
            v-model="form.pathLossThreshold"
            :min="0"
            :step="1"
            style="width: 100%"
            placeholder="请输入路径损耗阈值"
          />
        </el-form-item>
        <el-form-item label="批处理大小">
          <el-input-number
            v-model="form.batchSize"
            :min="100"
            :step="100"
            style="width: 100%"
            placeholder="请输入批处理大小"
          />
        </el-form-item>
        <el-form-item label="最大分析距离(米)">
          <el-input-number
            v-model="form.maxDistance"
            :min="100"
            :step="100"
            style="width: 100%"
            placeholder="请输入最大分析距离"
          />
        </el-form-item>
      </template>

      <el-divider />

      <el-form-item>
        <el-button
          type="primary"
          @click="runAnalysis"
          :loading="isAnalyzing"
          :disabled="!canAnalyze"
          style="width: 100%"
        >
          <el-icon><VideoPlay /></el-icon>
          开始分析
        </el-button>
        <el-button @click="resetForm" style="width: 100%; margin-top: 8px;">
          重置参数
        </el-button>
      </el-form-item>

      <!-- 分析进度 -->
      <el-form-item v-if="isAnalyzing" label="分析进度">
        <el-progress
          :percentage="analysisProgress"
          :status="isAnalyzing ? 'active' : 'success'"
        />
        <div class="progress-text">{{ progressText }}</div>
      </el-form-item>
    </el-form>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { VideoPlay } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useAnalysisStore } from '../stores/analysis'
import { useMapStore } from '../stores/map'

const analysisStore = useAnalysisStore()
const mapStore = useMapStore()
const analysisMode = ref('quick')
const isAnalyzing = ref(false)
const analysisProgress = ref(0)
const progressText = ref('')

const form = reactive({
  txHeightField: 'station_height',
  rxHeightField: 'grid_height',
  frequency: 2.4,
  considerCurvature: false,
  pathLossThreshold: 120,
  batchSize: 1000,
  maxDistance: 10000
})

const canAnalyze = computed(() => {
  return analysisStore.stations.length > 0 && analysisStore.gridPoints.length > 0
})

const runAnalysis = async () => {
  if (!canAnalyze.value) {
    ElMessage.warning('请先配置站点和格网')
    return
  }

  isAnalyzing.value = true
  analysisProgress.value = 0
  progressText.value = '初始化分析...'
  analysisStore.setIsAnalyzing(true)
  analysisStore.setAnalysisProgress(0)

  const results = await analysisStore.runAnalysis({
    ...form,
    mode: analysisMode.value
  })

  analysisProgress.value = 100
  progressText.value = '分析完成'
  analysisStore.setAnalysisProgress(100)
  analysisStore.setIsAnalyzing(false)
  isAnalyzing.value = false

  if (mapStore.viewer) {
    mapStore.setResultPoints(results, {
      colorScheme: 'green_red',
      pointSize: 4
    })
  }
  ElMessage.success('分析完成，结果已渲染')
}

const resetForm = () => {
  form.txHeightField = 'station_height'
  form.rxHeightField = 'grid_height'
  form.frequency = 2.4
  form.considerCurvature = false
  form.pathLossThreshold = 120
  form.batchSize = 1000
  form.maxDistance = 10000
  analysisMode.value = 'quick'
  ElMessage.info('参数已重置')
}
</script>

<style scoped>
.analysis-panel {
  padding: 8px 0;
  text-align: center;
}

.analysis-panel :deep(.el-form-item) {
  text-align: left;
  margin-bottom: 20px;
}

.analysis-panel :deep(.el-form-item__label) {
  text-align: left;
}

.analysis-panel :deep(.el-radio-group) {
  display: flex;
  flex-direction: row;
  gap: 16px;
  justify-content: flex-start;
}

.progress-text {
  margin-top: 8px;
  font-size: 12px;
  color: #666;
  text-align: center;
}
</style>
