from __future__ import annotations

import logging
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Dict, Literal, Optional

from app.core.column_mask_engine import run_column_mask_job
from app.models.grid_mask_models import ColumnMaskJobRequest

JobStatus = Literal["queued", "running", "done", "failed"]
logger = logging.getLogger("backend.mask_job_manager")


@dataclass
class MaskJobState:
    status: JobStatus = "queued"
    progress: int = 0
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    lock: threading.Lock = field(default_factory=threading.Lock)


class ColumnMaskJobManager:
    """格网柱掩膜计算：在线程池中执行，避免阻塞 FastAPI 事件循环（与 AnalysisJobManager 同思路）。"""

    def __init__(self, max_workers: int = 1) -> None:
        self._jobs: Dict[str, MaskJobState] = {}
        self._jobs_lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=max_workers)

    def create_job(self, req: ColumnMaskJobRequest) -> str:
        job_id = str(uuid.uuid4())
        state = MaskJobState(status="queued", progress=0)
        with self._jobs_lock:
            self._jobs[job_id] = state
        cells = req.gridX * req.gridY
        logger.info(
            "Queued column-mask job %s: grid=%dx%d 平面格点=%d dx=%.2f dy=%.2f 含裁剪=%s",
            job_id,
            req.gridX,
            req.gridY,
            cells,
            req.dx,
            req.dy,
            bool(req.clipMultiPolygonCoordinates),
        )
        self._executor.submit(self._run_job, job_id, req)
        return job_id

    def _run_job(self, job_id: str, req: ColumnMaskJobRequest) -> None:
        state = self._jobs[job_id]
        with state.lock:
            state.status = "running"
            state.progress = 1

        logger.info(
            "Column-mask job %s 工作线程已开始（正在计算柱掩膜，请稍候）",
            job_id,
        )

        progress_state = {"last_bucket": -1}

        def progress_cb(p: int) -> None:
            pct = min(99, int(p))
            bucket = pct // 10
            if bucket > progress_state["last_bucket"]:
                progress_state["last_bucket"] = bucket
                logger.info(
                    "Column-mask job %s 进度: %d%%（点在多边形内，大规模时此处会持续刷新）",
                    job_id,
                    pct,
                )
            with state.lock:
                state.progress = max(1, min(99, pct))

        try:
            result = run_column_mask_job(req, on_progress=progress_cb)
            with state.lock:
                state.result = result
                state.progress = 100
                state.status = "done"
            logger.info(
                "Column-mask job %s 完成: activeColumns=%s（前端即将拉取结果）",
                job_id,
                result.get("activeColumns"),
            )
        except Exception as exc:
            with state.lock:
                state.status = "failed"
                state.error = str(exc)
            logger.exception("Column-mask job %s failed: %s", job_id, exc)

    def get_status(self, job_id: str) -> Optional[Dict[str, Any]]:
        state = self._jobs.get(job_id)
        if not state:
            return None
        with state.lock:
            return {
                "jobId": job_id,
                "status": state.status,
                "progress": state.progress,
                "error": state.error,
            }

    def get_result(self, job_id: str) -> Optional[Dict[str, Any]]:
        state = self._jobs.get(job_id)
        if not state:
            return None
        with state.lock:
            return {
                "jobId": job_id,
                "status": state.status,
                "progress": state.progress,
                "result": state.result,
                "error": state.error,
            }
