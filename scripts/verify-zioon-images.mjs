// End-to-end image journeys through the packaged CLI and a local HTTP Runtime.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { clipboardImage, droppedImagePaths, readImageAttachment } from "../apps/runtime/src/cli-images.mjs";
import { createChatState } from "../apps/runtime/src/cli-chat-state.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(process.argv[2]), destination = resolve(process.argv[3]);
const temporary = await mkdtemp(join(tmpdir(), "zioon-images-"));
const server = spawn(process.execPath, [join(root, "scripts/cli-ux-fixture.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
const url = (await once(server.stdout, "data"))[0].toString().trim();
const checks = [];
function chunk(type, bytes) {
  const data = Buffer.concat([Buffer.from(type), bytes]);
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  const output = Buffer.alloc(bytes.length + 12);
  output.writeUInt32BE(bytes.length); data.copy(output, 4); output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}
const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
  chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0]))), chunk("IEND", Buffer.alloc(0))]);
const path1 = join(temporary, "图 一.png"), path2 = join(temporary, "图 二.png");
await writeFile(path1, png); await writeFile(path2, Buffer.concat([png, Buffer.from("second")]));
const environment = (name) => ({ ...process.env, ZIOON_CHAT_STATE_DIR: join(temporary, name), ZION_RUNTIME_CLI_CONFIG: join(temporary, "absent.json") });
const state = async () => (await fetch(`${url}/__state`)).json();
const control = async (value) => fetch(`${url}/__control`, { method: "POST", body: JSON.stringify(value) });
async function chat(name, lines, args = []) {
  const child = spawn(process.execPath, [entry, "--url", url, ...args], { env: environment(name), stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => output += chunk);
  child.stderr.on("data", (chunk) => output += chunk);
  child.stdin.end(lines);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  const [code] = await once(child, "exit"); clearTimeout(timeout);
  assert.equal(code, 0, output);
  return output;
}
try {
  assert.deepEqual(droppedImagePaths(`'${path1}' "${path2}"`), [path1, path2]);
  assert.deepEqual(droppedImagePaths(path1.replaceAll(" ", "\\ ")), [path1]);
  assert.deepEqual(droppedImagePaths('"C:\\Users\\Tester\\my image.png"'), ["C:\\Users\\Tester\\my image.png"]);
  assert.equal(droppedImagePaths("please examine /tmp/test.png"), null);
  assert.equal(droppedImagePaths("/tmp/a.png; rm -rf /tmp/x"), null);
  checks.push("quoted, escaped Chinese and Windows drops; prose and shell syntax remain text");

  const calls = [];
  for (const platform of ["darwin", "win32", "linux"]) {
    const result = await clipboardImage({ platform, environment: {}, run: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: platform === "linux" ? png : Buffer.from(png.toString("base64")) };
    } });
    assert.deepEqual(result, png);
  }
  assert.deepEqual(calls.map((call) => call.command), ["osascript", "powershell.exe", "xclip"]);
  assert.ok(calls.every((call) => call.options.timeout === 8000));
  await assert.rejects(clipboardImage({ run: async () => { throw new Error("unavailable"); } }), /No clipboard image/);
  checks.push("clipboard platform adapters decode bytes, bound time and explain unavailable helpers (simulated)");
  if (process.platform === "darwin") {
    const result = await clipboardImage({ run: (command, args, options) => {
      const script = args.at(-1)
        .replace("$.NSPasteboard.generalPasteboard", "$.NSPasteboard.pasteboardWithUniqueName")
        .replace("const images=", `p.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions('${png.toString("base64")}',0),'public.png'); const images=`)
        .replace("ObjC.unwrap(png.base64EncodedStringWithOptions(0));", "const result=ObjC.unwrap(png.base64EncodedStringWithOptions(0)); p.releaseGlobally; result;");
      return promisify(execFile)(command, [...args.slice(0, -1), script], options).catch((error) => {
        console.error(error.stderr?.toString()); throw error;
      });
    } });
    assert.equal(result.subarray(1, 4).toString(), "PNG");
    checks.push("native macOS AppKit image conversion with a private test pasteboard; user's clipboard untouched");
  }

  const cache = createChatState({ baseUrl: url, environment: environment("cache") });
  const fake = join(temporary, "fake.png");
  await writeFile(fake, "not an image");
  await assert.rejects(readImageAttachment(fake, cache), /File content is checked/);
  await writeFile(fake, Buffer.alloc(16 * 1024 * 1024 + 1));
  await assert.rejects(readImageAttachment(fake, cache), /16 MiB/);
  checks.push("reject disguised non-images and oversized input before upload");

  let before = await state();
  let output = await chat("unsupported", "看图\n/exit\n", ["-i", path1]);
  assert.match(output, /does not declare image support/);
  assert.equal((await state()).uploadAttempts, before.uploadAttempts);
  assert.equal((await state()).prompts.length, before.prompts.length);
  output = await chat("unsupported", "/images\n/model smart\n/draft send\n/exit\n");
  assert.match(output, /Draft restored/);
  let current = await state();
  assert.equal(current.uploadAttempts, before.uploadAttempts + 1);
  assert.equal(current.prompts.at(-1)[0].text, "看图");
  assert.equal(current.prompts.at(-1).filter((part) => part.type === "image_url").length, 1);
  checks.push("incompatible model prevents upload/send; restart and model change preserve text and image");

  before = await state();
  await chat("multi", `比较这两张\nnext\n/exit\n`, ["--model-profile", "smart", "--image", path1, "-i", path2, "-i", path1]);
  current = await state();
  assert.equal(current.uploadAttempts, before.uploadAttempts + 2);
  assert.equal(current.prompts.at(-2).filter((part) => part.type === "image_url").length, 2);
  assert.deepEqual(current.prompts.at(-2).filter((part) => part.type === "text").map((part) => part.text), ["比较这两张", "[Image 1]", "[Image 2]"]);
  assert.equal(current.prompts.at(-1), "next");
  assert.equal(current.uploads.at(-2).name, "图 一.png");
  assert.equal(current.uploads.at(-2).mediaType, "image/png");
  assert.deepEqual(Buffer.from(current.uploads.at(-2).bytes, "base64"), png);
  checks.push("text plus numbered multiple images, content deduplication, binary upload and clear after acceptance");

  before = await state();
  await control({ failUpload: before.uploadAttempts + 2 });
  output = await chat("partial", "compare\n/exit\n", ["--model-profile", "smart", "-i", path1, "-i", path2]);
  assert.match(output, /Upload temporarily unavailable/);
  assert.equal((await state()).prompts.length, before.prompts.length);
  await rm(path1); await rm(path2);
  output = await chat("partial", "/draft send\n/exit\n");
  current = await state();
  assert.equal(current.uploadAttempts, before.uploadAttempts + 3);
  assert.equal(current.uploads.length, before.uploads.length + 2);
  assert.equal(current.prompts.at(-1)[0].text, "compare");
  checks.push("partial upload failure survives restart/deleted originals; uploaded image is reused");
  await writeFile(path1, png); await writeFile(path2, Buffer.concat([png, Buffer.from("second")]));

  before = await state();
  await control({ loseNext: true });
  output = await chat("lost", "exactly once\n/exit\n", ["--model-profile", "smart", "-i", path1]);
  assert.match(output, /Acceptance unconfirmed/);
  output = await chat("lost", "/recover\n/images\n/exit\n", ["--continue"]);
  assert.match(output, /was accepted/); assert.match(output, /No images/);
  current = await state();
  assert.equal(current.prompts.length, before.prompts.length + 1);
  assert.equal(current.sends.length, before.sends.length + 1);
  assert.equal(current.uploadAttempts, before.uploadAttempts + 1);
  checks.push("lost acceptance response reconciles after restart without duplicate upload or message");

  before = await state();
  await control({ rejectNext: true });
  output = await chat("retry", "retry safely\n/images clear\n/recover retry\n/exit\n", ["--model-profile", "smart", "-i", path1]);
  assert.match(output, /Not sent/); assert.match(output, /before changing its images/);
  current = await state();
  assert.deepEqual(current.sends.at(-1), current.sends.at(-2));
  assert.equal(current.uploadAttempts, before.uploadAttempts + 1);
  checks.push("explicit retry reuses image references and request ID; pending attachments cannot mutate");

  before = await state();
  await control({ failRunNext: true });
  output = await chat("model-failure", "model failure draft\n/exit\n", ["--model-profile", "smart", "-i", path1]);
  assert.match(output, /Model only accepts text/);
  assert.match(output, /recover draft/);
  output = await chat("model-failure", "/recover draft\n/draft send\n/exit\n", ["--continue"]);
  assert.match(output, /Failed Run draft restored/);
  current = await state();
  assert.equal(current.uploadAttempts, before.uploadAttempts + 1);
  assert.equal(current.sends.length, before.sends.length + 2);
  assert.notEqual(current.sends.at(-1).clientRequestId, current.sends.at(-2).clientRequestId);
  assert.deepEqual(current.sends.at(-1).content, current.sends.at(-2).content);
  checks.push("accepted but failed model Run retains recoverable draft; explicit new send reuses uploaded images");

  before = await state();
  await chat("drop", `"${path1}" "${path2}"\n/images remove 1\n/model smart\n\n/exit\n`);
  current = await state();
  assert.equal(current.uploadAttempts, before.uploadAttempts + 1);
  assert.equal(current.prompts.at(-1).filter((part) => part.type === "image_url").length, 1);
  assert.equal(current.uploads.at(-1).name, "图 二.png");
  checks.push("dropped paths attach without sending; remove renumbers and image-only message works");

  const result = { version: (await promisify(execFile)(process.execPath, [entry, "--version"])).stdout.trim(), passed: checks.length, checks, platform: process.platform,
    native_clipboard: process.platform === "darwin" ? "AppKit conversion tested on a private pasteboard; system clipboard untouched" : "Not exercised; adapter contracts simulated",
    remote_model: "Local fixture only" };
  await writeFile(join(destination, "images-regression-results.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally { server.kill(); await once(server, "exit"); await rm(temporary, { recursive: true, force: true }); }
