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

  // 设置初始视角（深圳）
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(114.0579, 22.5431, 5000)
  })

  // 保存 viewer 实例到 store
  mapStore.setViewer(viewer)

  // 鼠标拾取北斗格网单元
  clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
  clickHandler.setInputAction((movement) => {
    const picked = viewer.scene.pick(movement.position)
    const id = picked && picked.id
    if (typeof id === 'string' && id.startsWith('beidou-cell-')) {
      mapStore.selectBeiDouCell(id)
    } else {
      mapStore.selectBeiDouCell(null)
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

