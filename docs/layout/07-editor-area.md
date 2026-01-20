# 编辑器区域 (Editor Area)

编辑器区域是 Zion Next 的核心区域，用于显示和编辑内容。支持多个标签页、编辑器分组和不同的语言模式。

## 🎯 设计目标

- 提供统一的内容编辑容器
- 支持多个标签页
- 支持编辑器分组（分屏）
- 支持不同语言和文件类型
- 响应式适配不同设备

## 📐 布局结构

```
┌─────────────────────────────────────────────────────────────┐
│  TABS                                                        │
│  ┌────────────┬──────────┬────────────┬──────────────┐   │
│  │ Chat       │ main.js  │ README.md │       [x]    │   │
│  └────────────┴──────────┴────────────┴──────────────┘   │
├─────────────────────────────────────────────────────────────┤
│  EDITOR CONTENT                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │ Session: Chat with GPT                            │    │
│  │ User: 帮我写一个 Python 脚本                      │    │
│  │ ────────────────────────────────────────────────── │    │
│  │ Assistant: 好的，这是代码...                       │    │
│  │ ────────────────────────────────────────────────── │    │
│  │                                                     │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘

分屏布局：
┌─────────────┬─────────────┐
│  Group A    │  Group B    │
│  ┌─────────┐│  ┌─────────┐│
│  │ Tab 1   ││  │ Tab 2   ││
│  │         ││  │         ││
│  │         ││  │         ││
│  └─────────┘│  └─────────┘│
└─────────────┴─────────────┘
```

## 🔧 扩展点定义

### Manifest 配置

```json
{
  "zion": {
    "contributes": {
      "editorTabs": [
        {
          "id": "chat.editor",
          "title": "Chat",
          "icon": "💬",
          "language": "markdown",
          "readOnly": false,
          "closeable": true
        },
        {
          "id": "code.editor",
          "title": "main.js",
          "icon": "📄",
          "language": "javascript",
          "readOnly": false
        }
      ]
    }
  }
}
```

### 属性说明

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string` | ✅ | 唯一标识符 |
| `title` | `string` | ✅ | 标签标题 |
| `icon` | `string \| SVG` | ❌ | 标签图标 |
| `tooltip` | `string` | ❌ | 鼠标悬停提示 |
| `language` | `string` | ❌ | 语言模式（markdown, javascript, python 等） |
| `content` | `string` | ❌ | 初始内容 |
| `component` | `HTMLElement \| Function` | ❌ | 自定义组件 |
| `readOnly` | `boolean` | ❌ | 是否只读（默认 `false`） |
| `closeable` | `boolean` | ❌ | 是否可关闭（默认 `true`） |
| `groupId` | `string` | ❌ | 所属编辑器组 ID |

## 📝 API 使用

### 打开标签页

```javascript
// 打开简单文本编辑器
window.zion.editorArea.openTab({
  id: 'my.editor',
  pluginId: 'my-plugin',
  title: 'My Document',
  icon: '📄',
  language: 'markdown',
  content: '# Hello World\n\nThis is a test document.',
  readOnly: false,
  closeable: true
});

// 打开代码编辑器
window.zion.editorArea.openTab({
  id: 'code.editor',
  pluginId: 'my-plugin',
  title: 'main.js',
  language: 'javascript',
  content: 'console.log("Hello, World!");',
  readOnly: false
});

// 使用自定义组件
class CustomEditor {
  constructor(container) {
    this.container = container;
    this.render();
  }
  
  render() {
    this.container.innerHTML = `
      <div class="custom-editor">
        <textarea spellcheck="false"></textarea>
      </div>
    `;
  }
  
  dispose() {
    this.container.innerHTML = '';
  }
}

window.zion.editorArea.openTab({
  id: 'custom.editor',
  pluginId: 'my-plugin',
  title: 'Custom Editor',
  component: (container) => new CustomEditor(container)
});
```

### 控制标签页

```javascript
// 激活标签
window.zion.editorArea.activateTab('chat.editor');

// 关闭标签
window.zion.editorArea.closeTab('chat.editor');

// 获取所有标签
const tabs = window.zion.editorArea.getTabs();

// 获取当前激活的标签
const activeTab = window.zion.editorArea.getActiveTab();
```

### 编辑器分组

```javascript
// 创建新分组（垂直分屏）
const groupId = window.zion.editorArea.createGroup({
  orientation: 'vertical',
  splitRatio: 0.5
});

// 在指定分组中打开标签
window.zion.editorArea.openTab({
  id: 'new.editor',
  title: 'New Tab',
  groupId: groupId
});

// 关闭分组
window.zion.editorArea.closeGroup(groupId);

// 获取所有分组
const groups = window.zion.editorArea.getGroups();
```

## 🎨 自定义编辑器组件

### 1. 简单编辑器

```javascript
class SimpleEditor {
  constructor(container, options) {
    this.container = container;
    this.options = options;
    this.textarea = null;
    this.render();
  }
  
  render() {
    this.container.innerHTML = `
      <div class="simple-editor">
        <div class="editor-toolbar">
          <button class="bold">B</button>
          <button class="italic">I</button>
          <button class="link">🔗</button>
        </div>
        <div class="editor-content">
          <textarea class="editor-textarea" spellcheck="false"></textarea>
        </div>
      </div>
    `;
    
    this.textarea = this.container.querySelector('.editor-textarea');
    if (this.options.content) {
      this.textarea.value = this.options.content;
    }
    
    this.bindEvents();
  }
  
  bindEvents() {
    // 工具栏按钮
    this.container.querySelector('.bold')?.addEventListener('click', () => {
      this.insertText('**', '**');
    });
    
    this.container.querySelector('.italic')?.addEventListener('click', () => {
      this.insertText('*', '*');
    });
    
    // 监听内容变化
    this.textarea?.addEventListener('input', () => {
      this.emit('change', this.textarea.value);
    });
  }
  
  insertText(before, after) {
    const start = this.textarea.selectionStart;
    const end = this.textarea.selectionEnd;
    const text = this.textarea.value;
    const selected = text.substring(start, end);
    
    this.textarea.value =
      text.substring(0, start) + before + selected + after + text.substring(end);
    
    this.textarea.focus();
    this.textarea.setSelectionRange(start + before.length, end + before.length);
    
    this.emit('change', this.textarea.value);
  }
  
  getValue() {
    return this.textarea?.value || '';
  }
  
  setValue(value) {
    if (this.textarea) {
      this.textarea.value = value;
    }
  }
  
  emit(event, data) {
    window.zion.events.emit(`editor:${event}`, {
      editorId: this.options.id,
      data
    });
  }
  
  dispose() {
    this.container.innerHTML = '';
  }
}

// 使用
window.zion.editorArea.openTab({
  id: 'simple.editor',
  title: 'Simple Editor',
  component: (container, options) => new SimpleEditor(container, options)
});
```

### 2. Markdown 编辑器

```javascript
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';

class MarkdownEditor {
  constructor(container, options) {
    this.container = container;
    this.options = options;
    this.view = null;
    this.render();
  }
  
  render() {
    this.view = new EditorView({
      doc: this.options.content || '',
      extensions: [
        basicSetup,
        markdown()
      ],
      parent: this.container
    });
  }
  
  getValue() {
    return this.view.state.doc.toString();
  }
  
  setValue(value) {
    const transaction = this.view.state.update({
      changes: {
        from: 0,
        to: this.view.state.doc.length,
        insert: value
      }
    });
    this.view.dispatch(transaction);
  }
  
  dispose() {
    this.view?.destroy();
    this.container.innerHTML = '';
  }
}

// 使用
window.zion.editorArea.openTab({
  id: 'markdown.editor',
  title: 'README.md',
  language: 'markdown',
  component: (container, options) => new MarkdownEditor(container, options)
});
```

### 3. 对话编辑器

```javascript
class ChatEditor {
  constructor(container, options) {
    this.container = container;
    this.options = options;
    this.messages = options.messages || [];
    this.render();
  }
  
  render() {
    this.container.innerHTML = `
      <div class="chat-editor">
        <div class="chat-messages"></div>
        <div class="chat-input-area">
          <textarea class="chat-input" placeholder="Type your message..."></textarea>
          <button class="send-btn">Send</button>
        </div>
      </div>
    `;
    
    this.renderMessages();
    this.bindEvents();
  }
  
  renderMessages() {
    const messagesContainer = this.container.querySelector('.chat-messages');
    messagesContainer.innerHTML = this.messages.map(msg => `
      <div class="chat-message ${msg.role}">
        <div class="message-avatar">${msg.role === 'user' ? '👤' : '🤖'}</div>
        <div class="message-content">${this.escapeHtml(msg.content)}</div>
      </div>
    `).join('');
    
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
  
  bindEvents() {
    const input = this.container.querySelector('.chat-input');
    const sendBtn = this.container.querySelector('.send-btn');
    
    const sendMessage = () => {
      const content = input.value.trim();
      if (!content) return;
      
      this.messages.push({
        role: 'user',
        content: content,
        timestamp: Date.now()
      });
      
      input.value = '';
      this.renderMessages();
      
      // 触发发送事件
      window.zion.events.emit('chat:messageSent', {
        content,
        editorId: this.options.id
      });
    };
    
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    
    sendBtn?.addEventListener('click', sendMessage);
  }
  
  addMessage(role, content) {
    this.messages.push({
      role,
      content,
      timestamp: Date.now()
    });
    this.renderMessages();
  }
  
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  dispose() {
    this.container.innerHTML = '';
  }
}

// 使用
window.zion.editorArea.openTab({
  id: 'chat.session',
  title: 'Chat Session',
  icon: '💬',
  component: (container, options) => new ChatEditor(container, {
    ...options,
    messages: [
      { role: 'assistant', content: 'Hello! How can I help you today?' }
    ]
  })
});
```

## 🔄 生命周期

### 激活时

```javascript
window.zion.editorArea.openTab({
  id: 'my.editor',
  title: 'My Editor',
  component: MyEditorComponent,
  
  onActivate: () => {
    console.log('Editor activated');
    // 加载数据、恢复状态等
  }
});
```

### 停用时

```javascript
window.zion.editorArea.openTab({
  id: 'my.editor',
  title: 'My Editor',
  component: MyEditorComponent,
  
  onDeactivate: () => {
    console.log('Editor deactivated');
    // 保存状态、暂停定时器等
  }
});
```

### 关闭时

```javascript
window.zion.editorArea.openTab({
  id: 'my.editor',
  title: 'My Editor',
  component: MyEditorComponent,
  
  onClose: () => {
    const confirm = window.confirm('Unsaved changes! Close anyway?');
    return confirm; // 返回 false 阻止关闭
  },
  
  onSave: () => {
    console.log('Saving...');
    // 保存内容
  }
});
```

## 📱 响应式行为

### 桌面端 (> 1024px)

- 支持多标签
- 支持分屏
- 完整的工具栏

### 平板端 (768px - 1024px)

- 支持多标签
- 分屏可能简化为单一视图
- 工具栏可能简化

### 手机端 (< 768px)

- 单一标签页
- 全屏编辑模式
- 最简工具栏

## 📊 最佳实践

### 1. 状态保存和恢复

```javascript
class StatefulEditor {
  constructor(container, options) {
    this.container = container;
    this.options = options;
    this.stateKey = `editor.state.${options.id}`;
    this.render();
    this.restoreState();
  }
  
  saveState() {
    const state = {
      content: this.getValue(),
      cursorPosition: this.getCursorPosition(),
      scrollPosition: this.getScrollPosition()
    };
    
    window.zion.state.set(this.stateKey, state);
  }
  
  restoreState() {
    const savedState = window.zion.state.get(this.stateKey);
    if (savedState) {
      this.setValue(savedState.content);
      this.setCursorPosition(savedState.cursorPosition);
      this.setScrollPosition(savedState.scrollPosition);
    }
  }
  
  onDeactivate() {
    this.saveState();
  }
}
```

### 2. 自动保存

```javascript
import { debounce } from 'lodash-es';

class AutoSaveEditor {
  constructor(container, options) {
    this.container = container;
    this.options = options;
    this.autoSaveKey = `editor.autosave.${options.id}`;
    this.render();
    this.setupAutoSave();
  }
  
  setupAutoSave() {
    // 防抖自动保存
    const debouncedSave = debounce(() => {
      this.save();
    }, 2000);
    
    this.container.addEventListener('input', () => {
      debouncedSave();
    });
  }
  
  save() {
    const content = this.getValue();
    localStorage.setItem(this.autoSaveKey, content);
    
    window.zion.events.emit('editor:saved', {
      editorId: this.options.id,
      content
    });
  }
  
  load() {
    const content = localStorage.getItem(this.autoSaveKey);
    if (content) {
      this.setValue(content);
    }
  }
}
```

### 3. 快捷键支持

```javascript
class ShortcutEditor {
  constructor(container, options) {
    this.container = container;
    this.options = options;
    this.render();
    this.bindShortcuts();
  }
  
  bindShortcuts() {
    document.addEventListener('keydown', (e) => {
      // 只在编辑器激活时处理
      if (this.options.id !== window.zion.editorArea.getActiveTab()?.id) {
        return;
      }
      
      // Ctrl+S / Cmd+S - 保存
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        this.save();
      }
      
      // Ctrl+F / Cmd+F - 查找
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        this.showFindDialog();
      }
      
      // Ctrl+/ / Cmd+/ - 注释
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        this.toggleComment();
      }
    });
  }
  
  save() {
    console.log('Saving...');
  }
  
  showFindDialog() {
    console.log('Find dialog...');
  }
  
  toggleComment() {
    console.log('Toggle comment...');
  }
}
```

### 4. 性能优化（大文件）

```javascript
class OptimizedEditor {
  constructor(container, options) {
    this.container = container;
    this.options = options;
    this.virtualLines = null;
    this.render();
    
    if (options.content && options.content.length > 100000) {
      this.setupVirtualization();
    }
  }
  
  setupVirtualization() {
    // 虚拟滚动实现
    const lineCount = this.options.content.split('\n').length;
    const lineHeight = 20;
    const visibleLines = Math.ceil(this.container.clientHeight / lineHeight);
    
    this.virtualLines = {
      total: lineCount,
      visible: visibleLines,
      start: 0,
      end: visibleLines
    };
    
    this.container.addEventListener('scroll', () => {
      this.updateVirtualLines();
    });
  }
  
  updateVirtualLines() {
    if (!this.virtualLines) return;
    
    const scrollTop = this.container.scrollTop;
    const lineHeight = 20;
    
    this.virtualLines.start = Math.floor(scrollTop / lineHeight);
    this.virtualLines.end = this.virtualLines.start + this.virtualLines.visible;
    
    this.renderVisibleLines();
  }
  
  renderVisibleLines() {
    // 只渲染可见行
  }
}
```

## 🔗 相关文档

- [扩展点总览](./01-extension-points.md)
- [响应式设计](./08-responsive-design.md)
- [插件开发指南](./09-plugin-guide.md)
