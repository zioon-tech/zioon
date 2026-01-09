# 插件热重载通知功能

## 功能概述

在开发模式下，当正在开发的插件代码发生变更时，系统会自动热重载插件，并在屏幕右上角显示弹出通知，告知用户插件已更新。

## 实现架构

### 1. 后端服务 (zion-local-tools)

**文件**: `src/zion_local_tools/plugins/dev_service.py`

后端服务实现了文件监控和 WebSocket 推送：

```python
class DevPluginService:
    async def _watch_loop(self, sess: DevSession):
        """轮询检测文件变更并通过 WebSocket 推送"""
        while sess.running:
            await asyncio.sleep(0.8)
            latest = self._scan_snapshot(sess.root)
            # 检测新增/修改/删除
            for rel, mt in latest.items():
                old_mt = sess.snapshot.get(rel)
                if old_mt is None:
                    await self._broadcast(sess, {
                        "type": "dev:change",
                        "devId": sess.dev_id,
                        "file": rel,
                        "event": "add",
                        "timestamp": int(time.time() * 1000)
                    })
                elif mt != old_mt:
                    await self._broadcast(sess, {
                        "type": "dev:change",
                        "devId": sess.dev_id,
                        "file": rel,
                        "event": "change",
                        "timestamp": int(time.time() * 1000)
                    })
```

### 2. 前端通知系统

#### 2.1 通知管理器

**文件**: `src/notification/manager.ts`

实现了统一的通知管理器：

```typescript
export class NotificationManager {
  /**
   * 显示插件热重载通知
   */
  showPluginHotReload(pluginInfo: PluginInfo, devDir?: string): HTMLElement {
    const devDirText = devDir ? `<div style="opacity: 0.6; font-size: 11px; margin-top: 4px;">📁 ${devDir}</div>` : '';

    return this.show(
      `<strong>${pluginInfo.name}</strong> has been hot-reloaded<br><span style="opacity: 0.7;">v${pluginInfo.version}</span>${devDirText}`,
      {
        type: 'success',
        duration: 6000,
        actions: [
          {
            label: 'Reload Page',
            handler: () => window.location.reload()
          }
        ]
      }
    );
  }

  /**
   * 显示热重载错误通知
   */
  showHotReloadError(pluginName: string, error: string): HTMLElement {
    return this.show(
      `<strong>${pluginName}</strong> hot reload failed<br><span style="opacity: 0.7; font-size: 11px;">${error}</span>`,
      {
        type: 'error',
        duration: 8000
      }
    );
  }
}
```

#### 2.2 插件管理器扩展

**文件**: `src/plugin/manager.ts`

新增了 `hotReloadFromInfo` 方法，专用于开发模式热重载：

```typescript
/**
 * 从 PluginInfo 热重载插件（开发模式专用）
 * 不检查版本变化，直接重新激活插件
 */
async hotReloadFromInfo(pluginInfo: PluginInfo, options: { enabled?: boolean } = {}): Promise<PluginInfo> {
  const existing = this.plugins.get(pluginInfo.id);
  if (!existing) {
    return await this.installFromInfo(pluginInfo, options);
  }

  this.log('info', `热重载插件: ${pluginInfo.id}`);

  // 如处于激活状态，先停用
  if (this.activePlugins.has(pluginInfo.id)) {
    try {
      await this.deactivate(pluginInfo.id);
    } catch (e) {
      this.log('warn', `热重载前停用失败: ${pluginInfo.id}`, e);
    }
  }

  // 替换信息（保留启用状态）
  this.plugins.set(pluginInfo.id, {
    ...existing,
    ...pluginInfo,
    enabled: existing.enabled,
    state: existing.state,
    error: existing.error,
    createdAt: existing.createdAt,
    updatedAt: Date.now()
  });

  // 触发热重载事件（区别于 updated 事件）
  this.emit('hotReloaded', {
    plugin: this.plugins.get(pluginInfo.id)!,
    previous: existing,
    timestamp: Date.now()
  });

  // 如启用则重新激活
  if (existing.enabled) {
    try {
      await this.activate(pluginInfo.id);
      this.enabledPlugins.add(pluginInfo.id);
      this.disabledPlugins.delete(pluginInfo.id);
    } catch (e) {
      this.log('error', `热重载后激活失败: ${pluginInfo.id}`, e);
    }
  } else {
    this.disabledPlugins.add(pluginInfo.id);
    this.enabledPlugins.delete(pluginInfo.id);
  }

  await this.savePluginStates();

  this.log('info', `插件热重载完成: ${pluginInfo.id}`);
  return this.plugins.get(pluginInfo.id)!;
}
```

#### 2.3 主程序集成

**文件**: `src/main.ts`

在插件管理器初始化后，监听热重载事件并显示通知：

```typescript
// 监听插件热重载事件并显示通知
pluginManager.on('hotReloaded', (event: any) => {
  const { plugin, previous } = event;
  try {
    // 从开发会话信息中获取目录
    const sessions = (window as any).zion.state.get("plugins.devSessions") || {};
    const devInfo = Object.values(sessions).find((s: any) => s?.pluginId === plugin.id) || null;

    // 尝试从 localStorage 获取开发目录信息
    let devDir: string | undefined;
    if (!devInfo) {
      try {
        const saved = JSON.parse(localStorage.getItem("zion.plugins.devSessionsInfo") || "{}");
        devInfo = saved[plugin.id] || null;
      } catch {}
    }

    if (devInfo?.dir) {
      devDir = devInfo.dir;
    }

    // 显示热重载通知
    notificationManager.showPluginHotReload(plugin, devDir);
  } catch (error) {
    console.error('[PluginManager] 显示热重载通知失败:', error);
  }
});
```

WebSocket 消息处理也更新为使用热重载方法：

```typescript
ws.onmessage = async (ev) => {
  try {
    const msg = JSON.parse(ev.data);
    if (msg.type === "dev:change" && msg.devId === devId) {
      // 变更事件：重新读取 manifest 并热重载插件
      const installer = (window as any).zion.pluginInstaller;
      const baseUrl = getServiceBaseUrl() + `/plugins/dev/${devId}`;
      const ret = await installer.installFromDevBase(baseUrl, devId);
      if (ret.success && ret.plugin) {
        // 使用热重载方法（不检查版本变化）
        try {
          await pluginManager.hotReloadFromInfo(ret.plugin, { enabled: true });
        } catch (e) {
          console.error("[plugins] dev hot reload error:", e);
          notificationManager.showHotReloadError(
            ret.plugin.name,
            (e as any)?.message || String(e)
          );
        }
      } else {
        console.warn("[plugins] dev install failed:", ret.error?.message);
      }
    } else if (msg.type === "dev:stop") {
      devStatus.textContent = `Dev session stopped: ${devId}`;
    }
  } catch (e) {
    // 非JSON消息或错误
  }
};
```

### 3. 扩展插件更新

**文件**: `extensions/dev.tools/main.js`

更新了 `pluginsManage` 工具的 WebSocket 处理逻辑，使用热重载方法：

```javascript
ws.onmessage = async (ev) => {
  try {
    const msg = JSON.parse(ev.data);
    if (msg?.type === "dev:change" && msg?.devId === devId) {
      const ret = await installer.installFromDevBase(baseUrlAbs, devId);
      if (ret.success && ret.plugin) {
        try {
          // 使用热重载方法（不检查版本变化）
          await pm.hotReloadFromInfo(ret.plugin, { enabled: true });
        } catch (e) {
          console.warn("[pluginsManage] dev hot reload failed:", e);
        }
      }
    }
  } catch {}
};
```

## 使用方法

### 启动开发模式

1. 在 Zion Next 中打开插件管理面板（点击状态栏的 "Plugins" 按钮）
2. 找到 "Dev Mode" 部分
3. 输入本地插件目录的绝对路径
4. 点击 "Start Dev" 按钮

### 热重载通知

当你在开发模式下修改插件代码时：

1. **文件变更检测**: zion-local-tools 每 800ms 轮询一次，检测到文件变化
2. **WebSocket 推送**: 后端通过 WebSocket 向前端推送 `dev:change` 消息
3. **自动热重载**: 前端收到消息后自动重新加载并激活插件
4. **显示通知**: 屏幕右上角弹出通知，显示：
   - 插件名称
   - 版本号
   - 开发目录路径
   - "Reload Page" 按钮（可选）

### 通知类型

通知支持多种类型：

- **成功** (绿色): 热重载成功
- **错误** (红色): 热重载失败，显示错误信息
- **信息** (蓝色): 开发模式启动/停止

### 交互功能

- **自动消失**: 通知默认在 6 秒后自动消失
- **手动关闭**: 点击通知右上角的 ✕ 按钮可立即关闭
- **操作按钮**: 提供可点击的操作按钮（如 "Reload Page"）

## 技术细节

### 事件类型区分

插件系统现在区分两种更新事件：

1. **`updated` 事件**: 版本号变化时的正常更新
2. **`hotReloaded` 事件**: 开发模式下的热重载（版本号可能不变）

### 开发会话管理

开发会话信息存储在两个地方：

1. **StateBus**: `plugins.devSessions` - 运行时状态
2. **localStorage**: `zion.plugins.devSessionsInfo` - 持久化存储

```typescript
interface DevSession {
  ws: WebSocket;
  baseUrl: string;
  pluginId: string;
  dir?: string;
}
```

### 文件监控实现

后端使用轮询方式检测文件变化：

```python
async def _watch_loop(self, sess: DevSession):
    """每 800ms 扫描一次快照，计算增量变化"""
    try:
        while sess.running:
            await asyncio.sleep(0.8)
            latest = self._scan_snapshot(sess.root)
            # 检测新增/修改/删除
            # ...
            sess.snapshot = latest
```

## 故障排除

### 通知不显示

1. 检查浏览器控制台是否有错误
2. 确认 `notificationManager` 已正确导入和初始化
3. 检查事件监听器是否正确注册

### 热重载失败

1. 检查插件代码是否有语法错误
2. 查看控制台错误信息
3. 尝试手动刷新页面

### WebSocket 连接问题

1. 确认 zion-local-tools 服务正在运行
2. 检查服务地址配置（默认 `http://127.0.0.1:8765`）
3. 查看浏览器网络面板的 WebSocket 连接状态

## 扩展功能

### 自定义通知样式

通知管理器支持自定义样式，可通过修改 CSS 变量或直接修改通知元素样式来实现自定义外观。

### 添加更多通知类型

在 `NotificationManager` 中添加新方法：

```typescript
showCustomNotification(message: string, options: NotificationOptions = {}) {
  return this.show(message, {
    type: 'info',
    duration: 5000,
    ...options
  });
}
```

### 监听其他插件事件

```typescript
pluginManager.on('updated', (pluginInfo) => {
  // 处理版本更新
});

pluginManager.on('installed', (pluginInfo) => {
  // 处理插件安装
});

pluginManager.on('error', (event) => {
  // 处理插件错误
});
```

## 相关文件

- `src/notification/manager.ts` - 通知管理器实现
- `src/plugin/manager.ts` - 插件管理器（包含热重载方法）
- `src/plugin/types.ts` - 类型定义（包含 `hotReloaded` 事件类型）
- `src/main.ts` - 主程序（包含事件监听和 WebSocket 处理）
- `extensions/dev.tools/main.js` - 开发工具扩展（包含 WebSocket 处理）
- `src/zion_local_tools/plugins/dev_service.py` - 开发模式服务

## 版本历史

- **v1.0.0** (当前版本): 初始实现
  - 实现通知管理器
  - 添加热重载方法和事件
  - 集成到主程序和扩展插件
  - 支持多种通知类型和交互功能
