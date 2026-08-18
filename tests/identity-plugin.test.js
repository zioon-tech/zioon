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
import { activate } from "../extensions/dev.identity/main.js";

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
      projectsInbox: "# 杂思收集箱\n- 评估 M2"
    });

    expect(text).toContain("<agent_identity");
    expect(text).toContain("<user_profile");
    expect(text).toContain("<biography");
    expect(text).toContain("<projects_index");
    expect(text).toContain("<projects_inbox");
    expect(text).toContain("Zion Next");
    expect(text).toContain("评估 M2");
    expect(text).toContain("&lt;trusted&gt;");
    expect(text).toContain("A &amp; B");
    expect(text).not.toContain("Name: Zion <trusted>");
    expect(text).toContain("~/.zion-next/memory/biography/events.jsonl");
    expect(text).toContain("user-owned read-only data");
    expect(text).toContain("model-maintained working memory");
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
        on: vi.fn(() => ({ dispose: vi.fn() }))
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
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const requestUrl = new URL(url);
      if (requestUrl.pathname.endsWith("/files/entries")) {
        return new globalThis.Response(JSON.stringify({
          path: "/Users/test/.zion-next/memory/projects",
          results: [
            {
              path: "/Users/test/.zion-next/memory/projects/zion-next",
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
          : path.endsWith("zion-next/project.md")
            ? "# Zion Next\n\n## 当前状态\n\nM1 已完成"
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
    workingProject?.click();
    await vi.waitFor(() => expect(inspectorItem?.title).toBe("Zion Next"));
    expect(inspectorItem.path).toBe("/Users/test/.zion-next/memory/projects/zion-next/project.md");
    expect(inspectorItem.file?.content).toContain("M1 已完成");
    const documentActions = Array.from(host.querySelectorAll(".zion-biography-working-document-action"));
    documentActions.find((button) => button.textContent.includes("项目索引"))?.click();
    expect(inspectorItem?.title).toBe("项目索引");
    documentActions.find((button) => button.textContent.includes("杂思收集箱"))?.click();
    await vi.waitFor(() => expect(inspectorItem?.title).toBe("杂思收集箱"));
    expect(inspectorItem.file?.content).toContain("评估 M2");
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
    const root = "/Users/test/.zion-next/memory";
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
      `${root}/projects/_template.md`
    ];
    expect(writes.map((write) => write.path)).toEqual(expectedCreated);

    const first = await initialize();
    expect(first).toEqual({ ok: true, created: [] });
    expect(files.get(`${root}/projects/index.md`)).toContain("# 项目索引");
    expect(files.get(`${root}/projects/inbox.md`)).toContain("# 杂思收集箱");
    expect(files.get(`${root}/projects/_template.md`)).toContain("autonomy: none");

    const second = await initialize();
    expect(second).toEqual({ ok: true, created: [] });
    expect(writes).toHaveLength(3);

    files.set(`${root}/projects/inbox.md`, "");
    const third = await initialize();
    expect(third).toEqual({ ok: true, created: [] });
    expect(writes).toHaveLength(3);
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
      expect(metaStore.get("session-cache").identitySnapshot.version).toBe(2);
      expect(metaStore.get("session-cache").identitySnapshot.content).toContain("Digest A");
      const readsAfterFirst = fileReads;
      expect(readsAfterFirst).toBeGreaterThanOrEqual(3);

      digest = "# 自传摘要\n\n- Digest B";
      const second = await contributor.contribute([{ role: "user", content: "again" }], { sessionId: "session-cache" });
      expect(second[0].content).toContain("Digest A");
      expect(second[0].content).not.toContain("Digest B");
      expect(fileReads).toBe(readsAfterFirst);

      disposable.dispose();
      await activate({ subscriptions: [] });
      const restored = await contributor.contribute([{ role: "user", content: "after reload" }], { sessionId: "session-cache" });
      expect(restored[0].content).toContain("Digest A");
      expect(restored[0].content).not.toContain("Digest B");
      expect(fileReads).toBeLessThanOrEqual(readsAfterFirst + 6);

      const refreshed = await commands.get("identity.refreshContext")({ sessionId: "session-cache" });
      expect(refreshed).toEqual(expect.objectContaining({ ok: true, sessionId: "session-cache" }));
      expect(metaStore.get("session-cache").identitySnapshot.content).toContain("Digest B");

      const afterRefresh = await contributor.contribute([{ role: "user", content: "after refresh" }], { sessionId: "session-cache" });
      expect(afterRefresh[0].content).toContain("Digest B");
    });

  it("appends a finished run and rebuilds digest.md", async () => {
    let onRunFinished;
    const writes = [];
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
    }];
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
    writes.length = 0;
    onRunFinished({ sessionId: "session-1", runId: "run-1", panelId: "panel-1" });

    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0].url).toContain("/files/append-jsonl");
    expect(writes[0].body.path).toBe("/Users/test/.zion-next/memory/biography/events.jsonl");
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
      expect(distillationMessages[1].content).toContain("<session_history>");
      expect(distillationMessages[1].content).toContain("确定使用 biography 事件记录");
      expect(distillationMessages[1].content).toContain("已有主题标签：agent-identity, storage");
    expect(writes[1].url).toContain("/files/write");
    expect(writes[1].body.path).toBe("/Users/test/.zion-next/memory/biography/digest.md");
      expect(writes[1].body.content).toContain("[project/memory-panel]");
    expect(writes[1].body.content).toContain("完成身份注入和自动自传记录");
    expect(stateValues.get("sessions.derivedTags").biography.sessions["session-1"]).toEqual(
      expect.arrayContaining([
        { path: "project/memory-panel", kind: "project" },
        { path: "topic/agent-identity", kind: "topic" }
      ])
    );
    disposable.dispose();
  });
});
