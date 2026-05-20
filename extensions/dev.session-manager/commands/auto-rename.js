export function registerSessionAutoRenameCommand(opts) {
  const zion = opts?.zion || window.zion;
  const loadDoc = opts?.loadDoc;

  const autoRenameInflight = new Set();
  const cleanAutoTitle = (raw) => {
    let t = String(raw || "");
    t = t.split("\n").find(x => String(x || "").trim().length > 0) || "";
    t = t.replace(/^\s*(title|session title)\s*[:：]\s*/i, "");
    t = t.replace(/^\s*标题\s*[:：]\s*/i, "");
    t = t.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "");
    t = t.replace(/\s+/g, " ").trim();
    t = t.replace(/^[\-–—:：#*]+/, "").replace(/[\-–—:：#*]+$/, "").trim();
    return t.trim();
  };

  return zion.commands.registerCommand("zion.sessions.autoRename", async (opts2) => {
    const id = opts2?.id || zion.state.get("sessions.currentId");
    if (!id) return false;
    if (autoRenameInflight.has(id)) return false;
    autoRenameInflight.add(id);
    try {
      const text = String(loadDoc?.(id) || "").trim();
      if (!text) return false;

      try {
        zion.notification?.show?.("正在生成会话标题…", { type: "info", duration: 1600 });
      } catch {}

      const runStream = zion?.llm?.runStream;
      if (typeof runStream !== "function") {
        try {
          zion.notification?.show?.("未找到大模型服务（zion.llm.runStream）", { type: "warning", duration: 2400 });
        } catch {}
        return false;
      }

      const excerpt = text.length > 6000 ? text.slice(0, 6000) : text;
      const messages = [
        {
          role: "system",
          content:
            "你是一个为笔记/会话自动生成标题的助手。输出一个简短自然的标题，避免引号与换行，不要输出任何解释。标题要尽量短，通常控制在一小段短语内。"
        },
        {
          role: "user",
          content: `请根据以下内容生成标题：\n\n${excerpt}`
        }
      ];

      let out = "";
      let err = null;
      await runStream({
        messages,
        tools: null,
        onToken: (tk) => {
          out += String(tk || "");
        },
        onEnd: () => {},
        onError: (e) => {
          err = e || new Error("LLM error");
        },
        runId: `autoRename-${Date.now()}`,
        sessionId: id,
        silentReasoning: true
      });
      if (err) throw err;

      const title = cleanAutoTitle(out);
      if (!title) {
        try { zion.notification?.show?.("未生成有效标题", { type: "warning", duration: 2000 }); } catch {}
        return false;
      }
      zion.commands.executeCommand("zion.sessions.rename", { id, title });
      try { zion.notification?.show?.(`已重命名为：${title}`, { type: "success", duration: 1800 }); } catch {}
      return true;
    } catch (e) {
      try {
        zion.notification?.show?.(`自动重命名失败：${e?.message || String(e)}`, { type: "error", duration: 3200 });
      } catch {}
      return false;
    } finally {
      autoRenameInflight.delete(id);
    }
  });
}
