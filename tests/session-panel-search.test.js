import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionsPanelManager } from "../extensions/dev.session-manager/ui/panel.js";

afterEach(() => {
  document.getElementById("zion-sessions-panel-overlay")?.remove();
  vi.useRealTimers();
});

describe("sessions panel content search", () => {
  it("uses service results across pages and discards an outdated response", async () => {
    vi.useFakeTimers();
    let resolveOld;
    const executeCommand = vi.fn((_command, options) => {
      if (options.query === "旧") return new Promise(resolve => { resolveOld = resolve; });
      return Promise.resolve(options.offset
        ? { sessions: [{ id: "second" }], hasMore: false, nextOffset: 200 }
        : { sessions: [{ id: "first" }], hasMore: true, nextOffset: 100 });
    });
    let rendererOptions;
    const render = vi.fn();
    render.dispose = vi.fn();
    const manager = createSessionsPanelManager({
      zion: { state: { get() {} }, commands: { executeCommand } },
      getIndex: () => [{ id: "first" }, { id: "second" }],
      createSessionsListRenderer(options) { rendererOptions = options; return render; }
    });
    manager.open();
    const input = document.querySelector('#zion-sessions-panel-overlay input[type="search"]');
    const type = value => { input.value = value; input.dispatchEvent(new Event("input")); };
    type("旧");
    await vi.advanceTimersByTimeAsync(180);
    type("新");
    await vi.advanceTimersByTimeAsync(180);
    expect(rendererOptions.getQuery()).toBe("");
    expect(rendererOptions.getSessionFilter()({ id: "first" })).toBe(true);
    expect(rendererOptions.getSessionFilter()({ id: "second" })).toBe(false);
    resolveOld({ sessions: [{ id: "old" }], hasMore: false });
    await Promise.resolve();
    expect(rendererOptions.getSessionFilter()({ id: "old" })).toBe(false);
    const more = [...document.querySelectorAll("#zion-sessions-panel-overlay button")]
      .find(button => button.textContent === "更多搜索结果");
    more.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(executeCommand).toHaveBeenLastCalledWith("zion.sessions.search", { query: "新", limit: 100, offset: 100 });
    expect(rendererOptions.getSessionFilter()({ id: "second" })).toBe(true);
    expect(more.hidden).toBe(true);
    type("");
    expect(rendererOptions.getSessionFilter()).toBeNull();
    document.getElementById("zion-sessions-panel-overlay").remove();
    expect(render.dispose).toHaveBeenCalledOnce();
  });
});
