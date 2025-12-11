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
    title.textContent = 'Configure Roles';
    title.style.margin = '0 0 8px 0';
    title.style.fontSize = '18px';

    const desc = document.createElement('div');
    desc.innerHTML = '添加/编辑自定义角色前缀（逗号分隔）。例如：coder, jarvis<br/>保存后建议刷新使装饰器立即生效。';
    desc.style.fontSize = '12px';
    desc.style.opacity = '0.8';
    desc.style.marginBottom = '10px';

    const field1 = document.createElement('div');
    const label1 = document.createElement('label');
    label1.textContent = 'Custom Role Prefixes';
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

export async function activate(ctx) {
  try {
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

    // 右键菜单入口
    if (window.zion?.menus?.register) {
      const dispMenu = window.zion.menus.register('editor/context', {
        command: 'roles.configure',
        title: '配置自定义角色…',
        when: 'editorFocus'
      });
      ctx.subscriptions.push(dispMenu);
    }

    // 状态栏按钮入口
    if (window.zion?.statusBar?.registerItem) {
      const dispStatus = window.zion.statusBar.registerItem({
        id: 'dev.roles.config',
        text: '角色配置',
        tooltip: '配置自定义角色和高亮块角色',
        onClick: showRolesConfigModal
      });
      ctx.subscriptions.push(dispStatus);
    }
  } catch (e) {
    console.error('[dev.roles] activation error:', e);
  }
}