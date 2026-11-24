import { describe, expect, it, vi, afterEach } from "vitest";
import { mergeMigratedSessionTree, mergeSessionTree, sessionTreeChanges } from "../apps/runtime/src/session-tree-merge.mjs";
import { invalidateRuntimeDynamicModelCache, loadRuntimeModelProfiles } from "../extensions/dev.langchain-chat/runtime-user-model-store.js";
import { setAccountSession } from "../packages/account-ui/src/client.ts";
import { Readable } from "node:stream";
import { createWorkbenchStateHttpHandler } from "../apps/runtime/src/workbench-state-http-handler.mjs";

const session = (id, title = id) => ({ id, type: "session", title });
const folder = (id, children = [], title = id) => ({ id, type: "folder", title, children });
const root = children => folder("root", children, "Sessions");
const copy = value => structuredClone(value);
const options = fetchImpl => ({
  state: { get: key => key === "runtime.mode" ? "runtime" : undefined },
  storage: { getItem: () => null },
  fetchImpl
});
const response = profiles => new Response(JSON.stringify({ profiles }), {
  status: 200, headers: { "content-type": "application/json" }
});

afterEach(() => {
  invalidateRuntimeDynamicModelCache();
  vi.restoreAllMocks();
  setAccountSession(null);
});

describe("sidebar concurrent persistence", () => {
  async function saveTree(body, protocol = "5") {
    const store = { readSnapshot: vi.fn(), updateSession: vi.fn(), writeTree: vi.fn(async () => ({ ok: true })) };
    const request = Readable.from([Buffer.from(JSON.stringify(body))]);
    request.method = "PUT";
    request.headers = { "x-zion-workbench-protocol": protocol };
    const response = { writeHead: vi.fn(), end: vi.fn() };
    await createWorkbenchStateHttpHandler({ store })(
      request, response, new URL("http://test/v1/workbench-state/tree")
    );
    return { store, response };
  }

  it("requires an old tab to refresh before it can overwrite the whole tree", async () => {
    const { store, response } = await saveTree({ tree: root([]) });
    expect(response.writeHead).toHaveBeenCalledWith(426, expect.any(Object));
    expect(store.writeTree).not.toHaveBeenCalled();
  });

  it("passes the base snapshot to the transactional tree merge", async () => {
    const tree = root([folder("new")]);
    const base = root([]);
    const { store, response } = await saveTree({ tree, base_tree: base }, "6");
    expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(store.writeTree).toHaveBeenCalledWith(tree, undefined, null, "", base, null);
  });

  it("preserves another tab's empty folder when a stale tab creates a session", () => {
    const base = root([]);
    expect(mergeSessionTree(base, root([session("s")]), root([folder("轩轩")])).children)
      .toEqual([session("s"), folder("轩轩")]);
  });

  it("keeps a session in its folder when the Runtime first creates it at root", () => {
    const base = root([folder("f")]);
    const desired = root([folder("f", [session("s", "New")])]);
    const current = root([session("s", "New"), folder("f")]);
    expect(mergeSessionTree(base, desired, current)).toEqual(desired);
  });

  it("preserves remote moves and renamed titles when local edits concern another node", () => {
    const base = root([folder("f"), session("s", "before")]);
    const desired = copy(base);
    desired.children.unshift(folder("local"));
    const current = root([folder("f", [session("s", "manual title")])]);
    expect(mergeSessionTree(base, desired, current))
      .toEqual(root([folder("local"), folder("f", [session("s", "manual title")])]));
  });

  it("does not resurrect a remotely deleted folder from an unchanged tab", () => {
    const base = root([folder("gone")]);
    const desired = root([folder("local"), folder("gone")]);
    expect(mergeSessionTree(base, desired, root([]))).toEqual(root([folder("local")]));
  });

  it("preserves explicit local folder deletion while keeping concurrent additions", () => {
    const base = root([folder("deleted"), folder("kept")]);
    const current = root([folder("other"), ...base.children]);
    expect(mergeSessionTree(base, root([folder("kept")]), current))
      .toEqual(root([folder("other"), folder("kept")]));
  });

  it("applies repeated acknowledged edits without duplicating nodes", () => {
    const base = root([folder("f")]);
    const desired = root([folder("f", [session("s")])]);
    expect(mergeSessionTree(base, desired, desired)).toEqual(desired);
  });

  it("rejects cycles caused by concurrent moves", () => {
    const base = root([folder("a"), folder("b")]);
    const desired = root([folder("b", [folder("a")])]);
    const current = root([folder("a", [folder("b")])]);
    expect(() => mergeSessionTree(base, desired, current)).toThrow(/cycle/);
  });

  it("rejects inserting into a folder removed by another tab", () => {
    const base = root([folder("gone")]);
    const desired = root([folder("gone", [session("s")])]);
    expect(() => mergeSessionTree(base, desired, root([]))).toThrow(/removed/);
  });

  it("keeps empty and nested browser folders during migration without replacing newer placements", () => {
    const current = root([folder("new", [session("existing")])]);
    const source = root([folder("legacy", [folder("empty"), session("existing"), session("imported")])]);
    expect(mergeMigratedSessionTree(current, source)).toEqual(root([
      folder("new", [session("existing")]),
      folder("legacy", [folder("empty"), session("imported")])
    ]));
  });

  it("records only changed node summaries for later recovery", () => {
    expect(sessionTreeChanges(root([]), root([folder("轩轩")]))).toEqual([{
      before: null, after: { id: "轩轩", type: "folder", title: "轩轩", parentId: "root" }
    }]);
  });
});

describe("model catalog on the submit path", () => {
  it("returns cached profiles immediately while an expired catalog refresh is stalled", async () => {
    let finish;
    const fetchImpl = vi.fn().mockResolvedValueOnce(response([{ id: "selected" }]))
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const config = options(fetchImpl);
    await loadRuntimeModelProfiles(config);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    await expect(loadRuntimeModelProfiles(config)).resolves.toEqual([{ id: "selected" }]);
    await expect(loadRuntimeModelProfiles(config)).resolves.toEqual([{ id: "selected" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    finish(response([{ id: "refreshed" }]));
  });

  it("does not reuse model profiles after switching accounts", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response([{ id: "a" }]))
      .mockResolvedValueOnce(response([{ id: "b" }]));
    const config = options(fetchImpl);
    setAccountSession({ user: { id: "a" }, space: { id: "a" }, scopes: [], sessionId: "a" });
    await expect(loadRuntimeModelProfiles(config)).resolves.toEqual([{ id: "a" }]);
    setAccountSession({ user: { id: "b" }, space: { id: "b" }, scopes: [], sessionId: "b" });
    await expect(loadRuntimeModelProfiles(config)).resolves.toEqual([{ id: "b" }]);
  });

  it("does not let a late pre-invalidation response replace a newer configuration", async () => {
    let finish;
    const fetchImpl = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(response([{ id: "new" }]));
    const config = options(fetchImpl);
    const old = loadRuntimeModelProfiles(config);
    invalidateRuntimeDynamicModelCache();
    await loadRuntimeModelProfiles(config);
    finish(response([{ id: "old" }]));
    await old;
    await expect(loadRuntimeModelProfiles(config)).resolves.toEqual([{ id: "new" }]);
  });
});
