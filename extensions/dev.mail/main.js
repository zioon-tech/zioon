import { installMailConfigPanel } from "./mail-config.js";
import { registerMailSettings } from "./settings.js";

export async function activate(ctx) {
  try {
    const mailManageTool = {
      type: "function",
      function: {
        name: "mailManage",
        description: "Manage MailCfg (recipients list, default recipient, notify settings).",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "list",
                "add_recipient",
                "remove_recipient",
                "set_default_recipient",
                "set_notify_always",
                "set_notify_once_for_session"
              ],
              description: "Operation"
            },
            email: { type: "string", description: "Email address" },
            session_id: { type: "string", description: "Session id (for notify once)" },
            enabled: { type: "boolean", description: "Enable/disable flag (for notify always)" }
          },
          required: ["action"],
          additionalProperties: false
        }
      }
    };

    const sendMailTool = {
      type: "function",
      function: {
        name: "sendMail",
        description: "Send an email to specified recipients. Supports HTML/plain text and attachments. Requires mail service configuration.",
        parameters: {
          type: "object",
          properties: {
            to: {
              type: "array",
              items: { type: "string" },
              description: "Recipient email addresses (required)"
            },
            use_default_to: {
              type: "boolean",
              description: "Use MailCfg default recipient when 'to' is empty (default: true)"
            },
            cc: {
              type: "array",
              items: { type: "string" },
              description: "CC email addresses (optional)"
            },
            bcc: {
              type: "array",
              items: { type: "string" },
              description: "BCC email addresses (optional)"
            },
            subject: { type: "string", description: "Email subject (required)" },
            body: { type: "string", description: "Email body content (required)" },
            html: { type: "boolean", description: "Whether body is HTML format (default: false)" },
            attachments: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  filename: { type: "string" },
                  content: { type: "string", description: "Base64 encoded content" },
                  content_type: { type: "string" }
                },
                required: ["filename", "content"]
              },
              description: "Email attachments (optional)"
            }
          },
          required: ["subject", "body"],
          additionalProperties: false
        }
      }
    };

    const existing = window.zion?.state?.get("chat.tools") || [];
    const existNames = new Set(existing.map(t => t?.function?.name).filter(Boolean));
    const merged = existing.slice();
    if (!existNames.has("mailManage")) merged.push(mailManageTool);
    if (!existNames.has("sendMail")) merged.push(sendMailTool);
    window.zion.state.set("chat.tools", merged);
  } catch (e) {
    console.warn("[dev.mail] register tool schema failed", e);
  }

  try {
    const handlers = { ...(window.zion?.state?.get("chat.toolHandlers") || {}) };

    if (!handlers.mailManage) {
      handlers.mailManage = async (args) => {
        try {
          const action = String(args?.action || "").trim();
          const normalizeEmail = (s) => {
            const v = String(s || "").trim();
            if (!v) return "";
            if (!/^\S+@\S+\.[^\s@]+$/.test(v)) return "";
            return v;
          };
          const readRecipients = () => {
            try {
              const raw = localStorage.getItem("zion.mail.recipients") || "[]";
              const j = JSON.parse(raw);
              return Array.isArray(j) ? j.map((s) => String(s).trim()).filter(Boolean) : [];
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
          const readDefault = () => {
            try { return String(localStorage.getItem("zion.mail.defaultRecipient") || "").trim(); } catch { return ""; }
          };
          const writeDefault = (email) => {
            try { localStorage.setItem("zion.mail.defaultRecipient", String(email || "").trim()); } catch {}
          };

          if (action === "list") {
            const recipients = readRecipients();
            const def = readDefault();
            const notifyAlwaysRaw = (() => {
              try { return (localStorage.getItem("zion.mail.notifyAlways") || "").toLowerCase(); } catch { return ""; }
            })();
            const notifyAlways = notifyAlwaysRaw === "1" || notifyAlwaysRaw === "true" || notifyAlwaysRaw === "yes";
            return JSON.stringify({ recipients, default_recipient: def || recipients[0] || "", notify_always: notifyAlways }, null, 2);
          }

          if (action === "add_recipient") {
            const email = normalizeEmail(args?.email);
            if (!email) return "Invalid email";
            const list = readRecipients();
            const next = writeRecipients([...list, email]);
            const def = readDefault();
            if (!def && next.length === 1) writeDefault(next[0]);
            return JSON.stringify({ ok: true, recipients: next, default_recipient: readDefault() || next[0] || "" }, null, 2);
          }

          if (action === "remove_recipient") {
            const email = normalizeEmail(args?.email);
            if (!email) return "Invalid email";
            const list = readRecipients();
            const next = writeRecipients(list.filter((x) => x !== email));
            const def = readDefault();
            if (def === email) writeDefault(next[0] || "");
            return JSON.stringify({ ok: true, recipients: next, default_recipient: readDefault() || next[0] || "" }, null, 2);
          }

          if (action === "set_default_recipient") {
            const email = normalizeEmail(args?.email);
            if (!email) return "Invalid email";
            const list = readRecipients();
            if (!list.includes(email)) {
              const next = writeRecipients([...list, email]);
              writeDefault(email);
              return JSON.stringify({ ok: true, recipients: next, default_recipient: email }, null, 2);
            }
            writeDefault(email);
            return JSON.stringify({ ok: true, recipients: list, default_recipient: email }, null, 2);
          }

          if (action === "set_notify_always") {
            const enabled = args?.enabled !== false;
            try { localStorage.setItem("zion.mail.notifyAlways", enabled ? "1" : "0"); } catch {}
            try { window.zion?.state?.set("mail.notifyAlways", !!enabled); } catch {}
            return JSON.stringify({ ok: true, notify_always: !!enabled }, null, 2);
          }

          if (action === "set_notify_once_for_session") {
            const sid = String(args?.session_id || "").trim();
            if (!sid) return "Missing session_id";
            try { window.zion?.state?.set(`mail.notifyOnce.${sid}`, true); } catch {}
            return JSON.stringify({ ok: true, session_id: sid, notify_once: true }, null, 2);
          }

          return "Unknown action";
        } catch (e) {
          return `mailManage error: ${e?.message || String(e)}`;
        }
      };
    }

    if (!handlers.sendMail) {
      handlers.sendMail = async (args) => {
        try {
          const base = (() => {
            const st = window.zion?.state?.get("mail.baseUrl");
            if (typeof st === "string" && st.trim()) return st.trim();
            try { const s = localStorage.getItem("zion.mail.baseUrl") || ""; if (s) return s.trim(); } catch {}
            return "http://127.0.0.1:8765";
          })().replace(/\/$/, "");

          const cfg = {
            provider: "smtp",
            smtp_host: "",
            smtp_port: 587,
            smtp_username: "",
            smtp_password: "",
            smtp_use_tls: true,
            from_email: "",
            from_name: ""
          };
          try {
            cfg.smtp_host = (localStorage.getItem("zion.mail.smtp.host") || "").trim();
            const p = (localStorage.getItem("zion.mail.smtp.port") || "").trim();
            const pn = parseInt(p || "587", 10); cfg.smtp_port = isNaN(pn) ? 587 : pn;
            cfg.smtp_username = (localStorage.getItem("zion.mail.smtp.username") || "").trim();
            cfg.smtp_password = (localStorage.getItem("zion.mail.smtp.password") || "");
            const tlsRaw = (localStorage.getItem("zion.mail.smtp.useTls") || "").toLowerCase();
            cfg.smtp_use_tls = tlsRaw === "1" || tlsRaw === "true" || tlsRaw === "yes";
            cfg.from_email = (localStorage.getItem("zion.mail.fromEmail") || "").trim() || "zion@zion.ai";
            cfg.from_name = (localStorage.getItem("zion.mail.fromName") || "").trim() || "Zion AI";
            if (cfg.smtp_host) {
              await fetch(`${base}/mail/config`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(cfg)
              }).catch(() => {});
            }
          } catch {}

          let to = Array.isArray(args?.to) ? args.to.map(String).filter(Boolean) : [];
          const subject = String(args?.subject || "").trim();
          const body = String((args?.body ?? args?.content ?? "")).trim();
          const html = !!args?.html;
          const cc = Array.isArray(args?.cc) ? args.cc.map(String).filter(Boolean) : undefined;
          const bcc = Array.isArray(args?.bcc) ? args.bcc.map(String).filter(Boolean) : undefined;

          const useDefaultTo = args?.use_default_to !== false;
          if ((!to || to.length === 0) && useDefaultTo) {
            try {
              const raw = localStorage.getItem("zion.mail.recipients") || "[]";
              const list = JSON.parse(raw);
              const recipients = Array.isArray(list) ? list.map((s) => String(s).trim()).filter(Boolean) : [];
              const def = String(localStorage.getItem("zion.mail.defaultRecipient") || "").trim();
              const picked = def && recipients.includes(def) ? def : (recipients[0] || "");
              if (picked) to = [picked];
            } catch {}
          }

          if (!to.length) return "Missing to";
          if (!subject) return "Missing subject";
          if (!body) return "Missing body";

          const payload = { to, subject, body, html, cc, bcc };
          const res = await fetch(`${base}/mail/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          const txt = await res.text();
          if (!res.ok) {
            let detail = "";
            try { const j = JSON.parse(txt); detail = j?.detail ? JSON.stringify(j.detail) : txt; } catch { detail = txt; }
            return `HTTP ${res.status}: ${detail}`;
          }
          return txt;
        } catch (e) {
          return `sendMail error: ${e?.message || String(e)}`;
        }
      };
    }

    window.zion.state.set("chat.toolHandlers", handlers);
  } catch (e) {
    console.warn("[dev.mail] register handler failed", e);
  }

  let mailPanel = null;
  const dispMailPanel = window.zion.editor.registerDecorator({
    id: "dev.mail.mail-config",
    apply(editor) {
      mailPanel = installMailConfigPanel();
      return { dispose() { mailPanel?.dispose?.(); mailPanel = null; } };
    }
  });
  ctx.subscriptions.push(dispMailPanel);

  const openMailCfg = window.zion.commands.registerCommand("tools.openMailConfig", () => {
    mailPanel?.open?.();
  });
  const closeMailCfg = window.zion.commands.registerCommand("tools.closeMailConfig", () => {
    mailPanel?.close?.();
  });
  ctx.subscriptions.push(openMailCfg, closeMailCfg);

  let mailBtnDisp = null;
  const updateMailBtn = () => {
    mailBtnDisp?.dispose?.();
    const mailBase = (window.zion.state.get("mail.baseUrl") || localStorage.getItem("zion.mail.baseUrl") || "http://127.0.0.1:8765");
    mailBtnDisp = window.zion.statusBar.registerItem({
      id: "dev.mail.button",
      text: "MailCfg",
      tooltip: `Configure mail (base: ${mailBase})`,
      onClick: () => window.zion.commands.executeCommand("tools.openMailConfig")
    });
  };
  updateMailBtn();
  ctx.subscriptions.push(window.zion.state.onDidChange("mail.baseUrl", () => updateMailBtn()));

  const dispMailNotify = window.zion.events.on("chat/runFinished", async ({ sessionId }) => {
    try {
      const sid = String(sessionId || "").trim();
      if (!sid) return;

      const debug = (() => {
        try {
          const st = window.zion?.state?.get("mail.debug");
          if (typeof st === "boolean") return st;
        } catch {}
        try {
          const v = (localStorage.getItem("zion.mail.debug") || "").toLowerCase();
          return v === "1" || v === "true" || v === "yes";
        } catch {
          return false;
        }
      })();
      const log = (...args) => {
        if (!debug) return;
        try { console.log("[mail.notify]", ...args); } catch {}
      };
      const warn = (...args) => {
        if (!debug) return;
        try { console.warn("[mail.notify]", ...args); } catch {}
      };

      let notifyOnce = false;
      try { notifyOnce = !!window.zion?.state?.get(`mail.notifyOnce.${sid}`); } catch {}

      const notifyAlways = (() => {
        try {
          const st = window.zion?.state?.get("mail.notifyAlways");
          if (typeof st === "boolean") return st;
        } catch {}
        try {
          const v = (localStorage.getItem("zion.mail.notifyAlways") || "").toLowerCase();
          return v === "1" || v === "true" || v === "yes";
        } catch {
          return false;
        }
      })();

      if (!notifyOnce && !notifyAlways) return;
      log("trigger", { sessionId: sid, notifyOnce, notifyAlways });

      const handlers = window.zion?.state?.get("chat.toolHandlers") || {};
      if (typeof handlers.sendMail !== "function") {
        warn("sendMail handler missing");
        return;
      }

      const readDoc = () => {
        try {
          const doc = window.zion?.commands?.executeCommand("zion.sessions.getDoc", sid);
          if (typeof doc === "string" && doc) return doc;
        } catch {}
        try {
          const cur = window.zion?.state?.get("sessions.currentId");
          const ed = window.zion?.window?.activeEditor;
          if (cur === sid && ed) return String(ed.getValue() || "");
        } catch {}
        return "";
      };

      const meta = (() => {
        try {
          const m = window.zion?.commands?.executeCommand("zion.sessions.getMeta", sid);
          return m && typeof m === "object" ? m : null;
        } catch {
          return null;
        }
      })();

      const doc = readDoc();
      log("doc", { length: String(doc || "").length, hasMeta: !!meta });

      const extractBlocks = (text, maxBlocks) => {
        const lines = String(text || "").replace(/\r/g, "").split("\n");
        const blocks = [];
        let role = "user";
        let acc = [];
        const flush = () => {
          const t = acc.join("\n").trim();
          if (t) blocks.push({ role, text: t });
          acc = [];
        };
        for (const line of lines) {
          const m = line.match(/^\s*(system|user|assistant)\s*:\s*(.*)$/i);
          if (m) {
            flush();
            role = m[1].toLowerCase();
            if (m[2]) acc.push(m[2]);
          } else {
            acc.push(line);
          }
        }
        flush();
        const compact = blocks.filter(b => b.text.trim());
        return compact.length > maxBlocks ? compact.slice(-maxBlocks) : compact;
      };

      const blocks = extractBlocks(doc, 10);
      const title = String(meta?.title || `Session ${sid}`);
      const subject = `[Zion] ${title} — 会话结束通知`;

      const summarizeWithActiveModel = async (text) => {
        try {
          let active = null;
          try {
            const st = window.zion?.state?.get("chat.activeModel");
            if (st && typeof st === "object" && st.providerId && st.modelId) {
              active = { providerId: String(st.providerId), modelId: String(st.modelId) };
            }
          } catch {}
          if (!active) {
            try {
              const raw = localStorage.getItem("zion.chat.defaultModel") || "";
              const j = raw ? JSON.parse(raw) : null;
              if (j && typeof j === "object" && j.providerId && j.modelId) {
                active = { providerId: String(j.providerId), modelId: String(j.modelId) };
              }
            } catch {}
          }
          if (!active) {
            log("summary skipped", { reason: "no_active_model" });
            return null;
          }

          const provider = window.zion?.models?.getProvider?.(active.providerId);
          if (!provider) {
            log("summary skipped", { reason: "provider_not_found", active });
            return null;
          }

          let cfg = {};
          try {
            const resolved = typeof provider.resolve === "function" ? await provider.resolve(active.modelId) : null;
            if (resolved && typeof resolved === "object") cfg = { ...cfg, ...resolved };
          } catch (e) {
            log("summary provider.resolve failed", { message: e?.message || String(e) });
          }
          try {
            const mc = provider?.getModelConfig?.(active.modelId);
            if (mc && typeof mc === "object") cfg = { ...cfg, ...mc };
          } catch {}
          try {
            const pc = provider?.getConfig?.();
            if (pc && typeof pc === "object") cfg = { ...cfg, ...pc };
          } catch {}

          const baseRaw = String(cfg.baseUrl || cfg.baseURL || cfg.endpoint || cfg.url || "").trim();

          const url = (() => {
            const base = baseRaw;
            if (!base) return null;
            if (/\/chat\/completions\/?$/.test(base)) return base.replace(/\/+$/, "");
            try {
              const normalized = base.endsWith("/") ? base : `${base}/`;
              return new URL("chat/completions", normalized).toString();
            } catch {
              return null;
            }
          })();

          const apiKey = cfg.key || cfg.apiKey;
          if (!url) {
            log("summary skipped", { reason: "missing_base_url", active, baseRaw });
            return null;
          }
          if (!apiKey) {
            log("summary skipped", { reason: "missing_api_key", active });
            return null;
          }

          const controller = new AbortController();
          const timeoutMs = 8000;
          const t = setTimeout(() => {
            try { controller.abort(); } catch {}
          }, timeoutMs);

          const maxInput = 12000;
          const input = String(text || "");
          const clipped = input.length > maxInput ? input.slice(-maxInput) : input;
          const clippedHint = input.length > maxInput ? `\n\n(仅截取末尾 ${maxInput} 字符用于总结)` : "";

          const body = {
            model: cfg.modelName || cfg.model || active.modelId,
            messages: [
              {
                role: "system",
                content: "你将收到一段会话内容。请用中文输出一封邮件可读的会话总结：1) 一句话结论；2) 关键要点（最多 6 条）；3) 待办/下一步（最多 6 条）；4) 如有代码或命令，列出最关键的 3 个。不要输出多余解释。"
              },
              { role: "user", content: clipped + clippedHint }
            ],
            stream: false,
            temperature: 0,
            max_tokens: typeof cfg.max_tokens === "number" ? Math.min(800, cfg.max_tokens) : 800
          };

          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify(body),
            signal: controller.signal
          }).finally(() => {
            clearTimeout(t);
          });
          if (!res.ok) {
            log("summary failed", { reason: "http_not_ok", status: res.status });
            return null;
          }
          const j = await res.json().catch(() => null);
          const content =
            j?.choices?.[0]?.message?.content ??
            j?.message?.content ??
            j?.content ??
            j?.output ??
            "";
          const out = String(content || "").trim();
          if (!out) {
            log("summary failed", { reason: "empty_output" });
            return null;
          }
          return { summary: out, model: `${active.providerId}:${active.modelId}` };
        } catch (e) {
          log("summary failed", { reason: "exception", message: e?.message || String(e) });
          return null;
        }
      };

      const summaryRet = await summarizeWithActiveModel(doc);
      log("summary", summaryRet ? { ok: true, model: summaryRet.model, length: summaryRet.summary.length } : { ok: false });

      const isSendOk = (ret) => {
        const s = String(ret || "").trim();
        if (!s) return true;
        if (/^HTTP\s+\d+\s*:/i.test(s)) return false;
        if (/^sendMail\s+error\s*:/i.test(s)) return false;
        if (/^Missing\s+/i.test(s)) return false;
        return true;
      };

      let body = `Session: ${title}\nSessionId: ${sid}\n\n`;
      if (summaryRet?.summary) {
        body += `Summary (${summaryRet.model}):\n\n${summaryRet.summary}\n\n`;
      }

      if (!summaryRet?.summary) {
        if (blocks.length) {
          body += "Recent conversation:\n\n";
          for (const b of blocks) {
            body += `--- ${b.role} ---\n${b.text}\n\n`;
          }
        } else {
          body += "(No session content)\n";
        }
      } else {
        if (blocks.length) {
          body += "Recent conversation (tail):\n\n";
          for (const b of blocks.slice(-6)) {
            body += `--- ${b.role} ---\n${b.text}\n\n`;
          }
        }
      }
      if (body.length > 16000) body = body.slice(-16000);

      const sendRet = await handlers.sendMail({ subject, body, use_default_to: true });
      log("sendMail", { result: String(sendRet || "").slice(0, 200) });
      if (notifyOnce && isSendOk(sendRet)) {
        try { window.zion?.state?.set(`mail.notifyOnce.${sid}`, false); } catch {}
        log("notifyOnce cleared", sid);
      }
    } catch {}
  });
  ctx.subscriptions.push({ dispose: () => dispMailNotify.dispose?.() });

  // Register mail settings into core Settings Panel
  try {
    registerMailSettings();
  } catch (e) {
    console.warn("[dev.mail] failed to register settings", e);
  }
}
