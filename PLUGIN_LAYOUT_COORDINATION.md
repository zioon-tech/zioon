# 插件布局协调方案

## 问题概述

当前三个面板插件的布局存在以下问题：

1. **Terminal Enhanced** (`dev.terminal-enhanced`)
   - 面板宽度占据整个浏览器窗口 (`left: 0; right: 0`)
   - 与编辑器不同宽度，视觉不一致
   - z-index 较低，被 session-manager 遮挡

2. **Session Manager** (`dev.session-manager`)
   - 侧边栏 (`left`) 固定在页面左侧
   - panel (`right`) 以 overlay 形式显示
   - z-index 较高 (99998-99999)

3. **TOC** (`dev.toc`)
   - 侧边栏通过 wrapper + flex 布局实现
   - overlay 形式显示在右侧
   - z-index 较低

## 统一布局原则

### 1. 宽度约束

所有面板应遵循编辑器的宽度约束，避免跨越整个浏览器窗口：

```css
.panel {
  max-width: var(--editor-max-width, 1200px);
  margin-left: auto;
  margin-right: auto;
  left: 0;
  right: 0;
}
```

或者直接对齐到编辑器容器：

```css
/* 当编辑器容器存在时 */
.editor-container ~ .panel,
#editor-container ~ .panel {
  left: var(--editor-left);
  right: var(--editor-right);
  transform: none;
}
```

### 2. Z-index 层级划分

| 层级 | 范围 | 说明 |
|------|--------|------|
| 9000-9999 | 基础面板 | terminal panel, toc sidepanel |
| 10000-10999 | Overlay 遮罩 | 各插件的 overlay 背景层 |
| 11000-11999 | 交互面板 | session-manager panel, toc overlay panel |
| 12000-12999 | 下拉菜单/提示框 | 各种 dropdown, suggest box |
| 13000+ | 临时提示 | toast, notification |

### 3. 布局模式

#### A. 侧边栏模式 (Sidebar)

永久或半永久的固定面板，占据页面一侧：

- **Session Manager 左侧边栏**: `position: fixed; left: 0; top: 0; bottom: 0`
- **TOC 左侧边栏**: 通过 wrapper 实现内联布局，位于编辑器左侧

#### B. 底部面板模式 (Bottom Panel)

从底部滑出的面板：

- **Terminal Enhanced**: `position: fixed; bottom: 0; left: ...; right: ...`

#### C. 右侧 Overlay 模式 (Right Overlay)

临时显示的浮动面板：

- **Session Manager Panel**: `position: fixed; right: 20px; top: 60px`
- **TOC Overlay**: `position: fixed; right: 20px; top: 50px`

## 具体修复方案

### Terminal Enhanced 修复

#### 1. 修改 `panel.js` 中的 root 定位

```javascript
// 原代码：
root.style.left = "0";
root.style.right = "0";

// 修改为：
root.style.maxWidth = "var(--editor-max-width, 1200px)";
root.style.left = "50%";
root.style.transform = "translateX(-50%)";
```

#### 2. 调整 z-index

```javascript
root.style.zIndex = "9000"; // 从 1001 降低
```

#### 3. 添加宽度检测逻辑

```javascript
function syncTerminalWidth() {
  const root = document.getElementById('zion-terminal-enhanced-root');
  const editor = document.querySelector('.editor-container') 
                || document.querySelector('.cm-editor');
  
  if (editor && root) {
    const rect = editor.getBoundingClientRect();
    root.style.left = `${rect.left}px`;
    root.style.right = `${window.innerWidth - rect.right}px`;
    root.style.transform = 'none';
  }
}
```

### Session Manager 修复

#### 1. Panel z-index 调整

```javascript
// overlay z-index: 99998 -> 11998
overlay.style.zIndex = "11998";
panel.style.zIndex = "11999";
```

#### 2. Panel 宽度限制

```javascript
panel.style.maxWidth = "min(600px, 80vw)";
panel.style.left = "auto";
panel.style.right = "20px";
```

### TOC 修复

#### 1. Sidepanel 层级

```css
#zion-toc-sidepanel {
  z-index: 9000; /* 与 terminal 同级 */
}
```

#### 2. Overlay 层级

```css
#zion-toc-panel {
  z-index: 11999; /* 与 session-manager panel 同级 */
}
```

#### 3. 菜单和提示框

```css
#zion-toc-sidepanel .menu,
#zion-toc-sidepanel .tooltip {
  z-index: 12000;
}
```

## 共存场景处理

### 场景 1: Session Manager Sidebar + Terminal Panel

```
┌────────────────────────────────────────────┐
│ [Sessions] │       Editor Area        │
│            │                          │
│  Sidebar   │                          │
│            │                          │
├────────────────────────────────────────────┤
│            Terminal Panel              │
└────────────────────────────────────────────┘
```

- Session Manager 左侧边栏固定
- Editor 内容区域宽度 = 视口宽度 - Sidebar 宽度
- Terminal Panel 宽度对齐到 Editor 内容区域

### 场景 2: TOC Sidepanel + Terminal Panel

```
┌────────────────────────────────────────────┐
│ [TOC] [Editor]                        │
│                                            │
├────────────────────────────────────────────┤
│            Terminal Panel              │
└────────────────────────────────────────────┘
```

- TOC sidepanel 通过 wrapper + flex 实现，已内联到编辑器布局中
- Terminal Panel 需要计算 wrapper 容器的位置，而非整个视口

### 场景 3: Session Manager Panel + Terminal Panel

```
┌────────────────────────────────────────────┐
│                 [Sessions Panel]         │
│                                      │
│         Editor Area                    │
│                                      │
├────────────────────────────────────────────┤
│            Terminal Panel              │
└────────────────────────────────────────────┘
```

- Session Manager Panel 为临时 overlay，不永久占用空间
- Terminal Panel 底部显示，两者层级通过 z-index 区分

### 场景 4: TOC Overlay + Terminal Panel

```
┌────────────────────────────────────────────┐
│                   [TOC Panel]          │
│                                      │
│         Editor Area                    │
│                                      │
├────────────────────────────────────────────┤
│            Terminal Panel              │
└────────────────────────────────────────────┘
```

- TOC Overlay 临时显示，点击外部关闭
- Terminal Panel 在底部，两者互不干扰

### 场景 5: 两个 Overlay 同时显示

```
┌────────────────────────────────────────────┐
│ [Sessions]        [TOC]               │
│                                      │
│         Editor Area                    │
│                                      │
├────────────────────────────────────────────┤
│            Terminal Panel              │
└────────────────────────────────────────────┘
```

- Session Manager Panel 在右侧
- TOC Overlay 也显示在右侧（可能重叠）
- 建议添加互斥逻辑：显示一个时关闭其他

## 实现建议

### 1. 创建共享布局管理器

```javascript
// extensions/dev.layout-manager/main.js
export class PluginLayoutManager {
  constructor() {
    this.panels = new Map();
    this.zRanges = {
      base: 9000,
      overlay: 11000,
      dropdown: 12000,
      notification: 13000
    };
  }
  
  registerPanel(id, config) {
    // config: { type: 'sidebar'|'bottom'|'overlay', priority: number }
    this.panels.set(id, config);
    this.recalculateLayout();
  }
  
  recalculateLayout() {
    // 重新计算所有面板的位置和层级
  }
}
```

### 2. 插件注册到布局管理器

```javascript
// dev.terminal-enhanced/main.js
const layoutManager = window.zion.layoutManager;
if (layoutManager) {
  layoutManager.registerPanel('terminal', {
    type: 'bottom',
    priority: 10,
    widthMode: 'match-editor'
  });
}
```

### 3. CSS 变量共享

```css
:root {
  --panel-z-sidebar: 9000;
  --panel-z-bottom: 9100;
  --panel-z-overlay: 11000;
  --panel-z-dropdown: 12000;
  --panel-z-notification: 13000;
  
  --panel-width-editor: var(--editor-max-width, 1200px);
  --panel-width-sidebar: 300px;
  --panel-width-toc: 240px;
}
```

## 优先级建议

1. **高优先级** (立即修复):
   - Terminal Enhanced 宽度对齐编辑器
   - 调整各插件的 z-index 避免遮挡

2. **中优先级** (近期优化):
   - 添加面板互斥逻辑
   - 实现布局管理器

3. **低优先级** (长期改进):
   - 统一 CSS 变量
   - 支持用户自定义布局

## 测试清单

- [ ] Terminal Panel 宽度与编辑器一致
- [ ] Terminal Panel 不被 Session Manager Panel 遮挡
- [ ] TOC Sidepanel 不被 Terminal Panel 遮挡
- [ ] Session Manager Sidebar + Terminal Panel 共存正常
- [ ] TOC Sidepanel + Terminal Panel 共存正常
- [ ] 多个 Overlay 不重叠或能正确堆叠
- [ ] 所有下拉菜单/提示框在最上层
- [ ] 窗口大小变化时布局正确更新
