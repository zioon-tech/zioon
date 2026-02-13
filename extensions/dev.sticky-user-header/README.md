# Sticky User Header Extension

在编辑器上下滚动时，自动将可视区域上方内容对应的 **user 消息**置顶显示在页面顶部。这样你可以快速知道当前查看的是哪个问题的回答内容。

## 功能说明

- 当你在编辑器中滚动浏览长对话时，扩展会自动识别当前可视区域顶部对应的 user 消息
- 将该 user 消息的内容显示在编辑器顶部的固定栏中
- 帮助你快速定位上下文，知道当前看的是哪个问题的回答

## 使用方式

扩展会自动生效。当你滚动编辑器时，顶部的 sticky header 会自动更新显示对应的 user 问题。

### 命令

当前 `zion-next` 可能还没有命令面板（Command Palette）。你仍然可以通过以下方式使用开关：

- 直接点击 Sticky Header 右侧的 `×` 关闭按钮
- 关闭后，编辑器右上角会出现一个半透明按钮，点击即可恢复开启
- （可选）在浏览器控制台执行：`window.zion.commands.executeCommand('stickyHeader.toggle')`

如果需要彻底关闭此功能，也可以在扩展管理中禁用 `dev.sticky-user-header` 扩展。

## 实现原理

1. 监听编辑器滚动事件
2. 获取当前可视区域的位置
3. 向上查找最近的 "user " 消息标记
4. 提取该消息的内容并显示在顶部固定栏中

## 技术细节

- 使用 `requestAnimationFrame` 优化滚动性能
- 从 `window.zion.state.get('chat.rolePrefixes')` 读取角色标记配置
- 轻量级实现，不修改编辑器核心逻辑
