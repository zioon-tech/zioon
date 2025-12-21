# 插件迁移指南

## 概述

本指南帮助你将现有的 Zion Next 扩展迁移到新的插件系统。新的插件系统提供了更好的隔离性、版本管理和分发机制。

## 迁移概述

### 主要变化

1. **清单格式**: 从 `extension.json` 改为 `manifest.json`
2. **插件ID**: 更严格的命名规范
3. **包结构**: 标准化的目录结构
4. **类型系统**: 完整的 TypeScript 支持
5. **依赖管理**: 显式依赖声明
6. **配置系统**: 增强的配置管理

### 向后兼容

新的插件系统保持向后兼容，现有的扩展可以继续工作，但建议迁移以获得新功能。

## 迁移步骤

### 步骤 1: 创建新的插件结构

```bash
# 创建新的插件目录
mkdir my-plugin-new
cd my-plugin-new

# 复制现有扩展文件
cp -r ../extensions/dev.my-extension/* .
```

### 步骤 2: 转换清单文件

**旧的 extension.json:**
```json
{
  "name": "dev.my-extension",
  "version": "0.0.1",
  "main": "./main.js",
  "contributes": {
    "commands": [
      { "id": "myext.hello", "title": "Say Hello" }
    ]
  },
  "activationEvents": ["onStartupFinished"]
}
```

**新的 manifest.json:**
```json
{
  "name": "zion-my-extension",
  "version": "1.0.0",
  "description": "My Zion extension",
  "author": "Your Name",
  "license": "MIT",
  "zion": {
    "id": "com.example.myextension",
    "name": "My Extension",
    "version": "1.0.0",
    "description": "My Zion extension",
    "main": "./dist/main.js",
    "categories": ["productivity"],
    "activationEvents": ["onStartupFinished"],
    "engines": {
      "zion": ">=0.1.0"
    },
    "contributes": {
      "commands": [
        {
          "id": "myext.hello",
          "title": "Say Hello",
          "category": "My Extension"
        }
      ]
    }
  }
}
```

### 步骤 3: 更新主文件

**旧的 main.js:**
```javascript
export async function activate(ctx) {
  const d1 = window.zion.commands.registerCommand("myext.hello", () => {
    const ed = window.zion.window.activeEditor;
    if (!ed) return;
    ed.replaceSelection("Hello!");
  });
  ctx.subscriptions.push(d1);
}
```

**新的 src/main.ts:**
```typescript
import type { PluginContext } from '../types/plugin';

export async function activate(context: PluginContext): Promise<void> {
  const disposable = window.zion.commands.registerCommand('myext.hello', () => {
    const editor = window.zion.window.activeEditor;
    if (!editor) return;
    editor.replaceSelection('Hello!');
  });
  
  context.subscriptions.push(disposable);
}

export async function deactivate(): Promise<void> {
  // 清理逻辑
}
```

### 步骤 4: 添加 TypeScript 配置

**tsconfig.json:**
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "node",
    "lib": ["ES2020", "DOM"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*", "types/**/*"]
}
```

### 步骤 5: 更新 package.json

```json
{
  "name": "zion-my-extension",
  "version": "1.0.0",
  "description": "My Zion extension",
  "main": "dist/main.js",
  "zion": "./manifest.json",
  "scripts": {
    "build": "tsc",
    "watch": "tsc --watch",
    "clean": "rm -rf dist"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/node": "^18.0.0"
  },
  "peerDependencies": {
    "zion-next": ">=0.1.0"
  }
}
```

### 步骤 6: 添加类型定义

**types/plugin.ts:**
```typescript
export interface PluginContext {
  subscriptions: Disposable[];
  extensionPath: string;
  globalState: Memento;
  workspaceState: Memento;
  configuration: PluginConfigurationManager;
  asAbsolutePath(relativePath: string): string;
  log(message: string, level?: 'info' | 'warn' | 'error'): void;
}

export interface Disposable {
  dispose(): void;
}

export interface Memento {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: any): Promise<void>;
}

export interface PluginConfigurationManager {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: any): Promise<void>;
  onDidChange<T>(key: string, callback: (value: T | undefined) => void): Disposable;
}
```

## 详细迁移指南

### 清单文件迁移

#### 字段映射

| 旧字段 | 新字段 | 说明 |
|--------|--------|------|
| `name` | `zion.id` | 需要符合新ID格式 |
| `version` | `zion.version` | 版本号格式相同 |
| `main` | `zion.main` | 路径可能需要更新 |
| `contributes` | `zion.contributes` | 结构增强 |
| `activationEvents` | `zion.activationEvents` | 事件类型扩展 |

#### ID 格式转换

旧格式：
```json
{
  "name": "dev.my-extension"
}
```

新格式：
```json
{
  "zion": {
    "id": "com.example.myextension"
  }
}
```

### 代码迁移

#### 激活函数

旧格式：
```javascript
export async function activate(ctx) {
  // 代码
}
```

新格式：
```typescript
export async function activate(context: PluginContext): Promise<void> {
  // 代码
}
```

#### 停用函数

旧格式：
```javascript
// 可选的停用函数
```

新格式：
```typescript
export async function deactivate(): Promise<void> {
  // 清理代码
}
```

#### 资源管理

旧格式：
```javascript
ctx.subscriptions.push(disposable);
```

新格式：
```typescript
context.subscriptions.push(disposable);
```

### API 使用迁移

#### 命令注册

旧格式：
```javascript
window.zion.commands.registerCommand("myext.command", handler);
```

新格式：
```typescript
window.zion.commands.registerCommand('myext.command', handler);
```

#### 状态存储

旧格式：
```javascript
// 使用 localStorage 直接
localStorage.setItem('myext.data', JSON.stringify(data));
```

新格式：
```typescript
// 使用插件状态存储
await context.globalState.update('data', data);
```

#### 配置管理

旧格式：
```javascript
// 手动管理配置
const config = JSON.parse(localStorage.getItem('myext.config') || '{}');
```

新格式：
```typescript
// 使用配置管理器
const enabled = context.configuration.get<boolean>('myext.enabled', true);
```

## 自动化迁移工具

### 使用迁移工具

我们提供了一个自动化迁移工具：

```bash
# 迁移单个扩展
npx zion-plugin migrate ./extensions/dev.my-extension ./plugins/

# 批量迁移
npx zion-plugin migrate-all ./extensions ./plugins/

# 验证迁移结果
npx zion-plugin validate ./plugins/my-plugin
```

### 迁移工具功能

1. **自动转换清单文件**
2. **更新代码结构**
3. **添加类型定义**
4. **生成配置文件**
5. **验证迁移结果**

### 手动迁移检查清单

- [ ] 创建 manifest.json
- [ ] 更新插件ID格式
- [ ] 转换激活函数签名
- [ ] 添加停用函数
- [ ] 更新类型导入
- [ ] 添加 TypeScript 配置
- [ ] 更新 package.json
- [ ] 添加类型定义文件
- [ ] 测试插件功能
- [ ] 验证清单格式

## 常见迁移问题

### 问题 1: ID 格式无效

**错误**: `插件ID格式无效`

**解决**: 确保ID只包含小写字母、数字、点和连字符：
```json
{
  "zion": {
    "id": "com.example.myplugin"
  }
}
```

### 问题 2: 缺少类型定义

**错误**: `找不到类型定义`

**解决**: 添加类型导入：
```typescript
import type { PluginContext } from '../types/plugin';
```

### 问题 3: 激活函数签名错误

**错误**: `activate 函数签名不匹配`

**解决**: 更新函数签名：
```typescript
export async function activate(context: PluginContext): Promise<void> {
  // 代码
}
```

### 问题 4: 清单验证失败

**错误**: `清单验证失败`

**解决**: 使用验证工具检查清单格式：
```bash
npx zion-plugin validate ./my-plugin
```

### 问题 5: 依赖缺失

**错误**: `缺少依赖`

**解决**: 在 manifest.json 中声明依赖：
```json
{
  "zion": {
    "dependencies": {
      "com.example.dependency": "^1.0.0"
    }
  }
}
```

## 迁移最佳实践

### 1. 逐步迁移

不要一次性迁移所有功能：
1. 先迁移基本结构
2. 然后迁移核心功能
3. 最后迁移高级功能

### 2. 保持向后兼容

在迁移期间：
1. 保留旧扩展的副本
2. 测试新旧版本的功能
3. 确保用户数据不丢失

### 3. 充分测试

迁移后：
1. 测试所有命令
2. 验证快捷键
3. 检查配置功能
4. 测试错误处理

### 4. 更新文档

迁移完成后：
1. 更新 README
2. 更新 API 文档
3. 添加迁移说明
4. 更新版本信息

## 性能优化

### 代码优化

1. **使用异步操作**:
```typescript
// Good
export async function activate(context: PluginContext): Promise<void> {
  const data = await loadData();
  processData(data);
}

// Bad
export function activate(context: PluginContext): void {
  const data = loadDataSync(); // 阻塞主线程
  processData(data);
}
```

2. **延迟加载**:
```typescript
let heavyModule: any;

export async function activate(context: PluginContext): Promise<void> {
  const disposable = window.zion.commands.registerCommand('myplugin.heavy', async () => {
    if (!heavyModule) {
      heavyModule = await import('./heavy-module');
    }
    heavyModule.doWork();
  });
  context.subscriptions.push(disposable);
}
```

3. **资源清理**:
```typescript
export async function deactivate(): Promise<void> {
  // 清理定时器
  if (timer) {
    clearInterval(timer);
  }
  
  // 清理事件监听器
  // 这些会被 context.subscriptions 自动处理
}
```

### 配置优化

1. **合理的默认值**:
```json
{
  "zion": {
    "contributes": {
      "configuration": {
        "properties": {
          "myplugin.timeout": {
            "type": "number",
            "default": 5000,
            "minimum": 1000,
            "maximum": 30000
          }
        }
      }
    }
  }
}
```

2. **配置验证**:
```typescript
const timeout = context.configuration.get<number>('myplugin.timeout', 5000);
if (timeout < 1000 || timeout > 30000) {
  context.log('Invalid timeout value, using default', 'warn');
  // 使用默认值
}
```

## 安全考虑

### 1. 输入验证

```typescript
export async function activate(context: PluginContext): Promise<void> {
  const disposable = window.zion.commands.registerCommand('myplugin.process', (input: string) => {
    // 验证输入
    if (!input || typeof input !== 'string') {
      window.zion.window.showErrorMessage('Invalid input');
      return;
    }
    
    // 处理输入
    processInput(input);
  });
  context.subscriptions.push(disposable);
}
```

### 2. 资源访问

```typescript
// 限制文件访问
const allowedPaths = ['/config', '/data'];
function validatePath(path: string): boolean {
  return allowedPaths.some(allowed => path.startsWith(allowed));
}
```

### 3. 网络请求

```typescript
// 验证URL
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}
```

## 迁移后的优化

### 1. 使用新功能

迁移后可以使用的增强功能：
- 增强的配置系统
- 改进的错误处理
- 更好的性能监控
- 增强的安全性

### 2. 代码重构

考虑重构代码以：
- 提高可维护性
- 增强性能
- 改善用户体验
- 添加新功能

### 3. 文档更新

更新文档以反映：
- 新的安装过程
- 增强的功能
- 配置选项
- 使用示例

## 支持

如果在迁移过程中遇到问题：

1. **查看错误日志**: 浏览器控制台
2. **使用验证工具**: `npx zion-plugin validate`
3. **参考示例**: 查看迁移示例
4. **寻求帮助**: 社区论坛
5. **报告问题**: GitHub Issues

## 迁移检查清单

### 迁移前
- [ ] 备份现有扩展
- [ ] 了解新系统要求
- [ ] 准备迁移工具
- [ ] 规划迁移步骤

### 迁移中
- [ ] 转换清单文件
- [ ] 更新代码结构
- [ ] 添加类型定义
- [ ] 配置构建系统
- [ ] 测试基本功能

### 迁移后
- [ ] 验证所有功能
- [ ] 测试错误处理
- [ ] 更新文档
- [ ] 发布新版本
- [ ] 通知用户

---
*最后更新：2024年1月*
*版本：1.0.0*