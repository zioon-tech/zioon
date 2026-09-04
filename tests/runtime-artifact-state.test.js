import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveFileArtifacts
} from "../apps/runtime/src/run-artifact-service.mjs";
import {
  clearRuntimeArtifactCache,
  getCachedRuntimeArtifacts,
  refreshRuntimeSessionArtifacts
} from "../extensions/dev.tools/runtime-artifact-state.js";

describe("Runtime artifacts and changes", () => {
  afterEach(() => {
    clearRuntimeArtifactCache();
    vi.unstubAllGlobals();
  });

  it("derives deterministic file artifacts from write and patch invocations", () => {
    const written = deriveFileArtifacts({
      invocationId: "invocation-write",
      runId: "run-1",
      toolCall: {
        id: "call-write",
        name: "write",
        arguments: {
          path: "/workspace/a.md",
          content: "one\ntwo"
        }
      }
    }, {
      ok: true,
      content: "written"
    }, 1000);
    expect(written).toMatchObject({
      artifacts: [{
        id: "invocation-write:artifact:0",
        uri: "/workspace/a.md"
      }],
      changes: [{
        operation: "created",
        path: "/workspace/a.md",
        after: "one\ntwo",
        addedLines: 2,
        removedLines: 0
      }]
    });

    const patched = deriveFileArtifacts({
      invocationId: "invocation-patch",
      runId: "run-1",
      toolCall: {
        id: "call-patch",
        name: "apply_patch",
        arguments: {
          patch: [
            "*** Begin Patch",
            "*** Update File: /workspace/a.md",
            "-old",
            "+new",
            "*** Add File: /workspace/b.md",
            "+created",
            "*** End Patch"
          ].join("\n")
        }
      }
    }, {
      ok: true,
      content: "patched"
    }, 2000);
    expect(patched.artifacts.map((artifact) => artifact.uri)).toEqual([
      "/workspace/a.md",
      "/workspace/b.md"
    ]);
    expect(patched.changes[0]).toMatchObject({
      operation: "patch",
      addedLines: 2,
      removedLines: 1
    });
  });

  it("loads Runtime Session changes into the Workbench projection cache", async () => {
    const state = {
      get(key) {
        if (key === "runtime.mode") return "runtime";
        if (key === "runtime.baseUrl") return "http://runtime.test";
        return null;
      }
    };
    const fetchImpl = vi.fn(async () => new globalThis.Response(JSON.stringify({
      sessionId: "session-1",
      artifacts: [{
        id: "artifact-1",
        uri: "/workspace/a.md"
      }],
      changes: [{
        id: "change-1",
        artifactId: "artifact-1",
        invocationId: "invocation-1",
        toolCallId: "call-1",
        toolName: "write",
        operation: "created",
        path: "/workspace/a.md",
        after: "hello",
        addedLines: 1,
        removedLines: 0,
        createdAt: 1000
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    await expect(refreshRuntimeSessionArtifacts({
      sessionId: "session-1",
      state,
      fetchImpl
    })).resolves.toMatchObject({
      loaded: true,
      artifacts: [expect.objectContaining({
        toolCallId: "call-1",
        path: "/workspace/a.md",
        kind: "created",
        runtime: true
      })]
    });
    expect(getCachedRuntimeArtifacts("session-1")).toHaveLength(1);
  });
});
