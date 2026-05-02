<template>
  <div id="app">
    <!-- 顶部导航栏 -->
    <header class="app-header">
      <div class="header-left">
        <h1 class="logo">3D GIS 可视域分析系统</h1>
      </div>
      <div class="header-right">
        <el-button type="text" class="header-btn">
          <el-icon><QuestionFilled /></el-icon>
          帮助
        </el-button>
        <el-button type="text" class="header-btn">
          <el-icon><User /></el-icon>
          用户
        </el-button>
      </div>
    </header>

    <!-- 主内容区 -->
    <main class="app-main">
      <!-- 左侧工具面板 -->
      <aside 
        class="left-panel" 
        :style="{ width: panelWidth + 'px', display: panelVisible ? 'flex' : 'none' }"
      >
        <div class="panel-content">
          <el-tabs v-model="activeTab" type="border-card" class="panel-tabs">
            <!-- 区域选择 -->
            <el-tab-pane label="区域选择" name="region">
              <RegionSelector />
            </el-tab-pane>

            <!-- 站点划设 -->
            <el-tab-pane label="站点划设" name="station">
              <StationManager />
            </el-tab-pane>

            <!-- 格网配置 -->
            <el-tab-pane label="格网配置" name="grid">
              <GridConfig />
            </el-tab-pane>

            <!-- 信号强度 -->
            <el-tab-pane label="信号强度" name="signal">
              <SignalStrengthLab />
            </el-tab-pane>

            <el-tab-pane label="性能实验" name="grid-performance">
              <GridPerformanceLab />
            </el-tab-pane>
            <el-tab-pane label="格网生成实验" name="grid-generation-lab">
              <GridGenerationLab />
            </el-tab-pane>

            <!-- 分析参数 -->
            <el-tab-pane label="分析参数" name="analysis">
              <AnalysisPanel />
            </el-tab-pane>

            <!-- 结果可视化 -->
            <el-tab-pane label="结果可视化" name="result">
              <ResultVisualizer />
            </el-tab-pane>
          </el-tabs>
        </div>
        
        <!-- 拖拽条和隐藏按钮 -->
        <div class="panel-resizer" @mousedown="startResize">
          <div class="resize-handle"></div>
          <div class="hide-button" @click="togglePanel" :title="panelVisible ? '隐藏侧边栏' : '显示侧边栏'">
            <el-icon><ArrowLeft v-if="panelVisible" /><ArrowRight v-else /></el-icon>
          </div>
        </div>
      </aside>

      <!-- 显示/隐藏按钮（当侧边栏隐藏时） -->
      <div v-if="!panelVisible" class="show-panel-button" @click="togglePanel" title="显示侧边栏">
        <el-icon><ArrowRight /></el-icon>
      </div>

      <!-- Cesium 3D地图区域 -->
      <section class="map-container">
        <MapViewer />
        <!-- 北斗格网单元属性弹窗 -->
        <BeiDouCellInfoPanel />
      </section>
    </main>

    <!-- 底部状态栏 -->
    <footer class="app-footer">
      <div class="footer-left">
        <span class="status-item">
          <el-icon><Location /></el-icon>
          中心点: {{ mapCenter.lon.toFixed(4) }}, {{ mapCenter.lat.toFixed(4) }}
        </span>
        <span class="status-item">
          <el-icon><View /></el-icon>
          缩放级别: {{ zoomLevel }}
        </span>
      </div>
      <div class="footer-right">
        <el-progress
          v-if="analysisProgress > 0"
          :percentage="analysisProgress"
          :status="isAnalyzing ? 'active' : 'success'"
          :stroke-width="4"
          class="progress-bar"
        />
        <span v-if="statusMessage" class="status-message">{{ statusMessage }}</span>
      </div>
    </footer>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useMapStore } from './stores/map'
import { useAnalysisStore } from './stores/analysis'
import MapViewer from './components/MapViewer.vue'
import RegionSelector from './components/RegionSelector.vue'
import StationManager from './components/StationManager.vue'
import GridConfig from './components/GridConfig.vue'
import GridPerformanceLab from './components/GridPerformanceLab.vue'
import GridGenerationLab from './components/GridGenerationLab.vue'
import AnalysisPanel from './components/AnalysisPanel.vue'
import ResultVisualizer from './components/ResultVisualizer.vue'
import SignalStrengthLab from './components/SignalStrengthLab.vue'
import BeiDouCellInfoPanel from './components/BeiDouCellInfoPanel.vue'
import { QuestionFilled, User, Location, View, ArrowLeft, ArrowRight } from '@element-plus/icons-vue'

const activeTab = ref('region')
const mapStore = useMapStore()
const analysisStore = useAnalysisStore()

// 侧边栏控制
const panelWidth = ref(320)
const panelVisible = ref(true)
const isResizing = ref(false)

const mapCenter = computed(() => mapStore.center)
const zoomLevel = computed(() => mapStore.zoom)
const analysisProgress = computed(() => analysisStore.analysisProgress)
const isAnalyzing = computed(() => analysisStore.isAnalyzing)
const statusMessage = computed(() => {
  if (analysisStore.isAnalyzing) return '分析进行中'
  if (analysisStore.hasResults) return '分析完成'
  return '准备就绪'
})

const togglePanel = () => {
  panelVisible.value = !panelVisible.value
}

const startResize = (e) => {
  // 如果点击的是隐藏按钮，不触发拖拽
  if (e.target.closest('.hide-button')) {
    return
  }
  
  isResizing.value = true
  const startX = e.clientX
  const startWidth = panelWidth.value
  let rafId = null

  const doResize = (e) => {
    // 使用 requestAnimationFrame 优化性能
    if (rafId) {
      cancelAnimationFrame(rafId)
    }
    
    rafId = requestAnimationFrame(() => {
      const diff = e.clientX - startX // 向右拖拽增加宽度，向左拖拽减少宽度
      const newWidth = startWidth + diff
      if (newWidth >= 280 && newWidth <= 800) {
        panelWidth.value = newWidth
      }
    })
  }

  const stopResize = () => {
    isResizing.value = false
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    document.removeEventListener('mousemove', doResize)
    document.removeEventListener('mouseup', stopResize)
    // 移除拖拽时的样式类
    document.body.classList.remove('is-resizing')
  }

  // 添加拖拽时的样式类，禁用过渡动画
  document.body.classList.add('is-resizing')
  
  document.addEventListener('mousemove', doResize, { passive: true })
  document.addEventListener('mouseup', stopResize)
  e.preventDefault()
}

onMounted(() => {
  // 从 localStorage 恢复设置
  const savedWidth = localStorage.getItem('panelWidth')
  const savedVisible = localStorage.getItem('panelVisible')
  if (savedWidth) {
    panelWidth.value = parseInt(savedWidth)
  }
  if (savedVisible !== null) {
    panelVisible.value = savedVisible === 'true'
  }
})

onUnmounted(() => {
  // 保存设置到 localStorage
  localStorage.setItem('panelWidth', panelWidth.value.toString())
  localStorage.setItem('panelVisible', panelVisible.value.toString())
})
</script>

<style scoped>
#app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

/* 顶部导航栏 */
.app-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 24px;
  height: 60px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  z-index: 1000;
}

.header-left .logo {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.header-right {
  display: flex;
  gap: 16px;
}

.header-btn {
  color: white !important;
  padding: 8px 16px;
}

.header-btn:hover {
  background: rgba(255, 255, 255, 0.1);
}

/* 主内容区 */
.app-main {
  display: flex;
  flex: 1;
  overflow: hidden;
  position: relative;
}

/* 左侧工具面板 */
.left-panel {
  display: flex;
  flex-direction: row;
  min-width: 280px;
  max-width: 800px;
  background: #f5f5f5;
  border-right: 1px solid #e0e0e0;
  overflow: hidden;
  position: relative;
  transition: width 0.2s ease;
  will-change: width;
}

/* 拖拽时禁用过渡动画 */
body.is-resizing .left-panel {
  transition: none;
}

.panel-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.panel-tabs {
  height: 100%;
  border: none;
  border-radius: 0;
}

.panel-tabs :deep(.el-tabs__content) {
  padding: 16px;
  height: calc(100% - 40px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
}

.panel-tabs :deep(.el-tab-pane) {
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* 拖拽条和隐藏按钮 */
.panel-resizer {
  width: 8px;
  background: #e0e0e0;
  cursor: col-resize;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
  user-select: none;
  -webkit-user-select: none;
  will-change: background;
}

.panel-resizer:hover {
  background: #c0c0c0;
}

.panel-resizer:active {
  background: #409eff;
}

.resize-handle {
  width: 2px;
  height: 100%;
  background: #999;
  opacity: 0.5;
}

.hide-button {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 24px;
  height: 48px;
  background: #409eff;
  border-radius: 4px 0 0 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: white;
  transition: all 0.2s;
  z-index: 10;
  box-shadow: -2px 0 4px rgba(0, 0, 0, 0.1);
}

.hide-button:hover {
  background: #66b1ff;
  width: 28px;
}

/* 显示侧边栏按钮（当隐藏时） */
.show-panel-button {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 32px;
  height: 64px;
  background: #409eff;
  border-radius: 0 4px 4px 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: white;
  z-index: 100;
  box-shadow: 2px 0 4px rgba(0, 0, 0, 0.1);
  transition: all 0.2s;
}

.show-panel-button:hover {
  background: #66b1ff;
  width: 36px;
}

/* Cesium 地图容器 */
.map-container {
  flex: 1;
  position: relative;
  background: #000;
}

/* 底部状态栏 */
.app-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 24px;
  height: 40px;
  background: #fafafa;
  border-top: 1px solid #e0e0e0;
  font-size: 12px;
  color: #666;
}

.footer-left {
  display: flex;
  gap: 24px;
}

.status-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.footer-right {
  display: flex;
  align-items: center;
  gap: 16px;
}

.progress-bar {
  width: 200px;
}

.status-message {
  color: #409eff;
}
</style>
