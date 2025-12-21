# 插件开发指南

## 概述

本指南将帮助你开发 Zion Next 插件。Zion Next 提供了一个强大的插件系统，允许你扩展编辑器的功能。

## 快速开始

### 1. 创建插件项目

使用我们的插件模板快速开始：

```bash
# 复制模板目录
cp -r templates/plugin-template my-plugin
cd my-plugin

# 安装依赖
npm install

# 构建插件
npm run build
```

### 2. 插件结构

一个基本的插件包含以下文件：

```
my-plugin/
├── manifest.json          # 插件清单
├── package.json           # npm 包配置
├── src/
│   └── main.ts           # 插件入口
├── types/
│   └── plugin.ts         # 类型定义
└── README.md             # 文档
```

### 3. 基本插件示例

**manifest.json**
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My first Zion plugin",
  "zion": {
    "id": "com.example.myplugin",
    "name": "My Plugin",
    "version": "1.0.0",
    "main": "./dist/main.js",
    "activationEvents": ["onStartupFinished"]
  }
}
```

**src/main.ts**
```typescript
import type { PluginContext } from '../types/plugin';

export async function activate(context: PluginContext): Promise<void> {
  console.log('My plugin activated!');
  
  // 注册命令
  const disposable = window.zion.commands.registerCommand('myplugin.hello', () => {
    window.zion.window.showInformationMessage('Hello from my plugin!');
  });
  
  context.subscriptions.push(disposable);
}

export async function deactivate(): Promise<void> {
  console.log('My plugin deactivated!');
}
```

## 核心概念

### 插件生命周期

1. **安装**: 插件被复制到插件目录
2. **加载**: 插件清单被读取和验证
3. **激活**: `activate()` 函数被调用
4. **运行**: 插件功能可用
5. **停用**: `deactivate()` 函数被调用
6. **卸载**: 插件从系统中移除

### 插件上下文

插件上下文 (`PluginContext`) 提供了访问 Zion Next API 的入口：

```typescript
interface PluginContext {
  subscriptions: Disposable[];      // 自动清理资源
  extensionPath: string;            // 插件路径
  globalState: Memento;             // 全局状态存储
  workspaceState: Memento;          // 工作区状态存储
  configuration: PluginConfigurationManager; // 配置管理
  asAbsolutePath(path: string): string;     // 路径转换
  log(message: string, level?: string): void; // 日志记录
}
```

### 激活事件

插件可以通过激活事件来控制何时被加载：

```json
{
  "zion": {
    "activationEvents": [
      "onStartupFinished",
      "onCommand:myplugin.hello",
      "onView:myplugin.panel"
    ]
  }
}
```

支持的激活事件：
- `onStartupFinished` - 编辑器启动完成
- `onCommand:commandId` - 特定命令被调用
- `onView:viewId` - 特定视图被打开
- `onLanguage:languageId` - 特定语言文件被打开

## API 参考

### 命令系统

注册命令：
```typescript
const disposable = window.zion.commands.registerCommand('myplugin.sayHello', () => {
  console.log('Hello!');
});
context.subscriptions.push(disposable);
```

执行命令：
```typescript
window.zion.commands.executeCommand('myplugin.sayHello');
```

### 快捷键绑定

注册快捷键：
```typescript
const disposable = window.zion.keybindings.register({
  command: 'myplugin.sayHello',
  key: 'ctrl+shift+h',
  when: 'editorFocus'
});
context.subscriptions.push(disposable);
```

### 菜单系统

添加菜单项：
```typescript
const disposable = window.zion.menus.register('editor/context', {
  command: 'myplugin.sayHello',
  title: 'Say Hello',
  when: 'editorFocus'
});
context.subscriptions.push(disposable);
```

### 状态栏

添加状态栏项：
```typescript
const disposable = window.zion.statusBar.registerItem({
  id: 'myplugin.status',
  text: 'My Plugin',
  tooltip: 'Click me!',
  onClick: () => {
    window.zion.commands.executeCommand('myplugin.sayHello');
  }
});
context.subscriptions.push(disposable);
```

### 编辑器操作

获取当前编辑器：
```typescript
const editor = window.zion.window.activeEditor;
if (editor) {
  const text = editor.getValue();
  editor.replaceSelection('Hello World!');
}
```

### 事件系统

监听事件：
```typescript
const disposable = window.zion.events.on('editor:focus', () => {
  console.log('Editor gained focus');
});
context.subscriptions.push(disposable);
```

发布事件：
```typescript
window.zion.events.emit('myplugin:customEvent', { data: 'value' });
```

### 状态存储

全局状态（跨会话持久化）：
```typescript
const count = context.globalState.get<number>('usageCount', 0);
await context.globalState.update('usageCount', count + 1);
```

工作区状态（当前工作区）：
```typescript
const data = context.workspaceState.get('workspaceData');
await context.workspaceState.update('workspaceData', { key: 'value' });
```

### 配置管理

获取配置：
```typescript
const enabled = context.configuration.get<boolean>('myplugin.enabled', true);
const timeout = context.configuration.get<number>('myplugin.timeout', 5000);
```

监听配置变化：
```typescript
const disposable = context.configuration.onDidChange('myplugin.enabled', (value) => {
  console.log('Enabled changed to:', value);
});
context.subscriptions.push(disposable);
```

### 粘贴处理器

处理粘贴事件：
```typescript
const disposable = window.zion.editor.registerPasteHandler({
  id: 'myplugin.pasteHandler',
  priority: 50,
  handle: ({ clipboardData, editor }) => {
    const text = clipboardData.getData('text/plain');
    if (text === 'special') {
      editor.replaceSelection('Processed: ' + text);
      return true; // 已处理
    }
    return false; // 未处理
  }
});
context.subscriptions.push(disposable);
```

### 装饰器

添加轻量级UI增强：
```typescript
const disposable = window.zion.editor.registerDecorator({
  id: 'myplugin.decorator',
  apply: (editor) => {
    // 添加装饰逻辑
    console.log('Decorator applied');
    
    return {
      dispose: () => {
        // 清理逻辑
        console.log('Decorator disposed');
      }
    };
  }
});
context.subscriptions.push(disposable);
```

## 高级功能

### 多语言支持

创建语言定义：
```typescript
// 在 manifest.json 中
{
  "zion": {
    "contributes": {
      "languages": [{
        "id": "mylang",
        "extensions": [".mylang"],
        "aliases": ["My Language"]
      }]
    }
  }
}
```

### 主题支持

创建主题：
```typescript
// 在 manifest.json 中
{
  "zion": {
    "contributes": {
      "themes": [{
        "id": "mytheme",
        "label": "My Theme",
        "uiTheme": "vs-dark",
        "path": "./themes/my-theme.json"
      }]
    }
  }
}
```

### 视图贡献

创建自定义视图：
```typescript
// 在 manifest.json 中
{
  "zion": {
    "contributes": {
      "views": [{
        "id": "myplugin.panel",
        "title": "My Panel",
        "type": "sidebar",
        "icon": "icon-panel"
      }]
    }
  }
}
```

### 依赖管理

声明插件依赖：
```json
{
  "zion": {
    "dependencies": {
      "com.example.otherplugin": "^1.0.0"
    }
  }
}
```

## 最佳实践

### 1. 错误处理

```typescript
export async function activate(context: PluginContext): Promise<void> {
  try {
    // 你的代码
  } catch (error) {
    context.log(`Error: ${error.message}`, 'error');
    window.zion.window.showErrorMessage(`Plugin error: ${error.message}`);
  }
}
```

### 2. 资源管理

```typescript
// 总是将 disposable 添加到 subscriptions
const disposable = window.zion.commands.registerCommand('myplugin.command', handler);
context.subscriptions.push(disposable);
```

### 3. 配置验证

```typescript
const timeout = context.configuration.get<number>('myplugin.timeout', 5000);
if (timeout < 0 || timeout > 60000) {
  throw new Error('Timeout must be between 0 and 60000');
}
```

### 4. 性能优化

```typescript
// 使用异步操作
export async function activate(context: PluginContext): Promise<void> {
  const data = await fetchData();
  processData(data);
}
```

### 5. 用户反馈

```typescript
window.zion.window.showInformationMessage('Operation completed');
window.zion.window.showWarningMessage('This requires setup');
window.zion.window.showErrorMessage('Failed: Permission denied');
```

## 测试

### 单元测试

```typescript
// test/main.test.ts
import { activate } from '../src/main';

describe('My Plugin', () => {
  test('should activate without errors', async () => {
    const mockContext = createMockContext();
    await expect(activate(mockContext)).resolves.not.toThrow();
  });
});
```

### 集成测试

```typescript
// test/integration.test.ts
test('should register commands', async () => {
  const mockRegister = jest.spyOn(window.zion.commands, 'registerCommand');
  const context = createMockContext();
  
  await activate(context);
  
  expect(mockRegister).toHaveBeenCalledWith('myplugin.hello', expect.any(Function));
});
```

## 调试

### 开发模式

1. 打开浏览器开发者工具
2. 查看控制台输出
3. 使用断点调试
4. 检查网络请求

### 日志记录

```typescript
// 不同级别的日志
context.log('Debug info', 'debug');
context.log('General info', 'info');
context.log('Warning message', 'warn');
context.log('Error occurred', 'error');
```

## 发布

### 打包插件

```bash
npm run build
npm pack
```

### 发布到插件市场

1. 创建插件包
2. 上传到插件市场
3. 填写插件信息
4. 等待审核

## 故障排除

### 常见问题

1. **插件不加载**
   - 检查 manifest.json 语法
   - 验证文件路径
   - 查看控制台错误

2. **命令不工作**
   - 确认命令已注册
   - 检查命令ID
   - 验证快捷键冲突

3. **配置不生效**
   - 检查属性名称
   - 验证监听器设置
   - 确认值有效

### 调试技巧

1. 使用 `console.log()` 输出调试信息
2. 检查浏览器控制台错误
3. 使用开发者工具断点调试
4. 验证插件清单格式

## 示例插件

### 代码片段插件

```typescript
export async function activate(context: PluginContext): Promise<void> {
  const snippets = {
    'function': 'function name() {\n  \n}',
    'class': 'class Name {\n  constructor() {\n  }\n}'
  };

  for (const [name, code] of Object.entries(snippets)) {
    const disposable = window.zion.commands.registerCommand(`snippets.${name}`, () => {
      const editor = window.zion.window.activeEditor;
      if (editor) {
        editor.replaceSelection(code);
      }
    });
    context.subscriptions.push(disposable);
  }
}
```

### 文件模板插件

```typescript
export async function activate(context: PluginContext): Promise<void> {
  const disposable = window.zion.commands.registerCommand('templates.newFile', async () => {
    const templates = ['JavaScript', 'TypeScript', 'Markdown'];
    const selected = await window.zion.window.showQuickPick(templates);
    
    if (selected) {
      const content = getTemplateContent(selected);
      const editor = window.zion.window.activeEditor;
      if (editor) {
        editor.setValue(content);
      }
    }
  });
  
  context.subscriptions.push(disposable);
}

function getTemplateContent(type: string): string {
  const templates = {
    'JavaScript': '// JavaScript file\nconsole.log("Hello World");',
    'TypeScript': '// TypeScript file\nconsole.log("Hello World");',
    'Markdown': '# Markdown file\n\nHello World'
  };
  
  return templates[type] || '';
}
```

## 资源

### 官方文档
- [Zion Next 插件系统](https://zion-next.dev/docs/plugins)
- [API 参考](https://zion-next.dev/docs/api)
- [示例插件](https://github.com/zion-next/examples)

### 社区资源
- [插件市场](https://marketplace.zion-next.dev)
- [开发者论坛](https://forum.zion-next.dev)
- [Discord 社区](https://discord.gg/zion-next)

### 工具
- [插件模板](https://github.com/zion-next/plugin-template)
- [开发工具](https://github.com/zion-next/dev-tools)
- [调试器](https://github.com/zion-next/debugger)

## 更新日志

### v1.0.0
- 初始版本发布
- 基础插件开发指南
- API 参考文档
- 最佳实践

---
*最后更新：2024年1月*
*版本：1.0.0*