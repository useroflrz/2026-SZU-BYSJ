<template>
  <div class="grid-config">
    <el-form :model="form" label-width="120px" size="small">
      <el-form-item label="渲染样式">
        <div class="style-inputs">
          <div class="style-row">
            <span class="style-label">面颜色</span>
            <el-color-picker
              v-model="form.fillColor"
              @change="handleFillStyleChange"
            />
            <span class="style-label">透明度</span>
            <el-slider
              v-model="form.fillOpacity"
              :min="0"
              :max="1"
              :step="0.05"
              @change="handleFillStyleChange"
              style="flex: 1; margin: 0 8px;"
            />
          </div>
          <div class="style-row">
            <span class="style-label">边线颜色</span>
            <el-color-picker
              v-model="form.outlineColor"
              @change="handleOutlineStyleChange"
            />
            <span class="style-label">透明度</span>
            <el-slider
              v-model="form.outlineOpacity"
              :min="0"
              :max="1"
              :step="0.05"
              @change="handleOutlineStyleChange"
              style="flex: 1; margin: 0 8px;"
            />
          </div>
        </div>
      </el-form-item>

      <el-divider />

      <el-form-item label="格网尺寸">
        <div class="grid-size-inputs">
          <el-form-item label="DX(米)" label-width="60px">
            <el-input-number
              v-model="form.dx"
              :min="0.1"
              :step="1"
              :precision="2"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="DY(米)" label-width="60px">
            <el-input-number
              v-model="form.dy"
              :min="0.1"
              :step="1"
              :precision="2"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="DZ(米)" label-width="60px">
            <el-input-number
              v-model="form.dz"
              :min="0.1"
              :step="1"
              :precision="2"
              style="width: 100%"
            />
          </el-form-item>
        </div>
      </el-form-item>

      <el-divider />

      <el-form-item label="离地高度范围">
        <div class="height-range-inputs">
          <el-form-item label="Z_MIN(米)" label-width="80px">
            <el-input-number
              v-model="form.zMin"
              :step="1"
              :precision="2"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="Z_MAX(米)" label-width="80px">
            <el-input-number
              v-model="form.zMax"
              :min="form.zMin + 0.1"
              :step="1"
              :precision="2"
              style="width: 100%"
            />
          </el-form-item>
        </div>
      </el-form-item>

      <el-divider />

      <el-form-item>
        <el-checkbox v-model="form.autoUseDSMBounds">
          自动使用已选区域边界
        </el-checkbox>
      </el-form-item>

      <el-form-item label="边界范围" v-if="!form.autoUseDSMBounds">
        <div class="bounds-inputs">
          <el-form-item label="最小经度" label-width="80px">
            <el-input-number
              v-model="form.bounds.minLon"
              :precision="6"
              :step="0.0001"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="最大经度" label-width="80px">
            <el-input-number
              v-model="form.bounds.maxLon"
              :precision="6"
              :step="0.0001"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="最小纬度" label-width="80px">
            <el-input-number
              v-model="form.bounds.minLat"
              :precision="6"
              :step="0.0001"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="最大纬度" label-width="80px">
            <el-input-number
              v-model="form.bounds.maxLat"
              :precision="6"
              :step="0.0001"
              style="width: 100%"
            />
          </el-form-item>
        </div>
      </el-form-item>

      <el-divider />

      <el-form-item>
        <el-button type="primary" @click="generateGrid" :loading="isGenerating">
          <el-icon><Refresh /></el-icon>
          生成格网
        </el-button>
        <el-button @click="resetForm">重置</el-button>
      </el-form-item>

      <el-form-item v-if="gridInfo.pointCount > 0" label="格网信息">
        <div class="grid-info">
          <div>总点数: {{ gridInfo.pointCount.toLocaleString() }}</div>
          <div>层数: {{ gridInfo.layerCount }}</div>
          <div>每层点数: {{ gridInfo.pointsPerLayer.toLocaleString() }}</div>
        </div>
      </el-form-item>
    </el-form>
  </div>
</template>

<script setup>
import { ref, reactive, watch } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import * as Cesium from 'cesium'
import { useAnalysisStore } from '../stores/analysis'
import { useMapStore } from '../stores/map'

const analysisStore = useAnalysisStore()
const mapStore = useMapStore()

const form = reactive({
  dx: 100,
  dy: 100,
  dz: 50,
  zMin: 0,
  zMax: 500,
  autoUseDSMBounds: true,
  fillColor: '#00e0ff',
  fillOpacity: 0.25,
  outlineColor: '#00e0ff',
  outlineOpacity: 0.6,
  bounds: {
    minLon: 114.0,
    maxLon: 114.1,
    minLat: 22.5,
    maxLat: 22.6
  }
})

const isGenerating = ref(false)
const gridInfo = ref({
  pointCount: 0,
  layerCount: 0,
  pointsPerLayer: 0
})

const generateGrid = async () => {
  // 参数验证
  if (form.dx <= 0.1 || form.dy <= 0.1 || form.dz <= 0.1) {
    ElMessage.error('格网尺寸必须大于0.1米')
    return
  }
  if (form.zMin >= form.zMax) {
    ElMessage.error('Z_MIN必须小于Z_MAX')
    return
  }

  let bounds = null
  const autoBounds = form.autoUseDSMBounds && mapStore.selectedRegion
    ? {
        minLon: mapStore.selectedRegion.bounds.minX,
        maxLon: mapStore.selectedRegion.bounds.maxX,
        minLat: mapStore.selectedRegion.bounds.minY,
        maxLat: mapStore.selectedRegion.bounds.maxY
      }
    : null

  if (form.autoUseDSMBounds && !autoBounds) {
    ElMessage.error('已勾选“自动使用已选区域边界”，请先在“区域选择”中确认一个区域（城市或导入SHP）')
    return
  }

  if (autoBounds) {
    bounds = autoBounds
  } else {
    bounds = form.bounds
  }

  if (!bounds || bounds.minLon === undefined) {
    ElMessage.error('请先选择区域，或关闭“自动使用已选区域边界”后手动填写边界')
    return
  }

  isGenerating.value = true
  ElMessage.info('正在生成格网（将采样地形高程以贴地）...')

  try {
    // 北斗网格：使用自定义 Primitive 做 3D 网格渲染
    mapStore.setGridPoints([]) // 不再用点图层
    const primitiveInfo = await mapStore.showBeiDouGrid(bounds, {
      dx: form.dx,
      dy: form.dy,
      dz: form.dz,
      zMin: form.zMin,
      zMax: form.zMax,
      fillColor: form.fillColor,
      fillOpacity: form.fillOpacity,
      outlineColor: form.outlineColor,
      outlineOpacity: form.outlineOpacity
    })
    if (primitiveInfo == null) {
      ElMessage.warning('地图未就绪，格网未渲染。请等待 3D 地图加载完成后再点击「生成格网」。')
      return
    }

    gridInfo.value = {
      pointCount: primitiveInfo.total,
      layerCount: primitiveInfo.layerCount,
      pointsPerLayer: primitiveInfo.pointsPerLayer
    }

    ElMessage.success(
      `格网生成完成，共 ${primitiveInfo.total.toLocaleString()} 个格网单元（已贴地：terrain采样，离地高度范围：${form.zMin}~${form.zMax}m）`
    )
  } catch (e) {
    ElMessage.error(`格网生成失败：${e?.message || '未知错误'}`)
  } finally {
    isGenerating.value = false
  }
}

const resetForm = () => {
  form.dx = 100
  form.dy = 100
  form.dz = 50
  form.zMin = 0
  form.zMax = 500
  form.autoUseDSMBounds = true
  form.fillColor = '#00e0ff'
  form.fillOpacity = 0.25
  form.outlineColor = '#00e0ff'
  form.outlineOpacity = 0.6
  gridInfo.value = {
    pointCount: 0,
    layerCount: 0,
    pointsPerLayer: 0
  }
  analysisStore.setGridPoints([])
  mapStore.setGridPoints([])
  mapStore.clearBeiDouGrid()
  ElMessage.info('表单已重置')
}

const safeUpdateBeiDouFillStyle = () => {
  if (!mapStore.beiDouGridPrimitive || !mapStore.beiDouGridMeta) return
  if (!mapStore.viewer) return
  if (mapStore.beiDouGridMeta.renderMode === 'instanced') return

  try {
    const { gridX, gridY, gridZ } = mapStore.beiDouGridMeta
    const primitive = mapStore.beiDouGridPrimitive
    const color = (form.fillColor
      ? Cesium.Color.fromCssColorString(form.fillColor)
      : new Cesium.Color(0.0, 0.9, 1.0, 1.0)
    ).withAlpha(
      typeof form.fillOpacity === 'number' ? form.fillOpacity : 0.25
    )
    for (let ix = 0; ix < gridX; ix++) {
      for (let iy = 0; iy < gridY; iy++) {
        for (let iz = 0; iz < gridZ; iz++) {
          const id = `beidou-cell-${ix}-${iy}-${iz}`
          const attr = primitive.getGeometryInstanceAttributes(id)
          if (attr && attr.color) {
            attr.color = Cesium.ColorGeometryInstanceAttribute.toValue(color)
          }
        }
      }
    }
    mapStore.beiDouGridMeta.fillColor = color
  } catch (e) {
    // 忽略运行时错误，避免阻断交互
  }
}

const handleFillStyleChange = () => {
  // 仅在用户松手（change 事件触发）后，批量更新格网颜色，避免拖动时频繁大量计算
  safeUpdateBeiDouFillStyle()
}

const handleOutlineStyleChange = () => {
  // 仅在用户松手后更新 3D 格网线框的颜色与透明度
  if (!mapStore.beiDouGridMeta) return
  if (!mapStore.viewer) return

  // 大规模 instanced 模式下：更新主网格线框样式后，重施选中高亮 Primitive。
  if (mapStore.beiDouGridMeta.renderMode === 'instanced') {
    try {
      const color = (form.outlineColor
        ? Cesium.Color.fromCssColorString(form.outlineColor)
        : Cesium.Color.BLACK
      ).withAlpha(
        typeof form.outlineOpacity === 'number' ? form.outlineOpacity : 0.8
      )

      mapStore.beiDouGridMeta.outlineColor = color
      if (mapStore.beiDouGridPrimitive?.setWireframeStyle) {
        mapStore.beiDouGridPrimitive.setWireframeStyle({
          color
        })
      }
      if (mapStore.selectedBeiDouCellId) {
        mapStore.selectBeiDouCell(mapStore.selectedBeiDouCellId)
      } else if (mapStore.viewer?.scene?.requestRender) {
        mapStore.viewer.scene.requestRender()
      }
    } catch (e) {
      // ignore
    }
    return
  }

  if (!mapStore.beiDouGridOutlinePrimitive) return

  try {
    const { gridX, gridY, gridZ } = mapStore.beiDouGridMeta
    const primitive = mapStore.beiDouGridOutlinePrimitive
    const color = (form.outlineColor
      ? Cesium.Color.fromCssColorString(form.outlineColor)
      : Cesium.Color.BLACK
    ).withAlpha(
      typeof form.outlineOpacity === 'number' ? form.outlineOpacity : 0.8
    )

    for (let ix = 0; ix < gridX; ix++) {
      for (let iy = 0; iy < gridY; iy++) {
        for (let iz = 0; iz < gridZ; iz++) {
          const id = `beidou-cell-${ix}-${iy}-${iz}`
          const attr = primitive.getGeometryInstanceAttributes(id)
          if (attr && attr.color) {
            attr.color = Cesium.ColorGeometryInstanceAttribute.toValue(color)
          }
        }
      }
    }

    mapStore.beiDouGridMeta.outlineColor = color

    // 批量更新边框样式后，重新施加当前选中高亮，避免选中态被覆盖。
    if (mapStore.selectedBeiDouCellId) {
      mapStore.selectBeiDouCell(mapStore.selectedBeiDouCellId)
    } else if (mapStore.viewer?.scene?.requestRender) {
      mapStore.viewer.scene.requestRender()
    }
  } catch (e) {
    // 忽略运行时错误，避免阻断交互
  }
}
</script>

<style scoped>
.grid-config {
  padding: 8px 0;
  text-align: center;
}

.grid-config :deep(.el-form-item) {
  text-align: left;
  margin-bottom: 20px;
}

.grid-config :deep(.el-form-item__label) {
  text-align: left;
}

.grid-config :deep(.el-radio-group) {
  display: flex;
  flex-direction: row;
  gap: 16px;
  justify-content: flex-start;
}

.grid-size-inputs,
.height-range-inputs,
.bounds-inputs {
  width: 100%;
}

.grid-info {
  font-size: 12px;
  color: #666;
  line-height: 1.8;
}
</style>

