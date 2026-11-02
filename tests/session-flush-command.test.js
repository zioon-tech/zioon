import { describe, expect, it, vi } from "vitest";
import { registerSessionFlushCommand } from "../extensions/dev.session-manager/commands/flush.js";

describe("session flush command", () => {
  it("waits for editor persistence before flushing the durable queue", async () => {
    let handler = null;
    let resolveEditor;
    const editorPersisted = new Promise((resolve) => {
      resolveEditor = resolve;
    });
    const flushRemote = vi.fn().mockResolvedValue(true);
    const zion = {
      commands: {
        registerCommand: (_id, command) => {
          handler = command;
          return { dispose() {} };
        }
      }
    };

    registerSessionFlushCommand({
      zion,
      plugin: {
        flushDurably: vi.fn(() => editorPersisted)
      },
      flushRemote
    });

    const pending = handler("session-a");
    await Promise.resolve();
    expect(flushRemote).not.toHaveBeenCalled();

    resolveEditor(true);
    await expect(pending).resolves.toBe(true);
    expect(flushRemote).toHaveBeenCalledTimes(1);
    expect(flushRemote).toHaveBeenCalledWith("session-a");
  });
  it("reports a durable unchanged session as saved", async () => {
    let handler;
    registerSessionFlushCommand({
      zion: { commands: { registerCommand: (_id, fn) => { handler = fn; return { dispose() {} }; } } },
      plugin: { flushDurably: async () => false },
      flushRemote: async () => true
    });
    expect(await handler("s")).toBe(true);
  });

  it("reports failure when the durable queue cannot be committed", async () => {
    let handler = null;
    registerSessionFlushCommand({
      zion: {
        commands: {
          registerCommand: (_id, command) => {
            handler = command;
            return { dispose() {} };
          }
        }
      },
      plugin: { flushDurably: vi.fn().mockResolvedValue(true) },
      flushRemote: vi.fn().mockResolvedValue(false)
    });

    await expect(handler("session-a")).resolves.toBe(false);
  });
});
