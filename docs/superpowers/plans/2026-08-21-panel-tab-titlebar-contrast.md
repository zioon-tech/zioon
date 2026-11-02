# Panel Tab 与 PWA Title 栏层级区分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在默认日间主题中区分 PWA title 栏和主编辑区 panel tabs 栏的背景色。

**Architecture:** 复用现有 `--editor-tabsbar-bg` 主题 token，不修改 DOM、布局或分隔拖拽逻辑。默认日间主题将 tabs 栏设为 `#f8f9fb`，最终 tabs 栏规则改为读取该 token。

**Tech Stack:** CSS custom properties、Vite

---

### Task 1: 调整 Panel Tabs 背景

**Files:**
- Modify: `src/styles.css`

- [ ] **Step 1: 修改默认日间主题 token**

```css
--editor-tabsbar-bg: #f8f9fb;
```

- [ ] **Step 2: 让最终 tabs 栏规则使用主题 token**

```css
.zion-editor-tabsbar {
  background: var(--editor-tabsbar-bg);
}
```

- [ ] **Step 3: 校验样式改动范围**

Run: `git diff --check -- src/styles.css`

Expected: 命令成功且无输出。

- [ ] **Step 4: 构建验证**

Run: `npm run build`

Expected: Vite 构建成功。

- [ ] **Step 5: 提交改动**

```bash
git add src/styles.css
git commit -m "fix(ui): distinguish panel tabs from titlebar"
```
