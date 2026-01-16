# Terminal Enhanced Plugin - Design Document

## 📋 目录

- [项目概述](#项目概述)
- [现状分析](#现状分析)
- [插件设计](#插件设计)
- [实现方案](#实现方案)
- [代码架构](#代码架构)
- [实现路线图](#实现路线图)

---

## 项目概述

### 背景

Zion Next 是一个基于 CodeMirror 6 的 AI-First 编辑器平台，现有 `dev.terminal-manager` 插件提供了基础的终端会话管理功能。为进一步提升开发体验，计划开发 `dev.terminal-enhanced` 插件，提供更强大的终端交互能力。

### 核心目标

创建一个**深度集成 AI 的终端增强插件**，让终端成为 AI 编程助手的"手脚"，同时提升开发者的终端使用体验。

---

## 现状分析

### 系统架构

Zion Next 采用**插件化架构**：

```
zion-next/
├── src/
│   ├── core/
│   │   ├── event-bus.ts        # 事件总线（发布/订阅）
│   │   └── state-bus.ts        # 状态总线（共享状态）
│   ├── editor/
│   │   ├── EditorCore.ts       # CM6 编辑器核心
│   │   └── EditorProxy.ts      # 安全代理
│   ├── ext/
│   │   └── registry.ts         # 扩展注册中心
│   └── plugin/
│       └── loader.ts           # 插件加载器
└── extensions/
    └── dev.terminal-manager/   # 现有终端管理器
```

**核心机制：**

| 机制 | 作用 | API |
|-----|------|-----|
| 插件系统 | manifest.json + activate(ctx) | `window.zion` |
| 事件总线 | 插件间通信 | `window.zion.events.emit/on` |
| 状态总线 | 共享小型状态 | `window.zion.state.set/get` |
| 工具注册 | AI 工具调用 | `window.zion.state.set("chat.tools")` |
| 装饰器系统 | UI 注入 | `window.zion.editor.registerDecorator` |

### 产品理念

Zion Next 的产品理念：

- **AI-First**：所有工具为 AI 助手设计，让 AI 能直接调用
- **深度集成**：工具无缝嵌入编辑器工作流
- **可扩展**：插件间通过状态总线和事件总线协作
- **轻量高效**：基于原生 JS，避免过度抽象

### 现有 terminal-manager 功能

| 功能模块 | 现有实现 | 局限性 |
|---------|---------|--------|
| 会话管理 | ✅ 创建/列出/关闭/设置 CWD（支持 SSH） | ❌ 缺少会话持久化和快速切换 |
| 管理面板 | ✅ 右侧面板展示会话列表 | ❌ UI 较简陋，缺少终端输出展示 |
| AI 集成 | ✅ terminalManage 工具 | ❌ 只有管理能力，无直接执行能力 |
| 状态栏 | ✅ 显示活跃会话 ID | ❌ 信息有限，缺少状态指示 |
| Slash 命令 | ✅ 丰富的终端操作命令 | ✅ 已实现 |

### 市场竞品对比

| 产品 | 核心优势 | 缺点 |
|-----|---------|------|
| VS Code Terminal | 成熟稳定、生态丰富 | AI 集成有限 |
| Warp | 用户体验优秀、协作友好 | 独立应用，非编辑器集成 |
| Cursor | AI 辅助编码强大 | 终端功能较基础 |
| Windsurf | AI 上下文感知强 | 终端功能在开发中 |
| Fig/Amazon Q | 智能补全、命令提示 | 需要安装客户端 |

**我们的差异化优势：**
- ✅ AI 深度集成（执行 + 分析 + 建议）
- ✅ 编辑器无缝集成
- ✅ 项目感知、历史感知
- ✅ 会话配置共享、命令模板

---

## 插件设计

### 插件基本信息

```json
{
  "name": "dev.terminal-enhanced",
  "version": "0.1.0",
  "description": "AI-enhanced terminal with output visualization and smart assistance",
  "zion": {
    "id": "dev.terminal-enhanced",
    "name": "Terminal Enhanced",
    "main": "./main.js",
    "contributes": {
      "commands": [
        { "id": "terminal.openPanel", "title": "Open Terminal Panel" },
        { "id": "terminal.executeCommand", "title": "Execute Terminal Command" },
        { "id": "terminal.quickCommand", "title": "Quick Command Selector" },
        { "id": "terminal.toggleContext", "title": "Toggle Terminal Context in Chat" }
      ],
      "keybindings": [
        { "command": "terminal.openPanel", "key": "Mod-`" },
        { "command": "terminal.quickCommand", "key": "Mod-Shift-P" }
      ]
    },
    "activationEvents": ["onStartupFinished"]
  }
}
```

### 功能架构

```
dev.terminal-enhanced/
├── manifest.json              # 插件清单
├── main.js                     # 插件入口
├── core/
│   ├── terminal-manager.js     # 会话管理（增强版）
│   ├── terminal-executor.js    # 命令执行器
│   └── state-manager.js        # 状态管理
├── ui/
│   ├── terminal-panel.js       # 终端面板（含输出展示）
│   ├── terminal-tab.js         # 会话标签页
│   ├── command-block.js        # 命令块组件
│   ├── suggestion-box.js        # 补全框
│   └── quick-command.js        # 快速命令
├── ai/
│   ├── analyzer.js             # AI 输出分析
│   ├── suggester.js            # 命令建议
│   └── fixer.js                # 错误修复
├── utils/
│   ├── ansi-parser.js          # ANSI 解析
│   ├── command-parser.js       # 命令解析
│   ├── debounce.js             # 防抖/节流
│   └── error-handler.js        # 错误处理
├── constants.js                # 常量定义
└── types.js                    # 类型定义（JSDoc）
```

### 核心功能设计

#### 功能 1：终端输出可视化面板

**产品理念：**
- 让 AI "看到"终端输出，理解命令执行结果
- 开发者无需离开编辑器查看终端

**实现方案：**

- ✅ 嵌入式终端输出展示（支持 ANSI 转义码渲染）
- ✅ 多标签页支持（每个会话独立标签）
- ✅ 输出历史滚动和搜索
- ✅ 错误命令高亮（失败命令红色标记）
- ✅ 输出复制/保存功能
- ✅ AI 上下文注入（可选择性注入终端输出到聊天）

**AI 价值：**

```javascript
// 新增工具：terminalExecute
{
  name: "terminalExecute",
  description: "Execute command in active terminal session and return output",
  parameters: {
    command: { type: "string", description: "Shell command to execute" },
    session_id: { type: "string", optional: true },
    timeout: { type: "number", default: 30000 },
    capture_ansi: { type: "boolean", default: false }
  }
}

// 新增状态：terminal.outputs
// 存储最近 N 条命令的输出供 AI 查询
```

#### 功能 2：AI 终端辅助

**产品理念：**
- AI 帮助解释错误、生成命令、优化操作流程

**实现方案：**

```javascript
// Slash 命令：/terminal-fix
// 用途：当命令执行失败时，AI 分析输出并给出修复建议

// Slash 命令：/terminal-explain
// 用途：解释复杂命令的含义

// Slash 命令：/terminal-optimize
// 用途：优化当前命令序列（如多个 git 命令合并）

// 自动触发
// - 当命令失败时，显示 "Ask AI to fix" 按钮
// - 在命令历史中显示 AI 建议标记
```

#### 功能 3：会话历史与快速切换

**产品理念：**
- 提升多环境开发效率（本地/多台服务器）

**实现方案：**

```javascript
// 持久化存储
const historyKey = 'zion.terminal.history';
const sessionsKey = 'zion.terminal.savedSessions';

// 功能特点
- 会话收藏（常用 SSH 连接收藏）
- 快捷键切换会话（Cmd+1, Cmd+2...）
- 会话分组（项目/环境维度）
- 最近使用会话快速访问
- 会话导入/导出（团队共享配置）
```

#### 功能 4：快速命令系统

**产品理念：**
- 减少重复输入，提升开发效率

**实现方案：**

```javascript
// 命令别名系统
const quickCommands = {
  'build': 'npm run build && npm run test',
  'deploy': 'npm run build && npm run deploy',
  'logs': 'tail -f logs/app.log'
};

// 动态命令
// - 当前文件相关命令（如 `git add %file%`）
// - 项目检测命令（如 `docker-compose up` 检测到 docker-compose.yml）

// UI：命令快速选择器（Cmd+Shift+P 类似）
```

#### 功能 5：智能命令补全

**产品理念：**
- 结合项目上下文提供智能命令建议

**实现方案：**

```javascript
// 命令建议来源
1. 历史命令（高频优先）
2. 项目检测（package.json scripts, Makefile targets）
3. Git 状态（分支、文件）
4. 当前文件路径（快速插入）
5. AI 预测（根据上下文生成）

// 触发时机
- 命令输入时实时显示建议
- Slash 命令 /cmd 触发命令选择器
```

#### 功能 6：命令历史追踪

**产品理念：**
- 帮助开发者回溯操作、总结经验

**实现方案：**

```javascript
// 功能特点
- 命令时间线视图
- 命令分类筛选（git/npm/docker/other）
- 命令统计（执行次数、成功率）
- 导出为文档（生成项目操作手册）
- 与 AI 对话联动（"帮我总结今天执行的命令"）
```

---

## 实现方案

### 一、借鉴成熟工具 - 避免重复造轮子

#### 1.1 核心技术选型

| 功能模块 | 推荐方案 | 理由 |
|---------|---------|------|
| **终端渲染** | **xterm.js** | VS Code、GitLab、Jupyter 都在用，成熟稳定 |
| **SSH 前端** | **xterm-addon-fit** | xterm 官方插件，自适应大小 |
| **命令补全** | **自建轻量级** + shellparser | 复用 Zion Next 的状态总线 |
| **ANSI 解析** | **xterm 内置** | 无需额外库 |
| **UI 组件** | **原生 DOM + CSS** | 保持 Zion Next 的轻量级风格 |

#### 1.2 为什么不选其他方案

❌ **不推荐：**
- **Hyper 基于 React** → Zion Next 是原生 JS，引入 React 会显著增大体积
- **Warp 的完整 UI** → 闭源，无法直接使用
- **browser-ssh (前端直连)** → 安全性问题，后端会话管理更适合

✅ **推荐：**
- **xterm.js** → 只增 ~200KB gzipped，但提供完整的终端能力
- **复用 Zion 后端** → 现有 `/sessions` API 已管理会话，直接复用

### 二、交互设计 - 借鉴优秀产品

#### 2.1 借鉴 Warp 的"命令块"设计

```javascript
// 每个命令作为一个独立的"块"，可以：
// - 复制命令
// - 编辑并重跑
// - 查看详细输出
// - AI 分析

interface CommandBlock {
  id: string;
  command: string;
  output: string;
  exitCode: number;
  timestamp: number;
  duration: number;
  status: 'running' | 'success' | 'error';
}
```

#### 2.2 借鉴 Fig 的智能补全 UI

```javascript
// 悬浮式补全框，类似 VS Code 的 Ctrl+P
// - 实时匹配
// - 显示参数提示
// - 历史命令优先

interface SuggestionItem {
  command: string;
  description?: string;
  source: 'history' | 'alias' | 'ai' | 'file';
  metadata?: {
    frequency?: number;  // 使用频率
    lastUsed?: number;   // 最后使用时间
  };
}
```

#### 2.3 借鉴 iTerm2 的快速命令面板

```javascript
// 快捷键触发（如 Cmd+Shift+P）
// 快速执行常用命令

interface QuickCommand {
  name: string;
  command: string;
  icon?: string;
  category?: string;
  keybinding?: string;
}
```

### 三、代码质量与可维护性

#### 3.1 设计原则

1. **关注点分离**
   - UI 层不包含业务逻辑
   - AI 层不直接操作 DOM
   - 工具层通过事件总线通信

2. **模块化设计**
   - 每个模块单一职责
   - 模块间通过 API 通信，不直接依赖
   - 易于单独测试和替换

3. **错误边界**
   - 所有异步操作包含错误处理
   - 统一的错误日志记录
   - 用户友好的错误提示

4. **可测试性**
   - 依赖注入（DI）
   - Mock 外部依赖
   - 单元测试覆盖核心逻辑

#### 3.2 性能优化

| 优化点 | 策略 | 预期效果 |
|-------|------|---------|
| 体积 | xterm.js 动态导入 | 初始加载减少 ~200KB |
| 内存 | 输出缓存 + LRU | 避免重复存储 |
| 渲染 | 虚拟滚动（大量输出时） | 减少节点数量 |
| 交互 | 防抖/节流 | 减少不必要的操作 |

---

## 代码架构

### 核心类设计

#### 3.1 TerminalExecutor - 命令执行器

```javascript
/**
 * 终端命令执行器
 * 职责：执行命令、管理输出流、处理 ANSI 转义
 */
export class TerminalExecutor {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.baseUrl = this._readBaseUrl();
    this.xterm = null;  // xterm.js 实例
  }

  /**
   * 执行命令
   * @param {string} command - 要执行的命令
   * @param {Object} options - 选项
   * @returns {Promise<CommandResult>}
   */
  async execute(command, options = {}) {
    // 1. 发送到后端
    // 2. 流式接收输出
    // 3. 更新状态总线
  }

  /**
   * 创建 xterm 实例
   */
  createTerminal(container) {
    const term = new Terminal({
      theme: this._getTheme(),
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
      cursorBlink: true,
      allowProposedApi: true
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    fitAddon.fit();

    term.open(container);
    this.xterm = term;
    return term;
  }
}
```

#### 3.2 TerminalPanel - 终端面板

```javascript
/**
 * 终端主面板
 * 职责：渲染标签页、管理布局、处理用户交互
 */
export class TerminalPanel {
  constructor() {
    this.root = null;
    this.tabs = new Map();  // sessionId -> tab element
    this.terminals = new Map();  // sessionId -> xterm instance
    this.activeSessionId = null;
  }

  /**
   * 创建面板 DOM
   */
  _createPanel() {
    const panel = document.createElement('div');
    panel.className = 'zion-terminal-panel';
    // ... 创建标签页栏、内容区
    return panel;
  }

  /**
   * 添加会话标签页
   */
  addTab(session) {
    const tab = this._createTabElement(session);
    const content = this._createContentElement(session);
    this.tabs.set(session.id, { tab, content });
  }

  /**
   * 切换到指定会话
   */
  async switchTo(sessionId) {
    // 切换标签页样式
    // 显示对应的 xterm
  }
}
```

#### 3.3 TerminalAnalyzer - AI 分析器

```javascript
/**
 * AI 终端分析器
 * 职责：分析终端输出、生成建议
 */
export class TerminalAnalyzer {
  /**
   * 分析失败命令
   */
  async analyzeFailure(command, output) {
    // 1. 提取错误信息
    const error = this._extractError(output);

    // 2. 检查常见错误模式
    const pattern = this._matchErrorPattern(error);

    // 3. 生成修复建议
    const suggestion = await this._generateFix(command, error, pattern);

    return suggestion;
  }

  /**
   * 分析命令序列，优化建议
   */
  async analyzeSequence(commands) {
    // 检查可以合并的命令
    // 检查可以优化的命令
  }
}
```

#### 3.4 TerminalState - 状态管理

```javascript
/**
 * 终端状态管理器
 * 集中管理所有终端相关状态
 */
export const TerminalState = {
  // 状态键常量
  KEYS: {
    SESSIONS: 'terminal.sessions',
    ACTIVE_ID: 'terminal.activeSessionId',
    OUTPUTS: 'terminal.outputs',
    COMMANDS_HISTORY: 'terminal.commandsHistory',
    QUICK_COMMANDS: 'terminal.quickCommands',
    SETTINGS: 'terminal.settings'
  },

  // 封装状态操作
  get(key) {
    return window.zion.state.get(this.KEYS[key] || key);
  },

  set(key, value) {
    window.zion.state.set(this.KEYS[key] || key, value);
  },

  // 监听器封装
  onChange(key, handler) {
    return window.zion.state.onDidChange(
      this.KEYS[key] || key,
      handler
    );
  },

  // 派生状态计算
  getActiveSession() {
    const sessions = this.get('SESSIONS');
    const activeId = this.get('ACTIVE_ID');
    return sessions?.find(s => s.id === activeId);
  },

  getRecentCommands(limit = 10) {
    const history = this.get('COMMANDS_HISTORY') || [];
    return history.slice(-limit);
  }
};
```

### 类型定义

```javascript
/**
 * @typedef {Object} TerminalSession
 * @property {string} id - 会话 ID
 * @property {'local'|'ssh'} type - 会话类型
 * @property {string} cwd - 当前工作目录
 * @property {number} last_activity - 最后活动时间戳
 * @property {Object} ssh_config - SSH 配置（type=ssh 时）
 * @property {string} [ssh_config.host]
 * @property {string} [ssh_config.user]
 * @property {number} [ssh_config.port]
 */

/**
 * @typedef {Object} CommandResult
 * @property {string} output - 命令输出
 * @property {number} exitCode - 退出码
 * @property {number} duration - 执行时长（ms）
 * @property {boolean} success - 是否成功
 */

/**
 * @typedef {Object} CommandBlock
 * @property {string} id - 命令块 ID
 * @property {string} command - 命令
 * @property {string} output - 输出
 * @property {number} exitCode - 退出码
 * @property {number} timestamp - 时间戳
 * @property {number} duration - 执行时长
 * @property {'running'|'success'|'error'} status - 状态
 */
```

### 错误处理

```javascript
/**
 * 统一错误处理
 */
export class TerminalErrorHandler {
  /**
   * 处理执行错误
   */
  static handleExecutionError(error) {
    console.error('[Terminal] Execution error:', error);

    // 1. 解析错误类型
    const errorType = this._classifyError(error);

    // 2. 显示用户友好的提示
    window.zion.notification?.show(
      this._getUserMessage(errorType),
      { type: 'error', duration: 5000 }
    );

    // 3. 通知 AI 分析器
    window.zion.events.emit('terminal/commandError', {
      error,
      type: errorType,
      timestamp: Date.now()
    });

    return { handled: true, type: errorType };
  }

  /**
   * 错误分类
   */
  static _classifyError(error) {
    if (error.message.includes('timeout')) return 'TIMEOUT';
    if (error.message.includes('network')) return 'NETWORK';
    if (error.message.includes('permission')) return 'PERMISSION';
    if (error.message.includes('command not found')) return 'COMMAND_NOT_FOUND';
    return 'UNKNOWN';
  }
}
```

---

## 实现路线图

### Phase 1: 核心终端面板（2-3周）

**目标：** 集成 xterm.js，实现基础终端显示

**任务清单：**
- [ ] 动态导入 xterm.js 及插件
- [ ] 实现终端面板 UI
- [ ] 实现会话标签页切换
- [ ] 实现命令执行和输出显示
- [ ] 实现窗口自适应

**交付物：**
- 可用的终端面板，支持多会话切换
- 命令执行和输出显示
- 基础的错误处理

**测试重点：**
- xterm 正常渲染
- 输出显示正确（包括颜色、换行）
- 窗口调整大小自适应
- 多会话切换流畅

### Phase 2: 会话管理增强（1-2周）

**目标：** 复用现有 terminal-manager，增强 UI

**任务清单：**
- [ ] 集成现有 terminal-manager 的会话管理
- [ ] 实现会话收藏功能
- [ ] 实现快捷键切换会话
- [ ] 实现会话分组
- [ ] 实现会话导入/导出

**交付物：**
- 增强的会话管理 UI
- 会话持久化
- 快速切换能力

**测试重点：**
- 与现有 API 兼容
- 多会话切换流畅
- 会话状态同步正确

### Phase 3: 命令历史与补全（1-2周）

**目标：** 实现智能命令补全

**任务清单：**
- [ ] 实现命令历史记录
- [ ] 实现智能补全建议
- [ ] 实现补全框 UI
- [ ] 实现键盘导航
- [ ] 集成项目上下文检测

**交付物：**
- 命令历史功能
- 智能补全 UI
- 键盘导航支持

**测试重点：**
- 补全响应速度快（<100ms）
- 建议排序合理
- 键盘导航流畅

### Phase 4: AI 集成（1-2周）

**目标：** 实现 AI 辅助功能

**任务清单：**
- [ ] 注册 terminalExecute 工具
- [ ] 实现 Message Contributor（终端上下文注入）
- [ ] 实现 /terminal-fix slash 命令
- [ ] 实现 /terminal-explain slash 命令
- [ ] 实现失败命令自动建议

**交付物：**
- AI 工具集成
- 终端上下文注入
- AI 辅助功能

**测试重点：**
- 上下文注入不干扰正常聊天
- AI 分析准确率
- 建议的可执行性

### Phase 5: 快速命令系统（1-2周）

**目标：** 实现快速命令面板

**任务清单：**
- [ ] 实现命令别名系统
- [ ] 实现快速命令面板 UI
- [ ] 实现动态命令检测
- [ ] 实现命令模板功能

**交付物：**
- 快速命令面板
- 命令别名系统
- 命令模板功能

### Phase 6: 高级功能（2-3周）

**任务清单：**
- [ ] 命令时间线与统计
- [ ] 命令导出为文档
- [ ] 团队会话配置共享
- [ ] 性能优化和测试

**交付物：**
- 高级分析功能
- 性能优化报告
- 完整的测试覆盖

---

## 总结

### 核心优势

1. ✅ **借鉴 xterm.js 成熟方案，避免重复造轮子**
2. ✅ **复用 Zion Next 现有 API，无缝集成**
3. ✅ **模块化设计，易于测试和维护**
4. ✅ **渐进式开发，每个阶段都有可交付价值**
5. ✅ **AI-First 设计，符合产品定位**

### 预期效果

| 指标 | 当前 | 目标 |
|-----|------|------|
| 命令执行时间 | N/A | <100ms (本地) |
| 补全响应时间 | N/A | <50ms |
| 多会话切换 | N/A | <200ms |
| UI 响应性 | 良好 | 优秀 |
| AI 辅助准确率 | N/A | >70% (常见错误) |

### 风险与挑战

| 风险 | 影响 | 缓解措施 |
|-----|------|---------|
| xterm.js 学习曲线 | 中 | 充分阅读文档和参考 VS Code 实现 |
| 与现有 terminal-manager 兼容 | 中 | 保持 API 兼容，渐进式迁移 |
| 性能问题 | 中 | 懒加载、缓存、虚拟滚动 |
| AI 建议质量 | 低 | 持续迭代，收集反馈 |

---

## 下一步行动

1. **Phase 1 启动**
   - 创建插件目录结构
   - 实现基础的终端面板
   - 集成 xterm.js

2. **技术验证**
   - 验证 xterm.js 在 Zion Next 中的兼容性
   - 验证与现有 terminal-manager 的兼容性

3. **设计评审**
   - 与团队评审设计方案
   - 确认技术选型和实现路径

---

*文档创建时间：2025-01-17*
*版本：v1.0*
*作者：Zion Next Team*
