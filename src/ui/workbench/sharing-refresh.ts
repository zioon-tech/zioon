import { useEffect, useRef } from "react";

type Subscription = { dispose(): void } | (() => void) | void;
export function subscribeSharingContentChanges(refresh: () => void) {
  const subscriptions: Subscription[] = [
    window.zion?.state?.onDidChange?.("sessions.treeMem", refresh),
    window.zion?.state?.onDidChange?.("sessions.catalog", refresh),
    window.zion?.events?.on?.("sharing/changed", refresh)
  ];
  return () => subscriptions.forEach(subscription => {
    if (typeof subscription === "function") subscription(); else subscription?.dispose();
  });
}

/** Refresh in place, keeping open selections, focus and unfinished permission edits. */
export function useSharingRefresh(refresh: () => void, enabled = true) {
  const latest = useRef({ refresh, enabled });
  latest.current = { refresh, enabled };
  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      if (document.visibilityState !== "hidden" && latest.current.enabled) latest.current.refresh();
    };
    const invalidate = () => { clearTimeout(debounce); debounce = setTimeout(run, 200); };
    const unsubscribe = subscribeSharingContentChanges(invalidate);
    const timer = setInterval(run, 15000);
    document.addEventListener("visibilitychange", invalidate);
    return () => {
      clearTimeout(debounce); clearInterval(timer); unsubscribe();
      document.removeEventListener("visibilitychange", invalidate);
    };
  }, []);
}
