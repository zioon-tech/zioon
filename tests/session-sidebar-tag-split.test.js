import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionsSidebarViewManager } from "../extensions/dev.session-manager/ui/sidebar-view.js";

function makeZion(widthCalls) {
  let width = 300;
  const values = new Map();
  return {
    state: {
      get: (key) => (key === "ui.sideBar.width" ? width : values.get(key)),
      set: vi.fn((key, value) => values.set(key, value)),
      onDidChange: () => ({ dispose: () => {} })
    },
    sideBar: {
      setWidth: (w) => {
        width = w;
        widthCalls.push(w);
      }
    },
    events: {
      on: () => ({ dispose: () => {} })
    }
  };
}

function makeManager(widthCalls) {
  const zion = makeZion(widthCalls);
  zion.state.set("sessions.tagIndex", {
    version: 1,
    sessions: {
      s1: { hash: "1", tags: ["alpha"] },
      s2: { hash: "2", tags: ["beta/one"] }
    }
  });
  const manager = createSessionsSidebarViewManager({
    zion,
    createSessionsListRenderer: () => {
      const render = () => {};
      render.dispose = () => {};
      render.syncSessionIndex = () => {};
      return render;
    },
    getIndex: () => [{ id: "s1" }, { id: "s2" }],
    loadMeta: (id) => ({ id, title: id, updatedAt: Date.now() }),
    loadDoc: vi.fn(() => {
      throw new Error("sidebar should not scan session documents");
    }),
    dbName: "zion.sessions.db.test"
  });
  return { manager, zion };
}

function mountAt(width, { attachHeader = true } = {}) {
  const widthCalls = [];
  const { manager, zion } = makeManager(widthCalls);
  const headerSnapshots = [];
  const headerDisposable = attachHeader
    ? manager.attachTagSplitHeader((snapshot) => headerSnapshots.push({ ...snapshot }))
    : null;
  const container = document.createElement("div");
  document.body.appendChild(container);
  Object.defineProperty(container, "clientWidth", { value: width, configurable: true });
  const inst = manager.mountInto(container);
  return {
    manager,
    zion,
    inst,
    container,
    widthCalls,
    headerSnapshots,
    headerDisposable,
    setWidth: (w) => Object.defineProperty(container, "clientWidth", { value: w, configurable: true })
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("sessions sidebar tag split layout", () => {
  it("defaults the activity filter to all sessions", () => {
    const { container } = mountAt(500);
    expect(container.querySelector(".zion-sessions-heatmap-range").value).toBe("all");
  });

  it("persists list and card view modes", () => {
    const { manager, container } = mountAt(500);
    expect(manager.getSessionViewMode()).toBe("list");
    expect(container.querySelector(".zion-sessions-list").classList.contains("is-card-view")).toBe(false);

    expect(manager.toggleSessionViewModeIfOpen()).toBe("card");
    expect(localStorage.getItem("zion.sessions.sidebar.viewMode")).toBe("card");
    expect(container.querySelector(".zion-sessions-list").classList.contains("is-card-view")).toBe(true);

    expect(manager.toggleSessionViewModeIfOpen()).toBe("list");
    expect(localStorage.getItem("zion.sessions.sidebar.viewMode")).toBe("list");
    expect(container.querySelector(".zion-sessions-list").classList.contains("is-card-view")).toBe(false);
  });

  it("renders two columns when enabled and body is wide enough", () => {
    localStorage.setItem("zion.sessions.sidebar.tagSplit", "1");
    const { container } = mountAt(500);
    expect(container.querySelector(".zion-sessions-split-row")).toBeTruthy();
    const right = container.querySelector(".zion-sessions-right-column");
    expect(right.querySelector(".zion-sessions-list")).toBeTruthy();
    expect(right.querySelector(".zion-sessions-day-panel")).toBeNull();
    expect(container.querySelector(".zion-sessions-tags-panel").style.display).toBe("none");
    const tagColumn = container.querySelector(".zion-sessions-tag-column");
    expect(tagColumn).toBeTruthy();
    expect(tagColumn.querySelector(".zion-sessions-day-panel")).toBeTruthy();
  });

  it("falls back to stacked layout under 380px even when enabled", () => {
    localStorage.setItem("zion.sessions.sidebar.tagSplit", "1");
    const { container, headerSnapshots } = mountAt(320);
    expect(container.querySelector(".zion-sessions-split-row")).toBeNull();
    expect(container.querySelector(".zion-sessions-list")).toBeTruthy();
    expect(container.querySelector(".zion-sessions-tags-panel").style.display).not.toBe("none");
    expect(headerSnapshots.at(-1).visible).toBe(false);
  });

  it("toggle enables split, auto-widens sidebar, and disables restoring width", () => {
    const { inst, container, widthCalls } = mountAt(500);
    expect(container.querySelector(".zion-sessions-split-row")).toBeNull();

    inst.toggleTagSplit();
    expect(localStorage.getItem("zion.sessions.sidebar.tagSplit")).toBe("1");
    expect(container.querySelector(".zion-sessions-split-row")).toBeTruthy();
    expect(widthCalls).toEqual([440]);

    inst.toggleTagSplit();
    expect(localStorage.getItem("zion.sessions.sidebar.tagSplit")).toBe("0");
    expect(container.querySelector(".zion-sessions-split-row")).toBeNull();
    expect(container.querySelector(".zion-sessions-day-panel").parentElement).toBe(container);
    expect(widthCalls).toEqual([440, 300]);
  });

  it("restores normal width on deactivation and reapplies split width on activation", () => {
    localStorage.setItem("zion.sessions.sidebar.tagSplit", "1");
    const { manager, zion, widthCalls } = mountAt(500);

    manager.activateTagSplitWidthIfEnabled();
    expect(widthCalls).toEqual([440]);
    expect(localStorage.getItem("zion.sessions.sidebar.preSplitWidth")).toBe("300");

    manager.deactivateTagSplitWidthIfEnabled();
    expect(widthCalls).toEqual([440, 300]);

    zion.sideBar.setWidth(320);
    widthCalls.length = 0;

    manager.activateTagSplitWidthIfEnabled();
    expect(widthCalls).toEqual([440]);
    expect(localStorage.getItem("zion.sessions.sidebar.preSplitWidth")).toBe("320");

    manager.deactivateTagSplitWidthIfEnabled();
    expect(widthCalls).toEqual([440, 320]);
  });

  it("keeps manual width when already wide enough", () => {
    const widthCalls = [];
    const zion = makeZion(widthCalls);
    let width = 520;
    zion.state.get = (key) => (key === "ui.sideBar.width" ? width : undefined);
    const manager = createSessionsSidebarViewManager({
      zion,
      createSessionsListRenderer: () => {
        const render = () => {};
        render.dispose = () => {};
        return render;
      },
      getIndex: () => [],
      loadMeta: () => ({}),
      loadDoc: () => ""
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    Object.defineProperty(container, "clientWidth", { value: 600, configurable: true });
    manager.attachTagSplitHeader(() => {});
    const inst = manager.mountInto(container);
    inst.toggleTagSplit();
    expect(widthCalls).toEqual([]);
    expect(localStorage.getItem("zion.sessions.sidebar.preSplitWidth")).toBe("520");
  });

  it("tag tree panel receives tree data with scanned tags", () => {
    localStorage.setItem("zion.sessions.sidebar.tagSplit", "1");
    const { container } = mountAt(500);
    const column = container.querySelector(".zion-sessions-tag-column");
    const rows = Array.from(column.querySelectorAll(".zion-sessions-tagtree-row"));
    expect(rows.map((r) => r.dataset.path).sort()).toEqual(["alpha", "beta", "beta/one"]);
  });

  it("enables flat session results while a tag filter is active", () => {
    localStorage.setItem("zion.sessions.sidebar.tagSplit", "1");
    const captured = [];
    const zion = makeZion([]);
    zion.state.set("sessions.tagIndex", {
      version: 1,
      sessions: { s1: { hash: "1", tags: ["alpha"] } }
    });
    const manager = createSessionsSidebarViewManager({
      zion,
      createSessionsListRenderer: (options) => {
        captured.push(options);
        const render = () => {};
        render.dispose = () => {};
        render.syncSessionIndex = () => {};
        return render;
      },
      getIndex: () => [{ id: "s1" }],
      loadMeta: () => ({ id: "s1", title: "Session", updatedAt: 1 }),
      loadDoc: () => ""
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    Object.defineProperty(container, "clientWidth", { value: 500, configurable: true });
    manager.attachTagSplitHeader(() => {});
    manager.mountInto(container);

    expect(captured.at(-1).getFlatSessionResults()).toBe(false);
    zion.state.set.mockClear();
    container.querySelector('[data-path="alpha"]').click();
    expect(captured.at(-1).getFlatSessionResults()).toBe(true);
    expect(zion.state.set).not.toHaveBeenCalledWith(
      "sessions.selectedFolderId",
      expect.anything()
    );

    container.querySelector('[data-path="alpha"]').click();
    expect(captured.at(-1).getFlatSessionResults()).toBe(false);
  });

  it("merges Biography tags as read-only rows and filters their sessions", () => {
    localStorage.setItem("zion.sessions.sidebar.tagSplit", "1");
    const captured = [];
    const zion = makeZion([]);
    zion.state.set("sessions.tagIndex", {
      version: 1,
      sessions: {
        s1: { hash: "1", tags: ["alpha"] },
        s2: { hash: "2", tags: [] }
      }
    });
    zion.state.set("sessions.derivedTags", {
      biography: {
        id: "biography",
        label: "Biography",
        readOnly: true,
        sessions: {
          s2: [{ path: "project/zion", kind: "project" }]
        }
      }
    });
    const manager = createSessionsSidebarViewManager({
      zion,
      createSessionsListRenderer: (deps) => {
        captured.push(deps);
        const render = () => {};
        render.dispose = () => {};
        render.syncSessionIndex = () => {};
        return render;
      },
      getIndex: () => [{ id: "s1" }, { id: "s2" }],
      loadMeta: (id) => ({ id, title: id, updatedAt: Date.now() })
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    Object.defineProperty(container, "clientWidth", { value: 500, configurable: true });
    manager.attachTagSplitHeader(() => {});
    manager.mountInto(container);

    const root = container.querySelector('[data-path="project"]');
    expect(root.querySelector(".zion-sessions-tagtree-source")).toBeTruthy();
    expect(container.querySelector('[data-path="project/zion"]')).toBeNull();
    root.querySelector(".zion-sessions-tagtree-toggle").click();
    const row = container.querySelector('[data-path="project/zion"]');
    expect(row.querySelector(".zion-sessions-tagtree-source")).toBeTruthy();
    row.click();
    const filter = captured.at(-1).getSessionFilter();
    expect(filter({ id: "s1" })).toBe(false);
    expect(filter({ id: "s2" })).toBe(true);
  });

  it("clicking a tree row filters via selection callbacks", () => {
    localStorage.setItem("zion.sessions.sidebar.tagSplit", "1");
    const { container } = mountAt(500);
    const row = container.querySelector('[data-path="alpha"]');
    row.click();
    const selected = container.querySelector('.zion-sessions-tagtree-row[aria-selected="true"]');
    expect(selected?.dataset.path).toBe("alpha");
    container.querySelector('[data-path="alpha"]').click();
    expect(container.querySelector('.zion-sessions-tagtree-row[aria-selected="true"]')).toBeNull();
  });

  it("selecting a tag in split mode produces a list filter that matches # prefixed session tags", () => {
    localStorage.setItem("zion.sessions.sidebar.tagSplit", "1");
    const captured = [];
    const zion = makeZion([]);
    zion.state.set("sessions.tagIndex", {
      version: 1,
      sessions: {
        s1: { hash: "1", tags: ["alpha"] },
        s2: { hash: "2", tags: ["beta/one"] }
      }
    });
    const manager = createSessionsSidebarViewManager({
      zion,
      createSessionsListRenderer: (deps) => {
        captured.push(deps);
        const render = () => {};
        render.dispose = () => {};
        render.syncSessionIndex = () => {};
        return render;
      },
      getIndex: () => [{ id: "s1" }, { id: "s2" }],
      loadMeta: (id) => ({ id, title: id, updatedAt: Date.now() }),
      dbName: "zion.sessions.db.tagfilter.test"
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    Object.defineProperty(container, "clientWidth", { value: 500, configurable: true });
    manager.attachTagSplitHeader(() => {});
    manager.mountInto(container);

    container.querySelector('[data-path="alpha"]').click();
    const alphaFilter = captured.at(-1).getSessionFilter();
    expect(alphaFilter).toBeTypeOf("function");
    expect(alphaFilter({ id: "s1" })).toBe(true);   // "#alpha" → matches alpha
    expect(alphaFilter({ id: "s2" })).toBe(false);  // "#beta/one" → no match

    container.querySelector('[data-path="beta"]').click();
    const betaFilter = captured.at(-1).getSessionFilter();
    expect(betaFilter({ id: "s1" })).toBe(false);   // not tagged beta
    expect(betaFilter({ id: "s2" })).toBe(true);    // "#beta/one" is a descendant of beta
  });

  it("split mode uses a single divider line, a session count header, and a clearable filter chip", () => {
    localStorage.setItem("zion.sessions.sidebar.tagSplit", "1");
    const { container } = mountAt(500);

    // tag column owns no border; the divider is the only separator
    const tagColumn = container.querySelector(".zion-sessions-tag-column");
    expect(tagColumn.style.borderRight).toBe("");
    expect(container.querySelector(".zion-sessions-split-divider")).toBeTruthy();

    // right column header row exists for height alignment, shows total count,
    // and does NOT repeat the host header's "Sessions" title
    const listHeader = container.querySelector(".zion-sessions-list-header");
    expect(listHeader).toBeTruthy();
    expect(listHeader.querySelector(".zion-sessions-list-header-title")).toBeNull();
    expect(listHeader.querySelector(".zion-sessions-list-header-count").textContent).toBe("2");

    // no chip when nothing is selected
    expect(listHeader.querySelector(".zion-sessions-split-filterchip")).toBeNull();

    // selecting a tag shows matched/total count + chip
    container.querySelector('[data-path="alpha"]').click();
    expect(listHeader.querySelector(".zion-sessions-list-header-count").textContent).toBe("1/2");
    const chip = listHeader.querySelector(".zion-sessions-split-filterchip");
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain("#alpha");

    // clearing via the chip resets selection
    listHeader.querySelector(".zion-sessions-split-filterclear").click();
    expect(listHeader.querySelector(".zion-sessions-split-filterchip")).toBeNull();
    expect(listHeader.querySelector(".zion-sessions-list-header-count").textContent).toBe("2");
    expect(container.querySelector('.zion-sessions-tagtree-row[aria-selected="true"]')).toBeNull();
  });

  it("publishes the tag header snapshot without overlaying the host header", () => {
    localStorage.setItem("zion.sessions.sidebar.tagSplit", "1");
    const { container, headerSnapshots } = mountAt(500);
    expect(headerSnapshots.at(-1)).toMatchObject({ visible: true, width: 180, nodeCount: 3 });
    const splitRow = container.querySelector(".zion-sessions-split-row");
    expect(splitRow.style.marginTop).toBe("");
    expect(splitRow.classList.contains("is-lifted")).toBe(false);
    expect(container.querySelector(".zion-sessions-tagtree-header")).toBeNull();
  });

  it("falls back to stacked content when the header bridge is absent", () => {
    localStorage.setItem("zion.sessions.sidebar.tagSplit", "1");
    const { container } = mountAt(500, { attachHeader: false });
    expect(container.querySelector(".zion-sessions-split-row")).toBeNull();
    expect(container.querySelector(".zion-sessions-tags-panel").style.display).not.toBe("none");
  });

  it("keeps header and content divider widths synchronized while dragging", () => {
    localStorage.setItem("zion.sessions.sidebar.tagSplit", "1");
    const { container, headerSnapshots } = mountAt(500);
    const divider = container.querySelector(".zion-sessions-split-divider");
    divider.dispatchEvent(new MouseEvent("mousedown", { clientX: 100, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 120, bubbles: true }));
    expect(headerSnapshots.at(-1).width).toBe(200);
    expect(container.querySelector(".zion-sessions-tag-column").style.width).toBe("200px");
    expect(divider.style.left).toBe("197px");
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(localStorage.getItem("zion.sessions.sidebar.tagColumnWidth")).toBe("200");
  });

  it("delegates root creation from the header to the mounted tree", () => {
    localStorage.setItem("zion.sessions.sidebar.tagSplit", "1");
    const { manager, container } = mountAt(500);
    manager.createRootTagIfOpen();
    expect(container.querySelector(".zion-sessions-tagtree-edit input")).toBeTruthy();
  });
});
