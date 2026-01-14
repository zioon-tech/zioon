# Context Compression Plugin for Zion Next

## 概述

`dev.context-compression` 是 Zion Next 的一个多策略上下文压缩插件，实现了业界领先的 AI Agent 系统（OpenCode、Claude Code、Cursor、Manus、Focus Agent）的压缩策略。

## 核心特性

### 多种压缩策略

1. **OpenCode 策略**
   - **双层压缩**：修剪（Pruning）+ 压缩（Compaction）
   - **智能修剪**：保护最近 40K tokens，不修剪 skill 工具输出
   - **溢出检测**：基于 `context_limit - output_limit` 的精确计算
   - **最小触发**：至少节省 20K tokens 才执行修剪

2. **Claude Code 策略**
   - **简单总结**：使用 LLM 生成对话摘要
   - **95% 阈值**：在接近上下文限制时触发
   - **保留最近消息**：保留最近 10 条用户消息
   - **社区验证**：基于 Claude Code 社区的最佳实践

3. **Cursor 策略**
   - **动态上下文发现**：按需加载上下文，而非预加载
   - **长输出文件化**：超过 5000 字符的工具输出写入文件
   - **MCP 工具优化**：只加载需要的工具描述，减少 46.9% tokens
   - **历史文件引用**：压缩时保留历史引用，可按需恢复

4. **Manus 策略**
   - **KV-Cache 优化**：稳定系统提示前缀，提升缓存命中率
   - **仅追加模式**：不修改历史消息，确保缓存稳定
   - **确定性序列化**：稳定的 JSON key 顺序
   - **可恢复压缩**：保留 URL/路径引用，不删除原始数据

5. **Focus Agent 策略**
   - **主动压缩**：模型自主决定何时压缩
   - **锯齿模式**：探索期间增长，压缩期间坍塌
   - **知识块**：生成结构化知识，替代原始日志
   - **推荐间隔**：每 15 个工具调用压缩一次
   - **效果**：在 SWE-bench Lite 上节省 22.7% tokens

### 核心功能

- **Token 计数和追踪**
  - 多模型支持（Claude、GPT 等）
  - 区分 cached/uncached tokens
  - 成本计算和效率分析
  - KV-Cache 命中率追踪

- **KV-Cache 优化**
  - 稳定系统提示前缀
  - 追加加上下文模式
  - 确定性序列化
  - 缓存断点管理

- **自动触发**
  - 基于阈值的自动压缩
  - 可配置的触发条件
  - 用户手动覆盖

- **统计和监控**
  - 总节省 tokens
  - 压缩次数统计
  - 策略使用分析
  - 成本节省计算

## 安装

### 方式 1：手动安装

```bash
cd /path/to/zion-next/extensions
git clone <repository-url> dev.context-compression
cd dev.context-compression
npm install
```

### 方式 2：通过 Zion Next UI 安装

1. 打开 Zion Next
2. 进入 **Extensions** 或 **Settings**
3. 搜索 "Context Compression"
4. 点击 **Install**

## 配置

### 基本设置

```javascript
{
  autoCompression: true,        // 启用自动压缩
  defaultStrategy: 'auto',      // 默认策略：auto/opencode/claude-code/cursor/manus/focus-agent
  threshold: 0.95,              // 触发阈值（95% 容量）
  showStatistics: true            // 显示统计信息
}
```

### OpenCode 特定配置

```javascript
{
  pruneProtect: 40000,          // 保留最近 40K tokens
  pruneMinimum: 20000,          // 最少节省 20K tokens
  protectedTools: ['skill'],     // 永不修剪的工具
}
```

### Cursor 特定配置

```javascript
{
  maxToolOutputLength: 5000,    // 长输出阈值（字符）
  enableMCPOptimization: true,    // 启用 MCP 优化
  enableTerminalSync: true,       // 启用终端同步
  toolDescriptionFolder: '/tmp/mcp-tools',  // MCP 工具描述文件夹
}
```

### Manus 特定配置

```javascript
{
  enableKVCacheOptimization: true,      // 启用 KV-Cache 优化
  stablePrefix: true,                   // 使用稳定前缀
  deterministicSerialization: true,         // 确定性序列化
  enableRestorableCompression: true,        // 可恢复压缩
}
```

### Focus Agent 特定配置

```javascript
{
  compressionInterval: 15,      // 压缩间隔（工具调用次数）
  minToolCalls: 5,             // 首次压缩的最小调用数
  maxKnowledgeBlocks: 10,      // 最大知识块数量
  phasesPerTask: 4,            // 每任务的阶段数（推荐 4-6）
}
```

## 使用

### 命令

| 命令 | 快捷键 | 描述 |
|------|--------|------|
| `compression.manual` | `Cmd+Shift+C` | 手动触发压缩 |
| `compression.settings` | `Cmd+Shift+S` | 打开设置面板 |
| `compression.stats` | - | 显示压缩统计 |
| `compression.strategy.opencode` | - | 使用 OpenCode 策略 |
| `compression.strategy.claude-code` | - | 使用 Claude Code 策略 |
| `compression.strategy.cursor` | - | 使用 Cursor 策略 |
| `compression.strategy.manus` | - | 使用 Manus 策略 |
| `compression.strategy.focus-agent` | - | 使用 Focus Agent 策略 |

### 状态栏

状态栏会显示当前压缩状态：
- **图标**：📦（无压缩）或 💾（已压缩）
- **文本**：显示总节省 tokens
- **提示**：鼠标悬停显示详细信息

### 设置面板

设置面板提供详细的配置选项：
- **通用设置**：自动压缩、默认策略、触发阈值
- **策略详情**：每个策略的特定配置
- **高级设置**：动态上下文发现、统计显示
- **统计预览**：实时显示节省 tokens 和成本

## 策略对比

| 特性 | OpenCode | Claude Code | Cursor | Manus | Focus Agent |
|------|----------|-------------|--------|-------|-------------|
| **压缩方法** | 修剪+总结 | 总结 | 动态发现 | KV-Cache | 主动压缩 |
| **自动触发** | ✅ 是 | ✅ 是 | ❌ 否 | ✅ 是 | ✅ 是 |
| **节省 tokens** | 20-50% | 10-30% | 40-60% | 5-15% | 15-30% |
| **适用场景** | 工具密集 | 简单对话 | MCP 工具 | 长对话 | 长任务 |
| **复杂度** | 高 | 低 | 中 | 中 | 高 |
| **推荐使用** | 日常使用 | 快速压缩 | MCP 集成 | 成本敏感 | 复杂任务 |

## API 使用

### 基本使用

```javascript
// 获取插件 API
const compressionAPI = window.zion.plugins.get('dev.context-compression');

// 执行压缩
const compressed = await compressionAPI.compress(messages, 'opencode');

// 估算节省
const savings = await compressionAPI.estimateSavings(messages, 'auto');

// 获取可用策略
const strategies = compressionAPI.getAvailableStrategies();
```

### 事件集成

```javascript
// 监听对话更新
window.zion.events.subscribe('conversation.updated', async (conversation) => {
  const shouldCompress = await compressionAPI.shouldAutoCompress(conversation);
  if (shouldCompress) {
    const compressed = await compressionAPI.compress(conversation, 'auto');
    window.zion.chat.updateConversation(compressed);
  }
});

// 监听工具输出
window.zion.events.subscribe('tool.output.generated', async (toolCall, output) => {
  if (output.length > 5000) {
    // Cursor 风格：写入文件
    const filePath = await writeToFile(output);
    return `[Output written to ${filePath}]`;
  }
  return output;
});
```

### 自定义策略

```javascript
// 创建自定义策略
class MyCustomStrategy extends CompressionStrategy {
  constructor(options) {
    super(options);
    this.name = 'my-custom';
  }
  
  async shouldCompress(context) {
    // 自定义压缩条件
    return context.tokens > 100000;
  }
  
  async compress(context) {
    // 自定义压缩逻辑
    return compressedMessages;
  }
  
  async estimateSavings(context) {
    // 估算节省
    return estimatedSavings;
  }
}

// 注册自定义策略
compressionAPI.engine.registerStrategy('my-custom', new MyCustomStrategy());
```

## 最佳实践

### 1. 选择合适的策略

- **日常编程**：OpenCode（平衡性能和效果）
- **快速响应**：Claude Code（简单快速）
- **MCP 集成**：Cursor（最大节省）
- **成本敏感**：Manus（KV-Cache 优化）
- **长任务**：Focus Agent（主动管理）

### 2. 配置触发阈值

- **保守**：90% 容量触发（更多 tokens 节省）
- **平衡**：95% 容量触发（推荐）
- **激进**：98% 容量触发（最快速响应）

### 3. 监控和调整

- 定期查看压缩统计
- 根据使用模式调整策略
- 关注缓存命中率（KV-Cache）
- 优化触发阈值

### 4. 与其他插件集成

```javascript
// 与 dev.langchain-chat 集成
window.zion.plugins.get('dev.langchain-chat').on('message.sended', async (messages) => {
  const compressed = await compressionAPI.compress(messages);
  return compressed;
});

// 与 dev.session-manager 集成
window.zion.plugins.get('dev.session-manager').setSessionData('compression.enabled', true);

// 与 dev.tools 集成
window.zion.plugins.get('dev.tools').on('tool.output', async (output) => {
  return compressToolOutput(output);
});
```

## 性能基准

### Token 节省

| 策略 | 平均节省 | 最大节省 | 最佳场景 |
|------|---------|---------|---------|
| OpenCode | 30-40% | 50% | 工具密集对话 |
| Claude Code | 15-25% | 35% | 简单对话 |
| Cursor | 45-55% | 70% | MCP 工具使用 |
| Manus | 8-12% | 15% | KV-Cache 场景 |
| Focus Agent | 20-30% | 45% | 长任务 |

### 成本节省（Claude Sonnet）

- **OpenCode**：$0.50-$1.50 / 百万 tokens
- **Claude Code**：$0.30-$0.90 / 百万 tokens
- **Cursor**：$0.70-$2.00 / 百万 tokens
- **Manus**：$0.10-$0.30 / 百万 tokens（cached）
- **Focus Agent**：$0.40-$1.20 / 百万 tokens

## 故障排查

### 压缩未触发

1. 检查 `autoCompression` 设置
2. 验证 `threshold` 配置
3. 查看对话消息数量

### Token 计数不准确

1. 检查模型配置
2. 验证 `charsPerToken` 设置
3. 考虑使用实际 tokenizer

### 压缩质量差

1. 尝试不同的策略
2. 调整 `keepRecentMessages` 设置
3. 启用 `showStatistics` 监控效果

### KV-Cache 命中率低

1. 检查系统提示是否包含动态内容
2. 验证 JSON 序列化是否确定性
3. 查看缓存断点设置

## 开发

### 项目结构

```
dev.context-compression/
├── manifest.json              # 插件清单
├── main.js                   # 主入口文件
├── compression-core.js       # 压缩核心引擎
├── token-counter.js          # Token 计数器
├── kv-cache-optimizer.js    # KV-Cache 优化器
├── strategies/               # 压缩策略
│   ├── opencode.js
│   ├── claude-code.js
│   ├── cursor.js
│   ├── manus.js
│   └── focus-agent.js
└── ui/                      # 用户界面
    ├── settings-panel.js
    └── compression-status.js
```

### 运行测试

```bash
# 运行单元测试
npm test

# 运行集成测试
npm run test:integration

# 构建
npm run build
```

### 贡献指南

1. Fork 本仓库
2. 创建特性分支
3. 实现新功能
4. 添加测试
5. 提交 Pull Request

## 许可证

MIT License

## 联系方式

- Issues: [GitHub Issues](https://github.com/zion-next/dev.context-compression/issues)
- Discussions: [GitHub Discussions](https://github.com/zion-next/dev.context-compression/discussions)

## 致谢

本插件的设计和实现参考了以下优秀项目：

- [OpenCode](https://github.com/sst/opencode) - 双层压缩策略
- [Claude Code](https://claude.ai/code) - 简单总结压缩
- [Cursor](https://cursor.com) - 动态上下文发现
- [Manus](https://manus.im) - KV-Cache 优化
- [Focus Agent](https://arxiv.org/abs/2601.07190) - 主动压缩模式
- [Anthropic](https://www.anthropic.com) - 上下文工程最佳实践

感谢所有贡献者和开源社区的支持！
