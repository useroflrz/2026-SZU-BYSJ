"""
3D GIS 可视域分析系统 - 后端API
FastAPI Hello World
"""

import logging

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.core.job_manager import AnalysisJobManager
from app.core.mask_job_manager import ColumnMaskJobManager
from app.models.analysis_models import (
    CreateAnalysisJobRequest,
    CreateAnalysisJobResponse,
    JobResultResponse,
    JobStatusResponse,
)
from app.models.grid_mask_models import (
    ColumnMaskJobRequest,
    ColumnMaskJobResultResponse,
    ColumnMaskJobStatusResponse,
    CreateColumnMaskJobResponse,
)

app = FastAPI(
    title="3D GIS 可视域分析系统 API",
    description="后端API服务",
    version="1.0.0"
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)
logger = logging.getLogger("backend.api")

job_manager = AnalysisJobManager(max_workers=1)
mask_job_manager = ColumnMaskJobManager(max_workers=1)

# 配置CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 生产环境应限制具体域名
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    """根路径 - Hello World"""
    return {
        "message": "Hello World from FastAPI!",
        "service": "3D GIS 可视域分析系统 - 后端API",
        "version": "1.0.0",
        "status": "running"
    }


@app.get("/api/v1/health")
async def health_check():
    """健康检查接口"""
    return {
        "status": "healthy",
        "service": "backend-api"
    }


@app.post("/api/v1/analysis/jobs", response_model=CreateAnalysisJobResponse)
async def create_analysis_job(payload: CreateAnalysisJobRequest):
    if not payload.stations:
        raise HTTPException(status_code=400, detail="stations cannot be empty")
    logger.info(
        "Received analysis request: stations=%d, grid=%dx%dx%d, params(maxDistance=%s, clearance=%s, los=%s-%s, progressBatchCells=%s)",
        len(payload.stations),
        payload.gridMeta.gridX,
        payload.gridMeta.gridY,
        payload.gridMeta.gridZ,
        payload.params.maxDistance,
        payload.params.clearance,
        payload.params.losSamplesMin,
        payload.params.losSamplesMax,
        payload.params.progressBatchCells,
    )
    job_id = job_manager.create_job(payload)
    logger.info("Analysis job created: jobId=%s", job_id)
    return {
        "jobId": job_id,
        "status": "queued",
    }


@app.get("/api/v1/analysis/jobs/{job_id}", response_model=JobStatusResponse)
async def get_analysis_job_status(job_id: str):
    status = job_manager.get_status(job_id)
    if not status:
        raise HTTPException(status_code=404, detail="job not found")
    return status


@app.get("/api/v1/analysis/jobs/{job_id}/result", response_model=JobResultResponse)
async def get_analysis_job_result(job_id: str):
    result = job_manager.get_result(job_id)
    if not result:
        raise HTTPException(status_code=404, detail="job not found")
    return result


@app.post("/api/v1/grid/column-mask/jobs", response_model=CreateColumnMaskJobResponse)
async def create_column_mask_job(payload: ColumnMaskJobRequest):
    cells = payload.gridX * payload.gridY
    logger.info(
        "HTTP 收到柱掩膜任务: grid=%dx%d 平面格点=%d 裁剪=%s",
        payload.gridX,
        payload.gridY,
        cells,
        "是" if payload.clipMultiPolygonCoordinates else "否（全柱有效）",
    )
    job_id = mask_job_manager.create_job(payload)
    return {"jobId": job_id, "status": "queued"}


@app.get(
    "/api/v1/grid/column-mask/jobs/{job_id}",
    response_model=ColumnMaskJobStatusResponse,
)
async def get_column_mask_job_status(job_id: str):
    status = mask_job_manager.get_status(job_id)
    if not status:
        raise HTTPException(status_code=404, detail="job not found")
    return status


@app.get(
    "/api/v1/grid/column-mask/jobs/{job_id}/result",
    response_model=ColumnMaskJobResultResponse,
)
async def get_column_mask_job_result(job_id: str):
    result = mask_job_manager.get_result(job_id)
    if not result:
        raise HTTPException(status_code=404, detail="job not found")
    return result


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

