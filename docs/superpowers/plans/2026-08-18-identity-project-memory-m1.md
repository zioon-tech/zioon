# Identity Project Memory M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded, model-maintained project working memory to `dev.identity` without changing Biography history or adding autonomous execution.

**Architecture:** A new pure `projects-core.js` module owns templates, clipping, and project-context instructions. `identity-core.js` composes that block with existing profile memory, while `main.js` remains the only local-tools I/O boundary and initializes/loads the project files.

**Tech Stack:** JavaScript ES modules, Zion extension APIs, local-tools HTTP file API, Vitest.

---

## File Structure

- Create `extensions/dev.identity/projects-core.js`: project templates, clipping, XML-safe context block, and maintenance instructions.
- Create `tests/identity-projects-core.test.js`: focused pure-function coverage.
- Modify `extensions/dev.identity/identity-core.js`: compose the project block into `identity_context`.
- Modify `extensions/dev.identity/main.js`: resolve project paths, initialize scaffold files, and load the index.
- Modify `tests/identity-plugin.test.js`: integration coverage for context loading, snapshots, and initialization.
- Modify `extensions/dev.identity/manifest.json`: describe project working memory in plugin presentation metadata.

### Task 1: Pure Project Memory Module

**Files:**
- Create: `extensions/dev.identity/projects-core.js`
- Create: `tests/identity-projects-core.test.js`

- [ ] **Step 1: Write failing template and context tests**

```js
import { describe, expect, it } from "vitest";
import {
  PROJECT_INDEX_TEMPLATE,
  PROJECT_INBOX_TEMPLATE,
  buildProjectContext,
  buildProjectTemplate
} from "../extensions/dev.identity/projects-core.js";

describe("identity project memory core", () => {
  it("provides stable project scaffold templates", () => {
    expect(PROJECT_INDEX_TEMPLATE).toContain("# 项目索引");
    expect(PROJECT_INBOX_TEMPLATE).toContain("# 杂思收集箱");
    const template = buildProjectTemplate({ project: "示例项目", date: "2026-08-18" });
    expect(template).toContain('project: "示例项目"');
    expect(template).toContain("autonomy: none");
    expect(template).toContain("## 经验教训");
  });

  it("builds an escaped bounded project context", () => {
    const context = buildProjectContext(`# Index\n${"A < B & C ".repeat(20)}`, { maxChars: 80 });
    expect(context.fragment).toContain("<projects_index");
    expect(context.fragment).toContain("&lt;");
    expect(context.fragment).toContain("&amp;");
    expect(context.fragment).toContain("[truncated]");
    expect(context.instructions.join("\n")).toContain("model-maintained working memory");
  });

  it("returns no block for an empty index", () => {
    expect(buildProjectContext("")).toEqual({ fragment: "", instructions: [] });
  });
});
```

- [ ] **Step 2: Run the focused test and verify module-not-found failure**

Run: `npx vitest run tests/identity-projects-core.test.js`

Expected: FAIL because `extensions/dev.identity/projects-core.js` does not exist.

- [ ] **Step 3: Implement templates, clipping, escaping, and maintenance instructions**

Create the module:

```js
const DEFAULT_PROJECT_INDEX_LIMIT = 1600;
const TRUNCATION_MARKER = "\n[truncated]";

function clipCharacters(value, maxChars) {
  const chars = Array.from(String(value || "").trim());
  const limit = Math.max(0, Number(maxChars) || 0);
  if (!limit || chars.length <= limit) return chars.join("");
  const marker = Array.from(TRUNCATION_MARKER);
  if (limit <= marker.length) return marker.slice(0, limit).join("");
  return `${chars.slice(0, limit - marker.length).join("")}${TRUNCATION_MARKER}`;
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function yamlString(value) {
  return JSON.stringify(String(value || ""));
}

export const PROJECT_INDEX_TEMPLATE = `# 项目索引

| 项目 | 状态 | 优先级 | 下一步 | 更新 |
|---|---|---|---|---|
`;

export const PROJECT_INBOX_TEMPLATE = `# 杂思收集箱

> 未成形的想法先记录在这里；同一想法再次出现时提议立项。
`;

export function buildProjectTemplate(options = {}) {
  const project = String(options.project || "project-name").trim() || "project-name";
  const date = String(options.date || "").trim();
  return `---
project: ${yamlString(project)}
status: active
priority: medium
owner: user
autonomy: none
next_due:
wait_until:
created: ${date}
updated: ${date}
tags: []
---

# ${project}

## 目标

## 当前状态
- 进度：
- 下一步：
- 阻塞：
- 等待：

## 计划

## 时间线

## 产物与资源

## 使用姿势

## 经验教训

## 关联
`;
}

export const PROJECT_FILE_TEMPLATE = buildProjectTemplate();

export function buildProjectContext(index, options = {}) {
  const content = clipCharacters(index, options.maxChars ?? DEFAULT_PROJECT_INDEX_LIMIT);
  if (!content) return { fragment: "", instructions: [] };
  return {
    fragment: [
      '<projects_index source="~/.zion-next/memory/projects/index.md">',
      `  <content>${escapeXml(content)}</content>`,
      "</projects_index>"
    ].join("\n"),
    instructions: [
      "Treat ~/.zion-next/memory/projects as model-maintained working memory.",
      "Before editing an existing project, read its project.md and preserve its fixed frontmatter and section structure.",
      "Only substantive progress, decisions, milestones, blocker changes, or completed plan items justify a project update.",
      "When project.md changes, update the matching one-line entry in projects/index.md in the same turn.",
      "Record a first-time unformed idea as one line in projects/inbox.md; when it recurs, propose creating a project and wait for user confirmation.",
      "Do not infer autonomy grants, deadlines, completion, blockers, project ownership, or user beliefs."
    ]
  };
}
```

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/identity-projects-core.test.js`

Expected: PASS.

- [ ] **Step 5: Commit the pure module**

```bash
git add extensions/dev.identity/projects-core.js tests/identity-projects-core.test.js
git commit -m "feat(identity): add project memory core"
```

### Task 2: Compose Project Memory Into Identity Context

**Files:**
- Modify: `extensions/dev.identity/identity-core.js`
- Modify: `tests/identity-plugin.test.js`

- [ ] **Step 1: Extend the existing context test**

Pass `projects: "# 项目索引\n| Zion | active |"` to
`buildIdentityContext()` and assert:

```js
expect(text).toContain("<projects_index");
expect(text).toContain("Zion");
expect(text).toContain("model-maintained working memory");
expect(text).toContain("identity.md and biography");
```

Also assert that omitting `projects` produces no `<projects_index>` block.

- [ ] **Step 2: Run the context test and verify failure**

Run: `npx vitest run tests/identity-plugin.test.js -t "builds escaped context"`

Expected: FAIL because project input is ignored.

- [ ] **Step 3: Delegate project block construction**

Import `buildProjectContext` into `identity-core.js`, add
`projects: 1600` to `DEFAULT_CONTEXT_LIMITS`, and append the returned fragment
and instructions without duplicating project-specific logic.

Replace the blanket memory read-only instruction with path-specific rules:
Identity and Biography stay read-only; `user.md` remains restricted;
`projects/` follows the project-maintenance contract.

- [ ] **Step 4: Run identity core tests**

Run: `npx vitest run tests/identity-plugin.test.js -t "identity context core"`

Expected: PASS.

- [ ] **Step 5: Commit context composition**

```bash
git add extensions/dev.identity/identity-core.js tests/identity-plugin.test.js
git commit -m "feat(identity): inject project working memory"
```

### Task 3: Initialize and Load Project Files

**Files:**
- Modify: `extensions/dev.identity/main.js`
- Modify: `tests/identity-plugin.test.js`

- [ ] **Step 1: Add integration assertions**

Update fetch fixtures so `projects/index.md` returns a project row and assert a
new/refreshed Identity context contains it. Add an initialization test that
captures POST writes and verifies exactly these missing files are created:

```text
/Users/test/.zion-next/memory/projects/index.md
/Users/test/.zion-next/memory/projects/inbox.md
/Users/test/.zion-next/memory/projects/_template.md
```

Run initialization twice and assert the second call creates nothing.

- [ ] **Step 2: Run integration tests and verify failure**

Run: `npx vitest run tests/identity-plugin.test.js`

Expected: FAIL because project paths are unresolved and the index is unread.

- [ ] **Step 3: Extend the I/O boundary**

In `getProfilePaths()`, add:

```js
projectsIndex: `${root}/projects/index.md`,
projectsInbox: `${root}/projects/inbox.md`,
projectsTemplate: `${root}/projects/_template.md`
```

Read `projectsIndex` alongside identity, user, and digest in
`loadIdentityContext()`, then call:

```js
buildIdentityContext({ identity, user, biography, projects })
```

Add the three project templates to `initializeProfileFiles()`. Preserve the
existing read-if-present behavior so initialization never overwrites content.

- [ ] **Step 4: Run integration tests**

Run: `npx vitest run tests/identity-plugin.test.js`

Expected: PASS.

- [ ] **Step 5: Commit plugin integration**

```bash
git add extensions/dev.identity/main.js tests/identity-plugin.test.js
git commit -m "feat(identity): initialize project working memory"
```

### Task 4: Presentation and Regression Verification

**Files:**
- Modify: `extensions/dev.identity/manifest.json`

- [ ] **Step 1: Update plugin presentation**

Add project working memory to the localized description/features and update the
local-files permission text to include project files. Do not add a command,
view, skill, or new data location.

- [ ] **Step 2: Run focused tests**

Run:

```bash
npx vitest run tests/identity-projects-core.test.js tests/identity-plugin.test.js tests/plugin-details.test.js
```

Expected: PASS.

- [ ] **Step 3: Run lint and the full test suite**

Run:

```bash
npx eslint extensions/dev.identity/projects-core.js extensions/dev.identity/identity-core.js extensions/dev.identity/main.js
npm test -- --run
```

Expected: all commands exit 0.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; unrelated pre-existing worktree changes remain
untouched.

- [ ] **Step 5: Commit presentation metadata**

```bash
git add extensions/dev.identity/manifest.json
git commit -m "docs(identity): describe project working memory"
```
