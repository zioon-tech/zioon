import type { NotificationOptions } from "../notification/manager";

export type ReloadPreparation = {
  status: "ready" | "pending" | "blocked";
  reason?: string;
};

export type ReloadPreparationContext = {
  detailed: true;
  timeoutMs: number;
  isCancelled(): boolean;
  requestToken: object;
};

const blockedMessages: Record<string, string> = {
  conflict: "会话存在保存冲突，已取消重新加载。请处理冲突后重试，未保存的改动仍在当前页面。",
  unauthenticated: "登录状态已失效，已取消重新加载。请重新登录后重试，未保存的改动仍在当前页面。",
  forbidden: "当前账户没有保存权限，已取消重新加载。请确认权限后重试。",
  "access-changed": "账户或访问权限已变化，已取消重新加载。请重新进入工作台。",
  "too-large": "会话数据超过保存大小限制，已取消重新加载。请减少内容后重试。",
  "upgrade-required": "工作台版本与服务端不兼容，保存尚未确认，已取消重新加载。",
  rejected: "服务端拒绝了保存，已取消重新加载。未保存的改动仍在当前页面。"
};

function waitingMessage(reason?: string): string {
  if (reason === "network" || reason === "timeout" || reason === "service-unavailable" || reason === "rate-limited") {
    return "保存暂未成功，正在重试；成功后将自动重新加载。";
  }
  if (reason === "editing") return "检测到新的改动，正在保存；完成后将自动重新加载。";
  return "正在保存会话，完成后将自动重新加载。";
}

/** One user request owns the wait and navigation. Cancelling never cancels a save. */
export function createWorkbenchReloadController({
  prepare,
  persistWorkspace,
  setPreparing,
  setIntentionalReload,
  reload,
  notify,
  timeoutMs = 30_000,
  retryMs = 1000,
  progressDelayMs = 300,
  now = () => Date.now()
}: {
  prepare(context: ReloadPreparationContext): Promise<ReloadPreparation | boolean>;
  persistWorkspace(): void;
  setPreparing(value: boolean): void;
  setIntentionalReload(value: boolean): void;
  reload(): void;
  notify(message: string, options: NotificationOptions): { remove(): void };
  timeoutMs?: number;
  retryMs?: number;
  progressDelayMs?: number;
  now?: () => number;
}) {
  let active: Promise<boolean> | null = null;
  let stopActive: (() => void) | null = null;
  let navigated = false;
  let cancelBeforeStart = false;

  function request(): Promise<boolean> {
    if (active) return active;
    if (navigated) return Promise.resolve(true);
    active = Promise.resolve().then(async () => {
      const requestToken = {};
      const deadline = now() + timeoutMs;
      let stopped: "cancelled" | "timeout" | null = null;
      let settleStop!: () => void;
      const stopPromise = new Promise<void>(resolve => { settleStop = resolve; });
      const stop = (reason: "cancelled" | "timeout") => {
        if (stopped || navigated) return;
        stopped = reason;
        settleStop();
      };
      stopActive = () => stop("cancelled");
      if (cancelBeforeStart) {
        cancelBeforeStart = false;
        stop("cancelled");
      }
      const timeoutId = setTimeout(() => stop("timeout"), timeoutMs);
      const progressNotice: { current: { remove(): void } | null } = { current: null };
      let noticeMessage = "";
      let pendingReason: string | undefined;
      const showProgress = () => {
        if (stopped || navigated) return;
        const message = waitingMessage(pendingReason);
        if (noticeMessage === message) return;
        progressNotice.current?.remove();
        noticeMessage = message;
        progressNotice.current = notify(message, {
          type: "info", duration: 0, dismissible: false,
          actions: [{ label: "取消重新加载", handler: () => stop("cancelled") }]
        });
      };
      let progressVisible = false;
      const progressId = setTimeout(() => {
        progressVisible = true;
        showProgress();
      }, progressDelayMs);
      const failure = (message: string) => {
        notify(message, {
          type: "warning", duration: 10_000,
          actions: [{ label: "重试重新加载", handler: () => { void request(); } }]
        });
        return false;
      };
      try {
        setIntentionalReload(false);
        setPreparing(true);
        persistWorkspace();
        while (!stopped && now() < deadline) {
          const result = await Promise.race([
            Promise.resolve().then(() => prepare({
              detailed: true,
              timeoutMs: Math.min(5000, Math.max(1, deadline - now())),
              isCancelled: () => stopped !== null,
              requestToken
            })),
            stopPromise.then(() => null)
          ]);
          if (stopped || now() >= deadline) break;
          const readiness: ReloadPreparation = result === true
            ? { status: "ready" }
            : result === false || result == null
              ? { status: "pending" } : result;
          if (readiness.status === "blocked") {
            return failure(blockedMessages[readiness.reason || ""]
              || "会话尚未确认保存，已取消重新加载。未保存的改动仍在当前页面。");
          }
          if (readiness.status === "ready") {
            // Capture layout changes made while waiting, immediately before navigation.
            persistWorkspace();
            setIntentionalReload(true);
            reload();
            navigated = true;
            return true;
          }
          pendingReason = readiness.reason;
          if (progressVisible) showProgress();
          let retryId: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            new Promise<void>(resolve => {
              // A new edit needs another save check, not network backoff.
              retryId = setTimeout(resolve, pendingReason === "editing" ? Math.min(25, retryMs) : retryMs);
            }),
            stopPromise
          ]).finally(() => clearTimeout(retryId));
        }
        if (stopped === "cancelled") {
          notify("已取消重新加载，保存会继续进行。", { type: "info", duration: 3000 });
          return false;
        }
        return failure("保存确认超时，已取消重新加载。未保存的改动仍在当前页面，可重试或查看保存状态。");
      } catch (error) {
        console.error("[zion] failed to prepare session storage for reload", error);
        setIntentionalReload(false);
        return failure("保存未完成，已取消重新加载。未保存的改动仍在当前页面，请重试。");
      } finally {
        // Stop an old preparation from doing further work after its request finishes.
        stopped ||= "cancelled";
        settleStop();
        clearTimeout(timeoutId);
        clearTimeout(progressId);
        progressNotice.current?.remove();
        stopActive = null;
        setPreparing(false);
        active = null;
      }
    });
    return active;
  }

  return {
    request,
    cancel() {
      if (stopActive) stopActive();
      else if (active) cancelBeforeStart = true;
    }
  };
}
