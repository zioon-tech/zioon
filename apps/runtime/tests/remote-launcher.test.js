import { PassThrough } from "node:stream";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { runRemoteLauncher } from "../src/remote-launcher.mjs";

function outputBuffer() {
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += chunk.toString();
  });
  return { output, text: () => text };
}

describe("Remote launcher", () => {
  it("prints a single-command help flow", async () => {
    const buffer = outputBuffer();

    await expect(runRemoteLauncher({
      argv: ["--help"],
      environment: {},
      output: buffer.output
    })).resolves.toBeNull();

    expect(buffer.text()).toContain("npm run remote:start");
    expect(buffer.text()).toContain("Cloudflare Quick Tunnel");
  });

  it("rejects a plaintext public URL", async () => {
    const buffer = outputBuffer();

    await expect(runRemoteLauncher({
      argv: [
        "--skip-build",
        "--public-url", "http://zion.example.test"
      ],
      environment: {},
      output: buffer.output
    })).rejects.toThrow("must use HTTPS");
  });

  it("refuses to attach to an unrelated process on the requested port", async () => {
    const listener = createServer();
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = listener.address();
      await expect(runRemoteLauncher({
        argv: [
          "--skip-build",
          "--local",
          "--port", String(address.port)
        ],
        environment: {},
        output: outputBuffer().output
      })).rejects.toThrow("already in use");
    } finally {
      await new Promise((resolve) => listener.close(resolve));
    }
  });
});
