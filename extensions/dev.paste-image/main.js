const IMAGE_URL_RE = /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp|bmp|svg|avif)(?:\?.*)?$/i;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

function probeClipboard(clipboardData) {
  const files = [...(clipboardData?.files || [])]
    .filter(file => file?.type?.startsWith("image/"));
  if (files.length) return files;

  const itemFiles = [...(clipboardData?.items || [])]
    .filter(item => item?.kind === "file" && item?.type?.startsWith("image/"))
    .map(item => item.getAsFile?.())
    .filter(Boolean);
  if (itemFiles.length) return itemFiles;

  const html = clipboardData?.getData?.("text/html") || "";
  if (html) {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const sources = [...parsed.querySelectorAll("img[src]")]
      .map(image => image.getAttribute("src"))
      .filter(Boolean);
    if (sources.length) return sources;
  }

  const text = String(clipboardData?.getData?.("text/plain") || "").trim();
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(text) || IMAGE_URL_RE.test(text)) {
    return [text];
  }
  return [];
}

function imageAlt(source) {
  if (!(typeof globalThis.File === "function" && source instanceof globalThis.File)) return "";
  return source.name.replace(/\.[^.]+$/, "");
}

async function storeSource(source) {
  if (typeof source === "string" && /^https?:/i.test(source)) {
    return source;
  }
  const media = window.zion?.media;
  if (media?.putImage) {
    return await media.putImage(source, typeof globalThis.File === "function" && source instanceof globalThis.File
      ? { name: source.name, mimeType: source.type }
      : {});
  }
  return typeof source === "string" ? source : await readAsDataUrl(source);
}

async function insertSources(editor, sources, options = {}) {
  const imageApi = window.zion?.editor?.images;
  if (!editor || !sources.length) return false;

  if (!imageApi?.begin || !imageApi?.complete) {
    const stored = await Promise.all(sources.map(storeSource));
    const markdown = stored.map((src, index) => `![${imageAlt(sources[index])}](${src})`).join("\n");
    editor.replaceSelection(sources.length > 1 ? `\n${markdown}\n` : markdown);
    return true;
  }

  let operationId = "";
  const run = async () => {
    try {
      const stored = await Promise.all(sources.map(storeSource));
      const images = stored.map((src, index) => ({
        src,
        alt: imageAlt(sources[index])
      }));
      imageApi.complete(editor, operationId, images);
    } catch (error) {
      imageApi.fail(
        editor,
        operationId,
        error instanceof Error ? error.message : "图片导入失败"
      );
    }
  };

  operationId = imageApi.begin(editor, {
    count: sources.length,
    position: options.position,
    from: options.from,
    to: options.to,
    userEvent: options.userEvent || "input.image",
    retry: run
  });
  await run();
  return true;
}

function registerExternalDrop(ctx) {
  const disposable = window.zion?.editor?.registerDecorator?.({
    id: "dev.paste-image.drop",
    apply(editor) {
      const view = editor?.getView?.();
      if (!view) return { dispose() {} };

      const onDragOver = (event) => {
        const items = [...(event.dataTransfer?.items || [])]
          .filter(item => item?.kind === "file" && item?.type?.startsWith("image/"));
        const files = [...(event.dataTransfer?.files || [])]
          .filter(file => file?.type?.startsWith("image/"));
        const count = Math.max(items.length, files.length);
        if (!count) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        window.zion?.editor?.images?.showDropTarget?.(
          editor,
          { x: event.clientX, y: event.clientY },
          { count }
        );
      };
      const hide = () => window.zion?.editor?.images?.hideDropTarget?.(editor);
      const onDragLeave = (event) => {
        if (!event.relatedTarget || !view.dom.contains(event.relatedTarget)) hide();
      };
      const onDrop = (event) => {
        const files = [...(event.dataTransfer?.files || [])]
          .filter(file => file?.type?.startsWith("image/"));
        if (!files.length) return;
        event.preventDefault();
        event.stopPropagation();
        const target = window.zion?.editor?.images?.showDropTarget?.(
          editor,
          { x: event.clientX, y: event.clientY },
          { count: files.length }
        );
        hide();
        void insertSources(editor, files, {
          position: target?.position,
          from: target?.position,
          to: target?.position,
          userEvent: "input.drop"
        });
      };

      view.dom.addEventListener("dragover", onDragOver);
      view.dom.addEventListener("dragleave", onDragLeave);
      view.dom.addEventListener("drop", onDrop);
      return {
        dispose() {
          view.dom.removeEventListener("dragover", onDragOver);
          view.dom.removeEventListener("dragleave", onDragLeave);
          view.dom.removeEventListener("drop", onDrop);
          hide();
        }
      };
    }
  });
  if (disposable) ctx.subscriptions.push(disposable);
}

function registerFilePicker(ctx) {
  const command = window.zion?.commands?.registerCommand?.("image.insertFromFile", () => {
    const editor = window.zion?.window?.activeEditor;
    if (!editor) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.addEventListener("change", () => {
      const files = [...(input.files || [])].filter(file => file.type.startsWith("image/"));
      if (files.length) void insertSources(editor, files, { userEvent: "input.file-picker" });
      input.remove();
    }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
  if (command) ctx.subscriptions.push(command);
}

export async function activate(ctx) {
  ctx.subscriptions = ctx.subscriptions || [];
  const handler = {
    id: "dev.paste-image.handler",
    priority: 100,
    claim({ clipboardData }) {
      const sources = probeClipboard(clipboardData);
      return sources.length ? { sources } : false;
    },
    async handle({ editor, claim }) {
      const sources = Array.isArray(claim?.sources) ? claim.sources : [];
      return await insertSources(editor, sources, { userEvent: "input.paste" });
    }
  };
  const pasteDisposable = window.zion?.editor?.registerPasteHandler?.(handler);
  if (pasteDisposable) ctx.subscriptions.push(pasteDisposable);
  registerExternalDrop(ctx);
  registerFilePicker(ctx);
}

export function deactivate(ctx) {
  for (const disposable of ctx?.subscriptions || []) {
    try { disposable?.dispose?.(); } catch {}
  }
}
