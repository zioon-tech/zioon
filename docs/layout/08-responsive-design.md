# 响应式设计 (Responsive Design)

Zion Next 作为一个网页端应用，需要适配多种设备形态，包括手机、平板、桌面和大屏幕。本系统提供了一套完整的响应式布局方案，确保插件在不同设备上都能良好工作。

## 📐 设备分类与断点

### 设备类型

| 设备类型 | 屏幕宽度 | 典型设备 | 断点值 |
|---------|---------|---------|--------|
| `Mobile` | < 768px | iPhone SE, Pixel | 768px |
| `Tablet` | 768px - 1024px | iPad, Android 平板 | 768px, 1024px |
| `Desktop` | 1024px - 1440px | MacBook Pro, Windows 笔记本 | 1024px, 1440px |
| `LargeDesktop` | > 1440px | 27" 显示器, 4K 屏幕 | 1440px |

### 断点配置

```typescript
// src/ui/workbench/runtime.ts
export const RESPONSIVE_BREAKPOINTS = {
  mobile: 768,
  tablet: 1024,
  largeDesktop: 1440
} as const;
```

## 🎨 不同设备的布局策略

Zion Next 的响应式目标是让工作台在不同屏幕宽度下保持“可操控”。在小屏下会采用更接近飞书/IM 类应用的模式：底部提供主入口（来自 Activity Bar 的按钮），侧边栏/辅助栏/底部面板以覆盖层形式打开，点击遮罩可关闭。

### 手机端 (< 768px) - Compact Mode

**特点**：
- 左侧 Activity Bar 不占用布局列；底部显示「Mobile Bar」承载 Activity Bar 的入口（可横向滚动）
- Side Bar / Auxiliary Bar / Bottom Panel 默认隐藏，但可作为覆盖层打开
- 点击遮罩关闭当前打开的覆盖层（不影响底部 Mobile Bar）
- 触屏与安全区：Mobile Bar 自动包含 iOS safe-area 底部安全区，编辑区也会预留底部空间避免被遮挡

```
┌───────────────────────────────────────┐
│              EDITOR AREA              │
│                                       │
│      (side/aux/bottom as overlay)     │
│                                       │
├───────────────────────────────────────┤
│  [💬] [📁] [⚙️] [⌨️] ...        [⌘]   │  ← Mobile Bar
└───────────────────────────────────────┘
```

**布局配置**：

```typescript
{
  activityBar: { visible: '(左侧不占位，入口下沉到底部)' },
  sideBar: { visible: false, mode: 'overlay' },
  auxiliaryBar: { visible: false, mode: 'overlay' },
  bottomPanel: { visible: false, mode: 'overlay' }
}
```

---

### 平板端 (768px - 1024px) - Medium Mode

**特点**：
- Side Bar 默认宽度调整为 180px（仍支持拖拽调整）
- Auxiliary Bar 默认隐藏（需要时由用户/插件主动打开）
- Bottom Panel 保持现有交互（多视图 + 拖拽高度 + 最大化/恢复）

**布局配置**：

```typescript
{
  activityBar: { visible: true },
  sideBar: { visible: true, width: 180 },
  auxiliaryBar: { visible: false },
  bottomPanel: { visible: '(遵循用户当前状态)' }
}
```

---

### 桌面端 (1024px - 1440px) - Full Mode

**特点**：
- Activity Bar / Side Bar 默认显示
- Side Bar 默认宽度 240px（支持拖拽调整）
- Auxiliary Bar / Bottom Panel 按用户状态显示（可通过命令/Activity Bar 入口打开）

**布局配置**：

```typescript
{
  activityBar: { visible: true },
  sideBar: { visible: true, width: 240 },
  auxiliaryBar: { visible: '(遵循用户当前状态)' },
  bottomPanel: { visible: '(遵循用户当前状态)' }
}
```

---

### 大屏端 (> 1440px) - Split Mode

**特点**：
- Side Bar 默认宽度调整为 280px（支持拖拽调整）
- 其它区域与桌面端一致（按用户状态显示）

**布局配置**：

```typescript
{
  activityBar: { visible: true },
  sideBar: { visible: true, width: 280 },
  auxiliaryBar: { visible: '(遵循用户当前状态)' },
  bottomPanel: { visible: '(遵循用户当前状态)' }
}
```

---

## 📝 响应式 API

### 获取设备信息

```javascript
// 获取当前设备类型
const deviceType = window.zion.responsive.getCurrentDeviceType();
// => 'mobile' | 'tablet' | 'desktop' | 'largedesktop'

// 获取当前响应式模式
const mode = window.zion.responsive.getCurrentMode();
// => 'compact' | 'medium' | 'full' | 'split'

// 判断设备类型
if (window.zion.responsive.isMobile()) {
  console.log('Mobile device');
}

if (window.zion.responsive.isTablet()) {
  console.log('Tablet device');
}

if (window.zion.responsive.isDesktop()) {
  console.log('Desktop device');
}

// 获取屏幕尺寸
const width = window.zion.responsive.getScreenWidth();
const height = window.zion.responsive.getScreenHeight();
```

### 监听设备变化

```javascript
// 监听设备类型变化
const disposable1 = window.zion.responsive.onDidChangeDeviceType((deviceType) => {
  console.log('Device changed to:', deviceType);
  
  // 适配新设备
  if (deviceType === 'mobile') {
    this.enterMobileMode();
  }
});

// 监听模式变化
const disposable2 = window.zion.responsive.onDidChangeMode((mode) => {
  console.log('Mode changed to:', mode);
  
  // 适配新模式
  this.adaptToMode(mode);
});

ctx.subscriptions.push(disposable1, disposable2);
```

### 手动控制

```javascript
// 手动切换模式（用于用户设置）
window.zion.responsive.setMode('compact');
window.zion.responsive.setMode('full');
```

## 🎨 插件适配响应式

目前不支持在 Manifest 中声明 `responsive` 字段（文档口径会以当前实现为准）。插件建议通过以下方式适配：
- 使用 `window.zion.responsive` 读取设备类型/模式并响应变化
- 使用 CSS 媒体查询（`@media`）和 `document.documentElement.dataset`（`data-zion-device-type` / `data-zion-responsive-mode`）做样式分支

### 在插件代码中适配

```javascript
export async function activate(ctx) {
  class ResponsiveComponent {
    constructor(container) {
      this.container = container;
      this.deviceType = window.zion.responsive.getCurrentDeviceType();
      this.render();
      
      // 监听设备变化
      this.disposable = window.zion.responsive.onDidChangeDeviceType((type) => {
        this.deviceType = type;
        this.render();
      });
    }
    
    render() {
      this.container.innerHTML = '';
      
      switch (this.deviceType) {
        case 'mobile':
          this.renderMobile();
          break;
        case 'tablet':
          this.renderTablet();
          break;
        case 'desktop':
        case 'largedesktop':
          this.renderDesktop();
          break;
      }
    }
    
    renderMobile() {
      this.container.innerHTML = `
        <div class="my-component mobile">
          <h3>Mobile View</h3>
          <p>Compact layout</p>
        </div>
      `;
    }
    
    renderTablet() {
      this.container.innerHTML = `
        <div class="my-component tablet">
          <h3>Tablet View</h3>
          <p>Medium layout</p>
        </div>
      `;
    }
    
    renderDesktop() {
      this.container.innerHTML = `
        <div class="my-component desktop">
          <h3>Desktop View</h3>
          <p>Full layout with all features</p>
        </div>
      `;
    }
    
    dispose() {
      this.disposable.dispose();
      this.container.innerHTML = '';
    }
  }
  
  const disposable = window.zion.sideBar.registerView({
    id: 'responsive.view',
    pluginId: 'responsive-plugin',
    title: 'Responsive',
    component: (container) => new ResponsiveComponent(container)
  });
  
  ctx.subscriptions.push(disposable);
}
```

## 🎯 CSS 媒体查询

### 在组件样式中使用

```css
/* 默认样式（桌面） */
.my-component {
  padding: 16px;
  font-size: 14px;
}

/* 平板 */
@media (max-width: 1024px) {
  .my-component {
    padding: 12px;
    font-size: 13px;
  }
}

/* 手机 */
@media (max-width: 768px) {
  .my-component {
    padding: 8px;
    font-size: 12px;
  }
}
```

### 动态类名

```javascript
class ResponsiveComponent {
  constructor(container) {
    this.container = container;
    this.deviceType = window.zion.responsive.getCurrentDeviceType();
    this.container.className = `my-component ${this.deviceType}`;
    
    window.zion.responsive.onDidChangeDeviceType((type) => {
      this.deviceType = type;
      this.container.className = `my-component ${type}`;
    });
  }
}
```

## 📊 最佳实践

### 1. 渐进增强

```javascript
class ProgressiveComponent {
  render() {
    const deviceType = window.zion.responsive.getCurrentDeviceType();
    
    // 基础功能（所有设备）
    const baseContent = this.renderBase();
    
    // 增强功能（更大屏幕）
    const enhancedContent = deviceType !== 'mobile' 
      ? this.renderEnhanced() 
      : '';
    
    this.container.innerHTML = baseContent + enhancedContent;
  }
}
```

### 2. 优先级驱动

```javascript
// 高优先级：手机端也显示
window.zion.sideBar.registerView({
  id: 'sessions',
  title: 'Sessions',
  priority: 100,
  responsive: {
    mobile: { visible: true }
  }
});

// 低优先级：桌面端才显示
window.zion.sideBar.registerView({
  id: 'advanced',
  title: 'Advanced',
  priority: 10,
  responsive: {
    mobile: { visible: false },
    desktop: { visible: true }
  }
});
```

### 3. 性能优化

```javascript
// 手机端使用虚拟滚动
class OptimizedList {
  constructor(container) {
    this.container = container;
    this.isMobile = window.zion.responsive.isMobile();
    
    if (this.isMobile) {
      this.setupVirtualScroll();
    } else {
      this.setupRegularScroll();
    }
  }
  
  setupVirtualScroll() {
    // 虚拟滚动实现
  }
  
  setupRegularScroll() {
    // 普通滚动实现
  }
}
```

### 4. 触摸友好的交互

```css
/* 增加点击区域 */
.touch-button {
  min-width: 44px;
  min-height: 44px;
  padding: 12px;
}

/* 移除 hover 效果（移动设备） */
@media (pointer: coarse) {
  .interactive-element {
    cursor: default;
  }
  .interactive-element:hover {
    /* 不显示 hover 效果 */
  }
}
```

## 🔗 相关文档

- [扩展点总览](./01-extension-points.md)
- [API 参考](./api-reference.md)
- [插件开发指南](./09-plugin-guide.md)
