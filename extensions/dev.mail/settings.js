import {
  getMailSettings,
  MAIL_SETTINGS_DEFAULTS,
  saveMailSettings,
  validateMailSettings
} from "./mail-settings-store.js";

function readField(field) {
  const settings = getMailSettings();
  return settings[field];
}

function writeField(field, value) {
  const result = saveMailSettings({ ...getMailSettings(), [field]: value });
  if (!result.ok) {
    throw new Error(result.errors?.[field] || result.errors?._form || "保存失败");
  }
}

function validateField(field, value) {
  const errors = validateMailSettings({ ...getMailSettings(), [field]: value });
  return errors[field] || null;
}

export function registerMailSettings() {
  try {
    if (window.zion?.settings?.registerPage) {
      window.zion.settings.registerPage({
        id: "services.mail",
        title: "Mail",
        titleKey: "dev.mail.settings.title",
        description: "配置 SMTP 发信、默认收件人和会话结束通知。",
        descriptionKey: "dev.mail.settings.description",
        category: "services",
        order: 20,
        pluginId: "dev.mail",
        keywords: ["smtp", "email", "recipient", "notification", "debug"],
        sections: [
          {
            id: "mail.smtp",
            title: "SMTP",
            titleKey: "dev.mail.settings.smtp.title",
            description: "定义真正用于发送邮件的 SMTP 连接参数。",
            descriptionKey: "dev.mail.settings.smtp.description",
            settings: [
              {
                id: "mail.smtp.host",
                label: "SMTP Host",
                description: "例如 `smtp.example.com`。",
                descriptionKey: "dev.mail.settings.smtpHost.description",
                kind: "string",
                controlLayout: "wide",
                scope: "application",
                order: 10,
                placeholder: "smtp.example.com",
                getValue: () => readField("smtpHost"),
                setValue: (value) => writeField("smtpHost", value),
                defaultValue: MAIL_SETTINGS_DEFAULTS.smtpHost
              },
              {
                id: "mail.smtp.port",
                label: "SMTP Port",
                description: "常见端口如 `465` 或 `587`。",
                descriptionKey: "dev.mail.settings.smtpPort.description",
                kind: "number",
                scope: "application",
                order: 20,
                placeholder: MAIL_SETTINGS_DEFAULTS.smtpPort,
                inputMode: "numeric",
                getValue: () => readField("smtpPort"),
                setValue: (value) => writeField("smtpPort", value),
                validate: (value) => validateField("smtpPort", value),
                defaultValue: MAIL_SETTINGS_DEFAULTS.smtpPort
              },
              {
                id: "mail.smtp.username",
                label: "SMTP Username",
                description: "通常是邮箱地址或服务账号。",
                descriptionKey: "dev.mail.settings.smtpUsername.description",
                kind: "string",
                controlLayout: "wide",
                scope: "application",
                order: 30,
                placeholder: "user@example.com",
                getValue: () => readField("smtpUsername"),
                setValue: (value) => writeField("smtpUsername", value),
                defaultValue: MAIL_SETTINGS_DEFAULTS.smtpUsername
              },
              {
                id: "mail.smtp.password",
                label: "SMTP Password",
                description: "建议使用 app-specific password。",
                descriptionKey: "dev.mail.settings.smtpPassword.description",
                kind: "password",
                controlLayout: "wide",
                scope: "application",
                order: 40,
                placeholder: "app-specific password",
                getValue: () => readField("smtpPassword"),
                setValue: (value) => writeField("smtpPassword", value),
                defaultValue: MAIL_SETTINGS_DEFAULTS.smtpPassword,
                dangerous: true
              },
              {
                id: "mail.smtp.useTls",
                label: "Use TLS",
                description: "与 Mail 服务配置保持一致。",
                descriptionKey: "dev.mail.settings.useTls.description",
                kind: "boolean",
                scope: "application",
                order: 50,
                getValue: () => readField("smtpUseTls"),
                setValue: (value) => writeField("smtpUseTls", value),
                defaultValue: MAIL_SETTINGS_DEFAULTS.smtpUseTls
              }
            ]
          },
          {
            id: "mail.identity",
            title: "Identity",
            titleKey: "dev.mail.settings.identity.title",
            description: "配置发件人展示信息。",
            descriptionKey: "dev.mail.settings.identity.description",
            settings: [
              {
                id: "mail.from.email",
                label: "From Email",
                description: "发件人邮箱地址。",
                descriptionKey: "dev.mail.settings.fromEmail.description",
                kind: "string",
                controlLayout: "wide",
                scope: "application",
                order: 10,
                placeholder: MAIL_SETTINGS_DEFAULTS.fromEmail,
                inputMode: "email",
                getValue: () => readField("fromEmail"),
                setValue: (value) => writeField("fromEmail", value),
                validate: (value) => validateField("fromEmail", value),
                defaultValue: MAIL_SETTINGS_DEFAULTS.fromEmail
              },
              {
                id: "mail.from.name",
                label: "From Name",
                description: "显示给收件人的发件人名称。",
                descriptionKey: "dev.mail.settings.fromName.description",
                kind: "string",
                controlLayout: "wide",
                scope: "application",
                order: 20,
                placeholder: MAIL_SETTINGS_DEFAULTS.fromName,
                getValue: () => readField("fromName"),
                setValue: (value) => writeField("fromName", value),
                defaultValue: MAIL_SETTINGS_DEFAULTS.fromName
              }
            ]
          },
          {
            id: "mail.recipients",
            title: "Recipients",
            titleKey: "dev.mail.settings.recipients.title",
            description: "管理默认收件人和通知发信对象。",
            descriptionKey: "dev.mail.settings.recipients.description",
            settings: [
              {
                id: "mail.recipients.list",
                label: "Recipients",
                description: "支持逗号、分号或换行分隔多个邮箱地址。",
                descriptionKey: "dev.mail.settings.recipientsList.description",
                kind: "textarea",
                controlLayout: "wide",
                scope: "application",
                order: 10,
                placeholder: "alice@example.com\nbob@example.com",
                getValue: () => (readField("recipients") || []).join("\n"),
                setValue: (value) => writeField("recipients", value),
                validate: (value) => validateField("recipients", value),
                defaultValue: ""
              },
              {
                id: "mail.recipients.default",
                label: "Default Recipient",
                description: "留空时会回退到收件人列表中的第一个地址。",
                descriptionKey: "dev.mail.settings.defaultRecipient.description",
                kind: "string",
                controlLayout: "wide",
                scope: "application",
                order: 20,
                placeholder: "alice@example.com",
                inputMode: "email",
                getValue: () => readField("defaultRecipient"),
                setValue: (value) => writeField("defaultRecipient", value),
                validate: (value) => validateField("defaultRecipient", value),
                defaultValue: MAIL_SETTINGS_DEFAULTS.defaultRecipient
              }
            ]
          },
          {
            id: "mail.notifications",
            title: "Notifications",
            titleKey: "dev.mail.settings.notifications.title",
            description: "控制会话结束后的发信和调试输出。",
            descriptionKey: "dev.mail.settings.notifications.description",
            settings: [
              {
                id: "mail.notify.always",
                label: "Auto Notify",
                description: "会话结束后默认尝试发信。",
                descriptionKey: "dev.mail.settings.autoNotify.description",
                kind: "boolean",
                scope: "application",
                order: 10,
                getValue: () => readField("notifyAlways"),
                setValue: (value) => writeField("notifyAlways", value),
                defaultValue: MAIL_SETTINGS_DEFAULTS.notifyAlways
              },
              {
                id: "mail.debug",
                label: "Debug Mode",
                description: "输出更多 mail 调试日志。",
                descriptionKey: "dev.mail.settings.debug.description",
                kind: "boolean",
                scope: "application",
                order: 20,
                getValue: () => readField("debug"),
                setValue: (value) => writeField("debug", value),
                defaultValue: MAIL_SETTINGS_DEFAULTS.debug
              },
              {
                id: "mail.panel.open",
                label: "Open Compact Mail Panel",
                labelKey: "dev.mail.settings.openPanel.label",
                description: "打开原有的紧凑 Mail 配置面板，便于调试或快速调整。",
                descriptionKey: "dev.mail.settings.openPanel.description",
                kind: "action",
                scope: "plugin",
                order: 30,
                actionLabel: "打开面板",
                actionLabelKey: "dev.mail.settings.openPanel.action",
                run: () => window.zion?.commands?.executeCommand?.("tools.openMailConfig")
              }
            ]
          }
        ]
      });
    }
  } catch (e) {
    console.warn("[dev.mail] failed to register settings page", e);
  }
}
