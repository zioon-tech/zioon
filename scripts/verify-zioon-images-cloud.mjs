// Optional real account smoke. Uploads only two generated geometric fixtures.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
const entry = resolve(process.argv[2]), destination = resolve(process.argv[3]), model = process.argv[4];
if (!model) throw new Error("Pass a verified image-capable model profile ID.");
function chunk(type, bytes) {
  const data = Buffer.concat([Buffer.from(type), bytes]);
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length); data.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
function fixture(circle) {
  const size = 256, rows = Buffer.alloc(size * (size * 3 + 1), 255);
  for (let y = 0; y < size; y++) {
    rows[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const fill = circle ? (x - 128) ** 2 + (y - 128) ** 2 <= 80 ** 2 : x >= 48 && x < 208 && y >= 48 && y < 208;
      if (fill) Buffer.from(circle ? [30, 85, 220] : [220, 40, 40]).copy(rows, y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
const paths = [join(destination, "images-fixture-1.png"), join(destination, "images-fixture-2.png")];
await writeFile(paths[0], fixture(false)); await writeFile(paths[1], fixture(true));
const state = await mkdtemp(join(tmpdir(), "zioon-cloud-images-"));
async function cli(args, input = "") {
  const child = spawn(process.execPath, [entry, ...args], { env: { ...process.env, ZIOON_CHAT_STATE_DIR: state }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => output += chunk); child.stderr.on("data", (chunk) => output += chunk);
  child.stdin.end(input);
  const [code] = await once(child, "exit");
  assert.equal(code, 0, output);
  return output;
}
try {
  const started = Date.now();
  const output = await cli(["chat", "--plain", "--no-tools", "--no-terminal-context", "--profile", "none",
    "--title", "CLI preview.4 image acceptance", "--model-profile", model, "-i", paths[0], "-i", paths[1]],
  "请只根据附图，依次写出 Image 1 和 Image 2 中主要图形的颜色与形状。用中文，两行，不要使用工具。\n/exit\n");
  await writeFile(join(destination, "images-cloud-output.txt"), output);
  const sessionId = output.match(/Saved in Session (\S+)\./)?.[1];
  assert.ok(sessionId, output);
  const { messages } = JSON.parse(await cli(["api", "GET", `/v1/sessions/${sessionId}/transcript`]));
  const user = messages.find((message) => message.role === "user");
  const { run } = JSON.parse(await cli(["api", "GET", `/v1/runs/${user.runId}`]));
  const assistant = messages.filter((message) => message.role === "assistant").map((message) => message.content).join("\n");
  const result = { version: "0.2.0-preview.4", model, sessionId, runId: user.runId, status: run.status,
    error: run.error || null,
    durationMs: Date.now() - started, fixtures: paths.map((path) => path.split("/").at(-1)),
    imageParts: user.content.filter((part) => part.type === "image_url").length, assistant,
    expected: ["红色正方形", "蓝色圆形"], visualAnswerCorrect: /红/.test(assistant) && /方/.test(assistant) && /蓝/.test(assistant) && /圆/.test(assistant) };
  await writeFile(join(destination, "images-cloud-smoke.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  assert.equal(run.status, "completed"); assert.equal(result.imageParts, 2); assert.ok(result.visualAnswerCorrect);
} finally { await rm(state, { recursive: true, force: true }); }
