import { sessionStorageFailureMessage } from "./errors.js";

const groupKey = mutation => `${mutation.type}:${mutation.id || "global"}`;

// Remember dismissed groups until their retained operations are resolved.
// New failed autosaves update the existing group instead of reopening a toast.
export function createSessionConflictNotifications({ getQueue, show, resolve }) {
  const groups = new Map();
  const members = key => getQueue().conflicts.filter(item => groupKey(item) === key);
  const message = (mutation, error, count) =>
    `${sessionStorageFailureMessage(error, { mutationType: mutation.type, retained: true })}（共 ${count} 条）`;
  function reconcile() {
    for (const [key, group] of groups) {
      const count = members(key).length;
      if (!count) {
        group.element?.remove?.();
        groups.delete(key);
      } else {
        const text = group.element?.querySelector?.("[data-zion-session-conflict-message]");
        if (text) text.textContent = message(group.mutation, group.error, count);
      }
    }
  }
  function notify(mutation, error) {
    reconcile();
    const key = groupKey(mutation);
    if (groups.has(key)) {
      Object.assign(groups.get(key), { mutation, error });
      reconcile();
      return;
    }
    const group = { mutation, error, element: null };
    groups.set(key, group);
    group.element = show(
      `<span data-zion-session-conflict-message>${message(mutation, error, members(key).length)}</span>`,
      {
        type: "warning", duration: 12000, dismissible: true,
        actions: [{
          label: mutation.type === "tree" ? "放弃未保存目录改动并刷新"
            : mutation.type === "session" ? "放弃该会话未保存改动并刷新" : "放弃此次未保存操作并刷新",
          handler: async () => {
            const retained = members(key);
            getQueue().discardConflicts(retained.map(item => item.operationId));
            reconcile();
            await resolve(mutation);
          }
        }]
      }
    );
  }
  return { notify, reconcile, dispose() {
    for (const group of groups.values()) group.element?.remove?.();
    groups.clear();
  } };
}
