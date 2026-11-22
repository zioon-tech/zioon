import { workbenchStorage as localStorage } from "../../src/runtime/workbench-space.ts";
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

import { registerTaskTools } from "./task-tools.js";
import {
  applyRuntimeTodoListsToState,
  loadRuntimeTodoLists
} from "./task-runtime-state.js";

const I18N_NS = 'dev.task-panel';
const LS_TASKS_STATE = 'zion.devTaskPanel.tasksState.v1';
const MAX_PERSISTED_TASKS = 200;
const TASK_PANEL_UI_ENABLED = false;
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
    'ui.footer': '点击任务激活，点击待办内容推进状态',
    'ui.empty': '暂无任务',
    'ui.emptyFilter': '没有匹配的任务',
    'ui.untitled': '未命名',
    'ui.pending': '待办',
    'ui.inProgress': '进行中',
    'ui.completed': '完成',
    'ui.taskCount': '{count} 个任务',
    'ui.todoSummary': '{done}/{total} 已完成',
    'ui.activate': '设为当前任务',
    'ui.newTaskName': '任务名称',
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
    'ui.footer': 'Click a task to activate, click todo text to advance status',
    'ui.empty': 'No tasks',
    'ui.emptyFilter': 'No matching tasks',
    'ui.untitled': 'untitled',
    'ui.pending': 'Todo',
    'ui.inProgress': 'Doing',
    'ui.completed': 'Done',
    'ui.taskCount': '{count} tasks',
    'ui.todoSummary': '{done}/{total} done',
    'ui.activate': 'Set active task',
    'ui.newTaskName': 'Task name',
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
    const persisted = loadPersistedTasksState();
    window.zion.state.set('todo.tasks', persisted.tasks);
    if (persisted.activeTaskId && !window.zion.state.get('todo.activeTaskId')) {
      window.zion.state.set('todo.activeTaskId', persisted.activeTaskId);
    }
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
    display: 'none',
    fontFamily: 'var(--font-sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif)'
  });
  root.tabIndex = -1;

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
    border: '1px solid color-mix(in srgb, var(--border) 88%, transparent)',
    borderRadius: '12px',
    boxShadow: '0 12px 32px rgba(0,0,0,0.32)',
    padding: '10px',
    fontFamily: 'inherit'
  });
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('ui.title', 'Tasks'));

  // Header toolbar
  const header = document.createElement('div');
  header.className = 'ztp-header';

  const title = document.createElement('div');
  title.className = 'ztp-title';
  const titleMain = document.createElement('div');
  titleMain.className = 'ztp-title-main';
  titleMain.textContent = t('ui.title', 'Tasks');
  title.appendChild(titleMain);

  const btnAdd = document.createElement('button');
  btnAdd.textContent = '+';
  btnAdd.title = t('ui.addTask', 'Add task');
  btnAdd.className = 'ztp-button ztp-icon-button ztp-primary-button';

  const btnClose = document.createElement('button');
  btnClose.textContent = '×';
  btnClose.title = t('ui.hidePanel', 'Hide panel');
  btnClose.className = 'ztp-button ztp-icon-button';

  header.appendChild(title);
  header.appendChild(btnAdd);
  header.appendChild(btnClose);

  const stats = document.createElement('div');
  stats.className = 'ztp-stats';
  const taskCountPill = document.createElement('span');
  taskCountPill.className = 'ztp-pill';
  const todoSummaryPill = document.createElement('span');
  todoSummaryPill.className = 'ztp-pill';
  stats.appendChild(taskCountPill);
  stats.appendChild(todoSummaryPill);

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
  btnContinue.className = 'ztp-button ztp-primary-button';
  Object.assign(btnContinue.style, { padding: '4px 8px', marginRight: '6px' });

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
  search.className = 'ztp-search';

  const list = document.createElement('div');
  list.className = 'ztp-list';

  const footer = document.createElement('div');
  footer.textContent = t('ui.footer', 'Click a task to activate, click todo text to advance status');
  footer.className = 'ztp-footer';

  panel.appendChild(header);
  panel.appendChild(stats);
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

  function renderTasks(tasks) {
    clearList();
    const q = (search.value || '').trim().toLowerCase();
    const safeTasks = Array.isArray(tasks) ? tasks : [];
    const totals = safeTasks.reduce((acc, task) => {
      const todos = Array.isArray(task.todos) ? task.todos : [];
      acc.total += todos.length;
      acc.done += todos.filter(td => td?.status === 'completed').length;
      return acc;
    }, { total: 0, done: 0 });
    taskCountPill.textContent = t('ui.taskCount', '{count} tasks', { count: safeTasks.length });
    todoSummaryPill.textContent = t('ui.todoSummary', '{done}/{total} done', totals);

    if (safeTasks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ztp-empty';
      empty.textContent = t('ui.empty', 'No tasks');
      list.appendChild(empty);
      return;
    }

    // Filter tasks by query
    const filtered = q ? safeTasks.filter(task => {
      const haystack = [
        task.name,
        ...(Array.isArray(task.todos) ? task.todos.map(td => td?.content) : [])
      ].filter(Boolean).join('\n').toLowerCase();
      return haystack.includes(q);
    }) : safeTasks;

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ztp-empty';
      empty.textContent = t('ui.emptyFilter', 'No matching tasks');
      list.appendChild(empty);
      return;
    }

    filtered.forEach((task) => {
      const arr = Array.isArray(task.todos) ? task.todos : [];
      const done = arr.filter(td => td?.status === 'completed').length;
      const pct = arr.length ? Math.round((done / arr.length) * 100) : 0;
      const card = document.createElement('div');
      card.className = 'ztp-task-card';
      card.dataset.taskId = task.id || '';

      const row = document.createElement('div');
      row.className = 'ztp-task-header';
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.title = t('ui.activate', 'Set active task');

      const name = document.createElement('div');
      name.className = 'ztp-task-name';
      name.textContent = task.name || `(${t('ui.untitled', 'untitled')})`;

      const meta = document.createElement('div');
      meta.className = 'ztp-task-meta';
      const count = document.createElement('span');
      count.textContent = `${done}/${arr.length}`;
      const ts = document.createElement('span');
      ts.textContent = task.updatedAt ? new Date(task.updatedAt).toLocaleTimeString() : '';
      meta.appendChild(count);
      meta.appendChild(ts);

      row.appendChild(name);
      row.appendChild(meta);

      const activateTask = (e) => {
        e.preventDefault();
        try { window.zion.state.set('todo.activeTaskId', task.id); } catch {}
        updateActiveStyles();
      };
      row.addEventListener('click', activateTask);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') activateTask(e);
      });

      const progress = document.createElement('div');
      progress.className = 'ztp-progress';
      const progressBar = document.createElement('div');
      progressBar.className = 'ztp-progress-bar';
      progressBar.style.width = `${pct}%`;
      progress.appendChild(progressBar);

      // todos list
      const todosWrap = document.createElement('div');
      todosWrap.className = 'ztp-todos';

      arr.forEach((td, idx) => {
        const status = normalizeTodoStatus(td.status);
        const trow = document.createElement('div');
        trow.className = 'ztp-todo-row';
        trow.dataset.status = status;

        const badge = document.createElement('span');
        badge.className = 'ztp-status-dot';
        badge.dataset.status = status;
        badge.textContent = status === 'completed' ? '✓' : (status === 'in_progress' ? '…' : '');
        const content = document.createElement('div');
        content.className = 'ztp-todo-content';
        content.textContent = td.content || '';
        content.title = t('ui.footer', 'Click a task to activate, click todo text to advance status');
        content.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const next = status === 'pending' ? 'in_progress' : (status === 'in_progress' ? 'completed' : 'pending');
          updateTodoStatus(task, idx, td, next);
        });

        const actions = document.createElement('div');
        actions.className = 'ztp-status-actions';
        [
          ['pending', t('ui.pending', 'Todo')],
          ['in_progress', t('ui.inProgress', 'Doing')],
          ['completed', t('ui.completed', 'Done')]
        ].forEach(([nextStatus, label]) => {
          const btn = document.createElement('button');
          btn.className = `ztp-status-action${status === nextStatus ? ' is-selected' : ''}`;
          btn.textContent = label;
          btn.setAttribute('aria-pressed', String(status === nextStatus));
          btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            updateTodoStatus(task, idx, td, nextStatus);
          });
          actions.appendChild(btn);
        });

        trow.appendChild(badge);
        trow.appendChild(content);
        trow.appendChild(actions);
        todosWrap.appendChild(trow);
      });

      card.appendChild(row);
      card.appendChild(progress);
      card.appendChild(todosWrap);
      list.appendChild(card);
    });

    updateActiveStyles();
  }

  function updateActiveStyles() {
    const activeId = window.zion?.state?.get('todo.activeTaskId');
    for (const card of list.querySelectorAll('.ztp-task-card')) {
      card.classList.toggle('is-active', !!activeId && card.dataset.taskId === activeId);
    }
  }

  function normalizeTodoStatus(status) {
    return status === 'completed' || status === 'in_progress' ? status : 'pending';
  }

  function updateTodoStatus(task, idx, todo, nextStatus) {
    try {
      const tasksNow = Array.isArray(window.zion.state.get('todo.tasks')) ? window.zion.state.get('todo.tasks').slice() : [];
      const i = tasksNow.findIndex(x => x.id === task.id);
      if (i < 0) return;
      tasksNow[i] = { ...tasksNow[i], todos: Array.isArray(tasksNow[i].todos) ? tasksNow[i].todos.slice() : [] };
      const todoId = String(todo?.id || '');
      const idIdx = todoId ? tasksNow[i].todos.findIndex(tt => String(tt?.id || '') === todoId) : -1;
      if (idIdx >= 0) {
        tasksNow[i].todos[idIdx] = { ...tasksNow[i].todos[idIdx], status: nextStatus };
      } else if (tasksNow[i].todos[idx]) {
        tasksNow[i].todos[idx] = { ...tasksNow[i].todos[idx], status: nextStatus };
      } else {
        const matchIdx = tasksNow[i].todos.findIndex(tt => tt.content === todo.content);
        if (matchIdx >= 0) tasksNow[i].todos[matchIdx] = { ...tasksNow[i].todos[matchIdx], status: nextStatus };
      }
      tasksNow[i].updatedAt = Date.now();
      window.zion.state.set('todo.tasks', tasksNow);
    } catch (err) {
      console.error('[task-panel] update todo status error', err);
    }
  }

  btnClose.addEventListener('click', (e) => {
    e.preventDefault();
    close();
  });

  btnAdd.addEventListener('click', (e) => {
    e.preventDefault();
    const name = window.prompt?.(t('ui.newTaskName', 'Task name'), '');
    if (name === null) return;
    try { window.zion.commands.executeCommand('tasks.addTask', (name || '').trim() || undefined); } catch {}
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
    titleMain.textContent = t('ui.title', 'Tasks');
    btnAdd.title = t('ui.addTask', 'Add task');
    btnClose.title = t('ui.hidePanel', 'Hide panel');
    btnContinue.textContent = t('ui.continue', 'Continue');
    autoText.textContent = t('ui.auto', 'Auto');
    search.placeholder = t('ui.filter', 'Filter tasks...');
    footer.textContent = t('ui.footer', 'Click a task to activate, click todo text to advance status');
    renderTasks(window.zion?.state?.get('todo.tasks') || []);
  }

  return { open, close, toggle, renderTasks, dispose, showContinueBanner, hideContinueBanner, refreshI18n };
}

/**
 * Helper: create a new task object
 */
function createTaskObject(name, id) {
  return {
    id: id || createTaskId(),
    name: name || `Session ${new Date().toLocaleString()}`,
    todos: [],
    updatedAt: Date.now()
  };
}

function createTaskId() {
  return 'task-' + (Date.now()) + '-' + Math.random().toString(36).slice(2,8);
}

function createTodoId(index = 0) {
  return 'todo-' + Date.now() + '-' + index + '-' + Math.random().toString(36).slice(2,7);
}

function getCurrentChatSessionId() {
  try { return String(window.zion?.state?.get?.('sessions.currentId') || ''); } catch { return ''; }
}

function normalizeTodoItems(list) {
  return (Array.isArray(list) ? list : []).map((it, index) => ({
    id: String(it?.id || createTodoId(index)),
    content: it?.content || (typeof it === 'string' ? it : ''),
    status: it?.status || 'pending',
    activeForm: it?.activeForm || ''
  }));
}

function signatureForTodos(todos) {
  return JSON.stringify((todos || []).map(t => [
    String(t?.content || '').trim(),
    String(t?.activeForm || '').trim()
  ]));
}

function countSessionTasks(tasks, sessionId) {
  return (tasks || []).filter(t => String(t?.sessionId || '') === String(sessionId || '')).length;
}

function mergeTodoItems(nextTodos, previousTodos) {
  const previous = Array.isArray(previousTodos) ? previousTodos : [];
  const used = new Set();
  return (Array.isArray(nextTodos) ? nextTodos : []).map((todo, index) => {
    const id = String(todo?.id || '').trim();
    const byId = id ? previous.find(item => String(item?.id || '') === id) : null;
    const matched = byId || findReusableTodo(todo, index, previous, used);
    const stableId = id || String(matched?.id || '') || createTodoId(index);
    if (matched?.id) used.add(String(matched.id));
    return { ...todo, id: stableId };
  });
}

function findReusableTodo(todo, index, previous, used) {
  const exact = previous.find(item =>
    item?.id &&
    !used.has(String(item.id)) &&
    String(item?.content || '').trim() === String(todo?.content || '').trim() &&
    String(item?.activeForm || '').trim() === String(todo?.activeForm || '').trim()
  );
  if (exact) return exact;
  const sameIndex = previous[index];
  if (sameIndex?.id && !used.has(String(sameIndex.id))) return sameIndex;
  return null;
}

function loadPersistedTasksState() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_TASKS_STATE) || '{}');
    return {
      tasks: sanitizePersistedTasks(raw?.tasks),
      activeTaskId: typeof raw?.activeTaskId === 'string' ? raw.activeTaskId : null
    };
  } catch {
    return { tasks: [], activeTaskId: null };
  }
}

function savePersistedTasksState(tasks, activeTaskId) {
  try {
    localStorage.setItem(LS_TASKS_STATE, JSON.stringify({
      version: 1,
      activeTaskId: typeof activeTaskId === 'string' ? activeTaskId : null,
      tasks: sanitizePersistedTasks(tasks).slice(0, MAX_PERSISTED_TASKS)
    }));
  } catch (e) {
    console.warn('[task-panel] persist tasks failed', e);
  }
}

function sanitizePersistedTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks.filter(Boolean).map((task) => ({
    ...task,
    id: String(task?.id || createTaskId()),
    name: String(task?.name || 'Task'),
    sessionId: String(task?.sessionId || ''),
    todos: normalizeTodoItems(task?.todos),
    updatedAt: Number(task?.updatedAt || Date.now())
  })).filter(task => task.todos.length || task.source === 'manual');
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
Please read the info above, check the task status and continue to work out the following todos for task "${task.name || ''}".\n\nImportant: After completing each todo item, use the todoWrite tool to update the task status so we can track progress. Keep the same taskId and todo ids when updating this list.\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;

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

export async function activate(ctx) {
  try {
    const disp = window.zion.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) ctx.subscriptions.push(disp);
  } catch {}

  ensureStateKeys();

  let runtimeTodoRefreshTimer = 0;
  const restoreRuntimeTodoProjection = async () => {
    try {
      const todoLists = await loadRuntimeTodoLists({ limit: MAX_PERSISTED_TASKS });
      if (!todoLists.length) return [];
      return applyRuntimeTodoListsToState(todoLists);
    } catch (e) {
      try {
        window.zion?.state?.set?.('todo.runtimeSync', {
          status: 'error',
          syncedAt: Date.now(),
          error: e?.message || String(e)
        });
      } catch {}
      return [];
    }
  };
  const scheduleRuntimeTodoRestore = (delay = 250) => {
    try {
      if (runtimeTodoRefreshTimer) window.clearTimeout(runtimeTodoRefreshTimer);
      runtimeTodoRefreshTimer = window.setTimeout(() => {
        runtimeTodoRefreshTimer = 0;
        void restoreRuntimeTodoProjection();
      }, Math.max(0, Number(delay) || 0));
    } catch {}
  };
  ctx.subscriptions.push({
    dispose() {
      try {
        if (runtimeTodoRefreshTimer) window.clearTimeout(runtimeTodoRefreshTimer);
      } catch {}
      runtimeTodoRefreshTimer = 0;
    }
  });

  // Panel handle (created via decorator apply)
  let panelHandle = null;

  try {
    document.getElementById('zion-task-panel-root')?.remove?.();
  } catch {}
  if (TASK_PANEL_UI_ENABLED) {
    // Legacy floating task panel is disabled; @Context owns the task UX now.
    const dec = window.zion.editor.registerDecorator({
      id: 'dev.task-panel.decorator',
      apply() {
        panelHandle = createPanelHandle();
        return { dispose() { try { panelHandle?.dispose?.(); } catch {} finally { panelHandle = null; } } };
      }
    });
    ctx.subscriptions.push(dec);
  }

  // Command: toggle panel
  const cmdToggle = window.zion.commands.registerCommand('tasks.togglePanel', () => {
    if (TASK_PANEL_UI_ENABLED && panelHandle) panelHandle.toggle();
  });
  ctx.subscriptions.push(cmdToggle);

  // Command: add task
  const cmdAdd = window.zion.commands.registerCommand('tasks.addTask', (name) => {
    try {
      const tasks = Array.isArray(window.zion.state.get('todo.tasks')) ? window.zion.state.get('todo.tasks').slice() : [];
      const t = createTaskObject(name || `Task ${tasks.length + 1}`);
      t.sessionId = getCurrentChatSessionId();
      t.source = 'manual';
      tasks.unshift(t); // newest first
      window.zion.state.set('todo.tasks', tasks);
      window.zion.state.set('todo.activeTaskId', t.id);
    } catch (e) { console.warn('[task-panel] add task failed', e); }
  });
  ctx.subscriptions.push(cmdAdd);

  // Command: clear tasks
  const cmdClear = window.zion.commands.registerCommand('tasks.clearTasks', () => {
    try {
      window.zion.state.set('todo.tasks', []);
      window.zion.state.set('todo.activeTaskId', null);
      savePersistedTasksState([], null);
    } catch (e) { console.warn('[task-panel] clear tasks failed', e); }
  });
  ctx.subscriptions.push(cmdClear);

  try {
    document.querySelectorAll('[data-zion-status-id="dev.task-panel.status"]').forEach(el => el.remove());
  } catch {}

  // Listen to tasks state changes to re-render the panel.
  const dispTasksChange = window.zion.state.onDidChange('todo.tasks', (newVal) => {
    try {
      savePersistedTasksState(newVal || [], window.zion.state.get('todo.activeTaskId'));
      if (panelHandle) panelHandle.renderTasks(newVal || []);
    } catch (e) { console.warn('[task-panel] tasks change render error', e); }
  });
  ctx.subscriptions.push(dispTasksChange);

  const dispActiveTaskChange = window.zion.state.onDidChange('todo.activeTaskId', (newVal) => {
    try {
      const tasks = Array.isArray(window.zion.state.get('todo.tasks')) ? window.zion.state.get('todo.tasks') : [];
      savePersistedTasksState(tasks, newVal || null);
    } catch (e) { console.warn('[task-panel] active task persist error', e); }
  });
  ctx.subscriptions.push(dispActiveTaskChange);

  const dispRuntimeConnection = window.zion.state.onDidChange('runtime.connection', () => {
    scheduleRuntimeTodoRestore(100);
  });
  ctx.subscriptions.push(dispRuntimeConnection);

  // When todo.list changes (from tool calls), append/update the matching session task snapshot.
  const dispTodoList = window.zion.state.onDidChange('todo.list', (newList) => {
    try {
      let todos = normalizeTodoItems(newList);
      const tasks = Array.isArray(window.zion.state.get('todo.tasks')) ? window.zion.state.get('todo.tasks').slice() : [];
      const write = window.zion.state.get('todo.lastWrite') || {};
      const sessionId = String(write?.sessionId || getCurrentChatSessionId() || '');
      const taskId = String(write?.taskId || '');
      const signature = String(write?.signature || signatureForTodos(todos));
      let idx = taskId ? tasks.findIndex(t => String(t?.id || '') === taskId) : -1;
      if (idx < 0 && !taskId) {
        const activeTaskId = String(window.zion.state.get('todo.activeTaskId') || '');
        idx = activeTaskId ? tasks.findIndex(t =>
          String(t?.id || '') === activeTaskId &&
          String(t?.sessionId || '') === sessionId
        ) : -1;
      }
      if (idx < 0 && !taskId) {
        idx = tasks.findIndex(t =>
          String(t?.sessionId || '') === sessionId &&
          String(t?.todoSignature || '') === signature
        );
      }
      const now = Date.now();
      if (idx >= 0) {
        todos = mergeTodoItems(todos, tasks[idx]?.todos);
        tasks[idx] = {
          ...tasks[idx],
          todos,
          sessionId,
          todoSignature: signature,
          source: tasks[idx]?.source || 'todoWrite',
          sourceToolCallId: write?.toolCallId || tasks[idx]?.sourceToolCallId || '',
          sourceWriteSeq: write?.seq || tasks[idx]?.sourceWriteSeq || 0,
          updatedAt: now
        };
        window.zion.state.set('todo.tasks', tasks);
        window.zion.state.set('todo.activeTaskId', tasks[idx].id);
      } else {
        const t = createTaskObject(`Task ${countSessionTasks(tasks, sessionId) + 1}`, taskId || undefined);
        t.todos = todos;
        t.sessionId = sessionId;
        t.todoSignature = signature;
        t.source = 'todoWrite';
        t.sourceToolCallId = write?.toolCallId || '';
        t.sourceWriteSeq = write?.seq || 0;
        t.createdAt = write?.createdAt || now;
        t.updatedAt = now;
        tasks.unshift(t);
        window.zion.state.set('todo.tasks', tasks);
        window.zion.state.set('todo.activeTaskId', t.id);
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
    const sessionId = getCurrentChatSessionId();
    return tasks.find(t => t.id === activeId && String(t?.sessionId || '') === sessionId) || null;
  }

  // When a chat run finishes, auto-continue if explicitly enabled. No legacy panel popup.
  const handleRunEnd = async ({ aborted = false } = {}) => {
    try {
      if (aborted) return;
      const task = getActiveTask();
      if (!task) return;
      if (!hasIncompleteTodos(task)) {
        return;
      }

      const auto = !!window.zion.state.get('todo.autoContinue');
      const lock = !!window.zion.state.get('__todo_auto_continue_lock');
      if (auto && !lock) {
        await appendUserInstructionAndRun(task);
      }
    } catch (e) {
      console.warn('[task-panel] handleRunEnd error', e);
    }
  };

  const dispRunFinished = window.zion.events.on('chat/runFinished', async (p) => {
    // clear any lock when a run finishes (we waited for it)
    try { window.zion.state.set('__todo_auto_continue_lock', false); } catch {}
    await restoreRuntimeTodoProjection();
    handleRunEnd();
  });
  ctx.subscriptions.push(dispRunFinished);

  const dispAborted = window.zion.events.on('chat/aborted', (p) => {
    try { window.zion.state.set('__todo_auto_continue_lock', false); } catch {}
    handleRunEnd({ aborted: true });
  });
  ctx.subscriptions.push(dispAborted);

  // When a run starts we can keep the lock active (prevents multiple triggers)
  const dispRunStarted = window.zion.events.on('chat/runStarted', (p) => {
    try { /* keep lock until finished */ } catch {}
  });
  ctx.subscriptions.push(dispRunStarted);

  const dispI18n = window.zion.events.on('i18n/changed', () => {
    try {
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

  scheduleRuntimeTodoRestore(0);

  // Clean-up on deactivate handled by ctx.subscriptions
}
