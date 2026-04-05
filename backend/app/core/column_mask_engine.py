from __future__ import annotations

import base64
import logging
import math
import time
from typing import Callable, List, Optional

import numpy as np

logger = logging.getLogger("backend.column_mask")


def _point_in_ring(lon: float, lat: float, ring: List[List[float]]) -> bool:
    if not ring or len(ring) < 3:
        return False
    inside = False
    n = len(ring)
    for i in range(n):
        j = (i - 1) % n
        xi, yi = float(ring[i][0]), float(ring[i][1])
        xj, yj = float(ring[j][0]), float(ring[j][1])
        if not all(map(math.isfinite, (xi, yi, xj, yj))):
            continue
        if abs(yj - yi) < 1e-15:
            continue
        if (yi > lat) != (yj > lat):
            x_int = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x_int:
                inside = not inside
    return inside


def _point_in_polygon_with_holes(lon: float, lat: float, polygon_coords: List[List[List[float]]]) -> bool:
    if not polygon_coords or not polygon_coords[0]:
        return False
    if not _point_in_ring(lon, lat, polygon_coords[0]):
        return False
    for h in range(1, len(polygon_coords)):
        if _point_in_ring(lon, lat, polygon_coords[h]):
            return False
    return True


def _point_in_multi_polygon(lon: float, lat: float, multi_coords: List[List[List[List[float]]]]) -> bool:
    for poly in multi_coords:
        if _point_in_polygon_with_holes(lon, lat, poly):
            return True
    return False


def _simplify_ring(ring: List[List[float]], max_vertices: int) -> List[List[float]]:
    if len(ring) <= max_vertices:
        return ring
    step = max(1, math.ceil(len(ring) / max_vertices))
    out: List[List[float]] = []
    for i in range(0, len(ring) - 1, step):
        out.append([float(ring[i][0]), float(ring[i][1])])
    last_pt = ring[-2] if len(ring) > 1 and ring[0] == ring[-1] else ring[-1]
    if not out or out[-1][0] != last_pt[0] or out[-1][1] != last_pt[1]:
        out.append([float(last_pt[0]), float(last_pt[1])])
    if len(ring) > 1 and ring[0] == ring[-1] and len(out) >= 2:
        a, b = out[0], out[-1]
        if a[0] != b[0] or a[1] != b[1]:
            out.append([a[0], a[1]])
    return out


def _simplify_multi(
    multi: List[List[List[List[float]]]], max_per_ring: int = 2500
) -> List[List[List[List[float]]]]:
    out: List[List[List[List[float]]]] = []
    for poly in multi:
        out.append([_simplify_ring(r, max_per_ring) for r in poly])
    return out


def compute_column_active_mask(
    min_lon: float,
    min_lat: float,
    max_lon: float,
    max_lat: float,
    dx: float,
    dy: float,
    grid_x: int,
    grid_y: int,
    multi_coords: Optional[List[List[List[List[float]]]]],
    on_progress: Optional[Callable[[int], None]] = None,
) -> tuple[np.ndarray, int]:
    """
    返回 (column_active float32 扁平 iy*grid_x+ix, active_columns)
    与前端 sampleGridGroundHeights / ENU 柱心一致：
    lon = min_lon + (ix+0.5)*dx / m_per_deg_lon
    lat = min_lat + (iy+0.5)*dy / m_per_deg_lat
    """
    n = grid_x * grid_y
    out = np.ones(n, dtype=np.float32)

    if not multi_coords:
        if on_progress:
            on_progress(100)
        logger.info(
            "column_mask: 无裁剪多边形，全柱有效 grid=%dx%d cells=%d",
            grid_x,
            grid_y,
            n,
        )
        return out, int(n)

    multi_coords = _simplify_multi(multi_coords, 2500)
    poly_count = len(multi_coords)
    logger.info(
        "column_mask: 开始点在多边形内 grid=%dx%d cells=%d polygons=%d dx=%.2f dy=%.2f",
        grid_x,
        grid_y,
        n,
        poly_count,
        dx,
        dy,
    )
    t_loop = time.perf_counter()

    center_lat_deg = (min_lat + max_lat) * 0.5
    center_lat_rad = math.radians(center_lat_deg)
    meters_per_deg_lat = 111000.0
    meters_per_deg_lon = max(1e-9, 111000.0 * math.cos(center_lat_rad))

    total = n
    done = 0
    report_every = max(5000, total // 20)

    for iy in range(grid_y):
        for ix in range(grid_x):
            local_x = (ix + 0.5) * dx
            local_y = (iy + 0.5) * dy
            lon = min_lon + local_x / meters_per_deg_lon
            lat = min_lat + local_y / meters_per_deg_lat
            inside = _point_in_multi_polygon(lon, lat, multi_coords)
            idx = iy * grid_x + ix
            out[idx] = 1.0 if inside else 0.0
            done += 1
            if on_progress and done % report_every == 0 and total > 0:
                on_progress(int(done * 100 / total))

    active_columns = int(np.sum(out > 0.5))
    loop_elapsed = time.perf_counter() - t_loop
    logger.info(
        "column_mask: 多边形判断完成 activeColumns=%d / %d 用时 %.2fs",
        active_columns,
        n,
        loop_elapsed,
    )
    if on_progress:
        on_progress(100)
    return out, active_columns


def mask_to_b64(arr: np.ndarray) -> str:
    if arr.dtype != np.float32:
        arr = arr.astype(np.float32)
    return base64.b64encode(arr.tobytes()).decode("ascii")


def run_column_mask_job(
    req,
    on_progress: Optional[Callable[[int], None]] = None,
) -> dict:
    gx, gy = req.gridX, req.gridY
    multi = req.clipMultiPolygonCoordinates
    t0 = time.perf_counter()

    arr, active_columns = compute_column_active_mask(
        req.minLon,
        req.minLat,
        req.maxLon,
        req.maxLat,
        req.dx,
        req.dy,
        gx,
        gy,
        multi,
        on_progress=on_progress,
    )

    if arr.size != gx * gy:
        raise ValueError("column mask size mismatch")

    t1 = time.perf_counter()
    b64 = mask_to_b64(arr)
    t2 = time.perf_counter()
    logger.info(
        "column_mask: base64 编码用时 %.2fs，输出长度 %d 字符 (原始 %.2f MB)",
        t2 - t1,
        len(b64),
        arr.nbytes / (1024 * 1024),
    )
    logger.info(
        "column_mask: 任务总耗时 %.2fs (grid=%dx%d)",
        t2 - t0,
        gx,
        gy,
    )

    return {
        "gridX": gx,
        "gridY": gy,
        "activeColumns": active_columns,
        "columnActiveB64": b64,
    }
