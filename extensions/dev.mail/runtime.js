import {
  DEFAULT_INTERACTION_PROFILE_ID,
  MAIL_MANAGE_ACTIONS,
  MAIL_MANAGE_TOOL_NAME,
  MAIL_RUNTIME_STATE_NAMESPACE,
  buildMailProfilePatch,
  mailManageToolDefinition,
  normalizeEmail,
  normalizeRecipients,
  summarizeMailProfile
} from "./mail-runtime-shared.js";

export const runtimePluginApiVersion = 2;

function requireMailService(context) {
  const service = context.config?.mailService;
  if (!service || typeof service !== "object") {
    throw new Error("Runtime mail management service is unavailable");
  }
  return service;
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

function profileIdFromArgs(args = {}) {
  return String(args.interaction_profile_id || DEFAULT_INTERACTION_PROFILE_ID).trim()
    || DEFAULT_INTERACTION_PROFILE_ID;
}

function notifyOnceKey(profileId, sessionId) {
  return `${profileId}.notifyOnce.${sessionId}`;
}

function notifyOnceSessionIds(state, profileId) {
  const prefix = `${profileId}.notifyOnce.`;
  return state.entries()
    .filter(([key, value]) => key.startsWith(prefix) && value === true)
    .map(([key]) => key.slice(prefix.length));
}

export function activateRuntimePlugin(context) {
  const service = requireMailService(context);
  const state = context.state.namespace(MAIL_RUNTIME_STATE_NAMESPACE);
  const definition = mailManageToolDefinition();
  const registration = context.tools.registerTool({
    name: MAIL_MANAGE_TOOL_NAME,
    description: definition.description,
    inputSchema: definition.inputSchema,
    policy: { minimumPreset: "trusted-automation" },
    async invoke(args = {}) {
      try {
        const action = String(args.action || "").trim();
        if (!MAIL_MANAGE_ACTIONS.includes(action)) {
          return {
            ok: false,
            content: `Unknown action: ${action}`,
            error: `Unknown action: ${action}`
          };
        }

        const profileId = profileIdFromArgs(args);
        const profile = service.getProfile(profileId);
        if (!profile) {
          return {
            ok: false,
            content: `InteractionProfile not found: ${profileId}`,
            error: `InteractionProfile not found: ${profileId}`
          };
        }

        if (action === "list") {
          return {
            ok: true,
            content: json(summarizeMailProfile(
              profile,
              notifyOnceSessionIds(state, profileId)
            ))
          };
        }

        if (action === "set_notify_once_for_session") {
          const sessionId = String(args.session_id || "").trim();
          if (!sessionId) {
            return { ok: false, content: "Missing session_id", error: "Missing session_id" };
          }
          const enabled = args.enabled !== false;
          state.set(notifyOnceKey(profileId, sessionId), enabled ? true : null);
          return {
            ok: true,
            content: json({
              interactionProfileId: profileId,
              session_id: sessionId,
              notify_once: enabled
            })
          };
        }

        const currentRecipients = normalizeRecipients(profile.policy?.allowedRecipients || []);
        let nextRecipients = currentRecipients;
        let defaultRecipient;
        let notifyAlways;

        if (action === "add_recipient") {
          const email = normalizeEmail(args.email);
          if (!email) return { ok: false, content: "Invalid email", error: "Invalid email" };
          nextRecipients = normalizeRecipients([...currentRecipients, email]);
          defaultRecipient = email;
        } else if (action === "remove_recipient") {
          const email = normalizeEmail(args.email);
          if (!email) return { ok: false, content: "Invalid email", error: "Invalid email" };
          nextRecipients = currentRecipients.filter((item) => item !== email);
        } else if (action === "set_default_recipient") {
          const email = normalizeEmail(args.email);
          if (!email) return { ok: false, content: "Invalid email", error: "Invalid email" };
          nextRecipients = normalizeRecipients([...currentRecipients, email]);
          defaultRecipient = email;
        } else if (action === "set_notify_always") {
          notifyAlways = args.enabled !== false;
        } else {
          return {
            ok: false,
            content: `Unsupported action: ${action}`,
            error: `Unsupported action: ${action}`
          };
        }

        const updated = service.patchProfile(profileId, buildMailProfilePatch(profile, {
          recipients: nextRecipients,
          defaultRecipient,
          notifyAlways
        }));
        return {
          ok: true,
          content: json(summarizeMailProfile(
            updated,
            notifyOnceSessionIds(state, profileId)
          ))
        };
      } catch (error) {
        context.log?.("error", `${MAIL_MANAGE_TOOL_NAME} failed: ${error?.message || error}`);
        return {
          ok: false,
          content: `mailManage error: ${error?.message || String(error)}`,
          error: error?.message || String(error)
        };
      }
    }
  });

  return {
    dispose() {
      registration.dispose();
    }
  };
}
