<template>
  <div id="cesiumContainer" class="cesium-container"></div>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue'
import * as Cesium from 'cesium'
import { useMapStore } from '../stores/map'

const mapStore = useMapStore()
let viewer = null
let clickHandler = null

onMounted(async () => {
  // 从环境变量读取 Cesium Ion Token（在 .env/.env.local 中配置 VITE_CESIUM_ION_TOKEN）
  const cesiumToken = import.meta.env.VITE_CESIUM_ION_TOKEN
  if (cesiumToken) {
    Cesium.Ion.defaultAccessToken = cesiumToken
  } else {
    console.warn('未设置 VITE_CESIUM_ION_TOKEN，将使用无地形的椭球地面和 ESRI 卫星影像')
  }

  // 优先使用在线 DEM（需要 token），否则回退到椭球地面
  // 注意：当 token 无效/网络异常时，世界地形的可用性信息可能不完整，导致 Cesium 内部报错；
  // 这里做 readyPromise 兜底，失败则回退 EllipsoidTerrainProvider。
  let terrainProvider = null
  if (cesiumToken) {
    try {
      terrainProvider = Cesium.createWorldTerrain()
      if (terrainProvider && terrainProvider.readyPromise) {
        await terrainProvider.readyPromise
      }
    } catch (e) {
      console.warn('世界地形初始化失败，回退到椭球地形：', e)
      terrainProvider = new Cesium.EllipsoidTerrainProvider()
    }
  } else {
    terrainProvider = new Cesium.EllipsoidTerrainProvider()
  }

  // 卫星影像底图：有 Ion Token 用 Bing 卫星，否则用 ESRI World Imagery（免费、无需 token）
  let imageryProvider = null
  if (cesiumToken) {
    try {
      imageryProvider = Cesium.createWorldImagery() // Bing Maps 卫星影像，需 Ion Token
    } catch (e) {
      console.warn('世界影像初始化失败，回退到 ESRI 影像：', e)
      imageryProvider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
        { credit: 'Esri, Maxar, Earthstar Geographics' }
      )
    }
  } else {
    imageryProvider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
      { credit: 'Esri, Maxar, Earthstar Geographics' }
    )
  }

  // 创建 Cesium Viewer
  viewer = new Cesium.Viewer('cesiumContainer', {
    terrainProvider,
    imageryProvider,
    baseLayerPicker: false,
    animation: false,
    timeline: false,
    vrButton: false,
    geocoder: false,
    homeButton: true,
    infoBox: true,
    sceneModePicker: true,
    selectionIndicator: true,
    navigationHelpButton: false,
    fullscreenButton: true
  })

  // 地形异常兜底：一旦 terrain tile 请求报错，自动回退椭球地形，避免持续报错影响渲染/交互
  try {
    const tp = viewer.terrainProvider
    if (tp && tp.errorEvent && typeof tp.errorEvent.addEventListener === 'function') {
      // 重要：地形瓦片失败并不一定意味着“整个地形不可用”
      // （例如格网贴地会触发额外采样请求，可能只失败少量瓦片）。
      // 若每次失败都直接切换到 EllipsoidTerrainProvider，会导致底图起伏瞬间消失。
      // 另外：不要在渲染过程中动态切换 terrainProvider（会导致 Cesium 内部 tile 状态不一致，
      // 从而出现你提到的 `reading 'rectangles'` 这类渲染停止错误）。
      // 这里仅做日志限流，不进行运行时 provider 切换。
      let terrainErrorCount = 0
      const LOG_FIRST_N = 5

      tp.errorEvent.addEventListener((err) => {
        terrainErrorCount += 1
        if (terrainErrorCount <= LOG_FIRST_N) {
          console.warn('地形瓦片请求失败（保留当前地形底图），错误：', err)
        }
      })
    }
  } catch (e) {
    // ignore
  }

  // 设置初始视角（深圳）
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(114.0579, 22.5431, 5000)
  })

  // 保存 viewer 实例到 store
  mapStore.setViewer(viewer)

  // 鼠标拾取北斗格网单元（geometryInstances 走 Cesium pick，instanced 走 GPU 拾取）
  clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
  clickHandler.setInputAction((movement) => {
    try {
      let id = null
      const picked = viewer.scene.pick(movement.position)
      if (picked && picked.id) id = picked.id
      const instancedPickPrim = mapStore.activeBeiDouCellPrimitive
      if ((typeof id !== 'string' || !id.startsWith('beidou-cell-')) && mapStore.beiDouGridMeta?.renderMode === 'instanced' && instancedPickPrim?.pick) {
        const globalId = instancedPickPrim.pick(viewer.scene, movement.position.x, movement.position.y)
        if (globalId >= 0 && mapStore.beiDouGridMeta) {
          const { gridX, gridY } = mapStore.beiDouGridMeta
          const layerSize = gridX * gridY
          const iz = Math.floor(globalId / layerSize)
          const rem = globalId % layerSize
          const iy = Math.floor(rem / gridX)
          const ix = rem % gridX
          id = `beidou-cell-${ix}-${iy}-${iz}`
        }
      }
      if (typeof id === 'string' && id.startsWith('beidou-cell-')) {
        mapStore.selectBeiDouCell(id)
      } else {
        mapStore.selectBeiDouCell(null)
      }
    } catch (e) {
      // 防止 Cesium 内部对象销毁竞态导致未捕获异常
      console.warn('[MapViewer] click pick/select failed:', e)
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

  // 监听相机移动，更新中心点和缩放级别显示
  const updateCameraInfo = () => {
    const carto = viewer.camera.positionCartographic
    const lon = Cesium.Math.toDegrees(carto.longitude)
    const lat = Cesium.Math.toDegrees(carto.latitude)
    const height = carto.height
    // 简单换算缩放级别（基于地球周长的近似）
    const zoom = Math.max(1, Math.round(Math.log2(40075000 / height)))
    mapStore.setCenter(lon, lat)
    mapStore.setZoom(zoom)
  }
  viewer.camera.moveEnd.addEventListener(updateCameraInfo)
  updateCameraInfo()
})

onUnmounted(() => {
  if (viewer) {
    if (clickHandler) {
      clickHandler.destroy()
      clickHandler = null
    }
    viewer.destroy()
  }
})
</script>

<style scoped>
.cesium-container {
  width: 100%;
  height: 100%;
}
</style>

