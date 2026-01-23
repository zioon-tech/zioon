# Zion Next PWA 功能已启用！🎉

## ✅ 已完成的配置

### 1. 安装依赖
- ✅ `vite-plugin-pwa` 已安装

### 2. 创建必需文件
- ✅ `public/manifest.json` - Web App Manifest
- ✅ `public/icon-192.png` - 192x192 图标
- ✅ `public/icon-512.png` - 512x512 图标

### 3. 更新配置文件
- ✅ `vite.config.ts` - 添加了 VitePWA 插件
- ✅ `index.html` - 添加了 manifest 链接和 meta 标签
- ✅ `src/main.ts` - 导入了 PWA 测试工具

---

## 🚀 如何使用

### 1. 启动开发服务器
```bash
npm run dev
```

### 2. 在浏览器中访问
打开浏览器访问：`http://localhost:5177/`（或显示的端口）

### 3. 检查 PWA 状态
1. 打开浏览器开发者工具（F12）
2. 进入 **Application** 标签
3. 查看以下内容：
   - **Manifest** - 应该能看到 manifest 配置
   - **Service Workers** - 应该能看到已注册的 Service Worker
   - **Cache Storage** - 应该能看到缓存的资源

### 4. 查看 PWA 检查日志
打开浏览器控制台（Console），应该能看到 PWA 状态检查日志：
```
🔍 PWA Status Check
===================
✅ Service Worker is supported
📋 Found 1 registered Service Worker(s)
✅ Web App Manifest link found
📡 Network status: Online
✅ Install prompt is supported
===================
```

### 5. 安装为应用
#### Chrome/Edge（桌面）
- 查看地址栏右侧，应该能看到安装图标（+ 或 🖥️）
- 点击图标，选择"安装 Zion Next"

#### Chrome（Android）
- 地址栏会显示安装提示
- 点击"安装"或"添加到主屏幕"

#### Safari（iOS）
- 点击分享按钮
- 选择"添加到主屏幕"

---

## 📦 构建生产版本

```bash
npm run build
npm run preview
```

**重要**：生产环境需要 **HTTPS** 才能使用 PWA 功能！

---

## 🎨 自定义图标（推荐）

当前使用的是蓝色占位图标。替换为你自己的 logo：

### 方法 1：使用在线工具
访问 [PWA Builder](https://www.pwabuilder.com/) 上传你的 logo，它会自动生成所有尺寸。

### 方法 2：手动创建
创建以下尺寸的 PNG 图标，保存到 `public/` 目录：
- `icon-192.png` (192x192)
- `icon-512.png` (512x512)
- `favicon.svg` (SVG 格式的 favicon)

### 方法 3：使用本地的图标文件
将你的图标文件复制到 `public/` 目录，并相应地更新 `manifest.json` 和 `vite.config.ts` 中的文件名。

---

## 📱 PWA 特性

### 离线功能
应用会自动缓存资源，即使断网也能打开（大部分功能）。

### 安装体验
- 独立窗口运行
- 添加到桌面/主屏幕
- 系统搜索可见

### 自动更新
Service Worker 会自动检查更新并提示用户。

---

## ⚙️ 高级配置

### 自定义缓存策略
编辑 `vite.config.ts` 中的 `VitePWA` 配置：

```typescript
VitePWA({
  workbox: {
    runtimeCaching: [
      {
        urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
        handler: 'CacheFirst',
        options: {
          cacheName: 'cdn-cache',
          expiration: {
            maxEntries: 10,
            maxAgeSeconds: 60 * 60 * 24 * 30
          }
        }
      }
    ]
  }
})
```

### 禁用开发环境的 PWA
编辑 `vite.config.ts`：

```typescript
VitePWA({
  devOptions: {
    enabled: false  // 设为 false
  }
})
```

---

## 🐛 故障排查

### 问题：Service Worker 不工作
- 确保使用 HTTPS 或 localhost
- 清除浏览器缓存和 Service Workers
- 检查控制台是否有错误

### 问题：无法安装应用
- 检查 manifest.json 格式是否正确
- 确认图标文件存在且路径正确
- 在 DevTools → Application → Manifest 中检查配置

### 问题：离线无法访问
- 打开 DevTools → Service Workers
- 检查是否有缓存的资源
- 尝试"Update on reload"

---

## 📚 参考资料

- [PWA 官方文档](https://web.dev/progressive-web-apps/)
- [vite-plugin-pwa 文档](https://github.com/vite-pwa/vite-plugin-pwa)
- [PWA 检查清单](https://web.dev/pwa-checklist/)

---

## 🎉 总结

Zion Next 现在已经支持 PWA 了！

✅ 可以离线使用
✅ 可以安装为应用
✅ 支持桌面和移动设备
✅ 自动更新机制

祝你使用愉快！🚀
