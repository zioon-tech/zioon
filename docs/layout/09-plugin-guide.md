# 插件开发指南 (Plugin Development Guide)

本指南将帮助你了解如何在插件中使用 Zion Next 的布局系统，从基础概念到高级技巧。

## 🚀 快速开始

### 步骤 1: 创建插件目录

```bash
extensions/
└── my-awesome-plugin/
    ├── manifest.json
    ├── main.js
    └── components/
        └── MyComponent.js
```

### 步骤 2: 编写 manifest.json

```json
{
  "name": "my-awesome-plugin",
  "version": "1.0.0",
  "description": "An awesome plugin for Zion Next",
  "author": "Your Name",
  "zion": {
    "id": "my-awesome-plugin",
    "name": "My Awesome Plugin",
    "version": "1.0.0",
    "main": "./main.js",
    "contributes": {
      "activityBarItems": [
        {
          "id": "my.activity",
          "icon": "🚀",
          "tooltip": "My Awesome Plugin",
          "sideBarViewId": "my.view",
          "order": 50
        }
      ],
      "sideBarViews": [
        {
          "id": "my.view",
          "title": "My View",
          "icon": "🚀",
          "order": 50
        }
      ],
      "statusBarItems": [
        {
          "id": "my.status",
          "text": "Ready",
          "position": "right",
          "order": 50
        }
      ]
    }
  }
}
```

### 步骤 3: 编写 main.js

```javascript
export async function activate(ctx) {
  console.log('My Awesome Plugin activated!');
  
  // 注册状态栏项目
  const statusDisposable = window.zion.statusBar.registerItem({
    id: 'my.status',
    pluginId: 'my-awesome-plugin',
    text: '● Ready',
    tooltip: 'My Awesome Plugin is ready',
    position: 'right',
    order: 50
  });
  
  // 注册侧边栏视图
  const viewDisposable = window.zion.sideBar.registerView({
    id: 'my.view',
    pluginId: 'my-awesome-plugin',
    title: 'My View',
    icon: '🚀',
    location: 'sidebar',
    component: (container) => {
      const el = document.createElement('div');
      el.className = 'my-view';
      el.innerHTML = `
        <h2>Welcome to My Plugin!</h2>
        <p>This is a simple example plugin.</p>
      `;
      container.appendChild(el);
      
      return {
        dispose: () => {
          container.innerHTML = '';
        }
      };
    }
  });
  
  // 注册命令
  const commandDisposable = window.zion.commands.registerCommand(
    'myPlugin.hello',
    () => {
      alert('Hello from My Awesome Plugin!');
    }
  );
  
  // 添加到订阅列表，确保正确清理
  ctx.subscriptions.push(statusDisposable);
  ctx.subscriptions.push(viewDisposable);
  ctx.subscriptions.push(commandDisposable);
}

export async function deactivate() {
  console.log('My Awesome Plugin deactivated!');
}
```

## 🎯 组件模式

### 1. 函数式组件

```javascript
function MyComponent(container, options) {
  // 创建 DOM
  const el = document.createElement('div');
  el.textContent = 'Hello!';
  container.appendChild(el);
  
  // 返回清理函数
  return {
    dispose: () => {
      container.innerHTML = '';
    }
  };
}

// 使用
window.zion.sideBar.registerView({
  id: 'my.view',
  component: (container) => MyComponent(container)
});
```

### 2. 类组件

```javascript
class MyComponent {
  constructor(container, options) {
    this.container = container;
    this.options = options || {};
    this.render();
    this.bindEvents();
  }
  
  render() {
    this.container.innerHTML = `
      <div class="my-component">
        <h2>${this.options.title || 'My Component'}</h2>
        <p>Content goes here</p>
      </div>
    `;
  }
  
  bindEvents() {
    this.container.addEventListener('click', (e) => {
      if (e.target.matches('.action-button')) {
        this.handleAction();
      }
    });
  }
  
  handleAction() {
    console.log('Action triggered!');
  }
  
  dispose() {
    this.container.innerHTML = '';
  }
}

// 使用
window.zion.sideBar.registerView({
  id: 'my.view',
  component: (container) => new MyComponent(container, { title: 'Hello' })
});
```

### 3. Web Components

```javascript
class MyWebComponent extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <div class="my-web-component">
        <slot></slot>
      </div>
    `;
  }
  
  disconnectedCallback() {
    // 清理
  }
}

customElements.define('my-web-component', MyWebComponent);

// 使用
window.zion.sideBar.registerView({
  id: 'my.view',
  component: (container) => {
    const el = document.createElement('my-web-component');
    el.innerHTML = 'Hello from Web Component!';
    container.appendChild(el);
    
    return {
      dispose: () => el.remove()
    };
  }
});
```

## 📦 状态管理

### 使用 Global State

```javascript
export async function activate(ctx) {
  // 写入状态
  window.zion.state.set('myPlugin.selectedItem', null);
  
  // 监听状态变化
  const disposable = window.zion.state.onDidChange(
    'myPlugin.selectedItem',
    (newValue, oldValue) => {
      console.log('Selected item changed:', newValue);
    }
  );
  
  ctx.subscriptions.push(disposable);
}
```

### 使用 Workspace State

```javascript
export async function activate(ctx) {
  // 获取工作区状态
  const workspaceState = ctx.workspaceState;
  
  // 保存配置
  await workspaceState.update('config', {
    theme: 'dark',
    fontSize: 14
  });
  
  // 读取配置
  const config = await workspaceState.get('config', {
    theme: 'light',
    fontSize: 12
  });
}
```

### 组件内部状态

```javascript
class StatefulComponent {
  constructor(container) {
    this.container = container;
    this.state = {
      items: [],
      selected: null,
      loading: false
    };
    this.render();
  }
  
  setState(newState) {
    this.state = { ...this.state, ...newState };
    this.render();
  }
  
  render() {
    this.container.innerHTML = `
      <div class="stateful-component">
        ${this.state.loading ? '<p>Loading...</p>' : this.renderItems()}
      </div>
    `;
  }
  
  renderItems() {
    return this.state.items.map(item => `
      <div class="item ${this.state.selected === item.id ? 'selected' : ''}" 
           data-id="${item.id}">
        ${item.name}
      </div>
    `).join('');
  }
}
```

## 🔄 事件通信

### 发布事件

```javascript
// 插件 A
export async function activate(ctx) {
  window.zion.events.emit('myPlugin:itemSelected', {
    id: 'item-1',
    name: 'Item 1'
  });
}
```

### 订阅事件

```javascript
// 插件 B
export async function activate(ctx) {
  const disposable = window.zion.events.on('myPlugin:itemSelected', (data) => {
    console.log('Item selected:', data);
    // 处理事件
  });
  
  ctx.subscriptions.push(disposable);
}
```

### 自定义事件总线

```javascript
class EventBus {
  constructor() {
    this.events = new Map();
  }
  
  on(event, callback) {
    if (!this.events.has(event)) {
      this.events.set(event, []);
    }
    this.events.get(event).push(callback);
    
    return () => {
      const callbacks = this.events.get(event);
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    };
  }
  
  emit(event, data) {
    const callbacks = this.events.get(event) || [];
    callbacks.forEach(callback => callback(data));
  }
}

// 使用
const eventBus = new EventBus();

const disposable = eventBus.on('customEvent', (data) => {
  console.log('Custom event:', data);
});

eventBus.emit('customEvent', { message: 'Hello!' });
```

## 🎨 样式处理

### 内联样式

```javascript
class StyledComponent {
  render() {
    this.container.innerHTML = `
      <div style="
        padding: 16px;
        background: #f5f5f5;
        border-radius: 8px;
      ">
        <h3 style="color: #333; margin: 0 0 8px;">Title</h3>
        <p style="color: #666;">Content</p>
      </div>
    `;
  }
}
```

### CSS 类

```javascript
// 创建样式表
const styleElement = document.createElement('style');
styleElement.textContent = `
  .my-component {
    padding: 16px;
    background: #f5f5f5;
    border-radius: 8px;
  }
  
  .my-component h3 {
    color: #333;
    margin: 0 0 8px;
  }
  
  .my-component p {
    color: #666;
  }
`;
document.head.appendChild(styleElement);

// 使用类
class StyledComponent {
  render() {
    this.container.innerHTML = `
      <div class="my-component">
        <h3>Title</h3>
        <p>Content</p>
      </div>
    `;
  }
}
```

### CSS Modules 风格

```javascript
function createScopedStyle(container, className, styles) {
  const uniqueClass = `${className}-${Math.random().toString(36).substr(2, 9)}`;
  
  const styleElement = document.createElement('style');
  const scopedStyles = Object.entries(styles)
    .map(([selector, style]) => {
      const scopedSelector = selector.replace(/\./g, `.${uniqueClass} `);
      return `${scopedSelector} { ${style} }`;
    })
    .join('\n');
  
  styleElement.textContent = scopedStyles;
  document.head.appendChild(styleElement);
  
  return uniqueClass;
}

// 使用
const styles = {
  '': 'padding: 16px;',
  'h3': 'color: #333; margin: 0 0 8px;',
  'p': 'color: #666;'
};

class ScopedComponent {
  constructor(container) {
    this.container = container;
    this.scopedClass = createScopedStyle(container, 'my-component', styles);
    this.render();
  }
  
  render() {
    this.container.innerHTML = `
      <div class="${this.scopedClass}">
        <h3>Title</h3>
        <p>Content</p>
      </div>
    `;
  }
}
```

## 📱 响应式插件

### 响应式组件

```javascript
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
    this.container.innerHTML = '<div class="mobile-view">Mobile</div>';
  }
  
  renderTablet() {
    this.container.innerHTML = '<div class="tablet-view">Tablet</div>';
  }
  
  renderDesktop() {
    this.container.innerHTML = '<div class="desktop-view">Desktop</div>';
  }
  
  dispose() {
    this.disposable.dispose();
  }
}
```

### 响应式布局

```javascript
window.zion.sideBar.registerView({
  id: 'responsive.view',
  pluginId: 'responsive-plugin',
  title: 'Responsive View',
  component: (container) => new ResponsiveComponent(container),
  responsive: {
    mobile: {
      visible: false,
      mode: 'drawer'
    },
    tablet: {
      visible: true,
      width: 180
    },
    desktop: {
      visible: true,
      width: 240
    }
  }
});
```

## 🎯 最佳实践

### 1. 资源清理

```javascript
class CleanupComponent {
  constructor(container) {
    this.container = container;
    this.timers = [];
    this.eventListeners = [];
    this.render();
    this.bindEvents();
  }
  
  bindEvents() {
    const clickHandler = () => console.log('Clicked');
    this.container.addEventListener('click', clickHandler);
    this.eventListeners.push({ type: 'click', handler: clickHandler });
    
    // 定时器
    const timer = setInterval(() => this.update(), 1000);
    this.timers.push(timer);
  }
  
  update() {
    // 更新逻辑
  }
  
  dispose() {
    // 清除所有定时器
    this.timers.forEach(timer => clearInterval(timer));
    this.timers = [];
    
    // 移除所有事件监听器
    this.eventListeners.forEach(({ type, handler }) => {
      this.container.removeEventListener(type, handler);
    });
    this.eventListeners = [];
    
    // 清空容器
    this.container.innerHTML = '';
  }
}
```

### 2. 防抖和节流

```javascript
// 防抖
function debounce(func, wait) {
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

// 节流
function throttle(func, limit) {
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
class SearchComponent {
  bindEvents() {
    const searchInput = this.container.querySelector('.search-input');
    
    // 防抖：避免频繁搜索
    searchInput.addEventListener('input', debounce((e) => {
      this.performSearch(e.target.value);
    }, 300));
    
    // 节流：限制滚动事件触发频率
    this.container.addEventListener('scroll', throttle(() => {
      this.handleScroll();
    }, 100));
  }
}
```

### 3. 错误处理

```javascript
class SafeComponent {
  async loadData() {
    try {
      const response = await fetch('/api/data');
      const data = await response.json();
      this.renderData(data);
    } catch (error) {
      console.error('Failed to load data:', error);
      this.renderError(error);
    }
  }
  
  renderData(data) {
    this.container.innerHTML = `
      <div class="data-list">
        ${data.map(item => `<div>${item.name}</div>`).join('')}
      </div>
    `;
  }
  
  renderError(error) {
    this.container.innerHTML = `
      <div class="error-state">
        <p>Failed to load data</p>
        <button class="retry">Retry</button>
      </div>
    `;
    
    this.container.querySelector('.retry').addEventListener('click', () => {
      this.loadData();
    });
  }
}
```

### 4. 性能优化

```javascript
class OptimizedComponent {
  constructor(container) {
    this.container = container;
    this.items = [];
    this.renderedItems = new Set();
    this.render();
  }
  
  updateItems(newItems) {
    // 只更新变化的项目
    newItems.forEach(item => {
      if (!this.renderedItems.has(item.id)) {
        this.appendItem(item);
        this.renderedItems.add(item.id);
      } else {
        this.updateItem(item);
      }
    });
    
    // 移除已删除的项目
    this.renderedItems.forEach(id => {
      if (!newItems.find(item => item.id === id)) {
        this.removeItem(id);
        this.renderedItems.delete(id);
      }
    });
  }
  
  appendItem(item) {
    const el = this.createItemElement(item);
    this.container.appendChild(el);
  }
  
  updateItem(item) {
    const el = this.container.querySelector(`[data-id="${item.id}"]`);
    if (el) {
      el.innerHTML = this.renderItemContent(item);
    }
  }
  
  removeItem(id) {
    const el = this.container.querySelector(`[data-id="${id}"]`);
    if (el) {
      el.remove();
    }
  }
}
```

### 5. 单元测试

```javascript
// MyComponent.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('MyComponent', () => {
  let container;
  let component;
  
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    component = new MyComponent(container);
  });
  
  afterEach(() => {
    component.dispose();
    container.remove();
  });
  
  it('should render correctly', () => {
    expect(container.innerHTML).toContain('Hello');
  });
  
  it('should handle clicks', () => {
    const button = container.querySelector('.action-button');
    button.click();
    // 断言点击处理逻辑
  });
});
```

## 🔗 相关资源

- [扩展点总览](./01-extension-points.md)
- [响应式设计](./08-responsive-design.md)
- [API 参考](./api-reference.md)

## 💡 常见问题

### Q: 如何调试插件？

A: 使用浏览器开发者工具：
1. 打开 Console 查看日志
2. 使用 Elements 检查 DOM
3. 在 Network 面板查看网络请求
4. 在 Sources 面板设置断点

### Q: 如何在不同设备上测试？

A: 使用浏览器的开发者工具：
1. 打开 DevTools (F12)
2. 点击设备切换按钮 (Ctrl+Shift+M)
3. 选择不同的设备或自定义尺寸

### Q: 如何与其他插件通信？

A: 使用事件总线：
```javascript
// 发布事件
window.zion.events.emit('pluginA:customEvent', data);

// 订阅事件
window.zion.events.on('pluginA:customEvent', (data) => {
  // 处理事件
});
```

### Q: 如何持久化数据？

A: 使用 Global State 或 Workspace State：
```javascript
// Global State（跨会话）
window.zion.state.set('myPlugin.data', data);

// Workspace State（工作区）
await ctx.workspaceState.update('data', data);
```
