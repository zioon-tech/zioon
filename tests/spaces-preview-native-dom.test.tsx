import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setAccountSession } from "../packages/account-ui/src/client";
import { mountSpacesWorkbench } from "../src/ui/workbench/SpacesWorkbench";
import { SharedDocument } from "../src/ui/workbench/SharedDocument";

const enabled = process.env.ZIOON_SPACES_PREVIEW_ACCEPTANCE === "1";
const native = globalThis.fetch;
const directory = resolve(".runtime-data/spaces-preview");
let config: any, account: any, host: HTMLElement, root: Root, mount: any;
let calls: Array<{ path: string; scope: string }> = [];
const receipt: string[] = [];
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === label);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
async function until(condition: () => void) {
  await vi.waitFor(async () => { await act(async () => {}); condition(); }, { timeout: 6000, interval: 30 });
}
beforeEach(() => {
  if (!enabled) return;
  config = JSON.parse(readFileSync(resolve(directory, "config.local.json"), "utf8"));
  account = config.accounts[0];
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); localStorage.setItem("zion.runtime.baseUrl", config.runtimeUrl);
  history.replaceState({}, "", "/?space=" + encodeURIComponent(config.teamSpaceId));
  Object.assign(HTMLDialogElement.prototype, { showModal() { this.open = true; }, close() { this.open = false; } });
  host = document.createElement("div"); document.body.append(host);
  calls = [];
  (window as any).zion = { state: { get: (key: string) => key === "sessions.currentId" ? config.sharedDocumentId : undefined },
    sessions: { resolveContext: () => ({ sessionId: config.sharedDocumentId }) },
    commands: { executeCommand: async () => true }, events: { on: () => ({ dispose() {} }) } };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${account.token}`);
    calls.push({ path: new URL(url).pathname, scope: headers.get("x-zioon-space-id") || "" });
    return native(url, { ...init, headers });
  });
});
afterEach(async () => {
  if (!enabled) return;
  await act(async () => { mount?.dispose(); root?.unmount(); });
  mount = null; root = null; host.remove(); setAccountSession(null); vi.unstubAllGlobals();
  writeFileSync(resolve(directory, "acceptance/native-dom.json"), JSON.stringify(receipt, null, 2));
});
describe.skipIf(!enabled)("Workbench controls connected to the isolated native Runtime", () => {
  it("loads real members and resource grants without private source settings", async () => {
    const me = await (await native(config.runtimeUrl + "/v1/account/me", { headers: {
      authorization: `Bearer ${account.token}`, "x-zioon-space-id": config.teamSpaceId
    } })).json();
    setAccountSession(me);
    await act(async () => { mount = mountSpacesWorkbench(host); });
    await click("空间管理");
    await until(() => expect(host.textContent).toContain("空间成员"));
    await click("共享资源");
    await until(() => expect(host.textContent).toContain("共享测试目录 · 只读"));
    expect(host.textContent).toContain("本地测试模型");
    expect(host.textContent).toContain("授权设置");
    expect(host.textContent).not.toContain("55675");
    expect(calls.filter(c => c.path.startsWith("/v1/spaces/")).every(c => c.scope === config.teamSpaceId)).toBe(true);
    receipt.push("PASS owner DOM: native members/resources/grants and scoped requests");
  }, 15000);
  it("renders the real single-document guest view, comments and revoked state", async () => {
    const owner = config.accounts[0]; account = config.accounts[2];
    const path = `/v1/spaces/${encodeURIComponent(config.teamSpaceId)}/documents/${config.guestDocumentId}/access`;
    const current = await (await native(config.runtimeUrl + path, { headers: {
      authorization: `Bearer ${owner.token}`, "x-zioon-space-id": config.teamSpaceId
    } })).json();
    root = createRoot(host);
    await act(async () => root.render(<SharedDocument baseUrl={config.runtimeUrl}
      spaceId={config.teamSpaceId} documentId={config.guestDocumentId} />));
    await until(() => expect(host.querySelector("table")).toBeTruthy());
    expect(host.textContent).toContain("可评论");
    expect(host.querySelector("textarea")).toBeTruthy();
    expect(calls.every(c => !c.path.includes("workbench-state") && !c.path.endsWith("capabilities"))).toBe(true);
    try {
      const revoked = await native(config.runtimeUrl + path, { method: "PUT", headers: {
        authorization: `Bearer ${owner.token}`, "x-zioon-space-id": config.teamSpaceId,
        "content-type": "application/json"
      }, body: JSON.stringify({ expectedRevision: current.document.aclRevision,
        protection: "restricted", audienceMode: "specific",
        grants: [{ subjectType: "user", subjectId: owner.userId, role: "manager" }] }) });
      expect(revoked.status).toBe(200);
      await act(async () => host.querySelector<HTMLButtonElement>('[data-action="refresh"]')!.click());
      await until(() => expect(host.textContent).toContain("文档不可用"));
      expect(host.querySelector(".cm-editor")).toBeNull();
      expect(host.querySelector("textarea")).toBeNull();
      receipt.push("PASS guest DOM: native Markdown table/comment UI/revocation clears content");
    } finally {
      const latest = await (await native(config.runtimeUrl + path, { headers: {
        authorization: `Bearer ${owner.token}`, "x-zioon-space-id": config.teamSpaceId
      } })).json();
      await native(config.runtimeUrl + path, { method: "PUT", headers: {
        authorization: `Bearer ${owner.token}`, "x-zioon-space-id": config.teamSpaceId,
        "content-type": "application/json"
      }, body: JSON.stringify({ expectedRevision: latest.document.aclRevision,
        protection: current.document.protection, audienceMode: current.document.audienceMode, grants: current.grants }) });
    }
  }, 10000);
});
