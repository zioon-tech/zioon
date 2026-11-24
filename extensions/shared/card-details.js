import { hydrateRemoteAnnotations } from "../dev.session-manager/storage/remote.js";

export function lazyCardDetails(sessionId, kind, id) {
  const commands = window.zion?.commands;
  const item = commands?.executeCommand?.("zion.chatCards.getSessionAnnotations", sessionId)?.[kind]
    ?.find(item => String(item.id) === String(id));
  const reference = item?.bodyRef || item?.detailRef;
  if (!reference) return item?.detailHydratedRef || item?.bodyHydratedRef ? Promise.resolve(item) : null;
  return hydrateRemoteAnnotations({ [kind]: [item] }).then(annotations => {
    const full = annotations[kind][0];
    const latest = commands.executeCommand("zion.chatCards.getSessionAnnotations", sessionId)?.[kind]
      ?.find(current => String(current.id) === String(id));
    const latestReference = latest?.bodyRef || latest?.detailRef;
    if (!latest || (latestReference && latestReference !== reference)
      || (!latestReference && (latest.bodyHydratedRef || latest.detailHydratedRef) !== reference)) {
      throw new Error("卡片内容已变化，请重试。");
    }
    const merge = current => {
      if (current.id !== item.id || (current.bodyRef || current.detailRef) !== reference) return current;
      const { detailRef, detailSessionId, bodyRef, bodySessionId, bodyKind, bodyBytes, ...local } = current;
      return { ...full, ...local,
        ...(item.bodyRef ? { bodyHydratedRef: reference } : { detailHydratedRef: reference }),
        ...(item.bodyRef && item.detailRef ? { detailHydratedRef: item.detailRef } : {}),
        ...(kind === "tools" ? {
          ...(Object.hasOwn(full, "args") ? { args: full.args } : {}), result: full.result
        } : { text: full.text }) };
    };
    // Remove the reference from the metadata fallback as well as live widgets.
    const state = window.zion?.state;
    const meta = state?.get(`sessions.meta.${sessionId}`);
    if (meta?.annotations?.[kind]) state.set(`sessions.meta.${sessionId}`, {
      ...meta, annotations: { ...meta.annotations, [kind]: meta.annotations[kind].map(merge) }
    });
    commands.executeCommand("zion.chatCards.updateSessionAnnotations", {
      sessionId, updater: previous => ({
        ...previous, [kind]: (previous[kind] || []).map(merge)
      })
    });
    return full;
  });
}

export function showCardDetailError(error) {
  window.zion?.notification?.show?.(error?.message || "卡片详情加载失败，请重试。", { type: "error" });
}
