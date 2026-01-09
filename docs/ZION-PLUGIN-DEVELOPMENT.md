# Zion Plugin Development Guide

> **Based on actual zion-next codebase implementation**

This guide provides comprehensive information for developing Zion plugins based on the actual implementation in the zion-next codebase.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Plugin Lifecycle](#plugin-lifecycle)
3. [Manifest Structure](#manifest-structure)
4. [Plugin Entry Point](#plugin-entry-point)
5. [Core APIs](#core-apis)
6. [State Management](#state-management)
7. [Event System](#event-system)
8. [Chat Integration](#chat-integration)
9. [Editor Customization](#editor-customization)
10. [Best Practices](#best-practices)
11. [Development Workflow](#development-workflow)

---

## Architecture Overview

### Core Components

```
zion-next/
├── src/plugin/
│   ├── types.ts      # Plugin type definitions
│   ├── loader.ts     # Plugin loading and validation
│   ├── manager.ts    # Plugin lifecycle management
│   └── index.ts      # Public API exports
├── src/ext/
│   └── registry.ts   # window.zion API exposure
└── extensions/
    └── *.plugin/     # Plugin directories
        ├── manifest.json
        └── main.js
```

### Key Files

- **`src/plugin/types.ts`**: Contains all type definitions:
  - `PluginManifest`: Modern plugin manifest structure
  - `PluginContext`: Context passed to `activate()`
  - `PluginModule`: Plugin module interface
  - `Disposable`: Interface for cleanup

- **`src/plugin/loader.ts`**: Handles plugin loading:
  - Detects plugin format (modern/legacy)
  - Loads manifest.json
  - Validates plugin structure
  - Loads plugin module

- **`src/plugin/manager.ts`**: Manages plugin lifecycle:
  - `install()`: Install a plugin
  - `activate()`: Call plugin's `activate()` function
  - `deactivate()`: Call plugin's `deactivate()` function
  - `enable()`/`disable()`: Enable/disable plugins
  - Event emission for lifecycle changes

- **`src/ext/registry.ts`**: Exposes `window.zion` API:
  - Commands: `window.zion.commands`
  - Keybindings: `window.zion.keybindings`
  - State: `window.zion.state`
  - Events: `window.zion.events`
  - StatusBar: `window.zion.statusBar`
  - Editor: `window.zion.editor`

---

## Plugin Lifecycle

```
┌─────────┐    ┌──────────┐    ┌─────────┐    ┌──────────┐
│  Load   │ -> │ Validate │ -> │ Install │ -> │ Enable   │
└─────────┘    └──────────┘    └─────────┘    └──────────┘
                                                │
                                                v
                                         ┌──────────┐
                                         │ Activate │ -> Use -> Deactivate
                                         └──────────┘
```

### Lifecycle States

```typescript
type PluginState =
  | 'installed'     // 已安装但未启用
  | 'enabled'       // 已启用但未激活
  | 'disabled'      // 已禁用
  | 'activating'    // 正在激活
  | 'active'        // 已激活
  | 'deactivating'  // 正在停用
  | 'error'         // 错误状态
  | 'uninstalled';  // 已卸载
```

### Activation Flow

1. **Load**: PluginManager reads `manifest.json`
2. **Validate**: PluginLoader validates manifest structure
3. **Install**: Plugin added to registry
4. **Enable**: Plugin marked as enabled
5. **Activate**: `activate()` function called with context
6. **Use**: Plugin functionality available
7. **Deactivate**: `deactivate()` called (if defined)

---

## Manifest Structure

### Minimal Example

```json
{
  "name": "my-plugin",
  "version": "0.0.1",
  "description": "My first Zion plugin",
  "author": "Your Name",
  "license": "MIT",
  "zion": {
    "id": "my-plugin",
    "name": "my-plugin",
    "version": "0.0.1",
    "main": "./main.js",
    "contributes": {
      "commands": [
        {
          "id": "myplugin.hello",
          "title": "Say Hello"
        }
      ]
    },
    "activationEvents": ["onStartupFinished"],
    "engines": {"zion": ">=1.0.0"}
  }
}
```

### Complete Manifest

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Plugin description",
  "author": "Author Name",
  "license": "MIT",
  "zion": {
    "id": "com.example.my-plugin",
    "name": "My Plugin",
    "version": "1.0.0",
    "main": "./main.js",
    "contributes": {
      "commands": [
        {
          "id": "myplugin.command1",
          "title": "Command Title",
          "description": "Command description"
        }
      ],
      "keybindings": [
        {
          "command": "myplugin.command1",
          "key": "Ctrl+Shift+H",
          "when": "editorFocus"
        }
      ],
      "menus": [
        {
          "location": "editor/context",
          "command": "myplugin.command1",
          "title": "Menu Title",
          "when": "hasSelection"
        }
      ],
      "views": [
        {
          "id": "myplugin.sidebar",
          "title": "My Sidebar",
          "type": "sidebar",
          "icon": "icon.svg"
        }
      ]
    },
    "activationEvents": [
      "onStartupFinished",
      "onCommand:myplugin.command1"
    ],
    "dependencies": {
      "other.plugin": "^1.0.0"
    },
    "engines": {
      "zion": ">=1.0.0"
    }
  }
}
```

### Manifest Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | NPM package name |
| `version` | string | Yes | Semantic version |
| `description` | string | No | Plugin description |
| `author` | string | No | Author name |
| `license` | string | No | License type |
| `zion.id` | string | Yes | Unique plugin ID |
| `zion.name` | string | Yes | Display name |
| `zion.version` | string | Yes | Plugin version |
| `zion.main` | string | Yes | Entry point path |
| `zion.contributes` | object | No | Contributions |
| `activationEvents` | array | No | Activation triggers |
| `dependencies` | object | No | Plugin dependencies |
| `engines.zion` | string | Yes | Zion version requirement |

### Activation Events

- `"onStartupFinished"`: Activate on app startup
- `"onCommand:commandId"`: Activate when command executed
- `"onLanguage:languageId"`: Activate when language detected
- `"onView:viewId"`: Activate when view opened

### When Conditions (for keybindings/menus)

- `"editorFocus"`: When editor has focus
- `"hasSelection"`: When text is selected
- `"searchReplaceVisible"`: When search panel is visible

---

## Plugin Entry Point

### Basic Structure

```javascript
// main.js
export async function activate(ctx) {
  console.log('Plugin activated!');
  
  // Register commands
  const command = window.zion.commands.registerCommand(
    'myplugin.hello',
    () => {
      console.log('Hello!');
    }
  );
  
  // Add to subscriptions for cleanup
  ctx.subscriptions.push(command);
}

export async function deactivate() {
  console.log('Plugin deactivated!');
  // Cleanup happens automatically via ctx.subscriptions
}
```

### Plugin Context

```typescript
interface PluginContext {
  subscriptions: Disposable[];           // Array for cleanup
  extensionPath: string;               // Plugin directory path
  globalState: Memento;              // Plugin-scoped storage
  workspaceState: Memento;            // Workspace storage
  configuration: PluginConfigurationManager;  // Plugin config
  asAbsolutePath(path: string): string;  // Resolve absolute paths
  log(message: string, level?: 'debug' | 'info' | 'warn' | 'error'): void;
}
```

---

## Core APIs

### Commands

```javascript
// Register a command
const command = window.zion.commands.registerCommand(
  'myplugin.doSomething',
  (arg1, arg2) => {
    console.log('Command executed:', arg1, arg2);
    return 'result';
  }
);

// Execute a command
const result = window.zion.commands.executeCommand(
  'otherplugin.someCommand',
  'param1',
  'param2'
);
```

### Keybindings

```javascript
// Register keybinding
const keybinding = window.zion.keybindings.register({
  command: 'myplugin.doSomething',
  key: 'Ctrl+Shift+H',    // or 'Cmd+Shift+H' on Mac
  when: 'editorFocus'       // Optional condition
});

// List all keybindings
const bindings = window.zion.keybindings.list();
```

**Key formats:**
- `Ctrl+Shift+A` / `Cmd+Shift+A` (auto-switches)
- `Alt+F`
- `Shift+Ctrl+Space`

### Status Bar Items

```javascript
// Register status item
const statusItem = window.zion.statusBar.registerItem({
  id: 'myplugin.status',
  text: 'My Plugin',
  tooltip: 'Click to do something',
  onClick: () => {
    window.zion.commands.executeCommand('myplugin.toggle');
  }
});

ctx.subscriptions.push(statusItem);
```

### Context Menu Items

```javascript
// Register context menu item
const menuItem = window.zion.menus.register(
  'editor/context',
  {
    command: 'myplugin.action',
    title: 'My Action',
    when: 'hasSelection'
  }
);

ctx.subscriptions.push(menuItem);
```

---

## State Management

### Shared State Bus (window.zion.state)

```javascript
// Get state
const value = window.zion.state.get('myKey', 'defaultValue');

// Set state
window.zion.state.set('myKey', 'newValue');

// Update state with function
window.zion.state.update('myKey', (oldValue) => {
  return oldValue + 1;
});

// Subscribe to changes
const subscription = window.zion.state.onDidChange(
  'myKey',
  (newValue, oldValue) => {
    console.log(`Changed from ${oldValue} to ${newValue}`);
  }
);

ctx.subscriptions.push({ dispose: () => subscription.dispose() });
```

### Plugin Global State (ctx.globalState)

```javascript
// Read global state (persistent)
const lastUsed = ctx.globalState.get('lastUsed', null);

// Write global state
await ctx.globalState.set('lastUsed', Date.now());

// List all keys
const keys = ctx.globalState.keys();
```

### Workspace State (ctx.workspaceState)

```javascript
// Read workspace state
const settings = ctx.workspaceState.get('settings', {});

// Write workspace state
await ctx.workspaceState.set('settings', { theme: 'dark' });
```

### Configuration (ctx.configuration)

```javascript
// Get configuration
const setting = ctx.configuration.get('mySetting', 'default');

// Set configuration
await ctx.configuration.update('mySetting', 'newValue');

// Listen for changes
const sub = ctx.configuration.onDidChange('mySetting', (value) => {
  console.log('Setting changed:', value);
});

ctx.subscriptions.push(sub);
```

---

## Event System

### Emitting Events

```javascript
// Emit a custom event
window.zion.events.emit('myplugin.customEvent', {
  data: 'some value',
  timestamp: Date.now()
});
```

### Listening to Events

```javascript
// Listen to custom event
const listener = window.zion.events.on(
  'myplugin.customEvent',
  (payload) => {
    console.log('Received:', payload.data);
  }
);

ctx.subscriptions.push({ dispose: () => listener.dispose() });
```

### Built-in Events

```javascript
// Editor events
const onDocChange = window.zion.events.on('editor.change', (data) => {
  console.log('Document changed');
});

const onCursorActivity = window.zion.events.on(
  'editor.cursorActivity',
  (data) => {
    console.log('Cursor moved:', data.selection);
  }
);

// Chat events
const onChatStart = window.zion.events.on('chat/runStarted', (data) => {
  console.log('Chat started:', data.runId);
});

const onChatToken = window.zion.events.on('chat/token', (data) => {
  console.log('Token:', data.token);
});

const onChatFinish = window.zion.events.on('chat/runFinished', (data) => {
  console.log('Chat finished:', data.runId);
});

ctx.subscriptions.push(
  { dispose: () => onDocChange.dispose() },
  { dispose: () => onCursorActivity.dispose() },
  { dispose: () => onChatStart.dispose() },
  { dispose: () => onChatToken.dispose() },
  { dispose: () => onChatFinish.dispose() }
);
```

### Cross-Plugin Communication

**Plugin A (emitter):**
```javascript
export async function activate(ctx) {
  window.zion.commands.registerCommand(
    'pluginA.notify',
    () => {
      window.zion.events.emit('pluginA.dataUpdated', {
        id: '123',
        status: 'complete'
      });
    }
  );
}
```

**Plugin B (listener):**
```javascript
export async function activate(ctx) {
  const listener = window.zion.events.on(
    'pluginA.dataUpdated',
    (data) => {
      console.log('Plugin A updated:', data);
      window.zion.commands.executeCommand('pluginB.refresh');
    }
  );

  ctx.subscriptions.push({ dispose: () => listener.dispose() });
}
```

---

## Chat Integration

### Register Tool Schema

```javascript
export async function activate(ctx) {
  // Define tool schema (OpenAI function format)
  const toolSchema = {
    type: 'function',
    function: {
      name: 'myPlugin.doSomething',
      description: 'Does something useful',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'delete', 'update'],
            description: 'The action to perform'
          },
          data: {
            type: 'string',
            description: 'Data for the action'
          }
        },
        required: ['action']
      }
    }
  };

  // Add to chat.tools
  const existingTools = window.zion.state.get('chat.tools') || [];
  const existNames = new Set(
    existingTools.map(t => t?.function?.name).filter(Boolean)
  );

  if (!existNames.has('myPlugin.doSomething')) {
    existingTools.push(toolSchema);
    window.zion.state.set('chat.tools', existingTools);
  }
}
```

### Register Tool Handler

```javascript
export async function activate(ctx) {
  // Get existing handlers
  const handlers = window.zion.state.get('chat.toolHandlers') || {};

  // Add your handler
  if (!handlers['myPlugin.doSomething']) {
    handlers['myPlugin.doSomething'] = async (args) => {
      try {
        const { action, data } = args || {};

        switch (action) {
          case 'create':
            return `Created: ${data}`;
          case 'update':
            return `Updated: ${data}`;
          case 'delete':
            return `Deleted: ${data}`;
          default:
            return 'Unknown action';
        }
      } catch (error) {
        return `Error: ${error.message}`;
      }
    };

    window.zion.state.set('chat.toolHandlers', handlers);
  }
}
```

### Example from dev.terminal-manager

```javascript
// Register terminalManage tool
const terminalManageTool = {
  type: 'function',
  function: {
    name: 'terminalManage',
    description: 'Manage persistent terminal sessions',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create','list','get','close','set_cwd']
        },
        type: { type: 'string', enum: ['local','ssh'] },
        ssh_host: { type: 'string' },
        ssh_user: { type: 'string' },
        ssh_port: { type: 'number' },
        session_id: { type: 'string' }
      },
      required: ['action']
    }
  }
};

// Add to tools
const tools = window.zion.state.get('chat.tools') || [];
tools.push(terminalManageTool);
window.zion.state.set('chat.tools', tools);

// Register handler
const handlers = window.zion.state.get('chat.toolHandlers') || {};
handlers.terminalManage = async (args) => {
  const base = 'http://127.0.0.1:8765';
  const action = args?.action;

  if (action === 'create') {
    const res = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });
    return await res.json();
  }

  if (action === 'list') {
    const res = await fetch(`${base}/sessions`);
    return await res.json();
  }

  // ... handle other actions
};

window.zion.state.set('chat.toolHandlers', handlers);
```

---

## Editor Customization

### Decorators

Decorators allow you to customize CodeMirror editor behavior.

```javascript
export async function activate(ctx) {
  const decorator = window.zion.editor.registerDecorator({
    id: 'myplugin.myDecorator',
    apply: (editorProxy) => {
      // editorProxy provides access to the editor

      // Apply your customization
      console.log('Decorator applied');

      // Return a disposable for cleanup
      return {
        dispose: () => {
          console.log('Decorator cleaned up');
        }
      };
    }
  });

  ctx.subscriptions.push(decorator);
}
```

### Example: Reacting to State Changes (from dev.editor-config)

```javascript
export async function activate(ctx) {
  const STATE_KEY = 'ui.editorWidthMode';

  const applyWidthMode = () => {
    const mode = window.zion.state.get(STATE_KEY) || 'full';
    const cm = document.querySelector('.cm-editor');
    if (!cm) return;
    const scroller = cm.querySelector('.cm-scroller') || cm;

    // Reset styles
    scroller.style.maxWidth = '';
    scroller.style.marginLeft = '';
    scroller.style.marginRight = '';

    if (mode === 'full') {
      cm.style.width = '100%';
      scroller.style.width = '100%';
    } else if (mode === 'wide') {
      scroller.style.maxWidth = '960px';
      scroller.style.marginLeft = 'auto';
      scroller.style.marginRight = 'auto';
    }
  };

  const decorator = window.zion.editor.registerDecorator({
    id: 'dev.editor.width-mode',
    apply: () => {
      // Apply initial state
      applyWidthMode();

      // Subscribe to state changes
      const sub = window.zion.state.onDidChange(STATE_KEY, applyWidthMode);

      // Cleanup on deactivate
      return {
        dispose: () => {
          try { sub.dispose(); } catch {}
          // Reset styles
          const cm = document.querySelector('.cm-editor');
          if (cm) cm.style.width = '';
        }
      };
    }
  });

  ctx.subscriptions.push(decorator);
}
```

### Paste Handlers

```javascript
export async function activate(ctx) {
  const pasteHandler = window.zion.editor.registerPasteHandler({
    id: 'myplugin.pasteHandler',
    priority: 100,  // Higher priority runs first
    handle: async (ctx) => {
      const { clipboardData, editor } = ctx;

      // Check for images
      for (const item of clipboardData.items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (!file) continue;

          // Convert to base64
          const base64 = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(file);
          });

          // Insert into editor
          editor.insertContent(`![Image](${base64})`);

          return true;  // Prevent default paste
        }
      }

      return false;  // Let default handler process
    }
  });

  ctx.subscriptions.push(pasteHandler);
}
```

---

## Best Practices

### Resource Cleanup

```javascript
export async function activate(ctx) {
  // Register everything
  const cmd = window.zion.commands.registerCommand('id', handler);
  const kb = window.zion.keybindings.register({ command: 'id', key: 'Ctrl+K' });
  const status = window.zion.statusBar.registerItem({ id: 's', text: 'Status' });
  const stateSub = window.zion.state.onDidChange('key', handler);
  const eventSub = window.zion.events.on('event', handler);
  const decorator = window.zion.editor.registerDecorator({ id: 'd', apply: () => ({ dispose: () => {} }) });

  // ALWAYS store disposables
  ctx.subscriptions.push(
    cmd,
    kb,
    status,
    { dispose: () => stateSub.dispose() },
    { dispose: () => eventSub.dispose() },
    decorator
  );
}

export async function deactivate() {
  // Cleanup happens automatically via ctx.subscriptions
  // But you can add custom cleanup here
  console.log('Plugin deactivated');

  // Clean up timers
  if (window.myPluginTimer) {
    clearInterval(window.myPluginTimer);
    window.myPluginTimer = null;
  }

  // Clean up DOM elements
  const panel = document.getElementById('myplugin-panel');
  if (panel) panel.remove();
}
```

### Error Handling

```javascript
export async function activate(ctx) {
  try {
    // Plugin code
    window.zion.commands.registerCommand('myplugin.cmd', () => {
      try {
        // Command logic
      } catch (err) {
        ctx.log('error', 'Command error:', err);
        console.error('[myplugin] Command error:', err);
      }
    });
  } catch (err) {
    ctx.log('error', 'Activation failed:', err);
    console.error('[myplugin] Activation error:', err);
    throw err;
  }
}
```

### Event Namespacing

```javascript
// Good: namespaced events
window.zion.events.emit('myplugin.action.completed', data);
window.zion.events.emit('myplugin.action.failed', error);

// Bad: generic names (risk conflicts)
window.zion.events.emit('completed', data);
window.zion.events.emit('error', error);
```

### Command IDs

```javascript
// Good: descriptive with plugin prefix
window.zion.commands.registerCommand('myplugin.file.save', handler);
window.zion.commands.registerCommand('myplugin.file.open', handler);

// Bad: generic names
window.zion.commands.registerCommand('save', handler);
window.zion.commands.registerCommand('open', handler);
```

---

## Development Workflow

### Creating a Plugin

```bash
# In zion-next/extensions directory
mkdir extensions/my-plugin
cd extensions/my-plugin
```

**manifest.json:**
```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "My Zion plugin",
  "author": "Your Name",
  "license": "MIT",
  "zion": {
    "id": "my-plugin",
    "name": "my-plugin",
    "version": "0.1.0",
    "main": "./main.js",
    "contributes": {
      "commands": [
        {
          "id": "myplugin.test",
          "title": "Test Command"
        }
      ]
    },
    "activationEvents": ["onStartupFinished"],
    "engines": {"zion": ">=1.0.0"}
  }
}
```

**main.js:**
```javascript
export async function activate(ctx) {
  console.log('[my-plugin] Activating...');

  const command = window.zion.commands.registerCommand(
    'myplugin.test',
    () => {
      alert('My plugin is working!');
      console.log('[my-plugin] Test command executed');
    }
  );

  const status = window.zion.statusBar.registerItem({
    id: 'myplugin.status',
    text: '🔌 MyPlugin',
    tooltip: 'Click to test',
    onClick: () => {
      window.zion.commands.executeCommand('myplugin.test');
    }
  });

  ctx.subscriptions.push(command, status);

  console.log('[my-plugin] Activated!');
}

export async function deactivate() {
  console.log('[my-plugin] Deactivated!');
}
```

### Development Server

```bash
# In zion-next root
npm run dev
```

Open browser to `http://localhost:5173`

### Debugging

```javascript
// Console logging
ctx.log('info', 'Plugin starting...');
ctx.log('debug', 'Debug info:', { foo: 'bar' });
ctx.log('warn', 'Warning message');
ctx.log('error', 'Error occurred');

// Inspect state
// In browser console:
window.zion.state.get('myplugin.someKey');
window.zion.state.keys();
Object.keys(window.zion.commands);

// Test activation/deactivation
window.zion.commands.executeCommand('pluginManager.disable', 'my-plugin');
window.zion.commands.executeCommand('pluginManager.enable', 'my-plugin');
```

### Development Checklist

- [ ] Create manifest.json with proper structure
- [ ] Implement activate() function
- [ ] Implement deactivate() function (if needed)
- [ ] Add proper error handling
- [ ] Add logging for debugging
- [ ] Test activation in browser console
- [ ] Test all commands
- [ ] Test keyboard shortcuts
- [ ] Test status bar items
- [ ] Test state persistence
- [ ] Test event emission/listening
- [ ] Test activation/deactivation cycles
- [ ] Check for memory leaks
- [ ] Verify cleanup on deactivation
- [ ] Test in different browsers
- [ ] Update documentation

---

## Example Plugins

### dev.editor-config

Demonstrates:
- Commands for editor settings
- Keybindings
- Status bar items
- State management
- Decorators for UI changes

### dev.terminal-manager

Demonstrates:
- Chat tool schema registration
- Tool handler implementation
- State management for sessions
- Status bar integration

### dev.paste-image

Demonstrates:
- Paste handler registration
- Priority system
- File processing
- Content insertion

### dev.thinking

Demonstrates:
- UI panel creation
- State subscriptions
- Event handling
- Dynamic UI updates

---

## Common Issues

### Plugin not activating

**Check:**
- Console for errors
- manifest.json syntax
- main.js path in manifest

### Command not found

**Check:**
- Command registration in activate()
- Command ID spelling
- Activation completed

### Memory leak

**Check:**
- All disposables in ctx.subscriptions
- Timer cleanup
- Event listener cleanup

### State not persisting

**Check:**
- Using ctx.globalState for persistence
- localStorage quota
- Key names are correct

---

## API Quick Reference

### window.zion.commands

```javascript
registerCommand(id: string, handler: Function): Disposable
executeCommand(id: string, ...args: any): any
```

### window.zion.keybindings

```javascript
register(binding: Keybinding): Disposable
list(): Keybinding[]
```

### window.zion.statusBar

```javascript
registerItem(opts: { id, text, tooltip?, onClick? }): Disposable
```

### window.zion.state

```javascript
get<T>(key: string, defaultValue?: T): T | undefined
set<T>(key: string, value: T): void
update<T>(key: string, updater: (old: T) => T): void
onDidChange<T>(key: string, handler: (new: T, old: T) => void): Disposable
```

### window.zion.events

```javascript
emit(topic: string, payload?: any): void
on(topic: string, handler: (payload: any) => void): Disposable
```

### window.zion.editor

```javascript
registerDecorator(dec: Decorator): Disposable
registerPasteHandler(handler: PasteHandler): Disposable
```

---

## Further Reading

- **Source Code**: `src/plugin/` directory
- **Examples**: `extensions/` directory
- **Registry**: `src/ext/registry.ts`
- **Types**: `src/plugin/types.ts`

---

*This guide is based on the actual zion-next codebase. For the most up-to-date information, always refer to the source code.*
