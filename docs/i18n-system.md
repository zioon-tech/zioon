# Zion Next 多语言系统设计文档

## 目标

- 默认语言为简体中文。
- 第一阶段仅支持 `zh-CN` 和 `en-US`。
- 核心应用、设置页、命令面板、插件 UI 都通过同一套 i18n API 获取文案。
- 插件可以独立注册自己的语言包，不需要把文案集中塞进核心仓库。
- 语言切换是运行时行为，不要求刷新页面。

## 当前能力

核心在 `src/i18n/i18nManager.ts` 中提供 `window.zion.i18n`：

```ts
window.zion.i18n.getLocale();
window.zion.i18n.setLocale("zh-CN");
window.zion.i18n.toggleLocale();
window.zion.i18n.getSupportedLocales();
window.zion.i18n.registerNamespace("plugin.id", {
  "zh-CN": {
    "settings.title": "插件设置"
  },
  "en-US": {
    "settings.title": "Plugin Settings"
  }
});
window.zion.i18n.t("plugin.id.settings.title");
```

## 存储与状态

- localStorage key: `zion.locale`
- runtime state: `ui.locale`
- DOM attribute: `document.documentElement.lang`
- change event: `i18n/changed`

```ts
window.zion.events.on("i18n/changed", ({ locale, previousLocale }) => {
  // Re-render plugin UI if needed.
});
```

## 翻译 Key 规范

- 使用 namespace 隔离核心和插件文案。
- 推荐 namespace 使用插件 id，例如 `dev.langchain-chat`。
- key 使用点号路径，例如 `settings.title`、`command.run.title`。
- 调用时使用完整路径：`dev.langchain-chat.settings.title`。

## 插件接入建议

插件激活时注册语言包：

```js
const disposable = window.zion.i18n?.registerNamespace?.("my.plugin", {
  "zh-CN": {
    "settings.title": "我的插件",
    "command.open": "打开插件"
  },
  "en-US": {
    "settings.title": "My Plugin",
    "command.open": "Open Plugin"
  }
});

ctx.subscriptions.push(disposable);
```

渲染 UI 时读取翻译：

```js
const t = (key, values) => window.zion.i18n?.t?.(`my.plugin.${key}`, values) || key;
title.textContent = t("settings.title");
```

需要响应语言切换的 UI，监听事件并重新渲染：

```js
ctx.subscriptions.push(window.zion.events.on("i18n/changed", () => rerender()));
```

## 插值

`t()` 支持 `{name}` 形式的简单插值：

```js
window.zion.i18n.t("my.plugin.welcome", { name: "Zion" });
```

```js
window.zion.i18n.registerNamespace("my.plugin", {
  "zh-CN": { welcome: "欢迎使用 {name}" },
  "en-US": { welcome: "Welcome to {name}" }
});
```

## 命令

- `zion.setLanguage(locale)`
- `zion.toggleLanguage()`
- `zion.i18n.setLocale(locale)`
- `zion.i18n.getLocale()`
- `zion.i18n.getSupportedLocales()`

命令面板中执行 `zion.setLanguage` 或 `zion.i18n.setLocale` 时，会打开语言选择列表。

## 设置入口

当前设置入口位于：

- `Settings -> General -> Appearance -> 语言`

选项：

- `简体中文`
- `English`

## 迁移原则

- 新增 UI 文案优先走 `window.zion.i18n.t()`。
- 插件新增文案时，必须至少提供 `zh-CN`，推荐同步提供 `en-US`。
- 对已有大量硬编码文案的插件，优先迁移高频入口：设置页、命令标题、状态栏、弹窗、空状态。
- 不要在组件里直接判断 `locale === "zh-CN"` 拼文案，应该通过语言包维护差异。

## 后续计划

1. 把命令面板核心文案迁入 `core.commandPalette` namespace。
2. 把 Appearance 设置页文案迁入 `dev.editor-config` namespace。
3. 为插件 manifest 的 command title/description 增加 i18n 读取约定。
4. 为 React 设置页提供 `useZionI18n()` hook。
5. 增加缺失 key 的开发期 warning，帮助插件补齐英文文案。
