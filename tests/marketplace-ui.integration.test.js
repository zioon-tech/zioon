import { afterEach, describe, expect, it, vi } from "vitest";
import { mountMarketplace } from "../extensions/dev.plugins/marketplace.js";
import { OFFICIAL_RELEASES, digest } from "../apps/runtime/src/marketplace/catalog.mjs";

const disposables = [];
afterEach(() => {
  disposables.splice(0).forEach((d) => d.dispose());
  document.body.replaceChildren();
  localStorage.clear();
});
const snapshot = () => ({ accountId: "account:test", revision: 0, categories: ["研究写作", "文档", "开发", "外部服务"],
  contributions: [], entries: OFFICIAL_RELEASES.map((entry) => ({ ...entry, digest: digest(entry),
    versions: [{ version: entry.version, digest: digest(entry), changelog: entry.changelog }] })) });
async function mount(fetchImpl, pluginManager = null) {
  const container = document.createElement("div"); document.body.append(container);
  disposables.push(mountMarketplace(container, { fetchImpl, baseUrl: "http://local.test", pluginManager }));
  await vi.waitFor(() => expect(container.querySelector(".zion-marketplace").hasAttribute("aria-busy")).toBe(false));
  return container;
}
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const click = async (host, selector) => {
  host.querySelector(selector).click();
  await vi.waitFor(() => expect(host.querySelector(".zion-marketplace").hasAttribute("aria-busy")).toBe(false));
};

describe("Marketplace UI behavior without a browser", () => {
  it("configures private code tools and validates through the same ordinary Run endpoint", async () => {
    const state = snapshot();
    const entry = { ...state.entries[0], id: "private.u123.code-plugin", kind: "plugin", name: "代码工具", visibility: "private",
      artifact: { kind: "plugin" }, components: [{ id: "code-plugin", kind: "plugin", name: "代码工具" }],
      installation: { enabled: true, status: "configuration_required", version: "1.0.0", executionEpoch: "before", components: [] } };
    state.entries.push(entry);
    const transport = vi.fn(async (url, init) => {
      if (url.endsWith("/connections")) return reply({ connections: [
        { nodeId: "node:my-device", label: "我的 Mac", workspaceRoot: "/workspace", status: "online" }
      ] });
      if (init.method === "PUT") {
        entry.installation.config = JSON.parse(init.body).config;
        entry.installation.executionEpoch = "configured";
        entry.installation.status = "validation_required";
        state.revision++;
        return reply({ installation: entry.installation, revision: state.revision });
      }
      if (url.endsWith("/v1/runs") && init.method === "POST") return reply({ runId: "run:probe" }, 202);
      if (url.endsWith("/v1/runs/run%3Aprobe")) {
        entry.installation.status = "ready";
        entry.installation.validation = { tools: [{ name: "hello", inputSchema: { type: "object" } }] };
        return reply({ run: { status: "completed", output: "hello discovered" } });
      }
      return reply(state);
    });
    const host = await mount(transport);
    await click(host, '[data-tab="private"]');
    const form = host.querySelector(".zm-host-form");
    form.querySelector('[name="nodeId"]').value = "node:my-device";
    form.querySelector('[name="nodeId"]').dispatchEvent(new Event("change", { bubbles: true }));
    expect(form.querySelector('[name="workspaceRoot"]').value).toBe("/workspace");
    expect(form.querySelector('[name="nodeId"]').tagName).toBe("SELECT");
    expect(host.querySelector('[data-action="extension-prepare"]')).toBeNull();
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(host.querySelector('[data-action="extension-probe"]')).not.toBeNull());
    await click(host, '[data-action="extension-probe"]');
    const request = transport.mock.calls.find(([url, init]) => url.endsWith("/v1/runs") && init.method === "POST");
    expect(JSON.parse(request[1].body)).toMatchObject({
      policy: { preset: "trusted-automation", allowedTools: ["extensionsCall", "write", "Bash"], fileRoots: ["/workspace"] },
      metadata: { extensionInvocation: { action: "probe", listingId: entry.id, epoch: "configured" } }
    });
    expect(host.querySelector(".zm-call-form [name=tool]").value).toBe("hello");
    expect(host.querySelector(".zm-detail").textContent).toContain("hello discovered");
  });

  it("keeps private uploads in My Development and selects the fixed uploaded version", async () => {
    const state = snapshot();
    const entry = { ...state.entries[0], id: "private.u123.my-skill", name: "我的私有技能", visibility: "private",
      publisher: { id: "u123", name: "我", origin: "private" }, sourceUrl: undefined };
    state.entries.push(entry);
    const transport = vi.fn(async (_, init) => {
      if (init.method === "POST") {
        entry.installation = { enabled: true, version: "1.0.0", status: "ready", components: [] };
        state.revision++;
      }
      return reply(state);
    });
    const host = await mount(transport);
    expect(host.querySelector(`[data-entry="${entry.id}"]`)).toBeNull();
    await click(host, '[data-tab="private"]');
    expect(host.querySelectorAll(".zm-row")).toHaveLength(1);
    expect(host.querySelector(".zm-detail").textContent).toContain("仅自己可见");
    expect(host.querySelector(".zm-detail").textContent).toContain("已上传版本");
    expect(host.querySelector(".zm-detail a")).toBeNull();
    await click(host, '[data-action="install"]');
    expect(JSON.parse(transport.mock.calls.find(([, init]) => init.method === "POST")[1].body))
      .toMatchObject({ version: "1.0.0", digest: entry.digest, expectedRevision: 0 });
    await click(host, '[data-tab="installed"]');
    expect(host.querySelector(`[data-entry="${entry.id}"]`)).not.toBeNull();
  });

  it("filters while preserving input focus and sends reviewed version identity to account installation", async () => {
    const state = snapshot();
    const transport = vi.fn(async (url, init) => {
      if (init.method === "GET") return reply(state);
      const input = JSON.parse(init.body);
      const entry = state.entries.find((e) => url.endsWith(e.id));
      entry.installation = { enabled: true, version: input.version, digest: input.digest, status: "ready", components: [] };
      state.revision++; return reply({ revision: state.revision });
    });
    const host = await mount(transport);
    const input = host.querySelector('input[type="search"]');
    input.focus(); input.value = "会议"; input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.activeElement).toBe(input);
    expect(host.querySelectorAll(".zm-row")).toHaveLength(1);
    await click(host, '[data-action="install"]');
    const request = transport.mock.calls.find(([, init]) => init.method === "POST");
    expect(JSON.parse(request[1].body)).toMatchObject({ expectedRevision: 0, version: "1.0.0", digest: state.entries[3].digest });
    expect(host.querySelector('[data-action="toggle"]').textContent).toBe("停用");
    expect(host.querySelector(".zm-message").textContent).toContain("已添加到账户");
  });

  it("shows actual API failure without an installed or ready success state", async () => {
    const transport = vi.fn(async (_, init) => init.method === "GET" ? reply(snapshot())
      : reply({ error: "内容摘要不匹配", code: "digest_mismatch" }, 409));
    const host = await mount(transport);
    await click(host, '[data-action="install"]');
    expect(host.querySelector(".zm-message").textContent).toBe("内容摘要不匹配");
    expect(host.querySelector(".zm-message").classList.contains("is-error")).toBe(true);
    expect(host.querySelector('[data-action="toggle"]')).toBeNull();
    expect(host.querySelector('[data-action="install"]').disabled).toBe(false);
  });

  it("escapes contributor content and retains unsaved draft text across view changes", async () => {
    const state = snapshot();
    state.entries[0].name = '<img src=x onerror="alert(1)">';
    const host = await mount(async () => reply(state));
    expect(host.querySelector(".zm-row img")).toBeNull();
    await click(host, '[data-tab="contributions"]');
    const name = host.querySelector('[name="name"]');
    name.value = "我的研究"; name.dispatchEvent(new Event("input", { bubbles: true }));
    await click(host, '[data-tab="discover"]');
    await click(host, '[data-tab="contributions"]');
    expect(host.querySelector('[name="name"]').value).toBe("我的研究");
    expect(host.querySelector('[name="body"]').value).toContain("name: my-skill");
  });

  it("reconciles a built-in Workbench component and restores its previous state after uninstall", async () => {
    const state = snapshot();
    const entry = state.entries.find((e) => e.id === "zion.document-kit");
    entry.installation = { enabled: true, version: entry.version, status: "partially_ready", components: [] };
    const plugin = { id: "dev.toc", enabled: false, status: "disabled" };
    const manager = { list: () => [plugin], enable: vi.fn(async () => { plugin.enabled = true; plugin.status = "active"; }),
      disable: vi.fn(async () => { plugin.enabled = false; plugin.status = "disabled"; }) };
    const transport = async (_, init) => {
      if (init.method === "DELETE") { delete entry.installation; state.revision++; }
      return reply(state);
    };
    const host = await mount(transport, manager);
    expect(manager.enable).toHaveBeenCalledWith("dev.toc");
    host.querySelector(`[data-entry="${entry.id}"]`).click();
    expect(host.querySelector(".zm-detail").textContent).toContain("当前 Workbench 运行中");
    await click(host, '[data-action="remove"]');
    expect(manager.disable).toHaveBeenCalledWith("dev.toc");
    expect(plugin.enabled).toBe(false);
  });
});
