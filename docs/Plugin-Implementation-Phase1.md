# 插件化实现 - 第一阶段：基础架构重构

## 概述

第一阶段的目标是建立插件化架构的基础，包括新的插件包格式、加载器和基本的管理功能。此阶段保持向后兼容，现有插件可以继续工作。

## 时间计划
- **预计时间**：1-2周
- **开始日期**：2024年1月
- **结束日期**：2024年1月

## 目标

### 主要目标
1. 定义新的插件包格式
2. 实现插件加载器重构
3. 创建插件管理器基础
4. 保持向后兼容

### 成功标准
- [ ] 新插件包格式规范完成
- [ ] 插件加载器支持新旧格式
- [ ] 基本插件管理界面
- [ ] 现有插件正常工作
- [ ] 单元测试覆盖核心功能

## 详细任务

### 任务 1：定义插件包格式规范
**负责人**：[待定]
**预计时间**：2天

#### 子任务
1. [ ] 创建 `manifest.json` 规范
2. [ ] 定义插件包目录结构
3. [ ] 设计向后兼容方案
4. [ ] 编写 JSON Schema 验证
5. [ ] 创建示例插件模板

#### 交付物
- `docs/Plugin-Package-Specification.md`
- `schemas/plugin-manifest.schema.json`
- `templates/plugin-template/`

### 任务 2：实现插件加载器
**负责人**：[待定]
**预计时间**：3天

#### 子任务
1. [ ] 创建 `PluginLoader` 类
2. [ ] 支持新旧格式检测
3. [ ] 实现清单文件解析
4. [ ] 添加依赖检查
5. [ ] 实现模块加载
6. [ ] 添加错误处理

#### 代码结构
```typescript
// src/plugin/loader.ts
class PluginLoader {
  async loadPlugin(pluginPath: string): Promise<Plugin>
  async loadManifest(manifestPath: string): Promise<PluginManifest>
  async resolveDependencies(manifest: PluginManifest): Promise<void>
  async loadModule(manifest: PluginManifest): Promise<ExtensionModule>
}

// src/plugin/types.ts
interface PluginManifest {
  zion: {
    id: string
    name: string
    version: string
    main: string
    // ... 其他字段
  }
}

interface Plugin {
  id: string
  name: string
  version: string
  manifest: PluginManifest
  path: string
  state: PluginState
  instance?: any
}
```

### 任务 3：创建插件管理器
**负责人**：[待定]
**预计时间**：3天

#### 子任务
1. [ ] 创建 `PluginManager` 类
2. [ ] 实现插件注册表
3. [ ] 添加插件生命周期管理
4. [ ] 创建配置存储
5. [ ] 实现事件系统

#### 代码结构
```typescript
// src/plugin/manager.ts
class PluginManager {
  private plugins: Map<string, Plugin> = new Map()
  private pluginDir: string
  
  async install(pluginPath: string): Promise<Plugin>
  async uninstall(pluginId: string): Promise<void>
  async enable(pluginId: string): Promise<void>
  async disable(pluginId: string): Promise<void>
  async activate(pluginId: string): Promise<void>
  async deactivate(pluginId: string): Promise<void>
  
  list(): Plugin[]
  get(pluginId: string): Plugin | null
  search(query: string): Plugin[]
}

// src/plugin/registry.ts
class PluginRegistry {
  private installed: Map<string, PluginInfo> = new Map()
  private enabled: Set<string> = new Set()
  
  register(plugin: PluginInfo): void
  unregister(pluginId: string): void
  isEnabled(pluginId: string): boolean
  setEnabled(pluginId: string, enabled: boolean): void
}
```

### 任务 4：更新主入口文件
**负责人**：[待定]
**预计时间**：2天

#### 子任务
1. [ ] 修改 `src/main.ts` 加载逻辑
2. [ ] 集成新的插件管理器
3. [ ] 保持向后兼容
4. [ ] 更新自动加载逻辑
5. [ ] 添加错误处理

#### 代码修改
```typescript
// src/main.ts
async function bootstrap() {
  // ... 现有代码
  
  // 初始化插件管理器
  const pluginManager = new PluginManager({
    pluginDir: './plugins', // 新插件目录
    extensionsDir: './extensions' // 旧插件目录（向后兼容）
  })
  
  // 加载插件
  await pluginManager.loadAll()
  
  // ... 其他初始化
}
```

### 任务 5：创建管理界面
**负责人**：[待定]
**预计时间**：2天

#### 子任务
1. [ ] 扩展现有的扩展面板
2. [ ] 添加插件安装功能
3. [ ] 实现启用/禁用切换
4. [ ] 显示插件信息
5. [ ] 添加错误状态显示

#### 界面功能
- 插件列表（名称、版本、状态）
- 启用/禁用切换
- 插件详情查看
- 错误信息显示
- 重新加载按钮

### 任务 6：迁移现有插件
**负责人**：[待定]
**预计时间**：2天

#### 子任务
1. [ ] 创建迁移工具
2. [ ] 迁移 `dev.editor-config` 插件
3. [ ] 迁移 `dev.fs-manager` 插件
4. [ ] 测试迁移后的插件
5. [ ] 更新文档

#### 迁移工具
```bash
# 迁移命令
npx zion-plugin migrate ./extensions/dev.editor-config ./plugins/

# 批量迁移
npx zion-plugin migrate-all ./extensions ./plugins/
```

### 任务 7：测试和验证
**负责人**：[待定]
**预计时间**：2天

#### 子任务
1. [ ] 编写单元测试
2. [ ] 编写集成测试
3. [ ] 测试新旧插件兼容性
4. [ ] 性能测试
5. [ ] 错误处理测试

#### 测试覆盖
- 插件加载测试
- 清单解析测试
- 依赖解析测试
- 生命周期测试
- 错误恢复测试

## 代码结构变更

### 新目录结构
```
src/
├── plugin/                    # 插件系统核心
│   ├── loader.ts             # 插件加载器
│   ├── manager.ts            # 插件管理器
│   ├── registry.ts           # 插件注册表
│   ├── types.ts              # 类型定义
│   └── utils.ts              # 工具函数
├── ui/                       # 插件管理界面
│   └── plugin-panel.ts       # 插件面板组件
└── main.ts                   # 更新主入口

plugins/                      # 新插件目录（用户安装）
├── com.example.myplugin-1.0.0/
└── ...

extensions/                   # 旧插件目录（向后兼容）
├── dev.editor-config/
└── ...
```

### 配置文件
```
zion.config.json              # 主配置文件
└── plugins.json              # 插件配置（自动生成）
```

## 向后兼容策略

### 兼容层设计
```typescript
// src/plugin/compatibility.ts
class CompatibilityLayer {
  static convertOldManifest(oldManifest: any): PluginManifest {
    // 转换旧格式到新格式
    return {
      zion: {
        id: `dev.${oldManifest.name}`,
        name: oldManifest.name,
        version: oldManifest.version || '0.0.1',
        main: oldManifest.main,
        // ... 其他字段转换
      }
    }
  }
  
  static loadOldExtension(path: string): Promise<Plugin> {
    // 加载旧格式插件
  }
}
```

### 加载优先级
1. 新插件目录 (`plugins/`)
2. 旧插件目录 (`extensions/`)
3. 内置插件

### 冲突处理
- 相同 ID 的插件：新版本优先
- 版本冲突：显示警告
- 依赖冲突：禁用冲突插件

## API 变更

### 新增 API
```typescript
// window.zion.plugins
window.zion.plugins = {
  install(url: string): Promise<PluginInfo>
  uninstall(id: string): Promise<void>
  enable(id: string): Promise<void>
  disable(id: string): Promise<void>
  list(): PluginInfo[]
  get(id: string): PluginInfo | null
}
```

### 现有 API 保持不变
- `window.zion.commands`
- `window.zion.keybindings`
- `window.zion.events`
- `window.zion.state`
- 等现有 API

## 错误处理

### 错误类型
```typescript
enum PluginError {
  MANIFEST_NOT_FOUND = 'MANIFEST_NOT_FOUND',
  MANIFEST_INVALID = 'MANIFEST_INVALID',
  DEPENDENCY_MISSING = 'DEPENDENCY_MISSING',
  VERSION_INCOMPATIBLE = 'VERSION_INCOMPATIBLE',
  LOAD_FAILED = 'LOAD_FAILED',
  ACTIVATION_FAILED = 'ACTIVATION_FAILED'
}
```

### 错误恢复
1. 清单错误：跳过插件，记录错误
2. 依赖错误：禁用插件，显示警告
3. 加载错误：重试一次，然后禁用
4. 激活错误：停用插件，恢复状态

## 性能考虑

### 优化措施
1. **懒加载**：插件按需加载
2. **缓存**：清单和模块缓存
3. **并行加载**：多个插件并行加载
4. **增量更新**：只更新变化的插件

### 性能指标
- 插件加载时间：< 100ms
- 内存使用增加：< 10MB（基础）
- 启动时间增加：< 200ms

## 安全考虑

### 安全措施
1. **清单验证**：验证 JSON Schema
2. **路径限制**：限制文件系统访问
3. **依赖检查**：验证依赖来源
4. **错误隔离**：插件错误不影响主程序

### 权限控制
- 插件只能访问指定目录
- 网络请求需要权限
- 文件操作需要权限

## 文档更新

### 需要更新的文档
1. [ ] `docs/Extensions.md` - 添加新插件格式说明
2. [ ] `docs/Extensions-API.md` - 添加插件管理 API
3. [ ] `docs/GettingStarted.md` - 更新插件开发指南
4. [ ] `README.md` - 更新项目说明

### 新文档
1. [ ] `docs/Plugin-Development.md` - 插件开发指南
2. [ ] `docs/Plugin-Migration.md` - 迁移指南
3. [ ] `docs/Plugin-Troubleshooting.md` - 故障排除

## 测试计划

### 单元测试
```typescript
// tests/plugin/loader.test.ts
describe('PluginLoader', () => {
  test('should load new format plugin', async () => {})
  test('should load old format plugin', async () => {})
  test('should handle manifest errors', async () => {})
  test('should resolve dependencies', async () => {})
})

// tests/plugin/manager.test.ts
describe('PluginManager', () => {
  test('should install plugin', async () => {})
  test('should uninstall plugin', async () => {})
  test('should enable/disable plugin', async () => {})
  test('should handle conflicts', async () => {})
})
```

### 集成测试
```typescript
// tests/integration/plugin-system.test.ts
describe('Plugin System Integration', () => {
  test('should load and activate plugin', async () => {})
  test('should handle plugin errors', async () => {})
  test('should maintain backward compatibility', async () => {})
  test('should update plugin state', async () => {})
})
```

### 性能测试
```typescript
// tests/performance/plugin-load.test.ts
describe('Plugin Load Performance', () => {
  test('should load 10 plugins under 1 second', async () => {})
  test('should not increase memory significantly', async () => {})
  test('should handle concurrent loads', async () => {})
})
```

## 风险缓解

### 技术风险
1. **向后兼容问题**
   - 缓解：充分测试，提供迁移工具
   
2. **性能影响**
   - 缓解：性能监控，优化加载策略
   
3. **稳定性问题**
   - 缓解：错误隔离，恢复机制

### 项目风险
1. **时间延迟**
   - 缓解：分阶段实施，优先级排序
   
2. **资源不足**
   - 缓解：重用现有代码，模块化开发

## 验收标准

### 功能验收
- [ ] 新插件格式可以正常加载
- [ ] 旧插件格式可以正常加载
- [ ] 插件管理界面工作正常
- [ ] 插件启用/禁用功能正常
- [ ] 错误处理机制完善

### 性能验收
- [ ] 插件加载时间符合要求
- [ ] 内存使用符合要求
- [ ] 启动时间符合要求

### 质量验收
- [ ] 单元测试覆盖率 > 80%
- [ ] 集成测试通过
- [ ] 文档完整准确
- [ ] 代码审查通过

## 下一步计划

### 第一阶段完成后
1. 评估第一阶段成果
2. 收集用户反馈
3. 规划第二阶段工作
4. 修复发现的问题

### 第二阶段准备
1. 设计沙箱机制
2. 规划依赖管理系统
3. 准备插件商店功能

## 联系方式

- **项目协调**：[待定]
- **技术负责人**：[待定]
- **测试负责人**：[待定]
- **文档负责人**：[待定]

---
*最后更新：2024年1月*
*版本：1.0.0*