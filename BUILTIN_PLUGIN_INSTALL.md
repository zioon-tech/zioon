# 内置 LangChain Chat 插件 - 手动安装说明

由于文件权限问题，无法直接修改 `vite.config.ts`。我改用另一种方式：在 `src/main.ts` 中直接加载插件。

## 需要修改的文件：src/main.ts

在 `pluginManager.initialize()` 调用后添加以下代码：

```typescript
// 初始化插件管理器
const pluginManager = new PluginManager({
  pluginDir: '/plugins',
  extensionsDir: '/extensions',
  logLevel: 'info'
});

// ===== 内置插件加载: LangChain Chat =====
try {
  console.log('[Builtin] Loading builtin plugin: langchain-chat');

  // 动态导入插件清单
  const manifestUrl = '/src/plugins/langchain-chat/manifest.json';
  const manifestResp = await fetch(manifestUrl);
  if (!manifestResp.ok) {
    throw new Error(`Failed to load manifest from ${manifestUrl}`);
  }
  const manifest = await manifestResp.json();

  // 动态导入插件模块
  const moduleUrl = '/src/plugins/langchain-chat/index.ts';
  const pluginModule = await import(/* @vite-ignore */ moduleUrl);

  // 创建插件信息
  const pluginInfo = {
    id: manifest.zion.id,
    name: manifest.zion.name,
    version: manifest.zion.version,
    description: manifest.description,
    author: manifest.author,
    license: manifest.license,
    path: '/src/plugins/langchain-chat',
    manifest: manifest,
    state: 'installed' as any,
    error: undefined,
    dependencies: Object.keys(manifest.zion.dependencies || {}),
    peerDependencies: Object.keys(manifest.zion.peerDependencies || {}),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isLegacy: false,
    enabled: true
  };

  // 直接安装并激活插件
  await pluginManager.installFromInfo(pluginInfo, { enabled: true });

  console.log('[Builtin] Builtin plugin langchain-chat loaded successfully');
} catch (error) {
  console.error('[Builtin] Failed to load builtin plugin langchain-chat:', error);
}

// ===== 初始化插件系统 =====
try {
  await pluginManager.initialize();
  console.log('[PluginManager] 插件系统初始化完成');

  // Expose plugin manager to window.zion
  (window as any).zion.plugins = pluginManager;

  // ... 其余初始化代码保持不变 ...
} catch (error) {
  console.error('[PluginManager] 插件系统初始化失败:', error);
}
```

## 完整的修改位置

找到 `bootstrap()` 函数中创建 PluginManager 的位置，然后在 `pluginManager.initialize()` 之前插入上述代码。

大概在第 60-70 行附近。
