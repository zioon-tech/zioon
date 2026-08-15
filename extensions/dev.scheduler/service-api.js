function readBaseUrl() {
  const stateValue = window.zion?.state?.get?.("localTools.baseUrl");
  if (typeof stateValue === "string" && stateValue.trim()) return stateValue.trim().replace(/\/$/, "");
  try {
    const stored = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl");
    if (stored) return stored.replace(/\/$/, "");
  } catch {}
  return "http://127.0.0.1:8765";
}

async function request(path, options = {}) {
  const response = await fetch(`${readBaseUrl()}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.detail || `Scheduler service HTTP ${response.status}`);
  return data;
}

function taskPayload(task) {
  return {
    taskType: task.taskType || "agent",
    title: task.title,
    prompt: task.prompt || "",
    command: task.command || "",
    cwd: task.cwd || "",
    note: task.note || "",
    schedule: {
      ...task.schedule,
      timeZone: task.schedule?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
      misfirePolicy: task.schedule?.misfirePolicy || "run-once",
      overlapPolicy: "forbid"
    },
    capability: task.capability,
    timeoutSeconds: task.timeoutSeconds,
    enabled: task.enabled,
    clientTaskId: task.id
  };
}

export class SchedulerServiceClient {
  async listTasks() {
    return (await request("/scheduler/tasks"))?.tasks || [];
  }

  async createTask(task) {
    return request("/scheduler/tasks", { method: "POST", body: JSON.stringify(taskPayload(task)) });
  }

  async updateTask(task) {
    return request(`/scheduler/tasks/${encodeURIComponent(task.remoteTaskId)}`, {
      method: "PUT",
      body: JSON.stringify({ revision: task.remoteRevision, ...taskPayload(task) })
    });
  }

  async deleteTask(task) {
    if (!task.remoteTaskId) return;
    await request(`/scheduler/tasks/${encodeURIComponent(task.remoteTaskId)}`, { method: "DELETE" });
  }

  async runNow(task) {
    return request(`/scheduler/tasks/${encodeURIComponent(task.remoteTaskId)}/run`, { method: "POST" });
  }

  async listRuns(taskId = "", { limit = 50, offset = 0, includeDetails = false } = {}) {
    const query = new window.URLSearchParams({
      limit: String(Math.max(1, Math.min(200, Number(limit) || 50))),
      offset: String(Math.max(0, Number(offset) || 0)),
      include_details: includeDetails ? "true" : "false"
    });
    if (taskId) query.set("task_id", taskId);
    return (await request(`/scheduler/runs?${query.toString()}`))?.runs || [];
  }

  async getRun(runId) {
    const run = await request(`/scheduler/runs/${encodeURIComponent(runId)}`);
    return run ? { ...run, isSummary: false } : null;
  }

  async claim(workerId, availableTools = []) {
    return (await request("/scheduler/runs/claim", {
      method: "POST",
      body: JSON.stringify({ workerId, leaseSeconds: 600, availableTools })
    }))?.run || null;
  }

  async appendEvent(runId, workerId, event) {
    return request(`/scheduler/runs/${encodeURIComponent(runId)}/events`, {
      method: "POST",
      body: JSON.stringify({ workerId, event })
    });
  }

  async cancel(runId, reason = "user") {
    return request(`/scheduler/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason })
    });
  }

  async complete(runId, workerId, result) {
    return request(`/scheduler/runs/${encodeURIComponent(runId)}/complete`, {
      method: "POST",
      body: JSON.stringify({ workerId, ...result })
    });
  }

  async executeCommand({ command, cwd = "", timeoutSeconds = 300 } = {}) {
    return request("/bash", {
      method: "POST",
      body: JSON.stringify({
        command,
        cwd,
        timeout: Math.max(10, Math.min(3600, Number(timeoutSeconds) || 300)) * 1000
      })
    });
  }
}
