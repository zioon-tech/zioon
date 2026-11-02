export const MAIL_MANAGE_TOOL_NAME = "mailManage";
export const MAIL_RUNTIME_PLUGIN_ID = "dev.mail";
export const MAIL_RUNTIME_STATE_NAMESPACE = "mail";
export const DEFAULT_INTERACTION_PROFILE_ID = "interactive.default";

export const MAIL_MANAGE_ACTIONS = [
  "list",
  "add_recipient",
  "remove_recipient",
  "set_default_recipient",
  "set_notify_always",
  "set_notify_once_for_session"
];

const EMAIL_RE = /^\S+@\S+\.[^\s@]+$/;
const TRUSTED_AUTOMATION_TOOLS = new Set([
  "Bash",
  "sendMail",
  "todoWrite",
  "mcpCall",
  "schedulerManage",
  "modelsManage",
  "toolsManage",
  "mailManage"
]);
const WORKSPACE_WRITE_TOOLS = new Set([
  "write",
  "edit",
  "sessionCreate",
  "sessionUpdate",
  "sessionDelete"
]);

function uniqueStrings(values = []) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  ));
}

export function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : "";
}

export function normalizeRecipients(values = []) {
  return uniqueStrings(values)
    .map(normalizeEmail)
    .filter(Boolean);
}

export function mailManageToolDefinition() {
  return {
    name: MAIL_MANAGE_TOOL_NAME,
    description: "Manage Runtime mail sending policy for an InteractionProfile. Recipients are stored as policy.allowedRecipients and sendMail is enabled only when the profile has an allowlist and quota.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: MAIL_MANAGE_ACTIONS,
          description: "Mail policy action"
        },
        email: {
          type: "string",
          description: "Recipient email address"
        },
        session_id: {
          type: "string",
          description: "Session id for notify-once state"
        },
        enabled: {
          type: "boolean",
          description: "Enable/disable flag"
        },
        interaction_profile_id: {
          type: "string",
          description: "Runtime InteractionProfile id. Defaults to interactive.default."
        }
      },
      required: ["action"],
      additionalProperties: false
    }
  };
}

export function mailMetadata(profile = {}) {
  const mail = profile?.metadata?.mail;
  return mail && typeof mail === "object" && !Array.isArray(mail)
    ? {
        defaultRecipient: normalizeEmail(mail.defaultRecipient),
        notifyAlways: mail.notifyAlways === true
      }
    : {
        defaultRecipient: "",
        notifyAlways: false
      };
}

export function summarizeMailProfile(profile = {}, notifyOnceSessionIds = []) {
  const recipients = normalizeRecipients(profile?.policy?.allowedRecipients || []);
  const metadata = mailMetadata(profile);
  const defaultRecipient = metadata.defaultRecipient && recipients.includes(metadata.defaultRecipient)
    ? metadata.defaultRecipient
    : (recipients[0] || "");
  return {
    interactionProfileId: profile.id || DEFAULT_INTERACTION_PROFILE_ID,
    recipients,
    default_recipient: defaultRecipient,
    notify_always: metadata.notifyAlways,
    notify_once_sessions: uniqueStrings(notifyOnceSessionIds),
    send_mail_enabled: Array.isArray(profile?.policy?.allowedTools)
      && profile.policy.allowedTools.includes("sendMail")
      && recipients.length > 0
      && Number(profile?.policy?.maxMailPerRun || 0) > 0,
    max_mail_per_run: Math.max(0, Number(profile?.policy?.maxMailPerRun || 0))
  };
}

function inferPreset(allowedTools = []) {
  if (allowedTools.some((name) => TRUSTED_AUTOMATION_TOOLS.has(name))) {
    return "trusted-automation";
  }
  if (allowedTools.some((name) => WORKSPACE_WRITE_TOOLS.has(name))) {
    return "workspace-write";
  }
  return "read-only";
}

export function buildMailProfilePatch(profile = {}, {
  recipients = profile?.policy?.allowedRecipients || [],
  defaultRecipient,
  notifyAlways
} = {}) {
  const normalizedRecipients = normalizeRecipients(recipients);
  const currentPolicy = profile.policy || {};
  const allowedTools = uniqueStrings(currentPolicy.allowedTools || []);
  const nextTools = new Set(allowedTools);
  if (normalizedRecipients.length) nextTools.add("sendMail");
  else nextTools.delete("sendMail");
  const nextAllowedTools = uniqueStrings(Array.from(nextTools));
  const currentMail = mailMetadata(profile);
  const nextDefault = normalizeEmail(defaultRecipient);
  const safeDefault = nextDefault && normalizedRecipients.includes(nextDefault)
    ? nextDefault
    : (normalizedRecipients.includes(currentMail.defaultRecipient)
        ? currentMail.defaultRecipient
        : (normalizedRecipients[0] || ""));
  return {
    policy: {
      allowedTools: nextAllowedTools,
      preset: inferPreset(nextAllowedTools),
      allowedRecipients: normalizedRecipients,
      maxMailPerRun: normalizedRecipients.length
        ? Math.max(1, Number(currentPolicy.maxMailPerRun || 10))
        : 0
    },
    metadata: {
      mail: {
        ...currentMail,
        defaultRecipient: safeDefault,
        notifyAlways: notifyAlways === undefined
          ? currentMail.notifyAlways
          : notifyAlways === true
      }
    }
  };
}
