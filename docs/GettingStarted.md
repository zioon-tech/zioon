# Getting Started

本指南帮助你在本地快速运行 Zion Next 并编写第一个扩展。

## 1. 环境准备

- 安装 Node.js ≥ 18
- 推荐使用 npm ≥ 9（或 pnpm/yarn）

## 2. 安装依赖并启动

```bash
cd zion-next
npm install
npm run dev
# 浏览器访问 http://localhost:5174
```

你将看到一个基础的 CM6 编辑器与顶部状态栏。

## 3. 了解核心文件

- `src/main.ts`：应用入口，创建编辑器并加载扩展
- `src/editor/EditorCore.ts`：CodeMirror 6 核心与基础扩展
- `src/ext/registry.ts`：扩展注册中心（commands/keybindings/statusbar/events/state）
- `extensions/dev.sample-hello/`：示例扩展

## 4. 编写你的第一个扩展

1) 在 `extensions/` 下复制示例扩展：
```
extensions/my.first-ext/
├─ extension.json
└─ main.js
```

2) `extension.json`：
```json
{
  "name": "my.first-ext",
  "version": "0.0.1",
  "main": "./main.js",
  "contributes": {
    "commands": [{ "id": "my.insertHello", "title": "Insert Hello" }],
    "keybindings": [{ "command": "my.insertHello", "key": "Mod-Shift-h" }]
  },
  "activationEvents": ["onCommand:my.insertHello"]
}
```

3) `main.js`：
```js
export async function activate(ctx) {
  const d1 = window.zion.commands.registerCommand("my.insertHello", () => {
    const ed = window.zion.window.activeEditor;
    if (!ed) return;
    ed.replaceSelection("Hello, Zion!");
  });
  ctx.subscriptions.push(d1);

  const d2 = window.zion.keybindings.register({
    command: "my.insertHello",
    key: "Mod-Shift-h"
  });
  ctx.subscriptions.push(d2);
}
```

4) 加载扩展与管理  
- 将你的扩展放到 `extensions/` 目录下（包含 `extension.json` 与入口 `main.js`），系统会自动扫描并加载。无需修改 `src/main.ts`。  
- 顶部状态栏的 “Extensions” 按钮可打开面板，启用/禁用扩展（状态保存在本地，刷新后生效）。  
- 如果某些扩展加载失败，状态栏会显示 `● ExtErr(n)`，请打开控制台查看详细错误。

刷新页面后按 `Cmd/Ctrl + Shift + H` 即可插入文本。

## 5. 插件互动（事件/状态总线）

- 发布事件：
  ```ts
  window.zion.events.emit("bookmark/requestAdd", { files });
  ```

- 订阅事件：
  ```ts
  const d = window.zion.events.on("bookmark/requestAdd", payload => { /* ... */ });
  // d.dispose() 取消订阅
  ```

- 共享状态：
  ```ts
  window.zion.state.set("explorer.selectedFiles", [{ path, name }]);
  ```

- 监听状态变化：
  ```ts
  const d = window.zion.state.onDidChange("explorer.selectedFiles", (nv, ov) => { /* ... */ });
  ```

## 6. 构建与预览

```bash
npm run build
npm run preview
# http://localhost:5175
```

## 7. 常见问题

- 端口冲突：修改 `vite.config.ts` 的 `server.port`。
- 扩展未加载：检查控制台是否打印 `[ext] loaded: ...`，以及 manifest 路径是否正确。
- 快捷键冲突：浏览器/系统层快捷键可能拦截，建议换键位测试。

祝开发愉快！
=======