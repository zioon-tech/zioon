# Zion Next (CM6) — Developer Guide

Zion Next 是一个基于 CodeMirror 6 的最小化脚手架，用于快速搭建“大模型交互编辑器”的核心与扩展体系验证。该工程提供：
- CM6 编辑器内核（EditorCore）与安全代理（EditorProxy）
- 扩展注册中心（commands / keybindings（支持 when） / menus（右键菜单） / status bar / messages（消息贡献者） / paste handlers / decorators）
- 事件总线（EventBus）与状态总线（StateBus），支持插件间交互
- 一个内置示例扩展（dev.sample-hello）以及扩展管理面板（可启用/禁用扩展与查看错误）

本仓库用于早期探索与框架搭建，后续将逐步扩展到完整平台。

## 环境要求

- Node.js ≥ 18
- npm ≥ 9（或使用 pnpm / yarn）
- 现代浏览器（本地开发使用 Vite dev server）

## 安装与启动

```bash
# 进入项目目录
cd zion-next

# 安装依赖
npm install

# 启动开发服务器
npm run dev
# 默认端口 5174，浏览器访问 http://localhost:5174
```

## 构建与预览

```bash
# 生产构建
npm run build

# 本地预览构建产物
npm run preview
# 默认端口 5175，浏览器访问 http://localhost:5175
```

## 项目结构

```
zion-next/
├─ index.html              # 应用入口
├─ src/
│  ├─ main.ts             # 启动逻辑：创建编辑器、挂载扩展
│  ├─ styles.css          # 全局样式
│  ├─ types/zion.d.ts     # 扩展 API & 类型定义（window.zion）
│  ├─ core/
│  │  ├─ event-bus.ts     # 插件事件总线（发布/订阅）
│  │  └─ state-bus.ts     # 插件状态总线（共享状态）
│  ├─ editor/
│  │  ├─ EditorCore.ts    # CodeMirror6 编辑器核心
│  │  └─ EditorProxy.ts   # 对外暴露的安全代理（扩展使用）
│  └─ ext/
│     └─ registry.ts      # 扩展注册中心（commands/keybindings/status bar）
├─ extensions/
│  └─ dev.sample-hello/
│     ├─ extension.json   # 扩展 manifest
│     └─ main.js          # 扩展入口（activate）
├─ vite.config.ts
├─ tsconfig.json
└─ package.json
```

## 扩展开发（Hello 示例）

扩展通过 `window.zion` 暴露的注册中心 API 进行注册与互动。示例扩展路径：
```
extensions/dev.sample-hello/
├─ extension.json
└─ main.js
```

`extension.json`（manifest）：
```json
{
  "name": "dev.sample-hello",
  "version": "0.0.1",
  "main": "./main.js",
  "contributes": {
    "commands": [
      { "id": "hello.insertDate", "title": "Insert Timestamp" }
    ],
    "keybindings": [
      { "command": "hello.insertDate", "key": "Mod-Shift-d" }
    ]
  },
  "activationEvents": [
    "onStartupFinished",
    "onCommand:hello.insertDate"
  ]
}
```

`main.js`（扩展入口）：
```js
export async function activate(ctx) {
  // 注册命令
  const d1 = window.zion.commands.registerCommand("hello.insertDate", () => {
    const ed = window.zion.window.activeEditor;
    if (!ed) return;
    ed.replaceSelection(new Date().toISOString());
  });
  ctx.subscriptions.push(d1);

  // 注册快捷键
  const d2 = window.zion.keybindings.register({
    command: "hello.insertDate",
    key: "Mod-Shift-d"
  });
  ctx.subscriptions.push(d2);

  // 状态栏按钮
  const status = window.zion.statusBar.registerItem({
    id: "ext.hello",
    text: "Hello",
    tooltip: "Insert timestamp",
    onClick: () => window.zion.commands.executeCommand("hello.insertDate")
  });
  ctx.subscriptions.push(status);
}
```

> 开发模式下会自动扫描并加载 `/extensions/**/extension.json` 下的所有扩展（见 `src/main.ts` 中的 `autoLoadExtensions()`）。你可以在 `extensions/` 下复制示例目录，立即生效，无需修改代码。

## 粘贴处理器（扩展）

扩展可以注册粘贴处理器来拦截并处理粘贴内容：

```js
const disp = window.zion.editor.registerPasteHandler({
  id: "demo.paste.timestamp",
  priority: 90,
  handle: ({ clipboardData, editor }) => {
    const text = clipboardData.getData("text/plain") || "";
    if (text.trim() === "::timestamp::") {
      editor.replaceSelection(new Date().toISOString());
      return true;
    }
    return false;
  }
});
```

> 处理器返回 `true` 时将阻止默认粘贴。

## 事件总线与状态总线（插件间互动）

- 事件总线（发布/订阅）
  ```ts
  // 发布事件
  window.zion.events.emit("bookmark/requestAdd", { files });

  // 订阅事件
  const d = window.zion.events.on("bookmark/requestAdd", payload => {
    console.log("add bookmarks", payload);
  });
  // 取消订阅
  d.dispose();
  ```

- 状态总线（共享小型状态）
  ```ts
  // 写入状态
  window.zion.state.set("explorer.selectedFiles", [{ path, name }]);

  // 监听变化
  const d = window.zion.state.onDidChange("explorer.selectedFiles", (nv, ov) => {
    console.log("selection changed:", nv);
  });
  d.dispose();
  ```

## 常见问题（FAQ）

- Q: 端口占用怎么办？
  - A: 更改 `vite.config.ts` 中的 `server.port`，例如改为 5176 后重启。

- Q: 快捷键不生效？
  - A: 确认 `key` 写法符合 CM6（如 `Mod-Shift-d`），并且扩展已被正确加载（查看浏览器控制台日志）。

- Q: 如何加载自定义扩展？
  - A: 在 `extensions/` 下创建新目录并提供 `extension.json` + `main.js`，在 `src/main.ts` 的 `loadExtension()` 调用中添加 manifest 路径或实现一个自动扫描（后续版本会加入自动加载）。

## 进一步阅读

- [docs/GettingStarted.md](./docs/GettingStarted.md)
- [docs/Extensions.md](./docs/Extensions.md)
- [docs/Development.md](./docs/Development.md)
- [docs/Roadmap.md](./docs/Roadmap.md)
- [docs/Changelog.md](./docs/Changelog.md)
=======