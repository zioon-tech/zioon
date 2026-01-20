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
// src/layout/responsive.ts

export const BREAKPOINTS = {
  mobile: 768,      // 手机
  tablet: 1024,     // 平板
  largeDesktop: 1440 // 大屏
};
```

## 🎨 不同设备的布局策略

### 手机端 (< 768px) - Compact Mode

```
┌───────────────────────────────────────┐
│  Zion             [☰]          [⋯]   │
├───────────────────────────────────────┤
│                                       │
│           EDITOR AREA                 │
│         (100% height)                 │
│                                       │
├───────────────────────────────────────┤
│  [💬] [📁] [⚙️] [⌨️] [📦]            │  ← 底部导航
└───────────────────────────────────────┘

抽屉菜单（点击 ☰）:
┌─────────────┐
│ ☰           │ ← 左滑关闭
│─────────────│
│ Sessions    │
│ Files       │
│ TOC         │
│ Settings    │
└─────────────┘
```

**特点**：
- 侧边栏隐藏，改为抽屉菜单
- 底部面板改为全屏覆盖
- 编辑器占满 100% 高度
- 底部导航栏显示核心功能
- 右侧辅助边栏隐藏

**布局配置**：

```typescript
{
  activityBar: { visible: false },
  sideBar: { visible: false },
  auxiliaryBar: { visible: false },
  bottomPanel: { visible: false },
  editorArea: { width: '100%', height: '100%' },
  statusBar: { visible: true, compact: true },
  bottomNav: { visible: true }
}
```

---

### 平板端 (768px - 1024px) - Medium Mode

```
┌───────────────────────────────────────────────┐
│  TITLE BAR                     [汉堡菜单 ☰]    │
├──────┬───────────────────────────────────────┤
│ACT   │  SIDE BAR (180px)                      │
│BAR   │  ┌────────────────────────────────┐    │
│💬📁  │  │ Session List                  │    │
│⚙️    │  │                                │    │
│      │  └────────────────────────────────┘    │
├──────┴───────────────────────────────────────┤
│  EDITOR AREA (flex-grow)                      │
├───────────────────────────────────────────────┤
│  [Terminal] [Output] [Problems]              │  ← 可滑动标签
└───────────────────────────────────────────────┘
```

**特点**：
- 左侧边栏缩小到 180px
- 右侧辅助边栏默认隐藏，以覆盖层形式显示
- 底部面板简化为可滑动的标签栏
- 活动栏可能简化或隐藏

**布局配置**：

```typescript
{
  activityBar: { visible: true, simplified: true },
  sideBar: { visible: true, width: 180 },
  auxiliaryBar: { visible: false, mode: 'overlay' },
  bottomPanel: { visible: true, height: 180, mode: 'tabs' },
  editorArea: { width: 'calc(100% - 180px)' },
  statusBar: { visible: true, compact: false }
}
```

---

### 桌面端 (1024px - 1440px) - Full Mode

```
┌─────────────────────────────────────────────────────────────┐
│  TITLE BAR                                                   │
├──────┬──────────────────────────────────────┬───────────┤
│ACT   │  SIDE BAR (240px)                     │AUX(300px) │
│BAR   │  ┌────────────┐                      │           │
│💬📁  │  │ Sessions   │                      │ Preview  │
│⚙️    │  │ Files      │                      │ Artifacts│
│      │  └────────────┘                      │           │
├──────┴──────────────────────────────────────┴───────────┤
│  EDITOR AREA (flex-grow)                                     │
├─────────────────────────────────────────────────────────────┤
│  STATUS BAR (left | center | right)                         │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  BOTTOM PANEL (200px) [Terminal] [Output] [Problems]        │
└─────────────────────────────────────────────────────────────┘
```

**特点**：
- 所有区域同时显示
- 左侧边栏 240px，右侧辅助边栏 300px
- 底部面板 200px，支持多个视图切换
- 完整的状态栏

**布局配置**：

```typescript
{
  activityBar: { visible: true },
  sideBar: { visible: true, width: 240 },
  auxiliaryBar: { visible: true, width: 300 },
  bottomPanel: { visible: true, height: 200 },
  editorArea: { width: 'calc(100% - 540px)' },
  statusBar: { visible: true, mode: 'full' }
}
```

---

### 大屏端 (> 1440px) - Split Mode

```
┌─────────────────────────────────────────────────────────────┐
│  TITLE BAR                                                   │
├──────┬──────────────────────────────────────┬───────────┤
│ACT   │  SIDE BAR (280px)                     │AUX(350px) │
│BAR   │  ┌────────────┐                      │           │
│💬📁  │  │ Sessions   │                      │ Preview  │
│⚙️    │  │ Files      │                      │ Artifacts│
│      │  └────────────┘                      │           │
├──────┴──────────────────────────────────────┴───────────┤
│  EDITOR AREA (flex-grow)                                     │
│  ┌────────────────┬────────────────┐                       │
│  │   Group A     │   Group B      │                       │
│  │                │                │                       │
│  └────────────────┴────────────────┘                       │
├─────────────────────────────────────────────────────────────┤
│  STATUS BAR                                                   │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  BOTTOM PANEL (250px) [Terminal] [Output] [Problems]        │
└─────────────────────────────────────────────────────────────┘
```

**特点**：
- 更大的侧边栏和辅助边栏
- 支持编辑器分屏
- 更大的底部面板

**布局配置**：

```typescript
{
  activityBar: { visible: true },
  sideBar: { visible: true, width: 280 },
  auxiliaryBar: { visible: true, width: 350 },
  bottomPanel: { visible: true, height: 250 },
  editorArea: { width: 'calc(100% - 630px)', supportsSplit: true },
  statusBar: { visible: true, mode: 'full' }
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

### 在 Manifest 中配置

```json
{
  "zion": {
    "contributes": {
      "sideBarViews": [
        {
          "id": "session.list",
          "title": "Sessions",
          "icon": "💬",
          "order": 10,
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
      ],
      "auxiliaryBarViews": [
        {
          "id": "preview.view",
          "title": "Preview",
          "icon": "🌐",
          "order": 10,
          "responsive": {
            "mobile": {
              "visible": false,
              "mode": "fullscreen"
            },
            "tablet": {
              "visible": true,
              "mode": "overlay",
              "width": "50%"
            },
            "desktop": {
              "visible": true,
              "width": 300
            }
          }
        }
      ]
    }
  }
}
```

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

## 📱 手机端特定功能

### 抽屉菜单

```javascript
// 打开抽屉菜单
window.zion.mobile.openDrawer();

// 关闭抽屉菜单
window.zion.mobile.closeDrawer();

// 切换抽屉菜单
window.zion.mobile.toggleDrawer();

// 监听抽屉菜单状态
window.zion.mobile.onDrawerChanged((open) => {
  console.log('Drawer:', open ? 'open' : 'closed');
});
```

### 底部导航

```javascript
// 注册底部导航项目
window.zion.mobile.registerBottomNavItems([
  {
    id: 'sessions',
    icon: '💬',
    label: 'Sessions',
    onClick: () => window.zion.mobile.openDrawer()
  },
  {
    id: 'files',
    icon: '📁',
    label: 'Files',
    onClick: () => window.zion.sideBar.activateView('files.explorer')
  },
  {
    id: 'terminal',
    icon: '⌨️',
    label: 'Terminal',
    onClick: () => window.zion.mobile.openFullscreen('terminal.view')
  }
]);
```

### 全屏视图

```javascript
// 打开全屏视图
window.zion.mobile.openFullscreen('preview.view');

// 关闭全屏视图
window.zion.mobile.closeFullscreen();

// 监听全屏视图变化
window.zion.mobile.onFullscreenChanged((viewId) => {
  console.log('Fullscreen view:', viewId);
});
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

## 📊 触屏手势支持

### 滑动手势

```javascript
class SwipeableComponent {
  constructor(container) {
    this.container = container;
    this.touchStartX = 0;
    this.touchStartY = 0;
    this.bindSwipe();
  }
  
  bindSwipe() {
    this.container.addEventListener('touchstart', (e) => {
      this.touchStartX = e.touches[0].clientX;
      this.touchStartY = e.touches[0].clientY;
    });
    
    this.container.addEventListener('touchend', (e) => {
      const touchEndX = e.changedTouches[0].clientX;
      const touchEndY = e.changedTouches[0].clientY;
      
      const deltaX = touchEndX - this.touchStartX;
      const deltaY = touchEndY - this.touchStartY;
      
      // 判断滑动方向
      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        // 水平滑动
        if (deltaX > 50) {
          this.onSwipeRight();
        } else if (deltaX < -50) {
          this.onSwipeLeft();
        }
      } else {
        // 垂直滑动
        if (deltaY > 50) {
          this.onSwipeDown();
        } else if (deltaY < -50) {
          this.onSwipeUp();
        }
      }
    });
  }
  
  onSwipeRight() {
    console.log('Swipe right');
  }
  
  onSwipeLeft() {
    console.log('Swipe left');
  }
  
  onSwipeUp() {
    console.log('Swipe up');
  }
  
  onSwipeDown() {
    console.log('Swipe down');
  }
}
```

### 长按手势

```javascript
class LongPressComponent {
  constructor(container) {
    this.container = container;
    this.longPressTimer = null;
    this.bindLongPress();
  }
  
  bindLongPress() {
    this.container.addEventListener('touchstart', () => {
      this.longPressTimer = setTimeout(() => {
        this.onLongPress();
      }, 500);
    });
    
    this.container.addEventListener('touchend', () => {
      clearTimeout(this.longPressTimer);
    });
    
    this.container.addEventListener('touchmove', () => {
      clearTimeout(this.longPressTimer);
    });
  }
  
  onLongPress() {
    console.log('Long press');
    // 显示上下文菜单等
  }
}
```

## 🔄 布局持久化

```javascript
// 保存针对不同设备的布局配置
window.zion.layout.saveResponsiveLayout({
  mobile: {
    sideBar: { visible: false },
    auxiliaryBar: { visible: false },
    bottomPanel: { visible: false }
  },
  tablet: {
    sideBar: { visible: true, width: 180 },
    auxiliaryBar: { visible: false },
    bottomPanel: { visible: true, height: 180 }
  },
  desktop: {
    sideBar: { visible: true, width: 240 },
    auxiliaryBar: { visible: true, width: 300 },
    bottomPanel: { visible: true, height: 200 }
  }
});

// 加载适合当前设备的布局
const layout = window.zion.layout.loadResponsiveLayout();
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
