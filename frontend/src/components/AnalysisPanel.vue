<template>
  <div class="analysis-panel">
    <el-form :model="form" label-width="120px" size="small">
      <el-form-item label="分析模式">
        <el-tag type="success">格网可视域(1.4GHz)</el-tag>
      </el-form-item>

      <el-form-item label="最大分析距离(米)">
        <el-input-number
          v-model="form.maxDistance"
          :min="100"
          :step="100"
          :precision="0"
          style="width: 100%"
        />
      </el-form-item>

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
import { ref, reactive, computed, watch } from 'vue'
import { VideoPlay } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useAnalysisStore } from '../stores/analysis'
import { useMapStore } from '../stores/map'

const analysisStore = useAnalysisStore()
const mapStore = useMapStore()
const analysisMode = ref('grid-viewshed-1_4ghz')
const isAnalyzing = ref(false)
const analysisProgress = ref(0)
const progressText = ref('')

const form = reactive({
  maxDistance: 10000
})

const canAnalyze = computed(() => {
  return analysisStore.stations.length > 0 && !!mapStore.beiDouGridMeta
})

watch(analysisMode, (mode) => {
  analysisStore.setPreferredAnalysisMode(mode)
})

watch(
  () => analysisStore.analysisProgress,
  (p) => {
    analysisProgress.value = p || 0
    if (isAnalyzing.value) {
      progressText.value = `分析进行中... ${analysisProgress.value}%`
    }
  }
)

const runAnalysis = async () => {
  if (!canAnalyze.value) {
    ElMessage.warning('请先完成自动选点并生成北斗格网')
    return
  }

  isAnalyzing.value = true
  analysisProgress.value = 0
  progressText.value = '初始化分析...'
  analysisStore.setIsAnalyzing(true)
  analysisStore.setAnalysisProgress(0)

  const params = {
    ...form,
    mode: 'grid-viewshed-1_4ghz'
  }
  const results = await analysisStore.runGridViewshedAnalysis(params)

  analysisProgress.value = 100
  progressText.value = '分析完成'
  analysisStore.setAnalysisProgress(100)
  analysisStore.setIsAnalyzing(false)
  isAnalyzing.value = false

  if (mapStore.viewer) {
    await mapStore.renderBeiDouUncoveredGridFromCompactResult(results)
  }
  ElMessage.success('分析完成，已替换为不可视红色格网')
}

const resetForm = () => {
  form.maxDistance = 10000
  analysisMode.value = 'grid-viewshed-1_4ghz'
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
