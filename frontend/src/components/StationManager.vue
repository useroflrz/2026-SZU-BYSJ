<template>
  <div class="station-manager">
    <el-form :model="form" label-width="100px" size="small">
      <el-form-item label="添加方式">
        <el-radio-group v-model="addMode" @change="handleModeChange">
          <el-radio label="auto">自动选点</el-radio>
          <el-radio label="import">批量导入</el-radio>
        </el-radio-group>
      </el-form-item>

      <!-- 自动选点 -->
      <template v-if="addMode === 'auto'">
        <el-form-item label="候选点间距(米)">
          <el-input-number
            v-model="autoForm.candidateSpacing"
            :min="50"
            :step="50"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="覆盖采样间距(米)">
          <el-input-number
            v-model="autoForm.demandSpacing"
            :min="50"
            :step="50"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="覆盖半径(米)">
          <el-input-number
            v-model="autoForm.coverRadius"
            :min="100"
            :step="100"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="最大站点数">
          <el-input-number
            v-model="autoForm.maxStations"
            :min="1"
            :step="1"
            style="width: 100%"
          />
        </el-form-item>
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

const autoForm = ref({
  candidateSpacing: 200,
  demandSpacing: 200,
  coverRadius: 2000,
  maxStations: 10,
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

const generateGridPointsInBounds = (bounds, spacingM) => {
  const { metersPerDegLat, metersPerDegLon } = degToMetersFactors(bounds.minLat, bounds.maxLat)
  const lonStep = spacingM / Math.max(1e-9, metersPerDegLon)
  const latStep = spacingM / metersPerDegLat
  const pts = []
  for (let lon = bounds.minLon; lon <= bounds.maxLon; lon += lonStep) {
    for (let lat = bounds.minLat; lat <= bounds.maxLat; lat += latStep) {
      pts.push({ lon, lat })
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

const distanceMetersApprox = (a, b, metersPerDegLon, metersPerDegLat) => {
  const dx = (a.lon - b.lon) * metersPerDegLon
  const dy = (a.lat - b.lat) * metersPerDegLat
  return Math.sqrt(dx * dx + dy * dy)
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

  const {
    candidateSpacing,
    demandSpacing,
    coverRadius,
    maxStations,
    frequency,
    type
  } = autoForm.value

  if (candidateSpacing <= 0 || demandSpacing <= 0 || coverRadius <= 0 || maxStations <= 0) {
    ElMessage.warning('自动选点参数不合法')
    return
  }

  isAutoPicking.value = true
  autoSummary.value = ''
  try {
    const { metersPerDegLat, metersPerDegLon } = degToMetersFactors(bounds.minLat, bounds.maxLat)

    // 需求点：用于“覆盖完全”的近似判定（规则采样点）
    const demand = generateGridPointsInBounds(bounds, demandSpacing)
    if (demand.length === 0) {
      ElMessage.warning('区域过小或采样间距过大，无法生成覆盖采样点')
      return
    }

    // 候选点：用于选站点（也用规则采样）
    const candidatesLonLat = generateGridPointsInBounds(bounds, candidateSpacing)
    if (candidatesLonLat.length === 0) {
      ElMessage.warning('区域过小或候选点间距过大，无法生成候选点')
      return
    }

    ElMessage.info(`候选点 ${candidatesLonLat.length}，覆盖采样点 ${demand.length}，正在采样高程...`)
    const candidatesWithHeight = await sampleHeights(mapStore.viewer, candidatesLonLat)

    // 预计算每个候选点覆盖的需求点索引（近似平面距离）
    const coverSets = candidatesWithHeight.map((c) => {
      const covered = []
      for (let di = 0; di < demand.length; di++) {
        const d = demand[di]
        const dist = distanceMetersApprox(c, d, metersPerDegLon, metersPerDegLat)
        if (dist <= coverRadius) covered.push(di)
      }
      return covered
    })

    const uncovered = new Array(demand.length).fill(true)
    let uncoveredCount = demand.length

    const selected = []
    const used = new Array(candidatesWithHeight.length).fill(false)

    const countNewCoverage = (coverIdxs) => {
      let cnt = 0
      for (let i = 0; i < coverIdxs.length; i++) {
        if (uncovered[coverIdxs[i]]) cnt++
      }
      return cnt
    }

    for (let k = 0; k < maxStations; k++) {
      let bestIdx = -1
      let bestGain = 0
      let bestHeight = -Infinity

      for (let ci = 0; ci < candidatesWithHeight.length; ci++) {
        if (used[ci]) continue
        const gain = countNewCoverage(coverSets[ci])
        if (gain > bestGain) {
          bestGain = gain
          bestIdx = ci
          bestHeight = candidatesWithHeight[ci].groundHeight
        } else if (gain === bestGain && gain > 0) {
          // 覆盖增益相同，优先选更高的点
          const h = candidatesWithHeight[ci].groundHeight
          if (h > bestHeight) {
            bestIdx = ci
            bestHeight = h
          }
        }
      }

      if (bestIdx === -1 || bestGain === 0) break

      used[bestIdx] = true
      const chosen = candidatesWithHeight[bestIdx]
      const coverIdxs = coverSets[bestIdx]
      for (let i = 0; i < coverIdxs.length; i++) {
        const di = coverIdxs[i]
        if (uncovered[di]) {
          uncovered[di] = false
          uncoveredCount--
        }
      }

      selected.push({
        id: `auto-${Date.now()}-${k}`,
        name: `站点${k + 1}`,
        position: {
          lon: chosen.lon,
          lat: chosen.lat,
          height: 30 // 相对地面高度：给一个固定天线高度（简单起见）
        },
        frequency,
        type,
        meta: {
          groundHeight: chosen.groundHeight,
          coverGain: bestGain
        }
      })

      if (uncoveredCount === 0) break
    }

    analysisStore.setStations(selected)
    mapStore.setStations(selected)

    const covered = demand.length - uncoveredCount
    const coverageRatio = demand.length === 0 ? 0 : covered / demand.length
    autoSummary.value = `已生成 ${selected.length} 个站点，覆盖采样点 ${covered.toLocaleString()} / ${demand.length.toLocaleString()}（${(coverageRatio * 100).toFixed(2)}%）`
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
