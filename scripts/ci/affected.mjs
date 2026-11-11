import { readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const base = event.pull_request?.base?.sha || event.before;
const head = event.pull_request?.head?.sha || process.env.GITHUB_SHA;
const all = !base || /^0+$/.test(base) || process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
const paths = all ? [] : execFileSync("git", ["diff", "--name-only", base, head], { encoding: "utf8" }).trim().split("\n");
const shared = paths.some((path) => /^(package(-lock)?\.json|\.github\/workflows\/|scripts\/ci\/)/.test(path));
const rules = {
  runtime: /^(apps\/runtime\/|apps\/device-connector\/|packages\/|extensions\/.*\/runtime|scripts\/.*runtime|scripts\/(?:verify-zioon|cli-ux-fixture)|tests\/runtime)/,
  workbench: /^(src\/|public\/|index\.html|vite\.config|vitest\.config|tests\/|extensions\/|packages\/)/,
  portals: /^(apps\/(?:mobile-client|admin|client-portal)\/|packages\/account-ui\/|apps\/runtime\/src\/(?:accounts|platform-admin)\/)/,
  marketplace: /^(apps\/marketplace\/|apps\/runtime\/src\/marketplace\/|packages\/runtime-client\/)/,
  site: /^(apps\/public-site\/|docs\/|packages\/zioon-cli\/|scripts\/(?:build-zioon-cli|verify-zioon-cli))/,
};
for (const [component, pattern] of Object.entries(rules)) {
  const affected = all || shared || paths.some((path) => pattern.test(path));
  appendFileSync(process.env.GITHUB_OUTPUT, `${component}=${affected}\n`);
  console.log(`${component}: ${affected}`);
}
