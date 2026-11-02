async function copyCommand(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {}
  // Keep command copying usable in the standalone file preview as well.
  const buffer = document.createElement("textarea");
  buffer.className = "home-copy-buffer";
  buffer.value = text;
  buffer.readOnly = true;
  const previousFocus = document.activeElement;
  document.body.append(buffer);
  try {
    buffer.select();
    if (!document.execCommand("copy")) throw new Error("clipboard_unavailable");
  } finally {
    buffer.remove();
    previousFocus?.focus({ preventScroll: true });
  }
}

const copyTimers = new WeakMap();
for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copy);
    if (!target) return;
    const status = document.getElementById("copy-status");
    clearTimeout(copyTimers.get(button));
    try {
      await copyCommand(target.textContent);
      button.textContent = "已复制";
      button.dataset.copied = "true";
      if (status) status.textContent = "命令已复制到剪贴板。";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      button.textContent = "已选中";
      if (status) status.textContent = "命令已选中，请使用复制快捷键。";
    }
    copyTimers.set(button, setTimeout(() => {
      button.textContent = "复制";
      delete button.dataset.copied;
    }, 2200));
  });
}
