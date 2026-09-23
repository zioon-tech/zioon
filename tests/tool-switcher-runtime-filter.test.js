import { describe, expect, it } from "vitest";
import {
  filterToolsForRuntime
} from "../extensions/dev.tools/tool-switcher.js";

function state(values) {
  return {
    get(key) {
      return values[key];
    }
  };
}

const tools = [
  { function: { name: "webFetch" } },
  { function: { name: "read" } },
  { function: { name: "Bash" } }
];

describe("tool switcher Runtime filtering", () => {
  it("shows only capabilities currently reachable through Runtime", () => {
    expect(filterToolsForRuntime(tools, state({
      "runtime.connection": { backend: "runtime" },
      "runtime.supportedToolNames": ["webFetch", "read"]
    })).map((tool) => tool.function.name)).toEqual([
      "webFetch",
      "read"
    ]);
  });

  it("prefers Runtime injectable tools over the configurable catalog", () => {
    expect(filterToolsForRuntime(tools, state({
      "runtime.connection": { backend: "runtime" },
      "runtime.supportedToolNames": ["webFetch", "read", "Bash"],
      "runtime.injectableToolNames": ["webFetch"]
    })).map((tool) => tool.function.name)).toEqual([
      "webFetch"
    ]);
  });

  it("does not fall back to all tools when Runtime reports no injectable tools", () => {
    expect(filterToolsForRuntime(tools, state({
      "runtime.connection": { backend: "runtime" },
      "runtime.supportedToolNames": ["webFetch", "read", "Bash"],
      "runtime.injectableToolNames": []
    }))).toEqual([]);
  });

  it("keeps the full catalog in browser mode", () => {
    expect(filterToolsForRuntime(tools, state({
      "runtime.mode": "browser",
      "runtime.supportedToolNames": ["webFetch"]
    }))).toEqual(tools);
  });

  it("shows pluginsManage only after Runtime advertises its plugin capability", () => {
    const catalog = [
      ...tools,
      { function: { name: "pluginsManage" } }
    ];

    expect(filterToolsForRuntime(catalog, state({
      "runtime.connection": { backend: "runtime" },
      "runtime.supportedToolNames": ["webFetch", "pluginsManage"],
      "runtime.capabilityTools": [{
        name: "pluginsManage",
        description: "Runtime Plugin Host management",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["list", "search", "listDev", "startDev", "stopDev"]
            }
          }
        }
      }]
    })).map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      actions: tool.function.parameters?.properties?.action?.enum
    }))).toEqual([
      {
        name: "webFetch",
        description: undefined,
        actions: undefined
      },
      {
        name: "pluginsManage",
        description: "Runtime Plugin Host management",
        actions: ["list", "search", "listDev", "startDev", "stopDev"]
      }
    ]);

    expect(filterToolsForRuntime(catalog, state({
      "runtime.connection": { backend: "runtime" },
      "runtime.supportedToolNames": ["webFetch"]
    })).map((tool) => tool.function.name)).toEqual([
      "webFetch",
    ]);
  });
});
