export function registerSessionAutoRenameCommand(opts) {
  const zion = opts?.zion || window.zion;
  const loadDoc = opts?.loadDoc;

  const autoRenameInflight = new Set();
  const TITLE_MAX_LENGTH = 36;
  const parseTitlePayload = (raw) => {
    const text = String(raw || "").trim();
    if (!text) return "";
    const withoutFence = text
      .replace(/^\s*```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
    const tryParse = (candidate) => {
      try {
        const parsed = JSON.parse(candidate);
        const title = parsed && typeof parsed === "object" ? (parsed.title ?? parsed.name) : "";
        return typeof title === "string" ? title : "";
      } catch {
        return "";
      }
    };
    const direct = tryParse(withoutFence);
    if (direct) return direct;
    const match = withoutFence.match(/\{[\s\S]*?\}/);
    return match ? tryParse(match[0]) : "";
  };
  const looksLikeAnswer = (title) => {
    const t = String(title || "").trim();
    if (!t) return true;
    if (Array.from(t).length > TITLE_MAX_LENGTH) return true;
    if (/[。！？!?]\s*.+/.test(t)) return true;
    return /^(当然|可以|好的|首先|其次|以下|这里|这是|这个问题|答案|建议|Sure|Certainly|Here|You can|To )/i.test(t);
  };
  const cleanAutoTitle = (raw) => {
    let t = parseTitlePayload(raw);
    if (!t) t = String(raw || "").split("\n").find(x => String(x || "").trim().length > 0) || "";
    t = t.replace(/^\s*(title|session title)\s*[:：]\s*/i, "");
    t = t.replace(/^\s*(name|session name)\s*[:：]\s*/i, "");
    t = t.replace(/^\s*标题\s*[:：]\s*/i, "");
    t = t.replace(/^\s*会话名\s*[:：]\s*/i, "");
    t = t.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "");
    t = t.replace(/\s+/g, " ").trim();
    t = t.replace(/^[\-–—:：#*]+/, "").replace(/[\-–—:：#*]+$/, "").trim();
    if (looksLikeAnswer(t)) return "";
    return t.trim();
  };

  return zion.commands.registerCommand("zion.sessions.autoRename", async (opts2) => {
    const id = opts2?.id || zion.state.get("sessions.currentId");
    if (!id) return false;
    if (zion.state.get(`sessions.deleted.${id}`) === true
      || zion.state.get(`sessions.deleting.${id}`) === true) return false;
    const silent = !!opts2?.silent;
    if (autoRenameInflight.has(id)) return false;
    if (opts2?.onlyIfAuto) {
      const meta = zion.commands.executeCommand("zion.sessions.getMeta", id);
      if (!meta || meta.titleAuto !== true) return false;
    }
    autoRenameInflight.add(id);
    try {
      const text = String(loadDoc?.(id) || "").trim();
      if (!text) return false;

      if (!silent) {
        try {
          zion.notification?.show?.("正在生成会话标题…", { type: "info", duration: 1600 });
        } catch {}
      }

      const runStream = zion?.llm?.runStream;
      if (typeof runStream !== "function") {
        if (!silent) {
          try {
            zion.notification?.show?.("未找到大模型服务（zion.llm.runStream）", { type: "warning", duration: 2400 });
          } catch {}
        }
        return false;
      }

      const excerpt = text.length > 6000 ? text.slice(0, 6000) : text;
      const messages = [
        {
          role: "system",
          content:
            [
              "你是会话标题生成器，不是聊天助手。",
              "任务：只根据用户提供的会话内容生成一个会话名。",
              "禁止：不要回答会话里的问题，不要给建议，不要解释，不要复述内容，不要输出 Markdown。",
              "标题要求：2-18 个中文字符或 2-8 个英文单词；短、具体、像文件/会话标题；不要引号；不要句号。",
              "如果内容是在提问，也要概括主题，而不是回答问题。",
              "必须只输出一行严格 JSON，格式为：{\"title\":\"会话名\"}"
            ].join("\n")
        },
        {
          role: "user",
          content:
            [
              "为下面的会话生成会话名。",
              "再次强调：不要回答会话内容，只返回 JSON。",
              "",
              "<conversation>",
              excerpt,
              "</conversation>"
            ].join("\n")
        }
      ];

      let out = "";
      let err = null;
      const sourceRun = zion.state.get(`chat.runs.${id}`);
      const activeModel = opts2?.activeModel || sourceRun?.model
        || zion.state.get("chat.activeModel") || null;
      await runStream({
        messages,
        activeModel,
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
        requestSource: "session-auto-rename",
        silentReasoning: true
      });
      if (err) throw err;
      if (zion.state.get(`sessions.deleted.${id}`) === true
        || zion.state.get(`sessions.deleting.${id}`) === true) return false;

      const title = cleanAutoTitle(out);
      if (!title) {
        if (!silent) {
          try { zion.notification?.show?.("未生成有效标题", { type: "warning", duration: 2000 }); } catch {}
        }
        return false;
      }
      if (opts2?.onlyIfAuto) {
        const meta = zion.commands.executeCommand("zion.sessions.getMeta", id);
        if (!meta || meta.titleAuto !== true) return false;
      }
      if (await zion.commands.executeCommand("zion.sessions.rename", { id, title }) === false) return false;
      if (!silent) {
        try { zion.notification?.show?.(`已重命名为：${title}`, { type: "success", duration: 1800 }); } catch {}
      }
      return true;
    } catch (e) {
      if (!silent) {
        try {
          zion.notification?.show?.(`自动重命名失败：${e?.message || String(e)}`, { type: "error", duration: 3200 });
        } catch {}
      }
      return false;
    } finally {
      autoRenameInflight.delete(id);
    }
  });
}
