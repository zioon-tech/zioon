const object = properties => ({ type: "object", properties, additionalProperties: false });
const nodeIds = ["node_demo_mac", "node_demo_linux", "node_demo_windows", "node_demo_mobile"];
const defs = [
  ["file.list", "列举授权目录中的文件。", "read", { ...object({ rootId: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, maxEntries: { type: "integer", default: 600, minimum: 1, maximum: 10000 } }), required: ["rootId", "path"] }],
  ["file.read", "读取授权目录中的文本文件。", "read", { ...object({ rootId: { type: "string" }, path: { type: "string" }, maxBytes: { type: "integer", default: 65536, minimum: 1, maximum: 1048576 } }), required: ["rootId", "path"] }],
  ["file.search", "在授权目录中搜索文件内容。", "read", { ...object({ rootId: { type: "string" }, path: { type: "string", default: "." }, query: { type: "string", minLength: 1 } }), required: ["rootId", "query"] }],
  ["file.write", "向设备的授权目录写入文件。", "write", { ...object({ rootId: { type: "string" }, path: { type: "string" }, content: { type: "string" }, createParents: { type: "boolean", default: false } }), required: ["rootId", "path", "content"] }],
  ["shell.exec", "在目标设备运行命令，执行范围由设备权限约束。", "execute", { ...object({ rootId: { type: "string" }, cwd: { type: "string", default: "" }, command: { type: "string", minLength: 1 }, timeoutMs: { type: "integer", default: 30000, minimum: 100, maximum: 600000 } }), required: ["rootId", "command"] }],
  ["command.template.list", "查看设备提供的已授权命令模板。", "read", object({})]
];
const root = { rootId: "root_demo", path: "/workspace", label: "Workspace", writable: true };
export function createFixtureAdapter() {
  let tasks = [
    { invocationId: "inv_demo_approval", jobId: "job_demo_approval", nodeId: nodeIds[1], tool: "shell.exec",
      status: "approval_required", createdAt: new Date(Date.now() - 360000).toISOString(),
      arguments: { command: "npm run build" }, error: { code: "approval_required", message: "模拟状态：当前授权要求执行前审批。" } },
    { invocationId: "inv_demo_unknown", nodeId: nodeIds[0], tool: "file.write", status: "unknown_outcome",
      createdAt: new Date(Date.now() - 900000).toISOString(), arguments: { path: "notes.md" },
      error: { code: "execution_outcome_unknown", message: "模拟状态：结果投递中断，需要查询原 invocation。" } }
  ];
  const tools = defs.map(([name, description, risk, args]) => ({ name, description,
    inputSchema: { ...object({ args, target: { ...object({ nodeId: { type: "string", enum: nodeIds.slice(0, 3) } }), required: ["nodeId"] } }), required: ["args", "target"] },
    annotations: { readOnlyHint: risk === "read" } }));
  const devices = [["开发 Mac", "darwin", true], ["构建 Linux", "linux", true], ["Windows 工作机", "win32", false], ["测试 Android", "android", false]]
    .map(([label, platform, online], i) => ({ nodeId: nodeIds[i], label, platform, online, roots: i === 3 ? [] : [root],
      lastSeenAt: new Date(Date.now() - (online ? 6000 : 86400000)).toISOString(),
      capability: { nodeVersion: "0.1.4", tools: i === 3 ? [] : defs.map(([name, , risk]) => ({ name, risk })), advertisedAt: new Date().toISOString() } }));
  function receipt(task) {
    return { receiptId: `rcpt_demo_${tasks.length}`, invocationId: task.invocationId, nodeId: task.nodeId,
      terminalStatus: task.status, sideEffect: task.tool === "shell.exec" || task.tool === "file.write",
      replayed: false, durationMs: 43, completedAt: new Date().toISOString(), simulated: true };
  }
  return {
    mode: "fixture", readOnly: false,
    async status() { return { connected: true, access: "交互演示", devices, tools, tasks,
      origin: "https://adc.zioon.tech", refreshedAt: new Date().toISOString(), links: {
        devices: "https://adc.zioon.tech/devices", access: "https://adc.zioon.tech/access", approvals: "https://adc.zioon.tech/approvals" } }; },
    async invoke(input) {
      let output;
      if (input.tool === "file.list") {
        output = { entries: !input.args.path || input.args.path === "." ? ["src/", "src/main.ts", "src/config.ts", "docs/", "docs/README.md", "package.json", "README.md"]
          : input.args.path.includes("src") ? ["main.ts", "config.ts"] : ["README.md"], truncated: false };
      } else if (input.tool === "file.read") output = { content: input.args.path.endsWith("json")
        ? '{\n  "name": "adc-studio-demo",\n  "private": true,\n  "scripts": { "build": "tsc" }\n}'
        : "# ADC Studio 演示\n\n设备、文件、工具与回执集中在一个工作台。\n\n此内容为模拟数据，未操作真实设备。\n", bytes: 128, truncated: false };
      else if (input.tool === "file.search") output = { matches: [{ path: "README.md", line: 3, text: `模拟搜索结果：${input.args.query}` }], truncated: false };
      else if (input.tool === "command.template.list") output = { templates: [{ name: "Build", command: "npm run build" }] };
      else output = { simulated: true, message: "交互演示已完成。此操作没有发送到 ADC。", arguments: input.args };
      const task = { ...input, invocationId: `inv_demo_${crypto.randomUUID()}`, status: "succeeded", output,
        arguments: input.args, simulated: true, createdAt: new Date().toISOString() };
      task.receipt = receipt(task); tasks = [task, ...tasks]; return task;
    },
    async task(input) {
      const task = tasks.find(t => t.invocationId === input.invocationId);
      if (!task) throw new Error("模拟任务不存在。");
      return task;
    },
    async cancel(input) {
      const task = tasks.find(t => t.invocationId === input.invocationId);
      if (!task) throw new Error("模拟任务不存在。");
      task.status = "cancelled"; task.error = { code: "cancelled", message: "模拟任务已取消。" }; return task;
    }
  };
}
