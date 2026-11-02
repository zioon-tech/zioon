# 12 设置面板（Settings Panel）

## 背景

Zion Next 的各类配置散落在不同位置：
- 服务 BaseUrl 由独立设置插件注册到统一设置中心
- Mail SMTP 配置由 `dev.mail` 插件自行管理
- Skills 配置在 `dev.skills` 插件内
- 文件系统句柄由 `dev.fs-manager` 管理

缺少一个**统一的设置入口**，用户需要知道每个配置在哪个插件里才能修改。

## 目标

1. 在左侧 Activity Bar 底部（和 ⌘ 命令按钮并排）添加 ⚙ 设置按钮
2. 点击弹出统一的设置面板（modal overlay）
3. **核心层只做注册 API + 面板壳子**，具体配置项由各插件自己注册
4. 历史上的 `dev.settings` 迁移掉，改为由各设置插件自行注册

## 架构

```
核心层 (src/settings/)
├── registry.ts          # SettingsRegistry：纯数据注册中心
├── SettingsPanel.ts     # 设置面板 UI：modal overlay
├── serviceBaseUrl.ts    # 现有，保持不变（纯数据层）
└── index.ts             # 统一导出

暴露到 window.zion：
  window.zion.settings.registerPage(page)  → { dispose() }
  window.zion.settings.registerItem(item)  → { dispose() } // legacy bridge
  window.zion.settings.open()
  window.zion.settings.close()

各模块/插件在 activate() 中自行调用 registerPage 注册配置页面
```

**核心原则**：核心层零业务逻辑，不做任何具体配置项的内容。

## 核心 API

### SettingsPageContribution 接口

```ts
interface SettingsPageContribution {
  id: string;
  title: string;
  category: "general" | "editor" | "services" | "workspace" | "extensions" | "advanced";
  description?: string;
  pluginId?: string;
  order?: number;
  sections: SettingSectionContribution[];
}

interface SettingSectionContribution {
  id: string;
  title: string;
  description?: string;
  settings: SettingContribution[];
}

interface SettingContribution {
  id: string;
  label: string;
  kind: "string" | "password" | "number" | "boolean" | "textarea" | "select" | "action" | "custom";
  description?: string;
  scope?: "application" | "workspace" | "plugin";
  defaultValue?: unknown;
  getValue?: () => unknown | Promise<unknown>;
  setValue?: (value: unknown) => void | Promise<void>;
  validate?: (value: unknown) => string | null | Promise<string | null>;
  reset?: () => void | Promise<void>;
  run?: () => void | Promise<void>;
  renderCustom?: () => ReactNode;
}
```

### 注册 API

```ts
// 注册设置页面
const disposable = window.zion.settings.registerPage({
  id: "my-plugin.settings",
  title: "My Plugin",
  category: "extensions",
  pluginId: "my-plugin",
  sections: [
    {
      id: "my-plugin.general",
      title: "General",
      settings: [
        {
          id: "myPlugin.apiKey",
          label: "API Key",
          kind: "password",
          getValue: () => localStorage.getItem("my.config.apiKey") || "",
          setValue: (value) => localStorage.setItem("my.config.apiKey", String(value || "")),
        }
      ]
    }
  ]
});

// 取消注册
disposable.dispose();
```

### 打开/关闭

```ts
// 打开设置面板
window.zion.settings.open();

// 关闭设置面板
window.zion.settings.close();

// 也可以通过命令
window.zion.commands.executeCommand("settings.open");
```

## 交互设计

### 入口

- **Activity Bar 底部 ⚙ 按钮**：点击打开设置面板
- **命令面板**：搜索 `settings.open` 执行
- **ESC**：关闭面板
- **点击遮罩层**：关闭面板

### 面板布局

```
┌─────────────────────────────────────┐
│  设置                        [Esc]  │  ← Header
├─────────────────────────────────────┤
│                                     │
│  ▎ 服务                              │  ← Section
│  ┌─────────────────────────────────┐│
│  │ 服务地址 (Base URL)              ││  ← Item
│  │  Plugin Service  [________]     ││
│  │  Local Tools     [________]     ││
│  │  Local Search    [________]     ││
│  │  Mail Service    [________]     ││
│  │  [保存]  [重置默认]              ││
│  └─────────────────────────────────┘│
│                                     │
│  ▎ Mail                              │
│  ┌─────────────────────────────────┐│
│  │ 邮件配置                         ││
│  │  SMTP Host  [________]          ││
│  │  ...                            ││
│  └─────────────────────────────────┘│
│                                     │
│  ▎ Skills                            │
│  ┌─────────────────────────────────┐│
│  │ Skills 配置                      ││
│  │  ...                            ││
│  └─────────────────────────────────┘│
│                                     │
└─────────────────────────────────────┘
```

### Activity Bar 底部

```
┌──────┐
│ 插件  │  ← 动态注册的按钮（上方 list）
│ 按钮  │
│ ...  │
├──────┤  ← border-top 分隔线
│  ⚙   │  ← 设置按钮（底部固定区）
│  ⌘   │  ← 命令面板按钮
└──────┘
```

## 已注册的设置项

| Section | Item | 注册者 | 内容 |
|---------|------|--------|------|
| 服务 | 服务地址 (Base URL) | dev.service-baseurl/main.js | 4 个服务的 BaseUrl 编辑 |
| Mail | 邮件配置 | dev.mail/settings.js | SMTP / 收件人 / 通知 / Debug |
| Skills | Skills 配置 | dev.skills/main.js | 目录路径 / 扫描 / 启用 |
| File System | 文件系统访问管理 | dev.fs-manager/main.js | 文件/文件夹句柄管理 |

## 关键实现文件

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/settings/registry.ts` | 新增 | SettingsRegistry 类 |
| `src/settings/SettingsPanel.ts` | 新增 | React 驱动的设置中心弹层 |
| `src/settings/SettingsShell.tsx` | 新增 | 左侧导航 + 搜索 + 内容区的设置中心壳子 |
| `src/settings/index.ts` | 新增 | 统一导出 |
| `src/ext/registry.ts` | 修改 | 暴露 `window.zion.settings` API |
| `src/ui/workbench/workbench.ts` | 修改 | Activity Bar 底部 ⚙ 按钮 |
| `src/styles.css` | 修改 | `.zion-activitybar-bottom` CSS |
| `src/main.ts` | 修改 | bootstrap 中注册设置中心打开命令及旧命令别名 |
| `extensions/dev.service-baseurl/main.js` | 新增 | 注册服务地址设置项（React 原生实现） |
| `extensions/dev.mail/settings.js` | 新增 | Mail 配置 UI 注册 |
| `extensions/dev.mail/main.js` | 修改 | activate 中调用 registerMailSettings |
| `extensions/dev.skills/main.js` | 修改 | activate 中注册 skills 配置 |
| `extensions/dev.fs-manager/main.js` | 修改 | activate 中注册 fs 配置 |

## 为插件开发者

如果你的插件有配置需要暴露给用户，在 `activate()` 中调用：

```js
export function activate(ctx) {
  const disposable = window.zion.settings.registerItem({
    id: "my-plugin-config",
    section: "My Plugin",
    title: "插件配置",
    order: 100,
    render(container) {
      // 读取配置
      const config = JSON.parse(localStorage.getItem("my.config") || "{}");

      // 构建 UI
      const input = document.createElement("input");
      input.value = config.someValue || "";
      container.appendChild(input);

      const saveBtn = document.createElement("button");
      saveBtn.textContent = "保存";
      saveBtn.onclick = () => {
        config.someValue = input.value;
        localStorage.setItem("my.config", JSON.stringify(config));
      };
      container.appendChild(saveBtn);

      // 返回 dispose（可选）
      return { dispose() { /* 清理资源 */ } };
    }
  });

  // 插件卸载时自动取消注册
  ctx.subscriptions.push(disposable);
}
```

### render() 规范

1. `container` 是面板为你分配的 DOM 容器，直接往里面 append 即可
2. 样式建议用 scoped class（如 `myplugin-cfg-xxx`）避免冲突
3. 返回 `{ dispose() }` 可在面板关闭时清理资源（移除事件监听等）
4. 每次面板打开都会重新调用 `render()`，不需要自己管理生命周期
