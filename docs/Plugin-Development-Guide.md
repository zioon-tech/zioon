# Zion Next 插件开发指南

## 目录

1. [项目概述](#项目概述)
2. [插件系统架构](#插件系统架构)
3. [开发环境搭建](#开发环境搭建)
4. [前端插件开发](#前端插件开发)
5. [后端工具集成](#后端工具集成)
6. [插件开发模式](#插件开发模式)
7. [UI 组件和样式规范](#ui-组件和样式规范)
8. [API 参考](#api-参考)
9. [示例插件](#示例插件)
10. [最佳实践](#最佳实践)
11. [常见问题](#常见问题)

---

## 项目概述

### Zion Next 是什么？

Zion Next 是一个基于 CodeMirror 6 的**大模型交互编辑器平台**，旨在通过插件系统实现无限的可扩展性。它不仅仅是一个聊天机器人，而是一个功能完整的编辑器和应用程序平台。

### 核心特性

- **基于 CodeMirror 6 的编辑器**：提供强大的文本编辑能力
- **所见即所得的 Markdown 编辑**：支持实时预览和交互
- **大模型集成**：内置 Chat 功能，可与各种大模型进行对话
- **插件系统**：完整的插件架构，支持丰富的扩展能力
- **本地工具服务**：通过 Zion Local Tools 提供文件系统、命令行等本地能力

### 插件系统的设计目标

1. **最大化自由度**：插件开发者应该能够实现几乎任何功能
2. **与内置扩展平等**：插件应拥有与内置扩展相同的能力
3. **模块化架构**：插件间可以相互协作，共享数据和事件
4. **开发友好**：提供完善的开发工具和热重载支持

---

## 插件系统架构

### 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                   Zion Next (前端)                    │
│  ┌───────────────────────────────────────────────┐   │
│  │           插件运行时 (Plugin Runtime)      │   │
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

- **安装**：将插件文件放置到插件目录或通过开发模式加载
- **启用**：用户在插件面板中启用插件，插件在应用重启后激活
- **激活**：调用插件的 `activate(ctx)` 函数，插件开始运行
- **运行**：插件处于活动状态，响应命令和事件
- **停用**：调用插件的 `deactivate()` 函数，清理资源
- **禁用**：用户在插件面板中禁用插件，插件不再激活
- **卸载**：从系统中移除插件

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

## 前端插件开发

### 插件基本结构

一个 Zion Next 插件至少包含两个文件：

```
my-plugin/
├── extension.json      # 插件清单（必需）
├── main.js            # 插件入口（必需）
├── package.json        # NPM 配置（可选，用于依赖管理）
└── assets/            # 资源文件（可选）
    └── icon.png
```

### 插件清单 (extension.json)

```json
{
  "name": "my.plugin",
  "version": "1.0.0",
  "description": "My awesome plugin",
  "author": "Your Name",
  "license": "MIT",
  "main": "./main.js",
  "contributes": {
    "commands": [
      {
        "id": "my.command",
        "title": "My Command",
        "description": "Execute my command"
      }
    ],
    "keybindings": [
      {
        "command": "my.command",
        "key": "Mod-Shift-M",
        "when": "editorFocus"
      }
    ],
    "menus": [
      {
        "location": "editor/context",
        "command": "my.command",
        "title": "Run My Command",
        "when": "hasSelection"
      }
    ],
    "statusBar": [
      {
        "id": "my.status",
        "text": "My Plugin",
        "tooltip": "My plugin is active"
      }
    ]
  },
  "activationEvents": [
    "onStartupFinished",
    "onCommand:my.command"
  ]
}
```

**清单字段说明**：

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 插件名称，建议使用 `scope.name` 格式 |
| `version` | string | ✅ | 插件版本，遵循语义化版本规范 |
| `description` | string | ❌ | 插件描述 |
| `author` | string | ❌ | 插件作者 |
| `license` | string | ❌ | 插件许可证 |
| `main` | string | ✅ | 插件入口文件路径 |
| `contributes` | object | ❌ | 插件贡献点声明 |
| `activationEvents` | array | ❌ | 插件激活事件 |

**contributes 支持的贡献点**：

- `commands`: 命令定义
- `keybindings`: 快捷键绑定
- `menus`: 菜单项
- `statusBar`: 状态栏按钮

**activationEvents 支持的事件**：

- `onStartupFinished`: 应用启动完成后
- `onCommand:commandId`: 特定命令执行时

### 插件入口 (main.js)

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
    'my.command',
    () => {
      // 命令处理逻辑
      console.log('My command executed!');
    }
  );
  ctx.subscriptions.push(commandDisposable);

  // 2. 注册快捷键
  const keybindingDisposable = window.zion.keybindings.register({
    command: 'my.command',
    key: 'Mod-Shift-M',
    when: 'editorFocus'
  });
  ctx.subscriptions.push(keybindingDisposable);

  // 3. 注册状态栏按钮
  const statusBarDisposable = window.zion.statusBar.registerItem({
    id: 'my.status',
    text: 'My Plugin',
    tooltip: 'My plugin is active',
    onClick: () => {
      window.zion.commands.executeCommand('my.command');
    }
  });
  ctx.subscriptions.push(statusBarDisposable);

  // 4. 监听事件
  const eventDisposable = window.zion.events.on('my.event', (payload) => {
    console.log('Received event:', payload);
  });
  ctx.subscriptions.push(eventDisposable);

  // 5. 初始化插件状态
  await ctx.globalState.update('initialized', true);
}

/**
 * 插件停用函数（可选）
 */
export async function deactivate() {
  // 清理插件资源
  console.log('My plugin deactivated');
}
```

---

## 后端工具集成

### Zion Local Tools 概述

Zion Local Tools 是一个基于 FastAPI 的本地服务，为前端提供以下能力：

- **文件操作**: 读写、搜索、编辑文件
- **命令执行**: 在本地 shell 中执行命令
- **搜索**: 网络搜索（DuckDuckGo）
- **会话管理**: 管理会话数据
- **邮件服务**: 发送邮件
- **插件管理**: 上传、下载、搜索插件

### 基础 API 调用

插件可以通过 `fetch` API 调用 Zion Local Tools 的接口：

```javascript
// 获取服务 URL
const serviceUrl = window.zionLocalToolsUrl || 'http://127.0.0.1:8765';

// 调用健康检查
async function checkHealth() {
  const response = await fetch(`${serviceUrl}/health`);
  const data = await response.json();
  return data;
}

// 读取文件
async function readFile(path) {
  const response = await fetch(
    `${serviceUrl}/files/read?path=${encodeURIComponent(path)}`
  );
  const data = await response.json();
  return data;
}

// 写入文件
async function writeFile(path, content) {
  const response = await fetch(`${serviceUrl}/files/write`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ path, content })
  });
  const data = await response.json();
  return data;
}

// 执行命令
async function executeCommand(command, timeout = 120000) {
  const response = await fetch(`${serviceUrl}/bash`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ command, timeout })
  });
  const data = await response.json();
  return data;
}

// 搜索文件
async function globFiles(pattern, path) {
  const url = new URL(`${serviceUrl}/files/glob`);
  url.searchParams.append('pattern', pattern);
  if (path) {
    url.searchParams.append('path', path);
  }
  const response = await fetch(url);
  const data = await response.json();
  return data;
}

// 搜索内容
async function grepContent(pattern, options = {}) {
  const url = new URL(`${serviceUrl}/files/grep`);
  url.searchParams.append('pattern', pattern);
  Object.entries(options).forEach(([key, value]) => {
    url.searchParams.append(key, value);
  });
  const response = await fetch(url);
  const data = await response.json();
  return data;
}
```

### 插件工具封装

建议在插件中封装一个工具类来简化后端 API 调用：

```javascript
// tools.js
export class ZionLocalTools {
  constructor(baseUrl = null) {
    this.baseUrl = baseUrl || window.zionLocalToolsUrl || 'http://127.0.0.1:8765';
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    });
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  // 文件操作
  async readFile(path) {
    return this.request('/files/read', {
      method: 'POST',
      body: JSON.stringify({ path })
    });
  }

  async writeFile(path, content) {
    return this.request('/files/write', {
      method: 'POST',
      body: JSON.stringify({ path, content })
    });
  }

  async editFile(path, edits) {
    return this.request('/files/edit', {
      method: 'POST',
      body: JSON.stringify({ path, edits })
    });
  }

  async listEntries(path, recursive = false) {
    return this.request('/files/entries', {
      method: 'POST',
      body: JSON.stringify({ path, recursive })
    });
  }

  // 搜索
  async glob(pattern, path) {
    const url = new URL(`${this.baseUrl}/files/glob`);
    url.searchParams.append('pattern', pattern);
    if (path) url.searchParams.append('path', path);
    const response = await fetch(url);
    return response.json();
  }

  async grep(pattern, options = {}) {
    const url = new URL(`${this.baseUrl}/files/grep`);
    url.searchParams.append('pattern', pattern);
    Object.entries(options).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });
    const response = await fetch(url);
    return response.json();
  }

  // 命令执行
  async execute(command, timeout = 120000) {
    return this.request('/bash', {
      method: 'POST',
      body: JSON.stringify({ command, timeout })
    });
  }

  // 搜索
  async search(query, options = {}) {
    const url = new URL(`${this.baseUrl}/search`);
    url.searchParams.append('q', query);
    Object.entries(options).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });
    const response = await fetch(url);
    return response.json();
  }
}

// 在插件中使用
export async function activate(ctx) {
  const tools = new ZionLocalTools();

  // 注册命令
  const command = window.zion.commands.registerCommand('tools.read', async () => {
    const editor = window.zion.window.activeEditor;
    if (!editor) return;

    const selection = editor.getSelection();
    if (!selection) {
      alert('请先选择一个文件路径');
      return;
    }

    try {
      const result = await tools.readFile(selection);
      if (result.ok) {
        editor.setValue(result.content);
      } else {
        alert(`读取文件失败: ${result.error}`);
      }
    } catch (error) {
      console.error('Read file error:', error);
      alert(`读取文件时发生错误: ${error.message}`);
    }
  });

  ctx.subscriptions.push(command);
}
```

---

## 插件开发模式

### 开发模式概述

Zion Next 提供了强大的开发模式支持，允许开发者在本地目录中开发插件，并通过 Zion Local Tools 提供的热重载功能实时预览修改。

### 设置开发环境

#### 1. 创建开发目录

```bash
# 在项目外创建插件目录
mkdir ~/my-zion-plugins
cd ~/my-zion-plugins

# 创建你的插件
mkdir my-awesome-plugin
cd my-awesome-plugin

# 创建基本文件结构
touch extension.json main.js
```

#### 2. 启动开发会话

```javascript
// 在浏览器控制台执行
const devPath = '/Users/yourname/my-zion-plugins/my-awesome-plugin';

// 调用插件服务的开发模式 API
fetch('http://127.0.0.1:8765/plugins/dev/start', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ path: devPath })
})
.then(response => response.json())
.then(data => {
  console.log('Dev session started:', data);
  // data.data.baseUrl: "/plugins/dev/{devId}"
  const pluginUrl = `http://127.0.0.1:8765${data.data.baseUrl}/manifest.json`;
  console.log('Plugin manifest URL:', pluginUrl);
})
.catch(error => {
  console.error('Failed to start dev session:', error);
});
```

#### 3. 安装开发中的插件

```javascript
// 使用插件管理器安装开发中的插件
await window.zion.plugins.installFromService({
  baseUrl: 'http://127.0.0.1:8765',
  pluginId: 'my-awesome-plugin',
  manifestUrl: '/plugins/dev/{devId}/manifest.json'
}, { enabled: true });
```

#### 4. 热重载

当你修改插件文件后，Zion Local Tools 会自动检测变化并通过 WebSocket 推送更新。前端会自动重新加载插件。

**监听开发事件**：

```javascript
// 可选：监听开发模式事件
const ws = new WebSocket('ws://127.0.0.1:8765/plugins/dev/ws/{devId}');

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

#### 5. 停止开发会话

```javascript
fetch('http://127.0.0.1:8765/plugins/dev/stop', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ devId: '{devId}' })
})
.then(response => response.json())
.then(data => {
  console.log('Dev session stopped:', data);
});
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

### 调试技巧

#### 1. 使用浏览器开发者工具

- **Console**: 查看 `console.log` 输出和错误信息
- **Network**: 查看网络请求（API 调用、插件加载）
- **Application**: 查看 localStorage、IndexedDB 存储数据
- **Elements**: 检查 DOM 结构和样式

#### 2. 插件调试

```javascript
// 在插件中添加调试代码
export async function activate(ctx) {
  console.log('[My Plugin] Activating...');

  try {
    // 插件逻辑
  } catch (error) {
    console.error('[My Plugin] Error:', error);
    // 显示错误提示
    ctx.log(`Plugin error: ${error.message}`, 'error');
  }
}
```

#### 3. 使用断点调试

```javascript
export async function activate(ctx) {
  debugger; // 设置断点

  const command = window.zion.commands.registerCommand('my.command', () => {
    debugger; // 在命令执行时断点
    // 命令逻辑
  });

  ctx.subscriptions.push(command);
}
```

#### 4. 查看插件状态

```javascript
// 在控制台中查看插件管理器状态
console.log('Plugins:', window.zion.plugins.list());
console.log('Active plugins:', window.zion.plugins.getActivePlugins());
console.log('Plugin stats:', window.zion.plugins.getStats());
```

---

## UI 组件和样式规范

### CSS 变量系统

Zion Next 使用 CSS 变量来定义主题和样式，插件开发时应使用这些变量来保持一致的外观。

#### 基础颜色变量

```css
/* 深色主题（默认） */
:root {
  --bg: #282c34;              /* 背景色 */
  --panel: #282a36;           /* 面板背景色 */
  --border: #44475a;          /* 边框颜色 */
  --fg: #d1d5db;             /* 前景色 */
  --accent: #6272a4;          /* 强调色 */
  --ok: #50fa7b;              /* 成功色 */
}
```

#### 字体变量

```css
:root {
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text",
    "Segoe UI", Roboto, "Noto Sans", "Noto Sans CJK SC", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
    "Liberation Mono", "Courier New", monospace;
}
```

#### Markdown UI 变量

```css
:root {
  --md-code-bg: rgba(98,114,164,0.06);      /* 行内代码背景 */
  --md-codeblock-bg: rgba(98,114,164,0.08);  /* 代码块背景 */
  --md-quote-bg: rgba(98,114,164,0.03);     /* 引用块背景 */
  --md-table-header-bg: rgba(98,114,164,0.10); /* 表头背景 */
}
```

### 创建自定义 UI 组件

#### 按钮组件

```javascript
function createButton(options) {
  const { text, onClick, variant = 'default', icon = null } = options;

  const button = document.createElement('button');
  button.textContent = text;
  button.type = 'button';

  // 基础样式
  button.style.cssText = `
    background: ${variant === 'primary' ? 'var(--accent)' : 'var(--panel)'};
    color: ${variant === 'primary' ? 'white' : 'var(--fg)'};
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 13px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: background 120ms ease, border-color 120ms ease;
  `;

  // 悬停效果
  button.onmouseenter = () => {
    button.style.background = variant === 'primary'
      ? '#7c8bc5'
      : 'var(--border)';
  };

  button.onmouseleave = () => {
    button.style.background = variant === 'primary'
      ? 'var(--accent)'
      : 'var(--panel)';
  };

  // 点击效果
  if (onClick) {
    button.onclick = onClick;
  }

  // 添加图标
  if (icon) {
    const iconSpan = document.createElement('span');
    iconSpan.innerHTML = icon;
    iconSpan.style.display = 'inline-flex';
    iconSpan.style.alignItems = 'center';
    button.prepend(iconSpan);
  }

  return button;
}
```

#### 面板组件

```javascript
function createPanel(options) {
  const { title, content, onClose } = options;

  // 创建遮罩
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    z-index: 99998;
    display: flex;
    align-items: center;
    justify-content: center;
  `;

  // 创建面板
  const panel = document.createElement('div');
  panel.style.cssText = `
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.35);
    max-width: 600px;
    max-height: 80vh;
    overflow: auto;
    display: flex;
    flex-direction: column;
    z-index: 99999;
  `;

  // 创建标题栏
  const header = document.createElement('div');
  header.style.cssText = `
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
  `;

  const titleEl = document.createElement('div');
  titleEl.textContent = title;
  titleEl.style.fontWeight = '500';
  titleEl.style.fontSize = '14px';
  titleEl.style.color = 'var(--fg)';

  const closeButton = createButton({
    text: '×',
    onClick: () => {
      overlay.remove();
      if (onClose) onClose();
    }
  });
  closeButton.style.padding = '2px 8px';

  header.appendChild(titleEl);
  header.appendChild(closeButton);

  // 创建内容区域
  const contentEl = document.createElement('div');
  contentEl.style.padding = '16px';
  contentEl.style.color = 'var(--fg)';
  if (typeof content === 'string') {
    contentEl.textContent = content;
  } else if (content instanceof HTMLElement) {
    contentEl.appendChild(content);
  }

  // 组装面板
  panel.appendChild(header);
  panel.appendChild(contentEl);
  overlay.appendChild(panel);

  // 点击遮罩关闭
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.remove();
      if (onClose) onClose();
    }
  });

  // 添加到文档
  document.body.appendChild(overlay);

  return { overlay, panel };
}
```

#### 侧边栏组件

```javascript
function createSidebar(options) {
  const { id, position = 'left', width = 300 } = options;

  const sidebar = document.createElement('div');
  sidebar.id = id;
  sidebar.style.cssText = `
    position: fixed;
    top: 0;
    ${position}: 0;
    width: ${width}px;
    height: 100vh;
    background: var(--panel);
    border-${position === 'left' ? 'right' : 'left'}: 1px solid var(--border);
    z-index: 99990;
    display: flex;
    flex-direction: column;
  `;

  // 调整主容器边距
  if (position === 'left') {
    document.body.style.marginLeft = `${width}px`;
  } else {
    document.body.style.marginRight = `${width}px`;
  }

  // 添加调整大小手柄
  const resizer = document.createElement('div');
  resizer.style.cssText = `
    position: absolute;
    ${position === 'left' ? 'right' : 'left'}: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    cursor: col-resize;
    background: transparent;
  `;

  // 实现拖拽调整大小
  let isDragging = false;
  let startX = 0;
  let startWidth = width;

  resizer.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const delta = e.clientX - startX;
    const newWidth = position === 'left'
      ? startWidth + delta
      : startWidth - delta;
    const constrainedWidth = Math.max(200, Math.min(600, newWidth));
    sidebar.style.width = `${constrainedWidth}px`;

    if (position === 'left') {
      document.body.style.marginLeft = `${constrainedWidth}px`;
    } else {
      document.body.style.marginRight = `${constrainedWidth}px`;
    }
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    document.body.style.userSelect = '';
  });

  resizer.addEventListener('mouseenter', () => {
    resizer.style.background = 'var(--border)';
  });

  resizer.addEventListener('mouseleave', () => {
    resizer.style.background = 'transparent';
  });

  sidebar.appendChild(resizer);
  document.body.appendChild(sidebar);

  return {
    sidebar,
    appendContent: (element) => {
      sidebar.appendChild(element);
    },
    close: () => {
      document.body.style.marginLeft = '';
      document.body.style.marginRight = '';
      sidebar.remove();
    }
  };
}
```

### 使用 CSS 变量创建可主题化的组件

```javascript
function createThemeAwareComponent() {
  const container = document.createElement('div');

  // 使用 CSS 变量，自动适配主题
  container.style.cssText = `
    --my-custom-bg: var(--panel, #282a36);
    --my-custom-fg: var(--fg, #d1d5db);
    --my-custom-border: var(--border, #44475a);
    --my-custom-accent: var(--accent, #6272a4);

    background: var(--my-custom-bg);
    color: var(--my-custom-fg);
    border: 1px solid var(--my-custom-border);
    border-radius: 8px;
    padding: 16px;
  `;

  const title = document.createElement('div');
  title.textContent = 'Theme-aware Component';
  title.style.color = 'var(--my-custom-accent)';
  title.style.fontWeight = '500';
  title.style.marginBottom = '8px';

  const content = document.createElement('div');
  content.textContent = 'This component automatically adapts to light/dark theme';

  container.appendChild(title);
  container.appendChild(content);

  return container;
}
```

---

## API 参考

### 核心对象：window.zion

`window.zion` 是所有插件 API 的入口点。

### 命令系统

#### registerCommand(id, handler)

注册一个命令。

**参数**：
- `id` (string): 命令 ID，建议使用 `scope.command` 格式
- `handler` (function): 命令处理函数

**返回值**：
- `Disposable`: 可销毁对象，用于取消注册

**示例**：
```javascript
const disposable = window.zion.commands.registerCommand(
  'my.hello',
  (name = 'World') => {
    console.log(`Hello, ${name}!`);
  }
);
```

#### executeCommand(id, ...args)

执行一个命令。

**参数**：
- `id` (string): 命令 ID
- `...args` (any): 命令参数

**返回值**：
- `any`: 命令返回值

**示例**：
```javascript
const result = window.zion.commands.executeCommand('my.hello', 'Zion');
```

### 快捷键系统

#### register(binding)

注册一个快捷键绑定。

**参数**：
- `binding` (object): 快捷键配置
  - `command` (string): 命令 ID
  - `key` (string): 快捷键，如 `Mod-Shift-M`
  - `when` (string, optional): 激活条件，如 `'editorFocus'`

**返回值**：
- `Disposable`: 可销毁对象，用于取消注册

**示例**：
```javascript
const disposable = window.zion.keybindings.register({
  command: 'my.command',
  key: 'Mod-Shift-M',
  when: 'editorFocus'
});
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

#### list()

列出所有已注册的快捷键。

**返回值**：
- `Array<Keybinding>`: 快捷键列表

**示例**：
```javascript
const bindings = window.zion.keybindings.list();
console.log('All keybindings:', bindings);
```

### 菜单系统

#### register(menuId, item)

注册一个菜单项。

**参数**：
- `menuId` (string): 菜单 ID，目前支持 `'editor/context'`
- `item` (object): 菜单项配置
  - `command` (string): 命令 ID
  - `title` (string): 菜单项标题
  - `when` (string, optional): 显示条件

**返回值**：
- `Disposable`: 可销毁对象，用于取消注册

**示例**：
```javascript
const disposable = window.zion.menus.register(
  'editor/context',
  {
    command: 'my.command',
    title: 'Run My Command',
    when: 'hasSelection'
  }
);
```

### 状态栏

#### registerItem(options)

注册一个状态栏按钮。

**参数**：
- `options` (object): 状态栏项配置
  - `id` (string): 唯一标识符
  - `text` (string): 显示文本
  - `tooltip` (string, optional): 工具提示
  - `onClick` (function, optional): 点击处理函数

**返回值**：
- `Disposable`: 可销毁对象，用于取消注册

**示例**：
```javascript
const disposable = window.zion.statusBar.registerItem({
  id: 'my.status',
  text: 'My Plugin',
  tooltip: 'My plugin is active',
  onClick: () => {
    window.zion.commands.executeCommand('my.command');
  }
});
```

### 事件总线

#### emit(topic, payload)

发布一个事件。

**参数**：
- `topic` (string): 事件主题
- `payload` (any, optional): 事件数据

**示例**：
```javascript
window.zion.events.emit('my.event', { data: 'Hello' });
```

#### on(topic, handler)

订阅一个事件。

**参数**：
- `topic` (string): 事件主题
- `handler` (function): 事件处理函数

**返回值**：
- `Disposable`: 可销毁对象，用于取消订阅

**示例**：
```javascript
const disposable = window.zion.events.on('my.event', (payload) => {
  console.log('Received event:', payload);
});
```

### 状态总线

#### get(key)

获取状态值。

**参数**：
- `key` (string): 状态键

**返回值**：
- `any`: 状态值

**示例**：
```javascript
const theme = window.zion.state.get('ui.theme');
```

#### set(key, value)

设置状态值。

**参数**：
- `key` (string): 状态键
- `value` (any): 状态值

**示例**：
```javascript
window.zion.state.set('my.setting', true);
```

#### update(key, updater)

更新状态值。

**参数**：
- `key` (string): 状态键
- `updater` (function): 更新函数，接收旧值，返回新值

**示例**：
```javascript
window.zion.state.update('my.counter', (old) => (old || 0) + 1);
```

#### onDidChange(key, handler)

监听状态变化。

**参数**：
- `key` (string): 状态键
- `handler` (function): 变化处理函数，接收新值和旧值

**返回值**：
- `Disposable`: 可销毁对象，用于取消监听

**示例**：
```javascript
const disposable = window.zion.state.onDidChange('ui.theme', (newVal, oldVal) => {
  console.log(`Theme changed from ${oldVal} to ${newVal}`);
});
```

### 编辑器 API

#### registerPasteHandler(handler)

注册一个粘贴处理器。

**参数**：
- `handler` (object): 处理器配置
  - `id` (string): 唯一标识符
  - `priority` (number, optional): 优先级，越大越先执行，默认 50
  - `handle` (function): 处理函数
    - 参数: `{ clipboardData, editor }`
    - 返回值: `boolean` - 是否已处理，true 将阻止默认粘贴

**返回值**：
- `Disposable`: 可销毁对象，用于取消注册

**示例**：
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

注册一个编辑器装饰器。

**参数**：
- `decorator` (object): 装饰器配置
  - `id` (string): 唯一标识符
  - `apply` (function): 应用函数
    - 参数: `editor` (EditorProxy)
    - 返回值: `Disposable` - 用于清理

**返回值**：
- `Disposable`: 可销毁对象，用于取消注册

**示例**：
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

### 编辑器代理 (EditorProxy)

#### getValue()

获取编辑器内容。

**返回值**：
- `string`: 编辑器内容

**示例**：
```javascript
const editor = window.zion.window.activeEditor;
const content = editor.getValue();
```

#### setValue(value)

设置编辑器内容。

**参数**：
- `value` (string): 新内容

**示例**：
```javascript
const editor = window.zion.window.activeEditor;
editor.setValue('Hello, World!');
```

#### replaceSelection(text)

替换当前选区。

**参数**：
- `text` (string): 替换文本

**示例**：
```javascript
const editor = window.zion.window.activeEditor;
editor.replaceSelection('new text');
```

#### getSelection()

获取当前选区。

**返回值**：
- `string`: 选区文本

**示例**：
```javascript
const editor = window.zion.window.activeEditor;
const selection = editor.getSelection();
```

#### replaceRange(text, from, to)

替换指定范围的文本。

**参数**：
- `text` (string): 新文本
- `from` (object): 起始位置 `{ line, ch }`
- `to` (object, optional): 结束位置 `{ line, ch }`

**示例**：
```javascript
const editor = window.zion.window.activeEditor;
editor.replaceRange('replacement', { line: 0, ch: 0 }, { line: 0, ch: 5 });
```

#### getCursor()

获取光标位置。

**返回值**：
- `object`: `{ line, ch }`

**示例**：
```javascript
const editor = window.zion.window.activeEditor;
const cursor = editor.getCursor();
console.log('Cursor at:', cursor);
```

#### setCursor(pos)

设置光标位置。

**参数**：
- `pos` (object): 位置 `{ line, ch }`

**示例**：
```javascript
const editor = window.zion.window.activeEditor;
editor.setCursor({ line: 10, ch: 0 });
```

#### focus()

让编辑器获得焦点。

**示例**：
```javascript
const editor = window.zion.window.activeEditor;
editor.focus();
```

#### addVisualExtension(ext)

添加 CodeMirror 6 视觉扩展。

**参数**：
- `ext` (any): CM6 扩展对象

**示例**：
```javascript
import { ViewPlugin, Decoration } from '@codemirror/view';

const myPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    // 初始化
  }

  update(update) {
    // 处理更新
  }
});

const disposable = window.zion.editor.registerDecorator({
  id: 'my.visual',
  apply: (editor) => {
    editor.addVisualExtension(myPlugin);
    return { dispose() {} };
  }
});
```

### 消息管道

#### registerContributor(contributor)

注册消息贡献者。

**参数**：
- `contributor` (object): 贡献者配置
  - `id` (string): 唯一标识符
  - `order` (number, optional): 执行顺序，越小越早，默认 50
  - `stage` (string, optional): 阶段，'pre' 或 'post'，默认 'pre'
  - `contribute` (function): 贡献函数
    - 参数: `messages, ctx`
    - 返回值: `Promise<Array>` | `Array` - 新的消息数组

**返回值**：
- `Disposable`: 可销毁对象，用于取消注册

**示例**：
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

注册一个模型提供者。

**参数**：
- `provider` (object): 提供者配置
  - `id` (string): 唯一标识符
  - `list` (function): 列出模型函数
  - `resolve` (function): 解析模型函数

**返回值**：
- `Disposable`: 可销毁对象，用于取消注册

**示例**：
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

### 插件管理

注意：这些 API 是未来功能，当前可能不完全可用。

#### list()

列出所有已安装的插件。

**返回值**：
- `Array<PluginInfo>`: 插件信息列表

**示例**：
```javascript
const plugins = window.zion.plugins.list();
console.log('Installed plugins:', plugins);
```

#### get(pluginId)

获取指定插件的信息。

**参数**：
- `pluginId` (string): 插件 ID

**返回值**：
- `PluginInfo | null`: 插件信息

**示例**：
```javascript
const plugin = window.zion.plugins.get('my.plugin');
console.log('Plugin info:', plugin);
```

#### enable(pluginId)

启用一个插件。

**参数**：
- `pluginId` (string): 插件 ID

**返回值**：
- `Promise<void>`

**示例**：
```javascript
await window.zion.plugins.enable('my.plugin');
```

#### disable(pluginId)

禁用一个插件。

**参数**：
- `pluginId` (string): 插件 ID

**返回值**：
- `Promise<void>`

**示例**：
```javascript
await window.zion.plugins.disable('my.plugin');
```

---

## 示例插件

### 示例 1: 简单的文本插入插件

这个插件提供一个命令，可以在编辑器中插入当前时间戳。

**extension.json**:
```json
{
  "name": "dev.timestamp",
  "version": "1.0.0",
  "description": "Insert timestamp into editor",
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
        "key": "Mod-Shift-T"
      }
    ]
  },
  "activationEvents": ["onStartupFinished"]
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
}
```

### 示例 2: 文件浏览器插件

这个插件创建一个侧边栏，显示本地文件系统，并允许打开文件。

**extension.json**:
```json
{
  "name": "dev.file-browser",
  "version": "1.0.0",
  "description": "Browse and open local files",
  "main": "./main.js",
  "contributes": {
    "commands": [
      {
        "id": "fileBrowser.toggle",
        "title": "Toggle File Browser"
      },
      {
        "id": "fileBrowser.open",
        "title": "Open File"
      }
    ],
    "keybindings": [
      {
        "command": "fileBrowser.toggle",
        "key": "Mod-Shift-B"
      }
    ],
    "statusBar": [
      {
        "id": "fileBrowser.status",
        "text": "📁",
        "tooltip": "Toggle File Browser"
      }
    ]
  },
  "activationEvents": ["onStartupFinished"]
}
```

**main.js**:
```javascript
export async function activate(ctx) {
  let sidebarVisible = false;
  let sidebarElement = null;

  // 创建侧边栏
  function createSidebar() {
    const sidebar = document.createElement('div');
    sidebar.style.cssText = `
      position: fixed;
      left: 0;
      top: 0;
      width: 300px;
      height: 100vh;
      background: var(--panel);
      border-right: 1px solid var(--border);
      z-index: 99990;
      display: flex;
      flex-direction: column;
      padding: 16px;
    `;

    const header = document.createElement('div');
    header.textContent = 'File Browser';
    header.style.cssText = `
      font-weight: 500;
      font-size: 14px;
      margin-bottom: 12px;
      color: var(--fg);
    `;

    const fileList = document.createElement('div');
    fileList.id = 'file-list';
    fileList.style.cssText = `
      flex: 1;
      overflow-y: auto;
    `;

    sidebar.appendChild(header);
    sidebar.appendChild(fileList);

    return sidebar;
  }

  // 加载文件列表
  async function loadFiles(path = '.') {
    try {
      const response = await fetch(
        `${window.zionLocalToolsUrl}/files/entries`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, recursive: false })
        }
      );
      const data = await response.json();

      if (data.ok) {
        renderFiles(data.entries);
      } else {
        console.error('Failed to load files:', data.error);
      }
    } catch (error) {
      console.error('Error loading files:', error);
    }
  }

  // 渲染文件列表
  function renderFiles(entries) {
    const fileList = document.getElementById('file-list');
    if (!fileList) return;

    fileList.innerHTML = '';

    entries.forEach(entry => {
      const item = document.createElement('div');
      item.style.cssText = `
        padding: 6px 8px;
        cursor: pointer;
        border-radius: 4px;
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
        color: var(--fg);
      `;

      item.onmouseenter = () => {
        item.style.background = 'var(--border)';
      };

      item.onmouseleave = () => {
        item.style.background = 'transparent';
      };

      const icon = entry.type === 'directory' ? '📁' : '📄';
      item.textContent = `${icon} ${entry.name}`;

      item.onclick = () => {
        if (entry.type === 'directory') {
          loadFiles(entry.path);
        } else {
          openFile(entry.path);
        }
      };

      fileList.appendChild(item);
    });
  }

  // 打开文件
  async function openFile(path) {
    try {
      const response = await fetch(
        `${window.zionLocalToolsUrl}/files/read`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path })
        }
      );
      const data = await response.json();

      if (data.ok) {
        const editor = window.zion.window.activeEditor;
        editor.setValue(data.content);
      } else {
        alert(`Failed to open file: ${data.error}`);
      }
    } catch (error) {
      console.error('Error opening file:', error);
      alert(`Error opening file: ${error.message}`);
    }
  }

  // 切换侧边栏
  function toggleSidebar() {
    if (sidebarVisible) {
      sidebarElement.remove();
      document.body.style.marginLeft = '';
    } else {
      sidebarElement = createSidebar();
      document.body.appendChild(sidebarElement);
      document.body.style.marginLeft = '300px';
      loadFiles();
    }
    sidebarVisible = !sidebarVisible;
  }

  // 注册命令
  const toggleCommand = window.zion.commands.registerCommand(
    'fileBrowser.toggle',
    toggleSidebar
  );
  ctx.subscriptions.push(toggleCommand);

  // 状态栏按钮
  const statusBarDisposable = window.zion.statusBar.registerItem({
    id: 'fileBrowser.status',
    text: '📁',
    tooltip: 'Toggle File Browser',
    onClick: toggleSidebar
  });
  ctx.subscriptions.push(statusBarDisposable);
}
```

### 示例 3: 搜索增强插件

这个插件增强搜索功能，支持正则表达式搜索。

**extension.json**:
```json
{
  "name": "dev.search-regex",
  "version": "1.0.0",
  "description": "Regex search enhancement",
  "main": "./main.js",
  "contributes": {
    "commands": [
      {
        "id": "searchRegex.show",
        "title": "Show Regex Search"
      }
    ],
    "keybindings": [
      {
        "command": "searchRegex.show",
        "key": "Mod-Shift-R"
      }
    ]
  },
  "activationEvents": ["onCommand:searchRegex.show"]
}
```

**main.js**:
```javascript
export async function activate(ctx) {
  let panelElement = null;

  function createSearchPanel() {
    // 移除已存在的面板
    if (panelElement) {
      panelElement.remove();
    }

    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 99998;
    `;

    const panel = document.createElement('div');
    panel.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      z-index: 99999;
      min-width: 400px;
      color: var(--fg);
    `;

    const title = document.createElement('div');
    title.textContent = 'Regex Search';
    title.style.cssText = `
      font-weight: 500;
      font-size: 16px;
      margin-bottom: 16px;
    `;

    const form = document.createElement('div');
    form.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 12px;
    `;

    const patternInput = document.createElement('input');
    patternInput.type = 'text';
    patternInput.placeholder = 'Enter regex pattern (e.g., \\btest\\b)';
    patternInput.style.cssText = `
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg);
      color: var(--fg);
      font-family: var(--font-mono);
      font-size: 14px;
    `;

    const options = document.createElement('div');
    options.style.cssText = `
      display: flex;
      gap: 16px;
    `;

    const caseSensitive = document.createElement('label');
    caseSensitive.innerHTML = `
      <input type="checkbox" id="regex-case">
      Case sensitive
    `;

    const multiline = document.createElement('label');
    multiline.innerHTML = `
      <input type="checkbox" id="regex-multiline">
      Multiline
    `;

    options.appendChild(caseSensitive);
    options.appendChild(multiline);

    const buttons = document.createElement('div');
    buttons.style.cssText = `
      display: flex;
      gap: 8px;
      margin-top: 8px;
    `;

    const searchButton = document.createElement('button');
    searchButton.textContent = 'Search';
    searchButton.style.cssText = `
      padding: 8px 16px;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    `;

    const closeButton = document.createElement('button');
    closeButton.textContent = 'Close';
    closeButton.style.cssText = `
      padding: 8px 16px;
      background: var(--panel);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    `;

    const results = document.createElement('div');
    results.id = 'regex-results';
    results.style.cssText = `
      margin-top: 16px;
      max-height: 200px;
      overflow-y: auto;
      font-family: var(--font-mono);
      font-size: 12px;
    `;

    // 搜索逻辑
    searchButton.onclick = async () => {
      const pattern = patternInput.value;
      const flags = [];
      if (!document.getElementById('regex-case').checked) {
        flags.push('i');
      }
      if (document.getElementById('regex-multiline').checked) {
        flags.push('m');
      }

      try {
        const editor = window.zion.window.activeEditor;
        const text = editor.getValue();
        const regex = new RegExp(pattern, flags.join(''));

        const matches = [];
        let match;
        while ((match = regex.exec(text)) !== null) {
          matches.push({
            index: match.index,
            text: match[0],
            groups: match.slice(1)
          });

          // 防止无限循环
          if (!match[0]) {
            regex.lastIndex++;
          }
        }

        results.innerHTML = `<div>Found ${matches.length} matches:</div>`;
        matches.slice(0, 100).forEach((m, i) => {
          const div = document.createElement('div');
          div.textContent = `${i + 1}. [${m.index}] ${m.text}`;
          div.style.cssText = `
            padding: 4px 8px;
            border-radius: 4px;
            cursor: pointer;
            margin-bottom: 4px;
          `;
          div.onmouseenter = () => {
            div.style.background = 'var(--border)';
          };
          div.onmouseleave = () => {
            div.style.background = 'transparent';
          };
          div.onclick = () => {
            editor.setCursor({ line: 0, ch: m.index });
            editor.focus();
          };
          results.appendChild(div);
        });
      } catch (error) {
        results.innerHTML = `<div style="color: #ff5555;">Error: ${error.message}</div>`;
      }
    };

    closeButton.onclick = () => {
      overlay.remove();
      panelElement = null;
    };

    overlay.onclick = (e) => {
      if (e.target === overlay) {
        overlay.remove();
        panelElement = null;
      }
    };

    buttons.appendChild(searchButton);
    buttons.appendChild(closeButton);

    form.appendChild(patternInput);
    form.appendChild(options);
    form.appendChild(buttons);

    panel.appendChild(title);
    panel.appendChild(form);
    panel.appendChild(results);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    panelElement = overlay;
  }

  const command = window.zion.commands.registerCommand(
    'searchRegex.show',
    createSearchPanel
  );
  ctx.subscriptions.push(command);
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

// ui.js
export function create(ctx) {
  // UI 创建逻辑
  const disposable = window.zion.statusBar.registerItem({
    // ...
  });
  ctx.subscriptions.push(disposable);
  return disposable;
}

// utils.js
export function formatDate(date) {
  return date.toLocaleString();
}

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

      // 可选：显示错误通知
      showNotification('error', `操作失败: ${error.message}`);
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

### 5. 性能优化

使用防抖和节流优化性能：

```javascript
// utils.js
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

// 使用
import { debounce, throttle } from './utils.js';

export async function activate(ctx) {
  const editor = window.zion.window.activeEditor;

  // 防抖：只在停止输入后执行
  const debouncedHandler = debounce(() => {
    console.log('Editor content changed (debounced)');
  }, 300);

  // 节流：限制执行频率
  const throttledHandler = throttle(() => {
    console.log('Editor cursor moved (throttled)');
  }, 100);

  // 注册监听器
  const eventDisposable = window.zion.events.on('editor.change', debouncedHandler);
  const cursorDisposable = window.zion.events.on('editor.cursorActivity', throttledHandler);

  ctx.subscriptions.push(eventDisposable, cursorDisposable);
}
```

### 6. 可访问性

确保 UI 组件的可访问性：

```javascript
function createButton(options) {
  const { text, onClick, tooltip } = options;

  const button = document.createElement('button');
  button.textContent = text;
  button.type = 'button';
  button.setAttribute('aria-label', tooltip || text);

  // 键盘导航
  button.tabIndex = 0;

  // 焦点样式
  button.addEventListener('focus', () => {
    button.style.outline = '2px solid var(--accent)';
  });

  button.addEventListener('blur', () => {
    button.style.outline = '';
  });

  // 键盘事件
  button.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      button.click();
    }
  });

  button.onclick = onClick;

  return button;
}
```

### 7. 国际化

支持多语言：

```javascript
// i18n.js
export const translations = {
  'en': {
    'plugin.title': 'My Plugin',
    'plugin.description': 'My awesome plugin',
    'command.insert': 'Insert',
    'error.failed': 'Operation failed'
  },
  'zh': {
    'plugin.title': '我的插件',
    'plugin.description': '我的 awesome 插件',
    'command.insert': '插入',
    'error.failed': '操作失败'
  }
};

export function t(key) {
  const locale = window.zion.state.get('ui.locale', 'en');
  return translations[locale]?.[key] || key;
}

// main.js
import { t } from './i18n.js';

export async function activate(ctx) {
  const command = window.zion.commands.registerCommand(
    'my.command',
    () => {
      console.log(t('plugin.title'));
    }
  );
}
```

---

## 常见问题

### Q1: 插件没有加载？

**可能原因**：
1. `extension.json` 格式错误
2. `main` 字段路径不正确
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

### Q5: 如何处理插件之间的依赖？

**方法**：
1. 在 `extension.json` 中声明依赖
2. 使用事件总线进行通信
3. 使用状态总线共享数据

**示例**：
```javascript
// extension.json
{
  "dependencies": {
    "other.plugin": "^1.0.0"
  }
}

// main.js
export async function activate(ctx) {
  // 等待依赖插件加载
  window.zion.events.on('other.plugin:ready', () => {
    console.log('Other plugin is ready');
    // 执行依赖操作
  });
}
```

### Q6: 如何创建自定义 UI？

**方法**：
1. 使用标准 DOM API 创建元素
2. 使用 CSS 变量保持样式一致
3. 确保响应式设计
4. 考虑可访问性

**示例**：
```javascript
function createPanel() {
  const panel = document.createElement('div');
  panel.style.cssText = `
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    color: var(--fg);
  `;
  return panel;
}
```

### Q7: 如何打包和发布插件？

**步骤**：
1. 确保所有文件都已包含
2. 测试插件功能
3. 创建压缩包（zip）
4. 通过 Zion Local Tools 上传或直接发布到插件市场

**示例**：
```bash
# 打包插件
zip -r my-plugin.zip my-plugin/

# 上传到服务器
curl -X POST http://127.0.0.1:8765/plugins/upload \
  -F "file=@my-plugin.zip" \
  -F "metadata={\"name\":\"my.plugin\",\"version\":\"1.0.0\"}"
```

### Q8: 插件性能问题？

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

### Q9: 如何处理主题切换？

**方法**：
1. 使用 CSS 变量
2. 监听主题变化事件
3. 动态更新样式

**示例**：
```javascript
export async function activate(ctx) {
  const themeDisposable = window.zion.state.onDidChange('ui.theme', (newTheme) => {
    console.log('Theme changed to:', newTheme);
    // 更新自定义 UI 的主题
    updateTheme(newTheme);
  });
  ctx.subscriptions.push(themeDisposable);
}
```

### Q10: 如何测试插件？

**方法**：
1. 使用开发模式进行热重载测试
2. 创建单元测试（使用 Vitest）
3. 手动测试各种场景
4. 收集用户反馈

**示例**：
```javascript
// tests/plugin.test.js
import { describe, it, expect } from 'vitest';
import { activate } from '../main.js';

describe('My Plugin', () => {
  it('should register command', async () => {
    const ctx = {
      subscriptions: []
    };

    await activate(ctx);

    expect(ctx.subscriptions.length).toBeGreaterThan(0);
    expect(window.zion.commands.executeCommand('my.command')).toBeDefined();
  });
});
```

---

## 附录

### A. 插件清单完整示例

```json
{
  "name": "my.awesome.plugin",
  "version": "1.0.0",
  "description": "An awesome plugin for Zion Next",
  "author": "Your Name",
  "license": "MIT",
  "main": "./main.js",
  "icon": "./assets/icon.png",
  "contributes": {
    "commands": [
      {
        "id": "my.command1",
        "title": "Command 1",
        "description": "Description of command 1"
      },
      {
        "id": "my.command2",
        "title": "Command 2",
        "description": "Description of command 2"
      }
    ],
    "keybindings": [
      {
        "command": "my.command1",
        "key": "Mod-Shift-C1",
        "when": "editorFocus"
      },
      {
        "command": "my.command2",
        "key": "Mod-Shift-C2",
        "when": "hasSelection"
      }
    ],
    "menus": [
      {
        "location": "editor/context",
        "command": "my.command1",
        "title": "Run Command 1",
        "when": "editorFocus"
      }
    ],
    "statusBar": [
      {
        "id": "my.status",
        "text": "My Plugin",
        "tooltip": "My awesome plugin",
        "onClick": "my.command1"
      }
    ]
  },
  "activationEvents": [
    "onStartupFinished"
  ],
  "dependencies": {
    "other.plugin": "^1.0.0"
  }
}
```

### B. 常用代码片段

#### 检查编辑器是否聚焦

```javascript
function isEditorFocused() {
  return document.activeElement.closest('.cm-editor') !== null;
}
```

#### 获取当前行内容

```javascript
function getCurrentLineContent() {
  const editor = window.zion.window.activeEditor;
  if (!editor) return '';

  const cursor = editor.getCursor();
  const lineStart = { line: cursor.line, ch: 0 };
  const lineEnd = { line: cursor.line, ch: Infinity };

  const content = editor.getValue();
  const lines = content.split('\n');
  return lines[cursor.line] || '';
}
```

#### 显示通知

```javascript
function showNotification(type, message, duration = 3000) {
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

#### 模态对话框

```javascript
function showPrompt(options) {
  const { title, message, placeholder = '' } = options;

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 99998;
      display: flex;
      align-items: center;
      justify-content: center;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      z-index: 99999;
      min-width: 400px;
      color: var(--fg);
    `;

    const titleEl = document.createElement('div');
    titleEl.textContent = title;
    titleEl.style.cssText = `
      font-weight: 500;
      font-size: 16px;
      margin-bottom: 12px;
    `;

    const messageEl = document.createElement('div');
    messageEl.textContent = message;
    messageEl.style.cssText = `
      margin-bottom: 16px;
    `;

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = placeholder;
    input.style.cssText = `
      width: 100%;
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg);
      color: var(--fg);
      margin-bottom: 16px;
      box-sizing: border-box;
    `;

    const buttons = document.createElement('div');
    buttons.style.cssText = `
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    `;

    const okButton = document.createElement('button');
    okButton.textContent = 'OK';
    okButton.style.cssText = `
      padding: 6px 12px;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    `;

    const cancelButton = document.createElement('button');
    cancelButton.textContent = 'Cancel';
    cancelButton.style.cssText = `
      padding: 6px 12px;
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 4px;
      cursor: pointer;
    `;

    dialog.appendChild(titleEl);
    dialog.appendChild(messageEl);
    dialog.appendChild(input);
    buttons.appendChild(okButton);
    buttons.appendChild(cancelButton);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = () => {
      overlay.remove();
    };

    okButton.onclick = () => {
      resolve(input.value);
      close();
    };

    cancelButton.onclick = () => {
      resolve(null);
      close();
    };

    overlay.onclick = (e) => {
      if (e.target === overlay) {
        resolve(null);
        close();
      }
    };

    input.focus();
  });
}
```

### C. 资源链接

- **Zion Next GitHub**: https://github.com/your-org/zion-next
- **Zion Local Tools GitHub**: https://github.com/your-org/zion-local-tools
- **CodeMirror 6 文档**: https://codemirror.net/docs/
- **FastAPI 文档**: https://fastapi.tiangolo.com/
- **VS Code 扩展 API 文档**: https://code.visualstudio.com/api

---

## 更新日志

本文档最后更新时间：2025-01-09

如有疑问或建议，请通过以下方式联系：
- GitHub Issues: https://github.com/your-org/zion-next/issues
- Email: support@example.com

---

**版权声明**

本文档遵循 CC BY-SA 4.0 许可证。
