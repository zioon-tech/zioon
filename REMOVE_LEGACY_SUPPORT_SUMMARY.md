# 移除旧格式支持代码总结

## 已完成的工作

### 1. 删除所有旧格式文件
- ✅ 删除所有 `extensions/*/extension.json` 文件
- ✅ 保留所有 `extensions/*/manifest.json` 文件

### 2. 更新 Vite 插件配置
**文件**: `vite-plugin-extensions.js`
- ✅ 移除对 `extension.json` 的支持
- ✅ 仅支持 `manifest.json` 格式
- ✅ 从 `zion.main` 或 `main` 字段获取入口文件

### 3. 更新主入口文件
**文件**: `src/main.ts`
- ✅ 移除 `preinstallBuiltinPlugins` 中对 `extension.json` 的扫描
- ✅ 仅扫描 `manifest.json` 文件
- ✅ 简化插件信息构建逻辑

### 4. 更新插件管理器
**文件**: `src/plugin/manager.ts`
- ✅ 移除 `scanExtensionsDirectory` 中对 `extension.json` 的扫描
- ✅ 仅扫描 `manifest.json` 文件
- ✅ 简化目录扫描逻辑

### 5. 更新插件加载器
**文件**: `src/plugin/loader.ts`
- ✅ 移除 `detectFormat` 中对 `extension.json` 的检查
- ✅ 修改 `loadLegacyManifest` 抛出错误，提示使用新格式
- ✅ 修改验证逻辑，对旧格式返回错误信息

### 6. 更新类型定义
**文件**: `src/plugin/types.ts`
- ✅ 为 `ExtensionManifest` 接口添加注释说明已废弃

## 代码变化详情

### 移除的代码
1. **extension.json 扫描逻辑**:
   - `vite-plugin-extensions.js`: 移除对 `extension.json` 的检查
   - `src/main.ts`: 移除对 `extension.json` 的 glob 扫描
   - `src/plugin/manager.ts`: 移除对 `extension.json` 的扫描

2. **旧格式兼容逻辑**:
   - `src/plugin/loader.ts`: 移除 `detectFormat` 中的 `extension.json` 检查
   - `src/plugin/loader.ts`: 修改 `loadLegacyManifest` 抛出错误
   - `src/plugin/loader.ts`: 修改验证逻辑，对旧格式返回错误

### 保留的代码
1. **向后兼容**:
   - `src/plugin/loader.ts`: 保留 `detectFormat` 方法，但移除 `extension.json` 检查
   - `src/plugin/loader.ts`: 保留 `loadLegacyManifest` 方法，但改为抛出错误
   - `src/plugin/types.ts`: 保留 `ExtensionManifest` 类型定义，但标记为已废弃

2. **错误处理**:
   - 当尝试加载旧格式插件时，会显示明确的错误信息
   - 引导开发者使用新的 `manifest.json` 格式

## 构建验证

✅ **构建成功**:
- 成功扫描 16 个插件
- 所有插件入口正确添加
- 插件依赖正确处理

## 测试建议

### 1. 开发环境测试
```bash
npm run dev
```

**验证点**:
- ✅ 应用正常启动
- ✅ 所有插件正常加载
- ✅ 插件功能正常工作

### 2. 构建测试
```bash
npm run build
```

**验证点**:
- ✅ 构建成功完成
- ✅ 所有插件被打包
- ✅ 无错误或警告

### 3. 功能测试
- ✅ TOC 插件：生成目录
- ✅ 搜索替换插件：搜索和替换功能
- ✅ 编辑器配置插件：配置功能
- ✅ 其他插件：各自的功能

## 回滚方案

如果出现问题，可以从 Git 历史恢复：

```bash
# 查看最近的提交
git log --oneline -20

# 恢复到移除旧格式支持前的状态
git reset --hard <commit-hash>

# 或者恢复特定文件
git checkout <commit-hash> -- extensions/
git checkout <commit-hash> -- src/main.ts
git checkout <commit-hash> -- src/plugin/
```

## 后续清理（可选）

如果一切正常，可以进一步清理：

### 1. 删除完全无用的代码
- 删除 `src/plugin/loader.ts` 中的 `loadLegacyManifest` 方法
- 删除 `src/plugin/types.ts` 中的 `ExtensionManifest` 类型定义
- 删除 `src/plugin/loader.ts` 中的 `isModernManifest` 方法（如果不再需要）

### 2. 更新文档
- 更新插件开发指南
- 移除旧格式相关文档
- 更新 API 文档

### 3. 清理注释
- 移除所有关于 `extension.json` 的注释
- 更新代码注释，反映当前仅支持 `manifest.json`

## 注意事项

1. **插件 ID**: 新格式中 `zion.id` 是必需的
2. **主入口**: 新格式使用 `zion.main` 字段
3. **引擎要求**: 新格式支持 `engines.zion` 声明最低版本
4. **依赖管理**: 新格式支持 `dependencies` 和 `peerDependencies`

## 迁移状态

| 项目 | 状态 | 备注 |
|------|------|------|
| 删除旧文件 | ✅ 完成 | 所有 extension.json 已删除 |
| 更新 Vite 插件 | ✅ 完成 | 仅支持 manifest.json |
| 更新主入口 | ✅ 完成 | 仅扫描 manifest.json |
| 更新插件管理器 | ✅ 完成 | 仅扫描 manifest.json |
| 更新插件加载器 | ✅ 完成 | 移除旧格式支持 |
| 构建验证 | ✅ 完成 | 构建成功 |
| 功能测试 | ⏳ 待测试 | 需要运行测试 |

---

**完成时间**: 2025-01-31  
**执行人**: AI Assistant  
**状态**: 代码更新完成，等待功能测试
