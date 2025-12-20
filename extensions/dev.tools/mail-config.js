/**
 * 邮件配置面板（SMTP：主机/端口/用户名/密码、发件人邮箱/名称、服务地址）
 * - 位置与样式遵循 UI/UX 原则与主题变量
 * - 保存到 localStorage，并调用本地服务 /mail/config（provider: smtp）
 */
export function installMailConfigPanel() {
  let root = document.getElementById("zion-mail-config-root");
  if (root) return createHandle(root);

  root = document.createElement("div");
  root.id = "zion-mail-config-root";
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    background: "transparent",
    zIndex: "1000",
    display: "none"
  });

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    position: "fixed",
    top: "64px",
    right: "12px",
    width: "420px",
    maxHeight: "65vh",
    overflow: "auto",
    background: "var(--panel)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
    padding: "8px",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
  });

  const header = document.createElement("div");
  header.textContent = "Mail Configuration (SMTP)";
  Object.assign(header.style, {
    fontSize: "11px",
    opacity: "0.8",
    marginBottom: "6px",
    fontWeight: "600"
  });

  const form = document.createElement("div");
  Object.assign(form.style, {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: "6px"
  });

  const mkInput = (label, key, placeholder = "", type = "text") => {
    const wrap = document.createElement("label");
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.style.gap = "4px";
    const lb = document.createElement("span");
    lb.textContent = label;
    Object.assign(lb.style, { fontSize: "11px", opacity: "0.8" });
    const inp = document.createElement("input");
    inp.type = type;
    inp.placeholder = placeholder;
    Object.assign(inp.style, {
      width: "100%",
      boxSizing: "border-box",
      border: "1px solid var(--border)",
      borderRadius: "4px",
      background: "var(--panel)",
      color: "var(--fg)",
      outline: "none",
      padding: "4px 6px",
      fontSize: "11px",
      fontFamily: "inherit"
    });
    try { inp.value = localStorage.getItem(key) || ""; } catch {}
    wrap.appendChild(lb);
    wrap.appendChild(inp);
    return { wrap, inp, key };
  };

  const mkCheckbox = (label, key) => {
    const wrap = document.createElement("label");
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "6px";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    const lb = document.createElement("span");
    lb.textContent = label;
    Object.assign(lb.style, { fontSize: "11px", opacity: "0.8" });
    try {
      const v = (localStorage.getItem(key) || "").toLowerCase();
      cb.checked = v === "1" || v === "true";
    } catch {}
    wrap.appendChild(cb);
    wrap.appendChild(lb);
    return { wrap, cb, key };
  };

  // SMTP 基本配置
  const smtpHost = mkInput("SMTP Host", "zion.mail.smtp.host", "smtp.example.com");
  const smtpPort = mkInput("SMTP Port", "zion.mail.smtp.port", "587", "number");
  const smtpUser = mkInput("SMTP Username", "zion.mail.smtp.username", "user@example.com");
  const smtpPass = mkInput("SMTP Password", "zion.mail.smtp.password", "app-specific password", "password");
  const smtpTLS = mkCheckbox("Use TLS", "zion.mail.smtp.useTls");

  // 发件人与服务地址
  const fromEmail = mkInput("From Email", "zion.mail.fromEmail", "zion@zion.ai");
  const fromName = mkInput("From Name", "zion.mail.fromName", "Zion AI");
  const baseUrl = mkInput("Service Base URL", "zion.mail.baseUrl", "http://127.0.0.1:8765");

  form.appendChild(smtpHost.wrap);
  form.appendChild(smtpPort.wrap);
  form.appendChild(smtpUser.wrap);
  form.appendChild(smtpPass.wrap);
  form.appendChild(smtpTLS.wrap);
  form.appendChild(fromEmail.wrap);
  form.appendChild(fromName.wrap);
  form.appendChild(baseUrl.wrap);

  const btns = document.createElement("div");
  Object.assign(btns.style, { display: "flex", gap: "8px", marginTop: "6px", justifyContent: "flex-end" });

  const save = document.createElement("button");
  save.textContent = "Save";
  save.title = "保存并推送到本地服务";
  Object.assign(save.style, {
    border: "1px solid var(--border)",
    borderRadius: "4px",
    background: "var(--accent)",
    color: "var(--panel)",
    padding: "4px 8px",
    fontSize: "11px",
    cursor: "pointer"
  });

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Close";
  Object.assign(closeBtn.style, {
    border: "1px solid var(--border)",
    borderRadius: "4px",
    background: "transparent",
    color: "var(--fg)",
    padding: "4px 8px",
    fontSize: "11px",
    cursor: "pointer"
  });

  btns.appendChild(save);
  btns.appendChild(closeBtn);

  const footer = document.createElement("div");
  footer.textContent = "SMTP will be used when host is set. Username/password may require an app-specific password.";
  Object.assign(footer.style, {
    fontSize: "10px",
    opacity: "0.6",
    marginTop: "6px",
    textAlign: "left",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
  });

  panel.appendChild(header);
  panel.appendChild(form);
  panel.appendChild(btns);
  panel.appendChild(footer);
  root.appendChild(panel);
  document.body.appendChild(root);

  save.addEventListener("click", async () => {
    try {
      localStorage.setItem(smtpHost.key, smtpHost.inp.value.trim());
      localStorage.setItem(smtpPort.key, smtpPort.inp.value.trim());
      localStorage.setItem(smtpUser.key, smtpUser.inp.value.trim());
      localStorage.setItem(smtpPass.key, smtpPass.inp.value);
      localStorage.setItem(smtpTLS.key, smtpTLS.cb.checked ? "1" : "0");
      localStorage.setItem(fromEmail.key, fromEmail.inp.value.trim());
      localStorage.setItem(fromName.key, fromName.inp.value.trim());
      localStorage.setItem(baseUrl.key, baseUrl.inp.value.trim());

      const base = (baseUrl.inp.value || "http://127.0.0.1:8765").trim().replace(/\/$/, "");
      const cfg = {
        provider: "smtp",
        smtp_host: smtpHost.inp.value.trim(),
        smtp_port: parseInt(smtpPort.inp.value.trim() || "587", 10) || 587,
        smtp_username: smtpUser.inp.value.trim() || undefined,
        smtp_password: smtpPass.inp.value || undefined,
        smtp_use_tls: !!smtpTLS.cb.checked,
        from_email: fromEmail.inp.value.trim() || "zion@zion.ai",
        from_name: fromName.inp.value.trim() || "Zion AI"
      };
      if (cfg.smtp_host) {
        await fetch(`${base}/mail/config`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cfg)
        }).catch(() => {});
      }
      // 同步到状态总线，便于其他模块读取
      window.zion?.state?.set("mail.baseUrl", base);
    } catch {}
  });

  closeBtn.addEventListener("click", () => { root.style.display = "none"; });

  root.addEventListener("click", (e) => { if (e.target === root) root.style.display = "none"; });

  function open() {
    root.style.display = "block";
  }
  function close() {
    root.style.display = "none";
  }
  function dispose() {
    root.remove();
  }
  return { open, close, dispose };
}

function createHandle(root) {
  return {
    open() { root.style.display = "block"; },
    close() { root.style.display = "none"; },
    dispose() { root.remove(); }
  };
}