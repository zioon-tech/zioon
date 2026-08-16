import { beforeEach, describe, expect, it } from "vitest";
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
