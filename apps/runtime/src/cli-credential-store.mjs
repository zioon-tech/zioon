import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const DEFAULT_SERVICE = "dev.zion.runtime-cli";

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export function createMacOsKeychainCredentialStore({
  service = DEFAULT_SERVICE,
  execFileImpl = execFileAsync
} = {}) {
  return Object.freeze({
    async get(profileName) {
      try {
        const { stdout } = await execFileImpl("security", [
          "find-generic-password",
          "-s", service,
          "-a", String(profileName),
          "-w"
        ], {
          encoding: "utf8",
          maxBuffer: 1024 * 1024
        });
        const value = JSON.parse(String(stdout || "").trim());
        return value && typeof value === "object" ? value : null;
      } catch (error) {
        if (Number(error?.code) === 44) return null;
        throw new Error(
          `Cannot read Runtime CLI credential from Keychain: ${
            error?.message || String(error)
          }`
        );
      }
    },

    async set(profileName, credential) {
      const serialized = JSON.stringify(credential);
      try {
        await execFileImpl("security", [
          "add-generic-password",
          "-U",
          "-s", service,
          "-a", String(profileName),
          "-w", serialized
        ], {
          encoding: "utf8",
          maxBuffer: 1024 * 1024
        });
      } catch {
        // execFile errors include argv, which contains the credential.
        throw new Error("Cannot save Runtime CLI credential to Keychain");
      }
    },

    async delete(profileName) {
      try {
        await execFileImpl("security", [
          "delete-generic-password",
          "-s", service,
          "-a", String(profileName)
        ], {
          encoding: "utf8",
          maxBuffer: 1024 * 1024
        });
        return true;
      } catch (error) {
        if (Number(error?.code) === 44) return false;
        throw new Error(
          `Cannot delete Runtime CLI credential from Keychain: ${
            error?.message || String(error)
          }`
        );
      }
    }
  });
}

export function windowsProtect(value, decrypt = false) {
  // Send sensitive data via stdin, never command arguments or error output.
  const operation = decrypt
    ? "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($data),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))"
    : "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($data),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))";
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security; $data=[Console]::In.ReadToEnd(); [Console]::Out.Write(${operation})`
    ], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let result = "";
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on("data", (chunk) => { result += chunk; });
    child.stdin.on("error", () => {});
    child.once("error", () => { clearTimeout(timer); reject(new Error("Windows credential protection failed")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && result) resolve(result);
      else reject(new Error("Windows credential protection failed"));
    });
    child.stdin.end(value);
  });
}

export function createFileCliCredentialStore({
  directory = process.env.ZIOON_CLI_CREDENTIAL_DIR || join(homedir(), ".zion-next", "cli-credentials"),
  platform = process.platform,
  protect = windowsProtect
} = {}) {
  const windows = platform === "win32";
  const filename = (key) => join(directory,
    `${createHash("sha256").update(String(key)).digest("hex")}.json`);
  const checkPrivate = async (path, isDirectory = false) => {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (isDirectory ? !info.isDirectory() : !info.isFile())
      || (!windows && ((info.mode & 0o077) || info.uid !== process.getuid()))) {
      throw new Error("CLI credential store must be owned by this user and private");
    }
  };
  const ensureDirectory = async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await checkPrivate(directory, true);
  };
  return Object.freeze({
    async get(key) {
      try {
        await checkPrivate(directory, true);
        const path = filename(key);
        await checkPrivate(path);
        const raw = await readFile(path, "utf8");
        const stored = JSON.parse(raw);
        const value = windows ? JSON.parse(await protect(stored.protected, true)) : stored;
        return value && typeof value === "object" ? value : null;
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw new Error("Cannot read CLI credential; check its permissions or sign in again");
      }
    },
    async set(key, credential) {
      await ensureDirectory();
      const path = filename(key);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const serialized = JSON.stringify(credential);
        await writeFile(temporary, windows
          ? JSON.stringify({ protected: await protect(serialized) }) : serialized,
        { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
      } catch {
        throw new Error("Cannot save CLI credential");
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async delete(key) {
      try {
        await checkPrivate(directory, true);
        await checkPrivate(filename(key));
        await rm(filename(key));
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw new Error("Cannot delete CLI credential");
      }
    }
  });
}

export function createCliCredentialStore({ platform = process.platform, ...options } = {}) {
  if (platform === "darwin" && !process.env.ZIOON_CLI_CREDENTIAL_DIR && !options.directory) {
    return createMacOsKeychainCredentialStore(options);
  }
  return createFileCliCredentialStore({ platform, ...options });
}
