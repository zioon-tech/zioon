import { isReceivedNode } from "./shared-view.js";

/** Save the private session before transferring it, then refresh the authoritative
 * private catalog and restore any editor that was displaying the old document. */
export function createSharedSessionMover({ zion, getZion = () => zion, view, moveOwn, isOwnSession, refreshOwn, getRevision }) {
  const pending = new Map();
  return (id, parent) => {
    if (isReceivedNode(id)) {
      return isReceivedNode(parent) ? view.mutate(id, { action: "move", parentId: parent }) : false;
    }
    if (!isReceivedNode(parent)) return moveOwn(id, parent);
    if (!isOwnSession(id)) return false;
    if (pending.has(id)) return pending.get(id);
    const operation = (async () => {
      try {
        const zion = getZion();
        if (!zion?.commands?.executeCommand) throw new Error("工作台正在准备，请稍后重新拖入");
        view.setMoving?.(id, parent, true);
        const panels = (zion.panels?.listEditors?.() || []).filter(entry => entry.sessionId === id);
        const wasCurrent = zion.state?.get?.("sessions.currentId") === id;
        if (await zion.commands.executeCommand("zion.sessions.flushRunInput", id) !== true
          || await zion.commands.executeCommand("zion.sessions.flushPendingSave", id) !== true) {
          throw new Error("会话尚未保存成功，请稍后重新拖入");
        }
        const revision = getRevision(id);
        const receivedId = await view.mutate(parent, { action: "importDocument", sourceDocumentId: id,
          ...(Number.isSafeInteger(revision) ? { sourceRevision: revision } : {}) });
        await refreshOwn();
        for (const panel of panels) await zion.panels.openSession?.(panel.panelId, receivedId, {
          focus: wasCurrent, forceReload: true, skipPersistPrevious: true
        });
        if (wasCurrent && !panels.length) await zion.commands.executeCommand("zion.sessions.switch", {
          id: receivedId, forceReload: true, skipPersistPrevious: true
        });
        return true;
      } catch (error) {
        view.reportError(error);
        return false;
      } finally {
        view.setMoving?.(id, parent, false);
      }
    })();
    pending.set(id, operation);
    void operation.finally(() => pending.delete(id));
    return operation;
  };
}
