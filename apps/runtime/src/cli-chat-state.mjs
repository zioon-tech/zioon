import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, win32 } from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");
export function chatStateDirectory(environment = process.env, platform = process.platform, home = homedir()) {
  if (environment.ZIOON_CHAT_STATE_DIR) return environment.ZIOON_CHAT_STATE_DIR;
  if (platform === "win32") return win32.join(environment.LOCALAPPDATA || environment.APPDATA || win32.join(home, "AppData", "Local"), "Zioon", "chat");
  if (platform === "darwin") return join(home, "Library", "Application Support", "Zioon", "chat");
  return join(environment.XDG_STATE_HOME || join(home, ".local", "state"), "zioon", "chat");
}

// Separate records avoid clobbering another terminal's conversation or settings.
// Only a hash of the endpoint/identity is stored; credentials never go to disk.
export function createChatState({ baseUrl, identity = "", environment = process.env, onError = () => {} }) {
  const root = join(chatStateDirectory(environment), hash(`${baseUrl.replace(/\/+$/, "")}\n${identity}`));
  let queue = Promise.resolve();
  const path = (key) => join(root, `${hash(key)}.json`);
  const read = async (key, strict = false) => {
    try {
      const data = JSON.parse(await readFile(path(key), "utf8"));
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch (error) {
      if (strict && error.code !== "ENOENT") throw error;
      if (error.code !== "ENOENT") onError(new Error("Local chat recovery could not be read; original file retained."));
      return {};
    }
  };
  return {
    root, read,
    write(key, patch) {
      queue = queue.then(async () => {
        await mkdir(root, { recursive: true, mode: 0o700 });
        const data = { ...await read(key, true), ...patch };
        const temp = `${path(key)}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
          await rename(temp, path(key));
        } finally { await rm(temp, { force: true }); }
        return true;
      }).catch(() => { onError(new Error("Local chat recovery could not be saved. Check disk space and permissions.")); return false; });
      return queue;
    },
    flush: () => queue
  };
}
