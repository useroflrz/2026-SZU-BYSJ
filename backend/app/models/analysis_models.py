from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class StationInput(BaseModel):
    lon: float
    lat: float
    height: float


class GridMetaInput(BaseModel):
    gridX: int = Field(gt=0)
    gridY: int = Field(gt=0)
    gridZ: int = Field(gt=0)
    dx: float = Field(gt=0)
    dy: float = Field(gt=0)
    dz: float = Field(gt=0)
    zMinRel: float = 0.0
    originLon: float
    originLat: float
    originGroundHeight: float = 0.0
    groundHeights: List[float]
    # 与 groundHeights 同序 flat 索引 iy*gridX+ix，>0.5 表示参与分析；缺省或长度不符则全柱有效
    columnActive: Optional[List[float]] = None


class AnalysisParamsInput(BaseModel):
    maxDistance: float = Field(default=10000.0, gt=0)
    clearance: float = Field(default=3.0, ge=0)
    losSamplesMin: int = Field(default=8, ge=2)
    losSamplesMax: int = Field(default=40, ge=4)
    progressBatchCells: int = Field(default=10000, ge=1000)


class CreateAnalysisJobRequest(BaseModel):
    stations: List[StationInput]
    gridMeta: GridMetaInput
    params: AnalysisParamsInput = AnalysisParamsInput()


class CreateAnalysisJobResponse(BaseModel):
    jobId: str
    status: Literal["queued", "running", "done", "failed"]


class JobStatusResponse(BaseModel):
    jobId: str
    status: Literal["queued", "running", "done", "failed"]
    progress: int
    error: Optional[str] = None


class AnalysisResultPayload(BaseModel):
    total: int
    gridX: int
    gridY: int
    gridZ: int
    stats: dict
    layerStats: list
    uncoveredIndices: List[int]
    elapsedMs: float


class JobResultResponse(BaseModel):
    jobId: str
    status: Literal["queued", "running", "done", "failed"]
    progress: int
    result: Optional[AnalysisResultPayload] = None
    error: Optional[str] = None
