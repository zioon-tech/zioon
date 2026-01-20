# 底部面板 (Bottom Panel)

底部面板位于编辑器下方，用于显示辅助功能和信息面板，如终端、输出日志、问题列表等。支持多个可切换的视图。

## 🎯 设计目标

- 提供功能性的辅助面板
- 支持多个视图切换
- 可调整高度
- 支持最大化/恢复

## 📐 布局结构

```
┌─────────────────────────────────────────────────────────────┐
│  EDITOR AREA                                                 │
├─────────────────────────────────────────────────────────────┤
│  BOTTOM PANEL                                                │
│  [Terminal] [Output] [Problems] [Debug]                      │
│  ┌────────────────────────────────────────────────────┐    │
│  │ > npm install                                      │    │
│  │                                                     │    │
│  └────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────┤
│  STATUS BAR (left | center | right)                         │
│  Ln 1, Col 5 │ UTF-8 │ Ready │ Branch: main                │
└─────────────────────────────────────────────────────────────┘
```

## 🔧 扩展点定义

### Manifest 配置

```json
{
  "zion": {
    "contributes": {
      "activityBarItems": [
        {
          "id": "terminal.activity",
          "icon": "⌨️",
          "tooltip": "Terminal",
          "bottomPanelViewId": "terminal.view",
          "order": 30
        }
      ],
      "bottomPanelViews": [
        {
          "id": "terminal.view",
          "title": "Terminal",
          "icon": "⌨️",
          "order": 10
        },
        {
          "id": "output.view",
          "title": "Output",
          "icon": "📄",
          "order": 20
        },
        {
          "id": "problems.view",
          "title": "Problems",
          "icon": "⚠️",
          "order": 30
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
| `title` | `string` | ✅ | 视图标题 |
| `icon` | `string \| SVG` | ❌ | 图标 |
| `order` | `number` | ❌ | 排序权重 |
| `when` | `string` | ❌ | 显示条件 |
| `keepWhenActive` | `boolean` | ❌ | 切换到其他视图时是否保持状态 |
| `maximizable` | `boolean` | ❌ | 是否可最大化 |

## 📝 API 使用

### 注册视图

```javascript
export async function activate(ctx) {
  class TerminalComponent {
    constructor(container) {
      this.container = container;
      this.terminal = null;
      this.render();
    }
    
    render() {
      this.container.innerHTML = `
        <div class="terminal-container">
          <div class="terminal-output"></div>
          <div class="terminal-input-line">
            <span class="prompt">$</span>
            <input type="text" class="terminal-input" autofocus />
          </div>
        </div>
      `;
      
      this.bindEvents();
    }
    
    bindEvents() {
      const input = this.container.querySelector('.terminal-input');
      input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          this.executeCommand(input.value);
          input.value = '';
        }
      });
    }
    
    executeCommand(cmd) {
      const output = this.container.querySelector('.terminal-output');
      const line = document.createElement('div');
      line.className = 'terminal-line';
      line.innerHTML = `<span class="prompt">$</span> ${this.escapeHtml(cmd)}`;
      output.appendChild(line);
      
      // 模拟执行
      const result = document.createElement('div');
      result.className = 'terminal-result';
      result.textContent = `Executed: ${cmd}`;
      output.appendChild(result);
      
      // 滚动到底部
      this.container.scrollTop = this.container.scrollHeight;
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
  
  const disposable = window.zion.bottomPanel.registerView({
    id: 'terminal.view',
    pluginId: 'terminal-plugin',
    title: 'Terminal',
    icon: '⌨️',
    location: 'bottompanel',
    component: (container) => new TerminalComponent(container),
    order: 10,
    keepWhenActive: true,
    maximizable: true
  });
  
  ctx.subscriptions.push(disposable);
}
```

### 控制底部面板

```javascript
// 激活视图
window.zion.bottomPanel.activateView('terminal.view');

// 关闭视图
window.zion.bottomPanel.closeView('terminal.view');

// 显示底部面板
window.zion.bottomPanel.show();

// 隐藏底部面板
window.zion.bottomPanel.hide();

// 切换底部面板
window.zion.bottomPanel.toggle();

// 设置高度
window.zion.bottomPanel.setHeight(200);

// 最大化
window.zion.bottomPanel.maximize();

// 恢复
window.zion.bottomPanel.restore();

// 获取所有视图
const views = window.zion.bottomPanel.getViews();
```

## 📱 响应式行为

### 桌面端 (> 1024px)

- 默认高度：200px
- 完整显示所有视图标签
- 支持拖拽调整高度
- 支持最大化/恢复

### 平板端 (768px - 1024px)

- 默认高度：180px
- 视图标签可能简化

### 手机端 (< 768px)

- 默认隐藏
- 以全屏覆盖形式显示
- 视图标签变成底部导航

## 🎨 典型用例

### 1. 终端面板

```javascript
class TerminalPanel {
  constructor(container) {
    this.container = container;
    this.history = [];
    this.historyIndex = -1;
    this.render();
    this.bindEvents();
  }
  
  render() {
    this.container.innerHTML = `
      <div class="terminal-panel">
        <div class="terminal-toolbar">
          <button class="clear-btn">Clear</button>
          <select class="shell-select">
            <option value="bash">bash</option>
            <option value="zsh">zsh</option>
            <option value="powershell">powershell</option>
          </select>
        </div>
        <div class="terminal-output"></div>
        <div class="terminal-input-line">
          <span class="prompt">$</span>
          <input type="text" class="terminal-input" spellcheck="false" />
        </div>
      </div>
    `;
  }
  
  bindEvents() {
    const input = this.container.querySelector('.terminal-input');
    input?.addEventListener('keydown', (e) => this.onKeyDown(e));
    
    this.container.querySelector('.clear-btn')?.addEventListener('click', () => {
      this.clear();
    });
  }
  
  onKeyDown(e) {
    const input = e.target;
    
    if (e.key === 'Enter') {
      this.executeCommand(input.value);
      input.value = '';
      this.history.push(input.value);
      this.historyIndex = this.history.length;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (this.historyIndex > 0) {
        this.historyIndex--;
        input.value = this.history[this.historyIndex];
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.historyIndex < this.history.length - 1) {
        this.historyIndex++;
        input.value = this.history[this.historyIndex];
      } else {
        this.historyIndex = this.history.length;
        input.value = '';
      }
    }
  }
  
  executeCommand(cmd) {
    if (!cmd.trim()) return;
    
    const output = this.container.querySelector('.terminal-output');
    
    // 添加命令行
    const line = document.createElement('div');
    line.className = 'terminal-line';
    line.innerHTML = `<span class="prompt">$</span> ${this.escapeHtml(cmd)}`;
    output.appendChild(line);
    
    // 添加结果
    const result = document.createElement('div');
    result.className = 'terminal-result';
    result.textContent = this.simulateExecution(cmd);
    output.appendChild(result);
    
    // 滚动到底部
    output.scrollTop = output.scrollHeight;
  }
  
  simulateExecution(cmd) {
    // 模拟命令执行
    if (cmd === 'ls') {
      return 'file1.txt  file2.js  folder1/';
    } else if (cmd === 'pwd') {
      return '/Users/username/project';
    } else if (cmd.startsWith('echo ')) {
      return cmd.substring(5);
    } else {
      return `Command not found: ${cmd.split(' ')[0]}`;
    }
  }
  
  clear() {
    this.container.querySelector('.terminal-output').innerHTML = '';
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
```

### 2. 输出面板

```javascript
class OutputPanel {
  constructor(container) {
    this.container = container;
    this.channels = {};
    this.activeChannel = 'general';
    this.render();
    this.bindEvents();
  }
  
  render() {
    this.container.innerHTML = `
      <div class="output-panel">
        <div class="output-tabs">
          <button class="tab active" data-channel="general">General</button>
          <button class="tab" data-channel="extension">Extension</button>
          <button class="tab" data-channel="compiler">Compiler</button>
          <button class="clear-all">Clear All</button>
        </div>
        <div class="output-content"></div>
      </div>
    `;
  }
  
  bindEvents() {
    // 标签切换
    this.container.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-channel]');
      if (tab) {
        this.switchChannel(tab.dataset.channel);
      }
      
      if (e.target.classList.contains('clear-all')) {
        this.clearAll();
      }
    });
  }
  
  switchChannel(channel) {
    this.activeChannel = channel;
    
    // 更新标签状态
    this.container.querySelectorAll('.tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.channel === channel);
    });
    
    // 渲染内容
    this.renderContent();
  }
  
  renderContent() {
    const content = this.container.querySelector('.output-content');
    content.innerHTML = '';
    
    const messages = this.channels[this.activeChannel] || [];
    messages.forEach(msg => {
      const line = document.createElement('div');
      line.className = `output-line ${msg.level}`;
      line.innerHTML = `<span class="timestamp">${msg.time}</span> ${this.escapeHtml(msg.text)}`;
      content.appendChild(line);
    });
    
    content.scrollTop = content.scrollHeight;
  }
  
  log(channel, level, text) {
    if (!this.channels[channel]) {
      this.channels[channel] = [];
    }
    
    this.channels[channel].push({
      level,
      text,
      time: new Date().toLocaleTimeString()
    });
    
    if (channel === this.activeChannel) {
      this.renderContent();
    }
  }
  
  clearAll() {
    this.channels = {};
    this.renderContent();
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
```

### 3. 问题面板

```javascript
class ProblemsPanel {
  constructor(container) {
    this.container = container;
    this.problems = [];
    this.render();
    this.bindEvents();
  }
  
  render() {
    this.container.innerHTML = `
      <div class="problems-panel">
        <div class="problems-toolbar">
          <select class="filter-select">
            <option value="all">All Problems</option>
            <option value="error">Errors only</option>
            <option value="warning">Warnings only</option>
          </select>
          <button class="clear-fixes">Clear Fixes</button>
        </div>
        <div class="problems-list"></div>
      </div>
    `;
  }
  
  bindEvents() {
    this.container.addEventListener('click', (e) => {
      const item = e.target.closest('[data-problem-id]');
      if (item) {
        this.openProblem(item.dataset.problemId);
      }
      
      const filter = e.target.closest('.filter-select');
      if (filter) {
        this.filterProblems(filter.value);
      }
    });
  }
  
  addProblem(problem) {
    this.problems.push(problem);
    this.renderProblems();
  }
  
  renderProblems(filter = 'all') {
    const list = this.container.querySelector('.problems-list');
    list.innerHTML = '';
    
    let filtered = this.problems;
    if (filter !== 'all') {
      filtered = this.problems.filter(p => p.severity === filter);
    }
    
    if (filtered.length === 0) {
      list.innerHTML = '<div class="empty-state">No problems</div>';
      return;
    }
    
    filtered.forEach(problem => {
      const item = document.createElement('div');
      item.className = `problem-item ${problem.severity}`;
      item.dataset.problemId = problem.id;
      item.innerHTML = `
        <div class="problem-icon">${this.getSeverityIcon(problem.severity)}</div>
        <div class="problem-info">
          <div class="problem-message">${this.escapeHtml(problem.message)}</div>
          <div class="problem-location">${problem.file}:${problem.line}:${problem.column}</div>
        </div>
        <button class="problem-fix">Fix</button>
      `;
      list.appendChild(item);
    });
  }
  
  getSeverityIcon(severity) {
    const icons = {
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️'
    };
    return icons[severity] || '•';
  }
  
  openProblem(id) {
    const problem = this.problems.find(p => p.id === id);
    if (!problem) return;
    
    // 打开文件并跳转到对应位置
    window.zion.editor.open({
      path: problem.file,
      line: problem.line,
      column: problem.column
    });
  }
  
  filterProblems(filter) {
    this.renderProblems(filter);
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
```

## 🔄 状态保持

### keepWhenActive 选项

```javascript
// 设置为 true，切换到其他视图时保持状态
const disposable = window.zion.bottomPanel.registerView({
  id: 'terminal.view',
  component: TerminalComponent,
  keepWhenActive: true
});
```

### 生命周期管理

```javascript
class StatefulPanel {
  constructor(container) {
    this.container = container;
    this.state = {
      scrollPosition: 0,
      selectedItems: [],
      filter: 'all'
    };
    this.render();
  }
  
  saveState() {
    this.state.scrollPosition = this.container.scrollTop;
    this.state.selectedItems = this.getSelectedItems();
    this.state.filter = this.getFilter();
  }
  
  restoreState() {
    this.container.scrollTop = this.state.scrollPosition;
    this.restoreSelection(this.state.selectedItems);
    this.setFilter(this.state.filter);
  }
  
  onActivate() {
    this.restoreState();
  }
  
  onDeactivate() {
    this.saveState();
  }
}
```

## 📊 最佳实践

### 1. 性能优化（虚拟滚动）

```javascript
class VirtualScrollPanel {
  constructor(container, items) {
    this.container = container;
    this.items = items;
    this.visibleStart = 0;
    this.visibleEnd = 50;
    this.itemHeight = 24;
    this.render();
    
    this.container.addEventListener('scroll', () => this.onScroll());
  }
  
  onScroll() {
    const scrollTop = this.container.scrollTop;
    this.visibleStart = Math.floor(scrollTop / this.itemHeight);
    this.visibleEnd = this.visibleStart + 50;
    this.renderVisibleItems();
  }
  
  render() {
    this.container.style.height = `${this.items.length * this.itemHeight}px`;
    this.renderVisibleItems();
  }
  
  renderVisibleItems() {
    const visibleItems = this.items.slice(this.visibleStart, this.visibleEnd);
    // 只渲染可见项
  }
}
```

### 2. 自动滚动

```javascript
class AutoScrollPanel {
  constructor(container) {
    this.container = container;
    this.autoScroll = true;
    this.render();
  }
  
  addLine(line) {
    const lineElement = document.createElement('div');
    lineElement.textContent = line;
    this.container.appendChild(lineElement);
    
    if (this.autoScroll) {
      this.container.scrollTop = this.container.scrollHeight;
    }
  }
  
  toggleAutoScroll() {
    this.autoScroll = !this.autoScroll;
  }
}
```

## 🔗 相关文档

- [扩展点总览](./01-extension-points.md)
- [响应式设计](./08-responsive-design.md)
- [插件开发指南](./09-plugin-guide.md)
