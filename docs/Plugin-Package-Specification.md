# 插件包规范

## 概述

本文档定义了 Zion-Next 插件的包格式规范。插件包是一个独立的目录或压缩包，包含插件代码、资源和元数据。

## 包结构

```
my-plugin/
├── package.json              # npm 包元数据（可选）
├── manifest.json            # Zion 插件清单（必需）
├── README.md                # 插件文档
├── LICENSE                  # 许可证文件
├── dist/                    # 构建输出目录
│   └── main.js             # 插件入口文件
├── src/                     # 源代码目录
│   ├── main.ts             # 插件入口源代码
│   └── components/         # 插件组件
├── assets/                  # 静态资源
│   ├── icon.png            # 插件图标
│   └── screenshot.png      # 插件截图
└── locales/                 # 国际化文件
    ├── en.json
    └── zh-CN.json
```

## 清单文件 (manifest.json)

清单文件是插件的核心配置文件，定义了插件的基本信息和功能贡献。

### 基本字段

```json
{
  "zion": {
    "id": "com.example.myplugin",          // 插件唯一标识符
    "name": "我的插件",                    // 插件显示名称
    "version": "1.0.0",                    // 插件版本
    "description": "插件功能描述",         // 插件描述
    "author": "作者名 <email@example.com>", // 作者信息
    "license": "MIT",                      // 许可证
    "homepage": "https://example.com",     // 主页链接
    "repository": {                        // 代码仓库
      "type": "git",
      "url": "https://github.com/example/my-plugin"
    },
    "bugs": {                              // 问题反馈
      "url": "https://github.com/example/my-plugin/issues"
    }
  }
}
```

### 运行时配置

```json
{
  "zion": {
    "main": "./dist/main.js",              // 插件入口文件
    "activationEvents": [                  // 激活事件
      "onStartupFinished",
      "onCommand:myplugin.hello",
      "onView:myplugin.panel"
    ],
    "engines": {                           // 引擎要求
      "zion": ">=0.1.0"
    },
    "dependencies": {                      // 插件依赖
      "com.example.otherplugin": "^1.0.0"
    },
    "peerDependencies": {                  // 对等依赖
      "zion-core-feature": "*"
    },
    "optionalDependencies": {              // 可选依赖
      "com.example.optional": "^1.0.0"
    }
  }
}
```

### 功能贡献

```json
{
  "zion": {
    "contributes": {
      "commands": [                        // 命令贡献
        {
          "id": "myplugin.hello",
          "title": "Say Hello",
          "category": "My Plugin",
          "icon": "icon-smile"
        }
      ],
      "keybindings": [                     // 快捷键贡献
        {
          "command": "myplugin.hello",
          "key": "ctrl+shift+h",
          "when": "editorFocus"
        }
      ],
      "menus": [                           // 菜单贡献
        {
          "id": "editor/context",
          "command": "myplugin.hello",
          "title": "Say Hello",
          "when": "editorFocus"
        }
      ],
      "views": [                           // 视图贡献
        {
          "id": "myplugin.panel",
          "title": "My Panel",
          "type": "sidebar",
          "icon": "icon-panel",
          "component": "./dist/panel.js"
        }
      ],
      "themes": [                          // 主题贡献
        {
          "id": "myplugin-theme",
          "label": "My Theme",
          "uiTheme": "vs-dark",
          "path": "./themes/my-theme.json"
        }
      ],
      "languages": [                       // 语言贡献
        {
          "id": "myplugin-lang",
          "extensions": [".mylang"],
          "aliases": ["My Language"],
          "configuration": "./language-configuration.json"
        }
      ],
      "configuration": {                   // 配置贡献
        "title": "My Plugin",
        "properties": {
          "myplugin.enabled": {
            "type": "boolean",
            "default": true,
            "description": "启用插件功能"
          }
        }
      }
    }
  }
}
```

## 插件入口文件

插件入口文件必须导出一个 `activate` 函数和一个可选的 `deactivate` 函数。

### TypeScript 类型定义

```typescript
interface ExtensionContext {
  subscriptions: Disposable[];
  extensionPath: string;
  globalState: Memento;
  workspaceState: Memento;
  asAbsolutePath(relativePath: string): string;
}

interface Disposable {
  dispose(): void;
}

interface Memento {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: any): Promise<void>;
}

export async function activate(context: ExtensionContext): Promise<void> {
  // 插件激活逻辑
}

export async function deactivate(): Promise<void> {
  // 插件停用逻辑
}
```

### JavaScript 示例

```javascript
export async function activate(ctx) {
  // 注册命令
  const commandDisposable = window.zion.commands.registerCommand(
    'myplugin.hello',
    () => {
      window.zion.window.showInformationMessage('Hello from My Plugin!');
    }
  );
  ctx.subscriptions.push(commandDisposable);

  // 注册视图
  const viewDisposable = window.zion.views.registerView({
    id: 'myplugin.panel',
    title: 'My Panel',
    component: MyPanelComponent
  });
  ctx.subscriptions.push(viewDisposable);

  console.log('My Plugin activated');
}

export async function deactivate() {
  console.log('My Plugin deactivated');
}
```

## 包元数据文件 (package.json)

虽然 `manifest.json` 是必需的，但建议同时包含 `package.json` 以便与 npm 生态系统兼容。

```json
{
  "name": "zion-myplugin",
  "version": "1.0.0",
  "description": "My Zion Plugin",
  "main": "dist/main.js",
  "zion": "./manifest.json",
  "scripts": {
    "build": "tsc",
    "watch": "tsc --watch",
    "package": "zion-plugin package",
    "publish": "zion-plugin publish"
  },
  "keywords": ["zion", "plugin"],
  "author": "Author Name",
  "license": "MIT",
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/node": "^18.0.0"
  },
  "peerDependencies": {
    "zion-next": ">=0.1.0"
  }
}
```

## 向后兼容格式

为了支持现有的插件格式，系统会自动检测并转换旧格式。

### 旧格式检测

```json
{
  "name": "dev.myplugin",
  "version": "0.0.1",
  "main": "./main.js",
  "contributes": {
    "commands": [{ "id": "myplugin.hello", "title": "Say Hello" }]
  },
  "activationEvents": ["onStartupFinished"]
}
```

### 自动转换规则

1. `name` → `zion.id` (添加 `dev.` 前缀)
2. `main` → `zion.main`
3. `contributes` → `zion.contributes`
4. `activationEvents` → `zion.activationEvents`

## 包签名和验证

### 签名文件

插件包可以包含签名文件以确保完整性：

```
my-plugin/
├── manifest.json
├── manifest.json.sig      # 清单文件签名
└── package.sha256         # 包完整性校验
```

### 签名格式

```json
{
  "signature": "base64-encoded-signature",
  "certificate": "base64-encoded-certificate",
  "timestamp": "2024-01-01T00:00:00Z"
}
```

## 包分发格式

### 目录格式（开发模式）
```
~/.zion/plugins/com.example.myplugin-1.0.0/
```

### 压缩包格式（分发）
```
my-plugin-1.0.0.zionplugin
```

### 压缩包结构
```
my-plugin-1.0.0.zionplugin
├── manifest.json
├── dist/
│   └── main.js
└── assets/
    └── icon.png
```

## 版本管理

### 版本号规范
遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)：
- `MAJOR`：不兼容的 API 修改
- `MINOR`：向下兼容的功能性新增
- `PATCH`：向下兼容的问题修正

### 版本兼容性
- `^1.2.3`：兼容 1.x.x (>=1.2.3 <2.0.0)
- `~1.2.3`：兼容 1.2.x (>=1.2.3 <1.3.0)
- `1.2.3`：精确版本

## 国际化支持

### 语言文件结构
```
locales/
├── en.json
├── zh-CN.json
└── ja.json
```

### 语言文件格式
```json
{
  "plugin.name": "My Plugin",
  "command.hello.title": "Say Hello",
  "view.panel.title": "My Panel"
}
```

### 清单中的国际化
```json
{
  "zion": {
    "name": "%plugin.name%",
    "description": "%plugin.description%",
    "contributes": {
      "commands": [{
        "id": "myplugin.hello",
        "title": "%command.hello.title%"
      }]
    }
  }
}
```

## 最佳实践

### 1. 文件组织
- 将源代码放在 `src/` 目录
- 将构建输出放在 `dist/` 目录
- 将资源文件放在 `assets/` 目录
- 将国际化文件放在 `locales/` 目录

### 2. 命名规范
- 插件 ID：使用反向域名格式 `com.example.myplugin`
- 命令 ID：使用 `pluginId.commandName` 格式
- 视图 ID：使用 `pluginId.viewName` 格式

### 3. 错误处理
- 在激活函数中处理异步错误
- 提供有意义的错误信息
- 实现优雅降级

### 4. 性能优化
- 懒加载大型资源
- 使用代码分割
- 避免阻塞主线程

### 5. 安全性
- 验证用户输入
- 限制文件系统访问
- 使用内容安全策略

## 示例插件

完整的示例插件可以在以下位置找到：
- [示例插件仓库](https://github.com/zion-next/example-plugin)
- [插件模板](https://github.com/zion-next/plugin-template)

## 工具支持

### 插件开发工具
```bash
# 创建新插件
npx create-zion-plugin my-plugin

# 构建插件
npm run build

# 打包插件
npx zion-plugin package

# 发布插件
npx zion-plugin publish
```

### VS Code 扩展
- Zion Plugin Development Tools
- Zion Manifest Language Support

## 常见问题

### Q: 插件必须包含哪些文件？
A: 必须包含 `manifest.json` 和入口文件（由 `zion.main` 指定）。

### Q: 如何调试插件？
A: 使用开发者工具的控制台，或使用专门的插件调试器。

### Q: 插件可以访问哪些 API？
A: 插件只能访问通过 `window.zion` 暴露的公共 API。

### Q: 如何更新插件？
A: 通过插件管理器或命令行工具更新。

### Q: 插件有大小限制吗？
A: 建议插件包大小不超过 10MB。

## 更新日志

### v1.0.0 (2024-01-01)
- 初始版本发布
- 定义基本包格式
- 添加向后兼容支持

---
*最后更新：2024年1月*
*版本：1.0.0*