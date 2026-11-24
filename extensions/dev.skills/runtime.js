import {
  buildAvailableSkillsContextXml,
  insertAfterLeadingSystem,
  normalizeSkillsSnapshot,
  SKILLS_LOCAL_RUNTIME_NODE_ID,
  SKILLS_RUNTIME_PLUGIN_NODE_ID,
  SKILLS_RUNTIME_SNAPSHOT_KEY,
  SKILLS_RUNTIME_STATE_NAMESPACE
} from "./skills-runtime-shared.js";

export const runtimePluginApiVersion = 2;

function sourceStatusByNode(availableNodes, localSourceAvailable = false) {
  const nodes = typeof availableNodes === "function" ? availableNodes() : [];
  return {
    ...(localSourceAvailable ? { [SKILLS_LOCAL_RUNTIME_NODE_ID]: "online" } : {}),
    [SKILLS_RUNTIME_PLUGIN_NODE_ID]: "online",
    "runtime:marketplace": "online",
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

async function readSkillsSnapshot(state, marketplaceSkills, runContext) {
  const value = state.read
    ? await state.read(SKILLS_RUNTIME_SNAPSHOT_KEY)
    : state.get(SKILLS_RUNTIME_SNAPSHOT_KEY);
  const snapshot = normalizeSkillsSnapshot(value || {});
  if (!marketplaceSkills) return snapshot;
  const overlay = await marketplaceSkills(runContext);
  const ids = new Set(overlay.catalog.map((skill) => skill.id));
  return normalizeSkillsSnapshot({ ...snapshot,
    catalog: [...snapshot.catalog.filter((skill) => !ids.has(skill.id) && !skill.id.startsWith("marketplace:")), ...overlay.catalog],
    enabled: [...snapshot.enabled.filter((id) => !id.startsWith("marketplace:")), ...overlay.enabled] });
}

class RuntimeSkillsContextProvider {
  constructor({ state, availableNodes, localSourceAvailable, marketplaceSkills }) {
    this.id = "dev.skills.available";
    this.stage = "pre";
    this.order = 25;
    this.state = state;
    this.availableNodes = availableNodes;
    this.localSourceAvailable = localSourceAvailable === true;
    this.marketplaceSkills = marketplaceSkills;
  }

  async contribute(messages, context = {}) {
    if ((Array.isArray(messages) ? messages : []).some((message) =>
      typeof message?.content === "string"
      && message.content.includes("<available_skills>")
    )) {
      return messages;
    }
    const snapshot = await readSkillsSnapshot(this.state, this.marketplaceSkills, context);
    const requestSkills = context?.request?.metadata?.skills || {};
    const sessionEnabled = requestSkills.enabled;
    const transientCatalog = Array.isArray(requestSkills.transientCatalog)
      ? requestSkills.transientCatalog.filter((skill) => !String(skill?.id || "").startsWith("marketplace:")).map((skill) => ({
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
            sessionEnabled.map(String).map((value) => value.trim()).filter((id) =>
              id && (!id.startsWith("marketplace:") || snapshot.enabled.includes(id)))
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
  const marketplaceSkills = context.config?.marketplaceSkills;
  const marketplaceSkillFile = context.config?.marketplaceSkillFile;
  const skillFile = context.config?.skillFile;
  const prepareSkill = context.config?.prepareSkill;
  const provider = new RuntimeSkillsContextProvider({
    state,
    availableNodes,
    localSourceAvailable,
    marketplaceSkills
  });
  const providerRegistration = context.context.registerProvider(provider);
  const toolRegistration = context.tools.registerTool({
    name: "skillsList",
    description: "List enabled Agent skills from the Runtime-backed skills catalog.",
    execution: { effect: "read" },
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
        },
        file: {
          type: "string",
          description: "Read one cached reference or script without starting a Sandbox or source Node."
        },
        content_hash: {
          type: "string",
          description: "Require the contentHash from the previously retrieved Skill."
        }
      },
      additionalProperties: false
    },
    policy: {
      minimumPreset: "read-only"
    },
    async invoke(args = {}, runContext = {}) {
      const snapshot = await readSkillsSnapshot(state, marketplaceSkills, runContext);
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
        if (args.content_hash && args.content_hash !== skill.contentHash) return {
          ok: false, content: JSON.stringify({ error: "Skill content changed; retrieve the current version.", code: "skill_content_changed" })
        };
        let attachment;
        if (args.file) {
          const read = skill.id.startsWith("marketplace:") ? marketplaceSkillFile : skillFile;
          if (!read) return {
            ok: false, content: JSON.stringify({ error: "Packaged Skill file unavailable" })
          };
          attachment = await read(runContext, skill.id, args.file, args.content_hash || skill.contentHash);
        }
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
              contentHash: skill.contentHash, files: skill.files || [],
              ...(attachment ? { attachment } : {}),
              ...(args.include_body ? { body: skill.body || "" } : {}),
              executionNotice: skill.runtimeCached || skill.body
                ? skill.id.startsWith("marketplace:")
                  ? "Use this cached body as the Skill instructions. Read packaged files with skillsList(name, file, content_hash). Use extensionsCall workspace-prepare to materialize files on the authorized account workspace before running scripts."
                  : "Use this Runtime-cached body as the Skill instructions. Do not read sourceFile or use sourceNodeId for instruction retrieval. Read references/scripts with skillsList(name, file, content_hash). Before running bundled scripts, call skillsPrepare with id, content_hash and an explicit authorized node_id. Source-specific commands and credentials still require the source Node."
                : sourceStatus === "online"
                  ? "The source Node is online, but commands, credentials, and dependencies must still be verified before execution."
                : "The source Node is offline. Cached instructions are available for reasoning, but source-local commands, files, credentials, login state, and environment variables are not available."
            }
          }, null, 2)
        };
      }
      const skills = snapshot.catalog
        .filter((skill) => !args.enabled_only || enabled.has(skill.id))
        .map((skill) => {
          const cached = !!(skill.runtimeCached || skill.body);
          return {
            id: skill.id,
            name: skill.name,
            description: skill.description,
            enabled: enabled.has(skill.id),
            ...(!cached ? {
              file: skill.runtimeFile || skill.file || (skill.path ? `${skill.path}/SKILL.md` : ""),
              node_id: skill.runtimeNodeId || skill.sourceNodeId
            } : {}),
            sourceStatus: statuses[skill.sourceNodeId] || "offline",
            runtimeCached: cached,
            ...(cached ? {
              retrieval: "Call skillsList with this name and include_body=true."
            } : {})
          };
        });
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
  const prepareRegistration = prepareSkill ? context.tools.registerTool({
    name: "skillsPrepare",
    description: "Prepare an immutable cached Skill bundle on an explicitly selected authorized Node or account Sandbox before executing scripts. Does not execute scripts or transfer credentials.",
    execution: { effect: "process", timeoutMs: 600000, maxTimeoutMs: 600000 },
    policy: { minimumPreset: "trusted-automation" },
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "Exact Skill id from skillsList." },
      content_hash: { type: "string", description: "The contentHash returned by skillsList." },
      node_id: { type: "string", description: "Chosen authorized Node; managed:account selects this account's Sandbox." },
      workspace_root: { type: "string", description: "Absolute writable directory on a physical Node. Account Sandbox defaults to its plugin data directory." }
    }, required: ["name", "content_hash", "node_id"], additionalProperties: false },
    async invoke(args, runContext = {}) {
      const snapshot = await readSkillsSnapshot(state, marketplaceSkills, runContext);
      const skill = snapshot.catalog.find((entry) => entry.id === args.name);
      if (!skill) return { ok: false, content: JSON.stringify({ error: "Skill not found" }) };
      if (skill.id.startsWith("marketplace:")) return { ok: false, content: JSON.stringify({
        error: "Use extensionsCall workspace-prepare for installed marketplace Skills."
      }) };
      return prepareSkill(runContext, skill, args);
    }
  }) : null;
  return {
    dispose() {
      providerRegistration.dispose();
      toolRegistration.dispose();
      prepareRegistration?.dispose();
    }
  };
}
