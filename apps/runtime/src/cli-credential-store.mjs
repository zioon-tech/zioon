import { execFile } from "node:child_process";
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

export function createCliCredentialStore({
  platform = process.platform,
  ...options
} = {}) {
  if (platform === "darwin") {
    return createMacOsKeychainCredentialStore(options);
  }
  return Object.freeze({
    async get() {
      throw new Error(
        "OAuth device credentials require an OS credential-store adapter; "
        + "use bearer env or workload token-file auth on this platform"
      );
    },
    async set() {
      throw new Error(
        "OAuth device credentials require an OS credential-store adapter"
      );
    },
    async delete() {
      throw new Error(
        "OAuth device credentials require an OS credential-store adapter"
      );
    }
  });
}
