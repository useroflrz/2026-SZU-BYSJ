<template>
  <div class="grid-performance-lab">
    <el-form :model="form" label-width="130px" size="small">
      <el-alert
        title="一键自动跑批：默认按已导入深圳市 SHP 区域执行多规模 × 2 种渲染模式（Geometry / 大规模自定义格元）。目标格元 ≥ 200w 时仅测试大规模自定义格元（避免 Geometry 在超大规模下不稳定/崩溃）。"
        type="info"
        :closable="false"
        class="lab-note"
      />

      <el-form-item label="实验边界来源">
        <el-radio-group v-model="form.autoUseDSMBounds" :disabled="isBusy">
          <el-radio :label="true">使用当前已选区域（推荐：深圳市 SHP）</el-radio>
          <el-radio :label="false">手动输入边界</el-radio>
        </el-radio-group>
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

      <el-form-item label="固定参数">
        <div class="param-grid">
          <el-form-item label="DZ(米)" label-width="70px">
            <el-input-number :model-value="100" :disabled="true" style="width: 100%" />
          </el-form-item>
          <el-form-item label="层数" label-width="70px">
            <el-input-number :model-value="GRID_Z_LEVELS" :disabled="true" style="width: 100%" />
          </el-form-item>
          <el-form-item label="预热(s)" label-width="70px">
            <el-input-number v-model="form.warmupSeconds" :min="0" :max="10" :step="1" :disabled="isBusy" style="width: 100%" />
          </el-form-item>
          <el-form-item label="采样(s)" label-width="70px">
            <el-input-number v-model="form.sampleSeconds" :min="3" :max="30" :step="1" :disabled="isBusy" style="width: 100%" />
          </el-form-item>
        </div>
      </el-form-item>

      <el-form-item>
        <div class="actions">
          <el-button type="primary" :loading="isBusy" @click="runAutoMatrix">
            一键自动测试并填表
          </el-button>
          <el-button :disabled="!isBusy" @click="pauseRun">
            中断
          </el-button>
          <el-button :disabled="isBusy" @click="clearResults">
            清空结果
          </el-button>
          <el-button :disabled="isBusy || pendingCellCount === 15" @click="copyMarkdownTable">
            复制 Markdown 表
          </el-button>
          <el-button :disabled="isBusy || pendingCellCount === 15" @click="copyCsvTable">
            复制 CSV
          </el-button>
        </div>
      </el-form-item>
    </el-form>

    <div class="run-info">
      <div><strong>状态：</strong>{{ statusText }}</div>
      <div><strong>进度：</strong>{{ progressText }}</div>
      <div><strong>当前任务：</strong>{{ currentTaskText }}</div>
      <div><strong>说明：</strong>每个单元 = 预热 {{ form.warmupSeconds }} 秒 + 采样 {{ form.sampleSeconds }} 秒，FPS 自动计算并填表。</div>
    </div>

    <el-card class="result-card" shadow="never">
      <template #header>
        <div class="result-header">
          <span>自动实验结果（系统阈值：120000）</span>
          <span class="pending-tip">待补充项：{{ pendingCellCount }}</span>
        </div>
      </template>
      <el-table :data="resultRows" size="small" border>
        <el-table-column prop="targetGridCount" label="目标格元总数" width="130" />
        <el-table-column label="实际格元总数" width="130">
          <template #default="{ row }">
            <span>{{ row.actualGridCount || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="Geometry FPS">
          <template #default="{ row }">
            <span>{{ row.geometryFps || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="大规模自定义格元 FPS">
          <template #default="{ row }">
            <span>{{ row.instancedFps || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="备注">
          <template #default="{ row }">
            <span>{{ row.note || '-' }}</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useMapStore } from '../stores/map'

const GRID_DZ = 100
const GRID_Z_LEVELS = 20
const GRID_Z_MIN = 0
const GRID_Z_MAX = GRID_Z_MIN + GRID_DZ * GRID_Z_LEVELS

const TARGET_COUNTS = [5000, 20000, 50000, 100000, 500000, 1000000, 2000000, 3000000, 5000000, 8000000]
const LARGE_ONLY_TARGET_MIN = 2000000
const MODES = [
  { key: 'geometryInstances', field: 'geometryFps', label: 'GeometryInstance' },
  { key: 'instanced', field: 'instancedFps', label: '大规模自定义格元' }
]

const mapStore = useMapStore()

const form = reactive({
  autoUseDSMBounds: true,
  warmupSeconds: 2,
  sampleSeconds: 10,
  bounds: {
    minLon: 114.0,
    maxLon: 114.7,
    minLat: 22.4,
    maxLat: 22.9
  }
})

const resultRows = reactive(
  TARGET_COUNTS.map((n) => ({
    targetGridCount: n,
    actualGridCount: '',
    geometryFps: '',
    instancedFps: '',
    note: ''
  }))
)

const runState = ref('idle') // idle/running/paused/done
const isBusy = computed(() => runState.value === 'running')
const currentRowIndex = ref(-1)
const currentModeIndex = ref(-1)
const currentTaskText = ref('-')
const stopRequested = ref(false)

const pendingCellCount = computed(() => {
  let pending = 0
  for (const row of resultRows) {
    // ≥200w 时只测大规模自定义格元，Geometry 直接跳过（不计入待补充）
    if (row.targetGridCount < LARGE_ONLY_TARGET_MIN && !row.geometryFps) pending++
    if (!row.instancedFps) pending++
  }
  return pending
})

const statusText = computed(() => {
  if (runState.value === 'running') return '运行中'
  if (runState.value === 'paused') return '已中断'
  if (runState.value === 'done') return '已完成'
  return '待开始'
})

const progressText = computed(() => {
  if (currentRowIndex.value < 0 || currentModeIndex.value < 0) {
    const total = resultRows.length * MODES.length
    return runState.value === 'done' ? `${total} / ${total}` : `0 / ${total}`
  }
  const total = resultRows.length * MODES.length
  const index = currentRowIndex.value * MODES.length + currentModeIndex.value + 1
  return `${Math.min(index, total)} / ${total}`
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const nextFrame = () =>
  new Promise((resolve) => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve())
      return
    }
    setTimeout(resolve, 16)
  })

const clearGridWithBarrier = async () => {
  mapStore.clearBeiDouGrid()
  if (mapStore.viewer?.scene?.requestRender) mapStore.viewer.scene.requestRender()
  // 给 Cesium 一帧时间处理 PrimitiveCollection 的移除，降低组间叠加概率。
  await nextFrame()
  await sleep(60)
  if (mapStore.viewer?.scene?.requestRender) mapStore.viewer.scene.requestRender()
}

const resolveBounds = () => {
  if (form.autoUseDSMBounds) {
    const b = mapStore.selectedRegion?.bounds
    if (!b) return null
    return { minLon: b.minX, maxLon: b.maxX, minLat: b.minY, maxLat: b.maxY }
  }
  const b = form.bounds
  if (![b.minLon, b.maxLon, b.minLat, b.maxLat].every(Number.isFinite)) return null
  return { minLon: b.minLon, maxLon: b.maxLon, minLat: b.minLat, maxLat: b.maxLat }
}

const clearResults = () => {
  resultRows.forEach((row) => {
    row.actualGridCount = ''
    row.geometryFps = ''
    row.instancedFps = ''
    row.note = ''
  })
  runState.value = 'idle'
  currentRowIndex.value = -1
  currentModeIndex.value = -1
  currentTaskText.value = '-'
}

const pauseRun = () => {
  if (!isBusy.value) return
  stopRequested.value = true
  runState.value = 'paused'
  currentTaskText.value = '收到中断请求，正在停止...'
}

const computeGridCounts = (bounds, dx, dy, dz, zMin, zMax) => {
  const centerLatDeg = (bounds.minLat + bounds.maxLat) * 0.5
  const centerLatRad = centerLatDeg * Math.PI / 180.0
  const metersPerDegLat = 111000.0
  const metersPerDegLon = 111000.0 * Math.cos(centerLatRad)
  const widthM = Math.max(0.0, (bounds.maxLon - bounds.minLon) * metersPerDegLon)
  const heightM = Math.max(0.0, (bounds.maxLat - bounds.minLat) * metersPerDegLat)
  const gridX = Math.max(1, Math.ceil(widthM / dx))
  const gridY = Math.max(1, Math.ceil(heightM / dy))
  const gridZ = Math.max(1, Math.ceil((zMax - zMin) / dz))
  return { gridX, gridY, gridZ, total: gridX * gridY * gridZ }
}

const solveDxDyForTargetCount = (bounds, targetCount) => {
  const dz = GRID_DZ
  const zMin = GRID_Z_MIN
  const zMax = GRID_Z_MAX
  const gridZ = Math.max(1, Math.ceil((zMax - zMin) / dz))
  const targetColumns = Math.max(1, Math.round(targetCount / gridZ))
  const centerLatDeg = (bounds.minLat + bounds.maxLat) * 0.5
  const centerLatRad = centerLatDeg * Math.PI / 180.0
  const metersPerDegLat = 111000.0
  const metersPerDegLon = 111000.0 * Math.cos(centerLatRad)
  const widthM = Math.max(1.0, (bounds.maxLon - bounds.minLon) * metersPerDegLon)
  const heightM = Math.max(1.0, (bounds.maxLat - bounds.minLat) * metersPerDegLat)
  const area = widthM * heightM

  const initial = Math.max(1, Math.sqrt(area / targetColumns))
  let best = { dx: initial, dy: initial, diff: Number.MAX_SAFE_INTEGER, total: 0 }

  for (let ratio = 0.6; ratio <= 1.8; ratio += 0.05) {
    const dx = Math.max(1, initial * ratio)
    const dy = Math.max(1, initial / ratio)
    const c = computeGridCounts(bounds, dx, dy, dz, zMin, zMax)
    const diff = Math.abs(c.total - targetCount)
    if (diff < best.diff) {
      best = { dx, dy, diff, total: c.total }
    }
  }

  const baseDx = best.dx
  const baseDy = best.dy
  for (let fx = 0.85; fx <= 1.15; fx += 0.01) {
    for (let fy = 0.85; fy <= 1.15; fy += 0.01) {
      const dx = Math.max(1, baseDx * fx)
      const dy = Math.max(1, baseDy * fy)
      const c = computeGridCounts(bounds, dx, dy, dz, zMin, zMax)
      const diff = Math.abs(c.total - targetCount)
      if (diff < best.diff) {
        best = { dx, dy, diff, total: c.total }
      }
    }
  }
  return { dx: Number(best.dx.toFixed(2)), dy: Number(best.dy.toFixed(2)), estimatedTotal: best.total }
}

const warmup = async (durationMs) => {
  if (durationMs <= 0) return
  const start = performance.now()
  while (performance.now() - start < durationMs) {
    if (stopRequested.value) return
    await sleep(16)
  }
}

const sampleAverageFps = (durationMs) =>
  new Promise((resolve) => {
    let frames = 0
    let startTime = 0
    let done = false
    const tick = (ts) => {
      if (done) return
      if (stopRequested.value) {
        done = true
        resolve({ fps: 0, frames: 0, durationMs: 0 })
        return
      }
      if (!startTime) startTime = ts
      frames++
      const elapsed = ts - startTime
      if (elapsed >= durationMs) {
        done = true
        const seconds = elapsed / 1000
        resolve({
          fps: seconds > 0 ? frames / seconds : 0,
          frames,
          durationMs: elapsed
        })
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

const fillCellValue = (row, field, value) => {
  row[field] = Number.isFinite(value) ? value.toFixed(2) : ''
}

const renderOneCaseAndSample = async ({ bounds, dx, dy, modeKey, row, field }) => {
  if (stopRequested.value) return
  await clearGridWithBarrier()

  const result = await mapStore.showBeiDouGrid(bounds, {
    dx,
    dy,
    dz: GRID_DZ,
    zMin: GRID_Z_MIN,
    zMax: GRID_Z_MAX,
    fillColor: '#00e0ff',
    fillOpacity: 0.05,
    outlineColor: '#00e0ff',
    outlineOpacity: 0.9,
    renderModeOverride: modeKey
  })
  if (!result || !mapStore.beiDouGridMeta) {
    throw new Error('渲染失败')
  }

  row.actualGridCount = result.total?.toLocaleString?.() || `${result.total || ''}`
  await warmup(form.warmupSeconds * 1000)
  const sampled = await sampleAverageFps(form.sampleSeconds * 1000)
  fillCellValue(row, field, sampled.fps)
  row.note = `预热${form.warmupSeconds}s 采样${(sampled.durationMs / 1000).toFixed(1)}s 帧${sampled.frames}`
}

const runAutoMatrix = async () => {
  const bounds = resolveBounds()
  if (!bounds) {
    ElMessage.error('未找到有效实验边界，请先导入并确认深圳市 SHP 区域')
    return
  }
  if (!mapStore.viewer) {
    ElMessage.error('地图未加载完成，请稍后再试')
    return
  }

  stopRequested.value = false
  runState.value = 'running'
  currentTaskText.value = '准备开始...'

  try {
    for (let r = 0; r < resultRows.length; r++) {
      if (stopRequested.value) break
      currentRowIndex.value = r
      const row = resultRows[r]
      const solved = solveDxDyForTargetCount(bounds, row.targetGridCount)
      row.note = `dx=${solved.dx}, dy=${solved.dy}`

      for (let m = 0; m < MODES.length; m++) {
        if (stopRequested.value) break
        currentModeIndex.value = m
        const mode = MODES[m]

        // ≥200w：仅测试大规模自定义格元（instanced）；Geometry 强制跳过，避免超大规模不稳定/崩溃。
        if (row.targetGridCount >= LARGE_ONLY_TARGET_MIN && mode.key === 'geometryInstances') {
          row.geometryFps = '-'
          row.note = `${row.note}；≥200w 跳过 Geometry`
          continue
        }

        currentTaskText.value = `规模 ${row.targetGridCount.toLocaleString()} / 模式 ${mode.label}`
        await renderOneCaseAndSample({
          bounds,
          dx: solved.dx,
          dy: solved.dy,
          modeKey: mode.key,
          row,
          field: mode.field
        })
      }
      if (!stopRequested.value) {
        currentTaskText.value = `规模 ${row.targetGridCount.toLocaleString()} 清理中...`
        await clearGridWithBarrier()
      }
    }

    if (stopRequested.value) {
      runState.value = 'paused'
      ElMessage.warning('自动跑批已中断')
    } else {
      runState.value = 'done'
      currentTaskText.value = '全部测试完成'
      ElMessage.success('自动测试完成，结果表已自动填充')
    }
  } catch (e) {
    runState.value = 'paused'
    currentTaskText.value = '运行中断'
    ElMessage.error(`自动跑批失败：${e?.message || '未知错误'}`)
  } finally {
    await clearGridWithBarrier()
  }
}

const markdownTableText = computed(() => {
  const lines = [
    '| 目标格元总数 | 实际格元总数 | Geometry FPS | 大规模自定义格元 FPS | 备注 |',
    '| --- | --- | --- | --- | --- |'
  ]
  for (const row of resultRows) {
    lines.push(
      `| ${row.targetGridCount} | ${row.actualGridCount || '-'} | ${row.geometryFps || '-'} | ${row.instancedFps || '-'} | ${row.note || '-'} |`
    )
  }
  lines.push('')
  lines.push(`说明：目标格元 ≥ ${LARGE_ONLY_TARGET_MIN.toLocaleString()} 时跳过 Geometry（仅测试大规模自定义格元）。`)
  return lines.join('\n')
})

const csvTableText = computed(() => {
  const lines = ['target_grid_count,actual_grid_count,geometry_fps,large_custom_fps,note']
  for (const row of resultRows) {
    const note = (row.note || '').replaceAll('"', '""')
    lines.push(
      `${row.targetGridCount},${row.actualGridCount || ''},${row.geometryFps || ''},${row.instancedFps || ''},"${note}"`
    )
  }
  lines.push(`note,"large_only_target_min=${LARGE_ONLY_TARGET_MIN}"`)
  return lines.join('\n')
})

const writeClipboard = async (text) => {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  throw new Error('当前环境不支持 clipboard API')
}

const copyMarkdownTable = async () => {
  try {
    await writeClipboard(markdownTableText.value)
    ElMessage.success('Markdown 表格已复制')
  } catch (e) {
    ElMessage.error(`复制失败：${e?.message || '未知错误'}`)
  }
}

const copyCsvTable = async () => {
  try {
    await writeClipboard(csvTableText.value)
    ElMessage.success('CSV 已复制')
  } catch (e) {
    ElMessage.error(`复制失败：${e?.message || '未知错误'}`)
  }
}

onBeforeUnmount(() => {
  stopRequested.value = true
})
</script>

<style scoped>
.grid-performance-lab {
  width: 100%;
}

.lab-note {
  margin-bottom: 16px;
}

.bounds-inputs,
.param-grid {
  width: 100%;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.run-info {
  margin: 10px 0;
  padding: 10px 12px;
  font-size: 12px;
  color: #606266;
  line-height: 1.8;
  background: #f5f7fa;
  border: 1px solid #e4e7ed;
  border-radius: 6px;
}

.result-card {
  margin-top: 14px;
}

.result-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}

.pending-tip {
  font-size: 12px;
  color: #909399;
}
</style>
