/**
 * Task Panel extension
 *
 * - Shows a right-side task panel that groups todo snapshots into tasks.
 * - Listens to zion.state 'todo.list' updates and records them into todo.tasks (per-task todos).
 * - Exposes commands:
 *    - tasks.togglePanel: show/hide panel
 *    - tasks.addTask: create a new empty task and activate it
 *    - tasks.clearTasks: clear all recorded tasks
 *
 * Data model (stored at zion.state('todo.tasks')):
 * [
 *   { id: 'task-<ts>', name: 'Session 1', todos: [ {content, status, activeForm}, ... ], updatedAt: 123456789 }
 * ]
 *
 * Active task id in zion.state('todo.activeTaskId')
 *
 * New features:
 * - When a chat run ends/aborts, if the active task still has incomplete todos, show a panel banner
 *   offering "Continue" and an "Auto-continue" toggle.
 * - If auto-continue is enabled, the extension will append a user instruction (with structured todos JSON)
 *   into the editor and trigger chat.run automatically (with a simple re-entrancy lock).
 */

const I18N_NS = 'dev.task-panel';
const I18N_MESSAGES = {
  'zh-CN': {
    'category.tasks': '任务',
    'cmd.togglePanel': '切换任务面板',
    'cmd.addTask': '添加任务',
    'cmd.clearTasks': '清空所有任务',
    'ui.title': '任务',
    'ui.addTask': '添加任务',
    'ui.hidePanel': '隐藏面板',
    'ui.activeUnfinished': '当前任务还有未完成待办。',
    'ui.taskUnfinished': '任务“{name}”还有未完成待办。',
    'ui.continue': '继续',
    'ui.auto': '自动',
    'ui.filter': '筛选任务...',
    'ui.footer': '点击任务激活，点击待办切换状态',
    'ui.empty': '暂无任务',
    'ui.untitled': '未命名',
    'ui.toggle': '切换',
    'status.text': '任务：{count}',
    'status.tooltip': '切换任务面板'
  },
  'en-US': {
    'category.tasks': 'Tasks',
    'cmd.togglePanel': 'Toggle Tasks Panel',
    'cmd.addTask': 'Add Task',
    'cmd.clearTasks': 'Clear All Tasks',
    'ui.title': 'Tasks',
    'ui.addTask': 'Add task',
    'ui.hidePanel': 'Hide panel',
    'ui.activeUnfinished': 'Active task has unfinished todos.',
    'ui.taskUnfinished': 'Task "{name}" has unfinished todos.',
    'ui.continue': 'Continue',
    'ui.auto': 'Auto',
    'ui.filter': 'Filter tasks...',
    'ui.footer': 'Click task to activate, click todo to toggle state',
    'ui.empty': 'No tasks',
    'ui.untitled': 'untitled',
    'ui.toggle': 'Toggle',
    'status.text': 'Tasks: {count}',
    'status.tooltip': 'Toggle Tasks Panel'
  }
};

function t(key, fallback, values) {
  try {
    const translated = window.zion?.i18n?.t?.(`${I18N_NS}.${key}`, values);
    if (translated && translated !== `${I18N_NS}.${key}`) return translated;
  } catch {}
  return fallback;
}

function ensureStateKeys() {
  if (!window.zion?.state) return;
  if (!Array.isArray(window.zion.state.get('todo.tasks'))) {
    window.zion.state.set('todo.tasks', []);
  }
  // autoContinue flag default false
  if (typeof window.zion.state.get('todo.autoContinue') === 'undefined') {
    window.zion.state.set('todo.autoContinue', false);
  }
}

/**
 * Create a DOM panel and return handle { open, close, toggle, renderTasks, dispose, showContinueBanner }
 */
function createPanelHandle() {
  // Root overlay for click outside close (transparent)
  const root = document.createElement('div');
  root.id = 'zion-task-panel-root';
  Object.assign(root.style, {
    position: 'fixed',
    inset: '0',
    background: 'transparent',
    zIndex: '100001',
    display: 'none'
  });

  // Panel
  const panel = document.createElement('div');
  panel.id = 'zion-task-panel';
  Object.assign(panel.style, {
    position: 'fixed',
    top: '48px',
    right: '12px',
    width: '360px',
    maxWidth: 'calc(100vw - 16px)',
    maxHeight: '65vh',
    overflow: 'auto',
    background: 'var(--panel)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    boxShadow: '0 12px 32px rgba(0,0,0,0.32)',
    padding: '8px',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif'
  });
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('ui.title', 'Tasks'));

  // Header toolbar
  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '8px'
  });

  const title = document.createElement('div');
  title.textContent = t('ui.title', 'Tasks');
  Object.assign(title.style, { fontSize: '13px', fontWeight: '600', flex: '1' });

  const btnAdd = document.createElement('button');
  btnAdd.textContent = '+';
  btnAdd.title = t('ui.addTask', 'Add task');
  Object.assign(btnAdd.style, {
    padding: '4px 6px',
    borderRadius: '4px',
    border: '1px solid var(--border)',
    background: 'transparent',
    cursor: 'pointer'
  });

  const btnClose = document.createElement('button');
  btnClose.textContent = '×';
  btnClose.title = t('ui.hidePanel', 'Hide panel');
  Object.assign(btnClose.style, {
    padding: '4px 6px',
    borderRadius: '4px',
    border: '1px solid var(--border)',
    background: 'transparent',
    cursor: 'pointer'
  });

  header.appendChild(title);
  header.appendChild(btnAdd);
  header.appendChild(btnClose);

  // Continue banner (hidden by default)
  const continueBanner = document.createElement('div');
  Object.assign(continueBanner.style, {
    display: 'none',
    border: '1px solid var(--accent)',
    background: 'rgba(0,0,0,0.04)',
    padding: '6px',
    borderRadius: '4px',
    marginBottom: '8px',
    alignItems: 'center'
  });

  const bannerText = document.createElement('div');
  bannerText.textContent = t('ui.activeUnfinished', 'Active task has unfinished todos.');
  Object.assign(bannerText.style, { flex: '1', fontSize: '12px' });

  const btnContinue = document.createElement('button');
  btnContinue.textContent = t('ui.continue', 'Continue');
  Object.assign(btnContinue.style, {
    padding: '4px 8px',
    borderRadius: '4px',
    border: '1px solid var(--border)',
    background: 'transparent',
    cursor: 'pointer',
    marginRight: '6px'
  });

  const autoLabel = document.createElement('label');
  Object.assign(autoLabel.style, { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' });
  const autoChk = document.createElement('input');
  autoChk.type = 'checkbox';
  autoChk.checked = !!window.zion.state.get('todo.autoContinue');
  const autoText = document.createElement('span');
  autoText.textContent = t('ui.auto', 'Auto');
  autoLabel.appendChild(autoChk);
  autoLabel.appendChild(autoText);

  continueBanner.appendChild(bannerText);
  continueBanner.appendChild(btnContinue);
  continueBanner.appendChild(autoLabel);

  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = t('ui.filter', 'Filter tasks...');
  Object.assign(search.style, {
    width: '100%',
    boxSizing: 'border-box',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    background: 'var(--panel)',
    color: 'var(--fg)',
    outline: 'none',
    padding: '6px',
    fontSize: '12px',
    marginBottom: '8px'
  });

  const list = document.createElement('div');
  Object.assign(list.style, {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px'
  });

  const footer = document.createElement('div');
  footer.textContent = t('ui.footer', 'Click task to activate, click todo to toggle state');
  Object.assign(footer.style, {
    fontSize: '11px',
    opacity: '0.6',
    marginTop: '8px',
    textAlign: 'center'
  });

  panel.appendChild(header);
  panel.appendChild(continueBanner);
  panel.appendChild(search);
  panel.appendChild(list);
  panel.appendChild(footer);
  root.appendChild(panel);
  document.body.appendChild(root);

  let visible = false;

  function clearList() {
    list.innerHTML = '';
  }

  function formatStatusBadge(status) {
    const el = document.createElement('span');
    el.textContent = status === 'completed' ? '✓' : (status === 'in_progress' ? '…' : '▢');
    Object.assign(el.style, {
      display: 'inline-block',
      width: '20px',
      textAlign: 'center',
      marginRight: '8px',
      opacity: '0.9',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
    });
    return el;
  }

  function renderTasks(tasks) {
    clearList();
    const q = (search.value || '').trim().toLowerCase();

    if (!Array.isArray(tasks) || tasks.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = t('ui.empty', 'No tasks');
      Object.assign(empty.style, { fontSize: '12px', opacity: '0.6', textAlign: 'center' });
      list.appendChild(empty);
      return;
    }

    // Filter tasks by query
    const filtered = q ? tasks.filter(t => (t.name || '').toLowerCase().includes(q)) : tasks;

    filtered.forEach((task) => {
      const card = document.createElement('div');
      Object.assign(card.style, {
        border: '1px solid var(--border)',
        borderRadius: '4px',
        padding: '6px',
        background: 'transparent'
      });

      const row = document.createElement('div');
      Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' });

      const name = document.createElement('div');
      name.textContent = `${task.name || `(${t('ui.untitled', 'untitled')})`} `;
      Object.assign(name.style, { fontWeight: '600', fontSize: '12px', flex: '1' });

      const ts = document.createElement('div');
      ts.textContent = task.updatedAt ? new Date(task.updatedAt).toLocaleTimeString() : '';
      Object.assign(ts.style, { fontSize: '11px', opacity: '0.6', marginLeft: '6px' });

      row.appendChild(name);
      row.appendChild(ts);

      // Click card header to activate task
      row.addEventListener('click', (e) => {
        e.preventDefault();
        try { window.zion.state.set('todo.activeTaskId', task.id); } catch {}
        updateActiveStyles();
      });

      // todos list
      const todosWrap = document.createElement('div');
      Object.assign(todosWrap.style, { display: 'flex', flexDirection: 'column', gap: '6px' });

      const arr = Array.isArray(task.todos) ? task.todos : [];
      arr.forEach((td, idx) => {
        const trow = document.createElement('div');
        Object.assign(trow.style, { display: 'flex', alignItems: 'center', gap: '8px' });

        const badge = formatStatusBadge(td.status || 'pending');
        const content = document.createElement('div');
        content.textContent = td.content || '';
        Object.assign(content.style, { flex: '1', fontSize: '12px', wordBreak: 'break-word' });

        // actions
        const actions = document.createElement('div');
        Object.assign(actions.style, { display: 'flex', gap: '6px', alignItems: 'center' });

        const btnToggle = document.createElement('button');
        btnToggle.textContent = t('ui.toggle', 'Toggle');
        Object.assign(btnToggle.style, {
          fontSize: '11px',
          padding: '2px 6px',
          borderRadius: '3px',
          border: '1px solid var(--border)',
          background: 'transparent',
          cursor: 'pointer'
        });

        btnToggle.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          // toggle status: pending -> in_progress -> completed -> pending
          const next = td.status === 'pending' ? 'in_progress' : (td.status === 'in_progress' ? 'completed' : 'pending');
          // update global state: modify todo.tasks
          try {
            const tasksNow = Array.isArray(window.zion.state.get('todo.tasks')) ? window.zion.state.get('todo.tasks').slice() : [];
            const i = tasksNow.findIndex(x => x.id === task.id);
            if (i >= 0) {
              tasksNow[i].todos = tasksNow[i].todos || [];
              // find the matching todo by index (fallback)
              if (tasksNow[i].todos[idx]) {
                tasksNow[i].todos[idx].status = next;
              } else {
                // best-effort: try to match by content
                const matchIdx = tasksNow[i].todos.findIndex(tt => tt.content === td.content);
                if (matchIdx >= 0) tasksNow[i].todos[matchIdx].status = next;
              }
              tasksNow[i].updatedAt = Date.now();
              window.zion.state.set('todo.tasks', tasksNow);
            }
          } catch (err) {
            console.error('[task-panel] toggle todo error', err);
          }
        });

        actions.appendChild(btnToggle);

        trow.appendChild(badge);
        trow.appendChild(content);
        trow.appendChild(actions);
        todosWrap.appendChild(trow);
      });

      card.appendChild(row);
      card.appendChild(todosWrap);
      list.appendChild(card);
    });

    updateActiveStyles();
  }

  function updateActiveStyles() {
    const activeId = window.zion?.state?.get('todo.activeTaskId');
    const cards = list.querySelectorAll('div');
    // iterate tasks in order and mark active header bold/with accent
    // simple approach: re-render to update styles is handled by renderTasks caller
    // but we do small visual update:
    const allCards = list.children;
    for (let i = 0; i < allCards.length; i++) {
      const c = allCards[i];
      const hd = c.querySelector('div'); // header row
      if (!hd) continue;
      const nameDiv = hd.querySelector('div');
      if (!nameDiv) continue;
      // find task name and match with state
      const text = (nameDiv.textContent || '').trim();
      const tasks = window.zion?.state?.get('todo.tasks') || [];
      const task = tasks.find(t => `${t.name || '(untitled)'} ` === text || t.name === text);
      if (!task) continue;
      if (task.id === activeId) {
        hd.style.background = 'var(--accent)';
        hd.style.color = 'var(--panel)';
      } else {
        hd.style.background = 'transparent';
        hd.style.color = 'var(--fg)';
      }
    }
  }

  btnClose.addEventListener('click', (e) => {
    e.preventDefault();
    close();
  });

  btnAdd.addEventListener('click', (e) => {
    e.preventDefault();
    // create new task via zion command
    try { window.zion.commands.executeCommand('tasks.addTask'); } catch {}
  });

  // click outside closes
  root.addEventListener('click', (e) => {
    if (e.target === root) close();
  });

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  search.addEventListener('input', () => {
    const tasks = window.zion?.state?.get('todo.tasks') || [];
    renderTasks(tasks);
  });

  // Continue banner control
  function showContinueBanner(task) {
    if (!task) {
      continueBanner.style.display = 'none';
      return;
    }
    bannerText.textContent = t('ui.taskUnfinished', 'Task "{name}" has unfinished todos.', {
      name: task.name || `(${t('ui.untitled', 'untitled')})`
    });
    continueBanner.style.display = 'flex';
  }
  function hideContinueBanner() {
    continueBanner.style.display = 'none';
  }

  // Auto checkbox wiring
  autoChk.addEventListener('change', () => {
    try {
      window.zion.state.set('todo.autoContinue', !!autoChk.checked);
    } catch {}
  });

  // Continue button wiring: triggers a continuation flow (append instruction + run)
  btnContinue.addEventListener('click', async (e) => {
    e.preventDefault();
    // find active task
    const tasks = Array.isArray(window.zion.state.get('todo.tasks')) ? window.zion.state.get('todo.tasks') : [];
    const activeId = window.zion.state.get('todo.activeTaskId');
    const task = tasks.find(t => t.id === activeId) || tasks[0];
    if (!task) return;
    try {
      await appendUserInstructionAndRun(task);
      hideContinueBanner();
    } catch (err) {
      console.error('[task-panel] continue click error', err);
    }
  });

  function positionPanel() {
    const btn = document.querySelector('[data-zion-status-id="dev.task-panel.status"]')
      || Array.from(document.querySelectorAll('#bottombar .status-item, #statusbar .status-item'))
        .find((b) => b.textContent?.includes('Tasks:'));
    const pad = 8;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    panel.style.left = '';
    panel.style.right = '';
    panel.style.top = '';
    panel.style.bottom = '';
    panel.style.maxHeight = 'min(65vh, calc(100vh - 24px))';
    if (!btn) {
      panel.style.right = '12px';
      panel.style.bottom = '36px';
      return;
    }
    const rect = btn.getBoundingClientRect();
    const width = Math.min(360, Math.max(220, vw - pad * 2));
    const maxRight = Math.max(pad, vw - width - pad);
    const right = Math.min(Math.max(pad, Math.round(vw - rect.right)), maxRight);
    const spaceAbove = Math.max(160, Math.round(rect.top - pad * 2));
    panel.style.width = `${width}px`;
    panel.style.maxHeight = `${Math.min(Math.round(vh * 0.65), spaceAbove)}px`;
    panel.style.right = `${right}px`;
    panel.style.bottom = `${Math.max(pad, Math.round(vh - rect.top + pad))}px`;
  }

  function open() {
    ensureStateKeys();
    root.style.display = 'block';
    visible = true;
    const tasks = window.zion?.state?.get('todo.tasks') || [];
    renderTasks(tasks);
    positionPanel();
    search.focus();
    search.select();
  }

  function close() {
    root.style.display = 'none';
    visible = false;
  }

  function toggle() {
    if (visible) close(); else open();
  }

  function dispose() {
    root.remove();
  }

  function refreshI18n() {
    panel.setAttribute('aria-label', t('ui.title', 'Tasks'));
    title.textContent = t('ui.title', 'Tasks');
    btnAdd.title = t('ui.addTask', 'Add task');
    btnClose.title = t('ui.hidePanel', 'Hide panel');
    btnContinue.textContent = t('ui.continue', 'Continue');
    autoText.textContent = t('ui.auto', 'Auto');
    search.placeholder = t('ui.filter', 'Filter tasks...');
    footer.textContent = t('ui.footer', 'Click task to activate, click todo to toggle state');
    renderTasks(window.zion?.state?.get('todo.tasks') || []);
  }

  return { open, close, toggle, renderTasks, dispose, showContinueBanner, hideContinueBanner, refreshI18n };
}

/**
 * Helper: create a new task object
 */
function createTaskObject(name) {
  return {
    id: 'task-' + (Date.now()) + '-' + Math.random().toString(36).slice(2,8),
    name: name || `Session ${new Date().toLocaleString()}`,
    todos: [],
    updatedAt: Date.now()
  };
}

/**
 * Utility: check if a task has incomplete todos
 */
function hasIncompleteTodos(task) {
  if (!task || !Array.isArray(task.todos) || task.todos.length === 0) return false;
  return task.todos.some(td => td.status !== 'completed');
}

/**
 * Append a user instruction (structured JSON of todos) to the active editor and trigger chat.run.
 * Uses a simple lock at window.zion.state('__todo_auto_continue_lock') to avoid re-entrancy.
 */
async function appendUserInstructionAndRun(task) {
  if (!task) return;
  try {
    // Locking to avoid multiple auto-continues
    const lock = window.zion.state.get('__todo_auto_continue_lock');
    if (lock) return;
    window.zion.state.set('__todo_auto_continue_lock', true);

    const ed = window.zion?.window?.activeEditor;
    if (!ed) {
      window.zion.state.set('__todo_auto_continue_lock', false);
      return;
    }

    // Build instruction: clear and explicit, include structured JSON for model to parse easily
    const payload = {
      taskId: task.id,
      taskName: task.name,
      todos: task.todos
    };
    const instr = `Task "${task.name || ''}" has unfinished todos.
Please read the info above, check the task status and continue to work out the following todos for task "${task.name || ''}".\n\nImportant: After completing each todo item, use the todoWrite tool to update the task status so we can track progress.\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;

    const current = ed.getValue() || '';
    const append = (current.endsWith('\n') ? '' : '\n') + 'user ' + instr + '\n';
    // Append at document end without rebuilding the whole document to preserve existing widgets/decorations
    try {
      const linesNow = current.replace(/\r/g, '').split('\n');
      const lastLineIndex = Math.max(0, linesNow.length - 1);
      const lastLineLength = (linesNow[lastLineIndex] || '').length;
      ed.replaceRange(append, { line: lastLineIndex, ch: lastLineLength });
    } catch {
      // Fallback: replace whole value if insertion fails
      ed.setValue(current + append);
    }

// Move cursor to the last non-empty line to avoid EOF edge cases
    const lines = (current + append).split('\n');
    let lastIdx = lines.length - 1;
    while (lastIdx > 0 && (lines[lastIdx] || '').trim() === '') lastIdx--;
    try { ed.setCursor({ line: lastIdx, ch: 0 }); } catch {}
    // Ensure editor is focused and state flushed before running
    try { ed.focus?.(); } catch {}
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));

    // Proactively clear aborted flag before trying to run
    try { window.zion.state.set('__chat_aborted_flag', false); } catch {}

    // Trigger chat.run (the chat extension will read document upto cursor)
    try {
      window.zion.commands.executeCommand('chat.run');
    } catch (e) {
      console.warn('[task-panel] failed to execute chat.run', e);
      // release lock on failure
      window.zion.state.set('__todo_auto_continue_lock', false);
      throw e;
    }

    // If run didn't start within a short window, retry once gracefully
    setTimeout(() => {
      try {
        const streaming = !!window.zion.state.get('chat.streaming');
        if (!streaming) {
          window.zion.commands.executeCommand('chat.run');
        }
      } catch (e) {
        console.warn('[task-panel] fallback run attempt failed', e);
        try { window.zion.state.set('__todo_auto_continue_lock', false); } catch {}
      }
    }, 200);
    // keep the lock until chat.runStarted/runFinished handlers clear it
  } catch (e) {
    console.error('[task-panel] appendUserInstructionAndRun error', e);
    window.zion.state.set('__todo_auto_continue_lock', false);
  }
}

import { registerTaskTools } from "./task-tools.js";
export async function activate(ctx) {
  try {
    const disp = window.zion.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) ctx.subscriptions.push(disp);
  } catch {}

  ensureStateKeys();

  // Panel handle (created via decorator apply)
  let panelHandle = null;

  // Decorator: mount panel when editor ready
  const dec = window.zion.editor.registerDecorator({
    id: 'dev.task-panel.decorator',
    apply(editor) {
      panelHandle = createPanelHandle();
      return { dispose() { try { panelHandle?.dispose?.(); } catch {} finally { panelHandle = null; } } };
    }
  });
  ctx.subscriptions.push(dec);

  // Command: toggle panel
  const cmdToggle = window.zion.commands.registerCommand('tasks.togglePanel', () => {
    if (panelHandle) panelHandle.toggle();
  });
  ctx.subscriptions.push(cmdToggle);

  // Command: add task
  const cmdAdd = window.zion.commands.registerCommand('tasks.addTask', (name) => {
    try {
      const tasks = Array.isArray(window.zion.state.get('todo.tasks')) ? window.zion.state.get('todo.tasks').slice() : [];
      const t = createTaskObject(name || `Task ${tasks.length + 1}`);
      tasks.unshift(t); // newest first
      window.zion.state.set('todo.tasks', tasks);
      window.zion.state.set('todo.activeTaskId', t.id);
      // open panel if exists
      if (panelHandle) panelHandle.open();
    } catch (e) { console.warn('[task-panel] add task failed', e); }
  });
  ctx.subscriptions.push(cmdAdd);

  // Command: clear tasks
  const cmdClear = window.zion.commands.registerCommand('tasks.clearTasks', () => {
    try {
      window.zion.state.set('todo.tasks', []);
      window.zion.state.set('todo.activeTaskId', null);
    } catch (e) { console.warn('[task-panel] clear tasks failed', e); }
  });
  ctx.subscriptions.push(cmdClear);

  // Status bar button showing number of tasks
  let statusDisp = null;
  function updateStatusBar() {
    try {
      statusDisp?.dispose?.();
      const tasks = Array.isArray(window.zion.state.get('todo.tasks')) ? window.zion.state.get('todo.tasks') : [];
      const text = t('status.text', 'Tasks: {count}', { count: tasks.length });
      const tooltip = t('status.tooltip', 'Toggle Tasks Panel');
      statusDisp = window.zion.bottomStatusBar?.registerItem?.({
        id: 'dev.task-panel.status',
        text,
        tooltip,
        priority: 50,
        onClick: () => window.zion.commands.executeCommand('tasks.togglePanel')
      }) || window.zion.editorHeaderMenu?.register?.({
        id: 'dev.task-panel.status',
        title: text,
        section: 'Workspace',
        order: 20,
        onClick: () => window.zion.commands.executeCommand('tasks.togglePanel')
      }) || window.zion.statusBar.registerItem({
        id: 'dev.task-panel.status',
        text,
        tooltip,
        onClick: () => window.zion.commands.executeCommand('tasks.togglePanel')
      });
      ctx.subscriptions.push(statusDisp);
    } catch (e) {
      console.warn('[task-panel] updateStatusBar failed', e);
    }
  }
  updateStatusBar();

  // Listen to tasks state changes to re-render and update status bar
  const dispTasksChange = window.zion.state.onDidChange('todo.tasks', (newVal) => {
    try {
      updateStatusBar();
      if (panelHandle) panelHandle.renderTasks(newVal || []);
    } catch (e) { console.warn('[task-panel] tasks change render error', e); }
  });
  ctx.subscriptions.push(dispTasksChange);

  // When todo.list changes (from tool calls), append/update active task snapshot
  const dispTodoList = window.zion.state.onDidChange('todo.list', (newList) => {
    try {
      const list = Array.isArray(newList) ? newList : [];
      const tasks = Array.isArray(window.zion.state.get('todo.tasks')) ? window.zion.state.get('todo.tasks').slice() : [];
      let active = window.zion.state.get('todo.activeTaskId');

      if (!active) {
        // create a new task automatically
        const t = createTaskObject(`Session ${tasks.length + 1}`);
        t.todos = list.map(it => ({ content: it?.content || (typeof it === 'string' ? it : ''), status: it?.status || 'pending', activeForm: it?.activeForm || '' }));
        t.updatedAt = Date.now();
        tasks.unshift(t);
        window.zion.state.set('todo.tasks', tasks);
        window.zion.state.set('todo.activeTaskId', t.id);
      } else {
        // update the active task's todos (replace)
        const idx = tasks.findIndex(t => t.id === active);
        if (idx >= 0) {
          tasks[idx].todos = list.map(it => ({ content: it?.content || (typeof it === 'string' ? it : ''), status: it?.status || 'pending', activeForm: it?.activeForm || '' }));
          tasks[idx].updatedAt = Date.now();
          window.zion.state.set('todo.tasks', tasks);
        } else {
          // fallback: create new task
          const t = createTaskObject(`Session ${tasks.length + 1}`);
          t.todos = list.map(it => ({ content: it?.content || (typeof it === 'string' ? it : ''), status: it?.status || 'pending', activeForm: it?.activeForm || '' }));
          t.updatedAt = Date.now();
          tasks.unshift(t);
          window.zion.state.set('todo.tasks', tasks);
          window.zion.state.set('todo.activeTaskId', t.id);
        }
      }
    } catch (e) {
      console.warn('[task-panel] on todo.list change error', e);
    }
  });
  ctx.subscriptions.push(dispTodoList);

  // Helper to get active task
  function getActiveTask() {
    const tasks = Array.isArray(window.zion.state.get('todo.tasks')) ? window.zion.state.get('todo.tasks') : [];
    const activeId = window.zion.state.get('todo.activeTaskId');
    return tasks.find(t => t.id === activeId) || null;
  }

  // When a chat run finishes or is aborted, check active task and prompt or auto-continue
  const handleRunEnd = async () => {
    try {
      const task = getActiveTask();
      if (!task) return;
      if (!hasIncompleteTodos(task)) {
        // nothing to do
        if (panelHandle) panelHandle.hideContinueBanner?.();
        return;
      }

      // If auto-continue enabled and not locked, start continuation
      const auto = !!window.zion.state.get('todo.autoContinue');
      const lock = !!window.zion.state.get('__todo_auto_continue_lock');
      if (auto && !lock) {
        // show panel to give visual feedback
        if (panelHandle) {
          panelHandle.open();
          panelHandle.showContinueBanner(task);
        }
        await appendUserInstructionAndRun(task);
        return;
      }

      // else show banner and open panel so user can continue manually
      if (panelHandle) {
        panelHandle.open();
        panelHandle.showContinueBanner(task);
      }
    } catch (e) {
      console.warn('[task-panel] handleRunEnd error', e);
    }
  };

  const dispRunFinished = window.zion.events.on('chat/runFinished', (p) => {
    // clear any lock when a run finishes (we waited for it)
    try { window.zion.state.set('__todo_auto_continue_lock', false); } catch {}
    handleRunEnd();
  });
  ctx.subscriptions.push(dispRunFinished);

  const dispAborted = window.zion.events.on('chat/aborted', (p) => {
    // when aborted, notify user similarly
    try { window.zion.state.set('__todo_auto_continue_lock', false); } catch {}
    handleRunEnd();
  });
  ctx.subscriptions.push(dispAborted);

  // When a run starts we can keep the lock active (prevents multiple triggers)
  const dispRunStarted = window.zion.events.on('chat/runStarted', (p) => {
    try { /* keep lock until finished */ } catch {}
  });
  ctx.subscriptions.push(dispRunStarted);

  const dispI18n = window.zion.events.on('i18n/changed', () => {
    try {
      updateStatusBar();
      panelHandle?.refreshI18n?.();
    } catch {}
  });
  ctx.subscriptions.push(dispI18n);

  // Ensure panel is in sync on startup
  try {
    const existing = window.zion.state.get('todo.tasks') || [];
    if (panelHandle) panelHandle.renderTasks(existing);
  } catch (e) {}

  // Register Task tools (todoWrite)
  try { registerTaskTools(); } catch {}

  // Clean-up on deactivate handled by ctx.subscriptions
}
