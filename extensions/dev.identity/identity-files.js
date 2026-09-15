import { buildBiographyDigest } from "./identity-core.js";
import {
  PROJECT_FILE_TEMPLATE, PROJECT_INDEX_TEMPLATE,
  PROJECT_INBOX_TEMPLATE, PROJECT_ATTENTION_TEMPLATE
} from "./projects-core.js";

export const IDENTITY_TEMPLATE = `---
type: identity
version: 1
---

# 身份档案

## 名字与角色
- 名字：Zion
- 角色：运行于 Zion Next 的 AI 助手

## 工作原则
- 直接、诚实，以可验证的结果为准
`;

export const USER_TEMPLATE = `---
type: user-profile
version: 1
---

# 用户档案

## 基本信息
- 称呼：

## 偏好
- [user-stated] 中文交流，结论先行

## 边界
`;

export function identityInitialFiles() {
  return {
    identity: { relativePath: "identity.md", content: IDENTITY_TEMPLATE },
    user: { relativePath: "user.md", content: USER_TEMPLATE },
    biography: { relativePath: "biography/digest.md", content: buildBiographyDigest([]) },
    projects: { relativePath: "projects/index.md", content: PROJECT_INDEX_TEMPLATE },
    projectsInbox: { relativePath: "projects/inbox.md", content: PROJECT_INBOX_TEMPLATE },
    projectsAttention: { relativePath: "projects/attention.md", content: PROJECT_ATTENTION_TEMPLATE },
    template: { relativePath: "projects/_template.md", content: PROJECT_FILE_TEMPLATE }
  };
}

export async function ensureIdentityFiles(fileService, fileRoot, runContext = {}) {
  const initial = identityInitialFiles();
  const loaded = await fileService.readTextFiles({
    fileRoot,
    files: Object.fromEntries(Object.entries(initial).map(([key, spec]) => [key, spec.relativePath])),
    runContext
  });
  // Only explicit ENOENT may create a file. An empty document is still user data.
  const files = Object.fromEntries((loaded.missing || []).map((key) => [
    key, { ...initial[key], create_only: true }
  ]));
  if (!Object.keys(files).length) return loaded;
  await fileService.writeTextFiles({ fileRoot, files, runContext });
  // create_only may lose a race; use the stored content, not assumed defaults.
  const refreshed = await fileService.readTextFiles({
    fileRoot,
    files: Object.fromEntries(Object.entries(files).map(([key, spec]) => [key, spec.relativePath])),
    runContext
  });
  return {
    ...loaded,
    files: { ...loaded.files, ...refreshed.files },
    missing: refreshed.missing || []
  };
}
