import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { startMultiNodeFixture } from "../apps/runtime/tests/helpers/multi-node-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = await startMultiNodeFixture();
const server = await createServer({
  configFile: false,
  root,
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT || 5194),
    proxy: { "/v1/device-services": fixture.url }
  },
  plugins: [{
    name: "multi-node-verification",
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (new URL(request.url, "http://fixture").pathname !== "/") return next();
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Multi-Node Terminal Verification</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.36/dist/codicon.css">
<link rel="stylesheet" href="/extensions/dev.terminal-manager/styles.css">
<style>
:root{--fg:#24282c;--border:#d9dde0;--accent:#167659;--hover-bg:#e9edf1}
body{margin:0;background:#f7f8fa;font-family:system-ui}
main{width:min(100%,380px);height:100dvh;border-right:1px solid var(--border);box-sizing:border-box}
</style></head><body><main id="terminal"></main>
<script type="module">
import { mountTerminalManagerSidebarViewInto } from "/extensions/dev.terminal-manager/session-tools.js";
const values = new Map([["runtime.mode","runtime"],["runtime.baseUrl",location.origin]]);
const listeners = new Map();
window.zion = {
  state:{
    get:key=>values.get(key),
    set(key,value){values.set(key,value);for(const fn of listeners.get(key)||[])fn(value)},
    onDidChange(key,fn){const set=listeners.get(key)||new Set();set.add(fn);listeners.set(key,set);return{dispose:()=>set.delete(fn)}}
  },
  commands:{executeCommand:async()=>{}}
};
mountTerminalManagerSidebarViewInto(document.querySelector("#terminal"));
</script></body></html>`);
      });
    }
  }]
});
await server.listen();
server.printUrls();
console.log("Isolated terminal verification: two test Nodes, no user files or cloud credentials.");
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  await fixture.close();
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
