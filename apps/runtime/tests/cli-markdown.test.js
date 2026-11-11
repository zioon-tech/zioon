import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { renderTerminalMarkdown } from "../src/cli-markdown.mjs";
import { createAnswerRenderer, terminalTheme, safeText, cellWidth } from "../src/cli-terminal.mjs";

const sample = `结论先行：**现在这 28 个 profile 的推理确实全在远端**，可以加本地模型。

**先澄清一个关键点**

这个会话的 Runtime 跑在 **云端 worker** 上，\`127.0.0.1\` 指的是云端 worker 自己的 loopback。

- ModelHub 那组 (\`127.0.0.1:8771\`) 通过 SSH 反向隧道访问。
- 本地模型需要把本地服务端口映射过去。

### 三条落地路径

| 路径 | 做法 | 适合 | 代价 |
|---|---|---|---|
| A. Mac 本地 | Mac 跑 Ollama/LM Studio (11434/1234)，加一条 SSH 反向隧道 \`-R 8772:127.0.0.1:11434\` | 轻量模型 | 依赖 Mac 在线与隧道健康 |
| B. 服务器 | 在局域网服务器运行模型 | 长任务 | 维护服务 |

\`\`\`js
const text = "**这里保留原样**";
\`\`\`

[文档](https://example.com/docs)
`;

function terminal(width = 80) {
  const output = new PassThrough(); output.isTTY = true; output.columns = width; output.rows = 24;
  let data = ""; output.on("data", (chunk) => { data += chunk; });
  return { output, data: () => data };
}

describe("terminal Markdown", () => {
  it("renders the reported Chinese answer with real strong/code/list/table semantics", () => {
    const rows = renderTerminalMarkdown(sample, { width: 90, color: true });
    const text = rows.map(safeText).join("\n");
    expect(rows.join("\n")).toContain("\x1b[1m现在这 28 个 profile");
    expect(text).not.toContain("**云端 worker**");
    expect(text).not.toContain("`127.0.0.1`");
    expect(text).toContain("• ModelHub");
    expect(text).toContain("┌");
    expect(text).toContain("├");
    expect(text).not.toContain("|---|");
    expect(text).toContain('const text = "**这里保留原样**";');
    expect(text).toContain("文档 (https://example.com/docs)");
    expect(rows.every((row) => cellWidth(row) <= 90)).toBe(true);
  });
  it("wraps CJK and Emoji cells with aligned terminal borders", () => {
    const rows = renderTerminalMarkdown("| 名称 | 描述 |\n|:---|---:|\n| 中文🙂 | 这里有一段很长的中文内容👩‍💻必须自动换行 |\n", { width: 34 });
    const table = rows.filter((row) => safeText(row).startsWith("│"));
    expect(new Set(table.map(cellWidth)).size).toBe(1);
    expect(rows.every((row) => cellWidth(row) <= 34)).toBe(true);
  });
  it("uses labelled records on narrow screens without dropping long cells", () => {
    const text = renderTerminalMarkdown("|路径|做法|代价|\n|---|---|---|\n|本地|运行模型|在线|\n", { width: 20, color: false }).join("\n");
    expect(text).toContain("路径: 本地"); expect(text).toContain("做法: 运行模型");
    expect(text).not.toContain("|"); expect(text).not.toContain("\x1b");
  });
  it("renders nested emphasis, quotes, ordered and task lists", () => {
    const text = renderTerminalMarkdown("> **引用**\n\n1. *强调*\n2. ~~删除~~\n\n- [x] 完成\n- [ ] 待办\n", { color: false }).join("\n");
    expect(text).toContain("│ 引用"); expect(text).toContain("1. 强调");
    expect(text).toContain("2. 删除"); expect(text).toContain("☑ 完成"); expect(text).toContain("☐ 待办");
  });
  it("keeps escaped literals and code contents while suppressing control injection", () => {
    const text = renderTerminalMarkdown("\\*literal\\* &amp; &#27;[2J\n\n~~~sh\nprintf '**code**'\n~~~", { color: false }).join("\n");
    expect(text).toContain("*literal* &"); expect(text).toContain("printf '**code**'");
    expect(text).not.toContain("\x1b");
  });
  it("shows partial output and handles delimiters split across stream chunks", () => {
    const t = terminal();
    const renderer = createAnswerRenderer(t.output, terminalTheme(t.output, {}));
    for (const text of ["**云", "端** 与 ", "`127", ".0.0.1`"]) { renderer.write(text); renderer.flush(); }
    expect(safeText(t.data())).toContain("云端");
    const before = t.data().length;
    renderer.end();
    const final = safeText(t.data().slice(before));
    expect(final).toBe("云端 与 127.0.0.1\n\n");
    expect(t.output.listenerCount("resize")).toBe(0);
  });
  it("flushes idempotently at tool boundaries and reattaches resize on reuse", () => {
    const t = terminal(); const renderer = createAnswerRenderer(t.output, terminalTheme(t.output, {}));
    renderer.write("**第一段**"); renderer.end();
    const first = t.data(); renderer.end(); expect(t.data()).toBe(first);
    renderer.write("`第二段`"); expect(t.output.listenerCount("resize")).toBe(1);
    t.output.columns = 30; t.output.emit("resize"); renderer.end();
    expect(safeText(t.data())).toContain("第二段"); expect(t.output.listenerCount("resize")).toBe(0);
  });
  it("keeps pipe/plain output byte-compatible and renders NO_COLOR structurally", () => {
    const pipe = new PassThrough(); let raw = ""; pipe.on("data", (chunk) => { raw += chunk; });
    const renderer = createAnswerRenderer(pipe, terminalTheme(pipe, {}));
    renderer.write("**bold** `code`\n"); renderer.end();
    expect(raw).toBe("**bold** `code`\n");
    const t = terminal(); const mono = createAnswerRenderer(t.output, terminalTheme(t.output, { NO_COLOR: "" }));
    mono.write("**bold** `code`\n"); mono.end();
    expect(t.data()).toBe("bold code\n\n");
  });
  it("commits only completed blocks, bounding repaint work to the live block", () => {
    const t = terminal(); const renderer = createAnswerRenderer(t.output, terminalTheme(t.output, {}));
    renderer.write("**完成段落**\n\n下一段"); renderer.flush();
    const first = t.data().length;
    renderer.write("继续"); renderer.flush();
    expect(t.data().slice(first)).not.toContain("完成段落");
    renderer.end();
  });
});

export { sample as markdownRegressionSample };
