import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionsListRendererFactory } from "../extensions/dev.session-manager/ui/list-renderer.js";

describe("sessions list renderer", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.zion = {
      state: {
        get: (key) => key === "comments.activeThreadId" ? "comment-1" : null,
        onDidChange: () => ({ dispose() {} })
      }
    };
  });

  it("updates the current session without rebuilding the list", () => {
    const listEl = document.createElement("div");
    const first = document.createElement("button");
    first.className = "zion-session-row is-session is-current";
    first.dataset.sessionId = "session-1";
    const second = document.createElement("button");
    second.className = "zion-session-row is-session";
    second.dataset.sessionId = "session-2";
    const comment = document.createElement("button");
    comment.className = "zion-session-row zion-session-child-row is-comment";
    comment.dataset.sessionId = "comment-session";
    comment.dataset.childId = "comment-1";
    listEl.append(first, second, comment);

    const createRenderer = createSessionsListRendererFactory({});
    const render = createRenderer({ listEl, hostElement: document.createElement("div") });
    const mountedRow = render.syncCurrentSession("session-2");

    expect(mountedRow).toBe(second);
    expect(first.classList.contains("is-current")).toBe(false);
    expect(second.classList.contains("is-current")).toBe(true);
    expect(comment.classList.contains("is-current")).toBe(true);
    expect(listEl.children).toHaveLength(3);
  });

  it("updates saved session metadata without rebuilding the list", () => {
    const listEl = document.createElement("div");
    const row = document.createElement("button");
    row.className = "zion-session-row is-session";
    row.dataset.sessionId = "session-1";
    const title = document.createElement("span");
    title.className = "zion-session-name";
    title.textContent = "Old title";
    row.appendChild(title);
    listEl.appendChild(row);

    const createRenderer = createSessionsListRendererFactory({
      loadMeta: () => ({ id: "session-1", title: "New title", updatedAt: 2, size: 42 }),
      fmtTime: (value) => String(value),
      now: () => 3
    });
    const render = createRenderer({ listEl, hostElement: document.createElement("div") });
    render.syncSessionIndex([{ id: "session-1", title: "New title" }]);

    expect(title.textContent).toBe("New title");
    expect(row.title).toContain("Updated: 2");
    expect(listEl.children).toHaveLength(1);
  });

  it("renders balanced card details while preserving list mode", () => {
    let viewMode = "card";
    const listWrap = document.createElement("div");
    listWrap.className = "zion-sessions-list";
    const listEl = document.createElement("div");
    listWrap.appendChild(listEl);
    document.body.appendChild(listWrap);
    const tree = {
      id: "root",
      type: "folder",
      title: "Root",
      children: [{ id: "session-1", type: "session", title: "Fallback title" }]
    };
    const meta = {
      id: "session-1",
      title: "Card title",
      documentPreview: "This is the document lead preview.",
      updatedAt: Date.now() - 5 * 60 * 1000,
      size: 42
    };
    const createRenderer = createSessionsListRendererFactory({
      loadTree: () => tree,
      ensureInitialTree: () => tree,
      loadMeta: () => meta,
      truncate: (value) => value,
      setSmallDragImage: () => {},
      fmtTime: (value) => String(value),
      now: () => Date.now(),
      getSelection: () => [],
      setSelection: () => {},
      clearSelection: () => {},
      isSelected: () => false,
      toggleSelection: () => {},
      getLastSelectedId: () => null,
      setLastSelectedId: () => {},
      isFolderOpen: () => true,
      setFolderOpen: () => {},
      moveNode: () => false
    });
    const render = createRenderer({
      listEl,
      hostElement: listWrap,
      getQuery: () => "",
      getSort: () => "updated",
      getViewMode: () => viewMode,
      getSessionTagRecords: () => [
        { path: "project/zion", sourceId: "biography", sourceLabel: "Biography", readOnly: true },
        { path: "topic/ui", sourceId: "document", sourceLabel: "Session", readOnly: false },
        { path: "third/hidden", sourceId: "document", sourceLabel: "Session", readOnly: false }
      ]
    });

    render();
    const card = listEl.querySelector('[data-session-id="session-1"]');
    expect(listWrap.classList.contains("is-card-view")).toBe(true);
    expect(card.querySelector(".zion-session-card-preview").textContent).toBe(meta.documentPreview);
    expect(Array.from(card.querySelectorAll(".zion-session-card-tag")).map((tag) => tag.textContent)).toEqual([
      "#project/zion",
      "#topic/ui"
    ]);
    expect(card.querySelector(".zion-session-card-tag.is-automatic")).toBeTruthy();
    expect(card.querySelector(".zion-session-card-time").textContent).toContain("5");

    viewMode = "list";
    render();
    expect(listWrap.classList.contains("is-card-view")).toBe(false);
    expect(listEl.querySelector(".zion-session-card-preview")).toBeNull();
  });

  it("renders comment sessions only beneath their parent session", () => {
    const listEl = document.createElement("div");
    const tree = {
      id: "root",
      type: "folder",
      title: "Root",
      children: [
        { id: "comment:thread-1", type: "session", title: "Accidental durable comment" },
        { id: "session-1", type: "session", title: "Parent session" }
      ]
    };
    window.zion.commands = {
      executeCommand: vi.fn((id) => id === "comments.listThreadRelations"
        ? [{
            id: "thread-1",
            sessionId: "session-1",
            parentSessionId: "session-1",
            threadSessionId: "comment:thread-1",
            title: "Review this section",
            resolved: false,
            updatedAt: 2
          }]
        : undefined)
    };
    const createRenderer = createSessionsListRendererFactory({
      loadTree: () => tree,
      ensureInitialTree: () => tree,
      loadMeta: (id) => ({ id, title: id, updatedAt: 2, size: 10 }),
      truncate: (value) => value,
      setSmallDragImage: () => {},
      fmtTime: (value) => String(value),
      now: () => 3,
      getSelection: () => [],
      setSelection: () => {},
      clearSelection: () => {},
      isSelected: () => false,
      toggleSelection: () => {},
      getLastSelectedId: () => null,
      setLastSelectedId: () => {},
      isFolderOpen: () => true,
      setFolderOpen: () => {},
      moveNode: () => false
    });
    const render = createRenderer({
      listEl,
      hostElement: document.createElement("div"),
      getQuery: () => "",
      getSort: () => "updated"
    });

    render();

    expect(listEl.querySelector('.zion-session-row.is-session[data-session-id="comment:thread-1"]')).toBeNull();
    expect(listEl.querySelector('.zion-session-child-row[data-session-id="comment:thread-1"]')).toBeTruthy();
    expect(listEl.querySelector('[data-session-id="session-1"]')).toBeTruthy();
  });

  it("renders filtered sessions flat without opening their folders", () => {
    let flat = true;
    let matchId = "nested-match";
    const listEl = document.createElement("div");
    const tree = {
      id: "root",
      type: "folder",
      title: "Root",
      children: [{
        id: "folder-a",
        type: "folder",
        title: "A",
        children: [
          { id: "nested-match", type: "session", title: "Match" },
          { id: "other", type: "session", title: "Other" }
        ]
      }]
    };
    const setFolderOpen = vi.fn();
    const createRenderer = createSessionsListRendererFactory({
      loadTree: () => tree,
      ensureInitialTree: () => tree,
      loadMeta: (id) => ({ id, title: id, updatedAt: id === "nested-match" ? 2 : 1 }),
      truncate: (value) => value,
      setSmallDragImage: () => {},
      fmtTime: (value) => String(value),
      now: () => 3,
      getSelection: () => [],
      setSelection: () => {},
      clearSelection: () => {},
      isSelected: () => false,
      toggleSelection: () => {},
      getLastSelectedId: () => null,
      setLastSelectedId: () => {},
      isFolderOpen: () => false,
      setFolderOpen,
      moveNode: () => false
    });
    const render = createRenderer({
      listEl,
      hostElement: document.createElement("div"),
      getQuery: () => "",
      getSort: () => "updated",
      getSessionFilter: () => (node) => node.id === matchId,
      getFlatSessionResults: () => flat
    });

    render();
    expect(listEl.querySelector('[data-session-id="nested-match"]')).toBeTruthy();
    expect(listEl.querySelector('[data-session-id="other"]')).toBeNull();
    expect(listEl.querySelector('.zion-session-row.is-folder:not([aria-hidden="true"])')).toBeNull();
    expect(setFolderOpen).not.toHaveBeenCalledWith("folder-a", true);

    matchId = "missing";
    render();
    expect(listEl.textContent).toContain("No matching sessions.");

    flat = false;
    render();
    expect(listEl.querySelector(".zion-session-row.is-folder")).toBeTruthy();
    expect(listEl.querySelector('[data-session-id="nested-match"]')).toBeNull();
  });

  it("toggles folder children without changing the selected folder state", () => {
    const listEl = document.createElement("div");
    const openFolders = new Map([["root", true], ["folder-a", true]]);
    const tree = {
      id: "root",
      type: "folder",
      title: "Root",
      children: [{
        id: "folder-a",
        type: "folder",
        title: "A",
        children: [{ id: "session-a", type: "session", title: "Session A" }]
      }]
    };
    const createRenderer = createSessionsListRendererFactory({
      loadTree: () => tree,
      ensureInitialTree: () => tree,
      getIndex: () => [{ id: "session-a" }],
      loadMeta: (id) => ({ id, title: id, updatedAt: 1 }),
      truncate: (value) => value,
      setSmallDragImage: () => {},
      fmtTime: (value) => String(value),
      now: () => 2,
      getSelection: () => [],
      setSelection: () => {},
      clearSelection: () => {},
      isSelected: () => false,
      toggleSelection: () => {},
      getLastSelectedId: () => null,
      setLastSelectedId: () => {},
      isFolderOpen: (id) => openFolders.get(id) === true,
      setFolderOpen: (id, open) => openFolders.set(id, open),
      moveNode: () => false
    });
    const render = createRenderer({
      listEl,
      hostElement: document.createElement("div"),
      getQuery: () => "",
      getSort: () => "updated"
    });

    render();
    expect(listEl.querySelector('[data-session-id="session-a"]')).toBeTruthy();
    listEl.querySelector('.zion-session-row.is-folder[data-depth="0"]').click();
    expect(openFolders.get("folder-a")).toBe(false);
    expect(listEl.querySelector('[data-session-id="session-a"]')).toBeNull();
    listEl.querySelector('.zion-session-row.is-folder[data-depth="0"]').click();
    expect(openFolders.get("folder-a")).toBe(true);
    expect(listEl.querySelector('[data-session-id="session-a"]')).toBeTruthy();
  });

  it("offers a root drop target while dragging a nested session", () => {
    const listEl = document.createElement("div");
    const hostElement = document.createElement("div");
    const rootDropHost = document.createElement("div");
    rootDropHost.className = "zion-sessions-list-header";
    hostElement.appendChild(listEl);
    document.body.append(rootDropHost, hostElement);
    const tree = {
      id: "root",
      type: "folder",
      title: "Root",
      children: [{
        id: "folder-a",
        type: "folder",
        title: "A",
        children: [{ id: "session-a", type: "session", title: "Session A" }]
      }]
    };
    const moveNode = vi.fn(() => true);
    const createRenderer = createSessionsListRendererFactory({
      loadTree: () => tree,
      ensureInitialTree: () => tree,
      getIndex: () => [{ id: "session-a" }],
      loadMeta: (id) => ({ id, title: id, updatedAt: 1 }),
      truncate: (value) => value,
      setSmallDragImage: () => {},
      fmtTime: (value) => String(value),
      now: () => 2,
      getSelection: () => [],
      setSelection: () => {},
      clearSelection: () => {},
      isSelected: () => false,
      toggleSelection: () => {},
      getLastSelectedId: () => null,
      setLastSelectedId: () => {},
      isFolderOpen: () => true,
      setFolderOpen: () => {},
      moveNode
    });
    const render = createRenderer({
      listEl,
      hostElement,
      rootDropHost,
      getQuery: () => "",
      getSort: () => "updated"
    });
    render();

    const data = new Map();
    const dataTransfer = {
      setData: (type, value) => data.set(type, value),
      getData: (type) => data.get(type) || "",
      setDragImage: () => {},
      effectAllowed: "",
      dropEffect: ""
    };
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer });
    listEl.querySelector('[data-session-id="session-a"]').dispatchEvent(dragStart);

    expect(listEl.classList.contains("is-dragging-nodes")).toBe(true);
    const rootTarget = rootDropHost.querySelector(".zion-sessions-root-drop-target");
    expect(rootTarget.classList.contains("is-visible")).toBe(true);
    expect(rootTarget.classList.contains("is-header-slot")).toBe(true);

    listEl.querySelector('[data-session-id="session-a"]').dispatchEvent(
      new Event("dragend", { bubbles: true })
    );
    expect(rootTarget.classList.contains("is-visible")).toBe(false);

    const folderDragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(folderDragStart, "dataTransfer", { value: dataTransfer });
    listEl.querySelector('.zion-session-row.is-folder[data-depth="0"]').dispatchEvent(folderDragStart);
    expect(rootTarget.classList.contains("is-visible")).toBe(true);
    expect(JSON.parse(data.get("application/zion-nodes"))).toEqual({
      items: [{ id: "folder-a", type: "folder" }]
    });
    listEl.querySelector('.zion-session-row.is-folder[data-depth="0"]').dispatchEvent(
      new Event("dragend", { bubbles: true })
    );

    listEl.querySelector('[data-session-id="session-a"]').dispatchEvent(dragStart);
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    rootTarget.dispatchEvent(drop);

    expect(moveNode).toHaveBeenCalledWith("session-a", "root");
    expect(rootTarget.classList.contains("is-visible")).toBe(false);
    rootDropHost.remove();
    hostElement.remove();
  });

  it("does not open the session root menu from the tag column", () => {
    const listEl = document.createElement("div");
    const hostElement = document.createElement("div");
    const tagColumn = document.createElement("div");
    tagColumn.className = "zion-sessions-tag-column";
    hostElement.append(listEl, tagColumn);
    document.body.appendChild(hostElement);

    const createRenderer = createSessionsListRendererFactory({
      loadTree: () => ({ id: "root", children: [] }),
      ensureInitialTree: () => ({ id: "root", children: [] }),
      getSelection: () => [],
      clearSelection: () => {},
      setLastSelectedId: () => {},
      setFolderOpen: () => {}
    });
    const render = createRenderer({
      listEl,
      hostElement,
      getQuery: () => "",
      getSort: () => "updated"
    });
    render();

    const rootMenu = listEl.querySelector(".session-row-menu");
    tagColumn.dispatchEvent(new MouseEvent("contextmenu", {
      clientX: 10,
      clientY: 10,
      bubbles: true,
      cancelable: true
    }));
    expect(rootMenu.style.display).toBe("none");
  });
});
