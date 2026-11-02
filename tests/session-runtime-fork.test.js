import { afterEach, describe, expect, it, vi } from "vitest";
import { forkRemoteChatSession } from "../extensions/dev.session-manager/storage/remote.js";

describe("Session Runtime fork bridge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.zion;
  });

  it("uses the Workbench fork id for the Runtime canonical Session", async () => {
    window.zion = {
      state: {
        get(key) {
          if (key === "runtime.baseUrl") return "http://runtime.test";
          if (key === "runtime.mode") return "runtime";
          return null;
        }
      }
    };
    const fetchImpl = vi.fn(async (url, init = {}) => {
      expect(String(url)).toBe("http://runtime.test/v1/sessions/source/fork");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        id: "forked",
        title: "Source (Fork)"
      });
      return new globalThis.Response(JSON.stringify({
        session: { id: "forked" },
        copiedTranscriptEntries: 4
      }), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchImpl);

    await expect(forkRemoteChatSession("source", {
      id: "forked",
      title: "Source (Fork)"
    })).resolves.toMatchObject({
      session: { id: "forked" },
      copiedTranscriptEntries: 4
    });
  });
});
