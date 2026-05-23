const I18N_NS = 'dev.roles';
const I18N_MESSAGES = {
  'zh-CN': {
    'category.roles': '角色',
    'cmd.toggle': '切换角色',
    'cmd.configure': '配置角色',
    'ui.configure': '角色配置',
    'ui.configureMenu': '配置自定义角色...',
    'ui.tooltip': '配置自定义角色和高亮块角色',
    'settings.title': 'Roles',
    'settings.description': '角色前缀与块级高亮',
    'settings.basics': '基础配置',
    'settings.prefixes': '角色前缀',
    'settings.prefixes.description': '每行一个角色名称。保存后新编辑器会使用这些前缀。'
  },
  'en-US': {
    'category.roles': 'Roles',
    'cmd.toggle': 'Toggle Roles',
    'cmd.configure': 'Configure Roles',
    'ui.configure': 'Role Settings',
    'ui.configureMenu': 'Configure custom roles...',
    'ui.tooltip': 'Configure custom roles and highlighted block roles',
    'settings.title': 'Roles',
    'settings.description': 'Role prefixes and block highlighting',
    'settings.basics': 'Basics',
    'settings.prefixes': 'Role Prefixes',
    'settings.prefixes.description': 'One role name per line. New editors will use these prefixes after saving.'
  }
};

function t(key, fallback) {
  const fullKey = `${I18N_NS}.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

function showRolesConfigModal() {
  try {
    const id = 'dev-roles-config-modal';
    document.getElementById(id)?.remove();

    const overlay = document.createElement('div');
    overlay.id = id;
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0,0,0,0.35)';
    overlay.style.zIndex = '9999';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';

    const panel = document.createElement('div');
    panel.className = 'roles-config-panel';
    panel.style.background = 'var(--panel)';
    panel.style.color = 'var(--fg)';
    panel.style.borderRadius = '8px';
    panel.style.boxShadow = '0 10px 30px rgba(0,0,0,0.2)';
    panel.style.width = '520px';
    panel.style.maxWidth = '92vw';
    panel.style.padding = '16px 18px';
    panel.style.fontFamily = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';

    const title = document.createElement('h3');
    title.textContent = t('cmd.configure', 'Configure Roles');
    title.style.margin = '0 0 8px 0';
    title.style.fontSize = '18px';

    const desc = document.createElement('div');
    desc.innerHTML = '添加/编辑自定义角色前缀（逗号分隔）。例如：coder, jarvis<br/>保存后建议刷新使装饰器立即生效。';
    desc.style.fontSize = '12px';
    desc.style.opacity = '0.8';
    desc.style.marginBottom = '10px';

    const field1 = document.createElement('div');
    const label1 = document.createElement('label');
    label1.textContent = t('settings.prefixes', 'Custom Role Prefixes');
    label1.style.display = 'block';
    label1.style.fontSize = '12px';
    label1.style.margin = '8px 0 4px';

    const inputRoles = document.createElement('input');
    inputRoles.type = 'text';
    inputRoles.placeholder = 'e.g. coder, jarvis';
    inputRoles.style.width = '100%';
    inputRoles.style.boxSizing = 'border-box';
    inputRoles.style.padding = '8px';
    inputRoles.style.border = '1px solid var(--border)';
    inputRoles.style.borderRadius = '6px';
    inputRoles.style.background = 'var(--panel)';
    inputRoles.style.color = 'var(--fg)';

    // 读取当前值
    const readArray = (primaryKey, fallbackKey, cfgPathArr) => {
      try {
        const raw = localStorage.getItem(primaryKey) || (fallbackKey ? localStorage.getItem(fallbackKey) : null);
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) return arr;
        }
      } catch {}
      try {
        // 从 window.zion.config 读取
        let obj = window?.zion?.config;
        for (const k of (cfgPathArr || [])) obj = obj?.[k];
        if (Array.isArray(obj)) return obj;
      } catch {}
      return [];
    };

    const currentRoles = readArray('zion.roles.prefixes', 'dev.roles.prefixes', ['roles','prefixes']);
    inputRoles.value = currentRoles.join(', ');

    const field2 = document.createElement('div');
    const label2 = document.createElement('label');
    label2.textContent = 'Highlight Block Roles';
    label2.style.display = 'block';
    label2.style.fontSize = '12px';
    label2.style.margin = '12px 0 4px';

    const inputHighlight = document.createElement('input');
    inputHighlight.type = 'text';
    inputHighlight.placeholder = 'e.g. user, coder';
    inputHighlight.style.width = '100%';
    inputHighlight.style.boxSizing = 'border-box';
    inputHighlight.style.padding = '8px';
    inputHighlight.style.border = '1px solid var(--border)';
    inputHighlight.style.borderRadius = '6px';
    inputHighlight.style.background = 'var(--panel)';
    inputHighlight.style.color = 'var(--fg)';

    const currentHL = readArray('zion.roles.highlightBlockRoles', 'dev.roles.highlightBlockRoles', ['roles','highlightBlockRoles']);
    inputHighlight.value = currentHL.join(', ');

    const btns = document.createElement('div');
    btns.style.display = 'flex';
    btns.style.gap = '8px';
    btns.style.marginTop = '14px';
    btns.style.justifyContent = 'flex-end';

    const btnSave = document.createElement('button');
    btnSave.textContent = 'Save';
    btnSave.className = 'roles-config-btn roles-config-btn-save';
    btnSave.style.padding = '6px 12px';
    btnSave.style.border = '1px solid var(--accent)';
    btnSave.style.background = 'var(--accent)';
    btnSave.style.color = 'var(--panel)';
    btnSave.style.borderRadius = '6px';
    btnSave.style.cursor = 'pointer';

    const btnCancel = document.createElement('button');
    btnCancel.textContent = 'Cancel';
    btnCancel.className = 'roles-config-btn roles-config-btn-cancel';
    btnCancel.style.padding = '6px 12px';
    btnCancel.style.border = '1px solid var(--border)';
    btnCancel.style.background = 'var(--panel)';
    btnCancel.style.color = 'var(--fg)';
    btnCancel.style.borderRadius = '6px';
    btnCancel.style.cursor = 'pointer';

    const normalize = (s) => {
      return (s || '')
        .split(',')
        .map(x => x.trim())
        .filter(x => !!x)
        .filter((x, i, a) => a.indexOf(x) === i);
    };

    btnSave.addEventListener('click', () => {
      const rolesArr = normalize(inputRoles.value);
      const hlArr = normalize(inputHighlight.value);

      try {
        localStorage.setItem('zion.roles.prefixes', JSON.stringify(rolesArr));
        localStorage.setItem('zion.roles.highlightBlockRoles', JSON.stringify(hlArr));
      } catch (e) {
        console.error('[dev.roles] 保存失败:', e);
        alert('保存失败：' + (e?.message || e));
        return;
      }

      overlay.remove();
      const needReload = confirm('已保存。是否立即刷新以应用新的角色设置？');
      if (needReload) {
        try { location.reload(); } catch {}
      }
    });

    btnCancel.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
      }
    });

    field1.appendChild(label1);
    field1.appendChild(inputRoles);
    field2.appendChild(label2);
    field2.appendChild(inputHighlight);
    btns.appendChild(btnCancel);
    btns.appendChild(btnSave);

    panel.appendChild(title);
    panel.appendChild(desc);
    panel.appendChild(field1);
    panel.appendChild(field2);
    panel.appendChild(btns);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  } catch (e) {
    console.error('[dev.roles] 打开配置面板失败:', e);
    alert('打开配置面板失败：' + (e?.message || e));
  }
}

function setCurrentLineRole(editor, role) {
  const ed = editor || window.zion?.window?.activeEditor;
  if (!ed || typeof ed.getValue !== 'function' || typeof ed.replaceRange !== 'function') return;
  const cursor = ed.getCursor?.();
  const line = cursor?.line;
  if (typeof line !== 'number' || line < 0) return;

  const doc = String(ed.getValue() || "");
  const lines = doc.split("\n");
  if (line >= lines.length) return;

  const original = String(lines[line] ?? "");
  const stripped = original.replace(/^\s*(user|assistant|system|tool)\s+/, "");
  const prefix = `${role} `;
  const next = prefix + stripped;
  try {
    ed.replaceRange(next, { line, ch: 0 }, { line, ch: original.length });
    ed.setCursor?.({ line, ch: prefix.length });
    ed.focus?.();
  } catch {}
}

function toggleCurrentLineUser(editor) {
  const ed = editor || window.zion?.window?.activeEditor;
  if (!ed || typeof ed.getValue !== 'function' || typeof ed.replaceRange !== 'function') return;
  const cursor = ed.getCursor?.();
  const line = cursor?.line;
  if (typeof line !== 'number' || line < 0) return;

  const doc = String(ed.getValue() || "");
  const lines = doc.split("\n");
  if (line >= lines.length) return;

  const original = String(lines[line] ?? "");
  const m = /^(\s*)user\s+/.exec(original);
  if (m) {
    const next = m[1] + original.slice(m[0].length);
    try {
      ed.replaceRange(next, { line, ch: 0 }, { line, ch: original.length });
      ed.setCursor?.({ line, ch: m[1].length });
      ed.focus?.();
    } catch {}
    return;
  }
  setCurrentLineRole(ed, 'user');
}

function insertRoleLineBelow(editor, role) {
  const ed = editor || window.zion?.window?.activeEditor;
  if (!ed || typeof ed.getValue !== 'function' || typeof ed.replaceRange !== 'function') return;
  const cursor = ed.getCursor?.();
  const line = cursor?.line;
  if (typeof line !== 'number' || line < 0) return;

  const doc = String(ed.getValue() || "");
  const lines = doc.split("\n");
  const curLineText = String(lines[line] ?? "");
  const insertAt = { line, ch: curLineText.length };
  const text = `\n${role} `;

  try {
    ed.replaceRange(text, insertAt);
    ed.setCursor?.({ line: line + 1, ch: `${role} `.length });
    ed.focus?.();
  } catch {}
}

function readRoleList(key, fallback = []) {
  try {
    const raw = localStorage.getItem(key);
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(v => String(v)) : fallback.slice();
  } catch {
    return fallback.slice();
  }
}

function writeRoleList(key, values) {
  const next = Array.isArray(values)
    ? values.map(v => String(v).trim()).filter(Boolean)
    : [];
  try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
  return next;
}

export async function activate(ctx) {
  try {
    const i18nDisp = window.zion.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (i18nDisp) ctx.subscriptions.push(i18nDisp);

    // Dynamically import roles() from local extension module
    const mod = await import('./roles.js');
    const roles = mod.roles;

    // Register as a lightweight decorator that injects the CM6 extension
    const disp = window.zion.editor.registerDecorator({
      id: 'dev.roles.decorator',
      apply(editor) {
        try {
          if (typeof editor.addVisualExtension === 'function' && typeof roles === 'function') {
            editor.addVisualExtension(roles());
          } else {
            console.warn('[dev.roles] editor.addVisualExtension or roles() unavailable');
          }
        } catch (e) {
          console.error('[dev.roles] failed to attach roles extension:', e);
        }
        return { dispose() { /* no-op for MVP */ } };
      }
    });

    ctx.subscriptions.push(disp);
    // Optional command hook
    const cmd = window.zion.commands.registerCommand('roles.toggle', () => {
      // For MVP: re-apply extension (no toggle state). Could be extended to enable/disable.
      try {
        // Re-inject to ensure active after reloads
        window.zion.window?.activeEditor?.addVisualExtension?.(roles());
      } catch {}
    });
    ctx.subscriptions.push(cmd);

    // 打开配置面板
    const cmdCfg = window.zion.commands.registerCommand('roles.configure', () => {
      showRolesConfigModal();
    });
    ctx.subscriptions.push(cmdCfg);

    const cmdSetRole = window.zion.commands.registerCommand('roles.setRole', (role, editor) => {
      if (typeof role !== 'string' || !role.trim()) return;
      setCurrentLineRole(editor, role.trim());
    });
    ctx.subscriptions.push(cmdSetRole);

    const cmdUser = window.zion.commands.registerCommand('roles.setUser', (editor) => setCurrentLineRole(editor, 'user'));
    const cmdToggleUser = window.zion.commands.registerCommand('roles.toggleUser', (editor) => toggleCurrentLineUser(editor));
    const cmdAssistant = window.zion.commands.registerCommand('roles.setAssistant', (editor) => setCurrentLineRole(editor, 'assistant'));
    const cmdSystem = window.zion.commands.registerCommand('roles.setSystem', (editor) => setCurrentLineRole(editor, 'system'));
    ctx.subscriptions.push(cmdUser, cmdToggleUser, cmdAssistant, cmdSystem);

    const cmdInsertUser = window.zion.commands.registerCommand('roles.insertUserBelow', (editor) => insertRoleLineBelow(editor, 'user'));
    const cmdInsertAssistant = window.zion.commands.registerCommand('roles.insertAssistantBelow', (editor) => insertRoleLineBelow(editor, 'assistant'));
    const cmdInsertSystem = window.zion.commands.registerCommand('roles.insertSystemBelow', (editor) => insertRoleLineBelow(editor, 'system'));
    ctx.subscriptions.push(cmdInsertUser, cmdInsertAssistant, cmdInsertSystem);

    const dSlashRoleUser = window.zion.slash?.registerCommand?.({
      id: 'roles.setUser',
      trigger: ['u', 'user', 'role.user'],
      title: '当前行设为 user',
      description: '将当前行开头设为 user 角色前缀',
      category: 'chat',
      priority: 95,
      execute: (_params, editor) => setCurrentLineRole(editor, 'user')
    });
    const dSlashRoleAssistant = window.zion.slash?.registerCommand?.({
      id: 'roles.setAssistant',
      trigger: ['a', 'assistant', 'role.assistant'],
      title: '当前行设为 assistant',
      description: '将当前行开头设为 assistant 角色前缀',
      category: 'chat',
      priority: 94,
      execute: (_params, editor) => setCurrentLineRole(editor, 'assistant')
    });
    const dSlashRoleSystem = window.zion.slash?.registerCommand?.({
      id: 'roles.setSystem',
      trigger: ['s', 'system', 'role.system'],
      title: '当前行设为 system',
      description: '将当前行开头设为 system 角色前缀',
      category: 'chat',
      priority: 93,
      execute: (_params, editor) => setCurrentLineRole(editor, 'system')
    });

    const dSlashInsertUser = window.zion.slash?.registerCommand?.({
      id: 'roles.insertUserBelow',
      trigger: ['iu', 'insert.user', 'role.insert.user'],
      title: '下一行插入 user',
      description: '在下一行插入 user 角色前缀并把光标放到后面',
      category: 'chat',
      priority: 85,
      execute: (_params, editor) => insertRoleLineBelow(editor, 'user')
    });
    const dSlashInsertAssistant = window.zion.slash?.registerCommand?.({
      id: 'roles.insertAssistantBelow',
      trigger: ['ia', 'insert.assistant', 'role.insert.assistant'],
      title: '下一行插入 assistant',
      description: '在下一行插入 assistant 角色前缀并把光标放到后面',
      category: 'chat',
      priority: 84,
      execute: (_params, editor) => insertRoleLineBelow(editor, 'assistant')
    });
    const dSlashInsertSystem = window.zion.slash?.registerCommand?.({
      id: 'roles.insertSystemBelow',
      trigger: ['is', 'insert.system', 'role.insert.system'],
      title: '下一行插入 system',
      description: '在下一行插入 system 角色前缀并把光标放到后面',
      category: 'chat',
      priority: 83,
      execute: (_params, editor) => insertRoleLineBelow(editor, 'system')
    });

    if (dSlashRoleUser) ctx.subscriptions.push(dSlashRoleUser);
    if (dSlashRoleAssistant) ctx.subscriptions.push(dSlashRoleAssistant);
    if (dSlashRoleSystem) ctx.subscriptions.push(dSlashRoleSystem);
    if (dSlashInsertUser) ctx.subscriptions.push(dSlashInsertUser);
    if (dSlashInsertAssistant) ctx.subscriptions.push(dSlashInsertAssistant);
    if (dSlashInsertSystem) ctx.subscriptions.push(dSlashInsertSystem);

    if (window.zion?.keybindings?.register) {
      const dKBUser = window.zion.keybindings.register({ command: 'roles.setUser', key: 'Mod-Alt-u', when: 'editorFocus' });
      const dKBUserQuick = window.zion.keybindings.register({ command: 'roles.toggleUser', key: 'Mod-u', when: 'editorFocus' });
      const dKBAssistant = window.zion.keybindings.register({ command: 'roles.setAssistant', key: 'Mod-Alt-a', when: 'editorFocus' });
      const dKBSystem = window.zion.keybindings.register({ command: 'roles.setSystem', key: 'Mod-Alt-s', when: 'editorFocus' });
      ctx.subscriptions.push(dKBUser, dKBUserQuick, dKBAssistant, dKBSystem);
    }

    // 右键菜单入口
    if (window.zion?.menus?.register) {
      const dispMenu = window.zion.menus.register('editor/context', {
        command: 'roles.configure',
        title: t('ui.configureMenu', '配置自定义角色...'),
        when: 'editorFocus'
      });
      ctx.subscriptions.push(dispMenu);
    }

    // 配置入口：优先放到 editor header 菜单，保留 statusBar 作为旧 API 兜底。
    if (window.zion?.editorHeaderMenu?.register || window.zion?.statusBar?.registerItem) {
      let dispStatus = null;
      const updateStatus = () => {
        try { dispStatus?.dispose?.(); } catch {}
        dispStatus = window.zion.editorHeaderMenu?.register?.({
          id: 'dev.roles.config',
          title: t('ui.configure', '角色配置'),
          section: 'Extensions',
          order: 30,
          onClick: showRolesConfigModal
        }) || window.zion.statusBar.registerItem({
          id: 'dev.roles.config',
          text: t('ui.configure', '角色配置'),
          tooltip: t('ui.tooltip', '配置自定义角色和高亮块角色'),
          onClick: showRolesConfigModal
        });
      };
      updateStatus();
      ctx.subscriptions.push(
        { dispose: () => { try { dispStatus?.dispose?.(); } catch {} } },
        window.zion.events.on('i18n/changed', updateStatus)
      );
    }

    try {
      window.zion.settings.registerPage({
        id: 'roles.preferences',
        pluginId: 'dev.roles',
        category: 'workspace',
        title: 'Roles',
        titleKey: 'dev.roles.settings.title',
        description: '角色前缀与块级高亮',
        descriptionKey: 'dev.roles.settings.description',
        order: 36,
        sections: [
          {
            id: 'roles.basics',
            title: '基础配置',
            titleKey: 'dev.roles.settings.basics',
            settings: [
              {
                id: 'roles.prefixes',
                kind: 'textarea',
                label: '角色前缀',
                labelKey: 'dev.roles.settings.prefixes',
                description: '每行一个角色名称。保存后新编辑器会使用这些前缀。',
                descriptionKey: 'dev.roles.settings.prefixes.description',
                placeholder: 'user\nassistant\nsystem',
                getValue: () => readRoleList('zion.roles.prefixes', []).join('\n'),
                setValue: async (value) => {
                  const next = String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
                  writeRoleList('zion.roles.prefixes', next);
                  try { localStorage.setItem('dev.roles.prefixes', JSON.stringify(next)); } catch {}
                }
              },
              {
                id: 'roles.highlightBlocks',
                kind: 'textarea',
                label: '高亮块角色',
                description: '这些角色会渲染为更明显的块样式。',
                placeholder: 'system\ntool',
                getValue: () => readRoleList('zion.roles.highlightBlockRoles', []).join('\n'),
                setValue: async (value) => {
                  const next = String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
                  writeRoleList('zion.roles.highlightBlockRoles', next);
                  try { localStorage.setItem('dev.roles.highlightBlockRoles', JSON.stringify(next)); } catch {}
                }
              },
              {
                id: 'roles.openAdvanced',
                kind: 'action',
                label: '高级角色配置',
                description: '打开角色配置弹窗做更细的调整',
                actionLabel: '打开角色配置',
                action: async () => window.zion.commands.executeCommand('roles.configure')
              }
            ]
          }
        ]
      });
    } catch (registerError) {
      console.error('[dev.roles] register settings page failed:', registerError);
    }
  } catch (e) {
    console.error('[dev.roles] activation error:', e);
  }
}
