<template>
  <div class="station-manager">
    <el-form :model="form" label-width="100px" size="small">
      <el-form-item label="添加方式">
        <el-radio-group v-model="addMode" @change="handleModeChange">
          <el-radio label="auto">自动选点</el-radio>
          <el-radio label="import">批量导入</el-radio>
        </el-radio-group>
      </el-form-item>

      <!-- 自动选点：区域内均匀 10 点 + 在线地形高程 -->
      <template v-if="addMode === 'auto'">
        <el-form-item label="频段(GHz)">
          <el-input-number
            v-model="autoForm.frequency"
            :min="0.1"
            :step="0.1"
            :precision="2"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="站点类型">
          <el-select v-model="autoForm.type" style="width: 100%">
            <el-option label="基站" value="base" />
            <el-option label="中继站" value="relay" />
            <el-option label="终端" value="terminal" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button
            type="primary"
            @click="autoSelectStations"
            style="width: 100%"
            :loading="isAutoPicking"
            :disabled="!canAutoPick"
          >
            自动生成站点
          </el-button>
          <el-button
            @click="clearStations"
            style="width: 100%; margin-top: 8px;"
          >
            清空站点
          </el-button>
        </el-form-item>
        <el-form-item v-if="autoSummary" label="生成摘要">
          <div class="auto-summary">
            <div>{{ autoSummary }}</div>
          </div>
        </el-form-item>
      </template>

      <!-- 批量导入 -->
      <template v-if="addMode === 'import'">
        <el-form-item label="文件格式">
          <el-radio-group v-model="importFormat">
            <el-radio label="csv">CSV</el-radio>
            <el-radio label="geojson">GeoJSON</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item>
          <el-upload
            :auto-upload="false"
            :on-change="handleFileImport"
            :show-file-list="false"
            accept=".csv,.geojson,.json"
          >
            <el-button type="primary" style="width: 100%">
              <el-icon><Upload /></el-icon>
              选择文件
            </el-button>
          </el-upload>
        </el-form-item>
      </template>

      <el-divider />

      <!-- 站点列表 -->
      <el-form-item label="站点列表">
        <div class="station-list">
          <el-table :data="stations" size="small" max-height="300" style="width: 100%">
            <el-table-column prop="name" label="名称" width="80" />
            <el-table-column prop="frequency" label="频段(GHz)" width="80" />
            <el-table-column label="操作" width="100">
              <template #default="scope">
                <el-button
                  link
                  type="primary"
                  size="small"
                  @click="editStation(scope.row)"
                >
                  编辑
                </el-button>
                <el-button
                  link
                  type="danger"
                  size="small"
                  @click="removeStation(scope.row.id)"
                >
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-form-item>

      <!-- 站点编辑表单 -->
      <el-divider v-if="editingStation" />
      <template v-if="editingStation">
        <el-form-item label="站点名称">
          <el-input v-model="editingStation.name" style="width: 100%" />
        </el-form-item>
        <el-form-item label="经度">
          <el-input-number 
            v-model="editingStation.position.lon" 
            :precision="6" 
            :step="0.0001"
            :min="-180"
            :max="180"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="纬度">
          <el-input-number 
            v-model="editingStation.position.lat" 
            :precision="6" 
            :step="0.0001"
            :min="-90"
            :max="90"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="相对地面高度(米)">
          <el-input-number 
            v-model="editingStation.position.height" 
            :min="0" 
            :step="1"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="频段(GHz)">
          <el-input-number 
            v-model="editingStation.frequency" 
            :min="0" 
            :step="0.1"
            :precision="2"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="站点类型">
          <el-select v-model="editingStation.type" style="width: 100%">
            <el-option label="基站" value="base" />
            <el-option label="中继站" value="relay" />
            <el-option label="终端" value="terminal" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="saveStation" style="width: 100%">保存</el-button>
          <el-button @click="cancelEdit" style="width: 100%; margin-top: 8px;">取消</el-button>
        </el-form-item>
      </template>
    </el-form>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, toRaw } from 'vue'
import { Upload } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import * as Cesium from 'cesium'
import { useAnalysisStore } from '../stores/analysis'
import { useMapStore } from '../stores/map'

const analysisStore = useAnalysisStore()
const mapStore = useMapStore()
const addMode = ref('auto')
const importFormat = ref('csv')

const form = ref({})

const stations = computed(() => analysisStore.stations)

const editingStation = ref(null)

const isAutoPicking = ref(false)
const autoSummary = ref('')

const AUTO_STATION_COUNT = 10
/** 天线相对地面高度（米），与 map.setStations 的 RELATIVE_TO_GROUND 一致 */
const DEFAULT_STATION_AGL_M = 30

const autoForm = ref({
  frequency: 2.4,
  type: 'base'
})

const canAutoPick = computed(() => {
  return !!mapStore.selectedRegion && !!mapStore.viewer
})

const handleModeChange = () => {
  autoSummary.value = ''
}

const getRegionBoundsLonLat = () => {
  const region = mapStore.selectedRegion
  const b = region?.bounds
  if (!b) return null
  // RegionSelector 存的是 minX/minY/maxX/maxY（经纬度）
  return {
    minLon: b.minX,
    minLat: b.minY,
    maxLon: b.maxX,
    maxLat: b.maxY
  }
}

const degToMetersFactors = (minLat, maxLat) => {
  const centerLatDeg = (minLat + maxLat) * 0.5
  const centerLatRad = (centerLatDeg * Math.PI) / 180.0
  const metersPerDegLat = 111000.0
  const metersPerDegLon = 111000.0 * Math.cos(centerLatRad)
  return { metersPerDegLat, metersPerDegLon }
}

/**
 * 在经纬度矩形内生成均匀网格中心点（固定 count 个，默认 10）。
 * 横长区域用 5×2（沿经度 5 格），竖长区域用 2×5。
 */
const generateUniformPointsInBounds = (bounds, count = AUTO_STATION_COUNT) => {
  const { minLon, minLat, maxLon, maxLat } = bounds
  const dLon = maxLon - minLon
  const dLat = maxLat - minLat
  const { metersPerDegLat, metersPerDegLon } = degToMetersFactors(bounds.minLat, bounds.maxLat)
  const widthM = Math.max(0, dLon * metersPerDegLon)
  const heightM = Math.max(0, dLat * metersPerDegLat)

  let rows = 2
  let cols = 5
  if (count === 10) {
    if (widthM < heightM) {
      rows = 5
      cols = 2
    }
  } else {
    let best = { rows: 1, cols: count, score: Infinity }
    for (let c = 1; c <= count; c++) {
      if (count % c !== 0) continue
      const r = count / c
      const cellAspect = (widthM / c) / Math.max(heightM / r, 1e-9)
      const regionAspect = widthM / Math.max(heightM, 1e-9)
      const score = Math.abs(Math.log(cellAspect + 1e-12) - Math.log(regionAspect + 1e-12))
      if (score < best.score) best = { rows: r, cols: c, score }
    }
    rows = best.rows
    cols = best.cols
  }

  const pts = []
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      pts.push({
        lon: minLon + (ix + 0.5) * dLon / cols,
        lat: minLat + (iy + 0.5) * dLat / rows
      })
    }
  }
  return pts
}

const sampleHeights = async (viewer, lonLatPoints) => {
  if (!viewer || lonLatPoints.length === 0) return []
  const rawViewer = toRaw(viewer)
  const terrain = rawViewer?.terrainProvider
  const out = []
  const BATCH = 200
  // 地形 provider 可能未就绪或 token/网络导致内部可用性信息缺失，这里做容错：
  // - 尝试等待 readyPromise
  // - sampleTerrainMostDetailed 失败则回退为 0 高程
  try {
    if (terrain && terrain.readyPromise) {
      await terrain.readyPromise
    }
  } catch (e) {
    // ignore
  }
  for (let i = 0; i < lonLatPoints.length; i += BATCH) {
    const batch = lonLatPoints.slice(i, i + BATCH)
    const cartos = batch.map(p => Cesium.Cartographic.fromDegrees(p.lon, p.lat))
    try {
      // eslint-disable-next-line no-await-in-loop
      const sampled = await Cesium.sampleTerrainMostDetailed(terrain, cartos)
      sampled.forEach((c, idx) => {
        out.push({
          lon: batch[idx].lon,
          lat: batch[idx].lat,
          groundHeight: Number.isFinite(c.height) ? c.height : 0
        })
      })
    } catch (e) {
      // 回退：不阻断自动选点流程
      batch.forEach((p) => {
        out.push({
          lon: p.lon,
          lat: p.lat,
          groundHeight: 0
        })
      })
    }
  }
  return out
}

const autoSelectStations = async () => {
  if (!canAutoPick.value) {
    ElMessage.warning('请先在“区域选择”中确认区域，并确保地图已加载')
    return
  }
  const bounds = getRegionBoundsLonLat()
  if (!bounds || !Number.isFinite(bounds.minLon)) {
    ElMessage.warning('未获取到有效区域范围')
    return
  }

  const { frequency, type } = autoForm.value

  isAutoPicking.value = true
  autoSummary.value = ''
  try {
    const uniformLonLat = generateUniformPointsInBounds(bounds, AUTO_STATION_COUNT)
    if (uniformLonLat.length === 0) {
      ElMessage.warning('无法生成均匀分布点')
      return
    }

    ElMessage.info(`在区域内均匀生成 ${uniformLonLat.length} 个点，正在采样在线地形高程...`)
    const withHeight = await sampleHeights(mapStore.viewer, uniformLonLat)

    const agl = DEFAULT_STATION_AGL_M
    const selected = withHeight.map((pt, k) => {
      const gh = pt.groundHeight
      return {
        id: `auto-${Date.now()}-${k}`,
        name: `站点${k + 1}`,
        position: {
          lon: pt.lon,
          lat: pt.lat,
          height: agl
        },
        frequency,
        type,
        meta: {
          groundHeight: gh,
          absoluteHeight: gh + agl
        }
      }
    })

    analysisStore.setStations(selected)
    mapStore.setStations(selected)

    const ghMin = Math.min(...selected.map((s) => s.meta.groundHeight))
    const ghMax = Math.max(...selected.map((s) => s.meta.groundHeight))
    autoSummary.value =
      `已生成 ${selected.length} 个均匀分布站点；在线地形椭球高程约 ${ghMin.toFixed(1)}～${ghMax.toFixed(1)} m（天线离地 ${agl} m，绝对海拔见各站点 meta.absoluteHeight）`
    ElMessage.success('自动选点完成，站点已渲染到地图')
  } catch (e) {
    ElMessage.error(`自动选点失败：${e?.message || '未知错误'}`)
  } finally {
    isAutoPicking.value = false
  }
}

const clearStations = () => {
  analysisStore.setStations([])
  mapStore.setStations([])
  editingStation.value = null
  autoSummary.value = ''
  ElMessage.info('站点已清空')
}

const handleFileImport = (file) => {
  ElMessage.info('文件选择: ' + file.name)
  const reader = new FileReader()
  reader.onload = (e) => {
    try {
      const content = e.target.result
      if (importFormat.value === 'csv') {
        const lines = content.split(/\r?\n/).filter(Boolean)
        const parsed = []
        lines.slice(1).forEach(line => {
          const [name, lon, lat, height, frequency, type] = line.split(',')
          if (name && lon && lat) {
            parsed.push({
              id: `${Date.now()}-${parsed.length}`,
              name: name.trim(),
              position: {
                lon: Number(lon),
                lat: Number(lat),
                height: Number(height) || 0
              },
              frequency: Number(frequency) || 1.4,
              type: (type || 'base').trim()
            })
          }
        })
        parsed.forEach(st => analysisStore.addStation(st))
        mapStore.setStations(analysisStore.stations)
        ElMessage.success(`已导入 ${parsed.length} 个站点`)
      } else if (importFormat.value === 'geojson') {
        const geo = JSON.parse(content)
        const features = geo.features || []
        const parsed = features
          .filter(f => f.geometry?.type === 'Point')
          .map((f, idx) => {
            // 兼容两类数据：
            // 1) geometry.coordinates 为 [lon, lat, height?]（WGS84）
            // 2) geometry 为投影坐标（如 EPSG:4547），但 properties 里包含 lon/lat（示例数据就是这种）
            const propLon = f.properties?.lon
            const propLat = f.properties?.lat
            const lon = propLon !== undefined && propLon !== null ? Number(propLon) : Number(f.geometry.coordinates?.[0])
            const lat = propLat !== undefined && propLat !== null ? Number(propLat) : Number(f.geometry.coordinates?.[1])
            const height =
              f.properties?.height !== undefined ? Number(f.properties.height)
              : f.properties?.altitude !== undefined ? Number(f.properties.altitude)
              : f.properties?.Z !== undefined ? Number(f.properties.Z)
              : (f.geometry.coordinates?.[2] !== undefined ? Number(f.geometry.coordinates[2]) : 0)
            return {
              id: `${Date.now()}-${idx}`,
              name: f.properties?.name || `站点${idx + 1}`,
              position: { lon, lat, height },
              frequency: Number(f.properties?.frequency) || 1.4,
              type: f.properties?.type || 'base'
            }
          })
        parsed.forEach(st => analysisStore.addStation(st))
        mapStore.setStations(analysisStore.stations)
        ElMessage.success(`已导入 ${parsed.length} 个站点`)
      }
    } catch (err) {
      ElMessage.error('导入失败，请检查文件格式')
    }
  }
  reader.readAsText(file.raw)
}

const editStation = (station) => {
  editingStation.value = { 
    ...station,
    position: { ...station.position }
  }
}

const saveStation = () => {
  analysisStore.updateStation(editingStation.value.id, editingStation.value)
  mapStore.setStations(analysisStore.stations)
  editingStation.value = null
  ElMessage.success('站点已保存')
}

const cancelEdit = () => {
  editingStation.value = null
}

const removeStation = (id) => {
  analysisStore.removeStation(id)
  mapStore.setStations(analysisStore.stations)
  ElMessage.success('站点已删除')
}

onMounted(() => {
  if (mapStore.viewer) {
    mapStore.setStations(analysisStore.stations)
  }
})
</script>

<style scoped>
.station-manager {
  padding: 8px 0;
  text-align: center;
}

.station-manager :deep(.el-form-item) {
  text-align: left;
  margin-bottom: 20px;
}

.station-manager :deep(.el-form-item__label) {
  text-align: left;
}

.station-manager :deep(.el-radio-group) {
  display: flex;
  flex-direction: row;
  gap: 16px;
  justify-content: flex-start;
}

.station-list {
  margin-top: 8px;
}

.auto-summary {
  font-size: 12px;
  color: #666;
  line-height: 1.6;
}
</style>
