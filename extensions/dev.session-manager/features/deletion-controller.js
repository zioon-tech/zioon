import { sessionStorageFailureMessage } from "../storage/errors.js";

export function createSessionDeletionController(zion) {
  let active = null;
  const publish = value => zion?.state?.set?.("sessions.deletion", value);

  return {
    run({ targets, sessionIds = [], execute }) {
      if (!targets.length) return Promise.resolve(false);
      const key = targets.map(item => `${item.type}:${item.id}`).sort().join("|");
      if (active) {
        if (active.key === key) return active.promise;
        zion?.notification?.show?.("正在删除会话，请等待当前操作完成。", { type: "info", duration: 3000 });
        return Promise.resolve(false);
      }
      const ids = [...new Set(sessionIds)];
      const state = {
        pending: true, status: "pending", completed: 0, total: targets.length,
        ids, targets, error: null
      };
      const notification = zion?.notification?.show?.("正在删除…", {
        type: "info", duration: 0, dismissible: false
      });
      const updateNotification = () => {
        const message = notification?.firstElementChild?.firstElementChild?.lastElementChild;
        if (message) message.textContent = `正在删除 ${state.completed}/${state.total}…`;
      };
      for (const id of ids) zion?.state?.set?.(`sessions.deleting.${id}`, true);
      publish({ ...state });
      const progress = count => {
        state.completed = count;
        publish({ ...state });
        updateNotification();
      };
      const promise = Promise.resolve().then(() => execute(progress)).then(ok => {
        if (ok === false) throw new Error("删除未完成，未删除的会话已保留。");
        state.status = "done";
        zion?.notification?.show?.(
          targets.length === 1 ? "已删除。" : `已删除 ${targets.length} 项。`,
          { type: "success", duration: 3000 }
        );
        return true;
      }).catch(error => {
        const uncertain = error?.code === "DELETE_OUTCOME_UNKNOWN";
        state.status = uncertain ? "unconfirmed" : "failed";
        state.error = error?.message || String(error);
        const message = sessionStorageFailureMessage(error, { mutationType: "delete", retained: !uncertain });
        zion?.notification?.show?.(
          uncertain ? `已确认 ${state.completed}/${state.total} 项。${message}`
            : `删除未完成，已确认 ${state.completed}/${state.total} 项。${message}`,
          { type: uncertain ? "warning" : "error", duration: 12000, dismissible: true }
        );
        return false;
      }).finally(() => {
        if (notification) {
          if (zion?.notification?.dismiss) zion.notification.dismiss(notification);
          else notification.remove?.();
        }
        for (const id of ids) zion?.state?.set?.(`sessions.deleting.${id}`, false);
        state.pending = false;
        publish({ ...state });
        active = null;
      });
      active = { key, promise };
      return promise;
    }
  };
}
