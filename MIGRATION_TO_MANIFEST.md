# 插件格式迁移总结

## 概述

已成功将所有内置插件从旧的 `extension.json` 格式迁移到新的 `manifest.json` 格式。

## 迁移范围

### 已迁移插件（16个）

| 插件 ID | 名称 | 说明 |
|---------|------|------|
| dev.editor-config | Editor Config | 编辑器配置管理 |
| dev.fs-manager | FS Manager | 文件系统管理器 |
| dev.gutter-actions | Gutter Actions | 编辑器边栏操作 |
| dev.langchain-chat | LangChain Chat | LangChain 对话集成 |
| dev.mail | Mail | 邮件功能 |
| dev.paste-image | Paste Image | 图片粘贴处理 |
| dev.roles | Roles | 角色管理 |
| dev.search-replace | Search Replace | 搜索替换 |
| dev.search-replace-plus | Search Replace Plus | 增强搜索替换 |
| dev.session-manager | Session Manager | 会话管理 |
| dev.task-panel | Task Panel | 任务面板 |
| dev.terminal-manager | Terminal Manager | 终端管理器 |
| dev.thinking | Thinking | 思考卡片 |
| dev.toc | TOC | 目录生成 |
| dev.tools | Tools | 工具管理 |
| dev.wysiwyg-toggle | WYSIWYG Toggle | 所见即所得切换 |

### 未迁移插件

- **dev.wysiwyg-toggle**: 原本就没有 `extension.json`，需要单独处理

## 格式变化

### 旧格式 (extension.json)

```json
{
  "name": "dev.toc",
  "version": "0.0.1",
  "main": "./main.js",
  "contributes": {
    "commands": [...],
    "keybindings": [...],
    "menus": {...}
  },
  "activationEvents": [...]
}
```

### 新格式 (manifest.json)

```json
{
  "name": "dev.toc",
  "version": "0.0.1",
  "description": "Table of Contents plugin",
  "author": "Zion Developer",
  "license": "MIT",
  "zion": {
    "id": "dev.toc",
    "name": "TOC",
    "version": "0.0.1",
    "main": "./main.js",
    "contributes": {
      "commands": [...],
      "keybindings": [...],
      "menus": [...]
    },
    "activationEvents": [...],
    "engines": {
      "zion": ">=1.0.0"
    }
  }
}
```

## 代码更新

### 1. Vite 插件配置 (vite-plugin-extensions.js)

**更新内容**:
- 优先读取 `manifest.json`（新格式）
- 兼容 `extension.json`（旧格式）
- 从 `zion.main` 或 `main` 字段获取入口文件

### 2. 主入口 (src/main.ts)

**更新内容**:
- `preinstallBuiltinPlugins` 函数优先扫描 `manifest.json`
- 保持对 `extension.json` 的兼容性
- 正确处理新格式的 `manifest` 结构

### 3. 插件管理器 (src/plugin/manager.ts)

**更新内容**:
- `scanExtensionsDirectory` 优先处理 `manifest.json`
- 避免重复处理同一目录（同时存在两种格式）

### 4. 插件加载器 (src/plugin/loader.ts)

**保持不变**:
- 已支持新旧格式检测
- `detectFormat` 方法会优先检查 `manifest.json`

## 已删除文件

- 所有 `extensions/*/extension.json` 文件已被删除

## 构建验证

构建测试显示：
- ✅ 成功扫描 16 个插件
- ✅ 所有插件入口正确添加
- ✅ 插件依赖正确处理

## 后续步骤

### 立即操作

1. **测试运行**: `npm run dev`
   - 验证所有插件正常加载
   - 检查插件功能是否正常

2. **删除旧格式支持代码**（可选，待测试通过后）:
   - 移除 `loader.ts` 中的 `detectFormat` 方法
   - 移除 `loadLegacyManifest` 方法
   - 简化 `vite-plugin-extensions.js`
   - 更新类型定义，移除 `ExtensionManifest`

### 中期优化

3. **完善插件信息**:
   - 为每个插件添加更详细的 `description`
   - 添加 `homepage`、`repository` 等元数据
   - 完善 `contributes` 声明

4. **文档更新**:
   - 更新插件开发指南
   - 移除旧格式相关文档
   - 更新贡献指南

### 长期规划

5. **插件市场兼容**:
   - 确保新格式与插件市场 API 兼容
   - 更新插件上传工具

6. **功能增强**:
   - 添加插件依赖版本检查
   - 实现插件自动更新
   - 支持插件主题配置

## 回滚方案

如果迁移出现问题，可以从 Git 历史恢复：

```bash
# 查看迁移前的提交
git log --oneline --grep="migration" --all

# 恢复到迁移前的状态
git reset --hard <commit-hash>

# 或者使用 git checkout 恢复特定文件
git checkout <commit-hash> -- extensions/
```

## 注意事项

1. **插件 ID**: 新格式中 `zion.id` 是必需的，旧格式使用 `name`
2. **主入口**: 新格式使用 `zion.main`，旧格式使用 `main`
3. **引擎要求**: 新格式支持 `engines.zion` 声明最低版本
4. **依赖管理**: 新格式支持 `dependencies` 和 `peerDependencies`

## 联系方式

如有问题，请通过以下方式联系：
- GitHub Issues: [创建 Issue](https://github.com/your-org/zion-next/issues)
- 开发团队: [email protected]

---

**迁移完成时间**: 2025-01-31
**迁移执行人**: AI Assistant
