# 布局扩展点总览

Zion Next 提供了多个布局扩展点，允许插件在不同的 UI 区域注册自己的视图。这些扩展点的设计参考了 VSCode 的架构，确保插件可以和谐共存。

## 🎯 可用扩展点

| 扩展点 | 位置 | 用途 | 优先级 |
|--------|------|------|--------|
| `activityBarItems` | 左侧图标栏 | 快速切换不同视图 | 高 |
| `sideBarViews` | 左侧边栏 | 主视图（文件树、会话等） | 高 |
| `auxiliaryBarViews` | 右侧边栏 | 辅助视图（预览、产物等） | 中 |
| `bottomPanelViews` | 底部面板 | 功能面板（终端、输出等） | 中 |
| `statusBarItems` | 底部状态栏 | 状态信息显示 | 低 |
| `editorTabs` | 编辑器区域 | 编辑器标签页 | 高 |
| `selectionToolbar` | 编辑器选区浮动工具栏 | 选中文本时的快捷操作（可扩展按钮/下拉） | 中 |

## 📐 完整布局结构

```
┌─────────────────────────────────────────────────────────────┐
│  TITLE BAR (菜单、工具栏)                                     │
├──────────┬──────────────────────────────────────┬───────────┤
│ ACTIVITY │  SIDE BAR (LEFT)                      │ AUXILIARY │
│ BAR      │  ┌─────────────┐                      │ BAR (RIGHT)│
│ 💬 📁 ⚙️  │  │ Explorer    │                      │ ┌─────────┐│
│          │  │ Sessions    │                      │ │ Preview ││
│          │  │ TOC         │                      │ │ Context ││
│          │  └─────────────┘                      │ └─────────┘│
├──────────┴──────────────────────────────────────┴───────────┤
│  EDITOR AREA                                              │
│  ┌────────────────────────────────────────────────────┐  │
│  │ [Chat] [main.js] [README.md]          [x][x][x]  │  │
│  ├────────────────────────────────────────────────────┤  │
│  │ Session: Chat with GPT                             │  │
│  │ User: 帮我写一个 Python 脚本                      │  │
│  │ ──────────────────────────────────────────────    │  │
│  └────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│  BOTTOM PANEL (Terminal | Output | Problems)                │
│  ┌────────────────────────────────────────────────────┐  │
│  │ > npm install                                       │  │
│  └────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│  STATUS BAR (left | center | right)                         │
│  Ln 1, Col 5 │ UTF-8 │ Ready │ Branch: main              │
└─────────────────────────────────────────────────────────────┘
```

## 🔧 扩展点详细说明

### 1. 活动栏 (Activity Bar)

**位置**：最左侧的图标栏

**用途**：提供快速访问不同视图的图标按钮

**特点**：
- 显示为垂直排列的图标
- 点击可激活对应的侧边栏/底部面板视图
- 支持条件显示（`when` 表达式）

**示例**：
```json
{
  "contributes": {
    "activityBarItems": [
      {
        "id": "session.activity",
        "icon": "💬",
        "tooltip": "Chat Sessions",
        "sideBarViewId": "session.list",
        "order": 10
      }
    ]
  }
}
```

**详细文档**：[活动栏文档](./04-activity-bar.md)

---

### 2. 左侧边栏 (Side Bar)

**位置**：活动栏右侧的主要边栏区域

**用途**：显示插件的主要内容和导航

**特点**：
- 支持多个视图切换（类似 VSCode 的 Explorer/Search/Git）
- 可调整宽度
- 可折叠/展开
- 插件可注册自己的视图

**典型用例**：
- 文件资源管理器
- 会话列表
- 目录结构（TOC）
- 历史记录
- 书签

**示例**：
```json
{
  "contributes": {
    "sideBarViews": [
      {
        "id": "session.list",
        "title": "Sessions",
        "icon": "💬",
        "order": 10
      }
    ]
  }
}
```

**详细文档**：[左侧边栏文档](./02-sidebar-left.md)

---

### 3. 右侧辅助边栏 (Auxiliary Bar)

**位置**：编辑器右侧的边栏区域

**用途**：显示与编辑器内容相关的辅助信息

**特点**：
- 支持多个视图切换
- 响应式：小屏时可能隐藏
- 适合显示预览、上下文等信息

**典型用例**：
- Markdown/HTML 预览
- AI 对话产物（生成的文件、代码）
- 上下文信息（token 使用、引用）
- 任务清单

**示例**：
```json
{
  "contributes": {
    "auxiliaryBarViews": [
      {
        "id": "preview.view",
        "title": "Preview",
        "icon": "🌐",
        "order": 10
      }
    ]
  }
}
```

**详细文档**：[右侧辅助边栏文档](./03-auxiliary-bar-right.md)

---

### 4. 底部面板 (Bottom Panel)

**位置**：编辑器下方的面板区域

**用途**：显示辅助功能和信息

**特点**：
- 支持多个视图切换（类似 VSCode 的 Terminal/Output/Problems）
- 可调整高度
- 可最大化/恢复

**典型用例**：
- 终端 (Terminal)
- 输出日志 (Output)
- 问题列表 (Problems/Errors)
- 调试控制台 (Debug Console)

**示例**：
```json
{
  "contributes": {
    "bottomPanelViews": [
      {
        "id": "terminal.view",
        "title": "Terminal",
        "icon": "⌨️",
        "order": 10
      }
    ]
  }
}
```

**详细文档**：[底部面板文档](./05-bottom-panel.md)

---

### 5. 状态栏 (Status Bar)

**位置**：最底部的状态信息栏

**用途**：显示运行时状态和快捷操作

**特点**：
- 分为左、中、右三个区域
- 支持多个项目
- 支持点击交互

**典型用例**：
- 光标位置（行、列）
- 文件编码
- Git 分支
- 主题切换按钮
- 插件状态指示器

**示例**：
```json
{
  "contributes": {
    "statusBarItems": [
      {
        "id": "my-plugin.status",
        "text": "My Plugin",
        "tooltip": "Click to open",
        "position": "right",
        "order": 10,
        "onClick": "myPlugin.open"
      }
    ]
  }
}
```

**详细文档**：[状态栏文档](./06-status-bar.md)

---

### 6. 编辑器区域 (Editor Area)

**位置**：中央的主要编辑区域

**用途**：显示和编辑内容

**特点**：
- 支持多个标签页
- 支持分组（左右/上下分屏）
- 支持不同语言模式

**典型用例**：
- Markdown 编辑器
- 代码编辑器
- 预览面板
- 自定义编辑器组件

**示例**：
```json
{
  "contributes": {
    "editorTabs": [
      {
        "id": "chat.editor",
        "title": "Chat",
        "icon": "💬",
        "language": "markdown",
        "readOnly": false
      }
    ]
  }
}
```

**详细文档**：[编辑器区域文档](./07-editor-area.md)

---

## 📝 共同属性

所有扩展点都支持以下通用属性：

| 属性 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 唯一标识符 |
| `order` | `number` | 排序权重（越小越靠前） |
| `when` | `string` | 显示条件（表达式） |
| `icon` | `string \| SVG` | 图标 |
| `tooltip` | `string` | 提示文本 |

## 🔄 生命周期

视图组件支持以下生命周期钩子：

```typescript
{
  onActivate?: () => void | Promise<void>;    // 激活时
  onDeactivate?: () => void | Promise<void>;  // 停用时
  onResize?: (size: { width, height }) => void; // 调整大小时
  onDispose?: () => void;                      // 销毁时
}
```

## 📱 响应式适配

所有扩展点都支持响应式配置，可根据设备类型自动调整显示方式：

```json
{
  "sideBarViews": [
    {
      "id": "my.view",
      "title": "My View",
      "responsive": {
        "mobile": {
          "visible": false,
          "mode": "drawer"
        },
        "tablet": {
          "visible": true,
          "width": 180
        },
        "desktop": {
          "visible": true,
          "width": 240
        }
      }
    }
  ]
}
```

详细说明请查看 [响应式设计文档](./08-responsive-design.md)。

## 🎯 如何选择扩展点

| 需求 | 推荐扩展点 | 原因 |
|------|-----------|------|
| 主要导航内容 | `sideBarViews` | 始终可见，空间充足 |
| 预览和辅助信息 | `auxiliaryBarViews` | 与编辑器内容相关 |
| 功能性工具 | `bottomPanelViews` | 不占用主区域，可随时切换 |
| 快速状态显示 | `statusBarItems` | 简洁、实时 |
| 内容编辑 | `editorTabs` | 专为编辑优化 |
| 快速入口 | `activityBarItems` | 醒目的图标按钮 |

## 🚀 下一步

- 查看 [插件开发指南](./09-plugin-guide.md) 了解如何在插件中使用这些扩展点
- 阅读 [API 参考](./api-reference.md) 获取完整的 API 文档
- 了解 [响应式设计](./08-responsive-design.md) 以适配不同设备
