from __future__ import annotations

import base64
import io
from typing import Optional

import numpy as np
from tifffile import TiffFile


def _decode_column_active_b64(column_active_b64: Optional[str], expected_size: int) -> Optional[np.ndarray]:
    if not column_active_b64:
        return None
    raw = base64.b64decode(column_active_b64.encode("ascii"))
    arr = np.frombuffer(raw, dtype=np.float32)
    if arr.size != expected_size:
        raise ValueError("columnActive length mismatch")
    return arr


def _encode_float32_b64(arr: np.ndarray) -> str:
    return base64.b64encode(arr.astype(np.float32, copy=False).tobytes()).decode("ascii")


def _read_dem_raster(dem_bytes: bytes) -> tuple[np.ndarray, float, float, float, float, float]:
    with TiffFile(io.BytesIO(dem_bytes)) as tif:
        page = tif.pages[0]
        raster = page.asarray().astype(np.float32, copy=False)
        if raster.ndim > 2:
            raster = raster[0]
        if raster.ndim != 2:
            raise ValueError("DEM tif 栅格维度无效")

        scale_tag = page.tags.get(33550)  # ModelPixelScaleTag
        tie_tag = page.tags.get(33922)    # ModelTiepointTag
        if scale_tag is None or tie_tag is None:
            raise ValueError("DEM tif 缺少地理参考标签(ModelPixelScale/ModelTiepoint)")

        scale = scale_tag.value
        tie = tie_tag.value
        if len(scale) < 2 or len(tie) < 6:
            raise ValueError("DEM tif 地理参考标签无效")

        sx = float(scale[0])
        sy = float(scale[1])
        x_origin = float(tie[3]) - float(tie[0]) * sx
        y_origin = float(tie[4]) - float(tie[1]) * sy
        nodata_tag = page.tags.get(42113)  # GDAL_NODATA
        nodata = float(nodata_tag.value) if nodata_tag is not None else np.nan
        return raster, x_origin, y_origin, sx, sy, nodata


def _sample_bilinear(raster: np.ndarray, px: float, py: float, nodata: float, default_height: float) -> float:
    h, w = raster.shape
    x0 = int(np.floor(px))
    y0 = int(np.floor(py))
    x1 = x0 + 1
    y1 = y0 + 1
    if x1 < 0 or y1 < 0 or x0 >= w or y0 >= h:
        return default_height

    x0 = max(0, min(w - 1, x0))
    x1 = max(0, min(w - 1, x1))
    y0 = max(0, min(h - 1, y0))
    y1 = max(0, min(h - 1, y1))

    tx = min(1.0, max(0.0, px - x0))
    ty = min(1.0, max(0.0, py - y0))

    vals = np.array([raster[y0, x0], raster[y0, x1], raster[y1, x0], raster[y1, x1]], dtype=np.float32)
    ws = np.array([(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty], dtype=np.float32)
    if np.isfinite(nodata):
        ws[vals == nodata] = 0.0
    valid_sum = float(np.sum(ws))
    if valid_sum <= 1e-6:
        return default_height
    return float(np.sum(vals * ws) / valid_sum)


def sample_local_dem_grid(
    *,
    dem_bytes: bytes,
    origin_lon: float,
    origin_lat: float,
    dx: float,
    dy: float,
    grid_x: int,
    grid_y: int,
    default_height: float = 0.0,
    column_active_b64: Optional[str] = None,
) -> dict:
    raster, x_origin, y_origin, sx, sy, nodata = _read_dem_raster(dem_bytes)
    h, w = raster.shape
    if sx <= 0 or sy <= 0:
        raise ValueError("DEM tif 像素尺度无效")

    center_lat_deg = origin_lat + ((grid_y * dy) / 111000.0) * 0.5
    meters_per_deg_lat = 111000.0
    meters_per_deg_lon = max(1e-9, 111000.0 * np.cos(np.radians(center_lat_deg)))

    total_cols = grid_x * grid_y
    column_active = _decode_column_active_b64(column_active_b64, total_cols)
    out = np.full((total_cols,), float(default_height), dtype=np.float32)
    sampled = 0

    for linear in range(total_cols):
        if column_active is not None and column_active[linear] <= 0.5:
            continue
        ix = linear % grid_x
        iy = linear // grid_x
        lon = origin_lon + ((ix + 0.5) * dx) / meters_per_deg_lon
        lat = origin_lat + ((iy + 0.5) * dy) / meters_per_deg_lat
        px = (lon - x_origin) / sx - 0.5
        py = (y_origin - lat) / sy - 0.5
        out[linear] = _sample_bilinear(raster, px, py, nodata, default_height)
        sampled += 1

    px0 = (origin_lon - x_origin) / sx - 0.5
    py0 = (y_origin - origin_lat) / sy - 0.5
    origin_ground_height = _sample_bilinear(raster, px0, py0, nodata, default_height)

    return {
        "gridX": grid_x,
        "gridY": grid_y,
        "totalColumns": total_cols,
        "sampledColumns": sampled,
        "originGroundHeight": origin_ground_height,
        "groundHeightsB64": _encode_float32_b64(out),
        "rasterWidth": int(w),
        "rasterHeight": int(h),
    }
