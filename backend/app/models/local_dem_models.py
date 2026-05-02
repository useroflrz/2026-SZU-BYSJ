from __future__ import annotations

from pydantic import BaseModel


class LocalDemSampleResponse(BaseModel):
    gridX: int
    gridY: int
    totalColumns: int
    sampledColumns: int
    originGroundHeight: float
    groundHeightsB64: str
