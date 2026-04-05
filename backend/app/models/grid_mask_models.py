from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field

# GeoJSON MultiPolygon coordinates: list[polygon], polygon = [outer_ring, *hole_rings], ring = [[lon,lat],...]
MultiPolygonCoords = List[List[List[List[float]]]]


class ColumnMaskJobRequest(BaseModel):
    """与前端 showBeiDouGrid 一致的边界与格距；gridX/gridY 由前端算出以保证与地形采样一致。"""

    minLon: float
    minLat: float
    maxLon: float
    maxLat: float
    dx: float = Field(gt=0)
    dy: float = Field(gt=0)
    gridX: int = Field(gt=0)
    gridY: int = Field(gt=0)
    # 缺省或 null：全柱有效（全 1）
    clipMultiPolygonCoordinates: Optional[MultiPolygonCoords] = None


class CreateColumnMaskJobResponse(BaseModel):
    jobId: str
    status: Literal["queued", "running", "done", "failed"]


class ColumnMaskResultPayload(BaseModel):
    gridX: int
    gridY: int
    activeColumns: int
    # float32 little-endian 的 base64，长度 = gridX*gridY*4 字节
    columnActiveB64: str


class ColumnMaskJobResultResponse(BaseModel):
    jobId: str
    status: Literal["queued", "running", "done", "failed"]
    progress: int
    result: Optional[ColumnMaskResultPayload] = None
    error: Optional[str] = None


class ColumnMaskJobStatusResponse(BaseModel):
    jobId: str
    status: Literal["queued", "running", "done", "failed"]
    progress: int
    error: Optional[str] = None
