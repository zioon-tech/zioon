# API 参考 (API Reference)

完整的 Zion Next 布局系统 API 参考文档。

## 📋 目录

- [Layout API](#layout-api)
- [Activity Bar API](#activity-bar-api)
- [Side Bar API](#side-bar-api)
- [Auxiliary Bar API](#auxiliary-bar-api)
- [Bottom Panel API](#bottom-panel-api)
- [Status Bar API](#status-bar-api)
- [Editor Area API](#editor-area-api)
- [Responsive API](#responsive-api)
- [Mobile API](#mobile-api)
- [Commands API](#commands-api)
- [Events API](#events-api)
- [State API](#state-api)

---

## Layout API

布局管理器，用于控制整体布局配置。

### window.zion.layout

#### getConfig()

获取当前布局配置。

```typescript
interface LayoutConfig {
  activityBar: {
    visible: boolean;
    position: 'left' | 'right';
    items: ActivityBarItemRegistration[];
  };
  sideBar: {
    visible: boolean;
    activeViewId: string | null;
    width: number;
    position: 'left' | 'right';
    views: Map<string, ViewRegistration>;
  };
  auxiliaryBar: {
    visible: boolean;
    activeViewId: string | null;
    width: number;
    views: Map<string, ViewRegistration>;
  };
  bottomPanel: {
    visible: boolean;
    activeViewId: string | null;
    height: number;
    maximized: boolean;
    views: Map<string, ViewRegistration>;
  };
  editorArea: {
    tabs: EditorTabRegistration[];
    activeTabId: string | null;
    groups: EditorGroup[];
  };
  statusBar: {
    visible: boolean;
    items: Map<string, StatusBarItemRegistration>;
  };
}

function getConfig(): LayoutConfig;
```

**示例**：

```javascript
const config = window.zion.layout.getConfig();
console.log('Side bar width:', config.sideBar.width);
```

#### setConfig(config)

设置布局配置。

```typescript
function setConfig(config: LayoutConfig): void;
```

**示例**：

```javascript
window.zion.layout.setConfig({
  ...window.zion.layout.getConfig(),
  sideBar: {
    ...window.zion.layout.getConfig().sideBar,
    width: 300
  }
});
```

#### resetLayout()

重置布局为默认配置。

```typescript
function resetLayout(): void;
```

#### saveLayout(name?)

保存当前布局为预设。

```typescript
function saveLayout(name?: string): void;
```

**示例**：

```javascript
// 保存默认预设
window.zion.layout.saveLayout();

// 保存命名预设
window.zion.layout.saveLayout('my-custom-layout');
```

#### restoreLayout(name?)

恢复布局预设。

```typescript
function restoreLayout(name?: string): void;
```

**示例**：

```javascript
// 恢复默认预设
window.zion.layout.restoreLayout();

// 恢复命名预设
window.zion.layout.restoreLayout('my-custom-layout');
```

#### getActiveView(area)

获取指定区域的当前激活视图。

```typescript
function getActiveView(area: LayoutArea): string | null;

type LayoutArea = 
  | 'activitybar'
  | 'sidebar'
  | 'auxiliarybar'
  | 'bottompanel'
  | 'editorarea'
  | 'statusbar';
```

**示例**：

```javascript
const activeSideView = window.zion.layout.getActiveView('sidebar');
console.log('Active side bar view:', activeSideView);
```

#### onDidChangeLayout(callback)

监听布局变化。

```typescript
function onDidChangeLayout(
  callback: (config: LayoutConfig) => void
): Disposable;
```

**示例**：

```javascript
const disposable = window.zion.layout.onDidChangeLayout((config) => {
  console.log('Layout changed:', config.sideBar.width);
});
```

---

## Activity Bar API

活动栏 API，用于管理左侧图标导航栏。

### window.zion.activityBar

#### registerItem(options)

注册活动栏项目。

```typescript
interface ActivityBarItemRegistration {
  id: string;
  pluginId: string;
  icon: string | SVGElement | Function;
  tooltip: string;
  sideBarViewId?: string;
  auxiliaryBarViewId?: string;
  bottomPanelViewId?: string;
  order?: number;
  when?: string;
  onClick?: () => void | Promise<void>;
}

function registerItem(
  options: ActivityBarItemRegistration
): Disposable;
```

`auxiliaryBarViewId` 仅保留调用兼容性。此类项目不会出现在左侧可见列表中；Auxiliary 视图会通过自身注册信息显示在右侧导航栏。

**示例**：

```javascript
const disposable = window.zion.activityBar.registerItem({
  id: 'session.activity',
  pluginId: 'session-manager',
  icon: '💬',
  tooltip: 'Chat Sessions',
  sideBarViewId: 'session.list',
  order: 10
});
```

#### activateItem(id)

激活指定项目。

```typescript
function activateItem(id: string): void;
```

**示例**：

```javascript
window.zion.activityBar.activateItem('session.activity');
```

#### getItems()

获取所有项目。

```typescript
function getItems(): ActivityBarItemRegistration[];
```

#### show()

显示活动栏。

```typescript
function show(): void;
```

#### hide()

隐藏活动栏。

```typescript
function hide(): void;
```

#### toggle()

切换活动栏显示状态。

```typescript
function toggle(): void;
```

---

## Side Bar API

左侧边栏 API，用于管理主视图区域。

### window.zion.sideBar

#### registerView(options)

注册侧边栏视图。

```typescript
interface ViewRegistration {
  id: string;
  pluginId: string;
  title: string;
  icon?: string | SVGElement;
  location: 'sidebar' | 'auxiliarybar' | 'bottompanel' | 'editorarea';
  component: string | HTMLElement | Function;
  order?: number;
  priority?: number;
  canClose?: boolean;
  canMove?: boolean;
  keepWhenHidden?: boolean;
  when?: string;
  responsive?: ResponsiveConfig;
  onActivate?: () => void | Promise<void>;
  onDeactivate?: () => void | Promise<void>;
  onResize?: (size: { width: number; height: number }) => void;
  onDispose?: () => void;
}

interface ResponsiveConfig {
  desktop?: {
    visible?: boolean;
    width?: number | string;
    order?: number;
    mode?: 'sidebar' | 'overlay' | 'tab';
  };
  tablet?: {
    visible?: boolean;
    width?: number | string;
    order?: number;
    mode?: 'sidebar' | 'overlay' | 'tab';
  };
  mobile?: {
    visible?: boolean;
    mode?: 'drawer' | 'bottomnav' | 'fullscreen' | 'modal';
    order?: number;
  };
}

function registerView(
  options: ViewRegistration
): Disposable;
```

**示例**：

```javascript
const disposable = window.zion.sideBar.registerView({
  id: 'session.list',
  pluginId: 'session-manager',
  title: 'Sessions',
  icon: '💬',
  location: 'sidebar',
  component: (container) => {
    const el = document.createElement('div');
    el.textContent = 'Session List';
    container.appendChild(el);
    
    return {
      dispose: () => container.innerHTML = ''
    };
  },
  order: 10,
  responsive: {
    desktop: { visible: true, width: 240 },
    tablet: { visible: true, width: 180 },
    mobile: { visible: false, mode: 'drawer' }
  }
});
```

#### activateView(id)

激活指定视图。

```typescript
function activateView(id: string): void;
```

#### closeView(id)

关闭指定视图。

```typescript
function closeView(id: string): void;
```

#### getViews()

获取所有视图。

```typescript
function getViews(): ViewRegistration[];
```

#### show()

显示侧边栏。

```typescript
function show(): void;
```

#### hide()

隐藏侧边栏。

```typescript
function hide(): void;
```

#### toggle()

切换侧边栏显示状态。

```typescript
function toggle(): void;
```

#### setWidth(width)

设置侧边栏宽度。

```typescript
function setWidth(width: number): void;
```

---

## Auxiliary Bar API

右侧辅助边栏 API，用于管理辅助视图区域。每个通过 `registerView` 注册的视图都会自动获得一个右侧导航项，使用注册信息中的 `icon` 和 `title`/`titleKey` 展示，无需单独注册。

### window.zion.auxiliaryBar

API 与 `sideBar` 完全相同。

```typescript
function registerView(options: ViewRegistration): Disposable;
function activateView(id: string): void;
function closeView(id: string): void;
function getViews(): ViewRegistration[];
function show(): void;
function hide(): void;
function toggle(): void;
function setWidth(width: number): void;
```

**示例**：

```javascript
const disposable = window.zion.auxiliaryBar.registerView({
  id: 'preview.view',
  pluginId: 'web-preview',
  title: 'Preview',
  icon: '🌐',
  location: 'auxiliarybar',
  component: PreviewComponent,
  order: 10
});
```

---

## Bottom Panel API

底部面板 API，用于管理底部功能面板。

### window.zion.bottomPanel

#### registerView(options)

注册底部面板视图。

```typescript
function registerView(options: ViewRegistration): Disposable;
```

**示例**：

```javascript
const disposable = window.zion.bottomPanel.registerView({
  id: 'terminal.view',
  pluginId: 'terminal-plugin',
  title: 'Terminal',
  icon: '⌨️',
  location: 'bottompanel',
  component: TerminalComponent
});
```

#### activateView(id)

激活指定视图。

```typescript
function activateView(id: string): void;
```

#### closeView(id)

关闭指定视图。

```typescript
function closeView(id: string): void;
```

#### getViews()

获取所有视图。

```typescript
function getViews(): ViewRegistration[];
```

#### show()

显示底部面板。

```typescript
function show(): void;
```

#### hide()

隐藏底部面板。

```typescript
function hide(): void;
```

#### toggle()

切换底部面板显示状态。

```typescript
function toggle(): void;
```

#### setHeight(height)

设置底部面板高度。

```typescript
function setHeight(height: number): void;
```

#### maximize()

最大化底部面板。

```typescript
function maximize(): void;
```

#### restore()

恢复底部面板大小。

```typescript
function restore(): void;
```

---

## Status Bar API

状态栏 API，用于管理底部状态信息。

### window.zion.statusBar

#### registerItem(options)

注册状态栏项目。

```typescript
interface StatusBarItemRegistration {
  id: string;
  pluginId: string;
  text: string;
  tooltip?: string;
  icon?: string | SVGElement;
  position: 'left' | 'center' | 'right';
  align?: 'left' | 'right';
  order?: number;
  priority?: number;
  onClick?: () => void;
  when?: string;
  color?: string;
  backgroundColor?: string;
}

function registerItem(
  options: StatusBarItemRegistration
): Disposable;
```

**示例**：

```javascript
const disposable = window.zion.statusBar.registerItem({
  id: 'cursor.position',
  pluginId: 'editor-plugin',
  text: 'Ln 1, Col 5',
  tooltip: 'Current cursor position',
  position: 'left',
  order: 10
});
```

#### updateItem(id, updates)

更新状态栏项目。

```typescript
function updateItem(
  id: string,
  updates: Partial<StatusBarItemRegistration>
): void;
```

**示例**：

```javascript
window.zion.statusBar.updateItem('cursor.position', {
  text: `Ln ${line}, Col ${col}`
});
```

#### removeItem(id)

移除状态栏项目。

```typescript
function removeItem(id: string): void;
```

---

## Editor Area API

编辑器区域 API，用于管理编辑器和标签页。

### window.zion.editorArea

#### openTab(options)

打开新的编辑器标签页。

```typescript
interface EditorTabRegistration {
  id: string;
  pluginId: string;
  title: string;
  icon?: string | SVGElement;
  tooltip?: string;
  language?: string;
  content?: string;
  component?: HTMLElement | Function;
  readOnly?: boolean;
  closeable?: boolean;
  groupId?: string;
  onActivate?: () => void;
  onDeactivate?: () => void;
  onClose?: () => boolean;
  onSave?: () => void | Promise<void>;
}

function openTab(options: EditorTabRegistration): Disposable;
```

**示例**：

```javascript
const disposable = window.zion.editorArea.openTab({
  id: 'chat.editor',
  pluginId: 'chat-plugin',
  title: 'Chat',
  icon: '💬',
  language: 'markdown',
  component: ChatComponent
});
```

#### activateTab(id)

激活指定标签页。

```typescript
function activateTab(id: string): void;
```

#### closeTab(id)

关闭指定标签页。

```typescript
function closeTab(id: string): boolean;
```

#### getTabs()

获取所有标签页。

```typescript
function getTabs(): EditorTabRegistration[];
```

#### getActiveTab()

获取当前激活的标签页。

```typescript
function getActiveTab(): EditorTabRegistration | null;
```

#### createGroup(options)

创建新的编辑器组（分屏）。

```typescript
interface EditorGroupOptions {
  orientation: 'horizontal' | 'vertical';
  splitRatio?: number;
}

function createGroup(options: EditorGroupOptions): string;
```

**示例**：

```javascript
const groupId = window.zion.editorArea.createGroup({
  orientation: 'vertical',
  splitRatio: 0.5
});
```

#### closeGroup(groupId)

关闭编辑器组。

```typescript
function closeGroup(groupId: string): void;
```

#### getGroups()

获取所有编辑器组。

```typescript
function getGroups(): EditorGroup[];
```

---

## Responsive API

响应式 API，用于处理设备适配。

### window.zion.responsive

#### getCurrentDeviceType()

获取当前设备类型。

```typescript
function getCurrentDeviceType(): DeviceType;

type DeviceType = 
  | 'mobile'
  | 'tablet'
  | 'desktop'
  | 'largedesktop';
```

**示例**：

```javascript
const deviceType = window.zion.responsive.getCurrentDeviceType();
console.log('Device:', deviceType);
```

#### getCurrentMode()

获取当前响应式模式。

```typescript
function getCurrentMode(): ResponsiveMode;

type ResponsiveMode = 
  | 'compact'
  | 'medium'
  | 'full'
  | 'split';
```

#### getScreenWidth()

获取当前屏幕宽度。

```typescript
function getScreenWidth(): number;
```

#### getScreenHeight()

获取当前屏幕高度。

```typescript
function getScreenHeight(): number;
```

#### isMobile()

判断是否为移动设备。

```typescript
function isMobile(): boolean;
```

#### isTablet()

判断是否为平板设备。

```typescript
function isTablet(): boolean;
```

#### isDesktop()

判断是否为桌面设备。

```typescript
function isDesktop(): boolean;
```

#### onDidChangeDeviceType(callback)

监听设备类型变化。

```typescript
function onDidChangeDeviceType(
  callback: (deviceType: DeviceType) => void
): Disposable;
```

**示例**：

```javascript
const disposable = window.zion.responsive.onDidChangeDeviceType((type) => {
  console.log('Device changed to:', type);
});
```

#### onDidChangeMode(callback)

监听响应式模式变化。

```typescript
function onDidChangeMode(
  callback: (mode: ResponsiveMode) => void
): Disposable;
```

#### setMode(mode)

手动设置响应式模式。

```typescript
function setMode(mode: ResponsiveMode): void;
```

---

## Mobile API

手机端特定 API。

### window.zion.mobile

#### openDrawer()

打开抽屉菜单。

```typescript
function openDrawer(): void;
```

#### closeDrawer()

关闭抽屉菜单。

```typescript
function closeDrawer(): void;
```

#### toggleDrawer()

切换抽屉菜单。

```typescript
function toggleDrawer(): void;
```

#### onDrawerChanged(callback)

监听抽屉菜单状态变化。

```typescript
function onDrawerChanged(
  callback: (open: boolean) => void
): Disposable;
```

#### openFullscreen(viewId)

打开全屏视图。

```typescript
function openFullscreen(viewId: string): void;
```

#### closeFullscreen()

关闭全屏视图。

```typescript
function closeFullscreen(): void;
```

#### onFullscreenChanged(callback)

监听全屏视图变化。

```typescript
function onFullscreenChanged(
  callback: (viewId: string | null) => void
): Disposable;
```

#### registerBottomNavItems(items)

注册底部导航项目。

```typescript
interface BottomNavItem {
  id: string;
  icon: string;
  label: string;
  onClick?: () => void;
}

function registerBottomNavItems(items: BottomNavItem[]): void;
```

**示例**：

```javascript
window.zion.mobile.registerBottomNavItems([
  {
    id: 'sessions',
    icon: '💬',
    label: 'Sessions',
    onClick: () => window.zion.mobile.openDrawer()
  },
  {
    id: 'files',
    icon: '📁',
    label: 'Files',
    onClick: () => window.zion.sideBar.activateView('files.explorer')
  }
]);
```

---

## Commands API

命令 API，用于注册和执行命令。

### window.zion.commands

#### registerCommand(id, handler)

注册命令。

```typescript
function registerCommand(
  id: string,
  handler: (...args: any[]) => any
): Disposable;
```

**示例**：

```javascript
const disposable = window.zion.commands.registerCommand(
  'myPlugin.hello',
  () => {
    alert('Hello from my plugin!');
  }
);
```

#### executeCommand(id, ...args)

执行命令。

```typescript
function executeCommand(
  id: string,
  ...args: any[]
): Promise<any>;
```

**示例**：

```javascript
await window.zion.commands.executeCommand('myPlugin.hello');
```

---

## Events API

事件总线 API，用于插件间通信。

### window.zion.events

#### emit(event, ...args)

发布事件。

```typescript
function emit(event: string, ...args: any[]): void;
```

**示例**：

```javascript
window.zion.events.emit('myPlugin:customEvent', {
  data: 'Hello'
});
```

#### on(event, handler)

订阅事件。

```typescript
function on(
  event: string,
  handler: (...args: any[]) => void
): Disposable;
```

**示例**：

```javascript
const disposable = window.zion.events.on(
  'myPlugin:customEvent',
  (data) => {
    console.log('Received:', data);
  }
);
```

---

## State API

状态管理 API。

### window.zion.state

#### get(key, defaultValue?)

获取状态值。

```typescript
function get<T>(
  key: string,
  defaultValue?: T
): T | undefined;
```

**示例**：

```javascript
const value = window.zion.state.get('myPlugin.data', 'default');
```

#### set(key, value)

设置状态值。

```typescript
function set<T>(key: string, value: T): void;
```

**示例**：

```javascript
window.zion.state.set('myPlugin.data', 'value');
```

#### onDidChange(key, callback)

监听状态变化。

```typescript
function onDidChange<T>(
  key: string,
  callback: (newValue: T, oldValue: T) => void
): Disposable;
```

**示例**：

```javascript
const disposable = window.zion.state.onDidChange(
  'myPlugin.data',
  (newValue, oldValue) => {
    console.log('Changed from', oldValue, 'to', newValue);
  }
);
```

---

## 类型定义

### Disposable

所有 API 返回的可销毁对象。

```typescript
interface Disposable {
  dispose(): void;
}
```

**使用示例**：

```javascript
const disposable = window.zion.sideBar.registerView(...);

// 在插件停用时清理
export function deactivate() {
  disposable.dispose();
}
```

---

## 🔗 相关文档

- [扩展点总览](./01-extension-points.md)
- [响应式设计](./08-responsive-design.md)
- [插件开发指南](./09-plugin-guide.md)
