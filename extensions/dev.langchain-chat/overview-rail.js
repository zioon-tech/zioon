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

function getOverviewLines(text) {
  return String(text || "").replace(/\r/g, "").split("\n");
}

function findAssistantBlockRangeFromLines(lines, preferredHeadLine) {
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

export function findAssistantBlockRange(text, preferredHeadLine) {
  return findAssistantBlockRangeFromLines(getOverviewLines(text), preferredHeadLine);
}

function findTrailingUserPromptLine(lines, assistantRange) {
  if (!assistantRange || typeof assistantRange.endLine !== "number") return null;
  const targetLine = assistantRange.endLine + 1;
  if (targetLine < lines.length && USER_HEAD_RE.test(lines[targetLine] || "")) {
    return targetLine;
  }
  return null;
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

function compactUserMessageText(value, maxLength = 96) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "空 user 消息";
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…` : text;
}

function collectUserMessageItemsFromLines(lines) {
  const items = [];
  const addItem = (line, endLine, previewLines) => {
    items.push({
      line,
      endLine,
      index: items.length + 1,
      preview: compactUserMessageText(previewLines.join(" "))
    });
  };
  const firstRoleLine = lines.findIndex((line) => ROLE_HEAD_RE.test(line || ""));
  const implicitEndLine = firstRoleLine === -1 ? lines.length - 1 : firstRoleLine - 1;
  if (implicitEndLine >= 0) {
    const previewLines = [];
    let previewLength = 0;
    for (let i = 0; i <= implicitEndLine; i++) {
      const bodyLine = String(lines[i] || "").trim();
      if (!bodyLine || previewLength >= 120) continue;
      previewLines.push(bodyLine);
      previewLength += bodyLine.length + 1;
    }
    if (previewLines.length) {
      addItem(0, implicitEndLine, previewLines);
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (!USER_HEAD_RE.test(lines[i] || "")) continue;
    let endLine = i;
    const previewLines = [];
    const firstLine = String(lines[i] || "").replace(USER_HEAD_RE, "").trim();
    if (firstLine) previewLines.push(firstLine);
    let previewLength = firstLine.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (ROLE_HEAD_RE.test(lines[j] || "")) break;
      endLine = j;
      const bodyLine = String(lines[j] || "").trim();
      if (bodyLine && previewLength < 120) {
        previewLines.push(bodyLine);
        previewLength += bodyLine.length + 1;
      }
    }
    addItem(i, endLine, previewLines);
    i = endLine;
  }
  return items;
}

export function collectUserMessageItemsFromText(text) {
  return collectUserMessageItemsFromLines(getOverviewLines(text));
}

function getUserRoleBlocks(view) {
  try {
    const blocks = window.zion?.roles?.getBlocks?.(view);
    if (Array.isArray(blocks) && blocks.length) {
      return blocks
        .filter((block) => block?.role === "user" && typeof block.startLine === "number")
        .sort((a, b) => a.startLine - b.startLine);
    }
  } catch {}
  return null;
}

function computeUserNavState(view, knownUserMessages = null) {
  const doc = view?.state?.doc;
  if (!view || !doc) return { userLines: [], prevLine: null, nextLine: null };
  const roleBlocks = getUserRoleBlocks(view);
  const userLines = roleBlocks
    ? roleBlocks.map((block) => block.startLine)
    : (knownUserMessages || collectUserMessageItemsFromText(doc.toString())).map((item) => item.line);
  if (!userLines.length) return { userLines, prevLine: null, nextLine: null };

  const cursorLine = Math.max(0, doc.lineAt(view.state.selection.main.head).number - 1);
  if (roleBlocks) {
    let nextIndex = roleBlocks.findIndex((block) => block.startLine > cursorLine);
    if (nextIndex === -1) nextIndex = roleBlocks.length;
    const prevIndex = nextIndex - 1;
    const currentIndex = roleBlocks.findIndex((block) => {
      const startLine = typeof block?.startLine === "number" ? block.startLine : null;
      const endLine = typeof block?.endLine === "number" ? block.endLine : startLine;
      return startLine != null && cursorLine >= startLine && cursorLine <= endLine;
    });

    let prevLine = null;
    let nextLine = null;
    if (currentIndex >= 0 && cursorLine !== roleBlocks[currentIndex].startLine) {
      prevLine = roleBlocks[currentIndex].startLine;
    } else {
      const targetIndex = currentIndex >= 0 ? currentIndex - 1 : prevIndex;
      if (targetIndex >= 0) prevLine = roleBlocks[targetIndex].startLine;
    }
    if (currentIndex >= 0 && cursorLine !== roleBlocks[currentIndex].startLine) {
      nextLine = roleBlocks[currentIndex].startLine;
    } else if (nextIndex < roleBlocks.length) {
      nextLine = roleBlocks[nextIndex].startLine;
    }
    return { userLines, prevLine, nextLine };
  }

  let prevLine = null;
  let nextLine = null;
  for (const line of userLines) {
    if (line < cursorLine) prevLine = line;
    if (line > cursorLine) {
      nextLine = line;
      break;
    }
  }
  if (!USER_HEAD_RE.test(doc.sliceString(doc.line(cursorLine + 1).from, doc.line(cursorLine + 1).to))) {
    for (let i = userLines.length - 1; i >= 0; i--) {
      if (userLines[i] <= cursorLine) {
        prevLine = userLines[i];
        break;
      }
    }
  }
  return { userLines, prevLine, nextLine };
}

function isLineVisible(view, lineIndex) {
  try {
    const doc = view?.state?.doc;
    if (!view || !doc || typeof lineIndex !== "number" || lineIndex < 0) return false;
    const line = doc.line(Math.max(1, Math.min(doc.lines, lineIndex + 1)));
    const block = view.lineBlockAt(line.from);
    const scrollDOM = view.scrollDOM;
    const viewportTop = scrollDOM.scrollTop;
    const viewportBottom = viewportTop + scrollDOM.clientHeight;
    return block.top >= viewportTop && block.bottom <= viewportBottom;
  } catch {
    return false;
  }
}

export function jumpToLine(view, lineIndex) {
  if (!view || typeof lineIndex !== "number" || lineIndex < 0) return false;
  try {
    const doc = view.state.doc;
    const line = doc.line(Math.max(1, Math.min(doc.lines, lineIndex + 1)));
    const scrollDOM = view.scrollDOM;
    const commentList = view.dom?.closest?.(".zion-comments-list");
    const wasVisible = isLineVisible(view, lineIndex);
    const outerScrollTop = Number(commentList?.scrollTop) || 0;
    view.dispatch({ selection: { anchor: line.from } });
    const block = view.lineBlockAt?.(line.from);
    const maxScrollTop = Math.max(
      0,
      Number(scrollDOM?.scrollHeight || 0) - Number(scrollDOM?.clientHeight || 0)
    );
    const targetScrollTop = wasVisible
      ? Number(scrollDOM?.scrollTop) || 0
      : Math.max(
        0,
        Math.min(
          maxScrollTop,
          Number(block?.top || 0)
            - Math.max(0, (Number(scrollDOM?.clientHeight || 0) - Number(block?.height || 0)) / 2)
        )
      );
    if (scrollDOM) {
      scrollDOM.__zionProgrammaticScrollUntil = Math.max(
        Number(scrollDOM.__zionProgrammaticScrollUntil) || 0,
        Date.now() + 240
      );
      scrollDOM.scrollTop = targetScrollTop;
    }
    try {
      view.contentDOM?.focus?.({ preventScroll: true });
    } catch {
      view.focus?.();
    }
    if (commentList) commentList.scrollTop = outerScrollTop;
    try {
      requestAnimationFrame(() => {
        if (scrollDOM) scrollDOM.scrollTop = targetScrollTop;
        if (commentList) commentList.scrollTop = outerScrollTop;
      });
    } catch {}
    try {
      window.dispatchEvent(new CustomEvent("zion:roles-nav-flash", {
        detail: { view, lineIndex }
      }));
    } catch {}
    return true;
  } catch {}
  return false;
}

function isAltKeyEvent(event) {
  return event?.key === "Alt" || event?.code === "AltLeft" || event?.code === "AltRight";
}

function getBottomSafeMargin(scrollDOM, baseMargin = 48) {
  try {
    const scrollRect = scrollDOM?.getBoundingClientRect?.();
    if (!scrollRect) return baseMargin;
    const selectors = ["#bottombar", "#statusbar"];
    let overlap = 0;
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const style = window.getComputedStyle?.(el);
      if (style?.display === "none" || style?.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      if (rect.right <= scrollRect.left || rect.left >= scrollRect.right) continue;
      const bottomOverlap = Math.max(0, scrollRect.bottom - rect.top);
      overlap = Math.max(overlap, Math.min(rect.height, bottomOverlap));
    }
    return baseMargin + Math.ceil(overlap) + (overlap > 0 ? 8 : 0);
  } catch {}
  return baseMargin;
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

function createUserHistoryItem(item, current, onSelect) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `zion-chat-overview-user-item${current ? " is-current" : ""}`;
  button.title = `第 ${item.line + 1} 行：${item.preview}`;
  button.setAttribute("aria-label", button.title);
  button.dataset.line = String(item.line);
  button.onmousedown = (event) => {
    event.preventDefault();
  };
  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onSelect(item.line);
  };

  const text = document.createElement("span");
  text.className = "zion-chat-overview-user-item-text";
  text.textContent = item.preview;
  button.appendChild(text);
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
  const latestBtn = createNavButton("zion-chat-overview-nav-latest", "新", "最新", "回到最新回答并恢复自动跟随");
  navDock.appendChild(prevUserBtn);
  navDock.appendChild(nextUserBtn);
  navDock.appendChild(latestBtn);
  const userHistory = document.createElement("div");
  userHistory.className = "zion-chat-overview-user-menu";
  userHistory.setAttribute("aria-label", "历史 user 消息");
  const userHistoryList = document.createElement("div");
  userHistoryList.className = "zion-chat-overview-user-list";
  userHistory.appendChild(userHistoryList);
  navDock.appendChild(userHistory);

  view.dom.appendChild(rail);
  view.dom.appendChild(navDock);

  let disposed = false;
  let rafId = 0;
  let renderTimer = 0;
  const subscriptions = [];
  const scrollDOM = view.scrollDOM || null;
  let suppressScrollTracking = false;
  let altTapStarted = false;
  let altTapUsedAsModifier = false;
  let lastAltTapAt = 0;
  let userHistorySignature = "";
  let userHistoryOpenTimer = 0;
  let userHistoryPointerInside = false;
  const resizeObserver =
    typeof window.ResizeObserver === "function"
      ? new window.ResizeObserver(() => scheduleRender())
      : null;

  const clearUserHistoryOpenTimer = () => {
    if (!userHistoryOpenTimer) return;
    try { window.clearTimeout(userHistoryOpenTimer); } catch {}
    userHistoryOpenTimer = 0;
  };

  const closeUserHistory = () => {
    clearUserHistoryOpenTimer();
    navDock.classList.remove("is-user-history-open");
  };

  const openUserHistoryNow = () => {
    clearUserHistoryOpenTimer();
    if (!navDock.classList.contains("has-user-history")) return;
    navDock.classList.add("is-user-history-open");
  };

  const scheduleUserHistoryOpen = () => {
    clearUserHistoryOpenTimer();
    if (!navDock.classList.contains("has-user-history")) return;
    userHistoryOpenTimer = window.setTimeout(() => {
      userHistoryOpenTimer = 0;
      if (disposed || !navDock.classList.contains("has-user-history")) return;
      navDock.classList.add("is-user-history-open");
    }, 300);
  };

  const targetMatches = (target, selector) => {
    try {
      return !!target?.closest?.(selector);
    } catch {}
    return false;
  };

  navDock.addEventListener("mouseenter", () => {
    userHistoryPointerInside = true;
  });
  navDock.addEventListener("mouseover", (event) => {
    if (targetMatches(event.target, ".zion-chat-overview-nav-latest")) {
      closeUserHistory();
      return;
    }
    if (targetMatches(event.target, ".zion-chat-overview-nav-prev-user, .zion-chat-overview-nav-next-user, .zion-chat-overview-user-menu")) {
      scheduleUserHistoryOpen();
    }
  });
  navDock.addEventListener("mouseleave", () => {
    userHistoryPointerInside = false;
    closeUserHistory();
  });
  navDock.addEventListener("focusin", (event) => {
    if (targetMatches(event.target, ".zion-chat-overview-nav-latest")) {
      closeUserHistory();
      return;
    }
    openUserHistoryNow();
  });
  navDock.addEventListener("focusout", (event) => {
    const next = event.relatedTarget;
    try {
      if (next && navDock.contains(next)) return;
    } catch {}
    if (userHistoryPointerInside) return;
    closeUserHistory();
  });

  const revealLatestAnswer = (sessionId, forceFollow = false) => {
    if (!scrollDOM) return;
    if (forceFollow && sessionId) setFollowLatest(sessionId, true);
    const preferredHeadLine = sessionId
      ? window.zion?.state?.get?.(`chat.answerHeadLine.${sessionId}`)
      : undefined;
    const docText = view.state.doc.toString();
    const lines = getOverviewLines(docText);
    const range = findAssistantBlockRangeFromLines(lines, preferredHeadLine);
    if (range) {
      try {
        const trailingUserLine = findTrailingUserPromptLine(lines, range);
        const targetLine = trailingUserLine == null ? range.endLine : trailingUserLine;
        const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, targetLine + 1)));
        const block = view.lineBlockAt(line.to);
        const margin = getBottomSafeMargin(scrollDOM, trailingUserLine == null ? 48 : 72);
        const maxScrollTop = Math.max(0, scrollDOM.scrollHeight - scrollDOM.clientHeight);
        const nextScrollTop = Math.max(0, Math.min(maxScrollTop, block.bottom - scrollDOM.clientHeight + margin));
        try {
          if (sessionId) window.zion?.state?.set?.(`chat.followSuppressUntil.${sessionId}`, Date.now() + 120);
        } catch {}
        window.requestAnimationFrame(() => {
          try {
            suppressScrollTracking = true;
            scrollDOM.scrollTop = nextScrollTop;
          } catch {}
          suppressScrollTracking = false;
          scheduleRender();
        });
        return;
      } catch {}
    }
    scheduleRender();
  };

  prevUserBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const nav = computeUserNavState(view);
    if (nav.prevLine == null) return;
    const sessionId = getEditorSessionId(editor);
    if (sessionId) setFollowLatest(sessionId, false);
    jumpToLine(view, nav.prevLine);
    openUserHistoryNow();
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
    openUserHistoryNow();
    scheduleRender();
  };

  latestBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeUserHistory();
    const sessionId = getEditorSessionId(editor);
    if (!sessionId) return;
    revealLatestAnswer(sessionId, true);
  };

  const revealLatestForActiveEditor = () => {
    const sessionId = getEditorSessionId(editor);
    if (!sessionId) return false;
    revealLatestAnswer(sessionId, true);
    return true;
  };

  const renderUserHistory = (items, cursorLine, sessionId) => {
    const signature = [
      sessionId || "",
      cursorLine,
      items.map((item) => `${item.line}:${item.endLine}:${item.preview}`).join("\u0000")
    ].join("\u0001");
    navDock.classList.toggle("has-user-history", items.length > 0);
    if (!items.length) closeUserHistory();
    if (signature === userHistorySignature) return;
    userHistorySignature = signature;
    userHistoryList.replaceChildren();
    for (const item of items) {
      const current = cursorLine >= item.line && cursorLine <= item.endLine;
      userHistoryList.appendChild(createUserHistoryItem(item, current, (line) => {
        if (sessionId) setFollowLatest(sessionId, false);
        jumpToLine(view, line);
        openUserHistoryNow();
        scheduleRender();
      }));
    }
    const currentItem = userHistoryList.querySelector(".zion-chat-overview-user-item.is-current");
    if (currentItem) {
      try {
        const itemTop = Number(currentItem.offsetTop) || 0;
        const itemBottom = itemTop + (Number(currentItem.offsetHeight) || 0);
        const viewportTop = Number(userHistoryList.scrollTop) || 0;
        const viewportBottom = viewportTop + (Number(userHistoryList.clientHeight) || 0);
        if (itemTop < viewportTop) userHistoryList.scrollTop = itemTop;
        else if (itemBottom > viewportBottom) {
          userHistoryList.scrollTop = Math.max(0, itemBottom - userHistoryList.clientHeight);
        }
      } catch {}
    }
  };

  const isThisEditorActive = () => {
    try {
      const active = document.activeElement;
      return !!active && view.dom.contains(active);
    } catch {}
    return false;
  };

  const onKeyDown = (event) => {
    if (disposed || !isThisEditorActive()) return;
    if (isAltKeyEvent(event) && !event.repeat && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      altTapStarted = true;
      altTapUsedAsModifier = false;
      return;
    }
    if (event.altKey) {
      altTapUsedAsModifier = true;
      lastAltTapAt = 0;
    }
  };

  const onKeyUp = (event) => {
    if (disposed || !isThisEditorActive()) return;
    if (!isAltKeyEvent(event)) return;
    const now = Date.now();
    const isPlainAltTap = altTapStarted && !altTapUsedAsModifier && !event.metaKey && !event.ctrlKey && !event.shiftKey;
    altTapStarted = false;
    altTapUsedAsModifier = false;
    if (!isPlainAltTap) {
      lastAltTapAt = 0;
      return;
    }
    if (lastAltTapAt && now - lastAltTapAt <= 360) {
      lastAltTapAt = 0;
      if (revealLatestForActiveEditor()) {
        event.preventDefault();
        try { event.stopPropagation(); } catch {}
      }
      return;
    }
    lastAltTapAt = now;
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
    navDock.style.setProperty("--zion-chat-overview-rail-height", `${railHeight}px`);
    navDock.style.setProperty("--zion-chat-overview-panel-width", `${Math.max(0, view.dom.clientWidth || 0)}px`);

    const cursorLine = Math.max(0, doc.lineAt(view.state.selection.main.head).number - 1);
    const cursorTop = lineToOffset(cursorLine, lineCount, railHeight, 4);
    cursorEl.style.top = `${cursorTop}px`;
    cursorEl.title = `光标: 第 ${cursorLine + 1} 行`;

    const sessionId = getEditorSessionId(editor);
    const preferredHeadLine = sessionId
      ? window.zion?.state?.get?.(`chat.answerHeadLine.${sessionId}`)
      : undefined;
    const lines = getOverviewLines(doc.toString());
    const range = findAssistantBlockRangeFromLines(lines, preferredHeadLine);
    const isStreaming = sessionId
      ? !!window.zion?.state?.get?.(`chat.runs.${sessionId}`)?.streaming
      : false;
    const followLatest = sessionId ? isFollowLatestEnabled(sessionId) : false;
    const userMessages = collectUserMessageItemsFromLines(lines);
    const userNav = computeUserNavState(view, userMessages);
    renderUserHistory(userMessages, cursorLine, sessionId);

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

  function scheduleRender(delay = 0) {
    if (disposed) return;
    if (renderTimer) {
      window.clearTimeout(renderTimer);
      renderTimer = 0;
    }
    if (delay > 0) {
      renderTimer = window.setTimeout(() => {
        renderTimer = 0;
        scheduleRender();
      }, delay);
      return;
    }
    if (rafId) window.cancelAnimationFrame(rafId);
    rafId = window.requestAnimationFrame(render);
  }

  try {
    editor.addVisualExtension(
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          scheduleRender(120);
        } else if (
          update.selectionSet ||
          update.geometryChanged ||
          update.viewportChanged
        ) {
          if (!renderTimer) scheduleRender();
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

  try {
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    subscriptions.push({
      dispose() {
        window.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("keyup", onKeyUp, true);
      }
    });
  } catch {}

  scheduleRender();

  return {
    dispose() {
      disposed = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      if (renderTimer) window.clearTimeout(renderTimer);
      try {
        resizeObserver?.disconnect();
      } catch {}
      closeUserHistory();
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
