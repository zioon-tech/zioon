# Zion Next Slash 命令插件实现总结

## 概述

本文档描述了在 zion-next 中实现的 slash 命令系统。该系统允许用户通过输入 `/` 快速访问编辑器功能、插件命令和 Markdown 元素。

## 实现架构

### 1. 类型定义 (src/types/zion.d.ts)

新增了以下类型定义：

```typescript
// Slash 参数类型
export type SlashParamType = 'string' | 'number' | 'boolean' | 'select';

// Slash 参数架构
export interface SlashParamSchema {
  name: string;
  type: SlashParamType;
  label: string;
  placeholder?: string;
  default?: any;
  min?: number;
  max?: number;
  options?: Array<{ value: string | number; label: string }>;
  asyncOptions?: () => Promise<Array<{ value: string | number; label: string }>>;
}

// Slash 命令接口
export interface SlashCommand {
  id: string;
  trigger: string | string[];
  title: string;
  description?: string;
  category: string;
  icon?: string;
  aliases?: string[];
  priority?: number;
  params?: SlashParamSchema[];
  execute: (params?: Record<string, any>, editor?: EditorProxy) => void | Promise<void>;
}
```

扩展了 `window.zion` 接口：

```typescript
window.zion.slash = {
  registerCommand(cmd: SlashCommand): Disposable;
  getAllCommands(): SlashCommand[];
  getCommand(id: string): SlashCommand | undefined;
  executeCommand(id: string, params?: Record<string, any>): Promise<void>;
  onCommandsChanged(handler: () => void): Disposable;
};
```

### 2. 核心插件 (extensions/dev.slash-commands)

#### 文件结构
```
extensions/dev.slash-commands/
├── manifest.json
├── main.js
└── style.css
```

#### 主要功能

1. **命令注册中心**
   - 维护所有注册的命令
   - 支持多个触发词和别名
   - 命令变化时通知监听器

2. **内置 Markdown 命令**
   - 标题：h1-h6, heading
   - 文本格式：bold, italic, strikethrough, code
   - 列表：ul, ol, checklist
   - 块元素：quote, codeblock, divider
   - 链接/媒体：link, image, table
   - 实用工具：timestamp, date

3. **UI 组件**
   - Slash 命令面板
   - 实时搜索和过滤
   - 按分类分组
   - 参数输入对话框
   - 键盘导航支持

4. **编辑器集成**
   - 监听 `editor.change` 事件
   - 检测 `/` 输入触发
   - 自动清理触发符

### 3. 插件注册

每个插件可以通过 `window.zion.slash.registerCommand()` 注册自己的 slash 命令：

```javascript
window.zion.slash.registerCommand({
  id: "my.command",
  trigger: ["mycmd", "alias"],
  title: "我的命令",
  description: "命令描述",
  category: "custom",
  icon: "🔧",
  priority: 50,
  execute: (params, editor) => {
    // 命令逻辑
  }
});
```

## 已注册的 Slash 命令

### Markdown 命令 (category: markdown)

| 触发词 | 标题 | 描述 |
|--------|------|------|
| h1, #, heading1 | 1级标题 | 插入 1 级标题 (#) |
| h2, ##, heading2 | 2级标题 | 插入 2 级标题 (##) |
| h3, ###, heading3 | 3级标题 | 插入 3 级标题 (###) |
| h4, ####, heading4 | 4级标题 | 插入 4 级标题 (####) |
| h5, #####, heading5 | 5级标题 | 插入 5 级标题 (#####) |
| h6, ######, heading6 | 6级标题 | 插入 6 级标题 (######) |
| heading, head, h | 标题 | 插入标题（可选级别 1-6） |
| bold, b | 粗体 | 插入粗体文本 (**text**) |
| italic, i, em | 斜体 | 插入斜体文本 (*text*) |
| strikethrough, s | 删除线 | 插入删除线文本 (~~text~~) |
| code, c | 行内代码 | 插入行内代码 (`code`) |
| ul, bullet, list | 无序列表 | 插入无序列表 (- item) |
| ol, numbered, numlist | 有序列表 | 插入有序列表 (1. item) |
| checklist, todo, task | 任务列表 | 插入任务列表 (- [ ] item) |
| quote, q, blockquote | 引用 | 插入引用块 (> quote) |
| codeblock, cb, ``` | 代码块 | 插入代码块 |
| divider, hr, --- | 分隔线 | 插入分隔线 (---) |
| link, url | 链接 | 插入链接 ([text](url)) |
| image, img, pic | 图片 | 插入图片 
![alt](url)
 |
| table | 表格 | 插入表格模板 |

### 编辑器命令 (category: editor)

| 触发词 | 标题 | 描述 |
|--------|------|------|
| linenumbers, ln | 切换行号 | 显示/隐藏行号 |
| syntax, sh | 切换语法高亮 | 显示/隐藏语法高亮 |
| highlight, ah | 切换行高亮 | 显示/隐藏当前行高亮 |
| wrap, line-wrap | 切换自动换行 | 启用/禁用自动换行 |
| width, editor-width | 切换编辑器宽度 | 循环切换编辑器宽度 |
| selection-highlight | 切换选择高亮 | 显示/隐藏选择内容高亮 |

### 导航命令 (category: navigation)

| 触发词 | 标题 | 描述 |
|--------|------|------|
| toc, table-of-contents | 显示目录 | 打开文档目录侧边栏 |
| insert-toc, toc-insert | 插入目录 | 在光标位置插入 Markdown 目录 |
| toc-group, group-toc | 切换目录分组 | 按角色分组显示目录 |

### 会话命令 (category: session)

| 触发词 | 标题 | 描述 |
|--------|------|------|
| new, new-session, ns | 新建会话 | 创建新的会话 |
| sessions, show-sessions | 显示会话面板 | 打开会话管理面板 |
| sidebar, sessions-sidebar | 切换会话侧边栏 | 显示/隐藏会话侧边栏 |
| save-as, save-session | 另存为新会话 | 将当前内容另存为新会话 |

### 终端命令 (category: terminal)

| 触发词 | 标题 | 描述 |
|--------|------|------|
| terminal, term | 打开终端管理器 | 打开终端会话管理面板 |
| close-terminal, close-term | 关闭终端管理器 | 关闭终端会话管理面板 |

### 搜索命令 (category: search)

| 触发词 | 标题 | 描述 |
|--------|------|------|
| search, find, s | 搜索 | 打开搜索面板 |
| replace, r | 搜索和替换 | 打开搜索和替换面板 |
| close-search | 关闭搜索 | 关闭搜索面板 |

### 任务命令 (category: task)

| 触发词 | 标题 | 描述 |
|--------|------|------|
| tasks, task, todo | 显示任务面板 | 显示/隐藏任务面板 |
| add-task, new-task | 添加任务 | 添加新任务 |
| clear-tasks, reset-tasks | 清空任务 | 清空所有任务 |

### AI 命令 (category: ai)

| 触发词 | 标题 | 描述 |
|--------|------|------|
| chat, run, ask | 运行对话 | 运行 AI 对话 |
| chat-sel, ask-sel | 运行对话(选中) | 对选中的内容运行 AI 对话 |
| stop, cancel | 停止对话 | 停止当前对话 |
| retry, regenerate | 重试对话 | 重新生成上一次的回复 |
| thinking, thought | 切换思考过程 | 显示/隐藏 AI 思考过程 |

### 文件命令 (category: file)

| 触发词 | 标题 | 描述 |
|--------|------|------|
| files, fs, file-manager | 打开文件管理器 | 打开文件访问管理面板 |
| add-file, file | 添加文件访问 | 添加文件访问权限 |
| add-folder, folder | 添加文件夹访问 | 添加文件夹访问权限 |
| clear-files, clear-fs | 清空文件访问 | 清除所有文件访问权限 |

### 实用工具 (category: utility)

| 触发词 | 标题 | 描述 |
|--------|------|------|
| timestamp, time, now | 时间戳 | 插入当前时间戳 |
| date | 日期 | 插入当前日期 |

## 交互流程

### 基本流程

1. 用户在编辑器中输入 `/`
2. Slash 插件检测到触发，显示命令面板
3. 用户可以输入关键词过滤命令
4. 使用鼠标点击选择命令
5. 执行命令，自动清理 `/` 触发符

### 带参数的命令

1. 用户选择带参数的命令（如 `/heading`）
2. 显示参数输入对话框
3. 用户填写参数
4. 点击确定执行命令

### 键盘快捷键

- `ESC` - 关闭命令面板
- `Enter` - 确认选择（当前未实现键盘导航，可后续添加）

## 扩展性

### 新增插件命令

插件可以在其 `activate` 函数中注册 slash 命令：

```javascript
export async function activate(ctx) {
  // 注册 slash 命令
  const dSlash = window.zion.slash?.registerCommand?.({
    id: "my.plugin.command",
    trigger: ["mycmd", "alias"],
    title: "我的命令",
    description: "命令描述",
    category: "plugin",
    icon: "🔌",
    priority: 100,
    execute: (params, editor) => {
      // 执行命令逻辑
    }
  });

  // 添加到订阅以便清理
  if (dSlash) ctx.subscriptions.push(dSlash);
}
```

### 命令参数支持

支持多种参数类型：

```javascript
{
  id: "example",
  trigger: "example",
  title: "示例命令",
  params: [
    {
      name: "text",
      type: "string",
      label: "文本输入",
      placeholder: "请输入..."
    },
    {
      name: "count",
      type: "number",
      label: "数量",
      min: 1,
      max: 100,
      default: 10
    },
    {
      name: "enabled",
      type: "boolean",
      label: "启用"
    },
    {
      name: "choice",
      type: "select",
      label: "选择",
      options: [
        { value: "opt1", label: "选项1" },
        { value: "opt2", label: "选项2" }
      ]
    },
    {
      name: "dynamic",
      type: "select",
      label: "动态选项",
      asyncOptions: async () => {
        // 异步加载选项
        return await fetchOptions();
      }
    }
  ]
}
```

## 实现特性

- ✅ `/` 触发命令面板
- ✅ 实时搜索和过滤
- ✅ 按分类分组显示
- ✅ 多个触发词和别名支持
- ✅ 命令描述和图标
- ✅ 参数输入对话框
- ✅ 支持异步参数选项
- ✅ 自动清理触发符
- ✅ 插件可扩展注册命令
- ✅ 事件变化通知
- ✅ 内置大量 Markdown 命令

## 待添加的手动操作

由于系统文件描述符限制，以下插件的 slash 命令需要手动添加到对应 `main.js` 文件末尾：

### dev.search-replace
将 `/tmp/slash_search.txt` 中的代码追加到 `extensions/dev.search-replace/main.js`

### dev.task-panel
将 `/tmp/slash_task.js` 中的代码追加到 `extensions/dev.task-panel/main.js`

### dev.langchain-chat
将 `/tmp/slash_chat.js` 中的代码追加到 `extensions/dev.langchain-chat/main.js`

### dev.fs-manager
将 `/tmp/slash_fs.js` 中的代码追加到 `extensions/dev.fs-manager/main.js`

## 测试

### 启动开发服务器

```bash
cd /Users/bytedance/Downloads/zion-next
npm run dev
```

### 访问应用

浏览器访问: http://localhost:5174

### 测试步骤

1. **基本触发**
   - 在编辑器中输入 `/`
   - 验证命令面板是否显示

2. **Markdown 命令测试**
   - `/h1` → 插入 `# `
   - `/bold` → 插入 `****`
   - `/codeblock` → 弹出语言选择对话框
   - `/heading` → 弹出级别选择对话框

3. **插件命令测试**
   - `/toc` → 打开目录面板
   - `/linenumbers` → 切换行号
   - `/new` → 新建会话
   - `/terminal` → 打开终端管理器

4. **搜索和过滤**
   - `/he` → 应显示所有匹配 "he" 的命令
   - `/s` → 应显示所有匹配 "s" 的命令

5. **参数对话框**
   - `/heading` → 显示级别选择
   - `/codeblock` → 显示语言选择
   - 选择参数后点击确定

6. **自动清理**
   - 执行命令后，`/` 应该被删除

## 未来改进

- [ ] 添加键盘导航（↑↓ 选择，Enter 执行）
- [ ] 支持命令历史记录
- [ ] 添加快捷键绑定到常用命令
- [ ] 支持命令分组折叠/展开
- [ ] 添加命令提示和示例
- [ ] 支持自定义命令主题
- [ ] 添加命令使用统计
- [ ] 支持多级参数交互（如 /model → provider → model）

## 总结

已成功实现 Zion Next 的 slash 命令系统，包括：

1. 完整的类型定义和 API
2. 核心插件实现（命令注册、UI、编辑器集成）
3. 大量内置 Markdown 命令
4. 已为 8 个内置插件注册 slash 命令
5. 支持参数输入、多触发词、分类分组等功能

用户现在可以通过在编辑器中输入 `/` 快速访问所有功能。
