const BASE_URL = 'http://localhost:8000'

async function requestJson(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`HTTP ${response.status}: ${text || response.statusText}`)
  }
  return response.json()
}

export function createGridViewshedJob(payload) {
  return requestJson('/api/v1/analysis/jobs', {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export function getGridViewshedJobStatus(jobId) {
  return requestJson(`/api/v1/analysis/jobs/${jobId}`)
}

export function getGridViewshedJobResult(jobId) {
  return requestJson(`/api/v1/analysis/jobs/${jobId}/result`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createColumnMaskJob(payload) {
  return requestJson('/api/v1/grid/column-mask/jobs', {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export function getColumnMaskJobStatus(jobId) {
  return requestJson(`/api/v1/grid/column-mask/jobs/${jobId}`)
}

export function getColumnMaskJobResult(jobId) {
  return requestJson(`/api/v1/grid/column-mask/jobs/${jobId}/result`)
}

/**
 * 提交柱掩膜任务并轮询直到完成（await 之间主线程可处理交互）
 */
export async function runColumnMaskJobAndWait(payload, pollMs = 300) {
  const created = await createColumnMaskJob(payload)
  const jobId = created.jobId
  let status = created.status
  while (status === 'queued' || status === 'running') {
    await sleep(pollMs)
    const s = await getColumnMaskJobStatus(jobId)
    status = s.status
  }
  const resultResp = await getColumnMaskJobResult(jobId)
  if (resultResp.status !== 'done' || !resultResp.result) {
    throw new Error(resultResp.error || 'column mask job failed')
  }
  return resultResp.result
}

export async function sampleLocalDemGrid(payload, demFile) {
  if (!demFile) {
    throw new Error('DEM tif 文件未选择')
  }
  const formData = new FormData()
  formData.append('demFile', demFile)
  Object.entries(payload || {}).forEach(([k, v]) => {
    if (v === null || v === undefined) return
    formData.append(k, String(v))
  })

  const response = await fetch(`${BASE_URL}/api/v1/grid/local-dem/sample`, {
    method: 'POST',
    body: formData
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`HTTP ${response.status}: ${text || response.statusText}`)
  }
  return response.json()
}
