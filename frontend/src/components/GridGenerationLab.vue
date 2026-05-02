<template>
  <div class="grid-generation-lab">
    <el-form :model="form" label-width="120px" size="small">
      <el-alert
        title="点击“开始实验”后会同时渲染两套格网：原逻辑（蓝色）与本地DEM tif结果（红色）用于对比。"
        type="info"
        :closable="false"
        class="lab-note"
      />

      <el-form-item label="GeoTIFF 文件">
        <div class="dem-upload">
          <input
            ref="demFileInputRef"
            type="file"
            accept=".tif,.tiff"
            @change="handleDemFileChange"
            :disabled="isGenerating"
          />
          <el-button
            size="small"
            :disabled="isGenerating"
            @click="triggerDemFileSelect"
          >
            选择GeoTIFF
          </el-button>
          <div class="dem-file-tip">{{ localDemFileName || '未加载文件' }}</div>
        </div>
      </el-form-item>

      <el-form-item label="格网尺寸">
        <div class="grid-size-inputs">
          <el-form-item label="DX(米)" label-width="60px">
            <el-input-number v-model="form.dx" :min="0.1" :step="1" :precision="2" style="width: 100%" />
          </el-form-item>
          <el-form-item label="DY(米)" label-width="60px">
            <el-input-number v-model="form.dy" :min="0.1" :step="1" :precision="2" style="width: 100%" />
          </el-form-item>
          <el-form-item label="DZ(米)" label-width="60px">
            <el-input-number v-model="form.dz" :min="0.1" :step="1" :precision="2" style="width: 100%" />
          </el-form-item>
        </div>
      </el-form-item>

      <el-form-item label="离地高度范围">
        <div class="height-range-inputs">
          <el-form-item label="Z_MIN(米)" label-width="80px">
            <el-input-number v-model="form.zMin" :step="1" :precision="2" style="width: 100%" />
          </el-form-item>
          <el-form-item label="Z_MAX(米)" label-width="80px">
            <el-input-number v-model="form.zMax" :min="form.zMin + 0.1" :step="1" :precision="2" style="width: 100%" />
          </el-form-item>
        </div>
      </el-form-item>

      <el-form-item>
        <el-checkbox v-model="form.autoUseDSMBounds">自动使用已选区域边界</el-checkbox>
      </el-form-item>

      <el-form-item label="边界范围" v-if="!form.autoUseDSMBounds">
        <div class="bounds-inputs">
          <el-form-item label="最小经度" label-width="80px">
            <el-input-number v-model="form.bounds.minLon" :precision="6" :step="0.0001" style="width: 100%" />
          </el-form-item>
          <el-form-item label="最大经度" label-width="80px">
            <el-input-number v-model="form.bounds.maxLon" :precision="6" :step="0.0001" style="width: 100%" />
          </el-form-item>
          <el-form-item label="最小纬度" label-width="80px">
            <el-input-number v-model="form.bounds.minLat" :precision="6" :step="0.0001" style="width: 100%" />
          </el-form-item>
          <el-form-item label="最大纬度" label-width="80px">
            <el-input-number v-model="form.bounds.maxLat" :precision="6" :step="0.0001" style="width: 100%" />
          </el-form-item>
        </div>
      </el-form-item>

      <el-form-item>
        <el-button type="primary" @click="runExperiment" :loading="isGenerating">
          开始实验
        </el-button>
        <el-button @click="clearGrid" :disabled="isGenerating">清除</el-button>
        <div v-if="isGenerating && progressText" class="terrain-progress">{{ progressText }}</div>
      </el-form-item>
    </el-form>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useAnalysisStore } from '../stores/analysis'
import { useMapStore } from '../stores/map'

const analysisStore = useAnalysisStore()
const mapStore = useMapStore()

const demFileInputRef = ref(null)
const localDemFileName = ref('')
const isGenerating = ref(false)
const progressText = ref('')

const form = reactive({
  dx: 500,
  dy: 500,
  dz: 100,
  zMin: 0,
  zMax: 500,
  autoUseDSMBounds: true,
  bounds: {
    minLon: 114.0,
    maxLon: 114.1,
    minLat: 22.5,
    maxLat: 22.6
  }
})

function triggerDemFileSelect() {
  demFileInputRef.value?.click?.()
}

async function handleDemFileChange(event) {
  const file = event?.target?.files?.[0]
  if (!file) return
  try {
    mapStore.setLocalDemFile(file)
    localDemFileName.value = `${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`
    ElMessage.success('GeoTIFF 已选择，将由后端处理')
  } catch (e) {
    mapStore.clearLocalDemFile()
    localDemFileName.value = ''
    ElMessage.error(`GeoTIFF 选择失败：${e?.message || '未知错误'}`)
  } finally {
    if (event?.target) event.target.value = ''
  }
}

function resolveBounds() {
  const autoBounds = form.autoUseDSMBounds && mapStore.selectedRegion
    ? {
        minLon: mapStore.selectedRegion.bounds.minX,
        maxLon: mapStore.selectedRegion.bounds.maxX,
        minLat: mapStore.selectedRegion.bounds.minY,
        maxLat: mapStore.selectedRegion.bounds.maxY
      }
    : null
  return autoBounds || form.bounds
}

async function runExperiment() {
  if (form.dx <= 0.1 || form.dy <= 0.1 || form.dz <= 0.1) {
    ElMessage.error('格网尺寸必须大于0.1米')
    return
  }
  if (form.zMin >= form.zMax) {
    ElMessage.error('Z_MIN必须小于Z_MAX')
    return
  }
  if (!mapStore.localDemFile) {
    ElMessage.error('请先选择本地 GeoTIFF 文件')
    return
  }

  const bounds = resolveBounds()
  if (!bounds || ![bounds.minLon, bounds.maxLon, bounds.minLat, bounds.maxLat].every(Number.isFinite)) {
    ElMessage.error('边界无效，请先选择区域或手动填写边界')
    return
  }

  isGenerating.value = true
  progressText.value = ''
  ElMessage.info('正在生成对比格网（蓝色=原逻辑，红色=本地DEM）...')
  try {
    const baseResult = await mapStore.showBeiDouGrid(bounds, {
      dx: form.dx,
      dy: form.dy,
      dz: form.dz,
      zMin: form.zMin,
      zMax: form.zMax,
      fillColor: '#00e0ff',
      fillOpacity: 0.05,
      outlineColor: '#00e0ff',
      outlineOpacity: 0.85,
      elevationMode: 'terrain',
      onTerrainSampleProgress: ({ current, total }) => {
        progressText.value = total > 0 ? `原逻辑采样：${current.toLocaleString()} / ${total.toLocaleString()} 柱` : ''
      }
    })
    if (!baseResult) return

    const demResult = await mapStore.showBeiDouGrid(bounds, {
      dx: form.dx,
      dy: form.dy,
      dz: form.dz,
      zMin: form.zMin,
      zMax: form.zMax,
      fillColor: '#ff4d4f',
      fillOpacity: 0.08,
      outlineColor: '#ff4d4f',
      outlineOpacity: 0.9,
      elevationMode: 'localDem',
      appendMode: true,
      saveAsResultLayer: true,
      onTerrainSampleProgress: ({ current, total }) => {
        progressText.value = total > 0 ? `本地DEM采样：${current.toLocaleString()} / ${total.toLocaleString()} 柱` : ''
      }
    })
    if (!demResult) return

    analysisStore.setGridMeta(mapStore.beiDouGridMeta)
    analysisStore.setPreferredAnalysisMode('grid-viewshed-1_4ghz')
    ElMessage.success(
      `对比渲染完成：原逻辑 ${baseResult.total.toLocaleString()} 格元，DEM ${demResult.total.toLocaleString()} 格元`
    )
  } catch (e) {
    ElMessage.error(`实验执行失败：${e?.message || '未知错误'}`)
  } finally {
    isGenerating.value = false
    progressText.value = ''
  }
}

function clearGrid() {
  mapStore.clearBeiDouGrid()
  analysisStore.setGridMeta(null)
  ElMessage.info('已清除格网')
}
</script>

<style scoped>
.grid-generation-lab {
  width: 100%;
}

.lab-note {
  margin-bottom: 12px;
}

.dem-upload {
  display: flex;
  flex-direction: column;
  width: 100%;
  gap: 6px;
}

.dem-file-tip {
  font-size: 12px;
  color: #606266;
}

.grid-size-inputs,
.height-range-inputs,
.bounds-inputs {
  width: 100%;
}

.terrain-progress {
  margin-top: 8px;
  font-size: 12px;
  color: #606266;
}
</style>
