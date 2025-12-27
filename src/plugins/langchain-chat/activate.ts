/**
 * Zion LangChain Chat Plugin - Activation Logic
 * Converted from extension/main.js
 */

import { runStream } from './services/chat-service';
import { deepseekProvider } from './providers/deepseek-provider';
import { userModelsProvider } from './providers/user-models-provider';
import { installModelSwitcher } from './ui/model-switcher';
import { registerModelsTools } from './tools/models-tools';
import type { PluginContext, Disposable } from '../../../plugin/types';

/**
 * Parse messages from document content (supporting system/user/assistant roles and images)
 */
function parseMessages(content: string) {
  const lines = content.split("\n");
  const messages: any[] = [];
  let currentRole = "user";
  let currentContent: string[] = [];
  let currentImages: string[] = [];

  for (const line of lines) {
    const roleMatch = line.match(/^(system|user|assistant)\s+(.*)$/);
    const imageMatch = line.match(/^!\[.*\]\((.*)\)$/);

    if (roleMatch) {
      if (currentContent.length > 0 || currentImages.length > 0) {
        const message = { role: currentRole, content: [] as any[] };
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
    const message = { role: currentRole, content: [] as any[] };
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

/**
 * Main activation function
 */
export async function activate(context: PluginContext) {
  // Register model providers
  const dispProv = (window as any).zion.models.registerProvider(deepseekProvider);
  context.subscriptions.push({ dispose: () => dispProv?.dispose?.() });

  const dispUserProv = (window as any).zion.models.registerProvider(userModelsProvider);
  context.subscriptions.push({ dispose: () => dispUserProv?.dispose?.() });

  // Model catalog refresh helper
  async function refreshCatalog() {
    try {
      const ids = (window as any).zion.models.listProviders() || [];
      const models: any[] = [];
      for (const pid of ids) {
        const prov = (window as any).zion.models.getProvider(pid);
        if (!prov) continue;
        const list = await prov.list();
        for (const m of (list || [])) {
          let requiresConfig = false;
          let configHint = "";
          try {
            const cfg = await prov.resolve(m.id);
            if (cfg?._requiresConfig && (!cfg.key || !cfg.key.trim())) {
              requiresConfig = true;
              configHint = cfg._configHint || "需要配置 API key";
            }
          } catch {}

          models.push({
            providerId: pid,
            id: m.id,
            label: m.label || m.id,
            requiresConfig,
            configHint
          });
        }
      }
      (window as any).zion.state.set("models.catalog", models);
    } catch (e) {
      console.warn("[langchain-chat] refreshCatalog error", e);
    }
  }

  function ensureActiveModel() {
    const active = (window as any).zion.state.get("chat.activeModel");
    if (!active) {
      (window as any).zion.state.set("chat.activeModel", {
        providerId: "deepseek",
        modelId: "deepseek-chat",
        label: "DeepSeek Chat"
      });
    }
  }

  await refreshCatalog();
  ensureActiveModel();

  // Model switcher decorator
  let modelSwitcher: any = null;
  const decSwitcher = (window as any).zion.editor.registerDecorator({
    id: "zion.langchain-chat.model-switcher",
    apply(editor: any) {
      modelSwitcher = installModelSwitcher();
      return {
        dispose() {
          modelSwitcher?.dispose?.();
          modelSwitcher = null;
        }
      };
    }
  });
  context.subscriptions.push({ dispose: () => decSwitcher?.dispose?.() });

  // Helper to get active editor
  const getEd = () => (window as any).zion?.window?.activeEditor;

  // Session helpers
  const getSessionId = () => (window as any)?.zion?.state?.get("sessions.currentId");
  const getRunState = (sid: string) => (window as any)?.zion?.state?.get(`chat.runs.${sid}`) || null;
  const setRunState = (sid: string, patch: any) => {
    const cur = getRunState(sid) || {};
    (window as any).zion.state.set(`chat.runs.${sid}`, { ...cur, ...patch });
  };

  // Simple tool execution
  async function executeToolCall(call: any, sid: string) {
    const isAborted = () => !!getRunState(sid)?.aborted;

    if (isAborted()) {
      return `Tool "${call.name}" execution aborted`;
    }

    // Use state bus handlers
    const handlers = (window as any).zion?.state?.get("chat.toolHandlers") || {};
    if (handlers && typeof handlers[call.name] === "function") {
      try {
        const out = await handlers[call.name](call.args);
        if (isAborted()) {
          return `Tool "${call.name}" execution aborted`;
        }
        return typeof out === "string" ? out : JSON.stringify(out);
      } catch (e) {
        if (isAborted()) return `Tool "${call.name}" execution aborted`;
        return `Tool "${call.name}" error: ${e?.message || String(e)}`;
      }
    }

    // Built-in example tools
    try {
      switch (call.name) {
        case "echo":
          return typeof call.args === "string" ? call.args : JSON.stringify(call.args);
        case "sum":
          if (isAborted()) return `Tool "${call.name}" execution aborted`;
          if (Array.isArray(call.args?.numbers)) {
            const s = call.args.numbers.reduce((a: number, b: number) => a + Number(b || 0), 0);
            return String(s);
          }
          return "Invalid args for sum: expected { numbers: number[] }";
        case "calculate":
          if (isAborted()) return `Tool "${call.name}" execution aborted`;
          if (call.args?.expression) {
            const expr = String(call.args.expression);
            if (!/^[\d\+\-\*\/\.\(\)\s]+$/.test(expr)) return "Unsafe expression";
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

  // Main run logic
  const doRun = async (opts: any = {}) => {
    const ed = getEd();
    if (!ed) {
      console.log("[langchain-chat] no active editor");
      return;
    }

    ensureActiveModel();
    const sid = getSessionId();
    const streaming = !!getRunState(sid)?.streaming;
    if (streaming) {
      console.log("[langchain-chat] already streaming in current session, abort");
      return;
    }

    const cursor = ed.getCursor();
    const fullDoc = ed.getValue();
    const lines = fullDoc.split("\n");
    const cursorLine = cursor.line;
    const contentBeforeCursor = lines.slice(0, cursorLine + 1).join("\n");

    const baseMessages = parseMessages(contentBeforeCursor);
    if (baseMessages.length === 0) {
      (window as any).zion.events.emit("chat/runError", { error: "No content to send" });
      console.log("[langchain-chat] no content, abort");
      return;
    }

    // Include terminal context if enabled
    try {
      let includeTerminal = (window as any).zion?.state?.get("chat.includeTerminalContext");
      if (includeTerminal === undefined) {
        includeTerminal = true;
        try { (window as any).zion?.state?.set("chat.includeTerminalContext", true); } catch {}
      }
      if (includeTerminal !== false) {
        const readBase = () => {
          const st1 = (window as any).zion?.state?.get("localTools.baseUrl");
          if (typeof st1 === "string" && st1.trim()) return st1.trim();
          try {
            const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
            if (s) return s.trim();
          } catch {}
          return "http://127.0.0.1:8765";
        };

        let sessions = (window as any).zion?.state?.get("terminal.sessions");
        if (!Array.isArray(sessions) || sessions.length === 0) {
          try {
            const base = readBase().replace(/\/$/, "");
            const resp = await fetch(`${base}/sessions`, { method: "GET" });
            const j = await resp.json().catch(() => null);
            if (resp.ok && j && Array.isArray(j.sessions)) {
              sessions = j.sessions;
              try { (window as any).zion?.state?.set("terminal.sessions", sessions); } catch {}
            } else {
              sessions = Array.isArray(sessions) ? sessions : [];
            }
          } catch {
            sessions = Array.isArray(sessions) ? sessions : [];
          }
        }

        const activeId = (window as any).zion?.state?.get("terminal.activeSessionId") || null;
        const ctxObj = { activeSessionId: activeId, sessions };
        const text = `Terminal Context\n${JSON.stringify(ctxObj, null, 2)}`;
        baseMessages.unshift({ role: "system", content: text });
      }
    } catch {}

    // Parse tools definition
    const tools = (window as any).zion?.commands?.executeCommand("tools.parseFromContent", contentBeforeCursor) || null;

    // Insert assistant block
    const insertLine = cursorLine + 1;
    if (insertLine >= lines.length) {
      let targetLine = lines.length - 1;
      if (fullDoc.length > 0 && !fullDoc.endsWith("\n")) {
        ed.replaceRange("\n", { line: lines.length - 1, ch: lines[lines.length - 1].length });
        targetLine = lines.length;
      } else {
        targetLine = Math.max(0, lines.length - 1);
      }
      ed.replaceRange("assistant ", { line: targetLine, ch: 0 });
    } else {
      const currentLineLength = lines[cursorLine].length;
      ed.replaceRange("\nassistant ", { line: cursorLine, ch: currentLineLength });
    }

    // Record assistant head line anchor
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
        (window as any).zion.state.set(`chat.answerHeadLine.${sid}`, headLine);
        (window as any).zion.state.set(`chat.answerAnchorPos.${sid}`, anchorPos);
      }
    } catch {}

    const runId = "run_" + Math.random().toString(36).slice(2);
    (window as any).zion.state.set("chat.runId", runId);
    setRunState(sid, { runId, streaming: true, aborted: false, awaiting: false });
    (window as any).zion.state.set("chat.error", null);
    (window as any).zion.state.set("chat.streaming", true);
    (window as any).zion.events.emit("chat/runStarted", { runId, sessionId: sid });

    let streamController: any = null;
    setRunState(sid, { controller: { abort: () => streamController?.abort?.() } });

    let aborted = false;
    setRunState(sid, { aborted: false });

    // Token buffer for batch writes
    const tokenBuffer = (() => {
      let acc: string[] = [];
      let timer: number | null = null;
      const interval = 30;

      const flushImpl = () => {
        timer = null;
        if (acc.length === 0) return;
        const text = acc.join("");
        acc = [];
        if (!getRunState(sid)?.streaming) return;

        const isActiveSession = getSessionId() === sid;
        if (!isActiveSession) {
          try {
            (window as any).zion.commands.executeCommand("zion.sessions.appendAssistantToken", { id: sid, token: text, runId });
            (window as any).zion.events.emit("chat/token", { runId, token: text, sessionId: sid });
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
          (window as any).zion.events.emit("chat/token", { runId, token: text, sessionId: sid });

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
        push(tk: string) {
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

    const appendToken = (tk: string) => {
      tokenBuffer.push(tk);
    };

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
        try {
          (window as any).zion.commands.executeCommand("zion.sessions.appendAssistantToken", { id: sid, token: "\n", runId });
        } catch {}
      }
      tokenBuffer.stop();
      setRunState(sid, { streaming: false, awaiting: true, controller: null });
      (window as any).zion.state.set("chat.streaming", false);
      (window as any).zion.commands.executeCommand("zion.sessions.bumpUpdatedAt", sid);
      (window as any).zion.events.emit("chat/runFinished", { runId, sessionId: sid });
    };

    // Step execution with tool calling support
    const runStep = async (msgs: any[]) => {
      if (aborted || getRunState(sid)?.aborted) return { calls: [], results: [] };
      const calls: any[] = [];
      const results: any[] = [];
      const promises: Promise<void>[] = [];

      await runStream({
        messages: msgs,
        tools,
        onToken: appendToken,
        onToolCall: (tc: any) => {
          if (aborted || getRunState(sid)?.aborted) return;
          calls.push({ id: tc.id, name: tc.name, args: tc.args });
          (window as any).zion.events.emit("chat/toolCall", { runId, toolCall: tc, sessionId: sid });
          const p = executeToolCall(tc, sid)
            .then(res => {
              if (aborted || getRunState(sid)?.aborted) return;
              const content = String(res || "");
              results.push({ id: tc.id, content });
              (window as any).zion.events.emit("chat/toolResult", { runId, toolCallId: tc.id, result: res, sessionId: sid });
            })
            .catch(err => {
              if (aborted || getRunState(sid)?.aborted) return;
              const msg = `Tool "${tc.name}" failed: ${err?.message || String(err)}`;
              results.push({ id: tc.id, content: msg });
              (window as any).zion.events.emit("chat/toolResult", { runId, toolCallId: tc.id, result: msg, sessionId: sid });
            });
          promises.push(p);
        },
        onEnd: () => {},
        onError: (e: any) => {
          if (e?.name === "AbortError") {
            aborted = true;
            setRunState(sid, { aborted: true, streaming: false });
            return;
          }
          (window as any).zion.state.set("chat.error", e.message);
          (window as any).zion.events.emit("chat/runError", { runId, error: e, sessionId: sid });
          aborted = true;
          setRunState(sid, { aborted: true, streaming: false });
        },
        getController: (controller: any) => { streamController = controller; },
        runId,
        sessionId: sid
      });

      if (promises.length > 0) {
        try { await Promise.allSettled(promises); } catch {}
      }

      return { calls, results };
    };

    try {
      let msgs = baseMessages;

      // Include tool/thinking history if enabled
      if ((window as any).zion?.state?.get("chat.includeToolHistory") || (window as any).zion?.state?.get("chat.includeThinkingHistory")) {
        try {
          const ann = (window as any).zion?.state?.get(`sessions.annotations.${sid}`) || {};
          const limitPos = contentBeforeCursor.length;

          const itemsToolsRaw = Array.isArray(ann.tools) ? ann.tools : [];
          const deleted = new Set(Array.isArray(ann.deletedToolIds) ? ann.deletedToolIds : []);
          const itemsTools = itemsToolsRaw
            .filter((it: any) => it && it.id && !deleted.has(it.id))
            .filter((it: any) => typeof it.from === "number" && it.from >= 0 && it.from < limitPos)
            .filter((it: any) => it.name && it.args && it.result != null)
            .sort((a: any, b: any) => (a.from || 0) - (b.from || 0));

          const itemsThinkingRaw = Array.isArray(ann.thinking) ? ann.thinking : [];
          const itemsThinking = itemsThinkingRaw
            .filter((it: any) => it && typeof it.from === "number" && it.from >= 0 && it.from < limitPos)
            .filter((it: any) => typeof it.text === "string" && it.text.trim().length > 0)
            .sort((a: any, b: any) => (a.from || 0) - (b.from || 0));

          const buildRanges = (text: string) => {
            const lines = String(text || "").replace(/\r/g, "").split("\n");
            const ranges: any[] = [];
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
          const assistantRanges = ranges.filter((r: any) => r.role === "assistant");
          const assistantMsgIdxs: number[] = [];
          for (let i = 0; i < msgs.length; i++) {
            if (msgs[i]?.role === "assistant") assistantMsgIdxs.push(i);
          }

          const groups = new Map<number, any[]>();
          const findAssistantIndexForPos = (p: number) => {
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

          if ((window as any).zion?.state?.get("chat.includeToolHistory") && itemsTools.length) {
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

          if ((window as any).zion?.state?.get("chat.includeThinkingHistory") && itemsThinking.length) {
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

          if (groups.size > 0) {
            const sortedIdxs = Array.from(groups.keys()).sort((a, b) => a - b);
            let offset = 0;
            for (const baseIdx of sortedIdxs) {
              const idx = baseIdx + offset;
              const units = (groups.get(baseIdx) || []).slice().sort((a: any, b: any) => (a.pos || 0) - (b.pos || 0));
              for (const unit of units) {
                if (unit.kind === "thinking") {
                  msgs.splice(idx + 1 + offset, 0, { role: "assistant", content: unit.data.content });
                  offset += 1;
                } else if (unit.kind === "tool") {
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

      // Chain execution
      while (true) {
        const step = await runStep(msgs);
        if (aborted) { finalize(); return; }

        if (step.calls.length > 0) {
          const assistantToolCalls = step.calls.map((tc: any) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) }
          }));
          const toolMsgs = step.results.map((tr: any) => ({
            role: "tool",
            tool_call_id: tr.id,
            content: tr.content
          }));

          msgs = [
            ...msgs,
            { role: "assistant", tool_calls: assistantToolCalls },
            ...toolMsgs
          ];
          continue;
        }

        break;
      }

      finalize();
    } catch (e) {
      console.error("[langchain-chat] runStream outer error:", e);
      finalize();
    }
  };

  // Register commands
  const cmds = [
    (window as any).zion.commands.registerCommand("chat.runSelection", () => doRun({ useSelection: true })),
    (window as any).zion.commands.registerCommand("chat.run", () => doRun({})),
    (window as any).zion.commands.registerCommand("chat.stop", () => {
      const sid = getSessionId();
      const rs = getRunState(sid);
      setRunState(sid, { streaming: false, aborted: true });
      (window as any).zion.state.set("chat.streaming", false);
      const controller = rs?.controller;
      if (controller?.abort) controller.abort();
      (window as any).zion.events.emit("chat/aborted", { runId: rs?.runId, sessionId: sid });
    }),
    (window as any).zion.commands.registerCommand("chat.retry", () => doRun({}))
  ];
  context.subscriptions.push(...cmds);

  // Model selection commands
  const dispListProviders = (window as any).zion.commands.registerCommand("models.listProviders", () => {
    console.log("[models] providers:", (window as any).zion.models.listProviders());
  });
  const dispListModels = (window as any).zion.commands.registerCommand("models.listModels", async () => {
    await refreshCatalog();
    console.log("[models] catalog:", (window as any).zion.state.get("models.catalog"));
  });
  const dispSelectModel = (window as any).zion.commands.registerCommand("models.selectModel", (spec: string) => {
    if (!spec) return;
    const [providerId, modelId] = String(spec).split(":");
    if (!providerId || !modelId) return;
    const catalog = (window as any).zion.state.get("models.catalog") || [];
    const item = catalog.find((m: any) => m.providerId === providerId && m.id === modelId);
    (window as any).zion.state.set("chat.activeModel", { providerId, modelId, label: item?.label || modelId });
  });
  const dispNextModel = (window as any).zion.commands.registerCommand("models.selectNextModel", async () => {
    await refreshCatalog();
    const catalog = (window as any).zion.state.get("models.catalog") || [];
    if (catalog.length === 0) return;
    const active = (window as any).zion.state.get("chat.activeModel");
    const idx = catalog.findIndex((m: any) => m.providerId === active?.providerId && m.id === active?.modelId);
    const next = catalog[(idx + 1) % catalog.length] || catalog[0];
    (window as any).zion.state.set("chat.activeModel", { providerId: next.providerId, modelId: next.id, label: next.label });
  });
  const dispPrevModel = (window as any).zion.commands.registerCommand("models.selectPrevModel", async () => {
    await refreshCatalog();
    const catalog = (window as any).zion.state.get("models.catalog") || [];
    if (catalog.length === 0) return;
    const active = (window as any).zion.state.get("chat.activeModel");
    const idx = catalog.findIndex((m: any) => m.providerId === active?.providerId && m.id === active?.modelId);
    const prev = catalog[(idx - 1 + catalog.length) % catalog.length] || catalog[0];
    (window as any).zion.state.set("chat.activeModel", { providerId: prev.providerId, modelId: prev.id, label: prev.label });
  });
  context.subscriptions.push(
    { dispose: () => dispListProviders?.dispose?.() },
    { dispose: () => dispListModels?.dispose?.() },
    { dispose: () => dispSelectModel?.dispose?.() },
    { dispose: () => dispNextModel?.dispose?.() },
    { dispose: () => dispPrevModel?.dispose?.() }
  );

  // Open/close model switcher
  const dispOpenSwitcher = (window as any).zion.commands.registerCommand("models.openSwitcher", async () => {
    await refreshCatalog();
    if (modelSwitcher) modelSwitcher.open();
  });
  const dispCloseSwitcher = (window as any).zion.commands.registerCommand("models.closeSwitcher", () => {
    modelSwitcher?.close?.();
  });
  context.subscriptions.push(
    { dispose: () => dispOpenSwitcher?.dispose?.() },
    { dispose: () => dispCloseSwitcher?.dispose?.() }
  );

  // Register keybindings
  const kbs = [
    (window as any).zion.keybindings.register({ command: "chat.runSelection", key: "Mod-Enter", when: "editorFocus" }),
    (window as any).zion.keybindings.register({ command: "chat.stop", key: "Escape", when: "editorFocus" }),
    (window as any).zion.keybindings.register({ command: "chat.retry", key: "Mod-Shift-r", when: "editorFocus" }),
    (window as any).zion.keybindings.register({ command: "models.openSwitcher", key: "Mod-Shift-m", when: "editorFocus" })
  ];
  context.subscriptions.push(...kbs.map((kb: any) => ({ dispose: () => kb?.dispose?.() })));

  // Register menus
  if ((window as any).zion.menus?.register) {
    const ms = [
      (window as any).zion.menus.register("editor/context", { command: "models.openSwitcher", title: "Select Model...", when: "editorFocus" }),
      (window as any).zion.menus.register("editor/context", { command: "chat.runSelection", title: "Run Chat (Selection)", when: "editorFocus" }),
      (window as any).zion.menus.register("editor/context", { command: "chat.stop", title: "Stop Chat", when: "editorFocus" }),
      (window as any).zion.menus.register("editor/context", { command: "chat.retry", title: "Retry Chat", when: "editorFocus" })
    ];
    context.subscriptions.push(...ms.map((m: any) => ({ dispose: () => m?.dispose?.() })));
  }

  // Status bar Run/Stop button
  let runBtnDisp: any = null;
  const updateRunBtn = (streaming: boolean) => {
    runBtnDisp?.dispose?.();
    runBtnDisp = (window as any).zion.statusBar.registerItem({
      id: "langchain.chat.runstop",
      text: streaming ? "Stop" : "Run",
      tooltip: "Mod-Enter: Run selection | Esc: Stop | Mod-Shift-R: Retry",
      onClick: () => {
        const s = (window as any).zion.state.get("chat.streaming");
        if (s) (window as any).zion.commands.executeCommand("chat.stop");
        else (window as any).zion.commands.executeCommand("chat.runSelection");
      }
    });
  };
  updateRunBtn(false);
  context.subscriptions.push(
    (window as any).zion.state.onDidChange("chat.streaming", (s: boolean) => updateRunBtn(!!s))
  );

  // Status bar Model button
  let modelBtnDisp: any = null;
  const updateModelBtn = () => {
    const active = (window as any).zion.state.get("chat.activeModel");
    const catalog = (window as any).zion.state.get("models.catalog") || [];
    const activeItem = catalog.find((m: any) =>
      m.providerId === active?.providerId && m.id === active?.modelId
    );

    let label = active?.label || active?.modelId || "unknown";
    let tooltip = "Select Model (Search / ↑↓ / PgUp/PgDn / Home/End / Enter / Esc)";

    if (activeItem?.requiresConfig) {
      label = `⚠️ ${label}`;
      tooltip = `${activeItem.configHint || "需要配置 API key"} - ${tooltip}`;
    }

    modelBtnDisp?.dispose?.();
    modelBtnDisp = (window as any).zion.statusBar.registerItem({
      id: "langchain.chat.model",
      text: `Model: ${label}`,
      tooltip,
      onClick: () => (window as any).zion.commands.executeCommand("models.openSwitcher")
    });
  };
  updateModelBtn();
  context.subscriptions.push(
    (window as any).zion.state.onDidChange("chat.activeModel", updateModelBtn),
    (window as any).zion.state.onDidChange("models.catalog", updateModelBtn)
  );

  // Register models management tools
  try { registerModelsTools(); } catch {}
}
