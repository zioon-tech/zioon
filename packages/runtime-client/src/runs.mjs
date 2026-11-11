/** Explicit resume input; callers must retain the waitId returned by run.waiting. */
export async function resumeRun(baseUrl, runId, {
  fetchImpl = globalThis.fetch, headers = {}, signal, ...request
} = {}) {
  const response = await fetchImpl(
    `${String(baseUrl).replace(/\/+$/, "")}/v1/runs/${encodeURIComponent(runId)}/resume`,
    { method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(request), signal }
  );
  const body = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(body?.error || `Runtime HTTP ${response.status}`), {
    statusCode: response.status, code: body?.code
  });
  return body;
}
