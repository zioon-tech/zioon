import { runStream } from "./chat-service.js";
import { deepseekProvider } from "./deepseek-provider.js";
import { userModelsProvider } from "./user-models-provider.js";
import { installModelSwitcher } from "./model-switcher.js";
import { registerModelsTools } from "./models-tools.js";

export async function activate(ctx) {
  // 注册模型提供者
  const dispProv = window.zion.models.registerProvider(deepseekProvider);
  ctx.subscriptions.push(dispProv);

  const dispUserProv = window.zion.models.registerProvider(userModelsProvider);
  ctx.subscriptions.push(dispUserProv);

  // 模型目录与激活模型状态
  async function refreshCatalog() {
    try {
      const ids = window.zion.models.listProviders() || [];
      const models = [];
      for (const pid of ids) {
        const prov = window.zion.models.getProvider(pid);
        if (!prov) continue;
        const list = await prov.list();
        for (const m of (list || [])) {
          models.push({ providerId: pid, id: m.id, label: m.label || m.id });
        }
      }
      window.zion.state.set("models.catalog", models);
    } catch (e) {
      console.warn("[langchain-chat] refreshCatalog error", e);
    }
  }
  function ensureActiveModel() {
    const active = window.zion.state.get("chat.activeModel");
    if (!active) {
      window.zion.state.set("chat.activeModel", { providerId: "deepseek", modelId: "deepseek-chat", label: "DeepSeek Chat" });
    }
  }
  await refreshCatalog();
  ensureActiveModel();

  // 模型切换器装饰器（挂载面板）
  let modelSwitcher = null;
  const decSwitcher = window.zion.editor.registerDecorator({
    id: "dev.langchain-chat.model-switcher",
    apply(editor) {
      modelSwitcher = installModelSwitcher();
      return { dispose() { modelSwitcher?.dispose?.(); modelSwitcher = null; } };
    }
  });
  ctx.subscriptions.push(decSwitcher);

  // 工具函数
  const getEd = () => window.zion?.window?.activeEditor;

  // 每会话运行状态 helpers
  const getSessionId = () => window.zion?.state?.get("sessions.currentId");
  const getRunState = (sid) => window.zion?.state?.get(`chat.runs.${sid}`) || null;
  const setRunState = (sid, patch) => {
    const cur = getRunState(sid) || {};
    window.zion.state.set(`chat.runs.${sid}`, { ...cur, ...patch });
  };
  // 简易工具执行器：支持外部注册与内置示例
  async function executeToolCall(call, sid) {
    const isAborted = () => !!getRunState(sid)?.aborted;

    // 立刻检查全局中断标志
    if (isAborted()) {
      return `Tool "${call.name}" execution aborted`;
    }

    // 优先使用状态总线里的处理器：{ [name]: (args) => Promise<string> | string }
    const handlers = window.zion?.state?.get("chat.toolHandlers") || {};
    if (handlers && typeof handlers[call.name] === "function") {
      try {
        const out = await handlers[call.name](call.args);
        // 再次检查中断，避免在 handler 返回后继续处理
        if (isAborted()) {
          return `Tool "${call.name}" execution aborted`;
        }
        return typeof out === "string" ? out : JSON.stringify(out);
      } catch (e) {
        // 若已中断，优先返回中断信息
        if (isAborted()) return `Tool "${call.name}" execution aborted`;
        return `Tool "${call.name}" error: ${e?.message || String(e)}`;
      }
    }

    // 内置示例（同步/轻量异步逻辑）
    try {
      // 在耗时或可能抛错的逻辑处也确保检查中断（尽量快速返回）
      switch (call.name) {
        case "echo":
          return typeof call.args === "string" ? call.args : JSON.stringify(call.args);
        case "sum":
          if (isAborted()) return `Tool "${call.name}" execution aborted`;
          if (Array.isArray(call.args?.numbers)) {
            const s = call.args.numbers.reduce((a, b) => a + Number(b || 0), 0);
            return String(s);
          }
          return "Invalid args for sum: expected { numbers: number[] }";
        case "calculate":
          if (isAborted()) return `Tool "${call.name}" execution aborted`;
          if (call.args?.expression) {
            // 极简演示：仅允许数字与 + - * / ()
            const expr = String(call.args.expression);
            if (!/^[\d\+\-\*\/\.\(\)\s]+$/.test(expr)) return "Unsafe expression";
            // eslint-disable-next-line no-eval
            const res = eval(expr);
            return String(res);
          }
          return "Invalid args for calculate: expected { expression: string }";
        default:
          return `Unknown tool: ${call.name}`;
      }
    } catch (e) {
      if (isAborted()) return `Tool "${call.name}" execution aborted`;
      return `Tool "${call.name}" failed: ${e?.message || String(e)}`;
    }
  }

  // 通用运行逻辑（含 Tool Calls 链式继续）
  const doRun = async (opts = {}) => {
    const ed = getEd();
    if (!ed) {
      console.log("[langchain-chat] no active editor");
      return;
    }
    // 确保已选择激活模型
    ensureActiveModel();
    const sid = getSessionId();
    const streaming = !!getRunState(sid)?.streaming;
    if (streaming) {
      console.log("[langchain-chat] already streaming in current session, abort");
      return; // 防止本会话并发；其他会话不受影响
    }

    // 1. 获取当前光标位置
    const cursor = ed.getCursor();

    // 2. 组装 messages：从文档开始到光标位置的所有内容
    const fullDoc = ed.getValue();
    const lines = fullDoc.split("\n");
    const cursorLine = cursor.line;
    const contentBeforeCursor = lines.slice(0, cursorLine + 1).join("\n");

    // 解析角色块
    const baseMessages = parseMessages(contentBeforeCursor);
    if (baseMessages.length === 0) {
      window.zion.events.emit("chat/runError", { error: "No content to send" });
      console.log("[langchain-chat] no content, abort");
      return;
    }

    // 解析工具定义（委托给独立 tools 插件）
    const tools = window.zion?.commands?.executeCommand("tools.parseFromContent", contentBeforeCursor) || null;

    // 3. 插入 assistant 块（用于承载输出）
    const insertLine = cursorLine + 1;
    if (insertLine >= lines.length) {
      // 在文档末尾安全插入 assistant 头行
      let targetLine = lines.length - 1;
      if (fullDoc.length > 0 && !fullDoc.endsWith("\n")) {
        // 追加一个换行，创建新的空行
        ed.replaceRange("\n", { line: lines.length - 1, ch: lines[lines.length - 1].length });
        // 新建的空行索引等于“旧的行数”
        targetLine = lines.length;
      } else {
        // 文档已以换行结尾或为空：最后一行为空，使用最后一行
        targetLine = Math.max(0, lines.length - 1);
      }
      ed.replaceRange("assistant ", { line: targetLine, ch: 0 });
    } else {
      const currentLineLength = lines[cursorLine].length;
      ed.replaceRange("\nassistant ", { line: cursorLine, ch: currentLineLength });
    }

    // 记录本次回答的 assistant 头行锚点（按会话存储，用于工具/思考插入定位）
    try {
      const docAfter = ed.getValue();
      const afterLines = docAfter.split("\n");
      let headLine = -1;
      for (let i = Math.max(0, insertLine); i < afterLines.length; i++) {
        if (/^\s*assistant\s+/.test(afterLines[i])) { headLine = i; break; }
      }
      if (headLine < 0) {
        for (let i = afterLines.length - 1; i >= 0; i--) {
          if (/^\s*assistant\s+/.test(afterLines[i])) { headLine = i; break; }
        }
      }
      if (headLine >= 0) {
        let anchorPos = 0;
        for (let i = 0; i < headLine; i++) anchorPos += afterLines[i].length + 1;
        window.zion.state.set(`chat.answerHeadLine.${sid}`, headLine);
        window.zion.state.set(`chat.answerAnchorPos.${sid}`, anchorPos);
      }
    } catch {}

    // 4. 状态 & 事件
    const runId = "run_" + Math.random().toString(36).slice(2);
    window.zion.state.set("chat.runId", runId); // 兼容旧事件消费者
    setRunState(sid, { runId, streaming: true, aborted: false, awaiting: false });
    window.zion.state.set("chat.error", null);
    window.zion.state.set("chat.streaming", true); // 兼容状态栏（当前会话）
    window.zion.events.emit("chat/runStarted", { runId, sessionId: sid });

    let streamController = null;
    setRunState(sid, { controller: { abort: () => streamController?.abort?.() } });

    // 工具调用收集（多步链式调用在每一步内局部收集）
    let aborted = false;
    // 每会话中断标志
    setRunState(sid, { aborted: false });

    // 通用 token 写入逻辑（写入同一个 assistant block，批量 flush 以降低刷新压力）
    // TokenBuffer：30ms 批量写入，同一行追加，触底才自动滚动
    const tokenBuffer = (() => {
      let acc = [];
      let timer = null;
      const interval = 30; // ms

      const flushImpl = () => {
        timer = null;
        if (acc.length === 0) return;
        const text = acc.join("");
        acc = [];
        if (!getRunState(sid)?.streaming) return;

        const isActiveSession = getSessionId() === sid;
        if (!isActiveSession) {
          try {
            window.zion.commands.executeCommand("zion.sessions.appendAssistantToken", { id: sid, token: text, runId });
            window.zion.events.emit("chat/token", { runId, token: text, sessionId: sid });
          } catch (e) {
            console.error("[langchain-chat] background append token error:", e);
          }
          return;
        }

        const currentDoc = ed.getValue();
        const currentLines = currentDoc.split("\n");

        let assistantLine = -1;
        for (let i = Math.max(0, insertLine - 1); i < currentLines.length; i++) {
          if (/^\s*assistant\s+/.test(currentLines[i])) { assistantLine = i; break; }
        }
        if (assistantLine === -1) {
          // Fallback: full scan to be robust when indices shift
          for (let i = 0; i < currentLines.length; i++) {
            if (/^\s*assistant\s+/.test(currentLines[i])) { assistantLine = i; break; }
          }
        }
        if (assistantLine === -1) return;

        let endLine = assistantLine;
        for (let i = assistantLine + 1; i < currentLines.length; i++) {
          if (/^\s*(system|user|assistant|tool)\s+/.test(currentLines[i])) break;
          endLine = i;
        }
        const lastLineText = currentLines[endLine] || "";
        try {
          ed.replaceRange(text, { line: endLine, ch: lastLineText.length });
          window.zion.events.emit("chat/token", { runId, token: text, sessionId: sid });

          // 触底才自动滚动（避免用户上拉时被抢滚）
          const scroller = document.querySelector(".cm-scroller");
          if (scroller) {
            const atBottom = (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) < 8;
            if (atBottom) {
              scroller.scrollTop = scroller.scrollHeight;
            }
          }
        } catch (e) {
          console.error("[langchain-chat] append token batch error:", e);
        }
      };

      return {
        push(tk) {
          acc.push(tk);
          if (!timer) timer = setTimeout(flushImpl, interval);
        },
        flush() {
          if (timer) { clearTimeout(timer); timer = null; }
          flushImpl();
        },
        stop() {
          if (timer) { clearTimeout(timer); timer = null; }
          acc = [];
        }
      };
    })();

    const appendToken = (tk) => {
      tokenBuffer.push(tk);
    };

    // 在最终阶段追加换行并清理（先 flush 剩余缓冲）
    const finalize = () => {
      try { tokenBuffer.flush(); } catch {}
      const currentDoc = ed.getValue();
      const currentLines = currentDoc.split("\n");
      let assistantLine = -1;
      for (let i = Math.max(0, insertLine - 1); i < currentLines.length; i++) {
        if (/^\s*assistant\s+/.test(currentLines[i])) { assistantLine = i; break; }
      }
      if (assistantLine === -1) {
        for (let i = 0; i < currentLines.length; i++) {
          if (/^\s*assistant\s+/.test(currentLines[i])) { assistantLine = i; break; }
        }
      }
      const isActiveSession = getSessionId() === sid;
      if (isActiveSession) {
        if (assistantLine !== -1) {
          let endLine = assistantLine;
          for (let i = assistantLine + 1; i < currentLines.length; i++) {
            if (/^\s*(system|user|assistant|tool)\s+/.test(currentLines[i])) break;
            endLine = i;
          }
          const lastLineText = currentLines[endLine] || "";
          try { ed.replaceRange("\n", { line: endLine, ch: lastLineText.length }); } catch {}
        }
      } else {
        try { window.zion.commands.executeCommand("zion.sessions.appendAssistantToken", { id: sid, token: "\n", runId }); } catch {}
      }
      tokenBuffer.stop();
      setRunState(sid, { streaming: false, awaiting: true, controller: null });
      window.zion.state.set("chat.streaming", false); // 兼容
      window.zion.commands.executeCommand("zion.sessions.bumpUpdatedAt", sid);
      window.zion.events.emit("chat/runFinished", { runId, sessionId: sid });
    };

    // 单步调用（收集本步工具调用并执行，返回本步的调用与结果）
    const runStep = async (msgs) => {
      if (aborted || getRunState(sid)?.aborted) return { calls: [], results: [] };
      const calls = [];
      const results = [];
      const promises = [];

      await runStream({
        messages: msgs,
        tools,
        onToken: appendToken,
        onToolCall: (tc) => {
          if (aborted || getRunState(sid)?.aborted) return;
          // 收集本步的 assistant tool_calls
          calls.push({ id: tc.id, name: tc.name, args: tc.args });
          // 执行工具并收集结果
          window.zion.events.emit("chat/toolCall", { runId, toolCall: tc, sessionId: sid });
          const p = executeToolCall(tc, sid)
            .then(res => {
              if (aborted || getRunState(sid)?.aborted) return;
              const content = String(res || "");
              results.push({ id: tc.id, content });
              window.zion.events.emit("chat/toolResult", { runId, toolCallId: tc.id, result: res, sessionId: sid });
            })
            .catch(err => {
              if (aborted || getRunState(sid)?.aborted) return;
              const msg = `Tool "${tc.name}" failed: ${err?.message || String(err)}`;
              results.push({ id: tc.id, content: msg });
              window.zion.events.emit("chat/toolResult", { runId, toolCallId: tc.id, result: msg, sessionId: sid });
            });
          promises.push(p);
        },
        onEnd: () => { /* 中间步骤不清理，留到链式结束后统一 finalize */ },
        onError: (e) => {
          if (e?.name === "AbortError") { aborted = true; setRunState(sid, { aborted: true, streaming: false }); return; }
          window.zion.state.set("chat.error", e.message);
          window.zion.events.emit("chat/runError", { runId, error: e, sessionId: sid });
          aborted = true;
          setRunState(sid, { aborted: true, streaming: false });
        },
        getController: (controller) => { streamController = controller; },
        runId,
        sessionId: sid
      });

      // 等待工具执行完成，确保生成 tool 结果
      if (promises.length > 0) {
        try { await Promise.allSettled(promises); } catch {}
      }

      return { calls, results };
    };

    try {
      // 多步链式：直到本步不再产生 tool_calls 为止
      let msgs = baseMessages;

      // 根据“发起会话位置（光标）上方”的内容，按编辑器顺序把历史工具调用插入到对应的 assistant 消息之后
      if (window.zion?.state?.get("chat.includeToolHistory") || window.zion?.state?.get("chat.includeThinkingHistory")) {
        try {
          const ann = window.zion?.state?.get(`sessions.annotations.${sid}`) || {};
          const limitPos = contentBeforeCursor.length;

          // tools (must have both call and result to satisfy API constraints)
          const itemsToolsRaw = Array.isArray(ann.tools) ? ann.tools : [];
          const deleted = new Set(Array.isArray(ann.deletedToolIds) ? ann.deletedToolIds : []);
          const itemsTools = itemsToolsRaw
            .filter(it => it && it.id && !deleted.has(it.id))
            .filter(it => typeof it.from === "number" && it.from >= 0 && it.from < limitPos)
            .filter(it => it.name && it.args && it.result != null)
            .sort((a, b) => (a.from || 0) - (b.from || 0));

          // thinking
          const itemsThinkingRaw = Array.isArray(ann.thinking) ? ann.thinking : [];
          const itemsThinking = itemsThinkingRaw
            .filter(it => it && typeof it.from === "number" && it.from >= 0 && it.from < limitPos)
            .filter(it => typeof it.text === "string" && it.text.trim().length > 0)
            .sort((a, b) => (a.from || 0) - (b.from || 0));

          // Build role ranges to locate assistant blocks within contentBeforeCursor
          const buildRanges = (text) => {
            const lines = String(text || "").replace(/\r/g, "").split("\n");
            const ranges = [];
            let pos = 0;
            let startPos = 0;
            let currentRole = "user";
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              const m = line.match(/^(system|user|assistant)\s+(.*)$/);
              if (m) {
                if (pos > startPos) {
                  ranges.push({ role: currentRole, from: startPos, to: pos });
                }
                currentRole = m[1];
                startPos = pos;
              }
              pos += line.length + 1;
            }
            if (pos > startPos) ranges.push({ role: currentRole, from: startPos, to: pos });
            return ranges;
          };

          const ranges = buildRanges(contentBeforeCursor);
          const assistantRanges = ranges.filter(r => r.role === "assistant");
          const assistantMsgIdxs = [];
          for (let i = 0; i < msgs.length; i++) {
            if (msgs[i]?.role === "assistant") assistantMsgIdxs.push(i);
          }

          // group ordered units per assistant message index
          const groups = new Map(); // idx -> Array<{ pos:number, kind:'tool'|'thinking', data:any }>
          const findAssistantIndexForPos = (p) => {
            for (let i = 0; i < assistantRanges.length; i++) {
              const r = assistantRanges[i];
              if (p >= r.from && p < r.to) {
                return assistantMsgIdxs[i] ?? -1;
              }
            }
            let fallback = -1;
            for (let i = 0; i < assistantRanges.length; i++) {
              if (assistantRanges[i].to <= p) fallback = assistantMsgIdxs[i] ?? -1;
            }
            return fallback;
          };

          // collect tool units
          if (window.zion?.state?.get("chat.includeToolHistory") && itemsTools.length) {
            for (const it of itemsTools) {
              const idx = findAssistantIndexForPos(it.from);
              if (idx < 0) continue;
              const arr = groups.get(idx) || [];
              arr.push({
                pos: it.from,
                kind: "tool",
                data: {
                  id: it.id,
                  name: it.name,
                  args: it.args,
                  result: String(it.result)
                }
              });
              groups.set(idx, arr);
            }
          }

          // collect thinking units
          if (window.zion?.state?.get("chat.includeThinkingHistory") && itemsThinking.length) {
            for (const it of itemsThinking) {
              const idx = findAssistantIndexForPos(it.from);
              if (idx < 0) continue;
              const arr = groups.get(idx) || [];
              arr.push({
                pos: it.from,
                kind: "thinking",
                data: { content: String(it.text || "") }
              });
              groups.set(idx, arr);
            }
          }

          // write back maintaining editor order:
          // for each assistant idx, insert units sorted by pos:
          // - thinking: insert an assistant message with content
          // - tool: insert an assistant message with single tool_call, then immediately the corresponding tool message
          if (groups.size > 0) {
            const sortedIdxs = Array.from(groups.keys()).sort((a, b) => a - b);
            let offset = 0;
            for (const baseIdx of sortedIdxs) {
              const idx = baseIdx + offset;
              const units = (groups.get(baseIdx) || []).slice().sort((a, b) => (a.pos || 0) - (b.pos || 0));
              for (const unit of units) {
                if (unit.kind === "thinking") {
                  // assistant text in order
                  msgs.splice(idx + 1 + offset, 0, { role: "assistant", content: unit.data.content });
                  offset += 1;
                } else if (unit.kind === "tool") {
                  // assistant tool_calls block followed immediately by its tool result
                  const tc = {
                    id: unit.data.id,
                    type: "function",
                    function: { name: unit.data.name, arguments: JSON.stringify(unit.data.args || {}) }
                  };
                  msgs.splice(idx + 1 + offset, 0, { role: "assistant", tool_calls: [tc] });
                  offset += 1;
                  msgs.splice(idx + 1 + offset, 0, { role: "tool", tool_call_id: unit.data.id, content: unit.data.result });
                  offset += 1;
                }
              }
            }
          }
        } catch {}
      }

      while (true) {
        const step = await runStep(msgs);
        if (aborted) { finalize(); return; }

        // 若本步产生了工具调用与结果，则构造下一步消息继续
        if (step.calls.length > 0) {
          const assistantToolCalls = step.calls.map(tc => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) }
          }));
          const toolMsgs = step.results.map(tr => ({
            role: "tool",
            tool_call_id: tr.id,
            content: tr.content
          }));

          msgs = [
            ...msgs,
            { role: "assistant", tool_calls: assistantToolCalls },
            ...toolMsgs
          ];
          // 继续下一步
          continue;
        }

        // 无新的工具调用，结束链式
        break;
      }

      // 全流程结束
      finalize();
    } catch (e) {
      console.error("[langchain-chat] runStream outer error:", e);
      finalize();
    }
  };

  // 解析消息内容，组装 messages 数组（支持图片）
  function parseMessages(content) {
    const lines = content.split("\n");
    const messages = [];
    let currentRole = "user"; // 默认角色
    let currentContent = [];
    let currentImages = [];

    for (const line of lines) {
      const roleMatch = line.match(/^(system|user|assistant)\s+(.*)$/);
      const imageMatch = line.match(/^!\[.*\]\((.*)\)$/);

      if (roleMatch) {
        if (currentContent.length > 0 || currentImages.length > 0) {
          const message = { role: currentRole, content: [] };
          if (currentContent.length > 0) {
            message.content.push({ type: "text", text: currentContent.join("\n").trim() });
          }
          for (const img of currentImages) {
            if (img.startsWith("http") || img.startsWith("app://")) {
              message.content.push({ type: "image_url", image_url: { url: img } });
            }
          }
          messages.push(message);
          currentContent = [];
          currentImages = [];
        }
        currentRole = roleMatch[1];
        const contentPart = roleMatch[2];
        if (contentPart.trim()) currentContent.push(contentPart);
      } else if (imageMatch) {
        const imageUrl = imageMatch[1];
        currentImages.push(imageUrl);
      } else {
        currentContent.push(line);
      }
    }

    if (currentContent.length > 0 || currentImages.length > 0) {
      const message = { role: currentRole, content: [] };
      if (currentContent.length > 0) {
        message.content.push({ type: "text", text: currentContent.join("\n").trim() });
      }
      for (const img of currentImages) {
        if (img.startsWith("http") || img.startsWith("app://")) {
          message.content.push({ type: "image_url", image_url: { url: img } });
        }
      }
      messages.push(message);
    }

    const simplifiedMessages = messages.map(msg => {
      if (msg.content.length === 1 && msg.content[0].type === "text") {
        return { role: msg.role, content: msg.content[0].text };
      }
      return msg;
    });

    return simplifiedMessages;
  }

  // 注册命令（完全复用现有 ID）
  const cmds = [
    window.zion.commands.registerCommand("chat.runSelection", () => doRun({ useSelection: true })),
    window.zion.commands.registerCommand("chat.run", () => doRun({})),
    window.zion.commands.registerCommand("chat.stop", () => {
      // 仅停止当前会话的流式输出并中止其请求
      const sid = getSessionId();
      const rs = getRunState(sid);
      setRunState(sid, { streaming: false, aborted: true });
      window.zion.state.set("chat.streaming", false); // 兼容状态栏
      const controller = rs?.controller;
      if (controller?.abort) controller.abort();
      window.zion.events.emit("chat/aborted", { runId: rs?.runId, sessionId: sid });
    }),
    window.zion.commands.registerCommand("chat.retry", () => doRun({}))
  ];
  ctx.subscriptions.push(...cmds);

  // 模型选择相关命令
  const dispListProviders = window.zion.commands.registerCommand("models.listProviders", () => {
    console.log("[models] providers:", window.zion.models.listProviders());
  });
  const dispListModels = window.zion.commands.registerCommand("models.listModels", async () => {
    await refreshCatalog();
    console.log("[models] catalog:", window.zion.state.get("models.catalog"));
  });
  const dispSelectModel = window.zion.commands.registerCommand("models.selectModel", (spec) => {
    if (!spec) return;
    const [providerId, modelId] = String(spec).split(":");
    if (!providerId || !modelId) return;
    const catalog = window.zion.state.get("models.catalog") || [];
    const item = catalog.find(m => m.providerId === providerId && m.id === modelId);
    window.zion.state.set("chat.activeModel", { providerId, modelId, label: item?.label || modelId });
  });
  const dispNextModel = window.zion.commands.registerCommand("models.selectNextModel", async () => {
    await refreshCatalog();
    const catalog = window.zion.state.get("models.catalog") || [];
    if (catalog.length === 0) return;
    const active = window.zion.state.get("chat.activeModel");
    const idx = catalog.findIndex(m => m.providerId === active?.providerId && m.id === active?.modelId);
    const next = catalog[(idx + 1) % catalog.length] || catalog[0];
    window.zion.state.set("chat.activeModel", { providerId: next.providerId, modelId: next.id, label: next.label });
  });
  const dispPrevModel = window.zion.commands.registerCommand("models.selectPrevModel", async () => {
    await refreshCatalog();
    const catalog = window.zion.state.get("models.catalog") || [];
    if (catalog.length === 0) return;
    const active = window.zion.state.get("chat.activeModel");
    const idx = catalog.findIndex(m => m.providerId === active?.providerId && m.id === active?.modelId);
    const prev = catalog[(idx - 1 + catalog.length) % catalog.length] || catalog[0];
    window.zion.state.set("chat.activeModel", { providerId: prev.providerId, modelId: prev.id, label: prev.label });
  });
  ctx.subscriptions.push(dispListProviders, dispListModels, dispSelectModel, dispNextModel, dispPrevModel);

  // 打开/关闭模型切换器
  const dispOpenSwitcher = window.zion.commands.registerCommand("models.openSwitcher", async () => {
    await refreshCatalog();
    if (modelSwitcher) modelSwitcher.open();
  });
  const dispCloseSwitcher = window.zion.commands.registerCommand("models.closeSwitcher", () => {
    modelSwitcher?.close?.();
  });
  ctx.subscriptions.push(dispListProviders, dispListModels, dispSelectModel, dispNextModel, dispPrevModel, dispOpenSwitcher, dispCloseSwitcher);

  // 注册快捷键
  const kbs = [
    window.zion.keybindings.register({ command: "chat.runSelection", key: "Mod-Enter", when: "editorFocus" }),
    window.zion.keybindings.register({ command: "chat.stop", key: "Escape", when: "editorFocus" }),
    window.zion.keybindings.register({ command: "chat.retry", key: "Mod-Shift-r", when: "editorFocus" }),
    window.zion.keybindings.register({ command: "models.openSwitcher", key: "Mod-Shift-m", when: "editorFocus" })
  ];
  ctx.subscriptions.push(...kbs);

  // 右键菜单
  if (window.zion.menus?.register) {
    const ms = [
      window.zion.menus.register("editor/context", { command: "models.openSwitcher", title: "Select Model...", when: "editorFocus" }),
      window.zion.menus.register("editor/context", { command: "chat.runSelection", title: "Run Chat (Selection)", when: "editorFocus" }),
      window.zion.menus.register("editor/context", { command: "chat.stop", title: "Stop Chat", when: "editorFocus" }),
      window.zion.menus.register("editor/context", { command: "chat.retry", title: "Retry Chat", when: "editorFocus" })
    ];
    ctx.subscriptions.push(...ms);
  }

  // 状态栏 Run/Stop 按钮
  let runBtnDisp = null;
  const updateRunBtn = (streaming) => {
    runBtnDisp?.dispose?.();
    runBtnDisp = window.zion.statusBar.registerItem({
      id: "langchain.chat.runstop",
      text: streaming ? "Stop" : "Run",
      tooltip: "Mod-Enter: Run selection | Esc: Stop | Mod-Shift-R: Retry",
      onClick: () => {
        const s = window.zion.state.get("chat.streaming");
        if (s) window.zion.commands.executeCommand("chat.stop");
        else window.zion.commands.executeCommand("chat.runSelection");
      }
    });
  };
  updateRunBtn(false);
  ctx.subscriptions.push(
    window.zion.state.onDidChange("chat.streaming", (s) => updateRunBtn(!!s))
  );

  // 状态栏 Model 按钮（动态展示与切换）
  let modelBtnDisp = null;
  const updateModelBtn = () => {
    const active = window.zion.state.get("chat.activeModel");
    const label = active?.label || active?.modelId || "unknown";
    modelBtnDisp?.dispose?.();
    modelBtnDisp = window.zion.statusBar.registerItem({
      id: "langchain.chat.model",
      text: `Model: ${label}`,
      tooltip: "Select Model (Search / ↑↓ / PgUp/PgDn / Home/End / Enter / Esc)",
      onClick: () => window.zion.commands.executeCommand("models.openSwitcher")
    });
  };
  updateModelBtn();
  ctx.subscriptions.push(
    window.zion.state.onDidChange("chat.activeModel", updateModelBtn)
  );

  // 注册“模型管理”工具（CRUD + 设置激活）
  try { registerModelsTools(); } catch {}
}