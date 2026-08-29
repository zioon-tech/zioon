# 活动栏 (Activity Bar)

活动栏位于左侧最边缘，提供垂直排列的图标按钮，用于快速切换不同的视图。点击图标可以激活对应的侧边栏、辅助边栏或底部面板视图。

## 🎯 设计目标

- 提供快速访问不同视图的图标按钮
- 清晰的视觉层次结构
- 支持条件显示和优先级排序

## 📐 布局结构

```
┌──────────┬──────────────────────────────────────┐
│ACTIVITY  │  SIDE BAR (LEFT)                      │
│BAR       │  ┌────────────────────────────────┐ │
│💬        │  │ 视图切换标签                    │ │
│📁        │  ├────────────────────────────────┤ │
│⚙️        │  │                                │ │
│          │  │    插件视图内容                │ │
│          │  │                                │ │
└──────────┴──────────────────────────────────────┘
```

## 🔧 扩展点定义

### Manifest 配置

```json
{
  "zion": {
    "contributes": {
      "activityBarItems": [
        {
          "id": "session.activity",
          "icon": "💬",
          "tooltip": "Chat Sessions",
          "sideBarViewId": "session.list",
          "order": 10
        },
        {
          "id": "files.activity",
          "icon": "📁",
          "tooltip": "File Explorer",
          "sideBarViewId": "files.explorer",
          "order": 20
        },
        {
          "id": "terminal.activity",
          "icon": "⌨️",
          "tooltip": "Terminal",
          "bottomPanelViewId": "terminal.view",
          "order": 30
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
| `icon` | `string \| SVG` | ✅ | 图标（emoji 或 SVG 元素） |
| `tooltip` | `string` | ✅ | 鼠标悬停提示 |
| `sideBarViewId` | `string` | ❌ | 关联的左侧边栏视图 ID |
| `auxiliaryBarViewId` | `string` | ❌ | 兼容字段；关联的右侧辅助视图会由右侧导航栏展示，不再生成可见的 Activity Bar 项 |
| `bottomPanelViewId` | `string` | ❌ | 关联的底部面板视图 ID |
| `order` | `number` | ❌ | 排序权重（越小越靠前） |
| `when` | `string` | ❌ | 显示条件（表达式） |

**注意**：必须指定 `sideBarViewId`、`auxiliaryBarViewId` 或 `bottomPanelViewId` 中的一个。

Auxiliary Bar 已有独立的右侧视图导航。新插件应只调用 `auxiliaryBar.registerView`，不要再为同一视图注册 Activity Bar 项。

## 📝 API 使用

### 注册活动栏项目

```javascript
export async function activate(ctx) {
  const disposable = window.zion.activityBar.registerItem({
    id: 'my.activity',
    pluginId: 'my-plugin',
    icon: '📦',
    tooltip: 'My Plugin',
    sideBarViewId: 'my.view',
    order: 10,
    when: 'true',
    
    onClick: () => {
      console.log('Activity item clicked');
    }
  });
  
  ctx.subscriptions.push(disposable);
}
```

### 控制活动栏

```javascript
// 激活项目
window.zion.activityBar.activateItem('my.activity');

// 显示活动栏
window.zion.activityBar.show();

// 隐藏活动栏
window.zion.activityBar.hide();

// 切换活动栏
window.zion.activityBar.toggle();

// 获取所有项目
const items = window.zion.activityBar.getItems();
```

## 🎨 图标类型

### 1. Emoji 图标

```javascript
window.zion.activityBar.registerItem({
  id: 'session.activity',
  icon: '💬',
  tooltip: 'Sessions'
});
```

### 2. SVG 图标

```javascript
window.zion.activityBar.registerItem({
  id: 'my.activity',
  icon: `
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2L2 7l10 5 10-5-10-5zm0 9l2.5-1.25L12 8.5l-2.5 1.25L12 11zm0 2.5l-5-2.5-5 2.5L12 22l10-8.5-5-2.5-5 2.5z"/>
    </svg>
  `,
  tooltip: 'My Plugin'
});
```

### 3. 动态图标

```javascript
class DynamicIcon {
  constructor(element) {
    this.element = element;
    this.state = 'normal';
    this.update();
  }
  
  update() {
    const icons = {
      normal: '💬',
      active: '💬🔥',
      error: '💬❌'
    };
    
    this.element.textContent = icons[this.state];
  }
  
  setState(state) {
    this.state = state;
    this.update();
  }
}

// 使用
window.zion.activityBar.registerItem({
  id: 'dynamic.activity',
  icon: (container) => new DynamicIcon(container),
  tooltip: 'Dynamic Icon'
});
```

## 📱 响应式行为

### 桌面端 (> 1024px)

- 完整显示
- 所有项目可见
- 支持 Tooltip

### 平板端 (768px - 1024px)

- 完整显示
- 可能只显示高优先级项目

### 手机端 (< 768px)

- 隐藏活动栏
- 移到底部导航栏

```json
{
  "activityBarItems": [
    {
      "id": "session.activity",
      "icon": "💬",
      "tooltip": "Sessions",
      "sideBarViewId": "session.list",
      "responsive": {
        "mobile": {
          "visible": false
        },
        "mobileBottomNav": {
          "visible": true,
          "icon": "💬",
          "label": "Sessions"
        }
      }
    }
  ]
}
```

## 🔄 行为模式

### 1. 切换视图（默认）

点击图标激活关联的视图：

```javascript
window.zion.activityBar.registerItem({
  id: 'session.activity',
  icon: '💬',
  tooltip: 'Sessions',
  sideBarViewId: 'session.list'
});
```

### 2. 自定义点击行为

```javascript
window.zion.activityBar.registerItem({
  id: 'custom.activity',
  icon: '⚙️',
  tooltip: 'Settings',
  onClick: () => {
    // 打开设置面板
    window.zion.commands.executeCommand('settings.open');
  }
});
```

### 3. 条件激活

```javascript
window.zion.activityBar.registerItem({
  id: 'session.activity',
  icon: '💬',
  tooltip: 'Sessions',
  sideBarViewId: 'session.list',
  when: 'editorIsMarkdown || hasActiveSession'
});
```

## 📊 状态管理

### 激活状态

```javascript
class ActivityItem {
  constructor(options) {
    this.id = options.id;
    this.icon = options.icon;
    this.tooltip = options.tooltip;
    this.active = false;
  }
  
  setActive(active) {
    this.active = active;
    this.updateStyles();
  }
  
  updateStyles() {
    if (this.active) {
      this.element.classList.add('active');
    } else {
      this.element.classList.remove('active');
    }
  }
}
```

### 禁用状态

```javascript
window.zion.activityBar.registerItem({
  id: 'my.activity',
  icon: '📦',
  tooltip: 'My Plugin',
  when: 'hasValidLicense',
  // 或者在代码中动态控制
  onCanActivate: () => {
    return window.zion.license.isValid();
  }
});
```

## 🎯 最佳实践

### 1. 清晰的图标语义

```javascript
// ✅ 好的图标
{
  icon: '💬',  // 对话
  tooltip: 'Chat Sessions'
}

// ❌ 不好的图标
{
  icon: '🦄',  // 不明确
  tooltip: 'Chat Sessions'
}
```

### 2. 合理的优先级

```javascript
// 高优先级：始终显示
{
  id: 'session.activity',
  order: 10,
  when: 'true'
}

// 中优先级：条件显示
{
  id: 'terminal.activity',
  order: 20,
  when: 'hasTerminalAccess'
}

// 低优先级：按需显示
{
  id: 'advanced.activity',
  order: 100,
  when: 'isAdvancedMode'
}
```

### 3. 一致性的分组

```javascript
// 按功能分组
const activityItems = [
  // 核心功能 (1-10)
  { id: 'sessions', order: 1 },
  { id: 'files', order: 2 },
  
  // 编辑器功能 (11-20)
  { id: 'search', order: 11 },
  { id: 'replace', order: 12 },
  
  // 工具功能 (21-50)
  { id: 'terminal', order: 21 },
  { id: 'preview', order: 22 },
  
  // 设置 (100+)
  { id: 'settings', order: 100 }
];
```

### 4. 响应式适配

```javascript
// 桌面端完整，移动端精简
window.zion.activityBar.registerItem({
  id: 'session.activity',
  icon: '💬',
  tooltip: 'Sessions',
  sideBarViewId: 'session.list',
  order: 10,
  responsive: {
    desktop: {
      visible: true
    },
    mobile: {
      visible: false
    },
    mobileBottomNav: {
      visible: true,
      icon: '💬',
      label: 'Chat'
    }
  }
});
```

## 🔗 相关文档

- [扩展点总览](./01-extension-points.md)
- [左侧边栏](./02-sidebar-left.md)
- [底部面板](./05-bottom-panel.md)
- [响应式设计](./08-responsive-design.md)
