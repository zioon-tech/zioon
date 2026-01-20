# 左侧边栏 (Side Bar - Left)

左侧边栏是 Zion Next 的主要导航区域，用于显示插件的主要内容和视图。插件可以在这里注册自己的视图组件。

## 🎯 设计目标

- 提供统一的主视图容器
- 支持多个插件视图的切换
- 可调整宽度
- 响应式适配不同设备

## 📐 布局结构

```
┌──────────┬──────────────────────────────────────┐
│ACTIVITY  │  SIDE BAR (LEFT)                      │
│BAR       │  ┌────────────────────────────────┐ │
│💬 📁 ⚙️  │  │ 视图切换标签                    │ │
│          │  ├────────────────────────────────┤ │
│          │  │                                │ │
│          │  │    插件视图内容                │ │
│          │  │                                │ │
│          │  │                                │ │
│          │  └────────────────────────────────┘ │
└──────────┴──────────────────────────────────────┘
```

## 🔧 扩展点定义

### Manifest 配置

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
          "when": "true"
        }
      ]
    }
  }
}
```

### 属性说明

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string` | ✅ | 唯一标识符 |
| `title` | `string` | ✅ | 视图标题 |
| `icon` | `string \| SVG` | ❌ | 图标（字符串 emoji 或 SVG 元素） |
| `order` | `number` | ❌ | 排序权重（越小越靠前） |
| `when` | `string` | ❌ | 显示条件（表达式） |
| `canClose` | `boolean` | ❌ | 是否可关闭（默认 `false`） |

## 📝 API 使用

### 注册视图

```javascript
export async function activate(ctx) {
  const MyComponent = {
    render: (container) => {
      // 创建 DOM 元素
      const el = document.createElement('div');
      el.className = 'my-sidebar-view';
      el.innerHTML = `
        <h3>My Sidebar View</h3>
        <ul>
          <li>Item 1</li>
          <li>Item 2</li>
        </ul>
      `;
      container.appendChild(el);
      
      // 返回清理函数
      return {
        dispose: () => {
          container.innerHTML = '';
        }
      };
    },
    
    onActivate: () => {
      console.log('View activated');
    },
    
    onDeactivate: () => {
      console.log('View deactivated');
    }
  };
  
  const disposable = window.zion.sideBar.registerView({
    id: 'my.view',
    pluginId: 'my-plugin',
    title: 'My View',
    icon: '📦',
    location: 'sidebar',
    component: MyComponent,
    order: 10,
    canClose: false,
    
    onActivate: () => console.log('View activated'),
    onDeactivate: () => console.log('View deactivated')
  });
  
  ctx.subscriptions.push(disposable);
}
```

### 控制侧边栏

```javascript
// 激活视图
window.zion.sideBar.activateView('my.view');

// 关闭视图
window.zion.sideBar.closeView('my.view');

// 显示侧边栏
window.zion.sideBar.show();

// 隐藏侧边栏
window.zion.sideBar.hide();

// 切换侧边栏
window.zion.sideBar.toggle();

// 设置宽度
window.zion.sideBar.setWidth(300);

// 获取所有视图
const views = window.zion.sideBar.getViews();
```

## 📱 响应式行为

### 桌面端 (> 1024px)

- 默认宽度：240px
- 完整显示所有视图
- 支持拖拽调整宽度

### 平板端 (768px - 1024px)

- 默认宽度：180px
- 保持侧边栏显示
- 减少视图内容密度

### 手机端 (< 768px)

- 默认隐藏
- 以抽屉菜单形式展示
- 通过滑动手势或菜单按钮打开

## 🎨 组件类型支持

### 1. 函数式组件

```javascript
const component = (container) => {
  const el = document.createElement('div');
  el.textContent = 'Hello';
  container.appendChild(el);
  
  return { dispose: () => {} };
};
```

### 2. 类组件

```javascript
class SidebarComponent {
  constructor(container) {
    this.container = container;
    this.render();
  }
  
  render() {
    this.container.innerHTML = '<div>My View</div>';
  }
  
  dispose() {
    this.container.innerHTML = '';
  }
}

const component = (container) => new SidebarComponent(container);
```

### 3. Web Component

```javascript
class MySidebarView extends HTMLElement {
  connectedCallback() {
    this.innerHTML = '<div>My View</div>';
  }
  
  disconnectedCallback() {
    // 清理
  }
}

customElements.define('my-sidebar-view', MySidebarView);

const component = (container) => {
  const el = document.createElement('my-sidebar-view');
  container.appendChild(el);
  
  return {
    dispose: () => el.remove()
  };
};
```

## 🔄 生命周期

### onActivate

视图被激活时调用：

```javascript
{
  onActivate: async () => {
    // 加载数据
    await this.loadData();
    // 刷新 UI
    this.refresh();
  }
}
```

### onDeactivate

视图被停用时调用：

```javascript
{
  onDeactivate: () => {
    // 保存状态
    this.saveState();
    // 暂停定时器等
    clearInterval(this.timer);
  }
}
```

### onResize

视图尺寸变化时调用：

```javascript
{
  onResize: ({ width, height }) => {
    console.log('New size:', width, height);
    // 重新计算布局
    this.calculateLayout();
  }
}
```

### onDispose

视图被销毁时调用：

```javascript
{
  onDispose: () => {
    // 清理资源
    this.cleanup();
  }
}
```

## 📊 最佳实践

### 1. 使用虚拟滚动（长列表）

```javascript
class VirtualList {
  constructor(container, items) {
    this.container = container;
    this.items = items;
    this.visibleStart = 0;
    this.visibleEnd = 20;
    this.render();
    
    this.container.addEventListener('scroll', () => this.onScroll());
  }
  
  onScroll() {
    // 计算可见范围
    const scrollTop = this.container.scrollTop;
    const itemHeight = 32;
    this.visibleStart = Math.floor(scrollTop / itemHeight);
    this.visibleEnd = this.visibleStart + 20;
    this.render();
  }
  
  render() {
    // 只渲染可见项
    const visibleItems = this.items.slice(this.visibleStart, this.visibleEnd);
    this.container.innerHTML = visibleItems.map(item => `<div>${item}</div>`).join('');
  }
}
```

### 2. 响应式样式

```css
.my-sidebar-view {
  padding: 12px;
}

/* 平板端 */
@media (max-width: 1024px) {
  .my-sidebar-view {
    padding: 8px;
    font-size: 14px;
  }
}

/* 手机端 */
@media (max-width: 768px) {
  .my-sidebar-view {
    padding: 4px;
    font-size: 13px;
  }
}
```

### 3. 懒加载内容

```javascript
{
  onActivate: async () => {
    // 只在激活时加载
    if (!this.loaded) {
      await this.loadContent();
      this.loaded = true;
    }
  },
  
  onDeactivate: () => {
    // 停用时不销毁，保持状态
  }
}
```

### 4. 事件委托

```javascript
class SidebarView {
  constructor(container) {
    this.container = container;
    this.render();
    
    // 使用事件委托，而不是为每个元素绑定
    this.container.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (target) {
        const action = target.dataset.action;
        this.handleAction(action, e);
      }
    });
  }
  
  render() {
    this.container.innerHTML = `
      <ul>
        <li data-action="open">Open</li>
        <li data-action="delete">Delete</li>
      </ul>
    `;
  }
  
  handleAction(action, event) {
    console.log('Action:', action);
  }
}
```

## 🔗 相关文档

- [扩展点总览](./01-extension-points.md)
- [响应式设计](./08-responsive-design.md)
- [插件开发指南](./09-plugin-guide.md)
