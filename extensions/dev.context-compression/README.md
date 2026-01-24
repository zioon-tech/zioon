# dev.context-compression 开发者文档

## 结构
- 入口与引擎：`main.js`、`compression-core.js`
- 策略：`strategies/` 下的 `opencode.js`、`claude-code.js` 等
- UI：`ui/settings-panel.js`、`ui/compression-status.js`
- 统计与版本：`main.js` 内 IndexedDB/KV 适配与统计 API

## 数据流
```
文本会话 → parseMessages →
消息序列 → analyzeConversation/selectStrategy →
strategy.compress → sanitizeChatMessages →
serializeMessages → 持久化 versions/统计
```

## 配置同步
- 设置面板写入键：`ui/settings-panel.js`
- 引擎同步：`main.js: syncEngineFromSettings`
- 策略选项更新：OpenCode、FocusAgent、Cursor 等按需下发

## 验证脚本
- 烟囱测试：`scripts/smoke-test.js`
  - 执行：`node extensions/dev.context-compression/scripts/smoke-test.js`
  - 输出包含策略注册、修剪日志与压缩后统计
- 基准测试：`scripts/benchmark.js`（后续补充）

## 扩展点
- 新策略需实现：`shouldCompress`、`compress`、`estimateSavings`
- 引擎策略选择：`compression-core.js: selectAutoStrategy`
- 清洗规则：`main.js: sanitizeChatMessages`

## Progressive 策略
- 目标：借鉴“渐进式加载”，保留必要元信息，卸载详细工具输出
- 行为：保留 user/assistant 文本；将 tool 消息替换为结构化最小记录（id、tool、status、file_path/url、prompt 等）
- 触发：上下文接近阈值或存在大量/长工具输出
- 命令：`compression.strategy.progressive`
