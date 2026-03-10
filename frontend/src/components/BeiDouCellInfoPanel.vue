<template>
  <transition name="el-fade-in-linear">
    <div v-if="cellInfo" class="beidou-cell-panel">
      <el-card class="beidou-card" shadow="always">
        <div class="panel-header">
          <span>格网单元属性</span>
          <el-button text size="small" @click="close">关闭</el-button>
        </div>
        <div class="panel-body">
          <div class="row">
            <span class="label">索引</span>
            <span class="value">({{ cellInfo.ix }}, {{ cellInfo.iy }}, {{ cellInfo.iz }})</span>
          </div>
          <div class="row">
            <span class="label">中心经度</span>
            <span class="value">{{ cellInfo.lon.toFixed(6) }}°</span>
          </div>
          <div class="row">
            <span class="label">中心纬度</span>
            <span class="value">{{ cellInfo.lat.toFixed(6) }}°</span>
          </div>
          <div class="row">
            <span class="label">中心高度</span>
            <span class="value">{{ cellInfo.height.toFixed(2) }} m</span>
          </div>
          <div class="row">
            <span class="label">立方体尺寸</span>
            <span class="value">
              {{ cellInfo.dx }} × {{ cellInfo.dy }} × {{ cellInfo.dz }} m
            </span>
          </div>
        </div>
      </el-card>
    </div>
  </transition>
</template>

<script setup>
import { computed } from 'vue'
import { useMapStore } from '../stores/map'

const mapStore = useMapStore()
const cellInfo = computed(() => mapStore.selectedBeiDouCellInfo)

const close = () => {
  mapStore.selectBeiDouCell(null)
}
</script>

<style scoped>
.beidou-cell-panel {
  position: absolute;
  top: 80px;
  right: 16px;
  z-index: 500;
  max-width: 280px;
}

.beidou-card {
  font-size: 12px;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-weight: 600;
}

.panel-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.row {
  display: flex;
  justify-content: space-between;
}

.label {
  color: #888;
}

.value {
  color: #333;
}
</style>

