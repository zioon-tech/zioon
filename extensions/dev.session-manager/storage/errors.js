function safeCode(value) {
  return typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/.test(value)
    ? value : null;
}

function diagnosticPath(value) {
  const path = String(value || "").split(/[?#]/)[0];
  if (!/^\/v1\/(?:workbench-state|sessions|runs)(?:\/|$)/.test(path)) return null;
  return path
    .replace(/(\/sessions\/)[^/]+/, "$1:sessionId")
    .replace(/(\/runs\/)[^/]+/, "$1:runId")
    .replace(/(\/tree\/folders\/)[^/]+/, "$1:folderId")
    .replace(/(\/kv\/)(?!sessions\.tagIndex$)[^/]+/, "$1:key")
    .slice(0, 200);
}

/** Keep response bodies on the Error, but never copy them into UI diagnostics. */
export function classifySessionStorageError(error) {
  const rawStatus = Number(error?.status || error?.statusCode);
  const status = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
    ? rawStatus : null;
  const code = safeCode(error?.code) || safeCode(error?.result?.code);
  let kind;
  if (code === "DELETE_OUTCOME_UNKNOWN") kind = "outcome-unknown";
  else if (code === "DELETE_NOT_SENT") kind = "not-sent";
  else if (code === "WORKBENCH_ACCESS_CHANGED") kind = "access-changed";
  else if (code === "INVALID_RESPONSE" || error?.name === "SessionStorageResponseError") kind = "invalid-response";
  else if (error?.result?.conflict === true || status === 409 || status === 412) kind = "conflict";
  else if (status === 401) kind = "unauthenticated";
  else if (status === 403) kind = "forbidden";
  else if (status === 413) kind = "too-large";
  else if (status === 426) kind = "upgrade-required";
  else if (status === 429) kind = "rate-limited";
  else if (status === 408 || code === "REQUEST_TIMEOUT" || error?.name === "AbortError") kind = "timeout";
  else if (status >= 500) kind = "service-unavailable";
  else if (status >= 400) kind = "rejected";
  else if (error?.name === "TypeError" || error?.name === "SessionStorageNetworkError") kind = "network";
  else kind = "unknown";
  const retryable = ["network", "timeout", "rate-limited", "service-unavailable", "invalid-response", "unknown"].includes(kind);
  const method = String(error?.method || "").toUpperCase();
  return {
    kind, status, code, retryable,
    method: ["GET", "PUT", "PATCH", "POST", "DELETE"].includes(method) ? method : null,
    path: diagnosticPath(error?.path)
  };
}

export function sessionStorageFailureMessage(error, {
  operation = "write", mutationType, retrying = false, retained = false, background = false
} = {}) {
  const issue = classifySessionStorageError(error);
  const target = mutationType === "tree" || mutationType === "folder-delete"
    ? "目录" : mutationType === "kv" ? "标签索引" : "会话";
  let message;
  switch (issue.kind) {
    case "outcome-unknown": message = "删除结果尚未确认。再次删除会核对同一笔操作，不会重复处理。"; break;
    case "not-sent": message = "删除尚未发送，请重试。"; break;
    case "access-changed": message = "账户或访问权限已变化，请重新进入工作台。"; break;
    case "unauthenticated": message = "登录状态已失效，请重新登录后再试。"; break;
    case "forbidden": message = "当前账户没有此操作的权限，请确认账户与访问权限。"; break;
    case "too-large": message = `${target}数据超过服务端大小限制，请减少内容后再保存。`; break;
    case "upgrade-required": message = "工作台版本与服务端不兼容，请更新工作台后再试。"; break;
    case "conflict":
      message = mutationType === "kv"
        ? "标签索引保存被服务端拒绝，请刷新后确认。"
        : `${target}存在保存冲突，其他操作可以继续。`;
      break;
    default:
      if (operation === "read") message = "暂时无法读取会话，请稍后重试。";
      else if (retrying && issue.retryable) message = background && mutationType === "kv"
        ? "标签同步暂时延迟，正在自动重试。"
        : `${target}尚未确认保存，正在自动重试。`;
      else message = `${target}尚未确认保存${issue.status ? `（HTTP ${issue.status}）` : ""}，请重试。`;
  }
  return message + (retained ? "未保存的改动已保留。" : "");
}
