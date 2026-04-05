from __future__ import annotations

import logging
import math
import time
from typing import Callable, Dict, List

import numpy as np

from app.models.analysis_models import AnalysisParamsInput, GridMetaInput, StationInput

logger = logging.getLogger("backend.viewshed")


def _clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


def _bilinear_ground_height(
    x: float,
    y: float,
    grid_x: int,
    grid_y: int,
    dx: float,
    dy: float,
    ground_heights: np.ndarray,
    default_height: float,
) -> float:
    fx = x / dx - 0.5
    fy = y / dy - 0.5
    x0 = _clamp(int(math.floor(fx)), 0, grid_x - 1)
    y0 = _clamp(int(math.floor(fy)), 0, grid_y - 1)
    x1 = _clamp(x0 + 1, 0, grid_x - 1)
    y1 = _clamp(y0 + 1, 0, grid_y - 1)
    tx = max(0.0, min(1.0, fx - x0))
    ty = max(0.0, min(1.0, fy - y0))
    h00 = float(ground_heights[y0 * grid_x + x0]) if y0 * grid_x + x0 < ground_heights.size else default_height
    h10 = float(ground_heights[y0 * grid_x + x1]) if y0 * grid_x + x1 < ground_heights.size else default_height
    h01 = float(ground_heights[y1 * grid_x + x0]) if y1 * grid_x + x0 < ground_heights.size else default_height
    h11 = float(ground_heights[y1 * grid_x + x1]) if y1 * grid_x + x1 < ground_heights.size else default_height
    h0 = h00 * (1.0 - tx) + h10 * tx
    h1 = h01 * (1.0 - tx) + h11 * tx
    return h0 * (1.0 - ty) + h1 * ty


def _has_line_of_sight(
    tx: Dict[str, float],
    rx_x: float,
    rx_y: float,
    rx_height: float,
    *,
    max_distance: float,
    los_samples_min: int,
    los_samples_max: int,
    clearance: float,
    grid_x: int,
    grid_y: int,
    dx: float,
    dy: float,
    ground_heights: np.ndarray,
    default_height: float,
) -> bool:
    dxm = rx_x - tx["x"]
    dym = rx_y - tx["y"]
    dist = math.hypot(dxm, dym)
    if not math.isfinite(dist) or dist <= 0 or dist > max_distance:
        return False

    # 自适应采样：距离越远采样越多，但设置上下限
    adaptive_samples = int(max(los_samples_min, min(los_samples_max, dist / 250.0)))
    for i in range(1, adaptive_samples):
        t = i / adaptive_samples
        sx = tx["x"] + dxm * t
        sy = tx["y"] + dym * t
        line_height = tx["height"] + (rx_height - tx["height"]) * t
        terrain_height = _bilinear_ground_height(
            sx, sy, grid_x, grid_y, dx, dy, ground_heights, default_height
        )
        if terrain_height + clearance > line_height:
            return False
    return True


def run_grid_viewshed_analysis(
    stations: List[StationInput],
    grid_meta: GridMetaInput,
    params: AnalysisParamsInput,
    on_progress: Callable[[int], None] | None = None,
) -> dict:
    started_at = time.perf_counter()
    grid_x = grid_meta.gridX
    grid_y = grid_meta.gridY
    grid_z = grid_meta.gridZ
    dx = grid_meta.dx
    dy = grid_meta.dy
    dz = grid_meta.dz
    z_min_rel = grid_meta.zMinRel
    origin_lon = grid_meta.originLon
    origin_lat = grid_meta.originLat
    default_height = grid_meta.originGroundHeight

    bbox_cells = grid_x * grid_y * grid_z
    logger.info(
        "Viewshed compute start: bboxCells=%d, grid=%dx%dx%d, stations=%d",
        bbox_cells,
        grid_x,
        grid_y,
        grid_z,
        len(stations),
    )
    ground_heights = np.asarray(grid_meta.groundHeights, dtype=np.float32)
    if ground_heights.size != grid_x * grid_y:
        padded = np.full(grid_x * grid_y, default_height, dtype=np.float32)
        copy_count = min(padded.size, ground_heights.size)
        padded[:copy_count] = ground_heights[:copy_count]
        ground_heights = padded

    col_n = grid_x * grid_y
    column_active = np.ones(col_n, dtype=np.bool_)
    if grid_meta.columnActive is not None:
        ca = np.asarray(grid_meta.columnActive, dtype=np.float64).reshape(-1)
        if ca.size == col_n:
            column_active = ca > 0.5

    active_columns = int(np.sum(column_active))
    active_cells = active_columns * grid_z
    column_any_visible = np.zeros(col_n, dtype=np.bool_)

    layer_stats: List[dict] = []
    for iz in range(grid_z):
        layer_stats.append(
            {
                "layerIndex": iz,
                "totalPoints": 0,
                "visiblePoints": 0,
                "invisiblePoints": 0,
                "visibilityRatio": 0.0,
                "zMin": z_min_rel + iz * dz,
                "zMax": z_min_rel + (iz + 1) * dz,
            }
        )

    if active_cells <= 0:
        elapsed_ms = (time.perf_counter() - started_at) * 1000.0
        if on_progress:
            on_progress(100)
        return {
            "total": 0,
            "gridX": grid_x,
            "gridY": grid_y,
            "gridZ": grid_z,
            "stats": {
                "totalPoints": 0,
                "visiblePoints": 0,
                "invisiblePoints": 0,
                "visibilityRatio": 0.0,
                "stationCount": len(stations),
                "activeColumns": 0,
                "activeCells": 0,
                "coveredAreaM2": 0.0,
                "bboxCells": bbox_cells,
            },
            "layerStats": layer_stats,
            "uncoveredIndices": [],
            "elapsedMs": elapsed_ms,
        }

    center_lat_rad = math.radians(origin_lat)
    meters_per_deg_lat = 111000.0
    meters_per_deg_lon = max(1e-9, 111000.0 * math.cos(center_lat_rad))

    tx_list = []
    for s in stations:
        tx_list.append(
            {
                "x": (s.lon - origin_lon) * meters_per_deg_lon,
                "y": (s.lat - origin_lat) * meters_per_deg_lat,
                "height": s.height,
            }
        )

    uncovered_indices: List[int] = []
    visible_count = 0
    processed = 0
    progress_batch = max(1000, int(params.progressBatchCells))
    max_distance = params.maxDistance
    max_distance_sq = max_distance * max_distance

    # 候选站点预筛：每个网格柱只保留覆盖半径内站点，减少 LOS 次数
    for iz in range(grid_z):
        for iy in range(grid_y):
            for ix in range(grid_x):
                col_index = iy * grid_x + ix
                if not column_active[col_index]:
                    continue
                ground_h = float(ground_heights[col_index]) if col_index < ground_heights.size else default_height
                rx_x = (ix + 0.5) * dx
                rx_y = (iy + 0.5) * dy
                rx_h = z_min_rel + (iz + 0.5) * dz + (ground_h - default_height)

                candidates = []
                for tx in tx_list:
                    d2 = (rx_x - tx["x"]) ** 2 + (rx_y - tx["y"]) ** 2
                    if d2 <= max_distance_sq:
                        candidates.append(tx)

                visible = False
                for tx in candidates:
                    if _has_line_of_sight(
                        tx,
                        rx_x,
                        rx_y,
                        rx_h,
                        max_distance=max_distance,
                        los_samples_min=params.losSamplesMin,
                        los_samples_max=params.losSamplesMax,
                        clearance=params.clearance,
                        grid_x=grid_x,
                        grid_y=grid_y,
                        dx=dx,
                        dy=dy,
                        ground_heights=ground_heights,
                        default_height=default_height,
                    ):
                        visible = True
                        break

                global_index = iz * grid_x * grid_y + iy * grid_x + ix
                layer_stats[iz]["totalPoints"] += 1
                if visible:
                    visible_count += 1
                    column_any_visible[col_index] = True
                    layer_stats[iz]["visiblePoints"] += 1
                else:
                    layer_stats[iz]["invisiblePoints"] += 1
                    uncovered_indices.append(global_index)

                processed += 1
                if on_progress and active_cells > 0 and processed % progress_batch == 0:
                    on_progress(int(processed * 100 / active_cells))

    for s in layer_stats:
        tp = s["totalPoints"]
        s["visibilityRatio"] = (s["visiblePoints"] / tp) if tp > 0 else 0.0

    elapsed_ms = (time.perf_counter() - started_at) * 1000.0
    covered_columns = int(np.sum(column_any_visible))
    covered_area_m2 = float(covered_columns * dx * dy)
    invisible_count = processed - visible_count
    logger.info(
        "Viewshed compute finish: activeCells=%d, processed=%d, visible=%d, invisible=%d, elapsedMs=%.2f",
        active_cells,
        processed,
        visible_count,
        invisible_count,
        elapsed_ms,
    )
    if on_progress:
        on_progress(100)

    return {
        "total": active_cells,
        "gridX": grid_x,
        "gridY": grid_y,
        "gridZ": grid_z,
        "stats": {
            "totalPoints": active_cells,
            "visiblePoints": visible_count,
            "invisiblePoints": invisible_count,
            "visibilityRatio": (visible_count / active_cells) if active_cells > 0 else 0.0,
            "stationCount": len(stations),
            "activeColumns": active_columns,
            "activeCells": active_cells,
            "coveredAreaM2": covered_area_m2,
            "bboxCells": bbox_cells,
        },
        "layerStats": layer_stats,
        "uncoveredIndices": uncovered_indices,
        "elapsedMs": elapsed_ms,
    }
