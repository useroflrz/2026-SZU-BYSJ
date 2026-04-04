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
