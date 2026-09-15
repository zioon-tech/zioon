import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildBiographyDigest,
  buildBiographyFacets,
  buildBiographyProjects,
  buildBiographySessionTagSource,
  buildIdentityContext,
  extractBiographyCitations,
  extractLatestExchange,
  filterBiographyEvents,
  groupBiographyEvents,
  parseBiographyEventsJsonl,
  parseDistillationResult,
  serializeBiographyEventsJsonl
} from "../extensions/dev.identity/identity-core.js";
import {
  activate as activateIdentity,
  getLocalToolsBase
} from "../extensions/dev.identity/main.js";

const activate = (context) => activateIdentity({
  ...context,
  locations: { data: Promise.resolve({
    nodeId: "cloud", root: "/Users/test/.zion-next/data/plugins/dev.identity"
  }) }
});

describe("identity local-tools routing", () => {
  it("uses the authenticated Runtime Device Service gateway remotely", () => {
    const previous = window.zion;
    try {
      window.zion = {
        state: {
          get(key) {
            if (key === "runtime.connection") {
              return {
                backend: "runtime",
                baseUrl: "https://zion.example.com/"
              };
            }
            if (key === "localTools.baseUrl") {
              return "http://127.0.0.1:8765";
            }
            return undefined;
          }
        }
      };

      expect(getLocalToolsBase()).toBe(
        "https://zion.example.com/v1/device-services/local-tools"
      );
    } finally {
      window.zion = previous;
    }
  });

  it("uses configured Runtime routing before runtime.connection is published", async () => {
    const previous = window.zion;
    try {
      localStorage.setItem("zion.debug.identityCspFetch", "1");
      localStorage.setItem("zion.runtime.mode", "runtime");
      localStorage.setItem("zion.runtime.baseUrl", "https://runtime.zioon.tech");
      window.zion = {
        state: {
          get() {
            return undefined;
          }
        }
      };

      expect(getLocalToolsBase()).toBe(
        "https://runtime.zioon.tech/v1/device-services/local-tools"
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      localStorage.removeItem("zion.debug.identityCspFetch");
      localStorage.removeItem("zion.runtime.mode");
      localStorage.removeItem("zion.runtime.baseUrl");
      window.zion = previous;
    }
  });
});

describe("identity context core", () => {
  it("extracts unique biography citation markers", () => {
    expect(extractBiographyCitations(
      "采用旧方案。[[memory:session-1:run-1:0]] 后来又验证了一次。[memory:session-1:run-1:0]"
    )).toEqual(["session-1:run-1:0"]);
    expect(extractBiographyCitations("没有记忆引用 [memory: ] [memory:bad id]")).toEqual([]);
  });

  it("builds escaped context from the three profile files", () => {
    const text = buildIdentityContext({
      identity: "Name: Zion <trusted>",
      user: "Prefers A & B",
      biography: "- shipped identity",
      projects: "# 项目索引\n| Zion Next | active | high | 完成 M1 | 08-18 |",
      projectsInbox: "# 杂思收集箱\n- 评估 M2",
      projectsAttention: "# 待处理事项\n- [ ] 批准执行"
    });

    expect(text).toContain("<agent_identity");
    expect(text).toContain("<user_profile");
    expect(text).toContain("<biography");
    expect(text).toContain("<projects_index");
    expect(text).toContain("<projects_inbox");
    expect(text).toContain("<projects_attention");
    expect(text).toContain("Zion Next");
    expect(text).toContain("评估 M2");
    expect(text).toContain("批准执行");
    expect(text).toContain("legacy and non-authoritative");
    expect(text).toContain("projectAutomationManage");
    expect(text).toContain("&lt;trusted&gt;");
    expect(text).toContain("A &amp; B");
    expect(text).not.toContain("Name: Zion <trusted>");
    expect(text).toContain("~/.zion-next/data/plugins/dev.identity/biography/events.jsonl");
    expect(text).toContain("user-owned read-only data");
    expect(text).toContain("model-maintained working memory");
    expect(text).toContain("Project working-memory routine");
    expect(text).toContain("use semantic judgment");
    expect(text).toContain("Before every final answer");
    expect(text).toContain("Do not infer autonomy grants");
    expect(text).toContain("[[memory:<event-id>]]");
    expect(text).toContain("Only valid biography event markers count as cited memory");
    const emptyProjects = buildIdentityContext({ identity: "Zion" });
    expect(emptyProjects).not.toContain("<projects_index");
    expect(emptyProjects).toContain("model-maintained working memory");
    expect(emptyProjects).toContain("create projects/{canonical-slug}/project.md");
  });

  it("extracts only the latest completed user and assistant exchange", () => {
    expect(extractLatestExchange([
      { role: "user", content: "first" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: [{ type: "text", text: "latest request" }] },
      { role: "assistant", content: "latest result" },
      { role: "user", content: "" }
    ])).toEqual({
      user: "latest request",
      assistant: "latest result"
    });
  });

  it("accepts only valid bounded distillation events", () => {
    const events = parseDistillationResult(`\`\`\`json
{"events":[
  {"kind":"decision","summary":"采用本地文件存储","project":"Memory_Panel","topics":["Agent Identity","storage","storage"],"confirmed":true},
  {"kind":"chat","summary":"普通聊天"},
  {"kind":"outcome","summary":"完成身份扩展"},
  {"kind":"lesson","summary":"第三条应被数量上限截断"}
]}
\`\`\``);

    expect(events).toEqual([
      {
        kind: "decision",
        summary: "采用本地文件存储",
        confirmed: true,
        project: "memory-panel",
        topics: ["agent-identity", "storage"]
      },
      {
        kind: "outcome",
        summary: "完成身份扩展",
        confirmed: false,
        project: "",
        topics: []
      }
    ]);
    expect(parseDistillationResult('{"events":[]}')).toEqual([]);
  });

  it("parses deduplicated JSONL events and builds a bounded digest", () => {
    const event = {
      id: "session-1:run-1:0",
      at: "2026-08-12T10:00:00.000Z",
      kind: "outcome",
      summary: "完成身份与自传最小闭环",
      confirmed: false,
      project: "memory-panel",
      topics: ["agent-identity"],
      sessionId: "session-1",
      runId: "run-1"
    };
    const jsonl = serializeBiographyEventsJsonl([event, event]);
    const events = parseBiographyEventsJsonl(`${jsonl}\nnot-json\n`);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining(event));
    expect(buildBiographyDigest(events)).toContain("完成身份与自传最小闭环");
    expect(buildBiographyDigest(events)).toContain("[project/memory-panel]");
    expect(buildBiographyDigest(events)).toContain("[topic/agent-identity]");
    expect(buildBiographyDigest(events)).toContain("（会话：session-1）");
    expect(buildBiographyDigest(events)).toContain("[[memory:session-1:run-1:0]]");
    expect(buildBiographyDigest([
      ...events,
      { ...event, id: "session-2:run-2:0", project: "zion-core", at: "2026-08-11T10:00:00.000Z" }
    ])).toMatch(/## memory-panel \[project\/memory-panel\]（1 条）[\s\S]*## zion-core \[project\/zion-core\]（1 条）/);
    expect(buildBiographyDigest(events)).toContain("events.jsonl");
  });

  it("groups events by date and session with a session time range", () => {
    const base = {
      kind: "decision",
      summary: "采用按会话分组的日志结构",
      confirmed: true,
      sessionId: "session-grouped"
    };
    const groups = groupBiographyEvents([
      { ...base, id: "event-1", runId: "run-1", at: "2026-08-12T10:00:00.000Z" },
      { ...base, id: "event-2", runId: "run-2", at: "2026-08-12T10:30:00.000Z", summary: "完成分组实现" }
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].sessions).toHaveLength(1);
    expect(groups[0].sessions[0].sessionId).toBe("session-grouped");
    expect(groups[0].sessions[0].events).toHaveLength(2);
    expect(groups[0].sessions[0].timeRange).toMatch(/^\d{2}:\d{2}-\d{2}:\d{2}$/);
  });

  it("filters biography events by time, query, and multi-value facets", () => {
    const base = {
      confirmed: false,
      sessionId: "session-filter"
    };
    const events = [
      {
        ...base,
        id: "event-memory",
        runId: "run-memory",
        at: "2026-08-13T09:00:00.000Z",
        kind: "decision",
        project: "memory-panel",
        topics: ["biography", "ui"],
        summary: "采用动态流展示经历事件"
      },
      {
        ...base,
        id: "event-cost",
        runId: "run-cost",
        at: "2026-08-10T09:00:00.000Z",
        kind: "outcome",
        project: "script-gen",
        topics: ["cost"],
        summary: "计算视频模型成本"
      },
      {
        ...base,
        id: "event-old",
        runId: "run-old",
        at: "2026-06-01T09:00:00.000Z",
        kind: "lesson",
        project: "memory-panel",
        topics: ["storage"],
        summary: "旧的存储经验"
      }
    ];

    expect(filterBiographyEvents(events, {
      timeRange: "7d"
    }, "2026-08-13T12:00:00.000Z").map((event) => event.id)).toEqual([
      "event-memory",
      "event-cost"
    ]);
    expect(filterBiographyEvents(events, {
      query: "视频",
      projects: new Set(["script-gen", "memory-panel"]),
      kinds: new Set(["outcome"])
    }).map((event) => event.id)).toEqual(["event-cost"]);
    expect(filterBiographyEvents(events, {
      projects: new Set(["memory-panel"]),
      topics: new Set(["ui", "cost"])
    }).map((event) => event.id)).toEqual(["event-memory"]);
  });

  it("builds sorted biography facets", () => {
    const base = {
      confirmed: false,
      sessionId: "session-facets"
    };
    const facets = buildBiographyFacets([
      { ...base, id: "1", runId: "1", at: "2026-08-13T09:00:00.000Z", kind: "decision", project: "memory-panel", topics: ["ui"], summary: "A" },
      { ...base, id: "2", runId: "2", at: "2026-08-13T10:00:00.000Z", kind: "outcome", project: "memory-panel", topics: ["ui", "biography"], summary: "B" },
      { ...base, id: "3", runId: "3", at: "2026-08-13T11:00:00.000Z", kind: "outcome", project: "script-gen", topics: ["cost"], summary: "C" }
    ]);

    expect(facets.projects[0]).toEqual({ value: "memory-panel", count: 2 });
    expect(facets.kinds[0]).toEqual({ value: "outcome", count: 2 });
    expect(facets.topics[0]).toEqual({ value: "ui", count: 2 });
  });

  it("aggregates biography events into project summaries", () => {
    const projects = buildBiographyProjects([
      {
        id: "project-1",
        at: "2026-08-12T10:00:00.000Z",
        kind: "outcome",
        summary: "完成项目视图",
        project: "memory-panel",
        topics: ["biography", "ui"],
        sessionId: "session-1",
        runId: "run-1"
      },
      {
        id: "project-2",
        at: "2026-08-13T10:00:00.000Z",
        kind: "lesson",
        summary: "保留事件事实源",
        project: "memory-panel",
        topics: ["storage"],
        sessionId: "session-2",
        runId: "run-2"
      }
    ]);

    expect(projects).toEqual([
      expect.objectContaining({
        project: "memory-panel",
        eventCount: 2,
        sessionCount: 2,
        topics: ["biography", "storage", "ui"],
        latestEvents: expect.arrayContaining([
          expect.objectContaining({ id: "project-2" })
        ])
      })
    ]);
  });

  it("projects biography projects and topics into per-session derived tags", () => {
    const source = buildBiographySessionTagSource([
      {
        id: "event-1",
        at: "2026-08-13T10:00:00.000Z",
        kind: "outcome",
        summary: "完成标签投影",
        project: "memory-panel",
        topics: ["ui", "storage"],
        sessionId: "session-1",
        runId: "run-1"
      },
      {
        id: "event-2",
        at: "2026-08-13T11:00:00.000Z",
        kind: "lesson",
        summary: "复用标签",
        project: "memory-panel",
        topics: ["ui"],
        sessionId: "session-1",
        runId: "run-2"
      }
    ]);

    expect(source).toEqual({
      id: "biography",
      label: "Biography",
      readOnly: true,
      sessions: {
        "session-1": [
          { path: "project/memory-panel", kind: "project" },
          { path: "topic/ui", kind: "topic" },
          { path: "topic/storage", kind: "topic" }
        ]
      }
    });
  });
});

describe("identity extension", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    delete window.zion;
  });

  it("injects profile files after leading system messages", async () => {
    let contributor;
    let biographyView;
    let inspectorItem;
      const commands = new Map();
    const subscriptions = [];
    const stateValues = new Map();
    const eventHandlers = new Map();
    const fileWrites = [];
    let automationContent = '{"version":1,"projects":{"zion-next":{"enabled":true,"mode":"execute"}}}';
    window.zion = {
      messages: {
        registerContributor(value) {
          contributor = value;
          return { dispose: vi.fn() };
        }
      },
      commands: {
          registerCommand: vi.fn((id, handler) => {
            commands.set(id, handler);
            return { dispose: vi.fn() };
          })
      },
      events: {
        on: vi.fn((topic, handler) => {
          eventHandlers.set(topic, handler);
          return { dispose: vi.fn(() => eventHandlers.delete(topic)) };
        }),
        emit: vi.fn((topic, payload) => eventHandlers.get(topic)?.(payload))
      },
      auxiliaryBar: {
        registerView: vi.fn((value) => {
          biographyView = value;
          return { dispose: vi.fn() };
        })
      },
      activityBar: {
        registerItem: vi.fn(() => ({ dispose: vi.fn() }))
      },
      inspector: {
        open: vi.fn((item) => {
          inspectorItem = item;
        }),
        clearOwner: vi.fn()
      },
      agents: {
        createTask: vi.fn((task) => task),
        runTaskHeadless: vi.fn(async (taskId) => ({
          ok: true,
          task: { id: taskId, status: "done", result: { workResult: "research complete" } }
        })),
        getTask: vi.fn(() => null),
        isRunning: vi.fn(() => false),
        updateTask: vi.fn()
      },
      state: {
        get: vi.fn((key) => {
          if (key === "localTools.baseUrl") return "http://127.0.0.1:9999";
          if (key === "terminal.sessions") return [{ id: "term-1", type: "local", cwd: "/Users/test/project" }];
          if (key === "sessions.catalog") return [{ id: "session-view", title: "Biography UI redesign" }];
          return stateValues.get(key) ?? null;
        }),
        set: vi.fn((key, value) => stateValues.set(key, value))
      }
    };
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const requestUrl = new URL(url);
      if (options.method === "POST") {
        const body = JSON.parse(options.body);
        fileWrites.push(body);
        return new globalThis.Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (requestUrl.pathname.endsWith("/files/entries")) {
        return new globalThis.Response(JSON.stringify({
          path: "/Users/test/.zion-next/data/plugins/dev.identity/projects",
          results: [
            {
              path: "/Users/test/.zion-next/data/plugins/dev.identity/projects/zion-next",
              type: "dir"
            }
          ]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      const path = decodeURIComponent(requestUrl.searchParams.get("path"));
      const content = path.endsWith("identity.md")
        ? "# Identity\nZion"
        : path.endsWith("user.md")
          ? "# User\nChinese"
          : path.endsWith("projects/index.md")
            ? "# 项目索引\n| 项目 | 状态 | 优先级 | 下一步 | 更新 |\n|---|---|---|---|---|\n| [Zion Next](./zion-next/project.md) | active | high | 完成 M1 | 2026-08-19 |"
          : path.endsWith("projects/inbox.md")
            ? "# 杂思收集箱\n\n- 评估 M2"
          : path.endsWith("projects/attention.md")
            ? "# 待处理事项\n\n- [ ] 批准执行\n\n<!-- automation:zion-next:run-failed -->\n- [ ] 2026-08-19T01:00:00.000Z · **Zion Next** · 自动推进运行失败"
          : path.endsWith("projects/.automation.json")
            ? automationContent
          : path.endsWith("zion-next/project.md")
            ? "# Zion Next\n\n## 目标\n\n完成项目自动化。\n\n## 当前状态\n\nM1 已完成\n\n## 计划\n\n- [ ] 完成 M2"
          : path.endsWith("digest.md")
            ? "# 自传摘要\n\n- Shipped biography digest"
            : `${JSON.stringify({
              id: "session-view:run-view:0",
              at: "2026-08-12T10:00:00.000Z",
              kind: "outcome",
              summary: "Shipped biography view",
              confirmed: false,
              project: "memory-panel",
              topics: ["agent-identity"],
              sessionId: "session-view",
              runId: "run-view"
            })}\n`;
      return new globalThis.Response(JSON.stringify({ content }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));

    const disposable = await activate({ subscriptions });
    await vi.waitFor(() => expect(stateValues.get("sessions.derivedTags")?.biography).toBeTruthy());
    expect(stateValues.get("sessions.derivedTags").biography.sessions["session-view"]).toEqual([
      { path: "project/memory-panel", kind: "project" },
      { path: "topic/agent-identity", kind: "topic" }
    ]);
    const messages = await contributor.contribute([
      { role: "system", content: "base" },
      { role: "user", content: "hello" }
    ]);

    expect(contributor).toMatchObject({ id: "dev.identity.context", order: 85, stage: "pre" });
    expect(messages.map((message) => message.role)).toEqual(["system", "system", "user"]);
    expect(messages[1].content).toContain("<identity_context>");
    expect(messages[1].content).toContain("Shipped biography digest");
    expect(messages[1].content).not.toContain("Shipped biography view");
    expect(messages[1].content).toContain("<projects_index");
    expect(messages[1].content).toContain("<projects_inbox");
    expect(messages[1].content).toContain("<projects_attention");
    expect(messages[1].content).toContain("| [Zion Next](./zion-next/project.md) | active |");
    expect(messages[1].content).toContain("评估 M2");
      const sessionEvents = await commands.get("identity.getSessionBiographyEvents")({ sessionId: "session-view" });
      expect(sessionEvents).toHaveLength(1);
      expect(sessionEvents[0]).toEqual(expect.objectContaining({
        summary: "Shipped biography view",
        sessionId: "session-view"
      }));

    const host = document.createElement("div");
    const viewDisposable = biographyView.component.render(host);
    await vi.waitFor(() => expect(host.textContent).toContain("Shipped biography view"));
    expect(host.textContent).toContain("memory-panel");
    expect(host.textContent).toContain("agent-identity");
    const sessionSection = host.querySelector(".zion-biography-session");
    expect(sessionSection?.dataset.sessionId).toBe("session-view");
    const sessionHeader = sessionSection?.querySelector(".zion-biography-session-header");
    expect(sessionHeader?.textContent).toContain("会话");
    expect(sessionHeader?.textContent).toContain("session-view");
    expect(sessionSection?.querySelectorAll(".zion-biography-event")).toHaveLength(1);
    const eventRow = sessionSection?.querySelector(".zion-biography-event");
    expect(eventRow?.textContent).not.toContain("session-view");
    expect(eventRow?.textContent).not.toContain("run-view");
    expect(eventRow?.textContent).not.toContain("memory-panel");
    eventRow?.click();
    expect(inspectorItem).toEqual(expect.objectContaining({
      title: "Shipped biography view",
      displayPath: "Biography UI redesign"
    }));
    expect(inspectorItem.actions).toHaveLength(1);
    expect(inspectorItem.actions[0].title).toBe("复制摘要");
    const detailHost = document.createElement("div");
    inspectorItem.render(detailHost);
    expect(detailHost.querySelector("h1, h2")).toBeNull();
    expect(detailHost.querySelector(".zion-biography-detail-title")?.textContent).toBe("Shipped biography view");
    expect(detailHost.textContent).toContain("这条经历由会话自动提炼");
    expect(detailHost.textContent).toContain("Biography UI redesign");
    expect(detailHost.textContent).toContain("打开原会话");
    expect(detailHost.textContent).toContain("复制摘要");
    expect(detailHost.querySelector("details:not([open])")?.textContent).toContain("技术详情");

    const biographyTab = (label) => Array.from(host.querySelectorAll(".zion-biography-section-tab"))
      .find((button) => button.textContent === label);
    biographyTab("概览")?.click();
    expect(host.textContent).toContain("最近动态");
    biographyTab("工作项目")?.click();
    await vi.waitFor(() => expect(host.textContent).toContain("完成 M1"));
    const workingProject = host.querySelector(".zion-biography-working-project");
    expect(workingProject?.textContent).toContain("Zion Next");
    expect(workingProject?.textContent).toContain("active");
    expect(workingProject?.textContent).toContain("high");
    const automationToggle = workingProject?.querySelector('input[type="checkbox"]');
    expect(automationToggle?.checked).toBe(false);
    automationToggle.checked = true;
    automationToggle.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(JSON.parse(
        localStorage.getItem("plugin.dev.identity.global.projectAutomation.v1")
      ).projects["zion-next"].enabled).toBe(true);
    });
    expect(fileWrites.some((write) => write.path.endsWith("projects/.automation.json"))).toBe(false);
    const automationTool = stateValues.get("chat.toolHandlers")?.projectAutomationManage;
    expect(automationTool).toBeTypeOf("function");
    const resolvedByName = JSON.parse(await automationTool({
      action: "get",
      project_key: "Zion Next"
    }));
    expect(resolvedByName).toEqual(expect.objectContaining({
      projectKey: "zion-next",
      projectName: "Zion Next"
    }));
    const missingProject = JSON.parse(await automationTool({
      action: "get",
      project_key: "Zion Next Research"
    }));
    expect(missingProject).toEqual(expect.objectContaining({
      ok: false,
      code: "PROJECT_NOT_FOUND",
      availableProjects: [{ key: "zion-next", name: "Zion Next" }]
    }));
    const requestResult = JSON.parse(await automationTool({
      action: "request_update",
      project_key: "zion-next",
      mode: "execute",
      reason: "用户希望进入执行阶段"
    }));
    expect(requestResult.status).toBe("pending_user_approval");
    await vi.waitFor(() => {
      expect(host.querySelector('[aria-label="批准 Zion Next 自动化变更"]')).toBeTruthy();
    });
    host.querySelector('[aria-label="批准 Zion Next 自动化变更"]')?.click();
    expect(JSON.parse(
      localStorage.getItem("plugin.dev.identity.global.projectAutomation.v1")
    ).projects["zion-next"].mode).toBe("execute");
    let runAutomation;
    await vi.waitFor(() => {
      runAutomation = host.querySelector('[aria-label="立即推进 Zion Next"]');
      expect(runAutomation?.disabled).toBe(false);
    });
    runAutomation?.click();
    await vi.waitFor(() => expect(window.zion.agents.runTaskHeadless).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(host.textContent).toContain("上次运行成功"));
    expect(window.zion.agents.createTask).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "researcher",
      executionPolicy: expect.objectContaining({
        preset: "workspace-write",
        maxToolCalls: 24
      })
    }));
    const disabled = JSON.parse(await automationTool({
      action: "disable",
      project_key: "Zion Next"
    }));
    expect(disabled).toEqual(expect.objectContaining({
      status: "disabled",
      projectKey: "zion-next"
    }));
    expect(JSON.parse(
      localStorage.getItem("plugin.dev.identity.global.projectAutomation.v1")
    ).projects["zion-next"].enabled).toBe(false);
    const staleTaskId = "project-auto-zion-next-stale";
    window.zion.agents.getTask.mockReturnValue({
      id: staleTaskId,
      status: "running",
      error: ""
    });
    const staleAutomation = JSON.parse(
      localStorage.getItem("plugin.dev.identity.global.projectAutomation.v1")
    );
    staleAutomation.projects["zion-next"] = {
      ...staleAutomation.projects["zion-next"],
      enabled: false,
      activeTaskId: staleTaskId,
      lastStatus: "running",
      cadenceMinutes: 15
    };
    localStorage.setItem(
      "plugin.dev.identity.global.projectAutomation.v1",
      JSON.stringify(staleAutomation)
    );
    eventHandlers.get("scheduler/heartbeat")?.({});
    await vi.waitFor(() => {
      expect(window.zion.agents.updateTask).toHaveBeenCalledWith(
        staleTaskId,
        expect.objectContaining({
          status: "error",
          activeRunId: "",
          error: "自动推进因应用或插件重启中断"
        })
      );
    });
    expect(JSON.parse(
      localStorage.getItem("plugin.dev.identity.global.projectAutomation.v1")
    ).projects["zion-next"]).toEqual(expect.objectContaining({
      activeTaskId: "",
      lastStatus: "failed",
      lastError: "自动推进因应用或插件重启中断"
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    window.zion.agents.getTask.mockReturnValue(null);
    window.zion.agents.runTaskHeadless.mockResolvedValueOnce({
      ok: false,
      task: {
        id: "project-auto-zion-next-failed",
        status: "error",
        error: "provider unavailable"
      }
    });
    const failedAutomation = JSON.parse(
      localStorage.getItem("plugin.dev.identity.global.projectAutomation.v1")
    );
    failedAutomation.projects["zion-next"] = {
      ...failedAutomation.projects["zion-next"],
      enabled: true,
      activeTaskId: "",
      lastStatus: "idle"
    };
    localStorage.setItem(
      "plugin.dev.identity.global.projectAutomation.v1",
      JSON.stringify(failedAutomation)
    );
    eventHandlers.get("identity/projectAutomationRunRequested")?.({
      projectKey: "zion-next"
    });
    await vi.waitFor(() => {
      expect(window.zion.agents.runTaskHeadless).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(JSON.parse(
        localStorage.getItem("plugin.dev.identity.global.projectAutomation.v1")
      ).projects["zion-next"].lastError).toBe("provider unavailable");
    });
    const attentionWrite = fileWrites.findLast((write) => (
      write.path.endsWith("projects/attention.md")
    ));
    expect(attentionWrite?.content).toContain("provider unavailable");
    expect(attentionWrite?.content.match(
      /<!-- automation:zion-next:run-failed -->/g
    )).toHaveLength(1);
    workingProject?.click();
    await vi.waitFor(() => expect(inspectorItem?.title).toBe("Zion Next"));
    expect(inspectorItem.path).toBe("/Users/test/.zion-next/data/plugins/dev.identity/projects/zion-next/project.md");
    expect(inspectorItem.file?.content).toContain("M1 已完成");
    const documentActions = Array.from(host.querySelectorAll(".zion-biography-working-document-action"));
    documentActions.find((button) => button.textContent.includes("项目索引"))?.click();
    expect(inspectorItem?.title).toBe("项目索引");
    documentActions.find((button) => button.textContent.includes("杂思收集箱"))?.click();
    await vi.waitFor(() => expect(inspectorItem?.title).toBe("杂思收集箱"));
    expect(inspectorItem.file?.content).toContain("评估 M2");
    documentActions.find((button) => button.textContent.includes("待处理事项"))?.click();
    await vi.waitFor(() => expect(inspectorItem?.title).toBe("待处理事项"));
    expect(inspectorItem.file?.content).toContain("批准执行");
    biographyTab("经历项目")?.click();
    expect(host.textContent).toContain("memory-panel");
    biographyTab("摘要")?.click();
    await vi.waitFor(() => expect(host.textContent).toContain("Shipped biography digest"));
    biographyTab("档案")?.click();
    await vi.waitFor(() => expect(host.textContent).toContain("Zion"));
    biographyTab("动态")?.click();
    expect(host.querySelector(".zion-biography-search input")).toBeTruthy();

    const searchInput = host.querySelector(".zion-biography-search input");
    searchInput.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    searchInput.value = "不存在的中文事件";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(host.querySelector(".zion-biography-search input")).toBe(searchInput);
    expect(host.textContent).toContain("Shipped biography view");
    searchInput.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await vi.waitFor(() => expect(host.textContent).toContain("没有匹配的动态"));
    expect(host.querySelector(".zion-biography-search input")).toBe(searchInput);
    searchInput.value = "biography";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(host.textContent).toContain("Shipped biography view"));
    expect(host.querySelector(".zion-biography-search input")).toBe(searchInput);
    viewDisposable.dispose();
    disposable.dispose();
  });

  it("automatically initializes project memory files without overwriting existing profiles", async () => {
    const commands = new Map();
    const root = "/Users/test/.zion-next/data/plugins/dev.identity";
    const files = new Map([
      [`${root}/identity.md`, "# Identity\nExisting"],
      [`${root}/user.md`, "# User\nExisting"],
      [`${root}/biography/digest.md`, "# 自传摘要\nExisting"]
    ]);
    const writes = [];

    window.zion = {
      messages: {
        registerContributor: vi.fn(() => ({ dispose: vi.fn() }))
      },
      commands: {
        registerCommand: vi.fn((id, handler) => {
          commands.set(id, handler);
          return { dispose: vi.fn() };
        }),
        executeCommand: vi.fn(() => null)
      },
      events: {
        on: vi.fn(() => ({ dispose: vi.fn() })),
        emit: vi.fn()
      },
      auxiliaryBar: {
        registerView: vi.fn(() => ({ dispose: vi.fn() }))
      },
      activityBar: {
        registerItem: vi.fn(() => ({ dispose: vi.fn() }))
      },
      notification: {
        show: vi.fn()
      },
      state: {
        get: vi.fn((key) => {
          if (key === "localTools.baseUrl") return "http://127.0.0.1:9999";
          if (key === "terminal.sessions") {
            return [{ id: "term-1", type: "local", cwd: "/Users/test/project" }];
          }
          return null;
        }),
        set: vi.fn()
      }
    };
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if (options.method === "POST") {
        const body = JSON.parse(options.body);
        writes.push(body);
        files.set(body.path, body.content);
        return new globalThis.Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      const path = decodeURIComponent(new URL(url).searchParams.get("path"));
      if (!files.has(path)) {
        return new globalThis.Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new globalThis.Response(JSON.stringify({ content: files.get(path) }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));

    const disposable = await activate({ subscriptions: [] });
    const initialize = commands.get("identity.initialize");
    const expectedCreated = [
      `${root}/projects/index.md`,
      `${root}/projects/inbox.md`,
      `${root}/projects/attention.md`,
      `${root}/projects/_template.md`
    ];
    await disposable.ready;
    expect(writes.map((write) => write.path)).toEqual(expectedCreated);

    const first = await initialize();
    expect(first).toEqual({ ok: true, created: [] });
    expect(files.get(`${root}/projects/index.md`)).toContain("# 项目索引");
    expect(files.get(`${root}/projects/inbox.md`)).toContain("# 杂思收集箱");
    expect(files.get(`${root}/projects/attention.md`)).toContain("# 待处理事项");
    expect(files.get(`${root}/projects/_template.md`)).toContain("autonomy: none");

    const second = await initialize();
    expect(second).toEqual({ ok: true, created: [] });
    expect(writes).toHaveLength(4);

    files.set(`${root}/projects/inbox.md`, "");
    const third = await initialize();
    expect(third).toEqual({ ok: true, created: [] });
    expect(writes).toHaveLength(4);
    expect(files.get(`${root}/identity.md`)).toBe("# Identity\nExisting");
    expect(files.get(`${root}/user.md`)).toBe("# User\nExisting");
    disposable.dispose();
  });

    it("persists a stable identity snapshot on the session until manually refreshed", async () => {
      let contributor;
      const commands = new Map();
      const metaStore = new Map();
      let digest = "# 自传摘要\n\n- Digest A";
      let fileReads = 0;

      window.zion = {
        messages: {
          registerContributor(value) {
            contributor = value;
            return { dispose: vi.fn() };
          }
        },
        commands: {
          registerCommand: vi.fn((id, handler) => {
            commands.set(id, handler);
            return { dispose: vi.fn() };
          }),
          executeCommand: vi.fn((id, arg) => {
            if (id === "zion.sessions.getMetaAsync" || id === "zion.sessions.getMeta") {
              return metaStore.get(arg) || { id: arg, title: "Cached Session" };
            }
            if (id === "zion.sessions.patchMeta") {
              const current = metaStore.get(arg.id) || { id: arg.id, title: "Cached Session" };
              const next = typeof arg.updater === "function"
                ? arg.updater(current)
                : { ...current, ...(arg.patch || {}) };
              metaStore.set(arg.id, next);
              return next;
            }
            return null;
          })
        },
        events: {
          on: vi.fn(() => ({ dispose: vi.fn() }))
        },
        auxiliaryBar: {
          registerView: vi.fn(() => ({ dispose: vi.fn() }))
        },
        activityBar: {
          registerItem: vi.fn(() => ({ dispose: vi.fn() }))
        },
        notification: {
          show: vi.fn()
        },
        state: {
          get: vi.fn((key) => {
            if (key === "localTools.baseUrl") return "http://127.0.0.1:9999";
            if (key === "terminal.sessions") return [{ id: "term-1", type: "local", cwd: "/Users/test/project" }];
            if (key === "sessions.currentId") return "session-cache";
            return null;
          }),
          set: vi.fn()
        }
      };
      vi.stubGlobal("fetch", vi.fn(async (url) => {
        fileReads += 1;
        const path = decodeURIComponent(new URL(url).searchParams.get("path"));
        const content = path.endsWith("identity.md")
          ? "# Identity\nZion"
          : path.endsWith("user.md")
            ? "# User\nChinese"
            : digest;
        return new globalThis.Response(JSON.stringify({ content }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }));

      metaStore.set("session-cache", {
        id: "session-cache",
        title: "Cached Session",
        identitySnapshot: {
          version: 1,
          content: "<identity_context>legacy snapshot</identity_context>"
        }
      });
      const disposable = await activate({ subscriptions: [] });
      const first = await contributor.contribute([{ role: "user", content: "hello" }], { sessionId: "session-cache" });
      expect(first[0].content).toContain("Digest A");
      expect(first[0].content).not.toContain("legacy snapshot");
      expect(metaStore.get("session-cache").identitySnapshot.version).toBe(3);
      expect(metaStore.get("session-cache").identitySnapshot.content).toContain("Digest A");
      const readsAfterFirst = fileReads;
      expect(readsAfterFirst).toBeGreaterThanOrEqual(3);

      digest = "# 自传摘要\n\n- Digest B";
      const second = await contributor.contribute([{ role: "user", content: "again" }], { sessionId: "session-cache" });
      expect(second[0].content).toContain("Digest A");
      expect(second[0].content).not.toContain("Digest B");
      expect(fileReads).toBe(readsAfterFirst);

      disposable.dispose();
      const restoredActivation = await activate({ subscriptions: [] });
      const restored = await contributor.contribute([{ role: "user", content: "after reload" }], { sessionId: "session-cache" });
      expect(restored[0].content).toContain("Digest A");
      expect(restored[0].content).not.toContain("Digest B");
      expect(fileReads).toBeLessThanOrEqual(readsAfterFirst + 8);

      const refreshed = await commands.get("identity.refreshContext")({ sessionId: "session-cache" });
      expect(refreshed).toEqual(expect.objectContaining({ ok: true, sessionId: "session-cache" }));
      expect(metaStore.get("session-cache").identitySnapshot.content).toContain("Digest B");

      const afterRefresh = await contributor.contribute([{ role: "user", content: "after refresh" }], { sessionId: "session-cache" });
      expect(afterRefresh[0].content).toContain("Digest B");
      restoredActivation.dispose();
    });

  it("appends a finished run and rebuilds digest.md", async () => {
    let onRunFinished;
    const writes = [];
    const extraEvents = Array.from({ length: 13 }, (_, index) => ({
      id: `global-session-${index + 1}:run-1:0`,
      at: `2026-08-12T${String(index).padStart(2, "0")}:00:00.000Z`,
      kind: "outcome",
      summary: `记录全局尾部标签 ${index + 1}`,
      confirmed: false,
      project: `project-${index + 1}`,
      topics: [`topic-${index + 1}`],
      sessionId: `global-session-${index + 1}`,
      runId: "run-1"
    }));
    const storedEvents = [{
      id: "session-1:run-0:0",
      at: "2026-08-13T10:00:00.000Z",
      kind: "decision",
      summary: "确定使用 biography 事件记录",
      confirmed: true,
      project: "memory-panel",
      topics: ["agent-identity", "storage"],
      sessionId: "session-1",
      runId: "run-0"
    }, {
      id: "other-session:run-1:0",
      at: "2026-08-12T10:00:00.000Z",
      kind: "lesson",
      summary: "记录全局可观测性经验",
      confirmed: false,
      project: "zion",
      topics: ["observability"],
      sessionId: "other-session",
      runId: "run-1"
    }, ...extraEvents];
    let distillationMessages = [];
    const stateValues = new Map();
    window.zion = {
      messages: {
        registerContributor: vi.fn(() => ({ dispose: vi.fn() }))
      },
      commands: {
        registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
        executeCommand: vi.fn((id) => {
          if (id === "zion.sessions.getDocAsync") {
              return "user #project/memory-panel 实现身份系统\nassistant 已完成身份注入和自动自传记录。";
          }
            if (id === "zion.sessions.getMeta") return { title: "Memory Panel 身份升级" };
          return true;
        })
      },
      events: {
        on: vi.fn((topic, handler) => {
          if (topic === "chat/runFinished") onRunFinished = handler;
          return { dispose: vi.fn() };
        }),
        emit: vi.fn()
      },
      panels: { getEditorBySession: vi.fn(() => null) },
      state: {
        get: vi.fn((key) => {
          if (key === "localTools.baseUrl") return "http://127.0.0.1:9999";
          if (key === "terminal.sessions") return [{ id: "term-1", type: "local", cwd: "/Users/test/project" }];
          return stateValues.get(key) ?? null;
        }),
        set: vi.fn((key, value) => stateValues.set(key, value))
      },
      llm: {
        runStream: vi.fn(async ({ messages, onToken, onEnd }) => {
          distillationMessages = messages;
          onToken('{"events":[{"kind":"outcome","summary":"完成身份注入和自动自传记录","project":"","topics":["agent-identity"],"confirmed":false}]}');
          onEnd();
        })
      }
    };
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if (options.method === "POST") {
        const body = JSON.parse(options.body);
        writes.push({ url: String(url), body });
        const result = String(url).includes("/files/append-jsonl")
          ? {
            ok: true,
            appended: body.records.map((record) => record.id),
            skipped: []
          }
          : { ok: true };
        if (Array.isArray(body.records)) storedEvents.push(...body.records);
        return new globalThis.Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      const path = decodeURIComponent(new URL(url).searchParams.get("path"));
      if (path.endsWith("events.jsonl")) {
        return new globalThis.Response(JSON.stringify({
          content: storedEvents.map((event) => JSON.stringify(event)).join("\n")
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new globalThis.Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }));

    const disposable = await activate({ subscriptions: [] });
    await disposable.ready;
    writes.length = 0;
    onRunFinished({ sessionId: "session-1", runId: "run-1", panelId: "panel-1" });

    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0].url).toContain("/files/append-jsonl");
    expect(writes[0].body.path).toBe("/Users/test/.zion-next/data/plugins/dev.identity/biography/events.jsonl");
    expect(writes[0].body.records[0]).toEqual(expect.objectContaining({
      id: "session-1:run-1:0",
        summary: "完成身份注入和自动自传记录",
        project: "memory-panel",
        topics: ["agent-identity"]
    }));
      expect(distillationMessages[1].content).toContain("Memory Panel 身份升级");
      expect(distillationMessages[1].content).toContain("project/memory-panel");
      expect(distillationMessages[1].content).toContain("<global_biography_index>");
      expect(distillationMessages[1].content).toContain("memory-panel（1 条）");
      expect(distillationMessages[1].content).toContain("zion（1 条）");
      expect(distillationMessages[1].content).toContain("project-13（1 条）");
      expect(distillationMessages[1].content).toContain("topic-13（1 条）");
      expect(distillationMessages[1].content).not.toContain("还有 5 个项目未展示");
      expect(distillationMessages[1].content).not.toContain("还有 1 个主题未展示");
      expect(distillationMessages[1].content).toContain("<session_history>");
      expect(distillationMessages[1].content).toContain("确定使用 biography 事件记录");
      expect(distillationMessages[1].content).toContain("已有主题标签：agent-identity, storage");
    expect(writes[1].url).toContain("/files/write");
    expect(writes[1].body.path).toBe("/Users/test/.zion-next/data/plugins/dev.identity/biography/digest.md");
      expect(writes[1].body.content).toContain("[project/memory-panel]");
    expect(writes[1].body.content).toContain("完成身份注入和自动自传记录");
    await vi.waitFor(() => {
      expect(stateValues.get("sessions.derivedTags")?.biography?.sessions?.["session-1"])
        .toBeTruthy();
    });
    expect(stateValues.get("sessions.derivedTags").biography.sessions["session-1"]).toEqual(
      expect.arrayContaining([
        { path: "project/memory-panel", kind: "project" },
        { path: "topic/agent-identity", kind: "topic" }
      ])
    );
    disposable.dispose();
  });

  it("restores newer Runtime project automation into the Workbench projection", async () => {
    const stateValues = new Map([
      ["runtime.mode", "runtime"],
      ["runtime.baseUrl", "http://runtime.test"],
      ["runtime.connection", {
        backend: "runtime",
        baseUrl: "http://runtime.test",
        projectAutomationWorker: true
      }]
    ]);
    const eventHandlers = new Map();
    const runtimeControlCalls = [];
    const globalValues = new Map([
      ["projectAutomation.v1", {
        version: 1,
        projects: {
          "zion-next": {
            enabled: false,
            mode: "explore",
            updatedAt: 1000
          }
        },
        requests: []
      }]
    ]);
    const runtimeDocument = {
      version: 1,
      projects: {
        "zion-next": {
          enabled: false,
          mode: "execute",
          cadenceMinutes: 30,
          updatedAt: 2000
        }
      },
      requests: []
    };
    window.zion = {
      messages: {
        registerContributor: vi.fn(() => ({ dispose: vi.fn() }))
      },
      commands: {
        registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
        executeCommand: vi.fn(() => null)
      },
      events: {
        on: vi.fn((topic, handler) => {
          eventHandlers.set(topic, handler);
          return { dispose: vi.fn(() => eventHandlers.delete(topic)) };
        }),
        emit: vi.fn((topic, payload) => eventHandlers.get(topic)?.(payload))
      },
      auxiliaryBar: {
        registerView: vi.fn(() => ({ dispose: vi.fn() }))
      },
      activityBar: {
        registerItem: vi.fn(() => ({ dispose: vi.fn() }))
      },
      state: {
        get: vi.fn((key) => {
          if (key === "localTools.baseUrl") return "http://127.0.0.1:9999";
          if (key === "terminal.sessions") {
            return [{ id: "term-1", type: "local", cwd: "/Users/test/project" }];
          }
          return stateValues.get(key) ?? null;
        }),
        set: vi.fn((key, value) => stateValues.set(key, value)),
        onDidChange: vi.fn(() => ({ dispose: vi.fn() }))
      }
    };
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const requestUrl = new URL(url);
      if (requestUrl.host === "runtime.test") {
        if (requestUrl.pathname.endsWith("/project-automation/projects/zion-next/run")) {
          runtimeControlCalls.push({
            path: requestUrl.pathname,
            body: JSON.parse(options.body || "{}")
          });
          return new globalThis.Response(JSON.stringify({
            status: "running",
            projectKey: "zion-next",
            runId: "runtime-project-run-1"
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        const key = decodeURIComponent(requestUrl.pathname.split("/").at(-1));
        if (options.method === "PUT") {
          return new globalThis.Response(JSON.stringify({ ok: true, revision: "runtime:3" }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (key.endsWith(".projectAutomation.v1")) {
          return new globalThis.Response(JSON.stringify({ value: runtimeDocument }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new globalThis.Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (options.method === "POST") {
        return new globalThis.Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (requestUrl.pathname.endsWith("/files/entries")) {
        return new globalThis.Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new globalThis.Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }));

    const disposable = await activate({
      subscriptions: [],
      globalState: {
        get: vi.fn((key, fallback) => globalValues.get(key) ?? fallback),
        update: vi.fn(async (key, value) => {
          globalValues.set(key, value);
        })
      }
    });

    await disposable.ready;
    expect(globalValues.get("projectAutomation.v1").projects["zion-next"]).toMatchObject({
      enabled: false,
      mode: "execute",
      cadenceMinutes: 30,
      updatedAt: 2000
    });
    expect(stateValues.get("runtime.projectAutomationSync")).toMatchObject({
      status: "loaded",
      revision: 2000
    });
    eventHandlers.get("identity/projectAutomationRunRequested")?.({
      projectKey: "zion-next"
    });
    await vi.waitFor(() => expect(runtimeControlCalls).toEqual([
      {
        path: "/v1/project-automation/projects/zion-next/run",
        body: { interaction_profile_id: "interactive.default" }
      }
    ]));
    disposable.dispose();
  });

  it("skips Workbench biography fallback for Runtime-owned runs", async () => {
    let onRunFinished;
    const writes = [];
    const runStream = vi.fn();
    const stateValues = new Map();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    window.zion = {
      messages: {
        registerContributor: vi.fn(() => ({ dispose: vi.fn() }))
      },
      commands: {
        registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
        executeCommand: vi.fn((id) => {
          if (id === "zion.sessions.getDocAsync") {
            return "user 继续推进 Runtime\nassistant 已完成 Runtime post processor。";
          }
          return true;
        })
      },
      events: {
        on: vi.fn((topic, handler) => {
          if (topic === "chat/runFinished") onRunFinished = handler;
          return { dispose: vi.fn() };
        }),
        emit: vi.fn()
      },
      panels: { getEditorBySession: vi.fn(() => null) },
      state: {
        get: vi.fn((key) => {
          if (key === "localTools.baseUrl") return "http://127.0.0.1:9999";
          if (key === "terminal.sessions") return [{ id: "term-1", type: "local", cwd: "/Users/test/project" }];
          return stateValues.get(key) ?? null;
        }),
        set: vi.fn((key, value) => stateValues.set(key, value))
      },
      llm: {
        runStream
      }
    };
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if (options.method === "POST") {
        writes.push({ url: String(url), body: JSON.parse(options.body || "{}") });
        return new globalThis.Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      const requestUrl = new URL(url);
      if (requestUrl.pathname.endsWith("/files/entries")) {
        return new globalThis.Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      const path = decodeURIComponent(requestUrl.searchParams.get("path") || "");
      const content = path.endsWith("events.jsonl")
        ? ""
        : path.endsWith("digest.md")
          ? "# 自传摘要\n"
          : "# Existing\n";
      return new globalThis.Response(JSON.stringify({ content }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));

    const disposable = await activate({ subscriptions: [] });
    writes.length = 0;
    onRunFinished({
      sessionId: "session-1",
      runId: "runtime-run-1",
      panelId: "panel-1",
      requestSource: "interactive",
      backend: "runtime"
    });
    await Promise.resolve();

    expect(runStream).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      "[dev.identity] biography skipped: handled by Runtime post-processor",
      expect.objectContaining({
        sessionId: "session-1",
        runId: "runtime-run-1"
      })
    );
    disposable.dispose();
    info.mockRestore();
  });
});
