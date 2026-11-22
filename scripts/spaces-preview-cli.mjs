import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runRuntimeCli, runtimeCliExitCode } from "../apps/runtime/src/runtime-cli.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(process.env.ZIOON_SPACES_PREVIEW_DIR || join(repository, ".runtime-data/spaces-preview"));
const config = JSON.parse(await readFile(join(directory, "config.local.json"), "utf8"));
const argv = process.argv.slice(2);
const requested = argv[0] || "partner";
const index = { owner: 0, partner: 1, guest: 2 }[requested];
if (index === undefined) throw new Error("Choose owner, partner or guest, then normal zioon CLI arguments.");
const account = config.accounts[index];
const args = argv.slice(1);
const command = args.length ? args : ["chat"];
if (!command.includes("--space")) command.push("--space", account.personalSpaceId);
command.push("--url", config.runtimeUrl, "--account");
try {
  const result = await runRuntimeCli({ argv: command,
    environment: { ...process.env, ZIOON_CHAT_STATE_DIR: join(directory, `cli-${requested}`),
      ZION_RUNTIME_CLI_CONFIG: join(directory, "cli-profiles.local.json") },
    credentialStore: { get: async () => ({ origin: config.runtimeUrl, token: account.token, expiresAt: Date.now() + 600000 }) }
  });
  process.exitCode = runtimeCliExitCode(result);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
