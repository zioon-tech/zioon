# 选中文本工具栏 (Selection Toolbar)

选中文本工具栏是编辑器内的浮动操作条：当用户完成一段文本选择后，它会在**靠近鼠标释放位置**、并结合选择方向（上/下）出现在选区附近，提供常用操作（AI、加粗、斜体、删除线等）。

这个工具栏同时也是一个插件扩展点：插件可以在这里注册按钮，甚至注册带下拉菜单/弹层的自定义控件。

## 何时出现

- 有非空选区且编辑器处于焦点状态时才会出现
- 鼠标拖拽选择期间不会出现；松开鼠标后显示
- 键盘选区会在短暂稳定后显示（防抖）

## API

### window.zion.editor.selectionToolbar.registerItem(item)

注册一个工具栏条目：

- `id`：唯一 ID（建议用 `pluginId.action` 风格）
- `order`：排序，越小越靠前（默认 50）
- `title`：hover 提示
- `label`：文字按钮文本（与 `codicon` 二选一）
- `codicon`：Codicon 名称（不带 `codicon-` 前缀），如 `bold`、`italic`
- `when(ctx)`：返回 true 时才显示该按钮
- `run(ctx)`：点击时执行（适合“按钮 + 行为”）
- `render(ctx)`：返回自定义 HTMLElement（适合“按钮 + 下拉/弹层”等复杂交互）

`ctx` 包含：

- `selectionText`：当前选区文本
- `from/to`：文档位置
- `view`：CodeMirror `EditorView`（高级用法）
- `anchorEl`：按钮容器（相对定位），适合把 dropdown/popup 挂在旁边

### window.zion.editor.selectionToolbar.list()

返回当前已注册的条目（按排序后）。

### window.zion.editor.selectionToolbar.onDidChange(fn)

监听注册表变化，通常不需要手动使用（工具栏会自动重渲染）。

## 示例

### 1) 注册一个简单按钮（把选区变成全大写）

```js
export async function activate(ctx) {
  const disp = window.zion.editor.selectionToolbar.registerItem({
    id: "dev.example.uppercase",
    order: 30,
    title: "Uppercase",
    codicon: "case-sensitive",
    when: ({ selectionText }) => !!selectionText && selectionText.trim().length > 0,
    run: ({ view, from, to, selectionText }) => {
      const upper = selectionText.toUpperCase();
      view.dispatch({ changes: { from, to, insert: upper } });
      view.focus();
    }
  });

  ctx.subscriptions.push(disp);
}
```

### 2) 注册一个“按钮 + 下拉菜单”

下面示例演示如何基于 `anchorEl` 在按钮旁边挂一个轻量 dropdown：

```js
function mountDropdown(anchorEl, items) {
  const old = anchorEl.querySelector("[data-demo-dropdown='1']");
  if (old) old.remove();

  const menu = document.createElement("div");
  menu.setAttribute("data-demo-dropdown", "1");
  menu.style.position = "absolute";
  menu.style.right = "0";
  menu.style.top = "32px";
  menu.style.zIndex = "10000";
  menu.style.background = "var(--panel)";
  menu.style.border = "1px solid var(--border)";
  menu.style.borderRadius = "10px";
  menu.style.padding = "6px";
  menu.style.boxShadow = "0 10px 30px rgba(0,0,0,0.22)";

  for (const it of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "zion-context-menu-item";
    btn.textContent = it.label;
    btn.onclick = () => { try { it.onClick(); } finally { menu.remove(); } };
    menu.appendChild(btn);
  }

  const onAway = (e) => { if (!menu.contains(e.target) && !anchorEl.contains(e.target)) menu.remove(); };
  const onEsc = (e) => { if (e.key === "Escape") menu.remove(); };
  setTimeout(() => document.addEventListener("mousedown", onAway, true), 0);
  document.addEventListener("keydown", onEsc, true);
  menu.addEventListener("remove", () => {
    document.removeEventListener("mousedown", onAway, true);
    document.removeEventListener("keydown", onEsc, true);
  });

  anchorEl.appendChild(menu);
}

export async function activate(ctx) {
  const disp = window.zion.editor.selectionToolbar.registerItem({
    id: "dev.example.dropdown",
    order: 40,
    title: "Actions",
    label: "⋯",
    run: ({ anchorEl }) => {
      mountDropdown(anchorEl, [
        { label: "Action A", onClick: () => console.log("A") },
        { label: "Action B", onClick: () => console.log("B") }
      ]);
    }
  });
  ctx.subscriptions.push(disp);
}
```

## 约定与建议

- **不要在 `when()` 里做重计算**：尽量只根据 `selectionText` 快速判断
- `render()` 返回的节点里如果会打开弹层，建议把弹层挂到 `anchorEl` 之下，方便定位与点击外部关闭
- 插件应在 `dispose()` 时清理自己创建的 DOM/事件监听（上例用 `remove` 事件做了简化清理）

