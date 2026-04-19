/**
 * dev.mail — mail 配置设置项注册
 *
 * 将 SMTP 配置 / 收件人列表 / 通知开关 注册到核心层 Settings Panel
 */

function getMailConfig() {
  try {
    const raw = localStorage.getItem("zion.mail.config");
    if (raw) return JSON.parse(raw);
  } catch {}
  return {
    host: "",
    port: "465",
    secure: true,
    user: "",
    pass: "",
    from: "",
    to: [],
    notify: true,
    debug: false
  };
}

function saveMailConfig(cfg) {
  try {
    localStorage.setItem("zion.mail.config", JSON.stringify(cfg));
  } catch {}
}

function renderMailConfig(container) {
  const cfg = getMailConfig();
  const inputs = {};

  const style = document.createElement("style");
  style.textContent = `
    .mail-cfg-row { display:flex;align-items:center;gap:8px;margin-bottom:8px }
    .mail-cfg-row:last-child { margin-bottom:0 }
    .mail-cfg-label { flex:0 0 110px;font-size:12px;opacity:.8;font-weight:500 }
    .mail-cfg-input { flex:1;padding:4px 8px;border:1px solid var(--border,#3c3c3c);border-radius:6px;background:transparent;color:var(--fg,#ccc);font-size:12px }
    .mail-cfg-input:focus { outline:1px solid var(--accent,#6272a4) }
    .mail-cfg-actions { display:flex;gap:8px;margin-top:12px }
    .mail-cfg-btn { padding:4px 12px;border:1px solid var(--border,#3c3c3c);border-radius:6px;background:transparent;color:var(--fg,#ccc);cursor:pointer;font-size:12px }
    .mail-cfg-btn:hover { background:rgba(255,255,255,.06) }
    .mail-cfg-btn.primary { border-color:var(--accent,#6272a4);color:var(--accent,#6272a4) }
    .mail-cfg-msg { font-size:11px;margin-top:6px;min-height:16px }
    .mail-cfg-msg.ok { color:var(--ok,#4caf50) }
    .mail-cfg-check { display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12px;opacity:.85 }
    .mail-cfg-check input { accent-color:var(--accent,#6272a4) }
  `;
  container.appendChild(style);

  const fields = [
    { key: "host", label: "SMTP Host", type: "text", placeholder: "smtp.example.com" },
    { key: "port", label: "SMTP Port", type: "text", placeholder: "465" },
    { key: "user", label: "Username", type: "text", placeholder: "user@example.com" },
    { key: "pass", label: "Password", type: "password", placeholder: "••••••" },
    { key: "from", label: "From", type: "text", placeholder: "noreply@example.com" },
    { key: "to", label: "Recipients", type: "text", placeholder: "a@x.com, b@y.com" }
  ];

  for (const f of fields) {
    const row = document.createElement("div");
    row.className = "mail-cfg-row";
    const label = document.createElement("div");
    label.className = "mail-cfg-label";
    label.textContent = f.label;
    const input = document.createElement("input");
    input.className = "mail-cfg-input";
    input.type = f.type;
    input.placeholder = f.placeholder;
    if (f.key === "to") {
      input.value = Array.isArray(cfg.to) ? cfg.to.join(", ") : (cfg.to || "");
    } else {
      input.value = String(cfg[f.key] ?? "");
    }
    inputs[f.key] = input;
    row.appendChild(label);
    row.appendChild(input);
    container.appendChild(row);
  }

  // Notification toggle
  const notifyRow = document.createElement("div");
  notifyRow.className = "mail-cfg-check";
  const notifyCb = document.createElement("input");
  notifyCb.type = "checkbox";
  notifyCb.checked = cfg.notify !== false;
  const notifyLabel = document.createElement("span");
  notifyLabel.textContent = "启用通知";
  notifyRow.appendChild(notifyCb);
  notifyRow.appendChild(notifyLabel);
  container.appendChild(notifyRow);

  // Debug toggle
  const debugRow = document.createElement("div");
  debugRow.className = "mail-cfg-check";
  const debugCb = document.createElement("input");
  debugCb.type = "checkbox";
  debugCb.checked = cfg.debug === true;
  const debugLabel = document.createElement("span");
  debugLabel.textContent = "Debug 模式";
  debugRow.appendChild(debugCb);
  debugRow.appendChild(debugLabel);
  container.appendChild(debugRow);

  const msg = document.createElement("div");
  msg.className = "mail-cfg-msg";

  const actions = document.createElement("div");
  actions.className = "mail-cfg-actions";
  const saveBtn = document.createElement("button");
  saveBtn.className = "mail-cfg-btn primary";
  saveBtn.textContent = "保存";
  saveBtn.onclick = () => {
    const toStr = inputs["to"].value.trim();
    const toArr = toStr ? toStr.split(/[,;]/).map(s => s.trim()).filter(Boolean) : [];
    const newCfg = {
      host: inputs["host"].value.trim(),
      port: inputs["port"].value.trim() || "465",
      secure: true,
      user: inputs["user"].value.trim(),
      pass: inputs["pass"].value,
      from: inputs["from"].value.trim(),
      to: toArr,
      notify: notifyCb.checked,
      debug: debugCb.checked
    };
    saveMailConfig(newCfg);
    msg.className = "mail-cfg-msg ok";
    msg.textContent = "已保存 ✓";
    setTimeout(() => { msg.textContent = ""; }, 2000);
  };
  actions.appendChild(saveBtn);
  container.appendChild(actions);
  container.appendChild(msg);
}

exports.registerMailSettings = function () {
  try {
    if (window.zion?.settings?.registerItem) {
      window.zion.settings.registerItem({
        id: "mail-config",
        section: "Mail",
        title: "邮件配置",
        order: 20,
        render: renderMailConfig
      });
    }
  } catch (e) {
    console.warn("[dev.mail] failed to register settings item", e);
  }
};
