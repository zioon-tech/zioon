import { afterEach, describe, expect, it } from "vitest";
import { initWorkbench } from "../src/ui/workbench/workbench";
import { bindWorkbenchCore, inspectorRuntime } from "../src/ui/workbench/runtime";

function createState() {
  const map = new Map<string, any>();
  const listeners = new Map<string, Set<(next: any, prev: any) => void>>();
  return {
    get: (key: string) => map.get(key),
    set: (key: string, value: any) => {
      const oldValue = map.get(key);
      map.set(key, value);
      for (const listener of Array.from(listeners.get(key) || [])) {
        try { listener(value, oldValue); } catch {}
      }
    },
    update: (key: string, updater: (value: any) => any) => {
      const oldValue = map.get(key);
      const nextValue = updater(oldValue);
      map.set(key, nextValue);
      for (const listener of Array.from(listeners.get(key) || [])) {
        try { listener(nextValue, oldValue); } catch {}
      }
    },
    onDidChange: (key: string, fn: (next: any, prev: any) => void) => {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key)!.add(fn);
      return { dispose: () => listeners.get(key)?.delete(fn) };
    }
  };
}

function resetInspector() {
  for (const item of inspectorRuntime.getItems()) inspectorRuntime.close(item.id);
  localStorage.removeItem("zion.inspector.recentPages");
  document.body.innerHTML = "";
}

describe("workbench inspector browser", () => {
  afterEach(() => {
    resetInspector();
  });

  it("opens a browser tab from the empty Inspector address bar", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    bindWorkbenchCore({
      state: createState(),
      events: {
        emit: () => {},
        on: () => ({ dispose() {} })
      }
    });
    const workbench = initWorkbench(host);

    inspectorRuntime.show();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const address = document.querySelector<HTMLInputElement>(".zion-inspector-browser-address");
    expect(address).toBeTruthy();
    address!.value = "zion next";
    address!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    expect(inspectorRuntime.getActiveItem()).toMatchObject({
      ownerId: "core.inspector.browser",
      url: "https://www.bing.com/search?q=zion+next"
    });
    workbench.dispose();
  });

  it("closes the Inspector after the last tab closes", async () => {
    const state = createState();
    const host = document.createElement("div");
    document.body.appendChild(host);
    bindWorkbenchCore({
      state,
      events: {
        emit: () => {},
        on: () => ({ dispose() {} })
      }
    });
    const workbench = initWorkbench(host);

    inspectorRuntime.open({
      id: "example-page",
      ownerId: "test",
      title: "Example",
      path: "https://example.com/",
      displayPath: "https://example.com/",
      url: "https://example.com/"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const close = document.querySelector<HTMLButtonElement>(".zion-inspector-tab-close");
    expect(close?.getAttribute("aria-label")).toBe("关闭 Example");
    close!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.get("ui.inspector.visible")).toBe(false);
    expect(inspectorRuntime.getItems()).toHaveLength(0);
    workbench.dispose();
  });

  it("creates a browser start tab from the Inspector tab strip", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    bindWorkbenchCore({
      state: createState(),
      events: {
        emit: () => {},
        on: () => ({ dispose() {} })
      }
    });
    const workbench = initWorkbench(host);

    document.querySelector<HTMLButtonElement>(".zion-inspector-tabbar-action")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(inspectorRuntime.getActiveItem()).toMatchObject({
      ownerId: "core.inspector.browser",
      title: "新标签页",
      browserStartPage: true
    });
    expect(document.querySelector(".zion-inspector-tab.is-active")?.textContent).toContain("新标签页");
    workbench.dispose();
  });

  it("shows address suggestions and opens history into the active browser tab", async () => {
    localStorage.setItem("zion.inspector.recentPages", JSON.stringify([{
      url: "https://example.com/",
      title: "Example",
      visitedAt: Date.now()
    }]));
    const host = document.createElement("div");
    document.body.appendChild(host);
    bindWorkbenchCore({
      state: createState(),
      events: {
        emit: () => {},
        on: () => ({ dispose() {} })
      }
    });
    const workbench = initWorkbench(host);

    document.querySelector<HTMLButtonElement>(".zion-inspector-tabbar-action")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const address = document.querySelector<HTMLInputElement>(".zion-inspector-browser-address")!;
    address.value = "exa";
    address.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelector(".zion-inspector-browser-suggestions.is-open")?.textContent).toContain("Example");

    document.querySelector<HTMLButtonElement>(".zion-inspector-history-button")!.click();
    expect(document.querySelector(".zion-inspector-history-menu.is-open")?.textContent).toContain("Example");
    document.querySelector<HTMLButtonElement>(".zion-inspector-history-menu .zion-inspector-browser-choice")!.click();

    expect(inspectorRuntime.getActiveItem()).toMatchObject({
      ownerId: "core.inspector.browser",
      url: "https://example.com/",
      browserStartPage: false
    });
    workbench.dispose();
  });
});
