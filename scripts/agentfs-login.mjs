#!/usr/bin/env node
// Standalone: copied into persistent CLI installations; requires only Node/Bun.
import { readFile, mkdir, open, rename, unlink, rmdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_RUNTIME = "https://runtime.zioon.tech";
const DEFAULT_API = "https://memory.zioon.tech";
const HELP = `Zion account authentication for agent-fs

  agent-fs login                 输出登录链接，浏览器确认后自动保存凭据
  agent-fs auth login            同上
  agent-fs auth status           检查登录状态
  agent-fs auth whoami           显示已登录账户
  agent-fs logout                撤销并清除本地登录

Options: --api-url <url> --runtime-url <url> --json --help
Environment: AGENT_FS_API_URL, ZION_ACCOUNT_RUNTIME_URL, AGENT_FS_HOME
`;

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("登录服务 URL 无效。"); }
  if ((url.protocol !== "https:"
    && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash) {
    throw new Error("登录服务需要 HTTPS（本机地址可用 HTTP），URL 不得包含凭据或查询参数。");
  }
  return url.href.replace(/\/+$/, "");
}

function parseArgs(args) {
  const options = { action: "login", json: false };
  if (args[0] === "--json") { options.json = true; args.shift(); }
  if (args[0] === "auth") args = args.slice(1);
  if (args[0] && !args[0].startsWith("-")) options.action = args.shift();
  if (!["login", "logout", "status", "whoami", "help"].includes(options.action)) {
    throw new Error("未知登录命令。运行 agent-fs login --help 查看用法。");
  }
  while (args.length) {
    const flag = args.shift();
    if (flag === "--help" || flag === "-h") options.action = "help";
    else if (flag === "--json") options.json = true;
    else if (["--api-url", "--runtime-url"].includes(flag)) {
      const value = args.shift();
      if (!value || value.startsWith("-")) throw new Error("URL 参数缺少值。");
      options[flag === "--api-url" ? "apiUrl" : "runtimeUrl"] = value;
    } else throw new Error("不支持此登录参数。运行 agent-fs login --help 查看用法。");
  }
  return options;
}

async function readConfig(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || (value.auth !== undefined && (!value.auth || typeof value.auth !== "object" || Array.isArray(value.auth)))) {
      throw new Error("invalid_config");
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("无法读取 agent-fs 配置；请检查 config.json 的权限和 JSON 格式。");
  }
}

// Brief lock protects credential replacement/logout across CLI processes.
// A failed save leaves the original config intact and removes only our temp file.
async function updateConfig(directory, update) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "config.json");
  const lock = `${path}.lock`;
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("另一个登录操作正在保存配置；请稍后重试。");
    throw new Error("无法创建登录配置目录。");
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    const previous = await readConfig(path);
    const next = await update(previous);
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(next, null, 2)}\n`);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    return previous;
  } finally {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    await rmdir(lock).catch(() => {});
  }
}

function credential(config) {
  return config.apiKey ?? config.auth?.apiKey;
}
const accountToken = (value) => typeof value === "string"
  && (value.startsWith("zion_account_v1.") || value.startsWith("zioon_at_"));

function safeIdentity(me) {
  if (!me || typeof me.userId !== "string" || !me.userId
    || typeof me.defaultOrgId !== "string" || !me.defaultOrgId
    || typeof me.defaultDriveId !== "string" || !me.defaultDriveId) {
    throw new Error("Memory 服务返回的账户信息无效；登录未保存。");
  }
  return { userId: me.userId, email: typeof me.email === "string" ? me.email : undefined };
}

export async function manageAgentfsAuth({
  args = [], env = process.env, signal,
  fetchImpl = globalThis.fetch, emit = console.log,
  now = Date.now, sleep = (ms) => delay(ms, undefined, { signal })
} = {}) {
  const options = parseArgs([...args]);
  if (options.action === "help") { emit(HELP); return 0; }
  const directory = resolve(env.AGENT_FS_HOME || join(env.HOME || homedir(), ".agent-fs"));
  const config = await readConfig(join(directory, "config.json"));
  const apiUrl = endpoint(options.apiUrl || env.AGENT_FS_API_URL || config.apiUrl || DEFAULT_API);
  const runtimeUrl = endpoint(options.runtimeUrl || env.ZION_ACCOUNT_RUNTIME_URL
    || (config.zionAccount?.apiUrl === apiUrl ? config.zionAccount.runtimeUrl : null)
    || new URL(apiUrl).origin);
  if (new URL(runtimeUrl).pathname !== "/") throw new Error("Runtime URL 必须指向服务根地址。");
  const output = (event, text) => emit(options.json ? JSON.stringify(event) : text);

  async function request(url, { token, body, cleanup = false } = {}) {
    const timeout = AbortSignal.timeout(10_000);
    let response;
    try {
      response = await fetchImpl(url, {
        method: body === undefined ? "GET" : "POST", redirect: "error",
        signal: signal && !cleanup ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          accept: "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch {
      if (!cleanup) signal?.throwIfAborted();
      throw new Error("无法连接登录或 Memory 服务；请检查网络和服务地址。");
    }
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      const errors = {
        device_login_expired: "登录链接已过期，请重新运行 agent-fs login。",
        device_login_failed: "登录未获确认或已被拒绝，请重新运行 agent-fs login。",
        access_denied: "登录已被拒绝，请重新运行 agent-fs login。",
        device_login_unavailable: "该 Runtime 尚未启用设备登录。",
        too_many_login_flows: "登录请求过多，请稍后重试。"
      };
      throw Object.assign(new Error(errors[value?.error]
        || `服务请求失败（HTTP ${response.status}）。`), { statusCode: response.status });
    }
    if (!value || typeof value !== "object") throw new Error("服务返回了无效响应。");
    return value;
  }
  const account = (path, params) => request(`${runtimeUrl}/v1/account/${path}`, params);
  async function revoke(token, targetRuntime = runtimeUrl) {
    try { await request(`${endpoint(targetRuntime)}/v1/account/logout`, { token, body: {}, cleanup: true }); }
    catch (error) { if (error.statusCode !== 401) throw error; }
  }

  if (options.action === "login") {
    if (env.AGENT_FS_API_KEY !== undefined) {
      throw new Error("请先 unset AGENT_FS_API_KEY；该环境变量会覆盖自动保存的登录。");
    }
    const flow = await account("device/start", { body: {} });
    if (typeof flow.flowToken !== "string" || !flow.flowToken
      || typeof flow.verificationUri !== "string"
      || !Number.isFinite(flow.expiresAt) || flow.expiresAt <= now()) {
      throw new Error("Runtime 返回了无效或已过期的登录链接。");
    }
    // Verification URLs may contain the public user code; never emit flowToken.
    const verification = new URL(flow.verificationUriComplete || flow.verificationUri);
    endpoint(verification.origin);
    if (verification.username || verification.password) throw new Error("登录链接无效。");
    output({
      type: "auth.deviceCode", verificationUri: verification.href,
      userCode: flow.userCode, expiresAt: flow.expiresAt
    }, `在浏览器打开并确认 Zion 登录：\n${verification.href}\n`
      + (flow.verificationUriComplete ? "" : `验证码：${flow.userCode || ""}\n`)
      + `等待确认中（链接有效至 ${new Date(flow.expiresAt).toLocaleTimeString()}，Ctrl+C 取消）…`);
    let session;
    let saved = false;
    const intervalMs = Math.min(Math.max(5, Number(flow.interval) || 5), 30) * 1000;
    try {
      while (now() < flow.expiresAt) {
        await sleep(Math.min(intervalMs, flow.expiresAt - now()));
        signal?.throwIfAborted();
        if (now() >= flow.expiresAt) break;
        const result = await account("device/poll", { body: { flowToken: flow.flowToken } });
        if (result.pending === true) continue;
        session = result;
        if (!accountToken(session.token)
          || !Number.isFinite(session.expiresAt) || session.expiresAt <= now()) {
          throw new Error("Runtime 返回了无效或已过期的登录凭据。");
        }
        const me = await request(`${apiUrl}/auth/me`, { token: session.token });
        const identity = safeIdentity(me);
        signal?.throwIfAborted();
        const previous = await updateConfig(directory, (current) => ({
          ...current, apiUrl, apiKey: session.token,
          auth: { ...current.auth, apiKey: session.token },
          defaultOrg: me.defaultOrgId, defaultDrive: me.defaultDriveId,
          zionAccount: { runtimeUrl, apiUrl, expiresAt: session.expiresAt }
        }));
        saved = true;
        // Once saved, cancellation must not revoke the newly persisted session.
        const previousToken = credential(previous);
        const previousRuntime = previous.zionAccount?.runtimeUrl;
        if (accountToken(previousToken) && previousToken !== session.token
          && previousRuntime && previous.zionAccount.apiUrl === apiUrl) {
          await revoke(previousToken, previousRuntime).catch(() => {
            output({ type: "auth.warning", code: "previous_session_revocation_failed" },
              "提示：旧登录撤销失败，将在原有效期结束后过期。");
          });
        }
        output({ type: "auth.completed", authenticated: true, ...identity, apiUrl, expiresAt: session.expiresAt },
          `已登录：${identity.email || identity.userId}\n`
          + "凭据已自动保存。现在可运行 agent-fs ls /memory/dev.identity。");
        return 0;
      }
      throw new Error("登录链接已过期，请重新运行 agent-fs login。");
    } catch (error) {
      if (!saved && accountToken(session?.token)) {
        await revoke(session.token).catch(() => {});
      }
      throw error;
    }
  }

  if (options.action === "logout") {
    if (env.AGENT_FS_API_KEY !== undefined) {
      throw new Error("请先 unset AGENT_FS_API_KEY，再运行 agent-fs logout。");
    }
    await updateConfig(directory, async (current) => {
      const token = credential(current);
      if (accountToken(token)) {
        await revoke(token, current.zionAccount?.runtimeUrl || runtimeUrl);
      }
      const next = { ...current, auth: { ...current.auth } };
      delete next.apiKey;
      delete next.auth.apiKey;
      delete next.zionAccount;
      delete next.defaultOrg;
      delete next.defaultDrive;
      return next;
    });
    output({ type: "auth.logout", authenticated: false }, "已退出登录。");
    return 0;
  }

  const token = env.AGENT_FS_API_KEY ?? credential(config);
  const expired = env.AGENT_FS_API_KEY === undefined
    && config.zionAccount?.expiresAt <= now();
  const missing = () => {
    output({ authenticated: false, apiUrl }, "尚未登录或登录已过期。运行 agent-fs login。");
    return 1;
  };
  if (!token || expired) return missing();
  try {
    const me = await request(`${apiUrl}/auth/me`, { token });
    const identity = safeIdentity(me);
    output({ authenticated: true, ...identity, apiUrl,
      ...(env.AGENT_FS_API_KEY === undefined ? { expiresAt: config.zionAccount?.expiresAt } : {}) },
    `已登录：${identity.email || identity.userId}\nMemory：${apiUrl}`);
    return 0;
  } catch (error) {
    if (error.statusCode === 401) return missing();
    if (error.statusCode === 403) throw new Error("当前账户没有 Memory 访问权限。");
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    process.exitCode = await manageAgentfsAuth({ args: process.argv.slice(2), signal: controller.signal });
  } catch (error) {
    console.error(controller.signal.aborted ? "登录已取消。" : `错误：${error.message}`);
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
