import shp from 'shpjs'

function initBbox() {
  return {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY
  }
}

function isFiniteBbox(b) {
  return (
    Number.isFinite(b.minX) &&
    Number.isFinite(b.minY) &&
    Number.isFinite(b.maxX) &&
    Number.isFinite(b.maxY)
  )
}

function updateBbox(b, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  if (x < b.minX) b.minX = x
  if (y < b.minY) b.minY = y
  if (x > b.maxX) b.maxX = x
  if (y > b.maxY) b.maxY = y
}

function traverseCoordinates(b, coords) {
  if (!coords) return
  if (typeof coords[0] === 'number') {
    updateBbox(b, coords[0], coords[1])
    return
  }
  for (const c of coords) traverseCoordinates(b, c)
}

function consumeGeometry(b, geometry) {
  if (!geometry) return
  if (geometry.type === 'GeometryCollection' && Array.isArray(geometry.geometries)) {
    for (const g of geometry.geometries) consumeGeometry(b, g)
    return
  }
  traverseCoordinates(b, geometry.coordinates)
}

function consumeGeoJson(b, geo) {
  if (!geo) return

  // shpjs 可能返回 {layerName: FeatureCollection, ...}
  if (!Array.isArray(geo) && typeof geo === 'object' && geo.type === undefined) {
    for (const v of Object.values(geo)) consumeGeoJson(b, v)
    return
  }

  if (Array.isArray(geo)) {
    for (const g of geo) consumeGeoJson(b, g)
    return
  }

  if (geo.type === 'FeatureCollection' && Array.isArray(geo.features)) {
    for (const f of geo.features) consumeGeoJson(b, f)
    return
  }

  if (geo.type === 'Feature' && geo.geometry) {
    consumeGeometry(b, geo.geometry)
    return
  }

  // 直接是 Geometry
  if (geo.type && geo.coordinates) {
    consumeGeometry(b, geo)
  }
}

export function geoJsonToBounds(geo) {
  const b = initBbox()
  consumeGeoJson(b, geo)
  if (!isFiniteBbox(b)) return null
  return b
}

export function looksLikeLonLatBounds(bounds) {
  if (!bounds) return false
  const { minX, minY, maxX, maxY } = bounds
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return false
  return minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90
}

export async function parseShpZipArrayBufferToBounds(zipArrayBuffer) {
  const geo = await shp(zipArrayBuffer)
  return geoJsonToBounds(geo)
}

function pushPolygonGeometries(geometry, out) {
  if (!geometry) return
  if (geometry.type === 'Polygon') {
    out.push(geometry.coordinates)
    return
  }
  if (geometry.type === 'MultiPolygon') {
    for (const c of geometry.coordinates || []) out.push(c)
    return
  }
  if (geometry.type === 'GeometryCollection' && Array.isArray(geometry.geometries)) {
    for (const g of geometry.geometries) pushPolygonGeometries(g, out)
  }
}

function collectClipPolygonsFromGeoJson(geo, out) {
  if (!geo) return
  if (!Array.isArray(geo) && typeof geo === 'object' && geo.type === undefined) {
    for (const v of Object.values(geo)) collectClipPolygonsFromGeoJson(v, out)
    return
  }
  if (Array.isArray(geo)) {
    for (const g of geo) collectClipPolygonsFromGeoJson(g, out)
    return
  }
  if (geo.type === 'FeatureCollection' && Array.isArray(geo.features)) {
    for (const f of geo.features) {
      if (f.geometry) pushPolygonGeometries(f.geometry, out)
    }
    return
  }
  if (geo.type === 'Feature' && geo.geometry) {
    pushPolygonGeometries(geo.geometry, out)
    return
  }
  if (geo.type && geo.coordinates) {
    pushPolygonGeometries(geo, out)
  }
}

/**
 * 从 shp 解析结果提取 MultiPolygon 坐标（用于柱掩膜），若无面几何则返回 null
 */
export function geoJsonToClipMultiPolygon(geo) {
  const polys = []
  collectClipPolygonsFromGeoJson(geo, polys)
  if (polys.length === 0) return null
  return { type: 'MultiPolygon', coordinates: polys }
}

export async function parseShpZipArrayBufferToBoundsAndClip(zipArrayBuffer) {
  const geo = await shp(zipArrayBuffer)
  const bounds = geoJsonToBounds(geo)
  const clipGeoJson = geoJsonToClipMultiPolygon(geo)
  return { bounds, clipGeoJson }
}

