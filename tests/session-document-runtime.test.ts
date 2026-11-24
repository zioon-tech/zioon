import { describe, expect, it, vi } from "vitest";
import { SessionDocumentRuntime } from "../src/session/document-runtime";

describe("SessionDocumentRuntime", () => {
  it("waits for the target pane's card restoration before restoring its viewport", async () => {
    let ready!: () => void;
    const order: string[] = [];
    const cards = new Promise<void>(resolve => { ready = resolve; });
    const runtime = new SessionDocumentRuntime({
      getGlobalSessionId: () => "a", setGlobalSessionId() {},
      getTargetEditor: () => ({ setValue() { order.push("document"); } }) as any,
      persistPreviousSession() {}, setLastActiveId() {},
      loadDocument: () => "full document",
      applyAnnotations: () => { order.push("cards-start"); return cards; },
      restoreUiState: () => { order.push("viewport"); }
    });
    const switching = runtime.switchSession({ id: "b" });
    expect(order).toEqual(["document", "cards-start"]);
    ready();
    expect(await switching).toBe(true);
    expect(order).toEqual(["document", "cards-start", "viewport"]);
  });
  it("persists previous panel session, loads target document, and restores annotations", async () => {
    const calls: string[] = [];
    const editor = {
      setValue(value: string) {
        calls.push(`setValue:${value}`);
      }
    } as any;
    let globalSessionId: string | null = "global-a";
    const runtime = new SessionDocumentRuntime({
      getGlobalSessionId: () => globalSessionId,
      setGlobalSessionId: (sessionId) => {
        globalSessionId = sessionId;
        calls.push(`setGlobal:${sessionId}`);
      },
      getTargetEditor: () => editor,
      persistPreviousSession: (sessionId) => calls.push(`persist:${sessionId}`),
      setLastActiveId: (sessionId, opts) => calls.push(`last:${sessionId}:${opts?.push}`),
      loadDocument: async (sessionId) => `doc:${sessionId}`,
      applyAnnotations: (sessionId, panelId) => calls.push(`annotations:${sessionId}:${panelId}`),
      restoreUiState: (sessionId, panelId) => calls.push(`ui:${sessionId}:${panelId}`),
      afterSwitch: (sessionId, panelId) => calls.push(`after:${sessionId}:${panelId}`)
    });

    await expect(runtime.switchSession({
      id: "session-b",
      panelId: "panel-a",
      previousSessionId: "session-a"
    })).resolves.toBe(true);

    expect(calls).toEqual([
      "persist:session-a",
      "last:session-b:true",
      "setGlobal:session-b",
      "setValue:doc:session-b",
      "annotations:session-b:panel-a",
      "ui:session-b:panel-a",
      "after:session-b:panel-a"
    ]);
  });

  it("uses global previous session when no panel is targeted", async () => {
    const persisted: string[] = [];
    let globalSessionId: string | null = "global-a";
    const runtime = new SessionDocumentRuntime({
      getGlobalSessionId: () => globalSessionId,
      setGlobalSessionId: (sessionId) => {
        globalSessionId = sessionId;
      },
      getTargetEditor: () => ({ setValue() {} }) as any,
      persistPreviousSession: (sessionId) => persisted.push(sessionId),
      setLastActiveId: () => {},
      loadDocument: () => "",
      applyAnnotations: () => {}
    });

    await runtime.switchSession({ id: "global-b" });

    expect(persisted).toEqual(["global-a"]);
    expect(globalSessionId).toBe("global-b");
  });

  it("can skip previous persistence and URL writes", async () => {
    const calls: string[] = [];
    const runtime = new SessionDocumentRuntime({
      getGlobalSessionId: () => "session-a",
      setGlobalSessionId: (sessionId) => calls.push(`setGlobal:${sessionId}`),
      getTargetEditor: () => ({ setValue() {} }) as any,
      persistPreviousSession: (sessionId) => calls.push(`persist:${sessionId}`),
      setLastActiveId: (sessionId) => calls.push(`last:${sessionId}`),
      loadDocument: () => "",
      applyAnnotations: () => {}
    });

    await runtime.switchSession({
      id: "session-b",
      previousSessionId: "session-a",
      skipPersistPrevious: true,
      writeUrl: false
    });

    expect(calls).toEqual(["setGlobal:session-b"]);
  });

  it("does not replace an editor document that already matches the loaded text", async () => {
    const setValue = vi.fn();
    const runtime = new SessionDocumentRuntime({
      getGlobalSessionId: () => "session-a",
      setGlobalSessionId: () => {},
      getTargetEditor: () => ({
        getValue: () => "prefetched text",
        setValue
      }) as any,
      persistPreviousSession: () => {},
      setLastActiveId: () => {},
      loadDocument: () => "prefetched text",
      applyAnnotations: () => {}
    });

    await expect(runtime.switchSession({ id: "session-b" })).resolves.toBe(true);
    expect(setValue).not.toHaveBeenCalled();
  });

  it("applies a prefetched synchronous document without yielding the switch task", async () => {
    const calls: string[] = [];
    const runtime = new SessionDocumentRuntime({
      getGlobalSessionId: () => "session-a",
      setGlobalSessionId: () => {},
      getTargetEditor: () => ({
        getValue: () => "",
        setValue: (text: string) => calls.push(text)
      }) as any,
      persistPreviousSession: () => {},
      setLastActiveId: () => {},
      loadDocument: () => "prefetched text",
      applyAnnotations: () => calls.push("annotations")
    });

    const switching = runtime.switchSession({ id: "session-b" });
    expect(calls).toEqual(["prefetched text", "annotations"]);
    await expect(switching).resolves.toBe(true);
  });

  it("drops stale document loads when a newer switch targets the same panel", async () => {
    const calls: string[] = [];
    const editor = {
      setValue(value: string) {
        calls.push(`setValue:${value}`);
      }
    } as any;
    let globalSessionId: string | null = "session-a";
    let panelSessionId: string | null = "session-a";
    const loaders = new Map<string, (value: string) => void>();
    const runtime = new SessionDocumentRuntime({
      getGlobalSessionId: () => globalSessionId,
      getPanelSessionId: () => panelSessionId,
      setGlobalSessionId: (sessionId) => {
        globalSessionId = sessionId;
      },
      getTargetEditor: () => editor,
      persistPreviousSession: () => {},
      setLastActiveId: () => {},
      loadDocument: (sessionId) => new Promise<string>((resolve) => {
        loaders.set(sessionId, resolve);
      }),
      applyAnnotations: (sessionId) => calls.push(`annotations:${sessionId}`),
      afterSwitch: (sessionId) => calls.push(`after:${sessionId}`)
    });

    const first = runtime.switchSession({ id: "session-b", panelId: "panel-a" });
    panelSessionId = "session-c";
    const second = runtime.switchSession({ id: "session-c", panelId: "panel-a" });

    loaders.get("session-c")?.("doc:c");
    await expect(second).resolves.toBe(true);
    loaders.get("session-b")?.("doc:b");
    await expect(first).resolves.toBe(false);

    expect(calls).toEqual(["setValue:doc:c", "annotations:session-c", "after:session-c"]);
  });
});
