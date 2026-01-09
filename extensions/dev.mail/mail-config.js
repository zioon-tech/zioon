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
    width: "360px",
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

  const readRecipients = () => {
    try {
      const raw = localStorage.getItem("zion.mail.recipients") || "[]";
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list.map((s) => String(s).trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  };

  const writeRecipients = (list) => {
    try {
      const uniq = Array.from(new Set((Array.isArray(list) ? list : []).map((s) => String(s).trim()).filter(Boolean)));
      localStorage.setItem("zion.mail.recipients", JSON.stringify(uniq));
      return uniq;
    } catch {
      return [];
    }
  };

  const readDefaultRecipient = () => {
    try {
      return String(localStorage.getItem("zion.mail.defaultRecipient") || "").trim();
    } catch {
      return "";
    }
  };

  const writeDefaultRecipient = (email) => {
    try {
      localStorage.setItem("zion.mail.defaultRecipient", String(email || "").trim());
    } catch {}
  };

  const readNotifyAlways = () => {
    try {
      const v = (localStorage.getItem("zion.mail.notifyAlways") || "").toLowerCase();
      return v === "1" || v === "true" || v === "yes";
    } catch {
      return false;
    }
  };

  const writeNotifyAlways = (flag) => {
    try {
      localStorage.setItem("zion.mail.notifyAlways", flag ? "1" : "0");
    } catch {}
  };

  const normalizeEmail = (s) => {
    const v = String(s || "").trim();
    if (!v) return "";
    if (!/^\S+@\S+\.[^\s@]+$/.test(v)) return "";
    return v;
  };

  const smtpHost = mkInput("SMTP Host", "zion.mail.smtp.host", "smtp.example.com");
  const smtpPort = mkInput("SMTP Port", "zion.mail.smtp.port", "587", "number");
  const smtpUser = mkInput("SMTP Username", "zion.mail.smtp.username", "user@example.com");
  const smtpPass = mkInput("SMTP Password", "zion.mail.smtp.password", "app-specific password", "password");
  const smtpTLS = mkCheckbox("Use TLS", "zion.mail.smtp.useTls");

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

  const recipientsWrap = document.createElement("div");
  Object.assign(recipientsWrap.style, {
    borderTop: "1px solid var(--border)",
    paddingTop: "8px",
    marginTop: "2px",
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: "6px"
  });

  const recipientsTitle = document.createElement("div");
  recipientsTitle.textContent = "Recipients";
  Object.assign(recipientsTitle.style, { fontSize: "11px", opacity: "0.85", fontWeight: "600" });

  const addRow = document.createElement("div");
  Object.assign(addRow.style, { display: "flex", gap: "6px" });
  const addInp = document.createElement("input");
  addInp.type = "text";
  addInp.placeholder = "user@example.com";
  Object.assign(addInp.style, {
    flex: "1",
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
  const addBtn = document.createElement("button");
  addBtn.textContent = "Add";
  Object.assign(addBtn.style, {
    border: "1px solid var(--border)",
    borderRadius: "4px",
    background: "transparent",
    color: "var(--fg)",
    padding: "4px 8px",
    fontSize: "11px",
    cursor: "pointer"
  });
  addRow.appendChild(addInp);
  addRow.appendChild(addBtn);

  const recipientsList = document.createElement("div");
  Object.assign(recipientsList.style, {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: "4px"
  });

  const renderRecipients = () => {
    const list = readRecipients();
    const def = readDefaultRecipient();
    recipientsList.innerHTML = "";

    for (const email of list) {
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        border: "1px solid var(--border)",
        borderRadius: "4px",
        padding: "4px 6px",
        background: "rgba(128,128,128,0.06)"
      });

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "zion-mail-default-recipient";
      radio.checked = def ? def === email : list[0] === email;
      radio.addEventListener("change", () => {
        writeDefaultRecipient(email);
      });

      const text = document.createElement("div");
      text.textContent = email;
      Object.assign(text.style, { fontSize: "11px", flex: "1", overflow: "hidden", textOverflow: "ellipsis" });

      const del = document.createElement("button");
      del.textContent = "Remove";
      Object.assign(del.style, {
        border: "1px solid var(--border)",
        borderRadius: "4px",
        background: "transparent",
        color: "var(--fg)",
        padding: "2px 6px",
        fontSize: "11px",
        cursor: "pointer"
      });
      del.addEventListener("click", () => {
        const next = writeRecipients(list.filter((x) => x !== email));
        const curDef = readDefaultRecipient();
        if (curDef === email) {
          writeDefaultRecipient(next[0] || "");
        }
        renderRecipients();
      });

      row.appendChild(radio);
      row.appendChild(text);
      row.appendChild(del);
      recipientsList.appendChild(row);
    }
  };

  addBtn.addEventListener("click", () => {
    const email = normalizeEmail(addInp.value);
    if (!email) return;
    const list = readRecipients();
    const next = writeRecipients([...list, email]);
    const def = readDefaultRecipient();
    if (!def && next.length === 1) writeDefaultRecipient(next[0]);
    addInp.value = "";
    renderRecipients();
  });
  addInp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addBtn.click();
    }
  });

  recipientsWrap.appendChild(recipientsTitle);
  recipientsWrap.appendChild(addRow);
  recipientsWrap.appendChild(recipientsList);
  form.appendChild(recipientsWrap);

  const notifyWrap = document.createElement("div");
  Object.assign(notifyWrap.style, {
    borderTop: "1px solid var(--border)",
    paddingTop: "8px",
    marginTop: "2px",
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: "6px"
  });
  const notifyTitle = document.createElement("div");
  notifyTitle.textContent = "Notify";
  Object.assign(notifyTitle.style, { fontSize: "11px", opacity: "0.85", fontWeight: "600" });

  const notifyModeWrap = document.createElement("div");
  Object.assign(notifyModeWrap.style, {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: "6px"
  });

  const mkRadio = (text) => {
    const wrap = document.createElement("label");
    Object.assign(wrap.style, {
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      fontSize: "11px",
      userSelect: "none",
      cursor: "pointer"
    });
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "zion-mail-notify-mode";
    radio.style.margin = "0";
    const span = document.createElement("span");
    span.textContent = text;
    wrap.appendChild(radio);
    wrap.appendChild(span);
    return { wrap, radio };
  };

  const rOnce = mkRadio("本次会话结束发送一次邮件通知");
  const rAlways = mkRadio("总是发送邮件通知");

  const setRadioChecked = (radio, checked) => {
    if (!radio) return;
    radio.checked = !!checked;
    if (radio.checked) radio.dataset.selected = "1";
    else delete radio.dataset.selected;
  };

  const applyNotifyMode = (mode) => {
    const sid = window.zion?.state?.get("sessions.currentId") || "";
    if (mode === "always") {
      writeNotifyAlways(true);
      try { window.zion?.state?.set("mail.notifyAlways", true); } catch {}
      if (sid) {
        try { window.zion?.state?.set(`mail.notifyOnce.${sid}`, false); } catch {}
      }
      return;
    }

    writeNotifyAlways(false);
    try { window.zion?.state?.set("mail.notifyAlways", false); } catch {}
    if (sid) {
      try { window.zion?.state?.set(`mail.notifyOnce.${sid}`, mode === "once"); } catch {}
    }
  };

  const makeRadioUnselectable = (radio, onSelected, onUnselected) => {
    radio.addEventListener("click", (e) => {
      const already = radio.dataset.selected === "1";
      if (already) {
        e.preventDefault();
        radio.checked = false;
        delete radio.dataset.selected;
        onUnselected?.();
        return;
      }
      radio.dataset.selected = "1";
      onSelected?.();
    });
  };

  makeRadioUnselectable(
    rOnce.radio,
    () => {
      setRadioChecked(rAlways.radio, false);
      applyNotifyMode("once");
    },
    () => {
      applyNotifyMode("off");
    }
  );
  makeRadioUnselectable(
    rAlways.radio,
    () => {
      setRadioChecked(rOnce.radio, false);
      applyNotifyMode("always");
    },
    () => {
      applyNotifyMode("off");
    }
  );

  const refreshNotifyUI = () => {
    const sid = window.zion?.state?.get("sessions.currentId") || "";
    const onceKey = sid ? `mail.notifyOnce.${sid}` : "";
    let once = false;
    try { once = !!(onceKey && window.zion?.state?.get(onceKey)); } catch {}
    const always = readNotifyAlways();

    setRadioChecked(rOnce.radio, !!once && !always);
    setRadioChecked(rAlways.radio, !!always);
  };

  notifyModeWrap.appendChild(rOnce.wrap);
  notifyModeWrap.appendChild(rAlways.wrap);

  notifyWrap.appendChild(notifyTitle);
  notifyWrap.appendChild(notifyModeWrap);
  form.appendChild(notifyWrap);

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
      window.zion?.state?.set("mail.baseUrl", base);
    } catch {}
  });

  renderRecipients();
  refreshNotifyUI();

  closeBtn.addEventListener("click", () => { root.style.display = "none"; });

  root.addEventListener("click", (e) => { if (e.target === root) root.style.display = "none"; });

  function open() {
    root.style.display = "block";
    try { renderRecipients(); } catch {}
    try { refreshNotifyUI(); } catch {}
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
