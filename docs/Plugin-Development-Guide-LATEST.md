# Zion Next 插件开发指南（最新版）

> 最后更新：2025-01-09
> 基于 zion-next 最新代码实现

---

## 目录

1. [项目概述](#项目概述)
2. [插件系统架构](#插件系统架构)
3. [开发环境搭建](#开发环境搭建)
4. [插件清单格式](#插件清单格式)
5. [前端插件开发](#前端插件开发)
6. [插件安装方式](#插件安装方式)
7. [开发模式](#开发模式)
8. [核心 API 参考](#核心-api-参考)
9. [示例插件](#示例插件)
10. [最佳实践](#最佳实践)
11. [常见问题](#常见问题)

---

## 项目概述

### Zion Next 是什么？

Zion Next 是一个基于 CodeMirror 6 的**大模型交互编辑器平台**，通过插件系统实现无限可扩展性。它不仅是一个聊天机器人，更是一个功能完整的编辑器和应用程序平台。

### 核心特性

- **基于 CodeMirror 6 的编辑器**：提供强大的文本编辑能力
- **所见即所得的 Markdown 编辑**：支持实时预览和交互（WYSIWYG 模式）
- **大模型集成**：内置 Chat 功能，可与各种大模型对话
- **模型提供者系统**：支持自定义模型提供者
- **主题系统**：支持 Light/Dark 主题切换
- **插件系统**：完整的插件架构，支持丰富的扩展能力
- **本地工具服务**：通过 Zion Local Tools 提供文件系统、命令行等本地能力

### 插件系统的设计目标

1. **最大化自由度**：插件开发者可以实现几乎任何功能
2. **与内置扩展平等**：插件拥有与内置扩展相同的能力
3. **模块化架构**：插件间可以相互协作，共享数据和事件
4. **开发友好**：提供完善的开发工具和热重载支持

---

## 插件系统架构

### 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                   Zion Next (前端)                    │
│  ┌───────────────────────────────────────────────┐   │
│  │           插件管理器 (PluginManager)       │   │
│  │  ┌───────────┐  ┌───────────┐  ┌───────┐ │   │
│  │  │   插件 A  │  │   插件 B  │  │ 插件 C│ │   │
│  │  └───────────┘  └───────────┘  └───────┘ │   │
│  └───────────────────────────────────────────────┘   │
│  ┌───────────────────────────────────────────────┐   │
│  │      扩展 API (window.zion)                │   │
│  └───────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│            Zion Local Tools (后端服务)                │
│  ┌───────────────────────────────────────────────┐   │
│  │      文件 │ 搜索 │ Bash │ 邮件 │ 插件     │   │
│  └───────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 插件生命周期

```
[安装] → [启用] → [激活] → [运行] → [停用] → [禁用] → [卸载]
    ↑                                            │
    └────────────────────────────────────────────┘
```

**生命周期详细说明**：

- **安装**：将插件文件放置到插件目录或通过 HTTP 服务/开发模式加载
- **启用**：用户在插件面板中启用插件，插件状态标记为启用
- **激活**：调用插件的 `activate(ctx)` 函数，插件开始运行
- **运行**：插件处于活动状态，响应命令和事件
- **停用**：调用插件的 `deactivate()` 函数，清理资源
- **禁用**：用户在插件面板中禁用插件，插件不再激活
- **卸载**：从系统中移除插件

**插件状态**：

```typescript
type PluginState = 
  | 'installed'    // 已安装但未启用
  | 'enabled'      // 已启用但未激活
  | 'disabled'     // 已禁用
  | 'activating'   // 正在激活
  | 'active'       // 已激活
  | 'deactivating' // 正在停用
  | 'error'        // 错误状态
  | 'uninstalled'; // 已卸载
```

---

## 开发环境搭建

### 前置要求

- **Node.js**: ≥ 18
- **npm**: ≥ 9（或使用 pnpm / yarn）
- **Python**: ≥ 3.8（用于 Zion Local Tools）
- **现代浏览器**: Chrome, Firefox, Safari, Edge

### 环境配置

#### 1. 安装 Zion Next

```bash
# 克隆项目
git clone https://github.com/your-org/zion-next.git
cd zion-next

# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

访问 `http://localhost:5174` 即可看到 Zion Next 编辑器。

#### 2. 安装 Zion Local Tools

```bash
# 克隆项目
git clone https://github.com/your-org/zion-local-tools.git
cd zion-local-tools

# 创建虚拟环境
python3 -m venv .venv
source .venv/bin/activate  # Linux/Mac
# 或 .venv\Scripts\activate  # Windows

# 安装依赖
pip install -r requirements.txt

# 启动服务
python run.py
```

服务将在 `http://127.0.0.1:8765` 启动。

#### 3. 配置前端连接后端

在 Zion Next 的浏览器控制台中执行：

```javascript
// 设置 Zion Local Tools 服务地址
window.zionLocalToolsUrl = 'http://127.0.0.1:8765';
```

或在 `index.html` 中添加：

```html
<script>
  window.zionLocalToolsUrl = 'http://127.0.0.1:8765';
</script>
```

### 开发工具推荐

- **VS Code**: 推荐的代码编辑器
- **Chrome DevTools**: 强大的调试工具
- **ESLint + Prettier**: 代码格式化和检查
- **Vitest**: 单元测试框架

---

## 插件清单格式

### 新格式：manifest.json

Zion Next 现在推荐使用 **manifest.json** 格式，这是基于 VS Code 扩展清单格式的现代化标准。

#### 完整示例

```json
{
  "name": "my.awesome.plugin",
  "version": "1.0.0",
  "description": "My awesome plugin for Zion Next",
  "author": "Your Name",
  "license": "MIT",
  "zion": {
    "id": "my.awesome.plugin",
    "name": "My Awesome Plugin",
    "version": "1.0.0",
    "description": "My awesome plugin for Zion Next",
    "main": "./main.js",
    "contributes": {
      "commands": [
        {
          "id": "my.plugin.hello",
          "title": "Hello World",
          "description": "Say hello to the world"
        }
      ],
      "keybindings": [
        {
          "command": "my.plugin.hello",
          "key": "Mod-Shift-H",
          "when": "editorFocus"
        }
      ],
      "menus": [
        {
          "location": "editor/context",
          "command": "my.plugin.hello",
          "title": "Hello World",
          "when": "hasSelection"
        }
      ],
      "statusBar": [
        {
          "id": "my.plugin.status",
          "text": "My Plugin",
          "tooltip": "My awesome plugin is active",
          "onClick": "my.plugin.hello"
        }
      ]
    },
    "activationEvents": [
      "onStartupFinished"
    ],
    "dependencies": {},
    "peerDependencies": {},
    "engines": {
      "zion": ">=1.0.0"
    }
  }
}
```

#### 字段说明

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | NPM 包名（推荐 `scope.name` 格式） |
| `version` | string | ✅ | 插件版本，遵循语义化版本规范 |
| `description` | string | ❌ | 插件描述 |
| `author` | string | ❌ | 插件作者 |
| `license` | string | ❌ | 插件许可证 |
| `zion` | object | ✅ | Zion 特定配置 |
| `zion.id` | string | ✅ | 插件唯一 ID |
| `zion.name` | string | ✅ | 插件显示名称 |
| `zion.version` | string | ✅ | 插件版本 |
| `zion.main` | string | ✅ | 插件入口文件路径 |
| `zion.contributes` | object | ❌ | 插件贡献点声明 |
| `zion.activationEvents` | array | ❌ | 插件激活事件 |
| `zion.dependencies` | object | ❌ | 插件依赖 |
| `zion.peerDependencies` | object | ❌ | 对等依赖 |
| `zion.engines` | object | ❌ | 引擎版本要求 |

### 备选格式：package.json

你也可以在 `package.json` 中嵌入 `zion` 字段：

```json
{
  "name": "my.awesome.plugin",
  "version": "1.0.0",
  "description": "My awesome plugin for Zion Next",
  "author": "Your Name",
  "license": "MIT",
  "zion": {
    "id": "my.awesome.plugin",
    "name": "My Awesome Plugin",
    "version": "1.0.0",
    "main": "./main.js",
    "contributes": { ... },
    "activationEvents": ["onStartupFinished"],
    "engines": {
      "zion": ">=1.0.0"
    }
  }
}
```

### 贡献点（contributes）

#### commands

定义命令：

```json
{
  "contributes": {
    "commands": [
      {
        "id": "my.plugin.hello",
        "title": "Hello World",
        "description": "Say hello to the world"
      }
    ]
  }
}
```

#### keybindings

定义快捷键：

```json
{
  "contributes": {
    "keybindings": [
      {
        "command": "my.plugin.hello",
        "key": "Mod-Shift-H",
        "when": "editorFocus"
      }
    ]
  }
}
```

**快捷键格式**：
- `Mod-...`: Cmd (Mac) / Ctrl (Windows/Linux)
- `Shift-...`: Shift
- `Alt-...`: Alt (Mac) / Option (Mac)
- 示例：`Mod-Shift-M`, `Mod-Alt-Delete`

**when 条件**：
- `editorFocus`: 编辑器聚焦时
- `hasSelection`: 有选区时
- `searchReplaceVisible`: 搜索替换面板可见时

#### menus

定义菜单项：

```json
{
  "contributes": {
    "menus": [
      {
        "location": "editor/context",
        "command": "my.plugin.hello",
        "title": "Hello World",
        "when": "hasSelection"
      }
    ]
  }
}
```

**支持的菜单位置**：
- `editor/context`: 编辑器右键菜单
- `editor/title`: 编辑器标题菜单

#### statusBar

定义状态栏按钮：

```json
{
  "contributes": {
    "statusBar": [
      {
        "id": "my.plugin.status",
        "text": "My Plugin",
        "tooltip": "My awesome plugin is active",
        "onClick": "my.plugin.hello"
      }
    ]
  }
}
```

### 激活事件（activationEvents）

```json
{
  "activationEvents": [
    "onStartupFinished",        // 应用启动完成后
    "onCommand:my.plugin.hello" // 特定命令执行时
  ]
}
```

### 依赖管理

```json
{
  "dependencies": {
    "other.plugin": "^1.0.0"
  },
  "peerDependencies": {
    "zion.core": ">=1.0.0"
  },
  "engines": {
    "zion": ">=1.0.0"
  }
}
```

---

## 前端插件开发

### 插件基本结构

一个 Zion Next 插件至少包含两个文件：

```
my-awesome-plugin/
├── manifest.json      # 插件清单（必需）
├── package.json        # NPM 配置（可选）
└── main.js            # 插件入口（必需）
```

### 插件入口（main.js）

```javascript
/**
 * 插件激活函数
 * @param {Object} ctx - 插件上下文
 * @param {Array} ctx.subscriptions - 订阅列表，用于资源清理
 * @param {string} ctx.extensionPath - 插件目录路径
 * @param {Object} ctx.globalState - 全局状态存储
 * @param {Object} ctx.workspaceState - 工作区状态存储
 * @param {Object} ctx.configuration - 配置管理器
 * @param {Function} ctx.asAbsolutePath - 相对路径转绝对路径
 * @param {Function} ctx.log - 日志记录函数
 */
export async function activate(ctx) {
  // 1. 注册命令
  const commandDisposable = window.zion.commands.registerCommand(
    'my.plugin.hello',
    () => {
      // 命令处理逻辑
      console.log('Hello, World!');
      alert('Hello from My Awesome Plugin!');
    }
  );
  ctx.subscriptions.push(commandDisposable);

  // 2. 注册状态栏按钮
  const statusBarDisposable = window.zion.statusBar.registerItem({
    id: 'my.plugin.status',
    text: 'My Plugin',
    tooltip: 'My awesome plugin is active',
    onClick: () => {
      window.zion.commands.executeCommand('my.plugin.hello');
    }
  });
  ctx.subscriptions.push(statusBarDisposable);

  // 3. 监听事件
  const eventDisposable = window.zion.events.on('my.event', (payload) => {
    console.log('Received event:', payload);
  });
  ctx.subscriptions.push(eventDisposable);

  // 4. 初始化插件状态
  await ctx.globalState.update('initialized', true);
  
  console.log('[My Plugin] Activated successfully');
}

/**
 * 插件停用函数（可选）
 */
export async function deactivate() {
  // 清理插件资源
  console.log('[My Plugin] Deactivated');
}
```

### 插件上下文（PluginContext）

插件上下文提供了插件运行时所需的所有资源：

```typescript
interface PluginContext {
  // 订阅列表，用于资源清理
  subscriptions: Disposable[];
  
  // 插件目录路径
  extensionPath: string;
  
  // 全局状态存储（跨工作区持久化）
  globalState: Memento;
  
  // 工作区状态存储（当前工作区）
  workspaceState: Memento;
  
  // 配置管理器
  configuration: PluginConfigurationManager;
  
  // 相对路径转绝对路径
  asAbsolutePath(path: string): string;
  
  // 日志记录函数
  log(message: string, level?: 'debug' | 'info' | 'warn' | 'error'): void;
}
```

### 使用插件上下文

```javascript
export async function activate(ctx) {
  // 读取全局状态
  const globalData = await ctx.globalState.get('myKey', 'defaultValue');
  console.log('Global data:', globalData);

  // 保存全局状态
  await ctx.globalState.update('myKey', 'newValue');

  // 读取工作区状态
  const workspaceData = await ctx.workspaceState.get('workspaceKey');
  
  // 保存工作区状态
  await ctx.workspaceState.update('workspaceKey', 'workspaceValue');

  // 读取配置
  const configValue = ctx.configuration.get('myConfig', 'default');
  
  // 保存配置
  await ctx.configuration.update('myConfig', 'newValue');
  
  // 监听配置变化
  const configDisposable = ctx.configuration.onDidChange('myConfig', (newValue) => {
    console.log('Config changed:', newValue);
  });
  ctx.subscriptions.push(configDisposable);

  // 记录日志
  ctx.log('Plugin is activating', 'info');
  ctx.log('Warning message', 'warn');
  ctx.log('Error message', 'error');

  // 获取绝对路径
  const absolutePath = ctx.asAbsolutePath('./assets/icon.png');
}
```

---

## 插件安装方式

### 方式一：内置扩展（开发阶段）

将插件放置在项目的 `extensions/` 目录下：

```
zion-next/
└── extensions/
    └── my-awesome-plugin/
        ├── manifest.json
        └── main.js
```

Zion Next 会自动扫描并加载这些扩展。

### 方式二：通过 Zion Local Tools 服务安装

使用 `window.zion.plugins.installFromService()` 从本地服务安装：

```javascript
// 从 HTTP 服务安装
await window.zion.plugins.installFromService({
  baseUrl: 'http://127.0.0.1:8765',
  pluginId: 'my-awesome-plugin',
  manifestUrl: '/plugins/my-awesome-plugin/manifest.json'
}, { enabled: true });
```

### 方式三：开发模式安装（支持热重载）

使用 `window.zion.plugins.installFromDevBase()` 从开发目录安装：

```javascript
// 启动开发会话（通过 Zion Local Tools）
const devId = 'my-dev-session-id';

// 从开发基础 URL 安装
await window.zion.plugins.installFromDevBase(
  `http://127.0.0.1:8765/plugins/dev/${devId}`,
  devId
);
```

### 方式四：从 ZIP 文件安装（拖拽）

```javascript
// 从本地 ZIP 文件安装
await window.zion.plugins.installFromFile(file);
```

**工作流程**：
1. 用户将 `.zip` 插件包拖拽到 Zion Next 界面
2. 插件管理器自动解压并加载
3. 安装后插件可以启用或禁用

### 插件管理 API

```javascript
// 列出所有插件
const plugins = window.zion.plugins.list();

// 获取指定插件信息
const plugin = window.zion.plugins.get('my.plugin.id');

// 启用插件
await window.zion.plugins.enable('my.plugin.id');

// 禁用插件
await window.zion.plugins.disable('my.plugin.id');

// 卸载插件
await window.zion.plugins.uninstall('my.plugin.id');

// 搜索插件
const results = window.zion.plugins.search('keyword');

// 获取插件统计信息
const stats = window.zion.plugins.getStats();

// 重新加载所有扩展
await window.zion.commands.executeCommand('zion.reloadExtensions');

// 打开扩展面板
await window.zion.commands.executeCommand('zion.showExtensions');
```

---

## 开发模式

### 启动开发会话

使用 Zion Local Tools 启动开发会话：

```bash
# 启动开发会话
curl -X POST http://127.0.0.1:8765/plugins/dev/start \
  -H "Content-Type: application/json" \
  -d '{"path": "/path/to/your/plugin"}'
```

返回结果：

```json
{
  "success": true,
  "data": {
    "devId": "abc123",
    "baseUrl": "/plugins/dev/abc123"
  }
}
```

### 安装开发中的插件

```javascript
// 安装开发中的插件
const devId = 'abc123';
const baseUrl = `http://127.0.0.1:8765/plugins/dev/${devId}`;

await window.zion.plugins.installFromDevBase(baseUrl, devId);
```

### 热重载

Zion Local Tools 会自动检测文件变化并通过 WebSocket 推送更新。前端会自动重新加载插件。

```javascript
// 监听开发事件（可选）
const ws = new WebSocket(`ws://127.0.0.1:8765/plugins/dev/ws/${devId}`);

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log('Dev event:', message);

  switch (message.type) {
    case 'dev:change':
      console.log('File changed:', message.file, message.event);
      // 文件变更时自动刷新插件
      break;
    case 'dev:stop':
      console.log('Dev session stopped');
      break;
  }
};
```

### 停止开发会话

```bash
# 停止开发会话
curl -X POST http://127.0.0.1:8765/plugins/dev/stop \
  -H "Content-Type: application/json" \
  -d '{"devId": "abc123"}'
```

### 开发工作流

```
1. 创建插件目录和基本文件
       ↓
2. 启动开发会话（POST /plugins/dev/start）
       ↓
3. 在编辑器中开发插件代码
       ↓
4. 修改文件自动触发热重载
       ↓
5. 测试插件功能
       ↓
6. 重复 3-5 步
       ↓
7. 停止开发会话（POST /plugins/dev/stop）
       ↓
8. 打包并发布插件
```

---

## 核心 API 参考

### 命令系统

#### registerCommand(id, handler)

注册命令：

```javascript
const disposable = window.zion.commands.registerCommand(
  'my.plugin.hello',
  (name = 'World') => {
    console.log(`Hello, ${name}!`);
  }
);
```

#### executeCommand(id, ...args)

执行命令：

```javascript
const result = window.zion.commands.executeCommand('my.plugin.hello', 'Zion');
```

### 快捷键系统

#### register(binding)

注册快捷键：

```javascript
const disposable = window.zion.keybindings.register({
  command: 'my.plugin.hello',
  key: 'Mod-Shift-H',
  when: 'editorFocus'
});
```

#### list()

列出所有快捷键：

```javascript
const bindings = window.zion.keybindings.list();
console.log('All keybindings:', bindings);
```

### 菜单系统

#### register(menuId, item)

注册菜单项：

```javascript
const disposable = window.zion.menus.register(
  'editor/context',
  {
    command: 'my.plugin.hello',
    title: 'Hello World',
    when: 'hasSelection'
  }
);
```

#### show(menuId, x, y)

在指定坐标显示菜单：

```javascript
window.zion.menus.show('editor/context', x, y);
```

### 状态栏

#### registerItem(options)

注册状态栏按钮：

```javascript
const disposable = window.zion.statusBar.registerItem({
  id: 'my.plugin.status',
  text: 'My Plugin',
  tooltip: 'My awesome plugin is active',
  onClick: () => {
    window.zion.commands.executeCommand('my.plugin.hello');
  }
});
```

### 事件总线

#### emit(topic, payload)

发布事件：

```javascript
window.zion.events.emit('my.event', { data: 'Hello' });
```

#### on(topic, handler)

订阅事件：

```javascript
const disposable = window.zion.events.on('my.event', (payload) => {
  console.log('Received event:', payload);
});
```

### 状态总线

#### get(key)

获取状态：

```javascript
const theme = window.zion.state.get('ui.theme');
```

#### set(key, value)

设置状态：

```javascript
window.zion.state.set('my.setting', true);
```

#### onDidChange(key, handler)

监听状态变化：

```javascript
const disposable = window.zion.state.onDidChange('ui.theme', (newVal, oldVal) => {
  console.log(`Theme changed from ${oldVal} to ${newVal}`);
});
```

### 编辑器 API

#### registerPasteHandler(handler)

注册粘贴处理器：

```javascript
const disposable = window.zion.editor.registerPasteHandler({
  id: 'my.paste',
  priority: 90,
  handle: ({ clipboardData, editor }) => {
    const text = clipboardData.getData('text/plain');
    if (text === '::timestamp::') {
      editor.replaceSelection(new Date().toISOString());
      return true; // 已处理，阻止默认粘贴
    }
    return false; // 未处理，继续默认粘贴
  }
});
```

#### registerDecorator(decorator)

注册编辑器装饰器：

```javascript
const disposable = window.zion.editor.registerDecorator({
  id: 'my.decorator',
  apply: (editor) => {
    // 添加 UI 或监听编辑器事件
    const handler = () => {
      console.log('Editor content changed');
    };
    editor.on('change', handler);

    // 返回清理函数
    return {
      dispose: () => {
        editor.off('change', handler);
      }
    };
  }
});
```

### 编辑器代理（EditorProxy）

编辑器代理提供了安全的编辑器访问接口：

```javascript
const editor = window.zion.window.activeEditor;

// 获取内容
const content = editor.getValue();

// 设置内容
editor.setValue('Hello, World!');

// 替换选区
editor.replaceSelection('new text');

// 获取选区
const selection = editor.getSelection();

// 替换范围
editor.replaceRange('replacement', { line: 0, ch: 0 }, { line: 0, ch: 5 });

// 获取光标位置
const cursor = editor.getCursor();

// 设置光标位置
editor.setCursor({ line: 10, ch: 0 });

// 让编辑器获得焦点
editor.focus();

// 添加 CodeMirror 6 视觉扩展
editor.addVisualExtension(myViewPlugin);
```

### 消息管道

#### registerContributor(contributor)

注册消息贡献者：

```javascript
const disposable = window.zion.messages.registerContributor({
  id: 'my.contributor',
  order: 10,
  stage: 'pre',
  contribute: async (messages, ctx) => {
    // 在消息发送前注入系统信息
    const systemInfo = {
      role: 'system',
      content: `当前时间: ${new Date().toISOString()}`
    };
    return [systemInfo, ...messages];
  }
});
```

### 模型提供者

#### registerProvider(provider)

注册模型提供者：

```javascript
const disposable = window.zion.models.registerProvider({
  id: 'my.models',
  async list() {
    return [
      { id: 'my.model.gpt4', label: 'My GPT-4' },
      { id: 'my.model.gpt3', label: 'My GPT-3' }
    ];
  },
  async resolve(modelId) {
    // 返回模型配置
    return {
      id: modelId,
      baseUrl: 'https://api.myprovider.com',
      apiKey: 'your-api-key'
    };
  }
});
```

### 主题系统

#### 切换主题

```javascript
// 切换主题
window.zion.commands.executeCommand('zion.toggleTheme');

// 设置主题
window.zion.commands.executeCommand('zion.setTheme', 'light');
window.zion.commands.executeCommand('zion.setTheme', 'dark');
```

### 编辑器配置

#### 切换编辑器特性

```javascript
// 切换行号
window.zion.commands.executeCommand('zion.toggleLineNumbers');

// 切换活动行高亮
window.zion.commands.executeCommand('zion.toggleActiveLineHighlight');

// 切换语法高亮
window.zion.commands.executeCommand('zion.toggleSyntaxHighlight');

// 切换自动缩进
window.zion.commands.executeCommand('zion.toggleAutoIndent');

// 切换折叠
window.zion.commands.executeCommand('zion.toggleFolding');

// 切换行包装
window.zion.commands.executeCommand('zion.toggleLineWrap');
```

### WYSIWYG 模式

#### 切换 WYSIWYG

```javascript
// 切换 WYSIWYG 模式
window.zion.commands.executeCommand('zion.toggleWysiwyg');

// 设置 WYSIWYG 模式
window.zion.commands.executeCommand('zion.setWysiwyg', true);
window.zion.commands.executeCommand('zion.setWysiwyg', false);
```

---

## 示例插件

### 示例 1：简单的文本插入插件

**manifest.json**:
```json
{
  "name": "dev.timestamp",
  "version": "1.0.0",
  "description": "Insert timestamp into editor",
  "author": "Your Name",
  "license": "MIT",
  "zion": {
    "id": "dev.timestamp",
    "name": "Timestamp",
    "version": "1.0.0",
    "main": "./main.js",
    "contributes": {
      "commands": [
        {
          "id": "timestamp.insert",
          "title": "Insert Timestamp"
        }
      ],
      "keybindings": [
        {
          "command": "timestamp.insert",
          "key": "Mod-Shift-T",
          "when": "editorFocus"
        }
      ]
    },
    "activationEvents": ["onStartupFinished"],
    "engines": {
      "zion": ">=1.0.0"
    }
  }
}
```

**main.js**:
```javascript
export async function activate(ctx) {
  const command = window.zion.commands.registerCommand(
    'timestamp.insert',
    () => {
      const editor = window.zion.window.activeEditor;
      if (!editor) return;

      const timestamp = new Date().toISOString();
      editor.replaceSelection(timestamp);
    }
  );

  ctx.subscriptions.push(command);
  
  ctx.log('Timestamp plugin activated', 'info');
}
```

### 示例 2：状态栏按钮

**manifest.json**:
```json
{
  "name": "dev.status-demo",
  "version": "1.0.0",
  "description": "Status bar button demo",
  "author": "Your Name",
  "license": "MIT",
  "zion": {
    "id": "dev.status-demo",
    "name": "Status Demo",
    "version": "1.0.0",
    "main": "./main.js",
    "contributes": {
      "commands": [
        {
          "id": "status.insert",
          "title": "Insert Marker"
        }
      ],
      "statusBar": [
        {
          "id": "status.button",
          "text": "Status Demo",
          "tooltip": "Click to insert marker",
          "onClick": "status.insert"
        }
      ]
    },
    "activationEvents": ["onStartupFinished"],
    "engines": {
      "zion": ">=1.0.0"
    }
  }
}
```

**main.js**:
```javascript
export async function activate(ctx) {
  // 注册命令
  const command = window.zion.commands.registerCommand(
    'status.insert',
    () => {
      const editor = window.zion.window.activeEditor;
      if (!editor) return;

      editor.replaceSelection('<!-- MARKER -->');
    }
  );
  ctx.subscriptions.push(command);

  // 注册状态栏按钮（通过 API）
  const statusBarDisposable = window.zion.statusBar.registerItem({
    id: 'status.button',
    text: 'Status Demo',
    tooltip: 'Click to insert marker',
    onClick: () => {
      window.zion.commands.executeCommand('status.insert');
    }
  });
  ctx.subscriptions.push(statusBarDisposable);
  
  ctx.log('Status demo plugin activated', 'info');
}
```

### 示例 3：主题切换

**manifest.json**:
```json
{
  "name": "dev.theme-switcher",
  "version": "1.0.0",
  "description": "Theme switcher plugin",
  "author": "Your Name",
  "license": "MIT",
  "zion": {
    "id": "dev.theme-switcher",
    "name": "Theme Switcher",
    "version": "1.0.0",
    "main": "./main.js",
    "contributes": {
      "commands": [
        {
          "id": "theme.toggle",
          "title": "Toggle Theme"
        }
      ],
      "keybindings": [
        {
          "command": "theme.toggle",
          "key": "Mod-Shift-T"
        }
      ]
    },
    "activationEvents": ["onStartupFinished"],
    "engines": {
      "zion": ">=1.0.0"
    }
  }
}
```

**main.js**:
```javascript
export async function activate(ctx) {
  // 注册主题切换命令
  const command = window.zion.commands.registerCommand(
    'theme.toggle',
    () => {
      window.zion.commands.executeCommand('zion.toggleTheme');
    }
  );
  ctx.subscriptions.push(command);

  // 监听主题变化
  const themeDisposable = window.zion.state.onDidChange('ui.theme', (newTheme) => {
    console.log(`Theme changed to: ${newTheme}`);
  });
  ctx.subscriptions.push(themeDisposable);
  
  ctx.log('Theme switcher plugin activated', 'info');
}
```

### 示例 4：WYSIWYG 切换

**manifest.json**:
```json
{
  "name": "dev.wysiwyg-toggle",
  "version": "1.0.0",
  "description": "WYSIWYG mode toggle",
  "author": "Your Name",
  "license": "MIT",
  "zion": {
    "id": "dev.wysiwyg-toggle",
    "name": "WYSIWYG Toggle",
    "version": "1.0.0",
    "main": "./main.js",
    "contributes": {
      "commands": [
        {
          "id": "wysiwyg.toggle",
          "title": "Toggle WYSIWYG"
        }
      ],
      "keybindings": [
        {
          "command": "wysiwyg.toggle",
          "key": "Mod-Shift-W"
        }
      ]
    },
    "activationEvents": ["onStartupFinished"],
    "engines": {
      "zion": ">=1.0.0"
    }
  }
}
```

**main.js**:
```javascript
export async function activate(ctx) {
  // 注册 WYSIWYG 切换命令
  const command = window.zion.commands.registerCommand(
    'wysiwyg.toggle',
    () => {
      window.zion.commands.executeCommand('zion.toggleWysiwyg');
    }
  );
  ctx.subscriptions.push(command);

  // 获取当前 WYSIWYG 状态
  const wysiwygEnabled = window.zion.state.get('wysiwyg', false);
  console.log(`WYSIWYG is ${wysiwygEnabled ? 'enabled' : 'disabled'}`);
  
  ctx.log('WYSIWYG toggle plugin activated', 'info');
}
```

### 示例 5：编辑器配置

**manifest.json**:
```json
{
  "name": "dev.editor-config",
  "version": "1.0.0",
  "description": "Editor configuration plugin",
  "author": "Your Name",
  "license": "MIT",
  "zion": {
    "id": "dev.editor-config",
    "name": "Editor Config",
    "version": "1.0.0",
    "main": "./main.js",
    "contributes": {
      "commands": [
        {
          "id": "config.toggleLineNumbers",
          "title": "Toggle Line Numbers"
        },
        {
          "id": "config.toggleSyntaxHighlight",
          "title": "Toggle Syntax Highlight"
        },
        {
          "id": "config.toggleAutoIndent",
          "title": "Toggle Auto Indent"
        }
      ],
      "keybindings": [
        {
          "command": "config.toggleLineNumbers",
          "key": "Mod-Shift-L"
        },
        {
          "command": "config.toggleSyntaxHighlight",
          "key": "Mod-Shift-S"
        },
        {
          "command": "config.toggleAutoIndent",
          "key": "Mod-Shift-I"
        }
      ],
      "statusBar": [
        {
          "id": "config.status",
          "text": "Config",
          "tooltip": "Editor Configuration"
        }
      ]
    },
    "activationEvents": ["onStartupFinished"],
    "engines": {
      "zion": ">=1.0.0"
    }
  }
}
```

**main.js**:
```javascript
export async function activate(ctx) {
  // 切换行号
  const lineNumbersCmd = window.zion.commands.registerCommand(
    'config.toggleLineNumbers',
    () => {
      window.zion.commands.executeCommand('zion.toggleLineNumbers');
    }
  );
  ctx.subscriptions.push(lineNumbersCmd);

  // 切换语法高亮
  const syntaxHighlightCmd = window.zion.commands.registerCommand(
    'config.toggleSyntaxHighlight',
    () => {
      window.zion.commands.executeCommand('zion.toggleSyntaxHighlight');
    }
  );
  ctx.subscriptions.push(syntaxHighlightCmd);

  // 切换自动缩进
  const autoIndentCmd = window.zion.commands.registerCommand(
    'config.toggleAutoIndent',
    () => {
      window.zion.commands.executeCommand('zion.toggleAutoIndent');
    }
  );
  ctx.subscriptions.push(autoIndentCmd);

  // 状态栏按钮
  const statusBarDisposable = window.zion.statusBar.registerItem({
    id: 'config.status',
    text: 'Config',
    tooltip: 'Editor Configuration',
    onClick: () => {
      // 显示配置菜单（需要实现）
      console.log('Show configuration menu');
    }
  });
  ctx.subscriptions.push(statusBarDisposable);
  
  ctx.log('Editor config plugin activated', 'info');
}
```

### 示例 6：消息贡献者

**manifest.json**:
```json
{
  "name": "dev.messages-contributor",
  "version": "1.0.0",
  "description": "Message contributor demo",
  "author": "Your Name",
  "license": "MIT",
  "zion": {
    "id": "dev.messages-contributor",
    "name": "Messages Contributor",
    "version": "1.0.0",
    "main": "./main.js",
    "contributes": {
      "commands": []
    },
    "activationEvents": ["onStartupFinished"],
    "engines": {
      "zion": ">=1.0.0"
    }
  }
}
```

**main.js**:
```javascript
export async function activate(ctx) {
  // 注册消息贡献者
  const contributor = window.zion.messages.registerContributor({
    id: 'messages.contributor',
    order: 10,
    stage: 'pre',
    contribute: async (messages, ctx) => {
      // 在消息发送前注入系统信息
      const systemInfo = {
        role: 'system',
        content: `当前时间: ${new Date().toLocaleString()}`
      };
      return [systemInfo, ...messages];
    }
  });
  ctx.subscriptions.push(contributor);
  
  ctx.log('Messages contributor plugin activated', 'info');
}
```

### 示例 7：粘贴处理器

**manifest.json**:
```json
{
  "name": "dev.paste-timestamp",
  "version": "1.0.0",
  "description": "Paste timestamp demo",
  "author": "Your Name",
  "license": "MIT",
  "zion": {
    "id": "dev.paste-timestamp",
    "name": "Paste Timestamp",
    "version": "1.0.0",
    "main": "./main.js",
    "contributes": {
      "commands": []
    },
    "activationEvents": ["onStartupFinished"],
    "engines": {
      "zion": ">=1.0.0"
    }
  }
}
```

**main.js**:
```javascript
export async function activate(ctx) {
  // 注册粘贴处理器
  const pasteHandler = window.zion.editor.registerPasteHandler({
    id: 'paste.timestamp',
    priority: 90,
    handle: ({ clipboardData, editor }) => {
      const text = clipboardData.getData('text/plain');
      
      // 检查是否粘贴特殊标记
      if (text.trim() === '::timestamp::') {
        const timestamp = new Date().toISOString();
        editor.replaceSelection(timestamp);
        return true; // 已处理
      }
      
      return false; // 未处理
    }
  });
  ctx.subscriptions.push(pasteHandler);
  
  ctx.log('Paste timestamp plugin activated', 'info');
}
```

---

## 最佳实践

### 1. 代码组织

使用模块化结构组织代码：

```javascript
// main.js
export async function activate(ctx) {
  const commands = await import('./commands.js');
  const ui = await import('./ui.js');
  const utils = await import('./utils.js');

  const commandDisposables = commands.registerAll(ctx);
  const uiDisposable = ui.create(ctx);

  ctx.subscriptions.push(...commandDisposables, uiDisposable);
}

// commands.js
export async function registerAll(ctx) {
  return [
    registerCommand1(ctx),
    registerCommand2(ctx),
    // ...
  ];
}

function registerCommand1(ctx) {
  const disposable = window.zion.commands.registerCommand('my.cmd1', () => {
    // 命令逻辑
  });
  ctx.subscriptions.push(disposable);
  return disposable;
}
```

### 2. 错误处理

始终使用 try-catch 处理异步操作：

```javascript
export async function activate(ctx) {
  const command = window.zion.commands.registerCommand('my.command', async () => {
    try {
      // 执行操作
      const result = await someAsyncOperation();
      // 处理结果
    } catch (error) {
      console.error('[My Plugin] Error:', error);
      // 显示用户友好的错误信息
      ctx.log(`操作失败: ${error.message}`, 'error');
    }
  });

  ctx.subscriptions.push(command);
}
```

### 3. 资源清理

确保在停用时清理所有资源：

```javascript
export async function activate(ctx) {
  // 注册各种资源
  const commandDisposable = window.zion.commands.registerCommand(...);
  const eventDisposable = window.zion.events.on(...);
  const statusBarDisposable = window.zion.statusBar.registerItem(...);

  // 全部添加到订阅列表，自动清理
  ctx.subscriptions.push(
    commandDisposable,
    eventDisposable,
    statusBarDisposable
  );

  // 创建 DOM 元素
  const panel = document.createElement('div');
  document.body.appendChild(panel);

  // 手动清理 DOM
  ctx.subscriptions.push({
    dispose: () => {
      panel.remove();
    }
  });
}
```

### 4. 状态管理

使用 `globalState` 和 `workspaceState` 管理持久化状态：

```javascript
export async function activate(ctx) {
  // 读取配置
  const config = ctx.configuration.get('mySetting', 'default');

  // 读取全局状态（跨工作区）
  const globalData = await ctx.globalState.get('myData', {});

  // 读取工作区状态（当前工作区）
  const workspaceData = await ctx.workspaceState.get('workspaceData', {});

  // 保存配置
  await ctx.configuration.update('mySetting', 'new value');

  // 保存全局状态
  await ctx.globalState.update('myData', { ...globalData, key: 'value' });

  // 监听配置变化
  const configDisposable = ctx.configuration.onDidChange('mySetting', (newValue) => {
    console.log('Setting changed:', newValue);
  });
  ctx.subscriptions.push(configDisposable);
}
```

### 5. 调试技巧

#### 使用浏览器开发者工具

- **Console**: 查看 `console.log` 输出和错误信息
- **Network**: 查看网络请求（API 调用、插件加载）
- **Application**: 查看 localStorage 存储数据
- **Elements**: 检查 DOM 结构和样式

#### 添加调试代码

```javascript
export async function activate(ctx) {
  console.log('[My Plugin] Activating...');

  try {
    // 插件逻辑
    debugger; // 设置断点
  } catch (error) {
    console.error('[My Plugin] Error:', error);
    ctx.log(`Plugin error: ${error.message}`, 'error');
  }
}
```

#### 查看插件状态

```javascript
// 在控制台中查看插件管理器状态
console.log('Plugins:', window.zion.plugins.list());
console.log('Active plugins:', window.zion.plugins.getActivePlugins());
console.log('Plugin stats:', window.zion.plugins.getStats());
```

---

## 常见问题

### Q1: 插件没有加载？

**可能原因**：
1. `manifest.json` 格式错误
2. `zion.main` 字段路径不正确
3. JavaScript 语法错误
4. 插件目录结构不正确

**解决方法**：
1. 检查浏览器控制台是否有错误信息
2. 验证 JSON 格式：使用 JSON lint 工具
3. 检查 JavaScript 语法：使用 ESLint
4. 确保文件路径正确（相对路径）

### Q2: 命令无法执行？

**可能原因**：
1. 命令未正确注册
2. 快捷键冲突
3. `when` 条件不满足

**解决方法**：
1. 在控制台执行 `window.zion.commands.executeCommand('my.command')` 测试
2. 检查快捷键是否与其他插件冲突
3. 检查 `when` 条件是否正确

### Q3: 如何调试插件？

**方法**：
1. 使用 `console.log` 输出调试信息
2. 使用 `debugger` 语句设置断点
3. 使用浏览器开发者工具的断点功能
4. 查看控制台的错误堆栈

**示例**：
```javascript
export async function activate(ctx) {
  console.log('[My Plugin] Activating...');

  try {
    // 调试代码
    debugger;

    const result = await someOperation();
    console.log('[My Plugin] Result:', result);
  } catch (error) {
    console.error('[My Plugin] Error:', error);
  }
}
```

### Q4: 如何与 Zion Local Tools 通信？

**方法**：
1. 使用 `fetch` API 调用 REST 接口
2. 配置正确的服务 URL
3. 处理网络错误和超时

**示例**：
```javascript
const serviceUrl = window.zionLocalToolsUrl || 'http://127.0.0.1:8765';

async function callApi(endpoint, options = {}) {
  try {
    const response = await fetch(`${serviceUrl}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('API call failed:', error);
    throw error;
  }
}
```

### Q5: 如何打包和发布插件？

**步骤**：
1. 确保所有文件都已包含
2. 测试插件功能
3. 创建压缩包（zip）
4. 通过 Zion Local Tools 上传或直接发布到插件市场

**示例**：
```bash
# 打包插件
zip -r my-plugin.zip my-awesome-plugin/

# 上传到服务器（需要实现）
# curl -X POST http://127.0.0.1:8765/plugins/upload \
#   -F "file=@my-plugin.zip" \
#   -F "metadata={\"name\":\"my.awesome.plugin\",\"version\":\"1.0.0\"}"
```

### Q6: 插件性能问题？

**优化方法**：
1. 使用防抖和节流
2. 避免频繁的 DOM 操作
3. 使用虚拟滚动处理大量数据
4. 延迟加载非关键资源

**示例**：
```javascript
import { debounce } from './utils.js';

export async function activate(ctx) {
  const handler = debounce(() => {
    // 昂贵的操作
    updateUI();
  }, 300);

  window.zion.events.on('editor.change', handler);
}
```

---

## 附录

### A. 插件清单完整模板

```json
{
  "name": "my.awesome.plugin",
  "version": "1.0.0",
  "description": "An awesome plugin for Zion Next",
  "author": "Your Name",
  "license": "MIT",
  "zion": {
    "id": "my.awesome.plugin",
    "name": "My Awesome Plugin",
    "version": "1.0.0",
    "description": "An awesome plugin for Zion Next",
    "main": "./main.js",
    "contributes": {
      "commands": [
        {
          "id": "my.plugin.command1",
          "title": "Command 1",
          "description": "Description of command 1"
        },
        {
          "id": "my.plugin.command2",
          "title": "Command 2",
          "description": "Description of command 2"
        }
      ],
      "keybindings": [
        {
          "command": "my.plugin.command1",
          "key": "Mod-Shift-C1",
          "when": "editorFocus"
        },
        {
          "command": "my.plugin.command2",
          "key": "Mod-Shift-C2",
          "when": "hasSelection"
        }
      ],
      "menus": [
        {
          "location": "editor/context",
          "command": "my.plugin.command1",
          "title": "Run Command 1",
          "when": "editorFocus"
        }
      ],
      "statusBar": [
        {
          "id": "my.plugin.status",
          "text": "My Plugin",
          "tooltip": "My awesome plugin",
          "onClick": "my.plugin.command1"
        }
      ]
    },
    "activationEvents": [
      "onStartupFinished"
    ],
    "dependencies": {
      "other.plugin": "^1.0.0"
    },
    "peerDependencies": {},
    "engines": {
      "zion": ">=1.0.0"
    }
  }
}
```

### B. 常用代码片段

#### 防抖函数

```javascript
export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
```

#### 节流函数

```javascript
export function throttle(func, limit) {
  let inThrottle;
  return function(...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}
```

#### 显示通知

```javascript
export function showNotification(type, message, duration = 3000) {
  const notification = document.createElement('div');
  notification.textContent = message;

  const colors = {
    'info': 'var(--accent)',
    'success': 'var(--ok)',
    'warn': '#ffb86c',
    'error': '#ff5555'
  };

  notification.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    padding: 12px 16px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-left: 4px solid ${colors[type] || colors.info};
    border-radius: 4px;
    color: var(--fg);
    z-index: 100000;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    font-size: 14px;
  `;

  document.body.appendChild(notification);

  setTimeout(() => {
    notification.style.opacity = '0';
    notification.style.transition = 'opacity 300ms ease';
    setTimeout(() => notification.remove(), 300);
  }, duration);
}
```

### C. CSS 变量参考

```css
/* 主题变量 */
:root {
  --bg: #282c34;
  --panel: #282a36;
  --border: #44475a;
  --fg: #d1d5db;
  --accent: #6272a4;
  --ok: #50fa7b;
}

/* 字体变量 */
:root {
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text",
    "Segoe UI", Roboto, "Noto Sans", "Noto Sans CJK SC", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
    "Liberation Mono", "Courier New", monospace;
}

/* Markdown UI 变量 */
:root {
  --md-code-bg: rgba(98,114,164,0.06);
  --md-codeblock-bg: rgba(98,114,164,0.08);
  --md-quote-bg: rgba(98,114,164,0.03);
  --md-table-header-bg: rgba(98,114,164,0.10);
}
```

### D. 资源链接

- **Zion Next GitHub**: https://github.com/your-org/zion-next
- **Zion Local Tools GitHub**: https://github.com/your-org/zion-local-tools
- **CodeMirror 6 文档**: https://codemirror.net/docs/
- **FastAPI 文档**: https://fastapi.tiangolo.com/
- **VS Code 扩展 API 文档**: https://code.visualstudio.com/api

---

## 更新日志

### 2025-01-09 - 重大更新

#### 新增
- **新的插件清单格式**：支持 `manifest.json` 和 `package.json`（内嵌 `zion` 字段）
- **HTTP 插件安装器**：支持从 HTTP 服务、本地 ZIP 文件、开发模式安装插件
- **模型提供者 API**：`window.zion.models.registerProvider()`
- **主题系统**：`window.zion.toggleTheme` / `window.zion.setTheme`
- **编辑器配置 API**：
  - `window.zion.toggleLineNumbers` / `window.zion.setLineNumbers`
  - `window.zion.toggleActiveLineHighlight` / `window.zion.setActiveLineHighlight`
  - `window.zion.toggleSyntaxHighlight` / `window.zion.setSyntaxHighlight`
  - `window.zion.toggleAutoIndent` / `window.zion.setAutoIndent`
  - `window.zion.toggleFolding` / `window.zion.setFolding`
  - `window.zion.toggleLineWrap` / `window.zion.setLineWrap`
- **WYSIWYG 模式 API**：`window.zion.toggleWysiwyg` / `window.zion.setWysiwyg`
- **新的 `when` 条件**：`searchReplaceVisible`（搜索/替换面板可见时）
- **开发模式热重载**：支持文件变化时自动重新加载插件

#### 变更
- **插件清单格式**：从 `extension.json` 迁移到 `manifest.json`
- **插件安装方式**：新增多种安装方式，向后兼容内置扩展
- **插件生命周期**：新增 `activating` 和 `deactivating` 状态
- **插件状态管理**：支持 localStorage 持久化启用/禁用状态

#### 废弃
- **旧版 `extension.json` 格式**：建议迁移到新的 `manifest.json` 格式

---

## 联系方式

如有疑问或建议，请通过以下方式联系：

- **GitHub Issues**: https://github.com/your-org/zion-next/issues
- **Email**: support@example.com
- **Discord**: https://discord.gg/your-server

---

**版权声明**

本文档遵循 CC BY-SA 4.0 许可证。
