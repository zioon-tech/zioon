const AUTOMATION_VERSION = 1;
const DEFAULT_CADENCE_MINUTES = 120;
const MIN_CADENCE_MINUTES = 15;
const MAX_CADENCE_MINUTES = 7 * 24 * 60;
const DEFAULT_MAX_TOOL_CALLS = 24;
const MAX_TOOL_CALLS = 80;
const DEFAULT_TIMEOUT_MINUTES = 10;
const MAX_TIMEOUT_MINUTES = 30;

function boundedNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function uniqueStrings(value, limit = 16) {
  return Array.from(new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
  )).slice(0, limit);
}

function timestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

export function normalizeProjectPolicy(input = {}) {
  const activeTaskId = String(input?.activeTaskId || "").trim().slice(0, 160);
  const requestedStatus = ["idle", "running", "success", "failed", "attention"].includes(
    input?.lastStatus
  )
    ? input.lastStatus
    : "idle";
  return {
    enabled: input?.enabled === true,
    mode: input?.mode === "execute" ? "execute" : "explore",
    cadenceMinutes: boundedNumber(
      input?.cadenceMinutes,
      DEFAULT_CADENCE_MINUTES,
      MIN_CADENCE_MINUTES,
      MAX_CADENCE_MINUTES
    ),
    fileRoots: uniqueStrings(input?.fileRoots),
    allowedCommandPrefixes: uniqueStrings(input?.allowedCommandPrefixes),
    maxToolCalls: boundedNumber(
      input?.maxToolCalls,
      DEFAULT_MAX_TOOL_CALLS,
      1,
      MAX_TOOL_CALLS
    ),
    timeoutMinutes: boundedNumber(
      input?.timeoutMinutes,
      DEFAULT_TIMEOUT_MINUTES,
      1,
      MAX_TIMEOUT_MINUTES
    ),
    nextEligibleAt: timestamp(input?.nextEligibleAt),
    lastRunAt: timestamp(input?.lastRunAt),
    lastCompletedAt: timestamp(input?.lastCompletedAt),
    lastStatus: requestedStatus === "running" && !activeTaskId ? "idle" : requestedStatus,
    lastPhase: ["research", "planning", "executing"].includes(input?.lastPhase)
      ? input.lastPhase
      : "",
    lastError: String(input?.lastError || "").trim().slice(0, 500),
    activeTaskId,
    failureCount: boundedNumber(input?.failureCount, 0, 0, 100),
    updatedAt: timestamp(input?.updatedAt)
  };
}

export function reconcileProjectRun(policy, task, actuallyRunning, now = Date.now()) {
  const current = normalizeProjectPolicy(policy);
  if (!current.activeTaskId) return null;
  if (task?.status === "running" && actuallyRunning === true) return null;
  const interrupted = task?.status === "running" && actuallyRunning !== true;
  return {
    activeTaskId: "",
    lastStatus: task?.status === "done" ? "success" : "failed",
    nextEligibleAt: now + current.cadenceMinutes * 60_000,
    lastError: interrupted
      ? "自动推进因应用或插件重启中断"
      : String(task?.error || current.lastError || "").trim()
  };
}

export function normalizeAutomationDocument(input = {}) {
  const projects = {};
  for (const [key, value] of Object.entries(input?.projects || {})) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey || normalizedKey.length > 160) continue;
    projects[normalizedKey] = normalizeProjectPolicy(value);
  }
  const requests = (Array.isArray(input?.requests) ? input.requests : [])
    .map((request) => normalizeAutomationRequest(request))
    .filter(Boolean)
    .slice(-40);
  return {
    version: AUTOMATION_VERSION,
    projects,
    requests
  };
}

export function updateProjectPolicy(document, projectKey, patch, now = Date.now()) {
  const current = normalizeAutomationDocument(document);
  const key = String(projectKey || "").trim();
  if (!key) return current;
  return {
    ...current,
    projects: {
      ...current.projects,
      [key]: normalizeProjectPolicy({
        ...(current.projects[key] || {}),
        ...(patch || {}),
        updatedAt: now
      })
    }
  };
}

function automationPatch(input = {}) {
  const patch = {};
  if (typeof input.enabled === "boolean") patch.enabled = input.enabled;
  if (input.mode === "explore" || input.mode === "execute") patch.mode = input.mode;
  if (input.cadenceMinutes !== undefined) {
    patch.cadenceMinutes = boundedNumber(
      input.cadenceMinutes,
      DEFAULT_CADENCE_MINUTES,
      MIN_CADENCE_MINUTES,
      MAX_CADENCE_MINUTES
    );
  }
  if (Array.isArray(input.fileRoots)) patch.fileRoots = uniqueStrings(input.fileRoots);
  if (Array.isArray(input.allowedCommandPrefixes)) {
    patch.allowedCommandPrefixes = uniqueStrings(input.allowedCommandPrefixes);
  }
  return patch;
}

export function normalizeAutomationRequest(input = {}) {
  const id = String(input?.id || "").trim().slice(0, 160);
  const projectKey = String(input?.projectKey || "").trim().slice(0, 160);
  const patch = automationPatch(input?.patch);
  if (!id || !projectKey || !Object.keys(patch).length) return null;
  return {
    id,
    projectKey,
    patch,
    reason: String(input?.reason || "").trim().slice(0, 500),
    status: ["pending", "approved", "rejected"].includes(input?.status)
      ? input.status
      : "pending",
    requestedAt: timestamp(input?.requestedAt) || Date.now(),
    resolvedAt: timestamp(input?.resolvedAt)
  };
}

export function addAutomationRequest(document, request) {
  const current = normalizeAutomationDocument(document);
  const normalized = normalizeAutomationRequest(request);
  if (!normalized) return current;
  return {
    ...current,
    requests: [
      ...current.requests.filter((item) => (
        item.id !== normalized.id
        && !(item.projectKey === normalized.projectKey && item.status === "pending")
      )),
      normalized
    ].slice(-40)
  };
}

export function resolveAutomationRequest(document, requestId, approved, now = Date.now()) {
  const current = normalizeAutomationDocument(document);
  const id = String(requestId || "").trim();
  const request = current.requests.find((item) => item.id === id && item.status === "pending");
  if (!request) return current;
  const withResolution = {
    ...current,
    requests: current.requests.map((item) => item.id === id
      ? {
          ...item,
          status: approved ? "approved" : "rejected",
          resolvedAt: now
        }
      : item)
  };
  return approved
    ? updateProjectPolicy(withResolution, request.projectKey, request.patch, now)
    : normalizeAutomationDocument(withResolution);
}

function frontmatterValue(markdown, key) {
  const source = String(markdown || "");
  const match = source.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return "";
  const line = match[1]
    .split(/\r?\n/)
    .find((item) => item.trim().toLowerCase().startsWith(`${key.toLowerCase()}:`));
  return String(line || "").split(":").slice(1).join(":").trim().replace(/^["']|["']$/g, "");
}

function markdownSection(markdown, title) {
  const source = String(markdown || "");
  const heading = new RegExp(`^##\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const match = heading.exec(source);
  if (!match) return "";
  const start = match.index + match[0].length;
  const rest = source.slice(start);
  const next = rest.search(/^##\s+/m);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

function meaningfulSection(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^[-*]\s*(?:\[[ xX]\]\s*)?/, "")
      .replace(/^(?:进度|下一步|阻塞|等待)\s*[：:]\s*/, "")
      .trim())
    .some((line) => line && line !== "暂无" && line !== "待补充");
}

function planItems(section) {
  return String(section || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/);
      if (!match) return null;
      return {
        done: match[1].toLowerCase() === "x",
        text: match[2].trim()
      };
    })
    .filter(Boolean);
}

export function inspectProjectReadiness(markdown, policy = {}) {
  const status = frontmatterValue(markdown, "status").toLowerCase();
  if (status === "done" || status === "archived") {
    return { kind: "none", reason: "terminal-status", status };
  }
  const goal = markdownSection(markdown, "目标");
  if (!meaningfulSection(goal)) {
    return { kind: "attention", reason: "missing-goal" };
  }
  const research = markdownSection(markdown, "调研");
  if (!meaningfulSection(research)) {
    return { kind: "run", phase: "research" };
  }
  const plan = markdownSection(markdown, "计划");
  const items = planItems(plan);
  if (!meaningfulSection(plan) || !items.length) {
    return { kind: "run", phase: "planning" };
  }
  if (policy?.mode !== "execute") {
    return { kind: "attention", reason: "plan-review" };
  }
  const next = items.find((item) => !item.done);
  if (!next) {
    return { kind: "attention", reason: "final-review" };
  }
  return {
    kind: "run",
    phase: "executing",
    nextStep: next.text
  };
}

export function selectAutomationCandidate(projects, document, now = Date.now(), options = {}) {
  const automation = normalizeAutomationDocument(document);
  const requestedKey = String(options.projectKey || "").trim();
  const candidates = (Array.isArray(projects) ? projects : [])
    .map((project) => {
      const key = String(project?.key || "").trim();
      return {
        ...project,
        key,
        policy: automation.projects[key] || normalizeProjectPolicy()
      };
    })
    .filter((project) => (
      project.key
      && project.policy.enabled
      && !project.policy.activeTaskId
      && (
        requestedKey
          ? project.key === requestedKey
          : !project.policy.nextEligibleAt || project.policy.nextEligibleAt <= now
      )
    ))
    .sort((left, right) => (
      left.policy.nextEligibleAt - right.policy.nextEligibleAt
      || left.policy.lastRunAt - right.policy.lastRunAt
      || left.key.localeCompare(right.key)
    ));
  return candidates[0] || null;
}

const PHASE_INSTRUCTIONS = {
  research: [
    "本次只补齐项目的基础调研，不执行实现。",
    "先读取项目档案和相关代码/资料，记录可验证事实、现状、约束和未知项。",
    "把结论写入 project.md 的「## 调研」；更新「当前状态」和 index.md。"
  ],
  planning: [
    "本次只形成可执行计划，不执行计划项。",
    "基于目标和调研，把「## 计划」改成按顺序排列的 Markdown checkbox。",
    "每个步骤必须可独立执行和验证；更新「当前状态」和 index.md。"
  ],
  executing: [
    "本次只推进一个计划项并完成验证。",
    "只推进一个计划项：{nextStep}",
    "验证通过后才能把该 checkbox 标为完成；失败或信息不足时保留未完成并记录阻塞。",
    "更新 project.md 的当前状态、时间线、经验教训和 index.md。"
  ]
};

export function buildAutomationTaskPrompt(input = {}) {
  const phase = PHASE_INSTRUCTIONS[input.phase] ? input.phase : "research";
  const instructions = PHASE_INSTRUCTIONS[phase]
    .map((line) => line.replace("{nextStep}", String(input.nextStep || "第一个未完成步骤")));
  return [
    `你正在受限自动推进项目「${input.project?.name || input.project?.key || "未命名项目"}」。`,
    `项目档案：${input.projectPath}`,
    `项目索引：${input.indexPath}`,
    `待处理事项：${input.attentionPath}`,
    "",
    ...instructions,
    "",
    "安全边界：",
    "- 开始前必须读取 project.md；不得依赖旧会话中的项目状态。",
    "- 不得直接修改任何自动化授权存储；需要调整时只能调用 projectAutomationManage。",
    "- 不得替用户推断目标、验收标准、截止时间或授权。",
    "- 遇到需要用户决策、权限不足或外部不可逆操作时立即停止，并在最终输出中明确说明。",
    "- 最终回答简要列出：本轮阶段、实际动作、验证结果、是否需要用户介入。"
  ].join("\n");
}

const ATTENTION_REASONS = {
  "missing-goal": "缺少明确目标，无法自动推进",
  "plan-review": "基础调研和计划已就绪，等待批准进入执行",
  "final-review": "计划项已全部完成，等待最终验收",
  "run-failed": "自动推进运行失败",
  "agents-unavailable": "Agents 运行时不可用",
  "project-missing": "项目档案不存在"
};

export function buildAttentionEntry(input = {}) {
  const at = String(input.at || new Date().toISOString());
  const reason = ATTENTION_REASONS[input.reason] || String(input.detail || input.reason || "需要用户处理");
  const detail = String(input.detail || "").trim();
  const markerKey = String(input.projectKey || input.projectName || "project")
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .slice(0, 120);
  const markerReason = String(input.reason || "attention").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return [
    `<!-- automation:${markerKey}:${markerReason} -->`,
    `- [ ] ${at} · **${input.projectName || "未命名项目"}** · ${reason}${detail && detail !== reason ? `：${detail}` : ""}`
  ].join("\n");
}
