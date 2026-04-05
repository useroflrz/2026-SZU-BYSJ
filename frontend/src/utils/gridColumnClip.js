/**
 * 柱心经纬度与 SHP 多边形裁剪（与 map.showBeiDouGrid / sampleGridGroundHeights 一致：
 * originLon/originLat 为西南角，东向 X、北向 Y，米制步长 dx/dy）。
 */

/**
 * 射线法：点在环内（环为闭合 [lon,lat][]，首尾可重复）
 */
export function pointInRing(lon, lat, ring) {
  if (!ring || ring.length < 3) return false
  let inside = false
  const n = ring.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    if (![xi, yi, xj, yj].every(Number.isFinite)) continue
    if (Math.abs(yj - yi) < 1e-15) continue
    const intersect =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/** GeoJSON Polygon coordinates: [outer, ...holes] */
export function pointInPolygonWithHoles(lon, lat, polygonCoords) {
  if (!polygonCoords || !polygonCoords[0]) return false
  if (!pointInRing(lon, lat, polygonCoords[0])) return false
  for (let h = 1; h < polygonCoords.length; h++) {
    if (pointInRing(lon, lat, polygonCoords[h])) return false
  }
  return true
}

/** GeoJSON MultiPolygon coordinates */
export function pointInMultiPolygonCoordinates(lon, lat, multiCoordinates) {
  if (!multiCoordinates || !multiCoordinates.length) return false
  for (let p = 0; p < multiCoordinates.length; p++) {
    if (pointInPolygonWithHoles(lon, lat, multiCoordinates[p])) return true
  }
  return false
}

function simplifyOpenRing(ring, maxVertices) {
  if (!ring || ring.length <= maxVertices) return ring
  const step = Math.max(1, Math.ceil(ring.length / maxVertices))
  const out = []
  for (let i = 0; i < ring.length - 1; i += step) {
    out.push(ring[i])
  }
  const first = ring[0]
  const last = ring[ring.length - 1]
  const closed = first[0] === last[0] && first[1] === last[1]
  const lastPt = closed ? ring[ring.length - 2] : ring[ring.length - 1]
  const olast = out[out.length - 1]
  if (!olast || olast[0] !== lastPt[0] || olast[1] !== lastPt[1]) {
    out.push([lastPt[0], lastPt[1]])
  }
  if (closed && out.length >= 2) {
    const a = out[0]
    const b = out[out.length - 1]
    if (a[0] !== b[0] || a[1] !== b[1]) out.push([a[0], a[1]])
  }
  return out
}

/** 对 MultiPolygon 各环做顶点数限制，避免超大数据点-in-多边形过慢 */
export function simplifyMultiPolygonCoordinates(multiCoordinates, maxVerticesPerRing = 2500) {
  if (!multiCoordinates) return multiCoordinates
  return multiCoordinates.map((poly) =>
    poly.map((ring) => simplifyOpenRing(ring, maxVerticesPerRing))
  )
}

/**
 * @returns {Float32Array} length gridX*gridY, 1=参与分析/渲染，0=区外
 */
/** 后端 columnActiveB64（float32 LE）解码为 Float32Array */
export function decodeColumnActiveFloat32B64(b64) {
  if (!b64 || typeof b64 !== 'string') {
    throw new Error('columnActiveB64 无效')
  }
  const bin = atob(b64)
  const buf = new ArrayBuffer(bin.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) {
    view[i] = bin.charCodeAt(i)
  }
  return new Float32Array(buf)
}

export function buildColumnActiveMask({
  originLon,
  originLat,
  gridX,
  gridY,
  dx,
  dy,
  centerLatDeg,
  multiPolygonCoordinates
}) {
  const mask = new Float32Array(gridX * gridY)
  if (!multiPolygonCoordinates || !multiPolygonCoordinates.length) {
    mask.fill(1)
    return mask
  }
  const centerLatRad = (centerLatDeg * Math.PI) / 180
  const metersPerDegLat = 111000.0
  const metersPerDegLon = Math.max(1e-9, 111000.0 * Math.cos(centerLatRad))
  for (let iy = 0; iy < gridY; iy++) {
    for (let ix = 0; ix < gridX; ix++) {
      const localX = (ix + 0.5) * dx
      const localY = (iy + 0.5) * dy
      const lon = originLon + localX / metersPerDegLon
      const lat = originLat + localY / metersPerDegLat
      const inside = pointInMultiPolygonCoordinates(lon, lat, multiPolygonCoordinates)
      mask[iy * gridX + ix] = inside ? 1 : 0
    }
  }
  return mask
}
