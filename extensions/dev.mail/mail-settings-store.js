import { workbenchStorage as localStorage } from "../../src/runtime/workbench-space.ts";
const LEGACY_KEY = "zion.mail.config";

export const MAIL_SETTINGS_DEFAULTS = {
  smtpHost: "",
  smtpPort: "587",
  smtpUsername: "",
  smtpPassword: "",
  smtpUseTls: true,
  fromEmail: "zion@zion.ai",
  fromName: "Zion AI",
  recipients: [],
  defaultRecipient: "",
  notifyAlways: true,
  debug: false
};

function readLegacyConfig() {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readString(key, fallback = "") {
  try {
    const value = localStorage.getItem(key);
    return value == null ? fallback : String(value);
  } catch {
    return fallback;
  }
}

function readBool(key, fallback = false) {
  try {
    const raw = String(localStorage.getItem(key) || "").toLowerCase();
    if (!raw) return fallback;
    return raw === "1" || raw === "true" || raw === "yes";
  } catch {
    return fallback;
  }
}

function writeBool(key, value) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {}
}

function normalizeRecipients(input) {
  const arr = Array.isArray(input)
    ? input
    : String(input || "")
        .split(/[\n,;]/)
        .map((item) => item.trim())
        .filter(Boolean);
  return Array.from(new Set(arr.map((item) => String(item).trim()).filter(Boolean)));
}

export function isValidEmail(value) {
  return /^\S+@\S+\.[^\s@]+$/.test(String(value || "").trim());
}

export function getMailSettings() {
  const legacy = readLegacyConfig();
  const legacyRecipients = Array.isArray(legacy?.to) ? legacy.to : [];
  const recipients = (() => {
    try {
      const raw = localStorage.getItem("zion.mail.recipients");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return normalizeRecipients(parsed);
        }
      }
    } catch {}
    return normalizeRecipients(legacyRecipients);
  })();

  const defaultRecipient = (() => {
    const explicit = readString("zion.mail.defaultRecipient", "").trim();
    if (explicit) return explicit;
    return recipients[0] || "";
  })();

  return {
    smtpHost: readString("zion.mail.smtp.host", legacy?.host || MAIL_SETTINGS_DEFAULTS.smtpHost).trim(),
    smtpPort: readString("zion.mail.smtp.port", String(legacy?.port || MAIL_SETTINGS_DEFAULTS.smtpPort)).trim() || MAIL_SETTINGS_DEFAULTS.smtpPort,
    smtpUsername: readString("zion.mail.smtp.username", legacy?.user || MAIL_SETTINGS_DEFAULTS.smtpUsername).trim(),
    smtpPassword: readString("zion.mail.smtp.password", legacy?.pass || MAIL_SETTINGS_DEFAULTS.smtpPassword),
    smtpUseTls: readBool("zion.mail.smtp.useTls", legacy?.secure !== false),
    fromEmail: readString("zion.mail.fromEmail", legacy?.from || MAIL_SETTINGS_DEFAULTS.fromEmail).trim() || MAIL_SETTINGS_DEFAULTS.fromEmail,
    fromName: readString("zion.mail.fromName", MAIL_SETTINGS_DEFAULTS.fromName).trim() || MAIL_SETTINGS_DEFAULTS.fromName,
    recipients,
    defaultRecipient,
    notifyAlways: readBool("zion.mail.notifyAlways", legacy?.notify !== false),
    debug: readBool("zion.mail.debug", legacy?.debug === true)
  };
}

export function validateMailSettings(draft) {
  const errors = {};
  if (!String(draft.smtpPort || "").trim()) {
    errors.smtpPort = "请输入 SMTP 端口";
  } else if (!/^\d+$/.test(String(draft.smtpPort).trim())) {
    errors.smtpPort = "SMTP 端口需要是数字";
  }

  if (draft.fromEmail && !isValidEmail(draft.fromEmail)) {
    errors.fromEmail = "发件人邮箱格式不正确";
  }

  const recipients = normalizeRecipients(draft.recipients);
  if (recipients.some((item) => !isValidEmail(item))) {
    errors.recipients = "收件人列表里存在格式不正确的邮箱";
  }

  if (draft.defaultRecipient && !isValidEmail(draft.defaultRecipient)) {
    errors.defaultRecipient = "默认收件人格式不正确";
  } else if (draft.defaultRecipient && recipients.length && !recipients.includes(draft.defaultRecipient.trim())) {
    errors.defaultRecipient = "默认收件人需要包含在收件人列表中";
  }

  return errors;
}

export function saveMailSettings(draft) {
  const next = {
    smtpHost: String(draft.smtpHost || "").trim(),
    smtpPort: String(draft.smtpPort || "").trim() || MAIL_SETTINGS_DEFAULTS.smtpPort,
    smtpUsername: String(draft.smtpUsername || "").trim(),
    smtpPassword: String(draft.smtpPassword || ""),
    smtpUseTls: !!draft.smtpUseTls,
    fromEmail: String(draft.fromEmail || "").trim() || MAIL_SETTINGS_DEFAULTS.fromEmail,
    fromName: String(draft.fromName || "").trim() || MAIL_SETTINGS_DEFAULTS.fromName,
    recipients: normalizeRecipients(draft.recipients),
    defaultRecipient: String(draft.defaultRecipient || "").trim(),
    notifyAlways: !!draft.notifyAlways,
    debug: !!draft.debug
  };

  const errors = validateMailSettings(next);
  if (Object.keys(errors).length) {
    return { ok: false, errors };
  }

  try {
    localStorage.setItem("zion.mail.smtp.host", next.smtpHost);
    localStorage.setItem("zion.mail.smtp.port", next.smtpPort);
    localStorage.setItem("zion.mail.smtp.username", next.smtpUsername);
    localStorage.setItem("zion.mail.smtp.password", next.smtpPassword);
    writeBool("zion.mail.smtp.useTls", next.smtpUseTls);
    localStorage.setItem("zion.mail.fromEmail", next.fromEmail);
    localStorage.setItem("zion.mail.fromName", next.fromName);
    localStorage.setItem("zion.mail.recipients", JSON.stringify(next.recipients));
    localStorage.setItem("zion.mail.defaultRecipient", next.defaultRecipient || next.recipients[0] || "");
    writeBool("zion.mail.notifyAlways", next.notifyAlways);
    writeBool("zion.mail.debug", next.debug);
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({
        host: next.smtpHost,
        port: next.smtpPort,
        secure: next.smtpUseTls,
        user: next.smtpUsername,
        pass: next.smtpPassword,
        from: next.fromEmail,
        to: next.recipients,
        notify: next.notifyAlways,
        debug: next.debug
      })
    );
  } catch (error) {
    return { ok: false, errors: { _form: error instanceof Error ? error.message : String(error) } };
  }

  try { window.zion?.state?.set("mail.notifyAlways", next.notifyAlways); } catch {}
  try { window.zion?.state?.set("mail.debug", next.debug); } catch {}

  return {
    ok: true,
    value: {
      ...next,
      defaultRecipient: next.defaultRecipient || next.recipients[0] || ""
    }
  };
}

export function updateMailSettings(patch) {
  return saveMailSettings({ ...getMailSettings(), ...patch });
}
