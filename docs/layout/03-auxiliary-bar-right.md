# 右侧辅助边栏 (Auxiliary Bar - Right)

右侧辅助边栏用于显示与编辑器内容相关的辅助信息，如预览、AI 对话产物、上下文信息等。相比左侧边栏，右侧边栏更注重与当前编辑器内容的关联性。所有已注册视图会自动出现在辅助栏右侧的窄导航栏中，以图标和标题纵向排列。

## 🎯 设计目标

- 提供与编辑器内容相关的辅助视图
- 通过右侧窄导航栏切换多个辅助视图
- 响应式：在小屏设备上自动隐藏
- 支持临时覆盖模式

## 📐 布局结构

```
┌──────────────────────────────────────┬────────────┬──────┐
│  EDITOR AREA                         │ AUXILIARY  │ VIEW │
│                                      │ CONTENT    │ RAIL │
│  Session: Chat with GPT              │            │  ◉   │
│  User: 帮我写一个脚本                 │ Preview    │预览  │
│  ────────────────────────────────    │            │  ◇   │
│  Assistant: 这是代码...               │            │文件  │
└──────────────────────────────────────┴────────────┴──────┘
```

右侧导航栏固定为紧凑宽度。标题过长时会省略显示，完整标题可通过悬停提示查看；导航项支持纵向拖拽排序。

## 🔧 扩展点定义

### Manifest 配置

```json
{
  "zion": {
    "contributes": {
      "auxiliaryBarViews": [
        {
          "id": "preview.view",
          "title": "Preview",
          "icon": "🌐",
          "order": 10,
          "when": "editorIsMarkdown"
        }
      ]
    }
  }
}
```

辅助视图不应再同时注册 `activityBarItems`；右侧导航栏已经提供同一视图的固定入口。Activity Bar 应保留给主工作区、左侧边栏和底部面板等一级入口。

### 属性说明

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string` | ✅ | 唯一标识符 |
| `title` | `string` | ✅ | 视图标题 |
| `icon` | `string \| SVG` | ❌ | 图标 |
| `order` | `number` | ❌ | 排序权重 |
| `when` | `string` | ❌ | 显示条件（通常关联编辑器状态） |
| `canClose` | `boolean` | ❌ | 是否可关闭 |

## 📝 API 使用

### 注册视图

`registerView` 同时注册视图内容和右侧导航项，不需要再单独注册导航按钮。`title`/`titleKey` 用作导航文字，`icon` 用作导航图标，`order` 控制初始顺序。

```javascript
export async function activate(ctx) {
  class PreviewComponent {
    constructor(container) {
      this.container = container;
      this.iframe = null;
      this.render();
      
      // 监听编辑器变化
      this.editorDisposable = window.zion.editor.onDidChange((e) => {
        this.updatePreview();
      });
    }
    
    render() {
      this.iframe = document.createElement('iframe');
      this.iframe.style.width = '100%';
      this.iframe.style.height = '100%';
      this.iframe.style.border = 'none';
      this.iframe.style.backgroundColor = '#fff';
      this.container.appendChild(this.iframe);
      
      this.updatePreview();
    }
    
    updatePreview() {
      const editor = window.zion.window.activeEditor;
      if (!editor || !this.iframe) return;
      
      const content = editor.getValue();
      this.iframe.srcdoc = this.renderHTML(content);
    }
    
    renderHTML(markdown) {
      // 简单的 Markdown 渲染
      const html = markdown
        .replace(/^# (.*$)/gm, '<h1>$1</h1>')
        .replace(/^## (.*$)/gm, '<h2>$1</h2>')
        .replace(/\*\*(.*)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');
      
      return `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; }
            h1 { border-bottom: 1px solid #eee; }
            code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
          </style>
        </head>
        <body>${html}</body>
        </html>
      `;
    }
    
    dispose() {
      if (this.editorDisposable) {
        this.editorDisposable.dispose();
      }
      this.container.innerHTML = '';
    }
  }
  
  const disposable = window.zion.auxiliaryBar.registerView({
    id: 'preview.view',
    pluginId: 'web-preview',
    title: 'Preview',
    icon: '🌐',
    location: 'auxiliarybar',
    component: (container) => new PreviewComponent(container),
    order: 10,
    when: 'editorIsMarkdown',
    
    onActivate: () => console.log('Preview activated'),
    onDeactivate: () => console.log('Preview deactivated'),
    onResize: ({ width, height }) => console.log('Preview resized:', width, height)
  });
  
  ctx.subscriptions.push(disposable);
}
```

### 控制辅助边栏

```javascript
// 激活视图
window.zion.auxiliaryBar.activateView('preview.view');

// 关闭视图
window.zion.auxiliaryBar.closeView('preview.view');

// 显示辅助边栏
window.zion.auxiliaryBar.show();

// 隐藏辅助边栏
window.zion.auxiliaryBar.hide();

// 切换辅助边栏
window.zion.auxiliaryBar.toggle();

// 设置宽度
window.zion.auxiliaryBar.setWidth(400);

// 获取所有视图
const views = window.zion.auxiliaryBar.getViews();
```

## 📱 响应式行为

### 桌面端 (> 1024px)

- 默认宽度：300px
- 完整显示
- 支持拖拽调整宽度

### 平板端 (768px - 1024px)

- 默认宽度：50% 屏幕宽度
- 以覆盖层形式显示
- 支持点击外部关闭

### 手机端 (< 768px)

- 默认隐藏
- 以全屏覆盖形式显示
- 需要手动打开

## 🎨 典型用例

### 1. Markdown 预览

```javascript
class MarkdownPreview {
  constructor(container) {
    this.container = container;
    this.render();
    this.bindEvents();
  }
  
  render() {
    this.container.innerHTML = `
      <div class="markdown-preview">
        <div class="preview-content"></div>
      </div>
    `;
  }
  
  bindEvents() {
    window.zion.events.on('editor:change', () => this.update());
    window.zion.events.on('editor:selection', () => this.syncScroll());
  }
  
  update() {
    const editor = window.zion.window.activeEditor;
    if (!editor) return;
    
    const markdown = editor.getValue();
    const html = this.markdownToHTML(markdown);
    this.container.querySelector('.preview-content').innerHTML = html;
  }
  
  markdownToHTML(markdown) {
    // Markdown 转换逻辑
    return markdown;
  }
  
  syncScroll() {
    // 同步滚动位置
    const editor = window.zion.window.activeEditor;
    if (!editor) return;
    
    const scrollInfo = editor.getScrollInfo();
    // 同步到预览区域
  }
  
  dispose() {
    // 清理
  }
}
```

### 2. AI 对话产物

```javascript
class ArtifactsPanel {
  constructor(container) {
    this.container = container;
    this.artifacts = [];
    this.render();
    this.bindEvents();
  }
  
  render() {
    this.container.innerHTML = `
      <div class="artifacts-panel">
        <div class="header">Generated Artifacts</div>
        <ul class="artifacts-list"></ul>
      </div>
    `;
  }
  
  bindEvents() {
    // 监听对话消息
    window.zion.events.on('chat:messageReceived', (msg) => {
      this.extractArtifacts(msg);
    });
    
    // 监听点击事件
    this.container.addEventListener('click', (e) => {
      const item = e.target.closest('[data-artifact-id]');
      if (item) {
        this.openArtifact(item.dataset.artifactId);
      }
    });
  }
  
  extractArtifacts(msg) {
    // 解析代码块、文件路径等
    const codeBlocks = msg.content.match(/```(\w+)?\n([\s\S]*?)```/g) || [];
    
    codeBlocks.forEach((block, index) => {
      const lang = block.match(/```(\w+)?/)?.[1] || 'text';
      const content = block.replace(/```\w*\n?/g, '').replace(/```\s*$/g, '');
      
      this.artifacts.push({
        id: `${Date.now()}-${index}`,
        type: 'code',
        language: lang,
        content: content,
        timestamp: Date.now()
      });
    });
    
    this.renderArtifacts();
  }
  
  renderArtifacts() {
    const list = this.container.querySelector('.artifacts-list');
    list.innerHTML = this.artifacts.map(artifact => `
      <li data-artifact-id="${artifact.id}">
        <div class="artifact-icon">📄</div>
        <div class="artifact-info">
          <div class="artifact-type">${artifact.type}</div>
          <div class="artifact-lang">${artifact.language}</div>
        </div>
        <div class="artifact-time">${new Date(artifact.timestamp).toLocaleTimeString()}</div>
      </li>
    `).join('');
  }
  
  openArtifact(id) {
    const artifact = this.artifacts.find(a => a.id === id);
    if (!artifact) return;
    
    // 在编辑器中打开
    window.zion.editor.open({
      content: artifact.content,
      language: artifact.language,
      title: `Artifact ${id}`
    });
  }
  
  dispose() {
    // 清理
  }
}
```

### 3. 上下文信息面板

```javascript
class ContextInspector {
  constructor(container) {
    this.container = container;
    this.render();
    this.bindEvents();
  }
  
  render() {
    this.container.innerHTML = `
      <div class="context-inspector">
        <div class="section">
          <h3>Token Usage</h3>
          <div class="stats">
            <div class="stat">
              <span class="label">Input:</span>
              <span class="value">1,234</span>
            </div>
            <div class="stat">
              <span class="label">Output:</span>
              <span class="value">567</span>
            </div>
            <div class="stat">
              <span class="label">Total:</span>
              <span class="value">1,801</span>
            </div>
          </div>
        </div>
        
        <div class="section">
          <h3>References</h3>
          <ul class="references"></ul>
        </div>
        
        <div class="section">
          <h3>Related Files</h3>
          <ul class="related-files"></ul>
        </div>
      </div>
    `;
  }
  
  bindEvents() {
    // 监听对话事件
    window.zion.events.on('chat:completed', (data) => {
      this.updateStats(data.usage);
    });
  }
  
  updateStats(usage) {
    // 更新统计信息
  }
  
  dispose() {
    // 清理
  }
}
```

## 🔄 生命周期示例

### 延迟加载

```javascript
class LazyPreview {
  constructor(container) {
    this.container = container;
    this.loaded = false;
    this.initialHTML = `
      <div class="preview-placeholder">
        <button class="load-preview">Load Preview</button>
      </div>
    `;
    this.container.innerHTML = this.initialHTML;
    
    this.bindEvents();
  }
  
  bindEvents() {
    this.container.querySelector('.load-preview')?.addEventListener('click', () => {
      this.load();
    });
  }
  
  async load() {
    if (this.loaded) return;
    
    this.container.innerHTML = '<div class="loading">Loading...</div>';
    
    // 加载预览库
    await import('marked');
    
    this.loaded = true;
    this.render();
  }
  
  render() {
    // 完整渲染
  }
  
  dispose() {
    // 清理
  }
}

const disposable = window.zion.auxiliaryBar.registerView({
  id: 'lazy.preview',
  pluginId: 'lazy-preview',
  title: 'Preview',
  icon: '🌐',
  location: 'auxiliarybar',
  component: (container) => new LazyPreview(container),
  
  // 只在激活时加载
  onActivate: async () => {
    const comp = new LazyPreview(this.container);
    await comp.load();
  }
});
```

## 📊 最佳实践

### 1. 条件显示

只在相关内容时显示：

```json
{
  "auxiliaryBarViews": [
    {
      "id": "preview.view",
      "title": "Preview",
      "when": "editorIsMarkdown || editorIsHTML"
    }
  ]
}
```

### 2. 状态同步

```javascript
class SyncedPreview {
  constructor(container) {
    this.container = container;
    this.render();
    this.syncEditorState();
  }
  
  syncEditorState() {
    const editor = window.zion.window.activeEditor;
    if (!editor) return;
    
    // 同步滚动位置
    this.syncScroll(editor);
    
    // 同步选中内容
    this.syncSelection(editor);
  }
  
  syncScroll(editor) {
    // 实现滚动同步
  }
  
  syncSelection(editor) {
    // 实现选区同步
  }
}
```

### 3. 响应式内容

```javascript
class ResponsivePreview {
  render() {
    const width = this.container.clientWidth;
    
    if (width < 300) {
      // 紧凑模式
      this.renderCompact();
    } else {
      // 完整模式
      this.renderFull();
    }
  }
  
  renderCompact() {
    this.container.innerHTML = '<div>Compact view</div>';
  }
  
  renderFull() {
    this.container.innerHTML = '<div>Full view</div>';
  }
}
```

## 🔗 相关文档

- [扩展点总览](./01-extension-points.md)
- [响应式设计](./08-responsive-design.md)
- [插件开发指南](./09-plugin-guide.md)
