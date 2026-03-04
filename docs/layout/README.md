# Zion Next Layout System - 布局系统总览

Zion Next 的布局系统设计参考了 VSCode 的成熟架构，为插件提供了灵活的布局扩展点。本系统支持多种设备形态的响应式适配，确保插件在不同屏幕尺寸下都能良好工作。

## 📐 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│  TITLE BAR                                                   │
├──────────┬──────────────────────────────────────┬───────────┤
│ACTIVITY  │  SIDE BAR (LEFT)                      │ AUXILIARY │
│BAR       │  - Explorer / File Tree              │ BAR (RIGHT)│
│💬 📁 ⚙️  │  - Chat Sessions                     │  - Preview │
│          │  - TOC / Bookmarks                    │  - Context │
│          │  - History                           │  - Artifacts│
├──────────┴──────────────────────────────────────┴───────────┤
│  EDITOR AREA (Chat / Markdown / Code)                     │
├─────────────────────────────────────────────────────────────┤
│  BOTTOM PANEL (Terminal | Output | Problems)                │
├─────────────────────────────────────────────────────────────┤
│  STATUS BAR (left | center | right)                         │
│  Ln 1, Col 5  │  UTF-8  │  Ready  │  Branch: main          │
└─────────────────────────────────────────────────────────────┘
```

## 🎯 核心设计目标

1. **插件友好**：插件无需关心布局框架，只需注册自己的视图组件
2. **响应式适配**：自动适配手机、平板、桌面等不同设备
3. **统一体验**：所有插件在统一的 UI 框架下运行
4. **灵活配置**：支持布局自定义和持久化
5. **性能优先**：支持视图懒加载和虚拟滚动

## 📂 文档目录

- [01 扩展点总览](./01-extension-points.md) - 所有可用的布局扩展点
- [02 左侧边栏](./02-sidebar-left.md) - 文件树、会话列表等主视图
- [03 右侧辅助边栏](./03-auxiliary-bar-right.md) - 预览、产物等辅助视图
- [04 活动栏](./04-activity-bar.md) - 左侧图标导航栏
- [05 底部面板](./05-bottom-panel.md) - 终端、输出等底部视图
- [06 状态栏](./06-status-bar.md) - 底部状态信息显示
- [07 编辑器区域](./07-editor-area.md) - 编辑器标签和分组管理
- [08 响应式设计](./08-responsive-design.md) - 跨设备适配策略
- [09 插件开发指南](./09-plugin-guide.md) - 如何在插件中使用布局系统
- [10 全局命令台](./10-command-palette.md) - Cmd+K 搜索并执行任意命令
- [11 选中文本工具栏](./11-selection-toolbar.md) - 选区浮动工具栏（可注册按钮/下拉）
- [API 参考](./api-reference.md) - 完整的 API 文档

## 🔑 快速开始

### 在 manifest.json 中声明布局贡献

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "zion": {
    "id": "my-plugin",
    "name": "My Plugin",
    "version": "1.0.0",
    "main": "./main.js",
    "contributes": {
      "activityBarItems": [
        {
          "id": "my.activity",
          "icon": "📦",
          "tooltip": "My Plugin",
          "sideBarViewId": "my.view",
          "order": 10
        }
      ],
      "sideBarViews": [
        {
          "id": "my.view",
          "title": "My View",
          "icon": "📦"
        }
      ]
    }
  }
}
```

### 在插件代码中注册视图组件

```javascript
export async function activate(ctx) {
  const MyComponent = {
    render: (container) => {
      const el = document.createElement('div');
      el.textContent = 'Hello from my plugin!';
      container.appendChild(el);
      
      return {
        dispose: () => {
          container.innerHTML = '';
        }
      };
    }
  };
  
  const disposable = window.zion.sideBar.registerView({
    id: 'my.view',
    pluginId: 'my-plugin',
    title: 'My View',
    icon: '📦',
    location: 'sidebar',
    component: MyComponent
  });
  
  ctx.subscriptions.push(disposable);
}
```

## 📊 设备适配概览

| 设备类型 | 屏幕宽度 | 左侧边栏 | 右侧边栏 | 底部面板 | 活动栏 |
|---------|---------|---------|---------|---------|-------|
| 手机 | < 768px | 抽屉菜单 | 全屏覆盖 | 全屏覆盖 | 隐藏 |
| 平板 | 768-1024px | 侧边栏(180px) | 隐藏/覆盖 | 可滑动标签 | 简化 |
| 桌面 | 1024-1440px | 侧边栏(240px) | 侧边栏(300px) | 多视图切换 | 完整 |
| 大屏 | > 1440px | 侧边栏(280px) | 侧边栏(350px) | 多视图切换 | 完整 |

详细说明请查看 [响应式设计文档](./08-responsive-design.md)。

## 🚀 下一步

1. 阅读 [扩展点总览](./01-extension-points.md) 了解所有可用扩展点
2. 查看 [插件开发指南](./09-plugin-guide.md) 学习如何集成
3. 参考 [API 文档](./api-reference.md) 了解完整 API

## 📝 贡献

本文档是开源的，欢迎贡献改进建议和补充内容。
