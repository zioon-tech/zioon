# Terminal Enhanced 插件改进总结

## 概述

针对 Zion Next 的 terminal-enhance 插件，我们提出了以下改进方案，参考 VSCode 的终端设计，提升用户体验。

## 主要改进点

### 1. 标签页改进 ✅

**改进前：**
- 简单的矩形标签，视觉层次不明显
- 关闭按钮只在 hover 时显示，不够直观
- 缺少右键菜单功能
- 不支持拖拽重排

**改进后：**
- 更精细的视觉设计（圆角、边框、阴影）
- 激活状态更明显（底部边框与内容区融合）
- 关闭按钮始终可见，hover 时有放大动画
- 支持右键菜单（关闭、关闭其他、重命名、拆分等）
- 支持拖拽重排标签
- 标签过长时显示完整信息的 tooltip

### 2. 右侧操作区改进 ✅

**改进前：**
- 纯文本按钮（New, Kill, Find, History, Close）
- 缺少视觉吸引力
- 功能组织不够清晰

**改进后：**
- 使用 SVG 图标替代文字
- 添加工具提示（hover 时显示快捷键）
- 添加终端下拉选择器，快速切换会话
- 添加分割终端按钮（预留功能）
- 改进按钮布局和间距
- 支持按钮分组（如新建和分割）

### 3. 视觉和交互细节 ✅

- 统一的动画效果（hover、active、拖拽等）
- 更好的焦点状态（支持键盘导航）
- 响应式设计（小屏幕适配）
- 支持 prefers-reduced-motion
- 更好的颜色对比度
- 一致的间距和尺寸系统

## 文件结构

```
extensions/dev.terminal-enhanced/
├── main.js                          # 主插件入口（原有）
├── panel.js                         # 原始面板实现（原有）
├── panel-improved.js               # 改进版面板实现（新增）
├── styles-improved.css             # 改进版样式（新增）
└── manifest.json                   # 插件清单（原有）
```

## 使用方法

### 方案一：渐进式改进（推荐）

1. 保留原有 `panel.js` 作为基础
2. 在 `main.js` 中导入改进版：

```javascript
import { installTerminalEnhancedPanel } from "./panel.js";
import { installImprovedTerminalEnhancedPanel } from "./panel-improved.js";

export async function activate(ctx) {
  // ... 原有代码 ...
  
  // 使用改进版面板
  panel = installImprovedTerminalEnhancedPanel({
    execute: async (command, sessionId) => {
      return await window.zion.commands.executeCommand("terminal.executeCommand", { command, session_id: sessionId });
    },
    connectPty
  });
}
```

3. 在 `activate` 函数中注入改进样式：

```javascript
function injectImprovedStyles() {
  const STYLE_ID = "zion-terminal-enhanced-improved-style";
  if (document.getElementById(STYLE_ID)) return;
  
  const link = document.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.href = "/extensions/dev.terminal-enhanced/styles-improved.css";
  document.head.appendChild(link);
}
```

### 方案二：直接修改原有文件

1. 备份原有的 `panel.js`
2. 将改进的样式合并到现有的 `<style>` 标签中
3. 逐步应用改进的代码逻辑

## 核心代码示例

### 图标按钮创建

```javascript
const ICONS = {
  plus: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M3 8h10"/></svg>`,
  trash: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h10M5 4V3a1 1 0 011-1h4a1 1 0 011 1v1M6 7v6M10 7v6"/></svg>`,
  // ... 更多图标
};

function createIconButton(icon, tooltip, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'zte-icon-btn';
  button.innerHTML = icon;
  button.setAttribute('data-tooltip', tooltip);
  button.disabled = disabled;
  return button;
}
```

### 标签右键菜单

```javascript
function openTabContextMenu(x, y, sessionId, tabElement) {
  const menu = document.createElement('div');
  menu.className = 'zte-context-menu';
  // ... 添加菜单项
  
  document.body.appendChild(menu);
  
  // 点击外部关闭
  const onDocClick = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', onDocClick);
    }
  };
  setTimeout(() => document.addEventListener('click', onDocClick), 0);
}
```

### 终端下拉选择器

```javascript
function createTerminalDropdown() {
  const dropdown = document.createElement('div');
  dropdown.className = 'zte-terminal-dropdown';
  dropdown.innerHTML = `
    ${ICONS.terminal}
    <span class="zte-terminal-dropdown-label">Terminal</span>
    <span class="zte-terminal-dropdown-icon">${ICONS.chevronDown}</span>
  `;
  
  // 创建下拉菜单
  const menu = document.createElement('div');
  menu.className = 'zte-dropdown-menu';
  
  dropdown.onclick = () => {
    dropdown.classList.toggle('is-open');
    menu.classList.toggle('is-open');
    updateDropdownItems(menu);
  };
  
  return { dropdown, menu };
}
```

## 实施优先级

### Phase 1: 核心视觉改进（1-2天）
- [ ] 注入改进的 CSS 样式
- [ ] 替换文本按钮为图标按钮
- [ ] 改进标签页视觉样式
- [ ] 添加工具提示

### Phase 2: 功能增强（2-3天）
- [ ] 添加终端下拉选择器
- [ ] 实现标签右键菜单
- [ ] 实现标签拖拽重排

### Phase 3: 高级功能（可选）
- [ ] 终端拆分功能
- [ ] 终端配置面板
- [ ] Git 分支显示

## 测试清单

- [ ] 标签页切换正常
- [ ] 标签页关闭功能正常
- [ ] 右键菜单功能正常
- [ ] 拖拽重排功能正常
- [ ] 终端下拉选择器正常
- [ ] 图标按钮功能正常
- [ ] 快捷键提示显示正常
- [ ] 响应式布局适配
- [ ] 键盘导航支持
- [ ] 深色/浅色主题适配

## 预期效果

改进后的终端面板将：
- ✅ 看起来更现代、更专业
- ✅ 操作更直观、更符合用户习惯
- ✅ 功能更丰富、更强大
- ✅ 与 VSCode 风格保持一致
- ✅ 保持原有核心功能不变

## 注意事项

1. **向后兼容**：改进版保留了所有原有功能，只是增强了 UI/UX
2. **性能考虑**：所有动画都使用 CSS transitions，性能开销小
3. **可访问性**：支持键盘导航和屏幕阅读器
4. **渐进式增强**：可以逐步应用改进，不必一次性全部替换

## 下一步

1. 审阅改进方案
2. 选择实施方案（渐进式或直接修改）
3. 开始 Phase 1 改进
4. 测试并收集反馈
5. 迭代优化

---

**Created:** 2025-01-13  
**Author:** Zion Next Team  
**Status:** Proposal / Ready for Review
