export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
export async function request<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, 22000);
  try {
    const response = await fetch(path, {
      credentials: "same-origin", redirect: "error", signal: controller.signal,
      method: options.method || "GET", headers: { accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(data.error || "请求未完成，请稍后重试", response.status, data.code);
    return data as T;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
export const runtimePath = (path: string) => "/api/runtime" + path;
export const login = (returnTo = location.pathname + location.search) => {
  location.assign("/api/auth/login?" + new URLSearchParams({ returnTo }));
};
