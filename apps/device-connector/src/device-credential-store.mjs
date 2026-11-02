import { execFile } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

const DEFAULT_SERVICE = "dev.zion.device-connector";

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

function parseCredential(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed
      && typeof parsed === "object"
      && String(parsed.credential || "")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function deviceCredentialKey(runtimeUrl, nodeId) {
  const origin = new URL(String(runtimeUrl || "")).origin;
  return `${origin}|${String(nodeId || "")}`;
}

export function createMacOsDeviceCredentialStore({
  service = DEFAULT_SERVICE,
  execFileImpl = execFileAsync
} = {}) {
  return Object.freeze({
    async get(key) {
      try {
        const { stdout } = await execFileImpl("security", [
          "find-generic-password",
          "-s", service,
          "-a", String(key),
          "-w"
        ], {
          encoding: "utf8",
          maxBuffer: 1024 * 1024
        });
        return parseCredential(String(stdout || "").trim());
      } catch (error) {
        if (Number(error?.code) === 44) return null;
        throw new Error(
          `Cannot read Device credential from Keychain: ${
            error?.message || String(error)
          }`
        );
      }
    },

    async set(key, credential) {
      await execFileImpl("security", [
        "add-generic-password",
        "-U",
        "-s", service,
        "-a", String(key),
        "-w", JSON.stringify(credential)
      ], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024
      });
    },

    async delete(key) {
      try {
        await execFileImpl("security", [
          "delete-generic-password",
          "-s", service,
          "-a", String(key)
        ], {
          encoding: "utf8",
          maxBuffer: 1024 * 1024
        });
        return true;
      } catch (error) {
        if (Number(error?.code) === 44) return false;
        throw new Error(
          `Cannot delete Device credential from Keychain: ${
            error?.message || String(error)
          }`
        );
      }
    }
  });
}

export function createFileDeviceCredentialStore({
  path = join(homedir(), ".zion-next", "device-credentials.json")
} = {}) {
  const readAll = () => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw new Error(
        `Cannot read Device credential store ${path}: ${
          error?.message || String(error)
        }`
      );
    }
  };
  const writeAll = (value) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  };
  return Object.freeze({
    async get(key) {
      return parseCredential(readAll()[key]);
    },
    async set(key, credential) {
      writeAll({ ...readAll(), [key]: credential });
    },
    async delete(key) {
      const values = readAll();
      if (!Object.hasOwn(values, key)) return false;
      delete values[key];
      writeAll(values);
      return true;
    }
  });
}

export function createDeviceCredentialStore({
  platform = process.platform,
  ...options
} = {}) {
  return platform === "darwin"
    ? createMacOsDeviceCredentialStore(options)
    : createFileDeviceCredentialStore(options);
}
