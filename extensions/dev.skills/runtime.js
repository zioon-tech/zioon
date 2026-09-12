import {
  buildAvailableSkillsContextXml,
  insertAfterLeadingSystem,
  normalizeSkillsSnapshot,
  SKILLS_RUNTIME_SNAPSHOT_KEY,
  SKILLS_RUNTIME_STATE_NAMESPACE
} from "./skills-runtime-shared.js";

export const runtimePluginApiVersion = 2;

class RuntimeSkillsContextProvider {
  constructor({ state }) {
    this.id = "dev.skills.available";
    this.stage = "pre";
    this.order = 25;
    this.state = state;
  }

  async contribute(messages, context = {}) {
    if ((Array.isArray(messages) ? messages : []).some((message) =>
      typeof message?.content === "string"
      && message.content.includes("<available_skills>")
    )) {
      return messages;
    }
    const snapshot = normalizeSkillsSnapshot(
      this.state.get(SKILLS_RUNTIME_SNAPSHOT_KEY) || {}
    );
    const sessionEnabled = context?.request?.metadata?.skills?.enabled;
    const effectiveSnapshot = Array.isArray(sessionEnabled)
      ? {
          ...snapshot,
          enabled: Array.from(new Set(
            sessionEnabled.map(String).map((value) => value.trim()).filter(Boolean)
          ))
        }
      : snapshot;
    if (!effectiveSnapshot.enabled.length || !effectiveSnapshot.catalog.length) {
      return messages;
    }
    const content = buildAvailableSkillsContextXml(effectiveSnapshot);
    return insertAfterLeadingSystem(messages, {
      role: "user",
      content
    });
  }
}

export function activateRuntimePlugin(context) {
  const state = context.state.namespace(SKILLS_RUNTIME_STATE_NAMESPACE);
  const provider = new RuntimeSkillsContextProvider({ state });
  const providerRegistration = context.context.registerProvider(provider);
  const toolRegistration = context.tools.registerTool({
    name: "skillsList",
    description: "List enabled Agent skills from the Runtime-backed skills catalog.",
    inputSchema: {
      type: "object",
      properties: {
        enabled_only: {
          type: "boolean",
          description: "When true, return only enabled skills."
        }
      },
      additionalProperties: false
    },
    policy: {
      minimumPreset: "read-only"
    },
    async invoke(args = {}) {
      const snapshot = normalizeSkillsSnapshot(
        state.get(SKILLS_RUNTIME_SNAPSHOT_KEY) || {}
      );
      const enabled = new Set(snapshot.enabled);
      const skills = snapshot.catalog
        .filter((skill) => !args.enabled_only || enabled.has(skill.id))
        .map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          enabled: enabled.has(skill.id),
          file: skill.file || (skill.path ? `${skill.path}/SKILL.md` : "")
        }));
      return {
        ok: true,
        content: JSON.stringify({
          total: snapshot.catalog.length,
          enabled: enabled.size,
          skills
        }, null, 2)
      };
    }
  });
  return {
    dispose() {
      providerRegistration.dispose();
      toolRegistration.dispose();
    }
  };
}
