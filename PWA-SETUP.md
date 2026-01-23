# Zion Next PWA 配置指南

## 已完成的配置

### 1. 安装了 `vite-plugin-pwa`
```bash
npm install -D vite-plugin-pwa
```

### 2. 创建了 PWA 必需的文件

#### 2.1 Web App Manifest (`public/manifest.json`)
- 应用名称：Zion Next
- 图标：192x192, 512x512 (PNG格式)
- 主题色：#2563eb (蓝色)
- 显示模式：standalone (独立窗口)

#### 2.2 应用图标 (`public/icon-192.png`, `public/icon-512.png`)
- 生成了占位图标（蓝色背景）
- ⚠️ **注意**：需要替换为实际的 Zion Next logo

#### 2.3 更新 HTML (`index.html`)
- 添加了 manifest 链接
- 添加了 theme-color meta 标签
- 添加了 apple-touch-icon (iOS 支持)

### 3. 更新 Vite 配置 (`vite.config.ts`)
- 添加了 VitePWA 插件
- 配置了自动更新模式
- 在开发环境也启用了 PWA

---

## 如何测试 PWA 功能

### 1. 启动开发服务器
```bash
npm run dev
```

### 2. 在浏览器中测试

#### Chrome DevTools 检查
1. 按 `F12` 打开开发者工具
2. 转到 **Application** 标签
3. 检查以下部分：
   - **Manifest**: 应该能看到 manifest.json 的内容
   - **Service Workers**: 应该能看到已注册的 Service Worker
   - **Service Worker Cache**: 应该能看到缓存的资源

#### 检查可安装性
1. 查看 Chrome 地址栏右侧
2. 应该能看到一个安装图标（+ 号或电脑图标）
3. 点击图标可以安装 PWA

### 3. 测试离线功能
1. 打开 DevTools → Network 标签
2. 勾选 **Offline** 模式
3. 刷新页面，应用应该仍然可以工作（部分功能）

### 4. 生产构建测试
```bash
npm run build
npm run preview
```

---

## 部署注意事项

### 1. HTTPS 要求
PWA **必须** 通过 HTTPS 服务才能正常工作（localhost 除外）

### 2. 推荐的部署平台
- **Vercel**: 自动 HTTPS，推荐
- **Netlify**: 自动 HTTPS
- **GitHub Pages**: 自动 HTTPS
- 自己的服务器：需要配置 HTTPS 证书（Let's Encrypt）

---

## 下一步优化建议

### 1. 替换应用图标
需要创建高质量的图标：
```bash
# 建议的图标尺寸
- 72x72    - Android
- 96x96    - Chrome Web Store
- 128x128  - Windows Store
- 144x144  - iOS (iPad)
- 152x152  - iOS (iPad)
- 192x192  - Android / Chrome / PWA 标准
- 384x384  - Android
- 512x512  - PWA 标准 / Chrome Web Store
```

### 2. 添加启动画面
在 `manifest.json` 中添加：
```json
"screenshots": [
  {
    "src": "/screenshot-wide.png",
    "sizes": "1280x720",
    "type": "image/png",
    "form_factor": "wide"
  },
  {
    "src": "/screenshot-narrow.png",
    "sizes": "750x1334",
    "type": "image/png",
    "form_factor": "narrow"
  }
]
```

### 3. 优化缓存策略
在 `vite.config.ts` 中可以自定义缓存策略：
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
            maxAgeSeconds: 60 * 60 * 24 * 30 // 30 days
          }
        }
      }
    ]
  }
})
```

### 4. 添加应用更新提示
在应用代码中添加更新通知：
```typescript
// 在 main.ts 或应用初始化时
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Service Worker 更新，提示用户刷新
    window.location.reload();
  });
}
```

---

## PWA 功能清单

✅ **已完成**
- [x] Web App Manifest
- [x] Service Worker 注册
- [x] 应用图标 (192x192, 512x512)
- [x] 主题色配置
- [x] 独立窗口模式
- [x] HTML meta 标签
- [x] iOS 支持 (apple-touch-icon)
- [x] 自动更新机制

📋 **可选优化**
- [ ] 高质量应用图标
- [ ] 启动画面
- [ ] 应用截图
- [ ] 自定义缓存策略
- [ ] 更新提示 UI
- [ ] 推送通知
- [ ] 后台同步
- [ ] 分享目标 API

---

## 参考资源

- [PWA 文档](https://web.developers.google.cn/learn/pwa)
- [vite-plugin-pwa 文档](https://github.com/vite-pwa/vite-plugin-pwa)
- [PWA 检查清单](https://web.dev/pwa-checklist/)
- [PWA Builder](https://www.pwabuilder.com/)

---

## 故障排查

### 问题：Service Worker 不注册
- 检查是否使用 HTTPS（或 localhost）
- 检查控制台是否有错误信息
- 清除浏览器缓存后重试

### 问题：应用无法安装
- 确认 manifest.json 路径正确
- 确认图标文件存在
- 使用 Chrome DevTools → Application → Manifest 检查

### 问题：离线无法访问
- 检查 Service Worker 是否激活
- 检查缓存的资源列表
- 尝试注销 Service Worker 后重新注册
