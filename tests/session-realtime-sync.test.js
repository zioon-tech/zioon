import { describe, expect, it, vi } from "vitest";
import {
  createSessionRealtimeSync
} from "../extensions/dev.session-manager/storage/realtime.js";

describe("session realtime sync", () => {
  it("delivers ordered events and identifies local echoes", async () => {
    const received = [];
    let sync;
    const subscribe = vi.fn(async function* ({ afterSequence }) {
      expect(afterSequence).toBe(4);
      yield {
        sequence: 5,
        type: "session.updated",
        sourceClientId: "client-a"
      };
      yield {
        sequence: 6,
        type: "session.updated",
        sourceClientId: "client-b"
      };
    });
    sync = createSessionRealtimeSync({
      subscribe,
      initialCursor: 4,
      clientId: "client-a",
      retryDelayMs: 1,
      async onEvent(event, meta) {
        received.push({ event, meta });
        if (received.length === 2) sync.dispose();
      }
    });

    await sync.start();

    expect(received).toEqual([
      {
        event: expect.objectContaining({ sequence: 5 }),
        meta: { ownEvent: true }
      },
      {
        event: expect.objectContaining({ sequence: 6 }),
        meta: { ownEvent: false }
      }
    ]);
    expect(sync.cursor).toBe(6);
  });

  it("recovers an expired cursor through the snapshot callback", async () => {
    const seenAfter = [];
    let calls = 0;
    let sync;
    const subscribe = async function* ({ afterSequence }) {
      seenAfter.push(afterSequence);
      calls += 1;
      if (calls === 1) {
        yield { type: "reset", latestSequence: 20 };
        return;
      }
      yield { sequence: 21, type: "tree.updated" };
    };
    sync = createSessionRealtimeSync({
      subscribe,
      initialCursor: 3,
      retryDelayMs: 1,
      async onReset() {
        return 20;
      },
      async onEvent() {
        sync.dispose();
      }
    });

    await sync.start();

    expect(seenAfter).toEqual([3, 20]);
    expect(sync.cursor).toBe(21);
  });

  it("resumes from the last delivered cursor after a transport failure", async () => {
    const seenAfter = [];
    const received = [];
    let calls = 0;
    let sync;
    const subscribe = async function* ({ afterSequence }) {
      seenAfter.push(afterSequence);
      calls += 1;
      if (calls === 1) {
        yield { sequence: 5, type: "session.updated" };
        throw new Error("connection lost");
      }
      yield { sequence: 6, type: "run.started" };
    };
    sync = createSessionRealtimeSync({
      subscribe,
      initialCursor: 4,
      retryDelayMs: 1,
      async onEvent(event) {
        received.push(event.sequence);
        if (event.sequence === 6) sync.dispose();
      }
    });

    await sync.start();

    expect(seenAfter).toEqual([4, 5]);
    expect(received).toEqual([5, 6]);
    expect(sync.cursor).toBe(6);
  });
});
