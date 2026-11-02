import { EditorView } from "@codemirror/view";
import { currentAccountSession } from "../../packages/account-ui/src/client";

const LABELS = { active: "进行中", paused: "已暂停", interrupted: "运行中断",
  blocked: "等待处理", budget_exhausted: "预算已用尽", completed: "已完成", cancelled: "已取消" };
const REASONS = {
  "user-pause": "目标已暂停，可以调整后继续。", "runtime-restarted": "服务曾重启，继续时会先检查已有结果。",
  "run-limit": "本轮运行次数已用完，可检查进展后继续。", "token-budget": "请增加累计 token 预算后继续。",
  "time-budget": "请设置新的运行时长后继续。", "no-observable-progress": "连续三轮没有新的可验证进展。",
  "unknown-tool-outcome": "有工具结果尚未确认，继续时需先核验。"
};
const terminal = (goal) => ["completed", "cancelled"].includes(goal?.status);
const format = (value) => new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);

export const inspectorStyles = `
.zion-goal-chrome[hidden],.zion-goal-inspector[hidden]{display:none!important}
.zion-goal-chrome{display:flex;align-items:center;gap:4px;flex:0 1 auto;min-width:0;margin-left:auto;font-size:12px;position:relative;z-index:50}
.zion-goal-chrome button,.zion-goal-inspector button{font:inherit;color:var(--fg);border:0;border-radius:4px;background:transparent;cursor:pointer;padding:4px 7px}
.zion-goal-chrome button:hover,.zion-goal-inspector button:hover{background:var(--surface-raised,var(--bg))}
.zion-goal-chrome button:focus-visible,.zion-goal-inspector button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.zion-goal-chrome button:disabled,.zion-goal-inspector button:disabled{opacity:.5;cursor:default}
.zion-goal-trigger{display:flex;align-items:center;gap:6px;min-width:0;max-width:230px;white-space:nowrap;position:relative}
.zion-goal-trigger span:last-child{overflow:hidden;text-overflow:ellipsis}
.zion-goal-trigger::after{content:attr(data-tooltip);position:absolute;z-index:80;right:0;top:calc(100% + 7px);width:max-content;max-width:min(320px,70vw);padding:8px 10px;border:1px solid var(--surface-border-soft,var(--border));border-radius:5px;background:var(--surface-raised,var(--bg));color:var(--fg);box-shadow:0 8px 24px #0003;font:12px/1.45 var(--font-ui,system-ui);white-space:pre-line;text-align:left;overflow-wrap:anywhere;opacity:0;visibility:hidden;transform:translateY(-2px);transition:opacity 100ms ease,transform 100ms ease,visibility 100ms;pointer-events:none}
.zion-goal-trigger:hover::after,.zion-goal-trigger:focus-visible::after{opacity:1;visibility:visible;transform:translateY(0)}
.zion-goal-dot{width:6px;height:6px;border-radius:50%;background:var(--icon-muted,var(--fg));flex:none}
.zion-goal-chrome[data-status=active] .zion-goal-dot{background:var(--accent)}
.zion-goal-chrome[data-status=completed],.zion-goal-chrome[data-status=cancelled]{opacity:.65}
.zion-goal-auxiliary-host{height:100%;min-height:0}
.zion-goal-inspector{height:100%;box-sizing:border-box;overflow:auto;background:var(--surface-panel,var(--bg));color:var(--fg);font:12px/1.6 var(--font-ui,system-ui);padding:14px 16px}
.zion-goal-section{padding:12px 0;border-top:1px solid var(--surface-border-soft,var(--border))}
.zion-goal-section h3{font:inherit;font-weight:600;margin:0 0 8px}
.zion-goal-text{white-space:pre-wrap;overflow-wrap:anywhere}
.zion-goal-muted{color:var(--icon-muted,var(--fg));font-size:11px}
.zion-goal-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.zion-goal-inspector .zion-goal-primary{background:var(--accent);color:var(--accent-fg,#fff)}
.zion-goal-inspector textarea,.zion-goal-inspector input{box-sizing:border-box;width:100%;font:inherit;color:inherit;background:var(--editor-bg,var(--bg));border:1px solid var(--surface-border-soft,var(--border));border-radius:4px;padding:7px;margin:4px 0}
.zion-goal-inspector textarea{resize:vertical;min-height:90px}
.zion-goal-inspector label{display:block;margin-top:6px}
.zion-goal-record{display:block;text-align:left;width:100%;margin:4px 0}
.zion-goal-record small{display:block;opacity:.65;white-space:pre-wrap;overflow-wrap:anywhere}
.zion-goal-inspector ol{padding-left:20px;margin:4px 0}
.zion-goal-output{font:12px/1.6 var(--font-mono,monospace);white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}
@media(max-width:600px){.zion-goal-trigger{max-width:140px}}
`;

export function createGoalInspector(editor, { zion, sessionFor, command, start, notify, auxiliary, disposed }) {
  const view = editor.getView?.();
  const root = view?.dom.closest(".zion-panel");
  const header = root?.querySelector(".zion-editor-header");
  if (!header) return { refresh: async () => {}, dispose() {}, clear() {}, showDetails() {} };
  const chrome = document.createElement("div"); chrome.className = "zion-goal-chrome"; chrome.hidden = true;
  const drawer = document.createElement("aside"); drawer.className = "zion-goal-inspector"; drawer.hidden = true;
  drawer.setAttribute("aria-label", "目标详情");
  drawer.id = `goal-inspector-${crypto.randomUUID()}`;
  header.querySelector(".zion-editor-session-path")?.after(chrome);
  if (!chrome.parentNode) header.append(chrome);
  (auxiliary?.host || root).append(drawer);
  let goal = null, alive = true, busy = false, opened = false, editing = false, renderedSession = "", ticket = 0;
  let records = null, detail = null, detailLoading = false, requestTicket = 0, returnFocus = null, error = "";
  let chromeKey = "";
  const visible = () => {
    const panel = zion.panels?.list?.().find((item) => item.id === editor.panelId);
    if (panel && panel.activeTabId !== sessionFor(editor)) return false;
    return zion.sessions?.isEditorShowingSession?.(editor, sessionFor(editor)) ?? true;
  };
  const syncVisibility = () => {
    const showing = visible() && !!renderedSession;
    chrome.hidden = !showing || !goal;
    drawer.hidden = !showing || !opened;
  };
  const text = (parent, value, className = "zion-goal-text") => {
    const node = document.createElement("div"); node.className = className;
    node.textContent = String(value || ""); parent.append(node); return node;
  };
  const button = (parent, label, action, className = "") => {
    const node = document.createElement("button"); node.type = "button"; node.textContent = label;
    node.className = className; node.disabled = busy;
    node.onclick = async () => {
      if (!alive || busy || !visible() || sessionFor(editor) !== renderedSession) return;
      const session = renderedSession, account = currentAccountSession();
      busy = true; node.disabled = true;
      for (const control of chrome.querySelectorAll("button")) control.disabled = true;
      if (node.textContent === "暂停") node.textContent = "正在暂停…";
      try { await action(); } catch (err) { notify(err); }
      finally {
        busy = false;
        chromeKey = "";
        if (alive && session === sessionFor(editor) && account === currentAccountSession()) await refresh();
      }
    };
    parent.append(node); return node;
  };
  const section = (title) => {
    const node = document.createElement("section"); node.className = "zion-goal-section";
    const heading = document.createElement("h3"); heading.textContent = title;
    node.append(heading); drawer.append(node); return node;
  };
  const close = () => {
    opened = false; editing = false; drawer.hidden = true;
    chrome.querySelector(".zion-goal-trigger")?.setAttribute("aria-expanded", "false");
    auxiliary?.close?.();
    if (visible()) (returnFocus?.isConnected ? returnFocus : chrome.querySelector(".zion-goal-trigger"))?.focus({ preventScroll: true });
  };
  const showDetails = ({ activate = true, focus = true } = {}) => {
    if (focus) returnFocus = document.activeElement;
    opened = true; render();
    if (activate) auxiliary?.open?.();
    if (focus) drawer.querySelector("button")?.focus({ preventScroll: true });
  };
  drawer.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  });
  // Selection in the editor remains unchanged when inspecting or navigating a result.
  const load = async (args, apply) => {
    const session = renderedSession, id = goal?.id, account = currentAccountSession(), request = ++requestTicket;
    detailLoading = true; render();
    try {
      const result = await command({ action: "status", sessionId: session, goalId: id, ...args });
      if (!alive || request !== requestTicket || session !== sessionFor(editor) || account !== currentAccountSession() || goal?.id !== id) return;
      apply(result); error = "";
    } catch (err) {
      if (alive && request === requestTicket && session === sessionFor(editor) && account === currentAccountSession()) error = err.message;
    } finally {
      if (alive && request === requestTicket) { detailLoading = false; render(); }
    }
  };
  const showRun = async (id, offset = 0) => {
    const marker = `assistant <!-- zion-assistant:id=${id} -->`;
    const position = view.state.doc.toString().indexOf(marker);
    if (position >= 0) view.dispatch({ effects: EditorView.scrollIntoView(position, { y: "start" }) });
    await load({ view: "run", runId: id, offset }, (result) => { detail = result; });
  };
  const render = () => {
    // Polls must not replace a draft form or move focus away from a control.
    const focused = drawer.contains(document.activeElement) ? document.activeElement : null;
    const focusLabel = focused?.textContent, scroll = drawer.scrollTop;
    const draftFields = new Map([...drawer.querySelectorAll("input,textarea")].map((node) => [node.getAttribute("aria-label"), node.value]));
    const chromeFocused = chrome.contains(document.activeElement) ? document.activeElement : null;
    const chromeLabel = chromeFocused?.textContent, triggerFocused = chromeFocused?.classList.contains("zion-goal-trigger");
    const auxiliaryActive = auxiliary?.isActive?.() ?? opened;
    const nextChromeKey = JSON.stringify([renderedSession, goal?.id, goal?.status, goal?.objective, goal?.nextAction, opened, auxiliaryActive, busy]);
    if (chromeKey !== nextChromeKey) {
      chromeKey = nextChromeKey;
      chrome.replaceChildren();
      chrome.dataset.status = goal?.status || "";
      if (goal) {
      const trigger = button(chrome, "", async () =>
        opened && (!auxiliary || auxiliary.isActive?.()) ? close() : showDetails(), "zion-goal-trigger");
      trigger.setAttribute("aria-label", `目标：${LABELS[goal.status] || goal.status}，${goal.objective}`);
      trigger.setAttribute("aria-expanded", String(opened && auxiliaryActive)); trigger.setAttribute("aria-controls", drawer.id);
      const status = LABELS[goal.status] || goal.status;
      const next = goal.nextAction ? `\n下一步：${goal.nextAction}` : goal.reason && !terminal(goal) ? `\n${REASONS[goal.reason] || goal.reason}` : "";
      const tooltip = `${status} · 点击在辅助栏查看\n${goal.objective}${next}`;
      trigger.dataset.tooltip = tooltip;
      const dot = document.createElement("span"); dot.className = "zion-goal-dot"; dot.setAttribute("aria-hidden", "true");
      const label = document.createElement("span"); label.textContent = `${LABELS[goal.status] || goal.status} · ${goal.objective}`;
      trigger.append(dot, label);
      if (goal.status === "active") {
        const pause = button(chrome, busy ? "正在暂停…" : "暂停", () => command({ action: "pause", sessionId: renderedSession }));
        pause.title = "暂停目标并停止当前运行";
      } else if (terminal(goal)) {
        const create = button(chrome, "新目标", () => { close(); return start({}, editor); });
        create.title = "在当前会话开始新目标";
      } else {
        const resume = button(chrome, "继续", () => {
        if (goal.status === "budget_exhausted" || ["token-budget", "time-budget"].includes(goal.reason)) return showDetails();
        return command({ action: "resume", sessionId: renderedSession });
        });
        resume.title = "继续执行当前目标";
      }
      }
    }
    syncVisibility();
    if (chromeFocused) (triggerFocused ? chrome.querySelector(".zion-goal-trigger")
      : [...chrome.querySelectorAll("button")].find((node) => node.textContent === chromeLabel))?.focus({ preventScroll: true });
    if (!opened) return;
    drawer.replaceChildren();
    if (!goal) { text(drawer, error || "当前会话没有持续目标。"); return; }
    text(drawer, goal.objective);
    text(drawer, LABELS[goal.status] || goal.status, "zion-goal-muted");
    if (goal.reason && !terminal(goal)) text(drawer, REASONS[goal.reason] || goal.reason, "zion-goal-muted");
    if (goal.blocker) text(drawer, goal.blocker);
    if (!terminal(goal)) {
      const actions = document.createElement("div"); actions.className = "zion-goal-actions"; drawer.append(actions);
      const edit = button(actions, "调整目标", () => { editing = true; render(); });
      edit.disabled = busy || goal.status === "active" || !!goal.activeRunId;
      if (edit.disabled) edit.title = "暂停并等待当前运行结束后可调整目标";
    }
    if (editing) {
      const part = section("调整目标");
      const input = document.createElement("textarea"); input.value = goal.objective; input.setAttribute("aria-label", "调整目标"); part.append(input);
      button(part, "保存目标", async () => {
        await command({ action: "amend", sessionId: renderedSession, objective: input.value }); editing = false;
      }, "zion-goal-primary");
      button(part, "放弃调整", () => { editing = false; render(); });
    }
    if (goal.nextAction || goal.progress?.length) {
      const part = section("进展");
      for (const item of (goal.progress || []).slice(-4)) {
        text(part, item.note);
        if (item.runId) button(part, "查看这轮记录", () => showRun(item.runId), "zion-goal-muted");
      }
      if (goal.nextAction) { text(part, "下一步", "zion-goal-muted"); text(part, goal.nextAction); }
    }
    if (goal.plan?.length) {
      const part = section("当前计划"), list = document.createElement("ol"); part.append(list);
      for (const item of goal.plan) { const node = document.createElement("li"); node.textContent = item; list.append(node); }
    }
    if (goal.evidence?.length) {
      const part = section("验收引用");
      for (const item of goal.evidence) text(part, `${item.criterion + 1}. ${item.reference}`);
      text(part, "引用由模型报告，请结合运行结果复核。", "zion-goal-muted");
    }
    const budget = section("运行用量");
    text(budget, `${format(goal.tokenUsage)}${goal.tokenBudget ? ` / ${format(goal.tokenBudget)}` : ""} tokens · ${goal.cycles || 0} 轮`);
    if (goal.deadline) text(budget, `时限：${new Date(goal.deadline).toLocaleString("zh-CN")}`, "zion-goal-muted");
    if (!terminal(goal) && goal.status !== "active") {
      const field = (label, name) => {
        const wrapper = document.createElement("label"); wrapper.textContent = label; budget.append(wrapper);
        const input = document.createElement("input"); input.type = "number"; input.min = "1"; input.name = name;
        input.setAttribute("aria-label", label); input.placeholder = "可选"; wrapper.append(input); return input;
      };
      const token = field("新的累计 token 预算", "tokenBudget"), duration = field("运行分钟数", "duration");
      button(budget, "继续运行", () => command({ action: "resume", sessionId: renderedSession,
        tokenBudget: Number(token.value) || undefined, timeBudgetMs: Number(duration.value) * 60000 || undefined }), "zion-goal-primary");
      button(budget, "取消目标", () => command({ action: "cancel", sessionId: renderedSession }));
    }
    const history = section("运行记录");
    if (detailLoading) text(history, "正在读取…", "zion-goal-muted");
    if (error) text(history, error);
    button(history, records ? "刷新记录" : `查看 ${goal.runIds?.length || 0} 轮记录`,
      () => load({ view: "records" }, (result) => { records = result.records; detail = null; }));
    for (const record of records || []) {
      const status = { completed: "已结束", running: "运行中", queued: "等待运行", failed: "失败", aborted: "已中止", unavailable: "记录不可用" }[record.status] || record.status;
      const node = button(history, `${new Date(record.createdAt || goal.createdAt).toLocaleTimeString("zh-CN")} · ${status}`,
        () => showRun(record.id), "zion-goal-record");
      node.title = record.id;
      const preview = document.createElement("small"); preview.textContent = record.preview || record.error || record.terminalReason || ""; node.append(preview);
    }
    if (detail) {
      text(history, `运行 ${detail.id}`, "zion-goal-muted");
      if (detail.reason) text(history, detail.reason);
      const output = document.createElement("pre"); output.className = "zion-goal-output";
      output.textContent = detail.output || "这轮运行尚无文本输出。"; history.append(output);
      for (const operation of detail.operations || []) text(history,
        `${operation.name} · ${{ pending: "执行中", unknown: "结果待核验", completed: "已结束", known: "结果已返回", reconciled: "已核验" }[operation.status] || operation.status}`, "zion-goal-muted");
      if (detail.nextOffset !== null) button(history, "下一段结果", () => showRun(detail.id, detail.nextOffset));
      if (detail.offset) button(history, "从头查看", () => showRun(detail.id));
    }
    for (const node of drawer.querySelectorAll("input,textarea")) {
      if (draftFields.has(node.getAttribute("aria-label"))) node.value = draftFields.get(node.getAttribute("aria-label"));
    }
    drawer.scrollTop = scroll;
    if (focusLabel) [...drawer.querySelectorAll("button")].find((node) => node.textContent === focusLabel)?.focus({ preventScroll: true });
  };
  const clear = () => {
    ticket++; requestTicket++; goal = null; records = null; detail = null; detailLoading = false; opened = false; editing = false; error = "";
    chromeKey = ""; chrome.replaceChildren(); drawer.replaceChildren(); chrome.hidden = true; drawer.hidden = true;
  };
  const refresh = async () => {
    if (!alive || disposed()) return;
    syncVisibility();
    const session = sessionFor(editor), account = currentAccountSession();
    ticket++;
    if (session !== renderedSession) { clear(); renderedSession = session; }
    const currentTicket = ticket;
    if (!session || !visible()) return;
    try {
      const next = await command({ action: "status", sessionId: session });
      if (!alive || disposed() || currentTicket !== ticket || session !== sessionFor(editor) || account !== currentAccountSession()) return;
      if (next?.id !== goal?.id) { records = null; detail = null; requestTicket++; }
      goal = next; error = "";
      if (drawer.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) { syncVisibility(); return; }
      render();
    } catch (err) {
      if (alive && currentTicket === ticket && account === currentAccountSession()) { error = err.message; render(); }
    }
  };
  void refresh();
  return { editor, refresh, clear, showDetails, get sessionId() { return renderedSession; },
    get active() { return goal?.status === "active"; },
    dispose() { alive = false; ticket++; requestTicket++; chrome.remove(); drawer.remove(); } };
}
