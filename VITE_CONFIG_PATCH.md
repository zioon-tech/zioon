# Vite Config 补丁 - 添加 /src/plugins 支持

需要手动更新 vite.config.ts 文件，在 manualChunks 函数中添加以下逻辑：

```typescript
// 在 manualChunks 函数开头添加

// 内置插件代码单独打包
if (id.includes('/src/plugins/')) {
  const match = id.match(/\/src\/plugins\/([^/]+)/);
  if (match) {
    return `plugins/${match[1]}`;
  }
}

// 然后是现有的 extensions 处理
if (id.includes('/extensions/')) {
  const match = id.match(/\/extensions\/([^/]+)/);
  if (match) {
    return `extensions/${match[1]}`;
  }
}
```

完整的 manualChunks 应该是：

```typescript
manualChunks: (id) => {
  // 内置插件代码单独打包
  if (id.includes('/src/plugins/')) {
    const match = id.match(/\/src\/plugins\/([^/]+)/);
    if (match) {
      return `plugins/${match[1]}`;
    }
  }
  // 扩展插件代码单独打包（向后兼容）
  if (id.includes('/extensions/')) {
    const match = id.match(/\/extensions\/([^/]+)/);
    if (match) {
      return `extensions/${match[1]}`;
    }
  }
  // 第三方依赖按包名分组
  if (id.includes('node_modules/')) {
    const match = id.match(/node_modules\/([^/]+)/);
    if (match) {
      return `vendor/${match[1]}`;
    }
  }
  return null;
}
```
