import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { SignJWT } from "jose";
import pg from "pg";
import { createIdentityState } from "./identity-state.mjs";
import { identityStyles, identityScript } from "./identity-ui.mjs";

const { Pool } = pg;
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const token = (bytes = 32) => randomBytes(bytes).toString("base64url");
const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
const safeText = (value) => String(value || "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);
const loopback = (url) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

export function localDevSubject(email) {
  return `local:${hash(normalizeEmail(email))}`;
}

function passwordDigest(password, salt) {
  return scryptSync(String(password), salt, 32).toString("hex");
}

async function initializeLocalIdentitySchema(database) {
  await database.query(`
    CREATE TABLE IF NOT EXISTS local_identity_users (
      subject TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      salt TEXT NOT NULL, password_hash TEXT NOT NULL, verified BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_identity_codes (
      email TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL,
      expires_at BIGINT NOT NULL, PRIMARY KEY(email, purpose)
    );
    CREATE TABLE IF NOT EXISTS local_identity_social_accounts (
      provider TEXT NOT NULL, provider_id TEXT NOT NULL,
      subject TEXT NOT NULL REFERENCES local_identity_users(subject),
      PRIMARY KEY(provider, provider_id), UNIQUE(provider, subject)
    );
  `);
}

export async function seedLocalIdentityUser({
  databaseUrl,
  pool = null,
  email,
  name = "",
  password,
  verified = true,
  now = () => Date.now()
} = {}) {
  const normalizedEmail = normalizeEmail(email);
  const displayName = String(name || normalizedEmail.split("@")[0] || "zion").trim();
  const secret = String(password || "");
  if (!pool && !String(databaseUrl || "").trim()) {
    throw new Error("Local identity user seed requires PostgreSQL");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error("Local identity user seed requires a valid email");
  }
  if (displayName.length < 1 || displayName.length > 100) {
    throw new Error("Local identity user seed requires a valid display name");
  }
  if (secret.length < 10 || secret.length > 256) {
    throw new Error("Local identity user seed requires a password between 10 and 256 characters");
  }
  const database = pool || new Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    application_name: "zion-local-identity-seed"
  });
  const ownsPool = !pool;
  try {
    await initializeLocalIdentitySchema(database);
    const salt = token(18);
    const subject = localDevSubject(normalizedEmail);
    const result = await database.query(
      `INSERT INTO local_identity_users
       (subject, email, name, salt, password_hash, verified, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (email) DO UPDATE SET
         name = EXCLUDED.name,
         salt = EXCLUDED.salt,
         password_hash = EXCLUDED.password_hash,
         verified = EXCLUDED.verified
       RETURNING subject, email, name, verified, created_at`,
      [
        subject,
        normalizedEmail,
        displayName,
        salt,
        passwordDigest(secret, salt),
        Boolean(verified),
        now()
      ]
    );
    await database.query(
      "DELETE FROM local_identity_codes WHERE email = $1",
      [normalizedEmail]
    );
    const row = result.rows[0];
    return {
      subject: row.subject,
      email: row.email,
      name: row.name,
      verified: row.verified === true,
      createdAt: Number(row.created_at)
    };
  } finally {
    if (ownsPool) await database.end();
  }
}

const brandMark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" aria-hidden="true">
  <rect width="32" height="32" rx="7" fill="#171a1d"/>
  <path d="M8.5 9.5h15" stroke="#f4f6f8" stroke-width="3.25" stroke-linecap="round"/>
  <path d="m23.5 9.5-15 13" stroke="#67d3b5" stroke-width="3.25" stroke-linecap="round"/>
  <path d="M8.5 22.5h15" stroke="#f4f6f8" stroke-width="3.25" stroke-linecap="round"/>
</svg>`;
const uiTheme = (value) => ["light", "dark"].includes(String(value || ""))
  ? String(value)
  : "";

function page(title, content, {
  returnHref = "",
  context = "完成后返回 Zion",
  theme = ""
} = {}) {
  const selectedTheme = uiTheme(theme);
  return `<!doctype html><html lang="zh-CN"${selectedTheme
    ? ` data-theme="${selectedTheme}"`
    : ""}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeText(title)} · Zion 账号</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=3"><style>
*{box-sizing:border-box;letter-spacing:0}
:root{color-scheme:light;--bg:#f5f6f9;--panel:#fff;--field:#fff;--field-muted:#f0f2f6;--text:#1a1e28;--muted:#687082;--faint:#8b93a3;--line:#dfe3eb;--line-strong:#c5cbd6;--accent:#5b7ff5;--accent-hover:#4a6ee2;--accent-soft:rgba(91,127,245,.14);--danger:#c64550;--danger-soft:#faecee;--ok:#3a9b78}
:root[data-theme="dark"]{color-scheme:dark;--bg:#1e1e2e;--panel:#222233;--field:#262638;--field-muted:#2d2d40;--text:#e6e8ef;--muted:#a3a8b7;--faint:#777f92;--line:#34364a;--line-strong:#4a4d64;--accent:#7d91d3;--accent-hover:#8fa2df;--accent-soft:rgba(125,145,211,.16);--danger:#e06b73;--danger-soft:#3b242b;--ok:#67c5a3}
body{min-width:320px;min-height:100vh;margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI Variable","Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.product-bar{height:42px;display:flex;align-items:center;padding:0 14px;border-bottom:1px solid var(--line);background:var(--panel)}
.brand{display:inline-flex;align-items:center;gap:8px;color:var(--text)}.brand-mark{width:22px;height:22px;display:block;flex:0 0 22px}.brand-mark svg{width:100%;height:100%;display:block}.brand strong{font-size:12.5px;font-weight:650}.environment{margin-left:auto;display:inline-flex;align-items:center;gap:6px;color:var(--faint);font-size:11px}.environment::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 2px color-mix(in srgb,var(--ok) 14%,transparent)}
.auth-shell{min-height:calc(100vh - 42px);display:grid;place-items:center;padding:40px 20px 8vh}.auth-panel{width:min(364px,100%)}
.auth-context{display:flex;align-items:center;gap:7px;margin-bottom:14px;color:var(--faint);font-size:11px;font-weight:550}.status-dot{width:6px;height:6px;border-radius:50%;background:var(--ok)}
h1{margin:0;color:var(--text);font-size:24px;line-height:1.25;font-weight:650}p{margin:8px 0 0;color:var(--muted);line-height:1.65}
form{display:grid;gap:15px;margin:26px 0 18px}label{display:grid;gap:7px;color:var(--text);font-size:12px;font-weight:600}
input{width:100%;min-width:0;height:40px;padding:0 11px;border:1px solid var(--line-strong);border-radius:5px;background:var(--field);color:var(--text);font:inherit;outline:none;transition:border-color 120ms ease,box-shadow 120ms ease,background-color 120ms ease}
input:hover{border-color:color-mix(in srgb,var(--line-strong) 62%,var(--text))}input:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}input[readonly]{background:var(--field-muted);color:var(--muted)}
button,.button{min-height:40px;display:inline-flex;align-items:center;justify-content:center;padding:0 14px;border:1px solid var(--accent);border-radius:5px;background:var(--accent);color:#fff;font:inherit;font-weight:650;text-decoration:none;cursor:pointer;transition:background-color 120ms ease,border-color 120ms ease}
button:hover,.button:hover{border-color:var(--accent-hover);background:var(--accent-hover)}button:focus-visible,.button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
form>button{width:100%;margin-top:3px}.auth-panel>.button{width:100%;margin-top:24px}.actions{display:flex;align-items:center;justify-content:space-between;gap:18px}.actions a,.text-link,.return-link{color:var(--accent);font-size:12px;text-decoration:none}.actions a:hover,.text-link:hover,.return-link:hover{text-decoration:underline}
.notice,.error{margin:18px 0 0;padding:10px 11px;border:1px solid var(--line);border-radius:5px;font-size:12px}.notice{border-color:color-mix(in srgb,var(--ok) 36%,var(--line));background:color-mix(in srgb,var(--ok) 10%,transparent);color:color-mix(in srgb,var(--ok) 78%,var(--text))}.error{border-color:color-mix(in srgb,var(--danger) 38%,var(--line));background:var(--danger-soft);color:var(--danger)}
code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:20px;font-weight:700;color:var(--text)}
footer{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:28px;padding-top:17px;border-top:1px solid var(--line);color:var(--faint);font-size:11px}.return-link{flex:0 0 auto}
.social{width:100%;gap:9px;margin-top:24px;background:var(--field);border-color:var(--line-strong);color:var(--text)}.social:hover{background:var(--field-muted);border-color:var(--line-strong)}.divider{display:flex;align-items:center;gap:12px;margin-top:20px;color:var(--faint);font-size:12px}.divider:before,.divider:after{content:"";height:1px;flex:1;background:var(--line)}.hint{font-size:12px;color:var(--muted);font-weight:400}button:disabled{opacity:.55;cursor:wait}
@media(max-width:440px){.product-bar{padding:0 12px}.auth-shell{place-items:start center;padding:34px 20px}.actions{justify-content:space-between}footer{align-items:flex-start;flex-direction:column;gap:9px}}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#1e1e2e;--panel:#222233;--field:#262638;--field-muted:#2d2d40;--text:#e6e8ef;--muted:#a3a8b7;--faint:#777f92;--line:#34364a;--line-strong:#4a4d64;--accent:#7d91d3;--accent-hover:#8fa2df;--accent-soft:rgba(125,145,211,.16);--danger:#e06b73;--danger-soft:#3b242b;--ok:#67c5a3}}
${identityStyles}
</style><script defer src="ui.js"></script></head><body><header class="product-bar"><span class="brand">
<span class="brand-mark">${brandMark}</span><strong>Zion</strong></span>
<span class="environment">账号登录</span></header><main class="auth-shell"><section class="auth-panel">
<div class="auth-context"><span class="status-dot" aria-hidden="true"></span><span>${safeText(context)}</span></div>
${content}<footer><span>Zion 账号</span>
${returnHref ? `<a class="return-link" href="${safeText(returnHref)}">取消并返回 Zion</a>` : ""}
</footer></section></main></body></html>`;
}

async function formBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw Object.assign(new Error("request_too_large"), { status: 413 });
  }
  return new URLSearchParams(raw);
}

function cookie(headers, name) {
  const match = String(headers.cookie || "").split(";").map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
}

export async function createLocalDevOidc({
  databaseUrl, pool = null, host = "127.0.0.1", port = 18080,
  runtimeOrigin = "http://127.0.0.1:18866", clientId = "zion-local",
  publicIssuer = "", sendMail = null, github = null,
  development = !publicIssuer, fetchImpl = fetch
} = {}) {
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("Local development identity provider must bind to loopback");
  }
  if (!pool && !String(databaseUrl || "").trim()) {
    throw new Error("Local development identity provider requires PostgreSQL");
  }
  const bindOrigin = `http://${host === "::1" ? `[${host}]` : host}:${port}`;
  const bindUrl = new URL(bindOrigin);
  const issuer = String(publicIssuer || bindOrigin).replace(/\/+$/, "");
  const issuerUrl = new URL(issuer);
  if (github && (!github.clientId || !github.clientSecret)) throw new Error("GitHub login requires client ID and secret");
  if (issuerUrl.protocol !== "https:" && !(issuerUrl.protocol === "http:" && loopback(issuerUrl))) {
    throw new Error("Local identity public issuer requires HTTPS or loopback HTTP");
  }
  const cookiePath = issuerUrl.pathname === "/"
    ? "/"
    : issuerUrl.pathname.replace(/\/+$/, "");
  const runtimeUrl = new URL(runtimeOrigin);
  if (!["http:", "https:"].includes(runtimeUrl.protocol)
    || runtimeUrl.username || runtimeUrl.password) {
    throw new Error("Local development identity provider requires a valid Runtime origin");
  }
  const runtimeBaseUrl = runtimeUrl.origin;
  const callbackUrl = `${runtimeBaseUrl}/v1/account/callback`;
  const cancelUrl = `${runtimeBaseUrl}/account?zionAuth=cancelled`;
  const renderPage = (title, content, options = {}) =>
    page(title, content, { returnHref: cancelUrl, ...options })
      .replace('src="ui.js"', `src="${safeText(issuer)}/ui.js"`);
  const database = pool || new Pool({
    connectionString: databaseUrl,
    max: 4,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    application_name: "zion-local-identity"
  });
  const ownsPool = !pool;
  await initializeLocalIdentitySchema(database);
  const { store, privateKey, publicJwk } = await createIdentityState(database);
  const sessions = store("session");
  const authorizationTransactions = store("authorization");
  const authorizationCodes = store("code");
  const deviceFlows = store("device");
  const githubFlows = store("github");
  const sessionCookie = "zion_local_identity";
  const now = () => Date.now();
  const cleanup = async () => {
    await database.query("DELETE FROM local_identity_state WHERE expires_at <= $1", [now()]);
    await database.query(
      "DELETE FROM local_identity_codes WHERE expires_at <= $1",
      [now()]
    );
  };
  const userByEmail = async (email) => (await database.query(
    "SELECT * FROM local_identity_users WHERE email = $1",
    [normalizeEmail(email)]
  )).rows[0] || null;
  const userBySubject = async (subject) => (await database.query(
    "SELECT * FROM local_identity_users WHERE subject = $1",
    [subject]
  )).rows[0] || null;
  const currentUser = async (request) => {
    await cleanup();
    const session = await sessions.get(hash(cookie(request.headers, sessionCookie)));
    return session && session.expiresAt > now()
      ? userBySubject(session.subject)
      : null;
  };
  const createSession = async (subject) => {
    const value = token();
    await sessions.set(hash(value), { subject, expiresAt: now() + 7 * 24 * 60 * 60_000 });
    return `${sessionCookie}=${value}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=604800${issuerUrl.protocol === "https:" ? "; Secure" : ""}`;
  };
  const html = (response, status, body, headers = {}) => {
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "referrer-policy": "same-origin",
      "content-security-policy": `default-src 'self'; style-src 'unsafe-inline'; form-action 'self' https://github.com ${runtimeBaseUrl}; frame-ancestors 'none'`,
      "x-content-type-options": "nosniff", ...headers
    });
    response.end(body);
  };
  const json = (response, status, value) => {
    response.writeHead(status, {
      "content-type": "application/json", "cache-control": "no-store",
      pragma: "no-cache", "x-content-type-options": "nosniff"
    });
    response.end(JSON.stringify(value));
  };
  const svg = (response, body) => {
    response.writeHead(200, {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff"
    });
    response.end(body);
  };
  const redirect = (response, location, headers = {}) => {
    response.writeHead(303, { location, "cache-control": "no-store", ...headers });
    response.end();
  };
  const destination = ({ tx = "", device = "" } = {}) =>
    tx ? contextHref("/authorize/complete", { tx })
      : device ? contextHref("/activate", { user_code: device })
        : `${runtimeBaseUrl}/v1/account/login?returnTo=/account`;
  const contextHref = (path, context = {}) => {
    const query = new URLSearchParams(
      Object.entries(context).filter(([, value]) => Boolean(value))
    ).toString();
    return query ? `${issuer}${path}?${query}` : `${issuer}${path}`;
  };
  const contextLabel = ({ device = "" } = {}) =>
    device ? "登录后返回终端继续" : "登录后自动返回 Zion";
  const authFields = ({ tx = "", device = "", theme = "", settings = "" } = {}) =>
    `<input type="hidden" name="tx" value="${safeText(tx)}">
     <input type="hidden" name="device" value="${safeText(device)}">
     <input type="hidden" name="settings" value="${settings === "1" ? "1" : ""}">
     <input type="hidden" name="theme" value="${safeText(uiTheme(theme))}">`;
  const authContext = async (params) => {
    const tx = String(params.get("tx") || "");
    return {
      tx,
      device: String(params.get("device") || ""),
      settings: params.get("settings") === "1" ? "1" : "",
      theme: uiTheme(params.get("theme") || (await authorizationTransactions.get(tx))?.uiTheme)
    };
  };
  const deviceCodePage = (userCode = "", error = "") => renderPage("设备登录",
    `<h1>连接 Zion CLI</h1><p>输入终端中 Code 后面的确认码，继续登录。</p>
    ${error ? `<p class="error" role="alert">${safeText(error)}</p>` : ""}
    <form method="get" action="${safeText(contextHref("/activate"))}">
      <label>设备确认码<input name="user_code" value="${safeText(userCode)}"
        autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="32" required autofocus></label>
      <button type="submit">继续登录</button>
    </form><p>保持登录命令运行；确认码有效期为 10 分钟。</p>`,
    { context: "Zion CLI 身份验证" });
  const loginPage = (context = {}, error = "") => renderPage("登录",
    `<h1>登录 Zion</h1><p>${context.device
      ? "验证账号后，允许当前 CLI 使用你的身份。"
      : github ? "使用 GitHub 或邮箱登录，继续进入工作台。" : "使用邮箱登录，继续进入工作台。"}</p>
    ${error ? `<p class="error" role="alert">${safeText(error)}</p>` : ""}
    ${socialButton(context)}
    <form method="post" action="${safeText(contextHref("/login"))}">${authFields(context)}
      <label>邮箱<input name="email" type="email" autocomplete="username" required autofocus></label>
      <label>密码<input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">登录</button>
    </form><div class="actions">
      ${sendMail || development ? `<a href="${safeText(contextHref("/register", context))}">邮箱注册</a>
      <a href="${safeText(contextHref("/forgot", context))}">忘记密码</a>` : ""}
    </div>`, { context: contextLabel(context), theme: context.theme });
  const registrationPage = (context = {}, error = "", email = "", emailLocked = false) => renderPage("注册",
    `<h1>创建 Zion 账号</h1><p>使用邮箱注册，验证后即可进入 Zion。</p>
    ${error ? `<p class="error" role="alert">${safeText(error)}</p>` : ""}
    ${socialButton(context)}
    <form method="post" action="${safeText(contextHref("/register"))}">${authFields(context)}
      <label>姓名<input name="name" autocomplete="name" required maxlength="100"></label>
      <label>邮箱<input name="email" type="email" autocomplete="email" required value="${safeText(email)}"
        ${emailLocked ? "readonly" : ""}></label>
      <label>密码<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required><span class="hint">使用至少 12 个字符。</span></label>
      <button type="submit">注册并验证邮箱</button>
    </form><a class="text-link" href="${safeText(contextHref("/login", context))}">已有账号，返回登录</a>`,
    { context: contextLabel(context), theme: context.theme });
  const verificationPage = ({
    email, tx = "", device = "", theme = "", code = "", error = ""
  }) => renderPage("验证邮箱",
    `<h1>验证邮箱</h1><p>验证码已发送至 ${safeText(maskEmail(email))}，10 分钟内有效。</p>
    ${development && code ? `<p class="notice">本地验证码：<code>${safeText(code)}</code></p>` : ""}
    ${error ? `<p class="error" role="alert">${safeText(error)}</p>` : ""}
    <form method="post" action="${safeText(contextHref("/verify"))}">${authFields({ tx, device, theme })}
      <input type="hidden" name="email" value="${safeText(email)}">
      <label>验证码<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label>
      <button type="submit">完成验证</button>
    </form><p class="hint">未收到邮件？请检查垃圾邮件文件夹。</p>
    <form method="post" action="${safeText(contextHref("/resend"))}">${authFields({ tx, device, theme })}
      <input type="hidden" name="email" value="${safeText(email)}"><button class="social" type="submit" data-cooldown="${code ? "60" : "0"}">重新发送验证码</button>
    </form><a class="text-link" href="${safeText(contextHref("/login", { tx, device, theme }))}">返回登录</a>`, { context: contextLabel({ device }), theme });
  const verifiedPage = (context = {}) => renderPage("验证完成",
    `<h1>邮箱验证完成</h1><p>账号已创建，可以继续进入 Zion。</p>
    <a class="button" href="${safeText(destination(context))}">进入 Zion</a>`,
    { context: contextLabel(context), theme: context.theme });
  const alreadyVerifiedPage = (context = {}) => renderPage("邮箱已验证",
    `<h1>邮箱已经验证</h1><p>请登录刚创建的账号，然后继续进入 Zion。</p>
    <a class="button" href="${safeText(contextHref("/login", context))}">返回登录</a>`,
    { context: contextLabel(context), theme: context.theme });
  const signTokens = async (user, { nonce = "" } = {}) => ({
    access_token: token(), token_type: "Bearer", expires_in: 300,
    id_token: await new SignJWT({
      name: user.name, email: user.email, email_verified: Boolean(user.verified),
      ...(nonce ? { nonce } : {})
    }).setProtectedHeader({ alg: "RS256", kid: publicJwk.kid, typ: "JWT" })
      .setIssuer(issuer).setSubject(user.subject).setAudience(clientId)
      .setIssuedAt().setExpirationTime("5m").sign(privateKey)
  });
  const completeAuthorization = async (response, tx, user, headers = {}) => {
    const transaction = await authorizationTransactions.take(tx);
    if (!transaction || transaction.expiresAt <= now()) {
      return html(response, 400, renderPage(
        "请求已失效",
        "<h1>登录请求已失效</h1><p>请返回 Zion 重新登录。</p>"
      ));
    }
    const code = token();
    await authorizationCodes.set(hash(code), {
      ...transaction, subject: user.subject, expiresAt: now() + 60_000
    });
    const callback = new URL(transaction.redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", transaction.state);
    redirect(response, callback.href, headers);
  };
  const approveDevice = async (response, userCode, user, headers = {}) => {
    const flow = (await deviceFlows.values()).find((value) => value.userCode === userCode);
    if (!flow || flow.expiresAt <= now()) {
      return html(response, 400, renderPage(
        "设备登录失效",
        "<h1>设备登录已失效</h1><p>请在 CLI 重新开始登录。</p>",
        { context: "Zion CLI 身份验证" }
      ));
    }
    flow.subject = user.subject;
    flow.status = "approved";
    await deviceFlows.set(flow.key, flow);
    html(response, 200, renderPage(
      "设备已授权",
      "<h1>设备已授权</h1><p>可以关闭此页面并返回终端。</p>",
      { context: "Zion CLI 身份验证" }
    ), headers);
  };

  const maskEmail = email => email.replace(/^(.).+(@.+)$/, "$1***$2");
  const socialButton = context => github ? `<form method="post" action="${safeText(contextHref("/github"))}">${authFields(context)}
    <button class="social" type="submit"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.86c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.95 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03A9.6 9.6 0 0 1 12 6.82c.85 0 1.71.11 2.51.34 1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.85-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>使用 GitHub 继续</button>
    </form><div class="divider">或使用邮箱</div>` : "";
  const issueCode = async (email, purpose) => {
    const code = String(randomInt(100000, 1000000));
    await database.query(
      `INSERT INTO local_identity_codes (email, purpose, code_hash, expires_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT (email, purpose) DO UPDATE
       SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at`,
      [email, purpose, hash(code), now() + 10 * 60_000]
    );
    if (sendMail) {
      await sendMail({
        to: email, subject: purpose === "verify" ? "验证你的 Zion 邮箱" : "重置你的 Zion 密码",
        text: `你的${purpose === "verify" ? "邮箱验证" : "密码重置"}验证码是：${code}\n\n10 分钟内有效。如果不是你本人操作，请忽略此邮件。`
      });
    }
    return code;
  };
  const consumeCode = async (email, purpose, code) => (await database.query(
    `DELETE FROM local_identity_codes WHERE email = $1 AND purpose = $2
     AND code_hash = $3 AND expires_at > $4 RETURNING email`,
    [email, purpose, hash(code), now()]
  )).rowCount > 0;
  const rateLimit = async (key, max = 10, window = 60_000) => {
    const result = await database.query(
      `INSERT INTO local_identity_state (namespace, key, value, expires_at)
       VALUES ('limits', $1, '{"count":1}', $2)
       ON CONFLICT (namespace, key) DO UPDATE SET
         value = jsonb_build_object('count', CASE WHEN local_identity_state.expires_at <= $3 THEN 1
           ELSE (local_identity_state.value->>'count')::int + 1 END),
         expires_at = CASE WHEN local_identity_state.expires_at <= $3 THEN $2 ELSE local_identity_state.expires_at END
       RETURNING (value->>'count')::int AS count`,
      [hash(key), now() + window, now()]
    );
    if (result.rows[0].count > max) throw Object.assign(new Error("操作过于频繁，请稍后重试。"), { status: 429 });
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, issuer);
    try {
      const requestHost = String(request.headers.host || "").toLowerCase();
      const canonicalHost = new URL(issuer).host.toLowerCase();
      if (requestHost && requestHost !== canonicalHost && requestHost !== bindUrl.host.toLowerCase()) {
        response.writeHead(307, {
          location: `${issuer}${url.pathname}${url.search}`,
          "cache-control": "no-store"
        });
        response.end();
        return;
      }
      if (request.method === "POST" && !["/token", "/device"].includes(url.pathname)) {
        const origin = request.headers.origin;
        if ((origin && origin !== issuerUrl.origin && origin !== bindOrigin)
          || request.headers["sec-fetch-site"] === "cross-site") {
          throw Object.assign(new Error("请从 Zion 登录页重新操作。"), { status: 403 });
        }
        await rateLimit(`${request.socket.remoteAddress}:${url.pathname}`);
      }
      if (request.method === "GET" && url.pathname === "/config") {
        json(response, 200, {
          registrationEnabled: !!sendMail || development,
          passwordResetEnabled: !!sendMail || development,
          requireEmailVerification: true, githubEnabled: !!github
        });
      } else if (request.method === "POST" && url.pathname === "/github") {
        if (!github) throw Object.assign(new Error("GitHub 登录暂未配置。"), { status: 503 });
        const context = await authContext(await formBody(request));
        const linkingUser = context.settings ? await currentUser(request) : null;
        if (context.settings && !linkingUser) return redirect(response, contextHref("/login", { settings: "1" }));
        const state = `zion_${token()}`;
        const browser = token();
        await githubFlows.set(hash(state), { context, subject: linkingUser?.subject || "", browser: hash(browser), expiresAt: now() + 10 * 60_000 });
        const target = new URL("https://github.com/login/oauth/authorize");
        target.search = new URLSearchParams({
          client_id: github.clientId, redirect_uri: github.callbackUrl || `${issuer}/github/callback`,
          scope: "read:user user:email", state
        }).toString();
        redirect(response, target.href, {
          "set-cookie": `zion_github=${browser}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=600${issuerUrl.protocol === "https:" ? "; Secure" : ""}`
        });
      } else if (request.method === "GET" && url.pathname === "/github/callback") {
        const flow = await githubFlows.take(hash(url.searchParams.get("state") || ""));
        if (!github || !flow || flow.browser !== hash(cookie(request.headers, "zion_github"))) {
          return html(response, 400, loginPage({}, "GitHub 登录请求已失效，请重新登录。"));
        }
        const context = flow.context;
        const githubFailure = (message, status = 400) => html(response, status, renderPage(
          context.settings ? "无法关联 GitHub" : "GitHub 登录未完成",
          `<h1>${context.settings ? "无法关联 GitHub" : "登录未完成"}</h1><p class="error" role="alert">${safeText(message)}</p>
           <a class="button" href="${safeText(contextHref(context.settings ? "/settings" : "/login", context))}">${context.settings ? "返回登录方式" : "返回登录"}</a>`,
          { theme: context.theme }
        ));
        if (url.searchParams.has("error") || !url.searchParams.get("code")) {
          return githubFailure("你尚未完成 GitHub 授权，可以返回后重试。");
        }
        let exchange;
        try {
          exchange = await fetchImpl("https://github.com/login/oauth/access_token", {
          method: "POST", signal: AbortSignal.timeout(15_000),
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({
            client_id: github.clientId, client_secret: github.clientSecret,
            code: url.searchParams.get("code"), redirect_uri: github.callbackUrl || `${issuer}/github/callback`
          })
          });
        } catch (error) {
          console.error(JSON.stringify({ event: "identity.github.exchange_failed", error: error.name, code: error.cause?.code || "" }));
          return githubFailure("GitHub 暂时没有响应，请稍后重试。你的账号关联未发生变化。", 503);
        }
        const credentials = await exchange.json();
        if (!exchange.ok || !credentials.access_token) return githubFailure("GitHub 授权已失效，请返回后重新授权。");
        const githubRequest = async path => {
          const result = await fetchImpl(`https://api.github.com${path}`, {
            signal: AbortSignal.timeout(15_000),
            headers: { accept: "application/vnd.github+json", authorization: `Bearer ${credentials.access_token}`, "user-agent": "Zion" }
          });
          if (!result.ok) throw new Error("GitHub unavailable");
          return result.json();
        };
        let profile, emails;
        try {
          [profile, emails] = await Promise.all([githubRequest("/user"), githubRequest("/user/emails")]);
        } catch (error) {
          console.error(JSON.stringify({ event: "identity.github.profile_failed", error: error.name, code: error.cause?.code || "" }));
          return githubFailure("暂时无法读取 GitHub 账号，请稍后重试。", 503);
        }
        const email = normalizeEmail(emails.find(item => item.primary && item.verified)?.email
          || emails.find(item => item.verified)?.email);
        if (!profile.id || !email) return githubFailure("请先在 GitHub 验证邮箱，再尝试关联或登录。");
        const linked = (await database.query(
          "SELECT subject FROM local_identity_social_accounts WHERE provider = 'github' AND provider_id = $1",
          [String(profile.id)]
        )).rows[0];
        let user = linked ? await userBySubject(linked.subject) : await userByEmail(email);
        if (context.settings) {
          const current = await currentUser(request);
          if (!current || current.subject !== flow.subject) return githubFailure("登录状态已变化，请重新登录后关联。", 401);
          if (linked && linked.subject !== current.subject) return githubFailure("这个 GitHub 账号已关联其他 Zion 账号。", 409);
          if (!linked && current.email !== email) return githubFailure("GitHub 的已验证邮箱需要与当前 Zion 邮箱一致。请检查 GitHub 邮箱设置。", 409);
          user = current;
        }
        if (!linked && user) {
          const current = await currentUser(request);
          if (!current || current.subject !== user.subject || !user.verified) {
            return githubFailure("该邮箱已有 Zion 账号。请先使用邮箱登录，再从账号设置关联 GitHub。", 409);
          }
        }
        if (!user) {
          const salt = token(18);
          const created = await database.query(
            `INSERT INTO local_identity_users (subject,email,name,salt,password_hash,verified,created_at)
             VALUES ($1,$2,$3,$4,$5,TRUE,$6) ON CONFLICT (email) DO NOTHING RETURNING subject`,
            [localDevSubject(email), email, String(profile.name || profile.login).slice(0, 100), salt, passwordDigest(token(64), salt), now()]
          );
          // A competing email registration must not be silently linked.
          user = await userByEmail(email);
          if (!created.rowCount) return html(response, 409, loginPage(context, "该邮箱已有账号，请先完成邮箱登录。"));
        }
        if (!linked) {
          await database.query(
            `INSERT INTO local_identity_social_accounts VALUES ('github',$1,$2) ON CONFLICT DO NOTHING`,
            [String(profile.id), user.subject]
          );
          const binding = (await database.query(
            "SELECT subject FROM local_identity_social_accounts WHERE provider = 'github' AND provider_id = $1",
            [String(profile.id)]
          )).rows[0];
          if (binding?.subject !== user.subject) return html(response, 409, loginPage(context, "GitHub 已关联其他账号。"));
        }
        const headers = { "set-cookie": [
          await createSession(user.subject),
          `zion_github=; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=0${issuerUrl.protocol === "https:" ? "; Secure" : ""}`
        ] };
        if (context.settings) return redirect(response, contextHref("/settings", { linked: "1" }), headers);
        if (context.tx) return await completeAuthorization(response, context.tx, user, headers);
        if (context.device) return await approveDevice(response, context.device, user, headers);
        redirect(response, destination(context), headers);
      } else if (request.method === "GET" && url.pathname === "/ui.js") {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
        response.end(identityScript);
      } else if (request.method === "GET" && url.pathname === "/favicon.svg") {
        svg(response, brandMark);
      } else if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
        json(response, 200, {
          issuer, authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
          device_authorization_endpoint: `${issuer}/device`,
          response_types_supported: ["code"], subject_types_supported: ["public"],
          grant_types_supported: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"], scopes_supported: ["openid", "profile", "email"]
        });
      } else if (request.method === "GET" && url.pathname === "/jwks") {
        json(response, 200, { keys: [publicJwk] });
      } else if (request.method === "GET" && url.pathname === "/authorize") {
        if (url.searchParams.get("client_id") !== clientId
          || url.searchParams.get("redirect_uri") !== callbackUrl
          || url.searchParams.get("response_type") !== "code"
          || url.searchParams.get("code_challenge_method") !== "S256"
          || !url.searchParams.get("code_challenge")
          || !String(url.searchParams.get("scope") || "").split(" ").includes("openid")) {
          return html(response, 400, renderPage(
            "请求无效",
            "<h1>登录请求无效</h1><p>请返回 Zion 后重新发起登录。</p>"
          ));
        }
        const tx = token(18);
        const theme = uiTheme(url.searchParams.get("zion_ui_theme"));
        await authorizationTransactions.set(tx, {
          clientId, redirectUri: callbackUrl, state: url.searchParams.get("state"),
          nonce: url.searchParams.get("nonce"), challenge: url.searchParams.get("code_challenge"),
          uiTheme: theme,
          expiresAt: now() + 5 * 60_000
        });
        const user = await currentUser(request);
        if (user) return await completeAuthorization(response, tx, user);
        html(response, 200, loginPage({ tx, theme }));
      } else if (request.method === "GET" && url.pathname === "/authorize/complete") {
        const user = await currentUser(request);
        const tx = url.searchParams.get("tx") || "";
        if (!user) return redirect(response, contextHref("/login", {
          tx,
          theme: (await authorizationTransactions.get(tx))?.uiTheme
        }));
        await completeAuthorization(response, tx, user);
      } else if (request.method === "GET" && url.pathname === "/login") {
        html(response, 200, loginPage(await authContext(url.searchParams)));
      } else if (request.method === "POST" && url.pathname === "/login") {
        const body = await formBody(request);
        const context = await authContext(body);
        const email = normalizeEmail(body.get("email"));
        const user = await userByEmail(email);
        const password = String(body.get("password") || "");
        if (password.length > 256) return html(response, 401, loginPage(context, "邮箱或密码不正确。"));
        const expected = user ? Buffer.from(user.password_hash, "hex") : Buffer.alloc(32);
        const actual = passwordDigest(password, user?.salt || "invalid-local-login");
        if (!user || !timingSafeEqual(expected, Buffer.from(actual, "hex"))) {
          return html(response, 401, loginPage(context, "邮箱或密码不正确。"));
        }
        if (!user.verified) {
          return html(response, 403, verificationPage({
            email, ...context,
            error: "请先完成邮箱验证。"
          }));
        }
        const headers = { "set-cookie": await createSession(user.subject) };
        if (context.settings) return redirect(response, contextHref("/settings"), headers);
        if (context.tx) return await completeAuthorization(response, context.tx, user, headers);
        if (context.device) return await approveDevice(response, context.device, user, headers);
        redirect(response, destination(), headers);
      } else if (request.method === "GET" && url.pathname === "/register") {
        if (!sendMail && !development) return html(response, 503, loginPage({}, "邮箱注册暂未开放，请使用已有账号登录。"));
        html(response, 200, registrationPage(
          await authContext(url.searchParams),
          "",
          url.searchParams.get("email") || "",
          url.searchParams.get("lock_email") === "1"
        ));
      } else if (request.method === "POST" && url.pathname === "/register") {
        if (!sendMail && !development) throw Object.assign(new Error("邮箱投递暂不可用，请稍后重试。"), { status: 503 });
        const body = await formBody(request);
        const email = normalizeEmail(body.get("email"));
        const name = String(body.get("name") || "").trim();
        const password = String(body.get("password") || "");
        const context = await authContext(body);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || name.length < 1 || name.length > 100
          || password.length < 12 || password.length > 128) {
          return html(response, 400, registrationPage(context, "请填写有效的姓名、邮箱和 12 至 128 位密码。", email));
        }
        if (await userByEmail(email)) {
          return html(response, 409, registrationPage(context, "该邮箱已经注册。", email));
        }
        const salt = token(18);
        await database.query(
          `INSERT INTO local_identity_users
           (subject, email, name, salt, password_hash, verified, created_at)
           VALUES ($1, $2, $3, $4, $5, FALSE, $6)`,
          [localDevSubject(email), email, name, salt, passwordDigest(password, salt), now()]
        );
        const code = await issueCode(email, "verify");
        html(response, 201, verificationPage({ email, ...context, code }));
      } else if (request.method === "POST" && url.pathname === "/resend") {
        if (!sendMail && !development) throw Object.assign(new Error("邮箱投递暂不可用。"), { status: 503 });
        const body = await formBody(request);
        const email = normalizeEmail(body.get("email"));
        const context = await authContext(body);
        await rateLimit(`resend:${email}`, 1, 60_000);
        const user = await userByEmail(email);
        const code = user && !user.verified ? await issueCode(email, "verify") : "";
        html(response, 200, verificationPage({ email, ...context, code }));
      } else if (request.method === "POST" && url.pathname === "/verify") {
        const body = await formBody(request);
        const context = await authContext(body);
        const email = normalizeEmail(body.get("email"));
        await rateLimit(`verify:${email}`, 5, 10 * 60_000);
        if (!await consumeCode(email, "verify", body.get("code"))) {
          const authenticated = await currentUser(request);
          if (authenticated?.email === email && authenticated.verified) {
            return html(response, 200, verifiedPage(context));
          }
          if ((await userByEmail(email))?.verified) {
            return html(response, 200, alreadyVerifiedPage(context));
          }
          return html(response, 400, verificationPage({
            email, ...context,
            error: "验证码不正确或已过期。"
          }));
        }
        await database.query(
          "UPDATE local_identity_users SET verified = TRUE WHERE email = $1",
          [email]
        );
        const user = await userByEmail(email);
        const headers = { "set-cookie": await createSession(user.subject) };
        if (context.device) return await approveDevice(response, context.device, user, headers);
        html(response, 200, verifiedPage(context), headers);
      } else if (request.method === "GET" && url.pathname === "/forgot") {
        if (!sendMail && !development) throw Object.assign(new Error("邮箱投递暂不可用。"), { status: 503 });
        const context = await authContext(url.searchParams);
        html(response, 200, renderPage("找回密码", `<h1>重置密码</h1>
          <p>输入注册邮箱，我们会发送密码重置验证码。</p>
          <form method="post" action="${safeText(contextHref("/forgot"))}">${authFields(context)}
          <label>注册邮箱<input name="email" type="email" required autofocus></label>
          <button type="submit">获取验证码</button></form>
          <a class="text-link" href="${safeText(contextHref("/login", context))}">返回登录</a>`,
        { context: contextLabel(context), theme: context.theme }));
      } else if (request.method === "POST" && url.pathname === "/forgot") {
        if (!sendMail && !development) throw Object.assign(new Error("邮箱投递暂不可用。"), { status: 503 });
        const body = await formBody(request);
        const email = normalizeEmail(body.get("email"));
        const context = await authContext(body);
        await rateLimit(`forgot:${email}`, 3, 10 * 60_000);
        const code = (await userByEmail(email)) ? await issueCode(email, "reset") : String(randomInt(100000, 1000000));
        html(response, 200, renderPage("重置密码", `<h1>验证并设置新密码</h1>
          <p class="notice">如果 ${safeText(maskEmail(email))} 已注册，密码重置验证码将发送到该邮箱。</p>
          ${development ? `<p class="notice">本地重置验证码：<code>${safeText(code)}</code></p>` : ""}
          <form method="post" action="${safeText(contextHref("/reset"))}">${authFields(context)}
          <input type="hidden" name="email" value="${safeText(email)}">
          <label>验证码<input name="code" inputmode="numeric" autocomplete="one-time-code" required></label>
          <label>新密码<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
          <button type="submit">更新密码</button></form>`,
        { context: contextLabel(context), theme: context.theme }));
      } else if (request.method === "POST" && url.pathname === "/reset") {
        const body = await formBody(request);
        const email = normalizeEmail(body.get("email"));
        const password = String(body.get("password") || "");
        const context = await authContext(body);
        await rateLimit(`reset:${email}`, 5, 10 * 60_000);
        if (password.length < 12 || password.length > 128 || !await consumeCode(email, "reset", body.get("code"))) {
          return html(response, 400, renderPage("重置失败",
            `<h1>无法更新密码</h1><p class="error" role="alert">验证码无效或密码长度不符合要求。</p>
            <a class="button" href="${safeText(contextHref("/forgot", context))}">重新获取验证码</a>`,
            { context: contextLabel(context), theme: context.theme }));
        }
        const salt = token(18);
        await database.query(
          `UPDATE local_identity_users
           SET salt = $1, password_hash = $2, verified = TRUE WHERE email = $3`,
          [salt, passwordDigest(password, salt), email]
        );
        await database.query(
          `DELETE FROM local_identity_state WHERE namespace = 'session' AND value->>'subject' = $1`,
          [localDevSubject(email)]
        );
        // In the hosted deployment Runtime and identity share PostgreSQL.
        // Revoke already-issued Runtime cookies as well as identity cookies.
        const runtimeSchema = (await database.query("SELECT to_regclass('account_sessions') AS sessions")).rows[0];
        if (runtimeSchema.sessions) await database.query(
          `UPDATE account_sessions SET revoked_at = $1 WHERE revoked_at IS NULL AND user_id IN
           (SELECT user_id FROM account_identities WHERE issuer = $2 AND subject = $3)`,
          [now(), issuer, localDevSubject(email)]
        );
        redirect(response, contextHref("/login", context));
      } else if (request.method === "GET" && url.pathname === "/settings") {
        const user = await currentUser(request);
        if (!user) return redirect(response, contextHref("/login", { settings: "1" }));
        const linked = (await database.query(
          "SELECT provider FROM local_identity_social_accounts WHERE subject = $1", [user.subject]
        )).rows.some(row => row.provider === "github");
        html(response, 200, renderPage("登录方式", `<h1>登录方式</h1><p>管理用于登录 Zion 的邮箱和 GitHub 账号。</p>
          ${url.searchParams.get("linked") === "1" && linked ? '<p class="notice" role="status">GitHub 关联成功，下次可使用 GitHub 登录。</p>' : ""}
          <div class="method-list">
            <div class="method-row"><span class="method-icon" aria-hidden="true">@</span><div><strong>邮箱</strong><small>${safeText(user.email)}</small></div><span class="linked">已验证</span></div>
            ${github ? `<div class="method-row"><span class="method-icon" aria-hidden="true">↗</span><div><strong>GitHub</strong><small>${linked ? "已关联，可用于登录" : "关联后可直接使用 GitHub 登录"}</small></div>
              ${linked ? '<span class="linked">已关联</span>' : `<form method="post" action="${safeText(contextHref("/github"))}">${authFields({ settings: "1" })}<button type="submit">关联 GitHub</button></form>`}</div>` : ""}
            ${sendMail || development ? `<div class="method-row"><span class="method-icon" aria-hidden="true">＊</span><div><strong>密码</strong><small>通过邮箱验证修改密码</small></div><a class="text-link" href="${safeText(contextHref("/forgot", { settings: "1" }))}">修改</a></div>` : ""}
          </div>
          <a class="button social" href="${safeText(runtimeBaseUrl + "/account")}" style="margin-top:32px">返回 Zion</a>`));
      } else if (request.method === "POST" && url.pathname === "/device") {
        const body = await formBody(request);
        if (body.get("client_id") !== clientId) return json(response, 400, { error: "invalid_client" });
        const deviceCode = token();
        const userCode = randomBytes(5).toString("hex").toUpperCase();
        await deviceFlows.set(hash(deviceCode), {
          key: hash(deviceCode),
          userCode, status: "pending", subject: "", expiresAt: now() + 10 * 60_000
        });
        json(response, 200, {
          device_code: deviceCode, user_code: userCode,
          verification_uri: `${issuer}/activate`,
          verification_uri_complete: `${issuer}/activate?user_code=${userCode}`,
          expires_in: 600, interval: 5
        });
      } else if (request.method === "GET" && url.pathname === "/activate") {
        const userCode = String(url.searchParams.get("user_code") || "").trim().toUpperCase();
        if (!userCode) return html(response, 200, deviceCodePage());
        const flow = (await deviceFlows.values()).find((value) => value.userCode === userCode);
        if (!flow) return html(response, 400, deviceCodePage(
          userCode, "设备码无效或已过期。请核对终端中的 Code，或重新运行登录命令。"
        ));
        const user = await currentUser(request);
        if (user) return html(response, 200, renderPage("设备登录",
          `<h1>授权 Zion CLI</h1><p>确认设备码 <code>${safeText(userCode)}</code></p>
          <form method="post" action="${safeText(contextHref("/activate"))}"><input type="hidden" name="user_code" value="${safeText(userCode)}">
          <button type="submit">允许登录</button></form>`,
          { context: "Zion CLI 身份验证" }));
        html(response, 200, loginPage({ device: userCode }));
      } else if (request.method === "POST" && url.pathname === "/activate") {
        const body = await formBody(request);
        const user = await currentUser(request);
        if (!user) return redirect(response, contextHref("/login", {
          device: body.get("user_code") || ""
        }));
        await approveDevice(response, String(body.get("user_code") || "").toUpperCase(), user);
      } else if (request.method === "POST" && url.pathname === "/token") {
        const body = await formBody(request);
        if (body.get("client_id") !== clientId) return json(response, 400, { error: "invalid_client" });
        if (body.get("grant_type") === "authorization_code") {
          const code = await authorizationCodes.take(hash(body.get("code")));
          const challenge = createHash("sha256").update(String(body.get("code_verifier") || "")).digest("base64url");
          if (!code || code.expiresAt <= now() || code.redirectUri !== body.get("redirect_uri")
            || code.challenge !== challenge) return json(response, 400, { error: "invalid_grant" });
          return json(response, 200, await signTokens(
            await userBySubject(code.subject),
            code
          ));
        }
        if (body.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
          const key = hash(body.get("device_code"));
          const flow = await deviceFlows.get(key);
          if (!flow || flow.expiresAt <= now()) return json(response, 400, { error: "expired_token" });
          if (flow.status !== "approved") return json(response, 400, { error: "authorization_pending" });
          const consumed = await deviceFlows.take(key);
          if (!consumed) return json(response, 400, { error: "expired_token" });
          return json(response, 200, await signTokens(
            await userBySubject(flow.subject)
          ));
        }
        json(response, 400, { error: "unsupported_grant_type" });
      } else if (request.method === "GET" && url.pathname === "/logout") {
        await sessions.delete(hash(cookie(request.headers, sessionCookie)));
        redirect(response, contextHref("/login"), {
          "set-cookie": `${sessionCookie}=; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=0`
        });
      } else if (request.method === "GET" && url.pathname === "/") {
        redirect(response, contextHref("/login"));
      } else {
        html(response, 404, renderPage("未找到", "<h1>页面不存在</h1><p>请检查地址后重试。</p>"));
      }
    } catch (error) {
      html(response, error?.status || 500, renderPage("请求失败",
        `<h1>请求失败</h1><p class="error">${safeText(error?.status ? error.message : "账号服务暂时不可用，请重试。")}</p>
        <a class="button" href="${safeText(contextHref("/login"))}">返回登录</a>`));
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    if (ownsPool) await database.end();
    throw error;
  }
  return {
    issuer, clientId, registrationUrl: `${issuer}/register`,
    close: () => new Promise((resolve) => {
      server.close(async () => {
        if (ownsPool) await database.end();
        resolve();
      });
      server.closeAllConnections();
    })
  };
}
