import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CancellationController } from "../../../packages/runtime/src/index";
import {
  RuntimePluginService,
  discoverRuntimePluginManifests
} from "../src/runtime-plugin-service.mjs";
import { SqliteWorkbenchStateStore } from "../src/sqlite-workbench-state-store.mjs";

const resources = [];

function createRoot() {
  const root = mkdtempSync(join(tmpdir(), "zion-runtime-plugins-"));
  resources.push({ root, services: [] });
  return root;
}

function createPlugin(root, {
  id,
  runtimeEntry = "./runtime.mjs",
  runtimeSource,
  entries = { runtime: runtimeEntry },
  runtimeApiVersion = 1
}) {
  const directory = join(root, id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({
    name: id,
    version: "1.0.0",
    zion: {
      id,
      name: id,
      version: "1.0.0",
      main: "./main.js",
      entries,
      runtime: {
        apiVersion: runtimeApiVersion
      }
    }
  }));
  if (runtimeSource != null) {
    writeFileSync(join(directory, "runtime.mjs"), runtimeSource);
  }
  return directory;
}

function trackService(root, service) {
  resources.find((resource) => resource.root === root).services.push(service);
  return service;
}

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) {
    for (const service of resource.services.reverse()) {
      if (service.state === "started") await service.stop();
    }
    rmSync(resource.root, { recursive: true, force: true });
  }
});

describe("RuntimePluginService", () => {
  it("discovers manifests but activates only explicitly enabled Runtime entries", async () => {
    const root = createRoot();
    createPlugin(root, {
      id: "dev.runtime",
      runtimeSource: `
        export const runtimePluginApiVersion = 1;
        export function activateRuntimePlugin(context) {
          return {
            contextProviders: [{
              id: "dev.runtime.context",
              prepare: async () => [{
                role: "user",
                content: context.config.marker
              }]
            }]
          };
        }
      `
    });
    createPlugin(root, {
      id: "dev.ui-only",
      entries: { ui: "./main.js" }
    });

    const discovery = await discoverRuntimePluginManifests([root]);
    expect(discovery.failures).toEqual([]);
    expect(discovery.plugins.map((plugin) => plugin.id)).toEqual([
      "dev.runtime"
    ]);

    const service = trackService(root, new RuntimePluginService({
      pluginRoots: [root],
      enabledPluginIds: ["dev.runtime"],
      configByPluginId: {
        "dev.runtime": { marker: "configured" }
      }
    }));
    const snapshot = await service.start();
    const [provider] = service.getContextProviders();

    expect(snapshot).toMatchObject({
      state: "started",
      plugins: [{
        id: "dev.runtime",
        status: "active",
        contextProviderIds: ["dev.runtime.context"]
      }],
      failures: []
    });
    await expect(provider.prepare()).resolves.toEqual([
      { role: "user", content: "configured" }
    ]);
  });

  it("registers Runtime run post-processors from v2 plugins", async () => {
    const root = createRoot();
    createPlugin(root, {
      id: "dev.processor",
      runtimeApiVersion: 2,
      runtimeSource: `
        export const runtimePluginApiVersion = 2;
        export function activateRuntimePlugin(context) {
          context.runs.registerPostProcessor({
            id: "dev.processor.after-run",
            order: 10,
            async process(run) {
              context.events.emit("processed", run.runId);
            }
          });
          return {};
        }
      `
    });
    const service = trackService(root, new RuntimePluginService({
      pluginRoots: [root],
      enabledPluginIds: ["dev.processor"]
    }));
    const snapshot = await service.start();

    expect(snapshot.plugins[0]).toMatchObject({
      id: "dev.processor",
      status: "active",
      postProcessorIds: ["dev.processor.after-run"]
    });
    const processors = service.getRunPostProcessors();
    expect(processors).toHaveLength(1);
    await expect(processors[0].process({ runId: "run-1" })).resolves.toBeUndefined();
  });

  it("registers a document projector from a v2 Runtime plugin", async () => {
    const root = createRoot();
    createPlugin(root, {
      id: "dev.projector",
      runtimeApiVersion: 2,
      runtimeSource: `
        export const runtimePluginApiVersion = 2;
        export function activateRuntimePlugin(context) {
          context.documents.registerProjector({
            id: "dev.projector.document",
            prepareRun() { return true; },
            projectRun() { return true; }
          });
          return {};
        }
      `
    });
    const service = trackService(root, new RuntimePluginService({
      pluginRoots: [root],
      enabledPluginIds: ["dev.projector"]
    }));
    const snapshot = await service.start();

    expect(snapshot.plugins[0]).toMatchObject({
      id: "dev.projector",
      status: "active",
      documentProjectorIds: ["dev.projector.document"]
    });
    expect(service.getDocumentProjector("dev.projector.document"))
      .toMatchObject({
        id: "dev.projector.document",
        pluginId: "dev.projector"
      });
  });

  it("rejects entry paths outside the plugin and unsupported API versions", async () => {
    const root = createRoot();
    createPlugin(root, {
      id: "dev.escape",
      runtimeEntry: "../outside.mjs",
      runtimeSource: ""
    });
    createPlugin(root, {
      id: "dev.future",
      runtimeApiVersion: 99,
      runtimeSource: `
        throw new Error("must not import");
      `
    });

    const service = trackService(root, new RuntimePluginService({
      pluginRoots: [root],
      enabledPluginIds: ["dev.escape", "dev.future"]
    }));
    const snapshot = await service.start();

    expect(service.getContextProviders()).toEqual([]);
    expect(snapshot.plugins).toEqual([
      expect.objectContaining({ id: "dev.escape", status: "failed" }),
      expect.objectContaining({ id: "dev.future", status: "failed" })
    ]);
    expect(snapshot.failures).toEqual([
      expect.objectContaining({
        id: "dev.escape",
        phase: "manifest",
        message: expect.stringContaining("entries.runtime must be a safe relative ./ path")
      }),
      expect.objectContaining({
        id: "dev.future",
        phase: "activation",
        message: expect.stringContaining("declares API version 99")
      })
    ]);
  });

  it("lets Runtime API v2 plugins register model-callable tools", async () => {
    const root = createRoot();
    createPlugin(root, {
      id: "dev.tool",
      runtimeApiVersion: 2,
      runtimeSource: `
        export const runtimePluginApiVersion = 2;
        export function activateRuntimePlugin(context) {
          context.context.registerProvider({
            id: "dev.tool.context",
            prepare: async () => []
          });
          context.tools.registerTool({
            name: "dev.tool.echo",
            description: "Echo text from the plugin.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
              additionalProperties: false
            },
            policy: { minimumPreset: "read-only" },
            async invoke(args, runContext) {
              context.state.namespace("calls").set("lastRunId", runContext.runId);
              context.events.emit("dev.tool.called", args.text);
              return { ok: true, content: context.plugin.id + ":" + args.text };
            }
          });
          context.tools.registerTool({
            name: "memoryManage",
            description: "Memory management contract.",
            inputSchema: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: ["list", "tree", "read", "search", "build_context", "providers", "create", "update", "delete", "select", "settings"]
                }
              },
              required: ["action"],
              additionalProperties: false
            },
            policy: { minimumPreset: "read-only" },
            async invoke() {
              return { ok: true, content: "ok" };
            }
          });
          context.tools.registerTool({
            name: "identityManage",
            description: "Identity management contract.",
            inputSchema: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: ["get", "update_snapshot", "patch_files", "append_biography_events", "load_files", "write_files", "clear"]
                }
              },
              required: ["action"],
              additionalProperties: false
            },
            policy: { minimumPreset: "read-only" },
            async invoke() {
              return { ok: true, content: "ok" };
            }
          });
          context.tools.registerTool({
            name: "projectAutomationManage",
            description: "Project automation management contract.",
            inputSchema: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: ["get", "request_update", "disable"]
                }
              },
              required: ["action"],
              additionalProperties: false
            },
            policy: { minimumPreset: "read-only" },
            async invoke() {
              return { ok: true, content: "ok" };
            }
          });
          return {};
        }
      `
    });

    const service = trackService(root, new RuntimePluginService({
      pluginRoots: [root],
      enabledPluginIds: ["dev.tool"]
    }));
    const snapshot = await service.start();

    expect(snapshot.plugins).toEqual([
      expect.objectContaining({
        id: "dev.tool",
        status: "active",
        contextProviderIds: ["dev.tool.context"],
        toolNames: ["dev.tool.echo", "memoryManage", "identityManage", "projectAutomationManage"]
      })
    ]);
    expect(service.getContextProviders().map((provider) => provider.id)).toEqual([
      "dev.tool.context"
    ]);
    await expect(service.listTools({
      policy: {
        preset: "read-only",
        allowedTools: ["dev.tool.echo"]
      }
    })).resolves.toEqual([
      expect.objectContaining({
        name: "dev.tool.echo",
        pluginId: "dev.tool",
        hostKinds: ["runtime-plugin", "plugin:dev.tool"],
        policy: {
          minimumPreset: "read-only"
        }
      })
    ]);
    await expect(service.listTools({
      policy: {
        preset: "read-only",
        allowedTools: ["memoryManage"]
      }
    })).resolves.toEqual([
      expect.objectContaining({
        name: "memoryManage",
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            action: {
              type: "string",
              enum: ["list", "tree", "read", "search", "build_context", "providers"]
            }
          })
        })
      })
    ]);
    await expect(service.listTools({
      policy: {
        preset: "workspace-write",
        allowedTools: ["memoryManage"]
      }
    })).resolves.toEqual([
      expect.objectContaining({
        name: "memoryManage",
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            action: {
              type: "string",
              enum: ["list", "tree", "read", "search", "build_context", "providers", "create", "update", "delete", "select", "settings"]
            }
          })
        })
      })
    ]);
    await expect(service.listTools({
      policy: {
        preset: "read-only",
        allowedTools: ["identityManage"]
      }
    })).resolves.toEqual([
      expect.objectContaining({
        name: "identityManage",
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            action: {
              type: "string",
              enum: ["get"]
            }
          })
        })
      })
    ]);
    await expect(service.listTools({
      policy: {
        preset: "workspace-write",
        allowedTools: ["identityManage"]
      }
    })).resolves.toEqual([
      expect.objectContaining({
        name: "identityManage",
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            action: {
              type: "string",
              enum: ["get", "update_snapshot", "patch_files", "append_biography_events", "load_files", "write_files", "clear"]
            }
          })
        })
      })
    ]);
    await expect(service.listTools({
      policy: {
        preset: "read-only",
        allowedTools: ["projectAutomationManage"]
      }
    })).resolves.toEqual([
      expect.objectContaining({
        name: "projectAutomationManage",
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            action: {
              type: "string",
              enum: ["get"]
            }
          })
        })
      })
    ]);
    await expect(service.listTools({
      policy: {
        preset: "workspace-write",
        allowedTools: ["projectAutomationManage"]
      }
    })).resolves.toEqual([
      expect.objectContaining({
        name: "projectAutomationManage",
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            action: {
              type: "string",
              enum: ["get", "request_update", "disable"]
            }
          })
        })
      })
    ]);
    await expect(service.invoke({
      runId: "run-1",
      attemptId: "attempt-1",
      policy: {
        preset: "read-only",
        allowedTools: ["dev.tool.echo"]
      },
      toolCall: {
        id: "call-1",
        name: "dev.tool.echo",
        arguments: { text: "hello" }
      }
    }, new CancellationController().signal)).resolves.toEqual({
      ok: true,
      content: "dev.tool:hello"
    });
  });

  it("persists Runtime plugin state namespaces through the provided state store", async () => {
    const root = createRoot();
    const stateStore = new SqliteWorkbenchStateStore(":memory:");
    createPlugin(root, {
      id: "dev.stateful",
      runtimeApiVersion: 2,
      runtimeSource: `
        export const runtimePluginApiVersion = 2;
        export function activateRuntimePlugin(context) {
          const state = context.state.namespace("skills");
          state.set("snapshot", { enabled: ["one"] });
          context.context.registerProvider({
            id: "dev.stateful.context",
            prepare: async () => [{
              role: "user",
              content: JSON.stringify(state.get("snapshot"))
            }]
          });
          return {};
        }
      `
    });

    const service = trackService(root, new RuntimePluginService({
      pluginRoots: [root],
      enabledPluginIds: ["dev.stateful"],
      stateStore
    }));
    await service.start();
    const [provider] = service.getContextProviders();

    expect(stateStore.readKV("runtime.plugins.dev.stateful.skills.snapshot")?.value)
      .toEqual({ enabled: ["one"] });
    await expect(provider.prepare()).resolves.toEqual([
      { role: "user", content: "{\"enabled\":[\"one\"]}" }
    ]);
    stateStore.close?.();
  });

  it("isolates a duplicate Provider and rolls back the rejected plugin", async () => {
    const root = createRoot();
    const logs = [];
    createPlugin(root, {
      id: "dev.first",
      runtimeSource: `
        export const runtimePluginApiVersion = 1;
        export function activateRuntimePlugin() {
          return {
            contextProviders: [{
              id: "shared.context",
              prepare: async () => []
            }]
          };
        }
      `
    });
    createPlugin(root, {
      id: "dev.duplicate",
      runtimeSource: `
        export const runtimePluginApiVersion = 1;
        export function activateRuntimePlugin(context) {
          context.log("info", "activated");
          return {
            contextProviders: [{
              id: "shared.context",
              prepare: async () => []
            }],
            dispose() {
              context.log("info", "rolled back");
            }
          };
        }
      `
    });

    const service = trackService(root, new RuntimePluginService({
      pluginRoots: [root],
      enabledPluginIds: ["dev.first", "dev.duplicate"],
      logger(event) {
        logs.push(`${event.pluginId}:${event.message}`);
      }
    }));
    const snapshot = await service.start();

    expect(service.getContextProviders().map((provider) => provider.id)).toEqual([
      "shared.context"
    ]);
    expect(snapshot.plugins).toEqual([
      expect.objectContaining({ id: "dev.first", status: "active" }),
      expect.objectContaining({ id: "dev.duplicate", status: "failed" })
    ]);
    expect(logs).toEqual([
      "dev.duplicate:activated",
      "dev.duplicate:rolled back",
      expect.stringContaining("dev.duplicate:activation:")
    ]);
  });

  it("disposes active plugins in reverse activation order", async () => {
    const root = createRoot();
    const logs = [];
    for (const id of ["dev.first", "dev.second"]) {
      createPlugin(root, {
        id,
        runtimeSource: `
          export const runtimePluginApiVersion = 1;
          export function activateRuntimePlugin(context) {
            context.log("info", "activated");
            return {
              contextProviders: [{
                id: context.plugin.id + ".context",
                prepare: async () => []
              }],
              dispose() {
                context.log("info", "disposed");
              }
            };
          }
        `
      });
    }

    const service = trackService(root, new RuntimePluginService({
      pluginRoots: [root],
      enabledPluginIds: ["dev.first", "dev.second"],
      logger(event) {
        logs.push(`${event.pluginId}:${event.message}`);
      }
    }));
    await service.start();
    const snapshot = await service.stop();

    expect(snapshot.state).toBe("stopped");
    expect(logs).toEqual([
      "dev.first:activated",
      "dev.second:activated",
      "dev.second:disposed",
      "dev.first:disposed"
    ]);
  });
});
