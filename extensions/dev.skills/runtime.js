import {
  buildAvailableSkillsContextXml,
  insertAfterLeadingSystem,
  normalizeSkillsSnapshot,
  SKILLS_LOCAL_RUNTIME_NODE_ID,
  SKILLS_RUNTIME_SNAPSHOT_KEY,
  SKILLS_RUNTIME_STATE_NAMESPACE
} from "./skills-runtime-shared.js";

export const runtimePluginApiVersion = 2;

function sourceStatusByNode(availableNodes, localSourceAvailable = false) {
  const nodes = typeof availableNodes === "function" ? availableNodes() : [];
  return {
    ...(localSourceAvailable ? { [SKILLS_LOCAL_RUNTIME_NODE_ID]: "online" } : {}),
    ...Object.fromEntries((Array.isArray(nodes) ? nodes : [])
    .map((node) => [String(node?.nodeId || ""), String(node?.status || "offline")])
    .filter(([nodeId]) => nodeId))
  };
}

function findSkill(snapshot, name) {
  const wanted = String(name || "").trim().toLowerCase();
  if (!wanted) return null;
  return snapshot.catalog.find((skill) =>
    String(skill.id).toLowerCase() === wanted
    || String(skill.name).toLowerCase() === wanted
  ) || null;
}

class RuntimeSkillsContextProvider {
  constructor({ state, availableNodes, localSourceAvailable }) {
    this.id = "dev.skills.available";
    this.stage = "pre";
    this.order = 25;
    this.state = state;
    this.availableNodes = availableNodes;
    this.localSourceAvailable = localSourceAvailable === true;
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
    const requestSkills = context?.request?.metadata?.skills || {};
    const sessionEnabled = requestSkills.enabled;
    const transientCatalog = Array.isArray(requestSkills.transientCatalog)
      ? requestSkills.transientCatalog.map((skill) => ({
          ...skill,
          transient: true
        }))
      : [];
    const catalogById = new Map(snapshot.catalog.map((skill) => [skill.id, skill]));
    for (const skill of transientCatalog) {
      const id = String(skill?.id || "").trim();
      if (id) catalogById.set(id, skill);
    }
    const effectiveSnapshot = Array.isArray(sessionEnabled)
      ? {
          ...snapshot,
          catalog: [...catalogById.values()],
          enabled: Array.from(new Set(
            sessionEnabled.map(String).map((value) => value.trim()).filter(Boolean)
          ))
        }
      : {
          ...snapshot,
          catalog: [...catalogById.values()]
        };
    if (!effectiveSnapshot.enabled.length || !effectiveSnapshot.catalog.length) {
      return messages;
    }
    const content = buildAvailableSkillsContextXml(effectiveSnapshot, {
      sourceStatusByNode: sourceStatusByNode(
        this.availableNodes,
        this.localSourceAvailable
      ),
      detailTool: "skillsList"
    });
    return insertAfterLeadingSystem(messages, {
      role: "user",
      content
    });
  }
}

export function activateRuntimePlugin(context) {
  const state = context.state.namespace(SKILLS_RUNTIME_STATE_NAMESPACE);
  const availableNodes = context.config?.availableNodes;
  const localSourceAvailable = context.config?.localSourceAvailable === true;
  const provider = new RuntimeSkillsContextProvider({
    state,
    availableNodes,
    localSourceAvailable
  });
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
        },
        name: {
          type: "string",
          description: "Optional skill id or name. Returns one resolved Runtime-cached skill."
        },
        include_body: {
          type: "boolean",
          description: "Include the Runtime-cached SKILL.md body for the selected skill."
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
      const statuses = sourceStatusByNode(availableNodes, localSourceAvailable);
      const enabled = new Set(snapshot.enabled);
      if (args.name) {
        const skill = findSkill(snapshot, args.name);
        if (!skill) {
          return {
            ok: false,
            content: JSON.stringify({
              error: "Skill not found",
              name: String(args.name)
            })
          };
        }
        const sourceStatus = statuses[skill.sourceNodeId] || "offline";
        return {
          ok: true,
          content: JSON.stringify({
            skill: {
              id: skill.id,
              name: skill.name,
              description: skill.description,
              enabled: enabled.has(skill.id),
              sourceNodeId: skill.sourceNodeId,
              sourceNodeLabel: skill.sourceNodeLabel,
              sourceStatus,
              runtimeCached: !!(skill.runtimeCached || skill.body),
              runtimeFile: skill.runtimeFile,
              runtimeNodeId: skill.runtimeNodeId,
              ...(args.include_body ? { body: skill.body || "" } : {}),
              executionNotice: sourceStatus === "online"
                ? "The source Node is online, but commands, credentials, and dependencies must still be verified before execution."
                : "The source Node is offline. Cached instructions are available for reasoning, but source-local commands, files, credentials, login state, and environment variables are not available."
            }
          }, null, 2)
        };
      }
      const skills = snapshot.catalog
        .filter((skill) => !args.enabled_only || enabled.has(skill.id))
        .map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          enabled: enabled.has(skill.id),
          file: skill.runtimeFile || skill.file || (skill.path ? `${skill.path}/SKILL.md` : ""),
          node_id: skill.runtimeNodeId || skill.sourceNodeId,
          sourceNodeId: skill.sourceNodeId,
          sourceStatus: statuses[skill.sourceNodeId] || "offline",
          runtimeCached: !!(skill.runtimeCached || skill.body)
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
