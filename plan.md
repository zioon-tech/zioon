# Settings Panel 实现计划

## 目标
在左侧 Activity Bar 底部添加⚙设置按钮，点击弹出设置面板。核心层只提供**注册 API + 面板壳子**，具体配置项由各模块/插件自己注册。

## 现状盘点

### 核心层已有
- `src/settings/serviceBaseUrl.ts`：纯数据层，管理 4 个服务的 BaseUrl（pluginService / localTools / localSearch / mail），`initServiceBaseUrlConfig()` 在 main.ts bootstrap 时调用
- `src/ext/registry.ts`：`(window as any).zion = api`（L2335），暴露了 commands / state / events / activityBar / sideBar / bottomPanel 等 API，**尚无 settings**
- `src/ui/workbench/workbench.ts`：`renderActivityBar()`（L269-310），上方 list 放插件按钮，下方硬编码 ⌘ 命令按钮，**没有底部分区**

### 插件现状
| 插件 | 当前配置方式 | 可注册到 Settings 的内容 |
|---|---|---|
| **dev.settings** | manifest: 注册 `zion.settings.show` 命令；main.js: 弹 overlay 面板编辑 serviceBaseUrl | 整个插件可被核心层替代 |
| **dev.mail** | localStorage `zion.mail.*` + state `mail.baseUrl`；mail-config.js: SMTP 配置面板 | SMTP / recipients / notifications / debug |
| **dev.skills** | localStorage `zion.skills.snapshot` + state `skills.config` | skills 路径 / 快照 |
| **dev.fs-manager** | IndexedDB `dev.fs-handles-db` | 文件系统句柄管理（可能只是只读展示） |

### 参考注册模式
- `window.zion.__editorHeaderMenuRegistry`（main.ts L1205-1230）：简单的 register → list → render 模式
- `window.zion.bottomPanel.registerView()`：render(container) → { dispose() } 模式

---

## 架构设计

```
核心层 (src/settings/)
├── registry.ts          # SettingsRegistry：registerItem / list / onDidChange
├── SettingsPanel.ts     # 设置面板 UI（modal overlay）
├── serviceBaseUrl.ts    # 现有，保持不变（纯数据层）
└── index.ts             # 统一导出
暴露到 window.zion：
  window.zion.settings = {
    registerItem(item) => { dispose() },
    open(),
    close()
  }
各模块/插件自己调用 registerItem：
  // main.ts bootstrap：注册 serviceBaseUrl 的编辑 UI
  // dev.mail/activate()：注册 mail 配置项
  // dev.skills/activate()：注册 skills 配置项
  // dev.fs-manager/activate()：注册 fs 配置项
```

### SettingsItem 接口
```ts
interface SettingsItem {
  id: string;                    // 唯一标识
  section: string;               // 分组（如 "Services", "Mail", "Skills"）
  title: string;                 // 显示标题
  order?: number;                // 排序（默认按注册顺序）
  render: (container: HTMLElement) => { dispose?: () => void } | void;
}
```

---

## 实现步骤

### Step 1：核心层 — SettingsRegistry（src/settings/registry.ts）
- `SettingsRegistry` 类
  - `registerItem(item: SettingsItem): { dispose(): void }`
  - `getItems(): SettingsItem[]`
  - `onDidChange(handler: () => void): { dispose(): void }`
- 纯数据管理，不涉及 UI

### Step 2：核心层 — SettingsPanel UI（src/settings/SettingsPanel.ts）
- modal overlay 样式（类似 Command Palette 的居中弹出面板）
- 按 section 分组渲染，每个 section 是可折叠的
- 每个 item 调用 `item.render(container)` 委托渲染
- 提供 `open()` / `close()` 方法
- 点击遮罩层关闭，ESC 关闭

### Step 3：核心层 — 暴露 API（src/ext/registry.ts）
- 在 `api` 对象中添加：
  ```ts
  settings: {
    registerItem: (item) => settingsRegistry.registerItem(item),
    open: () => settingsPanel.open(),
    close: () => settingsPanel.close(),
  }
  ```
- 注册命令 `settings.open`

### Step 4：Activity Bar 底部设置按钮（src/ui/workbench/workbench.ts）
- `renderActivityBar()` 改造：
  - 把 ⌘ 按钮和新的 ⚙ 按钮放在底部区域
  - 用 flexbox 让 list 占满上方，底部按钮固定在下方
  - ⚙ 点击调用 `window.zion.settings.open()`

### Step 5：main.ts 集成
- `initServiceBaseUrlConfig()` 调用之后，向 registry 注册 serviceBaseUrl 的编辑 UI
- 把 `dev.settings` 插件的 overlay 面板逻辑迁移到核心层注册

### Step 6：迁移 dev.settings 插件
- 删除 `extensions/dev.settings/` 目录（核心层已替代）
- 或保留 manifest 但清空 main.js，改为空 activate

### Step 7：dev.mail 注册设置项
- 在 `activate()` 中调用 `window.zion.settings.registerItem()`
- 将 mail-config.js 的 SMTP 配置 UI 迁移为 registerItem 的 render

### Step 8：dev.skills 注册设置项
- 在 activate 中注册 skills 路径配置

### Step 9：dev.fs-manager 注册设置项
- 在 activate 中注册 fs 句柄管理（可能只展示当前已保存的文件系统句柄列表）

### Step 10：验证
- `npm run build` 确认编译通过
- 手动验证：⚙ 按钮 → 设置面板弹出 → 各 section 正确渲染 → 编辑保存功能正常
