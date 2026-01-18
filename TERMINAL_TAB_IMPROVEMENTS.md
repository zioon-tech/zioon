# Terminal Enhanced 标签页和操作区改进方案

## 当前问题分析

### 标签页问题
- 关闭按钮只在 hover 时显示，不够直观
- 标签样式较为简单，缺少视觉层次
- 没有右键菜单功能（关闭其他、重命名等）
- 不支持拖拽重排标签
- 标签文本过长时只是省略显示，没有 tooltip

### 右侧操作区问题
- 纯文本按钮，缺少图标，视觉吸引力不足
- 按钮功能较为单一
- 没有会话下拉选择器（切换会话不够方便）
- 缺少终端拆分功能
- Find、History 等功能按钮占用空间较多

## 参考 VSCode 的设计理念

### VSCode 终端标签特点
1. **清晰的视觉状态**：激活标签有明显的背景色和边框
2. **标签关闭按钮**：始终可见或 hover 时明显显示
3. **右键菜单**：丰富的上下文操作
4. **下拉选择器**：可以快速切换终端
5. **图标按钮**：右侧操作使用图标而非文字

## 改进方案

### 一、标签页改进

#### 1.1 改进标签样式
```css
/* 当前样式改进 */
.zte-tab {
  height: 28px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border-radius: 6px 6px 0 0; /* 上方圆角 */
  border: 1px solid transparent;
  border-bottom: none; /* 底部无边框，与内容区融合 */
  background: transparent;
  color: var(--fg);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  flex: 0 0 auto;
  transition: background 0.15s ease, border-color 0.15s ease;
  position: relative;
}

.zte-tab:hover {
  background: color-mix(in srgb, var(--fg) 8%, transparent);
}

.zte-tab.is-active {
  background: color-mix(in srgb, var(--fg) 12%, transparent);
  border-color: var(--border);
  border-bottom-color: var(--panel); /* 遮盖底部边框 */
  margin-bottom: -1px; /* 向下偏移覆盖边框 */
  z-index: 1;
}

/* 标签关闭按钮始终可见（或至少更容易发现） */
.zte-tab-close {
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  color: var(--fg);
  opacity: 0.6;
  padding: 0;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.zte-tab:hover .zte-tab-close,
.zte-tab.is-active .zte-tab-close {
  opacity: 0.9;
}

.zte-tab-close:hover {
  background: color-mix(in srgb, var(--fg) 15%, transparent);
  opacity: 1;
}
```

#### 1.2 添加标签右键菜单
```javascript
function openTabContextMenu(tabElement, session) {
  const menu = document.createElement("div");
  menu.className = "zte-context-menu";
  // ... 菜单项：关闭、关闭其他、关闭右侧、重命名等
}
```

#### 1.3 添加拖拽重排
```javascript
// 使用 HTML5 Drag and Drop API
.zte-tab {
  draggable: true;
}
```

#### 1.4 添加 tooltip
```javascript
// 标签过长时显示完整信息
if (label.scrollWidth > label.clientWidth) {
  label.title = fullLabel;
}
```

### 二、右侧操作区改进

#### 2.1 使用图标按钮
```javascript
// 使用 SVG 图标替代文本按钮
const icons = {
  new: `<svg>...</svg>`,
  split: `<svg>...</svg>`,
  kill: `<svg>...</svg>`,
  find: `<svg>...</svg>`,
  settings: `<svg>...</svg>`,
  close: `<svg>...</svg>`
};
```

#### 2.2 添加终端下拉选择器
```javascript
// 类似 VSCode 的终端下拉器
function createTerminalDropdown() {
  const dropdown = document.createElement("div");
  dropdown.className = "zte-terminal-dropdown";
  // 显示当前会话和会话列表
}
```

#### 2.3 重新组织按钮布局
```
[ 标签区域... ] | [▼ 会话选择器] | [+] [⤡] [×] [⚙] [×关闭面板]
```

#### 2.4 改进后的按钮样式
```css
.zte-icon-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--fg);
  padding: 0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.zte-icon-btn:hover {
  background: color-mix(in srgb, var(--fg) 10%, transparent);
}

.zte-icon-btn svg {
  width: 16px;
  height: 16px;
}
```

### 三、增强功能

#### 3.1 终端拆分
- 支持水平/垂直拆分终端
- 每个分割区域独立管理会话

#### 3.2 终端配置面板
- 字体大小调节
- 字体系列选择
- 行间距设置
- 配色方案切换

#### 3.3 状态栏增强
- 显示当前工作目录
- 显示 Git 分支（如果可用）
- 显示终端模式（pty/exec）

#### 3.4 快捷键改进
- 统一使用 VSCode 风格快捷键
- 在按钮上显示快捷键提示

## 实施优先级

### 高优先级（核心体验）
1. ✅ 改进标签视觉样式
2. ✅ 添加图标按钮
3. ✅ 添加终端下拉选择器
4. ✅ 优化按钮布局和间距

### 中优先级（功能增强）
5. ⚡ 标签右键菜单
6. ⚡ 标签拖拽重排
7. ⚡ 终端拆分功能
8. ⚡ 快捷键提示

### 低优先级（锦上添花）
9. 💎 终端配置面板
10. 💎 Git 分支显示
11. 💎 标签动画效果

## 参考资源

- VSCode Terminal 源码
- VS Code API 文档
- 现代终端模拟器设计指南

## 备注

这个方案保持了当前实现的核心功能，重点改进交互体验和视觉设计。所有改进都遵循以下原则：
- 保持简洁，不过度设计
- 遵循用户已有的使用习惯（VSCode）
- 提供清晰的视觉反馈
- 保持可访问性
