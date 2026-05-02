<template>
  <div class="signal-strength-lab">
    <el-form label-width="110px" size="small">
      <el-form-item label="频率(GHz)">
        <el-input-number v-model="form.freqGHz" :min="0.1" :step="0.1" :precision="2" style="width: 100%" />
      </el-form-item>

      <el-form-item label="机载发射预设">
        <el-select
          v-model="presetKey"
          placeholder="典型无人机室外基站，或手动改下方数值"
          style="width: 100%"
          @change="applyPreset"
        >
          <el-option
            v-for="p in txPresets"
            :key="p.key"
            :label="p.label"
            :value="p.key"
          />
        </el-select>
        <div class="hint">
          接收电平（dBm）即接收功率，与常说的接收信号强度（如 RSSI）同属一类物理量；本页按自由空间损耗从机载 EIRP 推算。
        </div>
      </el-form-item>

      <el-form-item label="机载站 EIRP(dBm)">
        <el-input-number v-model="form.eirpDbm" :min="-30" :max="80" :step="1" :precision="1" style="width: 100%" />
      </el-form-item>

      <el-form-item label="接收天线增益(dBi)">
        <el-input-number v-model="form.rxGainDbi" :min="-10" :max="30" :step="0.5" :precision="1" style="width: 100%" />
      </el-form-item>

      <el-form-item label="其它损耗(dB)">
        <el-input-number v-model="form.miscLossDb" :min="0" :max="60" :step="0.5" :precision="1" style="width: 100%" />
        <div class="hint">室外机载链路：馈线、连接器、安装损耗等经验值，默认 0。</div>
      </el-form-item>

      <el-form-item label="近端参考(米)">
        <el-input-number v-model="form.scaleNearM" :min="20" :max="5000" :step="10" :precision="0" style="width: 100%" />
        <div class="hint">
          绿端对齐该距离；应不小于格网步长，否则只有站旁几格偏绿。着色按对数距离分配，中远距离也会有黄/绿过渡。
        </div>
      </el-form-item>

      <el-form-item label="远端参考(米)">
        <el-input-number v-model="form.radiusM" :min="100" :step="100" :precision="0" style="width: 100%" />
        <div class="hint">红端对齐该最远距离（原「衰减范围」）。须大于近端参考。</div>
      </el-form-item>

      <el-form-item label="透明度">
        <el-slider v-model="form.opacity" :min="0.02" :max="0.85" :step="0.01" />
      </el-form-item>

      <el-form-item label="颜色伽马">
        <el-slider v-model="form.signalGamma" :min="0.25" :max="3" :step="0.05" show-tooltip />
        <div class="hint">
          对「绿↔红」中间过渡做幂次调节（着色里为 t^γ）。取 <strong>1</strong> 为线性；<strong>小于 1</strong> 整体更偏绿；<strong>大于 1</strong> 更偏红、弱信号更醒目。改完点「开始/更新模拟」生效。
        </div>
      </el-form-item>

      <el-form-item label="色带档数">
        <el-input-number
          v-model="form.signalBands"
          :min="0"
          :max="16"
          :step="1"
          :precision="0"
          controls-position="right"
          style="width: 100%"
        />
        <div class="hint">0 为平滑渐变；≥2 为分档（如 5 表示 5 档）</div>
      </el-form-item>

      <el-form-item label="参与基站数">
        <el-input-number
          v-model="form.maxStations"
          :min="1"
          :max="stationCountUpperBound"
          :step="1"
          :precision="0"
          :disabled="stationCount <= 0"
          style="width: 100%"
        />
      </el-form-item>

      <el-divider />

      <el-form-item>
        <el-button
          type="primary"
          style="width: 100%"
          :disabled="!canRun"
          :loading="isRunning"
          @click="run"
        >
          开始/更新模拟
        </el-button>
        <el-button style="width: 100%; margin-top: 8px;" :disabled="!hasLayer" @click="toggleShow">
          {{ isShown ? '隐藏图层' : '显示图层' }}
        </el-button>
        <el-button style="width: 100%; margin-top: 8px;" :disabled="!hasLayer" @click="clear">
          清除图层
        </el-button>
      </el-form-item>

      <el-form-item label="状态">
        <div class="status">
          <div>基站数：{{ stationCount }}</div>
          <div>格网状态：{{ hasGrid ? '已生成(复用格网配置)' : '未生成' }}</div>
          <div v-if="statusText">{{ statusText }}</div>
        </div>
      </el-form-item>

      <el-divider />

      <div class="legend">
        <div class="legend-title">图例（接收信号强度，dBm）</div>
        <div class="legend-row">
          <span class="swatch swatch-strong" />强（近端 / 功率高）
        </div>
        <div class="legend-row">
          <span class="swatch swatch-weak" />弱（远端 / 功率低）
        </div>
        <div class="legend-fspl">
          参考区间约 <strong>{{ rxRangeText }}</strong>
          <span class="legend-note">
            （近端 {{ form.scaleNearM }}m～远端 {{ form.radiusM }}m 的自由空间接收电平；色相按对数距离拉伸）
          </span>
        </div>
      </div>
    </el-form>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useAnalysisStore } from '../stores/analysis'
import { useMapStore } from '../stores/map'

const analysisStore = useAnalysisStore()
const mapStore = useMapStore()

const isRunning = ref(false)
const statusText = ref('')

/** 无人机室外机载基站典型档位（数值可按执照与设备再改） */
const txPresets = [
  { key: 'uav_typical', label: '典型机载室外站（约 43 dBm EIRP）', eirpDbm: 43, rxGainDbi: 0, miscLossDb: 0 },
  { key: 'uav_high', label: '较高功率机载站（约 46 dBm EIRP）', eirpDbm: 46, rxGainDbi: 0, miscLossDb: 0 },
  { key: 'uav_light', label: '轻型/低功耗机载（约 36 dBm EIRP）', eirpDbm: 36, rxGainDbi: 0, miscLossDb: 0 }
]

const presetKey = ref('uav_typical')

const form = reactive({
  freqGHz: 1.4,
  radiusM: 5000,
  scaleNearM: 120,
  opacity: 0.25,
  signalGamma: 0.4,
  signalBands: 0,
  maxStations: 16,
  eirpDbm: 43,
  rxGainDbi: 0,
  miscLossDb: 0
})

function fsplDbMHz(distM, freqMHz) {
  const dKm = Math.max(distM, 0.1) / 1000
  const f = Math.max(freqMHz, 1)
  return 32.44 + 20.0 * (Math.log10(dKm) + Math.log10(f))
}

function receivedDbmAt(distM, freqMHz) {
  const loss = Number(form.miscLossDb) || 0
  const eirp = Number(form.eirpDbm)
  const g = Number(form.rxGainDbi)
  const e = Number.isFinite(eirp) ? eirp : 43
  const grx = Number.isFinite(g) ? g : 0
  return e + grx - fsplDbMHz(distM, freqMHz) - loss
}

const rxRangeText = computed(() => {
  const fMhz = form.freqGHz * 1000.0
  const a = receivedDbmAt(form.scaleNearM, fMhz)
  const b = receivedDbmAt(form.radiusM, fMhz)
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  return `${lo.toFixed(1)}～${hi.toFixed(1)} dBm`
})

function applyPreset(key) {
  const p = txPresets.find((x) => x.key === key)
  if (!p) return
  form.eirpDbm = p.eirpDbm
  form.rxGainDbi = p.rxGainDbi
  form.miscLossDb = p.miscLossDb
}

const stationCount = computed(() => (analysisStore.stations || []).length)
const stationCountUpperBound = computed(() => Math.max(1, stationCount.value))
const hasViewer = computed(() => !!mapStore.viewer)
const hasGrid = computed(() => !!mapStore.beiDouGridMeta)
const canRun = computed(() => stationCount.value > 0 && hasViewer.value && hasGrid.value)

const hasLayer = computed(() => !!mapStore.signalStrengthLayer)
const isShown = computed(() => !!mapStore.signalStrengthLayer?.show)
const usedStationCount = computed(() => Number(mapStore.signalStrengthLayer?.stationCount || 0))

watch(
  stationCount,
  (n) => {
    if (!Number.isFinite(n) || n <= 0) return
    if (form.maxStations > n) form.maxStations = n
  },
  { immediate: true }
)

function normalizeStationsForSignal(stations) {
  return (stations || [])
    .map((s) => {
      const lon = s.position?.lon ?? s.lon
      const lat = s.position?.lat ?? s.lat
      const absHeight =
        typeof s.meta?.absoluteHeight === 'number'
          ? s.meta.absoluteHeight
          : (typeof s.meta?.groundHeight === 'number' ? s.meta.groundHeight : 0) +
            (typeof s.position?.height === 'number' ? s.position.height : 0)
      return { lon, lat, height: absHeight }
    })
    .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat) && Number.isFinite(p.height))
}

async function run() {
  if (!canRun.value) {
    ElMessage.warning('请先导入/生成基站点，并确保地图已加载')
    return
  }
  if (form.opacity <= 0) {
    ElMessage.warning('透明度需大于 0')
    return
  }
  if (form.scaleNearM >= form.radiusM) {
    ElMessage.warning('近端参考须小于远端参考（米）')
    return
  }

  const freqMHz = form.freqGHz * 1000.0
  const maxStations = Math.max(
    1,
    Math.min(stationCountUpperBound.value, Math.floor(Number(form.maxStations) || stationCountUpperBound.value))
  )
  const stations = normalizeStationsForSignal(analysisStore.stations).slice(0, maxStations)
  if (stations.length === 0) {
    ElMessage.warning('基站坐标无效')
    return
  }

  isRunning.value = true
  statusText.value = '正在复用现有格网并更新信号着色...'
  try {
    await mapStore.showSignalStrengthGrid({
      stations,
      radiusM: form.radiusM,
      minDistM: form.scaleNearM,
      freqMHz,
      opacity: form.opacity,
      signalGamma: form.signalGamma,
      signalBands: form.signalBands,
      eirpDbm: form.eirpDbm,
      rxGainDbi: form.rxGainDbi,
      miscLossDb: form.miscLossDb,
      maxStations
    })
    statusText.value = `已更新（参与基站 ${usedStationCount.value || stations.length} 个）`
    ElMessage.success('信号强度模拟已更新')
  } catch (e) {
    statusText.value = ''
    ElMessage.error(`生成失败：${e?.message || '未知错误'}`)
  } finally {
    isRunning.value = false
  }
}

function toggleShow() {
  if (!hasLayer.value) return
  mapStore.setSignalStrengthVisibility(!isShown.value)
}

function clear() {
  mapStore.clearSignalStrengthGrid()
  statusText.value = ''
}
</script>

<style scoped>
.signal-strength-lab {
  padding: 8px 0;
  text-align: center;
}

.signal-strength-lab :deep(.el-form-item) {
  text-align: left;
  margin-bottom: 18px;
}

.signal-strength-lab :deep(.el-form-item__label) {
  text-align: left;
}

.status {
  font-size: 12px;
  color: #666;
  line-height: 1.6;
}

.hint {
  font-size: 11px;
  color: #909399;
  margin-top: 4px;
  line-height: 1.4;
}

.legend {
  text-align: left;
  font-size: 12px;
  color: #444;
  line-height: 1.65;
  padding: 0 4px 8px;
}

.legend-title {
  font-weight: 600;
  margin-bottom: 8px;
  color: #303133;
}

.legend-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.swatch {
  display: inline-block;
  width: 18px;
  height: 12px;
  border-radius: 2px;
  border: 1px solid rgba(0, 0, 0, 0.15);
  flex-shrink: 0;
}

.swatch-strong {
  background: linear-gradient(90deg, rgb(56, 199, 92), rgb(90, 210, 120));
}

.swatch-weak {
  background: linear-gradient(90deg, rgb(230, 120, 120), rgb(245, 89, 89));
}

.legend-fspl {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid #ebeef5;
}

.legend-note {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: #909399;
  font-weight: normal;
}
</style>

