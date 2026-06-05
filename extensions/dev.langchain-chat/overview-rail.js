import { EditorView } from "@codemirror/view";

const ROLE_HEAD_RE = /^\s*(system|user|assistant|tool)\s+/;
const ASSISTANT_HEAD_RE = /^\s*assistant\s+/;
const USER_HEAD_RE = /^\s*user\s+/;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getPanelSessionId(panelId) {
  if (!panelId) return null;
  try {
    return window.zion?.panels?.list?.().find((panel) => panel.id === panelId)?.activeTabId || null;
  } catch {}
  return null;
}

function getEditorSessionId(editor) {
  try {
    const direct = editor?.getSessionId?.() || editor?.sessionId || editor?.core?.getSessionId?.() || editor?.core?.sessionId;
    if (direct) return String(direct);
  } catch {}
  const panelId = editor?.panelId || null;
  if (panelId) {
    return getPanelSessionId(panelId);
  }
  try {
    return window.zion?.state?.get?.("sessions.currentId") || null;
  } catch {}
  return null;
}

function getFollowStateKey(sessionId) {
  return sessionId ? `chat.followLatest.${sessionId}` : null;
}

function isFollowLatestEnabled(sessionId) {
  const key = getFollowStateKey(sessionId);
  if (!key) return false;
  try {
    return window.zion?.state?.get?.(key) !== false;
  } catch {}
  return true;
}

function setFollowLatest(sessionId, value) {
  const key = getFollowStateKey(sessionId);
  if (!key) return;
  try {
    window.zion?.state?.set?.(key, !!value);
  } catch {}
}

function resolveAssistantHeadLine(lines, preferredHeadLine) {
  if (!Array.isArray(lines) || lines.length === 0) return -1;

  if (
    typeof preferredHeadLine === "number" &&
    preferredHeadLine >= 0 &&
    preferredHeadLine < lines.length &&
    ASSISTANT_HEAD_RE.test(lines[preferredHeadLine] || "")
  ) {
    return preferredHeadLine;
  }

  if (typeof preferredHeadLine === "number" && preferredHeadLine >= 0) {
    for (let i = preferredHeadLine; i < lines.length; i++) {
      if (ASSISTANT_HEAD_RE.test(lines[i] || "")) return i;
    }
    for (let i = Math.min(preferredHeadLine, lines.length - 1); i >= 0; i--) {
      if (ASSISTANT_HEAD_RE.test(lines[i] || "")) return i;
    }
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    if (ASSISTANT_HEAD_RE.test(lines[i] || "")) return i;
  }

  return -1;
}

export function findAssistantBlockRange(text, preferredHeadLine) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const headLine = resolveAssistantHeadLine(lines, preferredHeadLine);
  if (headLine < 0) return null;

  let endLine = headLine;
  for (let i = headLine + 1; i < lines.length; i++) {
    if (ROLE_HEAD_RE.test(lines[i] || "")) break;
    endLine = i;
  }

  return {
    headLine,
    endLine,
    lineCount: Math.max(lines.length, 1)
  };
}

function lineToOffset(lineIndex, lineCount, railHeight, markerSize) {
  if (railHeight <= 0) return 0;
  const usableHeight = Math.max(0, railHeight - markerSize);
  if (lineCount <= 1) {
    return usableHeight / 2;
  }
  const ratio = clamp(lineIndex / (lineCount - 1), 0, 1);
  return ratio * usableHeight;
}

function computeRangeLayout(range, railHeight) {
  if (!range || railHeight <= 0) return null;

  const minHeight = 14;
  const start = lineToOffset(range.headLine, range.lineCount, railHeight, minHeight);
  const end = lineToOffset(range.endLine, range.lineCount, railHeight, minHeight) + minHeight;
  const top = clamp(start, 0, Math.max(0, railHeight - minHeight));
  const height = clamp(Math.max(minHeight, end - start), minHeight, railHeight);

  return {
    top,
    height
  };
}

function createHiddenState(el) {
  if (!el) return;
  el.classList.add("is-hidden");
}

function clearHiddenState(el) {
  if (!el) return;
  el.classList.remove("is-hidden");
}

function getUserHeadLines(doc) {
  const lines = [];
  if (!doc) return lines;
  try {
    for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
      const line = doc.line(lineNo);
      if (USER_HEAD_RE.test(doc.sliceString(line.from, line.to))) {
        lines.push(lineNo - 1);
      }
    }
  } catch {}
  return lines;
}

function computeUserNavState(view) {
  const doc = view?.state?.doc;
  if (!view || !doc) return { userLines: [], prevLine: null, nextLine: null };
  const userLines = getUserHeadLines(doc);
  if (!userLines.length) return { userLines, prevLine: null, nextLine: null };

  const cursorLine = Math.max(0, doc.lineAt(view.state.selection.main.head).number - 1);
  let prevLine = null;
  let nextLine = null;

  for (const line of userLines) {
    if (line < cursorLine) prevLine = line;
    if (line > cursorLine) {
      nextLine = line;
      break;
    }
  }

  if (USER_HEAD_RE.test(doc.sliceString(doc.line(cursorLine + 1).from, doc.line(cursorLine + 1).to))) {
    prevLine = prevLine ?? null;
  } else {
    for (let i = userLines.length - 1; i >= 0; i--) {
      if (userLines[i] <= cursorLine) {
        prevLine = userLines[i];
        break;
      }
    }
  }

  return { userLines, prevLine, nextLine };
}

function jumpToLine(view, lineIndex) {
  if (!view || typeof lineIndex !== "number" || lineIndex < 0) return false;
  try {
    const doc = view.state.doc;
    const line = doc.line(Math.max(1, Math.min(doc.lines, lineIndex + 1)));
    view.dispatch({
      selection: { anchor: line.from },
      scrollIntoView: true
    });
    view.focus?.();
    try {
      window.dispatchEvent(new CustomEvent("zion:roles-nav-flash", {
        detail: { view, lineIndex }
      }));
    } catch {}
    return true;
  } catch {}
  return false;
}

function createNavButton(className, symbol, label, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `zion-chat-overview-nav-btn ${className}`;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = `<span class="zion-chat-overview-nav-symbol" aria-hidden="true">${symbol}</span><span class="zion-chat-overview-nav-label">${label}</span>`;
  return button;
}

export function createChatOverviewRail(editor) {
  const view = editor?.getView?.();
  if (!view?.dom) {
    return { dispose() {} };
  }

  const rail = document.createElement("div");
  rail.className = "zion-chat-overview-rail";

  const assistantRangeEl = document.createElement("div");
  assistantRangeEl.className = "zion-chat-overview-marker zion-chat-overview-marker-assistant is-hidden";
  rail.appendChild(assistantRangeEl);

  const cursorEl = document.createElement("div");
  cursorEl.className = "zion-chat-overview-marker zion-chat-overview-marker-cursor";
  rail.appendChild(cursorEl);

  const navDock = document.createElement("div");
  navDock.className = "zion-chat-overview-nav";
  navDock.setAttribute("aria-label", "聊天导航");
  const prevUserBtn = createNavButton("zion-chat-overview-nav-prev-user", "↑", "上问", "跳到上一个 user 行");
  const nextUserBtn = createNavButton("zion-chat-overview-nav-next-user", "↓", "下问", "跳到下一个 user 行");
  const latestBtn = createNavButton("zion-chat-overview-nav-latest", "A", "最新", "回到最新回答并恢复自动跟随");
  navDock.appendChild(prevUserBtn);
  navDock.appendChild(nextUserBtn);
  navDock.appendChild(latestBtn);

  view.dom.appendChild(rail);
  view.dom.appendChild(navDock);

  let disposed = false;
  let rafId = 0;
  const subscriptions = [];
  const scrollDOM = view.scrollDOM || null;
  let suppressScrollTracking = false;
  const resizeObserver =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => scheduleRender())
      : null;

  const revealLatestAnswer = (sessionId, forceFollow = false) => {
    if (!scrollDOM) return;
    if (forceFollow && sessionId) setFollowLatest(sessionId, true);
    const preferredHeadLine = sessionId
      ? window.zion?.state?.get?.(`chat.answerHeadLine.${sessionId}`)
      : undefined;
    const range = findAssistantBlockRange(view.state.doc.toString(), preferredHeadLine);
    const margin = 24;
    let nextScrollTop = null;
    if (range) {
      try {
        const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, range.endLine + 1)));
        const block = view.lineBlockAt(line.to);
        const visibleTop = scrollDOM.scrollTop + margin;
        const visibleBottom = scrollDOM.scrollTop + scrollDOM.clientHeight - margin;
        if (block.bottom > visibleBottom) {
          nextScrollTop = Math.max(0, block.bottom - scrollDOM.clientHeight + margin);
        } else if (block.top < visibleTop) {
          nextScrollTop = Math.max(0, block.top - margin);
        }
      } catch {}
    }
    if (nextScrollTop == null) {
      scheduleRender();
      return;
    }
    try {
      if (sessionId) window.zion?.state?.set?.(`chat.followSuppressUntil.${sessionId}`, Date.now() + 80);
    } catch {}
    window.requestAnimationFrame(() => {
      try {
        suppressScrollTracking = true;
        scrollDOM.scrollTop = nextScrollTop;
      } catch {}
      suppressScrollTracking = false;
      scheduleRender();
    });
  };

  prevUserBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const nav = computeUserNavState(view);
    if (nav.prevLine == null) return;
    const sessionId = getEditorSessionId(editor);
    if (sessionId) setFollowLatest(sessionId, false);
    jumpToLine(view, nav.prevLine);
    scheduleRender();
  };

  nextUserBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const nav = computeUserNavState(view);
    if (nav.nextLine == null) return;
    const sessionId = getEditorSessionId(editor);
    if (sessionId) setFollowLatest(sessionId, false);
    jumpToLine(view, nav.nextLine);
    scheduleRender();
  };

  latestBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const sessionId = getEditorSessionId(editor);
    if (!sessionId) return;
    revealLatestAnswer(sessionId, true);
  };

  const render = () => {
    rafId = 0;
    if (disposed) return;
    if (!view.dom.isConnected) return;
    if (!view.dom.contains(rail)) {
      view.dom.appendChild(rail);
    }
    if (!view.dom.contains(navDock)) {
      view.dom.appendChild(navDock);
    }

    const doc = view.state.doc;
    const lineCount = Math.max(doc.lines, 1);
    const railHeight = Math.max(0, (scrollDOM?.clientHeight || view.dom.clientHeight || 0) - 4);
    rail.style.setProperty("--zion-chat-overview-rail-height", `${railHeight}px`);

    const cursorLine = Math.max(0, doc.lineAt(view.state.selection.main.head).number - 1);
    const cursorTop = lineToOffset(cursorLine, lineCount, railHeight, 4);
    cursorEl.style.top = `${cursorTop}px`;
    cursorEl.title = `光标: 第 ${cursorLine + 1} 行`;

    const sessionId = getEditorSessionId(editor);
    const preferredHeadLine = sessionId
      ? window.zion?.state?.get?.(`chat.answerHeadLine.${sessionId}`)
      : undefined;
    const range = findAssistantBlockRange(doc.toString(), preferredHeadLine);
    const isStreaming = sessionId
      ? !!window.zion?.state?.get?.(`chat.runs.${sessionId}`)?.streaming
      : false;
    const followLatest = sessionId ? isFollowLatestEnabled(sessionId) : false;
    const userNav = computeUserNavState(view);

    assistantRangeEl.classList.toggle("is-streaming", isStreaming);
    navDock.classList.toggle("is-hidden", userNav.userLines.length === 0 && !range);
    prevUserBtn.disabled = userNav.prevLine == null;
    nextUserBtn.disabled = userNav.nextLine == null;
    latestBtn.disabled = !sessionId || !range;
    latestBtn.classList.toggle("is-detached", !!sessionId && !!range && !followLatest);
    latestBtn.classList.toggle("is-streaming", !!range && isStreaming);

    if (!range || railHeight <= 0) {
      createHiddenState(assistantRangeEl);
      return;
    }

    const layout = computeRangeLayout(range, railHeight);
    if (!layout) {
      createHiddenState(assistantRangeEl);
      return;
    }

    assistantRangeEl.style.top = `${layout.top}px`;
    assistantRangeEl.style.height = `${layout.height}px`;
    assistantRangeEl.title = `Assistant: 第 ${range.headLine + 1}-${range.endLine + 1} 行`;
    clearHiddenState(assistantRangeEl);

    latestBtn.title = followLatest
      ? "正在跟随最新回答，点击可重新定位到回答位置"
      : "回到最新回答并恢复自动跟随";
    latestBtn.setAttribute("aria-label", latestBtn.title);
  };

  function scheduleRender() {
    if (disposed) return;
    if (rafId) window.cancelAnimationFrame(rafId);
    rafId = window.requestAnimationFrame(render);
  }

  try {
    editor.addVisualExtension(
      EditorView.updateListener.of((update) => {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.geometryChanged ||
          update.viewportChanged
        ) {
          scheduleRender();
        }
      })
    );
  } catch {}

  try {
    resizeObserver?.observe(view.dom);
  } catch {}
  try {
    if (scrollDOM) resizeObserver?.observe(scrollDOM);
  } catch {}

  if (scrollDOM) {
    const onWheel = () => {
      const sessionId = getEditorSessionId(editor);
      if (!sessionId) return;
      if (!isFollowLatestEnabled(sessionId)) return;
      setFollowLatest(sessionId, false);
      scheduleRender();
    };
    const onScroll = () => {
      scheduleRender();
      const sessionId = getEditorSessionId(editor);
      if (!sessionId || suppressScrollTracking) return;
      const isStreaming = !!window.zion?.state?.get?.(`chat.runs.${sessionId}`)?.streaming;
      if (!isStreaming) return;
      if (!isFollowLatestEnabled(sessionId)) return;
      const suppressUntil = Number(window.zion?.state?.get?.(`chat.followSuppressUntil.${sessionId}`) || 0);
      if (suppressUntil > Date.now()) return;
      const distanceToBottom = scrollDOM.scrollHeight - scrollDOM.scrollTop - scrollDOM.clientHeight;
      if (distanceToBottom > 12) {
        setFollowLatest(sessionId, false);
        scheduleRender();
      }
    };
    scrollDOM.addEventListener("wheel", onWheel, { passive: true });
    scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    subscriptions.push({
      dispose() {
        scrollDOM.removeEventListener("wheel", onWheel);
        scrollDOM.removeEventListener("scroll", onScroll);
      }
    });
  }

  const panelId = editor?.panelId || null;
  const rerenderEvents = [
    "chat/runStarted",
    "chat/token",
    "chat/runFinished",
    "chat/aborted",
    "chat/runError"
  ];
  for (const topic of rerenderEvents) {
    try {
      subscriptions.push(
        window.zion.events.on(topic, (payload) => {
          const targetSessionId = getEditorSessionId(editor);
          if (!payload?.sessionId || !targetSessionId || payload.sessionId === targetSessionId) {
            if (topic === "chat/runStarted" && payload?.sessionId === targetSessionId) {
              setFollowLatest(targetSessionId, true);
            }
            scheduleRender();
          }
        })
      );
    } catch {}
  }

  try {
    subscriptions.push(
      window.zion.events.on("panel/tabActivated", (payload) => {
        if (!panelId || payload?.panelId === panelId) {
          scheduleRender();
        }
      })
    );
  } catch {}

  try {
    subscriptions.push(
      window.zion.state.onDidChange("sessions.currentId", () => {
        if (!panelId) scheduleRender();
      })
    );
  } catch {}

  try {
    subscriptions.push(
      window.zion.state.onDidChange("chat.streaming", () => {
        scheduleRender();
      })
    );
  } catch {}
  try {
    subscriptions.push(
      window.zion.state.onDidChange("sessions.currentId", () => {
        scheduleRender();
      })
    );
  } catch {}

  try {
    window.addEventListener("resize", scheduleRender, { passive: true });
    subscriptions.push({
      dispose() {
        window.removeEventListener("resize", scheduleRender);
      }
    });
  } catch {}

  scheduleRender();

  return {
    dispose() {
      disposed = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      try {
        resizeObserver?.disconnect();
      } catch {}
      for (const sub of subscriptions) {
        try {
          sub?.dispose?.();
        } catch {}
      }
      try {
        rail.remove();
      } catch {}
      try {
        navDock.remove();
      } catch {}
    }
  };
}
