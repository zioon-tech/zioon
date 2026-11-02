import { describe, expect, it, vi } from "vitest";
import {
  createChatCardWriterLeases,
  hasLiveChatCardWriter,
  shouldPersistChatCardInBackground
} from "../extensions/dev.session-manager/features/chat-card-writer.js";

describe("chat card writer ownership", () => {
  it("never lets a remote observer become a document writer", () => {
    const zion = {
      panels: {
        getActivePanelId: () => "panel-a",
        getEditorBySession: () => null,
        listEditors: () => []
      },
      state: { get: vi.fn(() => "session-a") },
      window: { activeEditor: null }
    };

    expect(shouldPersistChatCardInBackground(zion, {
      sessionId: "session-a",
      runId: "run-1",
      documentWriter: false
    })).toBe(false);
  });

  it("keeps a named source panel as the writer after focus moves elsewhere", () => {
    const sourceEditor = { panelId: "panel-a", sessionId: "session-a" };
    const zion = {
      panels: {
        getActivePanelId: () => "panel-b",
        getEditorBySession: (panelId, sessionId) =>
          panelId === "panel-a" && sessionId === "session-a" ? sourceEditor : null,
        list: () => [
          { id: "panel-a", activeTabId: "session-a" },
          { id: "panel-b", activeTabId: "session-b" }
        ]
      },
      state: { get: vi.fn(() => "session-b") },
      window: { activeEditor: { panelId: "panel-b", sessionId: "session-b" } }
    };
    const payload = { panelId: "panel-a", sessionId: "session-a" };

    expect(hasLiveChatCardWriter(zion, payload)).toBe(true);
    expect(shouldPersistChatCardInBackground(zion, payload)).toBe(false);
  });

  it("uses the background writer when the source panel no longer owns the session", () => {
    const zion = {
      panels: {
        getActivePanelId: () => "panel-b",
        getEditorBySession: () => null,
        listEditors: () => [],
        list: () => [{ id: "panel-b", activeTabId: "session-b" }]
      },
      state: { get: vi.fn(() => "session-b") },
      window: { activeEditor: { panelId: "panel-b", sessionId: "session-b" } }
    };
    const payload = { panelId: "panel-a", sessionId: "session-a" };

    expect(hasLiveChatCardWriter(zion, payload)).toBe(false);
    expect(shouldPersistChatCardInBackground(zion, payload)).toBe(true);
  });

  it("does not let hidden editor slots claim a headless event", () => {
    const zion = {
      panels: {
        getActivePanelId: () => "panel-b",
        getEditorBySession: (panelId, sessionId) =>
          panelId === "panel-a" && sessionId === "session-a"
            ? { panelId, sessionId }
            : null,
        list: () => [
          { id: "panel-a", activeTabId: "session-c" },
          { id: "panel-b", activeTabId: "session-b" }
        ]
      },
      state: { get: vi.fn(() => "session-b") },
      window: { activeEditor: { panelId: "panel-b", sessionId: "session-b" } }
    };

    expect(shouldPersistChatCardInBackground(zion, {
      panelId: null,
      sessionId: "session-a"
    })).toBe(true);
  });

  it("lets the active editor own panel-less events for its session", () => {
    const zion = {
      panels: {
        getActivePanelId: () => "panel-a",
        getEditorBySession: () => ({ panelId: "panel-a", sessionId: "session-a" })
      },
      state: { get: vi.fn(() => "session-a") },
      window: { activeEditor: { panelId: "panel-a", sessionId: "session-a" } }
    };

    expect(shouldPersistChatCardInBackground(zion, {
      panelId: null,
      sessionId: "session-a"
    })).toBe(false);
  });

  it("keeps background ownership stable while an async write is queued", () => {
    let activePanelId = "panel-b";
    const zion = {
      panels: {
        getActivePanelId: () => activePanelId,
        getEditorBySession: (panelId, sessionId) =>
          panelId === "panel-a" && sessionId === "session-a"
            ? { panelId, sessionId }
            : null
      },
      state: { get: vi.fn(() => activePanelId === "panel-a" ? "session-a" : "session-b") },
      window: { activeEditor: null }
    };
    const payload = { panelId: null, sessionId: "session-a", runId: "run-1" };
    const leases = createChatCardWriterLeases(zion);

    expect(leases.claimRun(payload)).toBe(true);
    expect(leases.claimCard(payload, "card-1")).toBe(true);

    activePanelId = "panel-a";
    expect(shouldPersistChatCardInBackground(zion, payload)).toBe(false);
    expect(leases.ownsRun(payload)).toBe(true);
    expect(leases.ownsCard(payload, "card-1")).toBe(true);

    leases.releaseRun(payload);
    expect(leases.ownsRun(payload)).toBe(false);
    expect(leases.ownsCard(payload, "card-1")).toBe(false);
  });

  it("invalidates an interrupted run and rejects its late events after restart", () => {
    const zion = {
      panels: {
        getActivePanelId: () => "panel-b",
        getEditorBySession: () => null,
        listEditors: () => []
      },
      state: { get: vi.fn(() => "session-b") },
      window: { activeEditor: null }
    };
    const oldRun = { panelId: "panel-a", sessionId: "session-a", runId: "run-old" };
    const newRun = { panelId: "panel-a", sessionId: "session-a", runId: "run-new" };
    const leases = createChatCardWriterLeases(zion);

    leases.startRun(oldRun);
    expect(leases.claimRun(oldRun)).toBe(true);
    expect(leases.claimCard(oldRun, "card-old")).toBe(true);
    leases.cancelRun(oldRun);
    leases.startRun(newRun);

    expect(leases.isWriteValid(oldRun)).toBe(false);
    expect(leases.claimRun(oldRun)).toBe(false);
    expect(leases.claimCard(oldRun, "late-card")).toBe(false);
    expect(leases.claimRun(newRun)).toBe(true);
  });

  it("lets accepted writes drain after normal completion until another run starts", () => {
    const zion = {
      panels: {
        getActivePanelId: () => "panel-b",
        getEditorBySession: () => null,
        listEditors: () => []
      },
      state: { get: vi.fn(() => "session-b") },
      window: { activeEditor: null }
    };
    const firstRun = { panelId: "panel-a", sessionId: "session-a", runId: "run-1" };
    const nextRun = { panelId: "panel-a", sessionId: "session-a", runId: "run-2" };
    const leases = createChatCardWriterLeases(zion);

    leases.startRun(firstRun);
    expect(leases.claimRun(firstRun)).toBe(true);
    leases.finishRun(firstRun);

    expect(leases.acceptsRun(firstRun)).toBe(false);
    expect(leases.isWriteValid(firstRun)).toBe(true);

    leases.startRun(nextRun);
    expect(leases.isWriteValid(firstRun)).toBe(false);
    leases.finishRun(nextRun);
    expect(leases.isWriteValid(firstRun)).toBe(false);
  });
});
