# 插件开发指南变更摘要

> 最后更新：2025-01-09

## 核心变更

### 1. 插件清单格式更新（重大变更）

#### 旧格式（已废弃）
```json
{
  "id": "my.plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "main": "./main.js",
  "contributes": { ... },
  "activationEvents": [ ... ]
}
```

#### 新格式（推荐）
```json
{
  "name": "my.plugin",
  "version": "1.0.0",
  "zion": {
    "id": "my.plugin",
    "name": "My Plugin",
    "version": "1.0.0",
    "main": "./main.js",
    "contributes": { ... },
    "activationEvents": [ ... ],
    "dependencies": {},
    "engines": { "zion": ">=1.0.0" }
  }
}
```

**关键变化**：
- 文件名从 `extension.json` 改为 `manifest.json`
- 所有插件配置现在嵌套在 `zion` 字段中
- 新增 `dependencies`、`engines` 等字段
- 支持在 `package.json` 中嵌入 `zion` 字段

---

### 2. 插件安装方式

#### 新增安装方式

1. **从 HTTP 服务安装**
   ```javascript
   await window.zion.plugins.installFromService({
     baseUrl: 'http://127.0.0.1:8765',
     pluginId: 'my-plugin',
     manifestUrl: '/plugins/my-plugin/manifest.json'
   }, { enabled: true });
   ```

2. **开发模式安装（支持热重载）**
   ```javascript
   await window.zion.plugins.installFromDevBase(
     'http://127.0.0.1:8765/plugins/dev/{devId}',
     '{devId}'
   );
   ```

3. **从 ZIP 文件安装（拖拽）**
   ```javascript
   await window.zion.plugins.installFromFile(file);
   ```

#### 保留方式

- 内置扩展（`extensions/` 目录）：自动扫描加载

---

### 3. 新增 API

#### 模型提供者 API
```javascript
window.zion.models.registerProvider({
  id: 'my.models',
  async list() {
    return [
      { id: 'my.model.gpt4', label: 'My GPT-4' }
    ];
  },
  async resolve(modelId) {
    return { id: modelId, baseUrl: '...', apiKey: '...' };
  }
});
```

#### 主题切换 API
```javascript
// 切换主题
window.zion.commands.executeCommand('zion.toggleTheme');

// 设置主题
window.zion.commands.executeCommand('zion.setTheme', 'light');
window.zion.commands.executeCommand('zion.setTheme', 'dark');
```

#### 编辑器配置 API
```javascript
// 行号
window.zion.commands.executeCommand('zion.toggleLineNumbers');
window.zion.commands.executeCommand('zion.setLineNumbers', true);

// 语法高亮
window.zion.commands.executeCommand('zion.toggleSyntaxHighlight');
window.zion.commands.executeCommand('zion.setSyntaxHighlight', true);

// 自动缩进
window.zion.commands.executeCommand('zion.toggleAutoIndent');
window.zion.commands.executeCommand('zion.setAutoIndent', true);

// 活动行高亮
window.zion.commands.executeCommand('zion.toggleActiveLineHighlight');
window.zion.commands.executeCommand('zion.setActiveLineHighlight', true);

// 折叠
window.zion.commands.executeCommand('zion.toggleFolding');
window.zion.commands.executeCommand('zion.setFolding', true);

// 行包装
window.zion.commands.executeCommand('zion.toggleLineWrap');
window.zion.commands.executeCommand('zion.setLineWrap', true);
```

#### WYSIWYG 模式 API
```javascript
// 切换 WYSIWYG 模式
window.zion.commands.executeCommand('zion.toggleWysiwyg');

// 设置 WYSIWYG 模式
window.zion.commands.executeCommand('zion.setWysiwyg', true);
window.zion.commands.executeCommand('zion.setWysiwyg', false);
```

---

### 4. 新的 `when` 条件

```javascript
{
  "command": "my.command",
  "key": "Mod-Shift-M",
  "when": "searchReplaceVisible"  // 搜索/替换面板可见时
}
```

支持的 `when` 条件：
- `editorFocus` - 编辑器聚焦时
- `hasSelection` - 有选区时
- `searchReplaceVisible` - 搜索/替换面板可见时（新增）

---

### 5. 新增扩展示例

- `dev.langchain-chat` - 基于 LangChain 的真实流式对话
- `dev.search-replace` - VS Code 风格搜索替换
- `dev.minimap` - 右侧缩略图
- `dev.toc` - Markdown 目录导航
- `dev.wysiwyg-toggle` - WYSIWYG 模式切换
- `dev.editor-config` - 编辑器配置管理

---

### 6. 开发模式改进

#### 新的开发模式工作流

1. **启动开发会话**（通过 Zion Local Tools）
   ```bash
   curl -X POST http://127.0.0.1:8765/plugins/dev/start \
     -H "Content-Type: application/json" \
     -d '{"path": "/path/to/your/plugin"}'
   ```

2. **安装开发中的插件**
   ```javascript
   await window.zion.plugins.installFromDevBase(
     'http://127.0.0.1:8765/plugins/dev/{devId}',
     '{devId}'
   );
   ```

3. **自动热重载**
   - 修改文件后自动检测并重新加载
   - 通过 WebSocket 推送更新通知
   - 无需手动停止/重启

4. **停止开发会话**
   ```bash
   curl -X POST http://127.0.0.1:8765/plugins/dev/stop \
     -H "Content-Type: application/json" \
     -d '{"devId": "{devId}"}'
   ```

---

## 迁移指南

### 从旧版清单格式迁移

#### 步骤 1：重命名清单文件
```bash
mv extension.json manifest.json
```

#### 步骤 2：更新清单内容

**旧格式**：
```json
{
  "id": "dev.my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "main": "./main.js",
  "contributes": { ... },
  "activationEvents": ["onStartupFinished"]
}
```

**新格式**：
```json
{
  "name": "dev.my-plugin",
  "version": "1.0.0",
  "zion": {
    "id": "dev.my-plugin",
    "name": "My Plugin",
    "version": "1.0.0",
    "main": "./main.js",
    "contributes": { ... },
    "activationEvents": ["onStartupFinished"],
    "engines": { "zion": ">=1.0.0" }
  }
}
```

#### 步骤 3：测试插件

1. 重启 Zion Next 或重新加载扩展
2. 在插件面板中查看插件状态
3. 测试插件功能是否正常

---

### 使用新 API 的示例

#### 使用主题切换
```javascript
export async function activate(ctx) {
  // 注册主题切换命令
  const command = window.zion.commands.registerCommand(
    'my.plugin.toggleTheme',
    () => {
      window.zion.commands.executeCommand('zion.toggleTheme');
    }
  );
  ctx.subscriptions.push(command);

  // 监听主题变化
  const themeDisposable = window.zion.state.onDidChange('ui.theme', (newTheme) => {
    console.log(`Theme changed to: ${newTheme}`);
  });
  ctx.subscriptions.push(themeDisposable);
}
```

#### 使用编辑器配置
```javascript
export async function activate(ctx) {
  // 切换行号
  const lineNumbersCmd = window.zion.commands.registerCommand(
    'my.plugin.toggleLineNumbers',
    () => {
      window.zion.commands.executeCommand('zion.toggleLineNumbers');
    }
  );
  ctx.subscriptions.push(lineNumbersCmd);

  // 切换 WYSIWYG
  const wysiwygCmd = window.zion.commands.registerCommand(
    'my.plugin.toggleWysiwyg',
    () => {
      window.zion.commands.executeCommand('zion.toggleWysiwyg');
    }
  );
  ctx.subscriptions.push(wysiwygCmd);
}
```

#### 使用模型提供者
```javascript
export async function activate(ctx) {
  const provider = window.zion.models.registerProvider({
    id: 'my.models',
    async list() {
      return [
        { id: 'my.model.gpt4', label: 'My GPT-4' },
        { id: 'my.model.gpt3', label: 'My GPT-3' }
      ];
    },
    async resolve(modelId) {
      // 从配置中读取 API Key
      const apiKey = ctx.configuration.get('apiKey', '');
      return {
        id: modelId,
        baseUrl: 'https://api.myprovider.com',
        apiKey
      };
    }
  });
  ctx.subscriptions.push(provider);
}
```

---

## 兼容性说明

### 向后兼容

- **内置扩展**：`extensions/` 目录下的扩展仍然支持
- **旧版 API**：大部分 API 保持向后兼容
- **插件管理器**：支持新旧两种格式共存

### 废弃功能

- **`extension.json` 格式**：建议迁移到 `manifest.json` 格式
- **部分旧 API**：未来版本中可能会移除

### 推荐做法

1. 新插件使用新的 `manifest.json` 格式
2. 旧插件逐步迁移到新格式
3. 使用新的 API 以获得更好的功能支持
4. 关注 Changelog 了解最新变化

---

## 获取帮助

### 文档资源

- **最新开发指南**：`docs/Plugin-Development-Guide-LATEST.md`
- **原开发指南**：`docs/Plugin-Development-Guide.md`（已过时）
- **变更记录**：`docs/Changelog.md`
- **API 参考**：`docs/Extensions-API.md`

### 示例代码

查看 `extensions/` 目录下的内置扩展示例：
- `dev.tools` - 工具管理
- `dev.terminal-manager` - 终端管理
- `dev.wysiwyg-toggle` - WYSIWYG 切换
- `dev.editor-config` - 编辑器配置
- `dev.search-replace` - 搜索替换
- `dev.minimap` - 右侧缩略图
- `dev.toc` - 目录导航

### 联系方式

- **GitHub Issues**: https://github.com/your-org/zion-next/issues
- **Email**: support@example.com
- **Discord**: https://discord.gg/your-server

---

## 快速检查清单

迁移插件时，请确保：

- [ ] 清单文件重命名为 `manifest.json`
- [ ] 所有配置嵌套在 `zion` 字段中
- [ ] `main.js` 使用 ES6 模块语法（`export async function activate`）
- [ ] 测试所有插件功能是否正常
- [ ] 检查浏览器控制台是否有错误
- [ ] 验证插件状态（已安装、已启用、已激活）
- [ ] 测试插件安装/卸载/启用/禁用流程

---

## 总结

Zion Next 的插件系统经历了重大更新，主要包括：

1. **新的清单格式**（`manifest.json`）
2. **多种插件安装方式**（HTTP、ZIP、开发模式）
3. **新增 API**（模型提供者、主题、编辑器配置、WYSIWYG）
4. **改进的开发模式**（热重载）
5. **新的扩展示例**和 `when` 条件

建议所有插件开发者：
- 阅读最新版开发指南
- 将现有插件迁移到新格式
- 使用新 API 以获得更好的功能支持
- 关注项目 Changelog 了解最新变化

如有疑问，请参考示例代码或联系项目维护者。
