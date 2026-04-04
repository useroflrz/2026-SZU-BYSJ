from __future__ import annotations

import logging
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Dict, Literal, Optional

from app.core.viewshed_engine import run_grid_viewshed_analysis
from app.models.analysis_models import CreateAnalysisJobRequest

JobStatus = Literal["queued", "running", "done", "failed"]
logger = logging.getLogger("backend.job_manager")


@dataclass
class JobState:
    status: JobStatus = "queued"
    progress: int = 0
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    lock: threading.Lock = field(default_factory=threading.Lock)


class AnalysisJobManager:
    def __init__(self, max_workers: int = 1) -> None:
        self._jobs: Dict[str, JobState] = {}
        self._jobs_lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=max_workers)

    def create_job(self, req: CreateAnalysisJobRequest) -> str:
        job_id = str(uuid.uuid4())
        state = JobState(status="queued", progress=0)
        with self._jobs_lock:
            self._jobs[job_id] = state

        logger.info(
            "Queued job %s: stations=%d, grid=%dx%dx%d",
            job_id,
            len(req.stations),
            req.gridMeta.gridX,
            req.gridMeta.gridY,
            req.gridMeta.gridZ,
        )
        self._executor.submit(self._run_job, job_id, req)
        return job_id

    def _run_job(self, job_id: str, req: CreateAnalysisJobRequest) -> None:
        state = self._jobs[job_id]
        with state.lock:
            state.status = "running"
            state.progress = 1

        logger.info("Job %s started", job_id)
        progress_state = {"last_bucket": -1}

        def progress_cb(p: int) -> None:
            bucket = int(p) // 10
            if bucket > progress_state["last_bucket"]:
                progress_state["last_bucket"] = bucket
                logger.info("Job %s progress: %d%%", job_id, int(p))
            with state.lock:
                state.progress = max(1, min(100, int(p)))

        try:
            result = run_grid_viewshed_analysis(
                stations=req.stations,
                grid_meta=req.gridMeta,
                params=req.params,
                on_progress=progress_cb,
            )
            with state.lock:
                state.result = result
                state.progress = 100
                state.status = "done"
            logger.info(
                "Job %s done: visible=%s/%s, elapsedMs=%.2f",
                job_id,
                result.get("stats", {}).get("visiblePoints"),
                result.get("total"),
                float(result.get("elapsedMs", 0.0)),
            )
        except Exception as exc:
            with state.lock:
                state.status = "failed"
                state.error = str(exc)
            logger.exception("Job %s failed: %s", job_id, exc)

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
