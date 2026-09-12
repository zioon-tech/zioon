import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileDeviceCredentialStore,
  deviceCredentialKey
} from "../src/device-credential-store.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Device credential store", () => {
  it("persists credentials in a restricted file without changing their key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-device-credentials-"));
    directories.push(directory);
    const path = join(directory, "credentials.json");
    const store = createFileDeviceCredentialStore({ path });
    const key = deviceCredentialKey(
      "https://runtime.example.test/path",
      "node:macbook"
    );
    const credential = {
      credential: "zion_v1.credential:test.secret",
      expiresAt: 10_000
    };

    await store.set(key, credential);

    await expect(store.get(key)).resolves.toEqual(credential);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("runtime.example.test/path");
    await expect(store.delete(key)).resolves.toBe(true);
    await expect(store.get(key)).resolves.toBeNull();
  });
});
