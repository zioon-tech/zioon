function iconHtml(name, size = 14) {
  try {
    const html = window.zionIcons?.htmlFromCodicon?.(name, "", size);
    if (html) return html;
  } catch {}
  return `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
}

export function renderSessionsTagHeader(container, context, deps) {
  const manager = deps?.manager;
  const t = deps?.t || ((_key, fallback) => fallback);
  container.classList.add("zion-sessions-header-leading");

  const title = document.createElement("span");
  title.className = "zion-sessions-header-title";
  const count = document.createElement("span");
  count.className = "zion-sessions-header-count";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "zion-sessions-header-add";
  add.innerHTML = iconHtml("add");

  const refreshText = () => {
    title.textContent = t("tags.title", "All Tags");
    const label = t("tags.addTag", "New tag");
    add.title = label;
    add.setAttribute("aria-label", label);
  };
  refreshText();
  add.onclick = (event) => {
    event.stopPropagation();
    manager?.createRootTagIfOpen?.();
  };
  container.replaceChildren(title, count, add);

  const headerDisposable = manager?.attachTagSplitHeader?.((snapshot) => {
    context.setWidth(snapshot.width);
    context.setVisible(snapshot.visible);
    count.textContent = String(snapshot.nodeCount || 0);
  });
  let i18nDisposable = null;
  try {
    i18nDisposable = window.zion?.events?.on?.("i18n/changed", refreshText) || null;
  } catch {}

  return {
    dispose() {
      try { headerDisposable?.dispose?.(); } catch {}
      try { i18nDisposable?.dispose?.(); } catch {}
      context.setVisible(false);
      container.replaceChildren();
      container.classList.remove("zion-sessions-header-leading");
    }
  };
}
