import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { detectImageMediaType } from "./asset-service.mjs";
import { localPath } from "./cli-files.mjs";
import { cellWidth, truncate } from "./cli-text.mjs";

const exec = promisify(execFile);
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGES = 8;
export const MAX_TOTAL_IMAGE_BYTES = 32 * 1024 * 1024;
const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif" };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const imageName = (text) => /\.(png|jpe?g|gif|webp|avif)$/i.test(text);

// A drop must consist entirely of explicit image paths. Never evaluate shell
// syntax or extract paths out of prose. POSIX escaped spaces and Windows paths
// both work; ordinary Windows backslashes are retained.
export function droppedImagePaths(value) {
  const text = value.trim();
  const tokens = []; let token = "", quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = "";
      else token += ch;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\\" && /[\s'"]/.test(text[i + 1] || "")) token += text[++i];
    else if (/\s/.test(ch)) { if (token) tokens.push(token); token = ""; }
    else token += ch;
  }
  if (quote) return null;
  if (token) tokens.push(token);
  if (!tokens.length || tokens.length > MAX_IMAGES) return null;
  try {
    const paths = tokens.map((part) => part.startsWith("file://") ? fileURLToPath(part) : part);
    return paths.every((part) => /^(\/|~[/\\]|[A-Za-z]:[/\\]|\\\\)/.test(part) && imageName(part)) ? paths : null;
  } catch { return null; }
}

export function imageCapability(profile) {
  const capabilities = profile?.capabilities || {};
  if (capabilities.supportsImage === false || capabilities.supportsImages === false || profile?.supportsImages === false) return false;
  return capabilities.supportsImage === true || capabilities.supportsImages === true || profile?.supportsImages === true;
}

export function imageLabel(image, index, columns) {
  const size = image.byteLength < 1024 * 1024 ? `${Math.ceil(image.byteLength / 1024)} KiB` : `${(image.byteLength / 1024 / 1024).toFixed(1)} MiB`;
  const prefix = `[Image ${index + 1}] `;
  const suffix = ` · ${size} · ${image.status || (image.uri ? "uploaded" : "local")}`;
  const room = Number.isFinite(columns) ? Math.max(0, columns - cellWidth(prefix + suffix)) : Infinity;
  const name = cellWidth(image.name) > room ? `${truncate(image.name, Math.max(0, room - 1))}${room ? "…" : ""}` : image.name;
  return prefix + name + suffix;
}

async function boundedImageFile(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Choose a regular image file.");
    if (info.size > MAX_IMAGE_BYTES) throw new Error("Image exceeds 16 MiB.");
    const bytes = Buffer.alloc(Math.min(MAX_IMAGE_BYTES + 1, info.size + 1));
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > info.size) throw new Error("Image changed while being read. Add it again.");
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

export async function cacheImage(bytes, name, state) {
  if (!state?.root) throw new Error("Local recovery storage is required for images.");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("Image must be between 1 byte and 16 MiB.");
  const mediaType = detectImageMediaType(bytes);
  if (!mediaType) throw new Error("Only PNG, JPEG, GIF, WebP and AVIF images are supported. File content is checked.");
  const sha256 = digest(bytes), extension = extensions[mediaType];
  const directory = join(state.root, "images"), path = join(directory, `${sha256}.${extension}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Content-addressed, private cache survives moving/deleting the original file.
  try { await writeFile(path, bytes, { mode: 0o600, flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (digest(await boundedImageFile(path)) !== sha256) throw new Error("Cached image is damaged. Remove its cache file and add the image again.");
  }
  return { kind: "image", name: basename(name).replace(/[\x00-\x1f\x7f]/g, ""), sha256, mediaType, byteLength: bytes.length };
}

export async function readImageAttachment(value, state) {
  const path = localPath(value);
  return cacheImage(await boundedImageFile(path), basename(path), state);
}

export function cachedImagePath(image, state) {
  if (!state?.root || !/^[a-f0-9]{64}$/.test(image.sha256) || !extensions[image.mediaType]) throw new Error("Invalid cached image record.");
  return join(state.root, "images", `${image.sha256}.${extensions[image.mediaType]}`);
}

export async function readCachedImage(image, state) {
  const bytes = await boundedImageFile(cachedImagePath(image, state));
  if (digest(bytes) !== image.sha256 || bytes.length !== image.byteLength) throw new Error("Cached image changed. Remove it with /images remove and add it again.");
  return bytes;
}

export async function clipboardImage({ platform = process.platform, environment = process.env, run = exec } = {}) {
  const options = { env: environment, timeout: 8000, maxBuffer: MAX_IMAGE_BYTES * 2, encoding: "buffer", windowsHide: true };
  const validate = (bytes) => {
    if (!bytes?.length || !detectImageMediaType(bytes)) throw Object.assign(new Error("Clipboard image conversion returned invalid bytes."), { code: "CLIPBOARD_IMAGE_INVALID" });
    if (bytes.length > MAX_IMAGE_BYTES) throw Object.assign(new Error("Clipboard image exceeds 16 MiB."), { code: "CLIPBOARD_IMAGE_TOO_LARGE" });
    return bytes;
  };
  try {
    if (platform === "darwin") {
      const script = `ObjC.import('AppKit'); const p=$.NSPasteboard.generalPasteboard; const images=$.NSImage.imageTypes; const t=p.availableTypeFromArray(images); if(!t || t.isNil()) throw Error('ZIOON_CLIPBOARD_NO_IMAGE'); const d=p.dataForType(t); const b=$.NSBitmapImageRep.imageRepWithData(d); if(!b || b.isNil()) throw Error('ZIOON_CLIPBOARD_CONVERSION_FAILED'); const png=b.representationUsingTypeProperties($.NSBitmapImageFileTypePNG,$()); if(!png || png.isNil()) throw Error('ZIOON_CLIPBOARD_CONVERSION_FAILED'); ObjC.unwrap(png.base64EncodedStringWithOptions(0));`;
      const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", script], options);
      return validate(Buffer.from(stdout.toString().trim(), "base64"));
    }
    if (platform === "win32") {
      const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $im=[System.Windows.Forms.Clipboard]::GetImage(); if($null -eq $im){exit 2}; $ms=New-Object System.IO.MemoryStream; $im.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png); [Console]::Write([Convert]::ToBase64String($ms.ToArray())); $ms.Dispose(); $im.Dispose()`;
      const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], options);
      return validate(Buffer.from(stdout.toString().trim(), "base64"));
    }
    if (environment.WAYLAND_DISPLAY) {
      try { return validate((await run("wl-paste", ["--no-newline", "--type", "image/png"], options)).stdout); }
      catch { /* XWayland may still provide an X11 clipboard. */ }
    }
    return validate((await run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"], options)).stdout);
  } catch (error) {
    if (error.code === "CLIPBOARD_IMAGE_TOO_LARGE") throw error;
    if (error.code === "CLIPBOARD_IMAGE_INVALID" || /ZIOON_CLIPBOARD_CONVERSION_FAILED/.test(error.stderr?.toString() || ""))
      throw new Error("Clipboard image could not be converted. Copy it again, or save it and use /image <path>.");
    if (error.code === "ENOENT")
      throw new Error(platform === "linux" ? "Clipboard helper missing. Install wl-paste or xclip, or use /image <path>." : "System clipboard helper unavailable. Use /image <path>.");
    if (error.killed || error.code === "ETIMEDOUT")
      throw new Error("Clipboard read timed out. Try /paste again, or use /image <path>.");
    if (platform === "darwin" && /ZIOON_CLIPBOARD_NO_IMAGE/.test(error.stderr?.toString() || ""))
      throw new Error("Clipboard has no image. Use Ctrl+Cmd+Shift+4 to capture to the clipboard, then Ctrl+V or /paste. Cmd+Shift+4 saves a file.");
    throw new Error("No clipboard image available. Copy an image, drag its file here, or use /image <path>. Linux needs wl-paste or xclip.");
  }
}

export async function openImage(image, state) {
  await readCachedImage(image, state);
  const path = cachedImagePath(image, state);
  const executable = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [path], { stdio: "ignore", shell: false, detached: true });
    child.once("error", () => reject(new Error(`Cannot open image viewer. Cached file: ${path}`)));
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export function messageText(content) {
  if (!Array.isArray(content)) return typeof content === "string" ? content : JSON.stringify(content);
  let index = 0; const lines = [];
  for (const part of content) {
    if (part.type === "text") lines.push(part.text);
    if (part.type === "image_url") {
      const label = `[Image ${++index}]`;
      if (lines.at(-1) !== label) lines.push(label);
    }
  }
  return lines.filter(Boolean).join("\n");
}
