# ADR-2024-08-08 — 主题系统（Light / Dark）

Status: Proposed
Date: 2024-08-08
Authors: zion-next core

## 背景与目标

- 需求：为整个应用提供可切换的日间（Light）/夜间（Dark）主题，默认 Dark（与当前 oneDark 风格保持一致）。
- 约束：不破坏现有扩展 API，采用 CSS 变量 + data-theme 实现全局配色切换；编辑器（CM6）主题通过 Compartment 动态切换。
- 兼容：WYSIWYG 样式使用 CSS 变量，跟随主题变量即可；避免引入与扩展冲突的全局样式。

## 设计原则

1) 样式以 CSS 变量为核心，通过在 html/body 上设置 data-theme 切换变量集。
2) 编辑器主题采用 Compartment 动态切换（Dark 使用 oneDark，Light 使用默认主题扩展集）。
3) 主题选择持久化在 localStorage('zion.theme')；通过 StateBus 发布到 `ui.theme`，扩展可监听。
4) 提供命令与状态栏按钮，允许用户在 UI 中切换主题。

## 技术方案

- CSS
  - :root 保持 Dark 变量作为默认值。
  - :root[data-theme="light"] 定义 Light 变量覆盖。
- EditorCore
  - 新增 `themeComp`（Compartment）与 `setTheme(theme)` 方法。
  - Dark -> reconfigure(oneDark)；Light -> reconfigure([]) 使用默认主题。
- 启动流程（main.ts）
  - 读取 localStorage('zion.theme')，设置 document.documentElement 的 data-theme。
  - 调用 `core.setTheme(theme)` 应用到编辑器。
  - 注册命令：
    - `zion.setTheme('light'|'dark')`
    - `zion.toggleTheme()`
  - 状态栏按钮 `Theme: Light/Dark`，点击切换。
  - 发布状态 `window.zion.state.set('ui.theme', theme)` 供扩展感知。

## 里程碑

M1（本次）
- Light/Dark 切换、持久化、命令与状态栏按钮、CM6 主题切换。

M2
- 主题扩展位（允许扩展注册主题包/配色档），提供统一注册/选择接口。

M3
- WYSIWYG 装饰与各控件在 Light 下的对比度与细节优化。
- 多实例（多编辑器/多窗口）下的主题同步策略。

## 风险与缓解

- 不同主题下的对比度与可读性差异：通过变量与微调样式优化。
- 主题切换闪烁（FOUC）：在启动尽快设置 data-theme；默认变量为 Dark，初始黑屏时间可忽略。

## 结论

采用 CSS 变量 + data-theme + CM6 Compartment 的方案最小可行、扩展兼容好，并具备向自定义主题扩展的空间。