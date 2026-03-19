<template>
  <div class="region-selector">
    <el-form :model="form" label-width="100px" size="small">
      <el-form-item label="选择方式">
        <el-radio-group v-model="selectMode" @change="handleModeChange">
          <el-radio label="city">城市/地区</el-radio>
          <el-radio label="import">导入SHP文件</el-radio>
        </el-radio-group>
      </el-form-item>
      <!-- 城市选择 -->
      <el-form-item v-if="selectMode === 'city'" label="城市">
        <el-select 
          v-model="form.city" 
          placeholder="请选择城市" 
          style="width: 100%"
          @change="handleCityChange"
        >
          <el-option label="深圳市" value="shenzhen" />
          <el-option label="广州市" value="guangzhou" />
        </el-select>
      </el-form-item>
      <!-- SHP文件导入 -->
      <template v-if="selectMode === 'import'">
        <el-form-item label="上传文件">
          <el-upload
            :auto-upload="false"
            :on-change="handleShpFileChange"
            :on-remove="handleShpFileRemove"
            :show-file-list="true"
            accept=".zip,.shp,.dbf,.shx,.prj"
            :limit="10"
            multiple
          >
            <el-button type="primary">
              <el-icon><Upload /></el-icon>
              选择SHP文件
            </el-button>
            <template #tip>
              <div class="el-upload__tip">
                推荐上传一个 zip（包含 .shp/.dbf/.shx/.prj）。也可分别选择 .shp/.dbf/.shx（.prj 可选）
              </div>
            </template>
          </el-upload>
        </el-form-item>
      </template>
      <!-- 区域信息显示 -->
      <el-divider v-if="hasRegion" />
      <template v-if="hasRegion">
        <el-form-item label="区域名称">
          <span class="region-name">{{ regionName }}</span>
        </el-form-item>
        <el-form-item label="边界范围">
          <div class="bounds-info">
            <div>经度: {{ bounds.minX?.toFixed(4) || '-' }} ~ {{ bounds.maxX?.toFixed(4) || '-' }}</div>
            <div>纬度: {{ bounds.minY?.toFixed(4) || '-' }} ~ {{ bounds.maxY?.toFixed(4) || '-' }}</div>
          </div>
        </el-form-item>
        <el-form-item label="面积">
          <span class="area-value">{{ area ? area.toFixed(2) + ' km²' : '-' }}</span>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="confirmRegion" style="width: 100%">
            确认区域
          </el-button>
          <el-button @click="clearRegion" style="width: 100%; margin-top: 8px;">
            清除
          </el-button>
        </el-form-item>
      </template>
    </el-form>
  </div>
</template>
<script setup>
import { ref, computed } from 'vue'
import { Upload } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import JSZip from 'jszip'
import { useMapStore } from '../stores/map'
import {
  parseShpZipArrayBufferToBounds,
  looksLikeLonLatBounds
} from '../utils/shpExtent'
const mapStore = useMapStore()
const selectMode = ref('city')
const form = ref({
  city: ''
})
const bounds = ref({
  minX: null,
  minY: null,
  maxX: null,
  maxY: null
})
const area = ref(null)
const regionName = ref('')
const isParsing = ref(false)
const selectedShpFiles = ref({
  zip: null,
  shp: null,
  dbf: null,
  shx: null,
  prj: null
})
// 城市边界数据（简化版，实际应该从API获取）
const cityBounds = {
  shenzhen: {
    name: '深圳市',
    minX: 113.7519,
    minY: 22.4473,
    maxX: 114.6281,
    maxY: 22.8647,
    area: 1997.47 // km²
  },
  guangzhou: {
    name: '广州市',
    minX: 112.9333,
    minY: 22.7587,
    maxX: 113.8167,
    maxY: 23.6317,
    area: 7434.4 // km²
  }
}
const hasRegion = computed(() => {
  return bounds.value.minX !== null
})
const handleModeChange = () => {
  if (selectMode.value === 'city') {
    form.value.city = ''
  }
  clearRegion()
}
const handleCityChange = (value) => {
  if (value && cityBounds[value]) {
    const city = cityBounds[value]
    bounds.value = {
      minX: city.minX,
      minY: city.minY,
      maxX: city.maxX,
      maxY: city.maxY
    }
    area.value = city.area
    regionName.value = city.name
    ElMessage.success(`已选择${city.name}`)
    // 无论 viewer 是否已初始化，都先写入 store，供格网配置联动使用
    mapStore.setRegion({
      name: regionName.value,
      bounds: bounds.value,
      area: area.value
    })
    // viewer 就绪时再绘制到地图
    if (mapStore.viewer) mapStore.drawRegion(bounds.value, regionName.value)
  }
}
const fileToArrayBuffer = (file) => {
  if (!file) return Promise.resolve(null)
  return file.arrayBuffer()
}
const estimateAreaKm2FromBounds = (b) => {
  if (!b) return null
  const centerLat = (b.minY + b.maxY) * 0.5
  const metersPerDegLat = 111000.0
  const metersPerDegLon = 111000.0 * Math.cos((centerLat * Math.PI) / 180.0)
  const widthM = Math.max(0, (b.maxX - b.minX) * metersPerDegLon)
  const heightM = Math.max(0, (b.maxY - b.minY) * metersPerDegLat)
  return (widthM * heightM) / 1e6
}
const setParsedRegion = (parsedBounds, name) => {
  bounds.value = parsedBounds
  regionName.value = name || '导入区域'
  area.value = estimateAreaKm2FromBounds(parsedBounds)
  if (!looksLikeLonLatBounds(parsedBounds)) {
    ElMessage.warning('检测到范围可能不是经纬度坐标（WGS84）。若格网位置不对，请先将 shp 投影到 WGS84 再导入。')
  }
  // 无论 viewer 是否已初始化，都先写入 store，供格网配置联动使用
  mapStore.setRegion({
    name: regionName.value,
    bounds: bounds.value,
    area: area.value
  })
  // viewer 就绪时：绘制到地图，并把镜头移动到该区域
  if (mapStore.viewer) {
    mapStore.drawRegion(bounds.value, regionName.value)
    const centerLon = (bounds.value.minX + bounds.value.maxX) / 2
    const centerLat = (bounds.value.minY + bounds.value.maxY) / 2
    const areaKm2 = area.value
    let height = 8000
    if (typeof areaKm2 === 'number' && areaKm2 > 0) {
      const approxSizeKm = Math.sqrt(areaKm2)
      height = Math.min(Math.max(approxSizeKm * 2000, 3000), 80000)
    }
    mapStore.flyToCenter(centerLon, centerLat, height)
  }
}
const parseAndApplyShp = async (nameHint = '') => {
  if (isParsing.value) return
  const { zip, shp, dbf, shx, prj } = selectedShpFiles.value
  if (!zip && !(shp && dbf && shx)) {
    ElMessage.info('请继续选择文件：需要 .shp + .dbf + .shx（或直接上传一个 zip）')
    return
  }
  isParsing.value = true
  try {
    let zipArrayBuffer = null
    if (zip) {
      zipArrayBuffer = await fileToArrayBuffer(zip)
      const baseName = zip.name?.replace(/\.zip$/i, '') || nameHint
      regionName.value = baseName || regionName.value
    } else {
      const stem = (shp.name || nameHint).replace(/\.(shp|dbf|shx|prj)$/i, '')
      const z = new JSZip()
      z.file(`${stem}.shp`, await fileToArrayBuffer(shp))
      z.file(`${stem}.dbf`, await fileToArrayBuffer(dbf))
      z.file(`${stem}.shx`, await fileToArrayBuffer(shx))
      if (prj) z.file(`${stem}.prj`, await fileToArrayBuffer(prj))
      zipArrayBuffer = await z.generateAsync({ type: 'arraybuffer' })
      regionName.value = stem
    }
    const parsedBounds = await parseShpZipArrayBufferToBounds(zipArrayBuffer)
    if (!parsedBounds) {
      ElMessage.error('未能从 shp 中解析出有效范围（bbox）')
      return
    }
    setParsedRegion(parsedBounds, regionName.value || nameHint)
    ElMessage.success('SHP范围解析成功')
  } catch (e) {
    ElMessage.error(`SHP解析失败：${e?.message || '未知错误'}`)
  } finally {
    isParsing.value = false
  }
}
const handleShpFileChange = async (uploadFile, uploadFiles) => {
  const raw = uploadFile?.raw
  if (!raw) return
  const name = raw.name || uploadFile.name || ''
  const ext = name.split('.').pop()?.toLowerCase()
  const validExts = ['zip', 'shp', 'dbf', 'shx', 'prj']
  if (!validExts.includes(ext)) {
    ElMessage.warning('请上传 .zip 或有效的SHP文件（.shp, .dbf, .shx, .prj）')
    return
  }
  selectedShpFiles.value[ext] = raw
  ElMessage.info(`文件选择: ${name}`)
  if (ext === 'zip') {
    selectedShpFiles.value.shp = null
    selectedShpFiles.value.dbf = null
    selectedShpFiles.value.shx = null
    selectedShpFiles.value.prj = null
  }
  await parseAndApplyShp(name.replace(/\.(zip|shp|dbf|shx|prj)$/i, ''))
}
const handleShpFileRemove = (uploadFile, uploadFiles) => {
  const name = uploadFile?.name || uploadFile?.raw?.name || ''
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext && selectedShpFiles.value[ext]) {
    selectedShpFiles.value[ext] = null
  }
  // 当所有文件都被移除时，清空当前导入范围（不影响“城市选择”模式）
  if (selectMode.value === 'import') {
    const { zip, shp, dbf, shx, prj } = selectedShpFiles.value
    if (!zip && !shp && !dbf && !shx && !prj) {
      clearRegion()
    }
  }
}
const confirmRegion = () => {
  if (!hasRegion.value) {
    ElMessage.warning('请先选择区域')
    return
  }
  
  // 保存到store
  mapStore.setRegion({
    name: regionName.value,
    bounds: bounds.value,
    area: area.value
  })
  // 选定前在地图上保留蓝色矩形预览，点击“确认区域”后移除预览矩形
  mapStore.removeRegionRectangleOnly()
  
  ElMessage.success('区域已确认')
}
const clearRegion = () => {
  bounds.value = {
    minX: null,
    minY: null,
    maxX: null,
    maxY: null
  }
  area.value = null
  regionName.value = ''
  form.value.city = ''
  selectedShpFiles.value = {
    zip: null,
    shp: null,
    dbf: null,
    shx: null,
    prj: null
  }
  mapStore.clearRegionLayer()
}
</script>
<style scoped>
.region-selector {
  padding: 8px 0;
  text-align: center;
}
.region-selector :deep(.el-form-item) {
  margin-bottom: 20px;
  text-align: left;
}
.region-selector :deep(.el-form-item__label) {
  text-align: left;
}
.region-selector :deep(.el-radio-group) {
  display: flex;
  flex-direction: row;
  gap: 16px;
  justify-content: flex-start;
}
.region-selector :deep(.el-radio) {
  margin-right: 0;
  margin-bottom: 0;
}
.bounds-info {
  font-size: 12px;
  color: #666;
  line-height: 1.8;
  text-align: left;
}
.region-name {
  font-weight: 600;
  color: #409eff;
  font-size: 14px;
}
.area-value {
  font-weight: 600;
  color: #67c23a;
  font-size: 14px;
}
.el-upload__tip {
  font-size: 12px;
  color: #909399;
  margin-top: 8px;
  text-align: left;
}
</style>