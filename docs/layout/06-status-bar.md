# 状态栏 (Status Bar)

状态栏位于窗口最底部，用于显示运行时状态、编辑器信息和快捷操作。支持左、中、右三个区域的分区显示。

## 🎯 设计目标

- 提供简洁的状态信息显示
- 支持分区显示（左、中、右）
- 支持点击交互
- 响应式适配不同设备

## 📐 布局结构

```
┌─────────────────────────────────────────────────────────────┐
│  EDITOR AREA                                                 │
├─────────────────────────────────────────────────────────────┤
│  BOTTOM PANEL                                                │
│  [Terminal] [Output] [Problems] [Debug]                      │
│  ┌────────────────────────────────────────────────────┐    │
│  │ > npm install                                      │    │
│  │                                                     │    │
│  └────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────┤
│  STATUS BAR (left | center | right)                         │
│  Ln 1, Col 5 │ UTF-8 │ Ready │ Branch: main                │
└─────────────────────────────────────────────────────────────┘
```

## 🔧 扩展点定义

### Manifest 配置

```json
{
  "zion": {
    "contributes": {
      "statusBarItems": [
        {
          "id": "editor.status",
          "text": "Ln 1, Col 5",
          "tooltip": "Current cursor position",
          "position": "left",
          "order": 10
        },
        {
          "id": "encoding.status",
          "text": "UTF-8",
          "tooltip": "File encoding",
          "position": "center",
          "order": 10
        },
        {
          "id": "ready.status",
          "text": "● Ready",
          "tooltip": "System is ready",
          "position": "right",
          "order": 100
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
| `text` | `string` | ✅ | 显示文本 |
| `tooltip` | `string` | ❌ | 鼠标悬停提示 |
| `icon` | `string \| SVG` | ❌ | 图标 |
| `position` | `'left' \| 'center' \| 'right'` | ✅ | 显示区域 |
| `align` | `'left' \| 'right'` | ❌ | 在区域内的对齐方式 |
| `order` | `number` | ❌ | 排序权重（越小越靠前） |
| `priority` | `number` | ❌ | 优先级（用于空间不足时的隐藏决策） |
| `onClick` | `string` | ❌ | 点击时执行的命令 ID |
| `when` | `string` | ❌ | 显示条件（表达式） |
| `color` | `string` | ❌ | 文字颜色 |
| `backgroundColor` | `string` | ❌ | 背景颜色 |

## 📝 API 使用

### 注册状态栏项目

```javascript
export async function activate(ctx) {
  const disposable1 = window.zion.statusBar.registerItem({
    id: 'my-plugin.status',
    pluginId: 'my-plugin',
    text: 'My Plugin',
    tooltip: 'Click to open settings',
    icon: '📦',
    position: 'right',
    order: 50,
    priority: 50,
    color: '#4CAF50',
    
    onClick: () => {
      console.log('Status bar item clicked');
      window.zion.commands.executeCommand('myPlugin.openSettings');
    },
    
    when: 'myPlugin.isEnabled'
  });
  
  ctx.subscriptions.push(disposable1);
}
```

### 动态更新

```javascript
// 更新文本
window.zion.statusBar.updateItem('cursor.status', {
  text: `Ln ${line}, Col ${col}`
});

// 更新颜色
window.zion.statusBar.updateItem('connection.status', {
  text: '● Connected',
  color: '#4CAF50'
});

// 更新所有属性
window.zion.statusBar.updateItem('my.status', {
  text: 'Updated',
  tooltip: 'New tooltip',
  icon: '✅',
  color: '#2E7D32'
});

// 移除项目
window.zion.statusBar.removeItem('my.status');
```

## 🎨 分区显示

### 左侧区域

显示编辑器相关状态：

```javascript
window.zion.statusBar.registerItem({
  id: 'cursor.position',
  text: 'Ln 1, Col 5',
  tooltip: 'Cursor position',
  position: 'left',
  order: 10
});

window.zion.statusBar.registerItem({
  id: 'file.size',
  text: '1.2 KB',
  tooltip: 'File size',
  position: 'left',
  order: 20
});

window.zion.statusBar.registerItem({
  id: 'line.count',
  text: '42 lines',
  tooltip: 'Line count',
  position: 'left',
  order: 30
});
```

### 中间区域

显示全局状态信息：

```javascript
window.zion.statusBar.registerItem({
  id: 'encoding',
  text: 'UTF-8',
  tooltip: 'File encoding',
  position: 'center',
  order: 10
});

window.zion.statusBar.registerItem({
  id: 'language',
  text: 'JavaScript',
  tooltip: 'Language mode',
  position: 'center',
  order: 20
});

window.zion.statusBar.registerItem({
  id: 'line.ending',
  text: 'LF',
  tooltip: 'Line ending',
  position: 'center',
  order: 30
});
```

### 右侧区域

显示操作按钮和系统状态：

```javascript
window.zion.statusBar.registerItem({
  id: 'git.branch',
  text: '⌥ main',
  tooltip: 'Git branch',
  position: 'right',
  order: 10
});

window.zion.statusBar.registerItem({
  id: 'theme.toggle',
  text: '🌙',
  tooltip: 'Toggle theme',
  position: 'right',
  order: 20,
  onClick: () => window.zion.commands.executeCommand('zion.toggleTheme')
});

window.zion.statusBar.registerItem({
  id: 'ready',
  text: '● Ready',
  tooltip: 'System ready',
  position: 'right',
  order: 100
});
```

## 🔄 实时更新示例

### 光标位置

```javascript
export async function activate(ctx) {
  const cursorItem = window.zion.statusBar.registerItem({
    id: 'cursor.position',
    text: 'Ln 1, Col 1',
    position: 'left',
    order: 10
  });
  
  // 监听编辑器光标变化
  const disposable = window.zion.editor.onCursorChange((cursor) => {
    window.zion.statusBar.updateItem('cursor.position', {
      text: `Ln ${cursor.line}, Col ${cursor.ch}`
    });
  });
  
  ctx.subscriptions.push(disposable);
}
```

### 连接状态

```javascript
export async function activate(ctx) {
  const connectionItem = window.zion.statusBar.registerItem({
    id: 'connection.status',
    text: '○ Disconnected',
    tooltip: 'Connection status',
    position: 'right',
    order: 10,
    color: '#f44336',
    onClick: () => window.zion.commands.executeCommand('connection.connect')
  });
  
  // 监听连接状态变化
  window.zion.events.on('connection:statusChanged', (status) => {
    const config = {
      text: status === 'connected' ? '● Connected' : '○ Disconnected',
      color: status === 'connected' ? '#4CAF50' : '#f44336',
      tooltip: status === 'connected' ? 'Connected' : 'Click to connect'
    };
    
    window.zion.statusBar.updateItem('connection.status', config);
  });
}
```

### 主题切换

```javascript
export async function activate(ctx) {
  const themeItem = window.zion.statusBar.registerItem({
    id: 'theme.toggle',
    text: '🌙',
    tooltip: 'Current theme: Dark',
    position: 'right',
    order: 20,
    onClick: () => window.zion.commands.executeCommand('zion.toggleTheme')
  });
  
  // 监听主题变化
  window.zion.state.onDidChange('ui.theme', (theme) => {
    window.zion.statusBar.updateItem('theme.toggle', {
      text: theme === 'dark' ? '🌙' : '☀️',
      tooltip: `Current theme: ${theme === 'dark' ? 'Dark' : 'Light'}`
    });
  });
}
```

## 📱 响应式行为

### 桌面端 (> 1024px)

- 显示所有项目
- 完整的工具提示

### 平板端 (768px - 1024px)

- 根据优先级隐藏部分项目
- 简化工具提示

### 手机端 (< 768px)

- 只显示高优先级项目
- 隐藏左侧和中间区域
- 只显示右侧操作按钮

```javascript
window.zion.statusBar.registerItem({
  id: 'my.status',
  text: 'Status',
  position: 'right',
  priority: 100,
  responsive: {
    mobile: {
      visible: true,
      compact: true
    },
    tablet: {
      visible: true
    },
    desktop: {
      visible: true
    }
  }
});
```

## 🎨 样式自定义

### 颜色

```javascript
window.zion.statusBar.registerItem({
  id: 'success.status',
  text: '● Success',
  color: '#4CAF50',
  backgroundColor: '#E8F5E9',
  position: 'right'
});

window.zion.statusBar.registerItem({
  id: 'warning.status',
  text: '⚠️ Warning',
  color: '#FF9800',
  backgroundColor: '#FFF3E0',
  position: 'right'
});

window.zion.statusBar.registerItem({
  id: 'error.status',
  text: '❌ Error',
  color: '#f44336',
  backgroundColor: '#FFEBEE',
  position: 'right'
});
```

### 图标 + 文本

```javascript
window.zion.statusBar.registerItem({
  id: 'git.status',
  text: '⌥ main',
  tooltip: 'Git branch: main',
  position: 'right'
});

window.zion.statusBar.registerItem({
  id: 'sync.status',
  text: '🔄',
  tooltip: 'Syncing...',
  position: 'right'
});
```

### SVG 图标

```javascript
window.zion.statusBar.registerItem({
  id: 'sync.icon',
  icon: `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
    </svg>
  `,
  tooltip: 'Refresh',
  position: 'right'
});
```

## 📊 最佳实践

### 1. 优先级设置

```javascript
// 高优先级：始终显示
window.zion.statusBar.registerItem({
  id: 'ready',
  text: '● Ready',
  position: 'right',
  priority: 100
});

// 中优先级：空间允许时显示
window.zion.statusBar.registerItem({
  id: 'branch',
  text: '⌥ main',
  position: 'right',
  priority: 50
});

// 低优先级：可能隐藏
window.zion.statusBar.registerItem({
  id: 'line.count',
  text: '42 lines',
  position: 'left',
  priority: 10
});
```

### 2. 条件显示

```javascript
// 只在特定编辑器类型时显示
window.zion.statusBar.registerItem({
  id: 'language.mode',
  text: 'JavaScript',
  position: 'center',
  when: 'editorIsJavaScript'
});

// 只在有 Git 仓库时显示
window.zion.statusBar.registerItem({
  id: 'git.branch',
  text: '⌥ main',
  position: 'right',
  when: 'hasGitRepository'
});
```

### 3. 防抖更新

```javascript
import { debounce } from 'lodash-es';

export async function activate(ctx) {
  const cursorItem = window.zion.statusBar.registerItem({
    id: 'cursor.position',
    text: 'Ln 1, Col 1',
    position: 'left'
  });
  
  // 防抖，避免频繁更新
  const updatePosition = debounce((cursor) => {
    window.zion.statusBar.updateItem('cursor.position', {
      text: `Ln ${cursor.line}, Col ${cursor.ch}`
    });
  }, 100);
  
  const disposable = window.zion.editor.onCursorChange(updatePosition);
  ctx.subscriptions.push(disposable);
}
```

### 4. 工具提示增强

```javascript
window.zion.statusBar.registerItem({
  id: 'detailed.status',
  text: '● Connected',
  tooltip: `
    Connection Status
    ─────────────────────
    Status: Connected
    Server: api.example.com
    Latency: 45ms
    Uptime: 2h 34m
    
    Click to view details
  `,
  position: 'right'
});
```

## 🔗 相关文档

- [扩展点总览](./01-extension-points.md)
- [响应式设计](./08-responsive-design.md)
- [插件开发指南](./09-plugin-guide.md)
