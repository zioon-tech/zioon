import { createServer } from "node:http";
import { readFile, realpath, appendFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { DeviceConnector, exchangeDevicePairing } from "../../apps/device-connector/src/device-connector.mjs";

// Deliberately deterministic. Exercises the real transport/executor, never
// represents the quality or latency of a production model.
export async function startPreviewModel({ port, receiptPath }) {
  const server = createServer(async (request, response) => {
    if (request.url === "/health") { response.end('{"ok":true,"fixture":true}'); return; }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      const messages = input.messages || [];
      const latest = [...messages].reverse().find(m => m.role === "user");
      const prompt = typeof latest?.content === "string" ? latest.content : JSON.stringify(latest?.content || "");
      const toolResult = [...messages].reverse().find(m => m.role === "tool");
      const advertised = messages.find(m => typeof m.content === "string"
        && m.content.includes("Available explicitly shared capabilities:"));
      const capability = advertised?.content.match(/"id":"([^"]+)","kind":"device"/)?.[1];
      let tool;
      if (!toolResult && /读取共享文件/.test(prompt) && capability) {
        tool = { name: "spaceCapabilityCall", arguments: { bindingId: capability, tool: "read",
          arguments: { path: "/shared/欢迎.txt" } } };
      } else if (!toolResult && /读取文档记忆/.test(prompt)) {
        tool = { name: "mcp__agentfs__cat", arguments: { path: "/memory/dev.identity/user.md" } };
      }
      await appendFile(receiptPath, JSON.stringify({
        at: Date.now(), model: input.model, prompt,
        tool: tool?.name || null, sharedContext: Boolean(advertised)
      }) + "\n", { mode: 0o600 });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      const send = delta => response.write(`data: ${JSON.stringify({
        id: `local-${randomUUID()}`, object: "chat.completion.chunk", model: input.model,
        choices: [{ index: 0, delta, finish_reason: null }]
      })}\n\n`);
      if (tool) {
        send({ role: "assistant", tool_calls: [{ index: 0, id: `call_${randomUUID()}`,
          type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] });
      } else {
        const text = toolResult
          ? `**本地测试模型**\n\n已通过授权工具读取：\n\n${toolResult.content}`
          : `**本地测试模型**\n\n收到：${prompt}\n\n| 验证项 | 结果 |\n| --- | --- |\n| 模型使用 | 请求已按授权路由 |\n| 内容边界 | 仅使用本次提交内容 |\n\n此回复用于验证分享链路。`;
        for (const delta of text.match(/.{1,24}|\n/g) || []) {
          if (response.destroyed) break;
          send({ content: delta });
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {},
        finish_reason: tool ? "tool_calls" : "stop" }], usage: {
        prompt_tokens: 30, completion_tokens: 20, total_tokens: 50
      } })}\n\ndata: [DONE]\n\n`);
      response.end();
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end('{"error":{"message":"local fixture request failed"}}');
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return { close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

export async function startPreviewDevice({ runtimeUrl, credential, pairing, root, receiptPath }) {
  const nodeId = "node:spaces-preview";
  if (!credential) credential = (await exchangeDevicePairing({
    runtimeUrl, ...pairing, device: { deviceId: nodeId, label: "本地共享测试目录", platform: "fixture" }
  })).credential;
  const dedicatedRoot = await realpath(root);
  const connector = new DeviceConnector({
    runtimeUrl, token: credential,
    registration: { protocolVersion: 1, nodeId, instanceId: `preview:${randomUUID()}`,
      label: "本地共享测试目录", platform: "fixture",
      capabilities: [{ name: "read", version: "1", risk: "read", hostKind: "local-tools",
        description: "Read only the dedicated local preview folder",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
      resources: [{ resourceId: "workspace:spaces-preview", kind: "workspace", projectId: "project:spaces-preview" }] },
    toolHost: { async invoke(invocation) {
      const requested = String(invocation.toolCall.arguments.path || "");
      const path = await realpath(resolve(requested));
      const inside = relative(dedicatedRoot, path);
      const granted = invocation.policy?.fileRoots?.includes(dedicatedRoot);
      if (!granted || inside.startsWith("..") || isAbsolute(inside)) {
        return { ok: false, content: "outside_shared_folder", error: "outside_shared_folder" };
      }
      const content = await readFile(path, "utf8");
      await appendFile(receiptPath, JSON.stringify({ at: Date.now(), invocationId: invocation.invocationId,
        tool: invocation.toolCall.name, path: join("/shared", inside) }) + "\n", { mode: 0o600 });
      return { ok: true, content };
    } },
    pollWaitMs: 1000, logger: message => { if (message.includes("error")) console.error("[preview-device]", message); }
  });
  await connector.start();
  return { credential, nodeId, close: () => connector.stop() };
}
