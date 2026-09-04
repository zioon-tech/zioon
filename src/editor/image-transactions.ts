import {
  StateEffect,
  StateField,
  Transaction,
  type Extension
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType
} from "@codemirror/view";
import {
  formatImageInsertion,
  getImageInsertTarget,
  type ImageDisplayKind
} from "./image-model";

export type ImageInsertItem = {
  src: string;
  alt?: string;
};

export type BeginImageInsertionOptions = {
  count: number;
  from?: number;
  to?: number;
  position?: number;
  kind?: ImageDisplayKind;
  userEvent?: string;
  retry?: () => void | Promise<void>;
  cancel?: () => void;
};

type PendingImageInsertion = {
  id: string;
  from: number;
  to: number;
  position: number;
  count: number;
  kind: ImageDisplayKind;
  status: "loading" | "error";
  message?: string;
  userEvent: string;
  retry?: () => void | Promise<void>;
  cancel?: () => void;
};

type ImageInsertionState = {
  operations: PendingImageInsertion[];
  decorations: ReturnType<typeof Decoration.set>;
};

const addImageInsertion = StateEffect.define<PendingImageInsertion>({
  map: (value, changes) => ({
    ...value,
    from: changes.mapPos(value.from, -1),
    to: changes.mapPos(value.to, 1),
    position: changes.mapPos(value.position, -1)
  })
});
const updateImageInsertion = StateEffect.define<{
  id: string;
  status: PendingImageInsertion["status"];
  message?: string;
}>();
const removeImageInsertion = StateEffect.define<string>();
const clearImageInsertions = StateEffect.define<void>();

let nextOperationId = 0;
const indicatorByView = new WeakMap<EditorView, HTMLElement>();

function createOperationId(): string {
  nextOperationId += 1;
  return `image-${Date.now().toString(36)}-${nextOperationId.toString(36)}`;
}

function escapeAltText(value: string): string {
  return String(value || "").replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function toMarkdown(items: ImageInsertItem[]): string {
  return items
    .filter(item => item?.src)
    .map(item => `![${escapeAltText(item.alt || "")}](${item.src})`)
    .join("\n");
}

function getOperation(state: EditorView["state"], id: string): PendingImageInsertion | null {
  try {
    return state.field(imageInsertionField).operations.find(operation => operation.id === id) || null;
  } catch {
    return null;
  }
}

class PendingImageInsertionWidget extends WidgetType {
  constructor(private operation: PendingImageInsertion) {
    super();
  }

  eq(other: PendingImageInsertionWidget): boolean {
    return other.operation.id === this.operation.id
      && other.operation.status === this.operation.status
      && other.operation.message === this.operation.message
      && other.operation.count === this.operation.count
      && other.operation.kind === this.operation.kind;
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("span");
    root.className = `cm-image-pending${this.operation.kind === "inline" ? "" : " is-block"}`;
    if (this.operation.status === "error") root.classList.add("is-error");

    if (this.operation.status === "loading") {
      const spinner = document.createElement("span");
      spinner.className = "cm-image-pending-spinner";
      spinner.setAttribute("aria-hidden", "true");
      root.appendChild(spinner);
    }

    const label = document.createElement("span");
    label.className = "cm-image-pending-label";
    label.textContent = this.operation.status === "error"
      ? (this.operation.message || "图片导入失败")
      : `正在导入 ${this.operation.count} 张图片`;
    root.appendChild(label);

    if (this.operation.status === "error") {
      const actions = document.createElement("span");
      actions.className = "cm-image-pending-actions";
      if (this.operation.retry) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "重试";
        retry.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          markImageInsertionLoading(view, this.operation.id);
          void this.operation.retry?.();
        });
        actions.appendChild(retry);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "移除";
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        cancelImageInsertion(view, this.operation.id);
      });
      actions.appendChild(remove);
      root.appendChild(actions);
    }
    return root;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function buildDecorations(operations: PendingImageInsertion[]) {
  const ranges = operations.map(operation =>
    Decoration.widget({
      widget: new PendingImageInsertionWidget(operation),
      block: operation.kind !== "inline",
      side: 1
    }).range(operation.position)
  );
  return ranges.length ? Decoration.set(ranges, true) : Decoration.none;
}

const imageInsertionField = StateField.define<ImageInsertionState>({
  create() {
    return { operations: [], decorations: Decoration.none };
  },
  update(value, transaction) {
    let operations = value.operations.map(operation => ({
      ...operation,
      from: transaction.changes.mapPos(operation.from, -1),
      to: transaction.changes.mapPos(operation.to, 1),
      position: transaction.changes.mapPos(operation.position, -1)
    }));
    let changed = transaction.docChanged;
    for (const effect of transaction.effects) {
      if (effect.is(addImageInsertion)) {
        operations.push(effect.value);
        changed = true;
      } else if (effect.is(updateImageInsertion)) {
        operations = operations.map(operation =>
          operation.id === effect.value.id
            ? { ...operation, status: effect.value.status, message: effect.value.message }
            : operation
        );
        changed = true;
      } else if (effect.is(removeImageInsertion)) {
        operations = operations.filter(operation => operation.id !== effect.value);
        changed = true;
      } else if (effect.is(clearImageInsertions)) {
        operations = [];
        changed = true;
      }
    }
    return changed
      ? { operations, decorations: buildDecorations(operations) }
      : value;
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations)
});

const imageIndicatorLifecycle = ViewPlugin.fromClass(class {
  private indicator: HTMLElement;
  private view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
    this.indicator = document.createElement("div");
    this.indicator.className = "cm-image-drop-indicator";
    const label = document.createElement("span");
    label.className = "cm-image-drop-indicator-label";
    this.indicator.appendChild(label);
    document.body.appendChild(this.indicator);
    indicatorByView.set(view, this.indicator);
  }

  destroy() {
    indicatorByView.delete(this.view);
    this.indicator.remove();
  }
});

export function imageInsertionExtension(): Extension {
  return [imageInsertionField, imageIndicatorLifecycle];
}

export function beginImageInsertion(
  view: EditorView,
  options: BeginImageInsertionOptions
): string {
  const selection = view.state.selection.main;
  const requestedPosition = options.position ?? selection.from;
  const target = getImageInsertTarget(view.state.doc, requestedPosition, options.count);
  const hasExplicitRange = typeof options.from === "number" || typeof options.to === "number";
  const hasExplicitPosition = typeof options.position === "number";
  const from = hasExplicitRange
    ? (options.from ?? requestedPosition)
    : hasExplicitPosition
      ? target.position
      : selection.from;
  const to = hasExplicitRange
    ? (options.to ?? from)
    : hasExplicitPosition
      ? target.position
      : selection.to;
  const kind = options.kind || (options.count > 1 ? "gallery" : target.kind);
  const id = createOperationId();
  view.dispatch({
    effects: addImageInsertion.of({
      id,
      from,
      to,
      position: target.position,
      count: Math.max(1, options.count),
      kind,
      status: "loading",
      userEvent: options.userEvent || "input.image",
      retry: options.retry,
      cancel: options.cancel
    }),
    annotations: Transaction.addToHistory.of(false)
  });
  return id;
}

export function markImageInsertionLoading(view: EditorView, id: string): boolean {
  if (!getOperation(view.state, id)) return false;
  view.dispatch({
    effects: updateImageInsertion.of({ id, status: "loading" }),
    annotations: Transaction.addToHistory.of(false)
  });
  return true;
}

export function failImageInsertion(view: EditorView, id: string, message?: string): boolean {
  if (!getOperation(view.state, id)) return false;
  view.dispatch({
    effects: updateImageInsertion.of({ id, status: "error", message }),
    annotations: Transaction.addToHistory.of(false)
  });
  return true;
}

export function cancelImageInsertion(view: EditorView, id: string): boolean {
  const operation = getOperation(view.state, id);
  if (!operation) return false;
  try { operation.cancel?.(); } catch {}
  view.dispatch({
    effects: removeImageInsertion.of(id),
    annotations: Transaction.addToHistory.of(false)
  });
  return true;
}

export function completeImageInsertion(
  view: EditorView,
  id: string,
  items: ImageInsertItem[]
): boolean {
  const operation = getOperation(view.state, id);
  const markdown = toMarkdown(items);
  if (!operation || !markdown) return false;
  const insert = formatImageInsertion(
    view.state.doc,
    operation.from,
    operation.to,
    markdown,
    operation.kind
  );
  view.dispatch({
    changes: { from: operation.from, to: operation.to, insert },
    effects: removeImageInsertion.of(id),
    scrollIntoView: true,
    userEvent: operation.userEvent
  });
  return true;
}

export function clearImageInsertionState(view: EditorView): void {
  view.dispatch({
    effects: clearImageInsertions.of(),
    annotations: Transaction.addToHistory.of(false)
  });
}

export function getImageDropTarget(
  view: EditorView,
  point: { x: number; y: number },
  count = 1
) {
  const rawPosition = view.posAtCoords(point) ?? view.state.selection.main.head;
  return getImageInsertTarget(view.state.doc, rawPosition, count);
}

export function showImageDropIndicator(
  view: EditorView,
  point: { x: number; y: number },
  options: { count?: number; moving?: boolean } = {}
) {
  const target = getImageDropTarget(view, point, options.count || 1);
  const indicator = indicatorByView.get(view);
  const coords = view.coordsAtPos(target.position);
  if (!indicator || !coords) return target;
  const contentRect = view.contentDOM.getBoundingClientRect();
  const inline = target.kind === "inline";
  indicator.style.left = `${inline ? coords.left : contentRect.left}px`;
  indicator.style.top = `${inline ? coords.top : coords.bottom}px`;
  indicator.style.width = `${inline ? 2 : contentRect.width}px`;
  indicator.style.height = `${inline ? Math.max(18, coords.bottom - coords.top) : 2}px`;
  const label = indicator.querySelector(".cm-image-drop-indicator-label");
  if (label) {
    const action = options.moving ? "移动" : "插入";
    label.textContent = target.kind === "inline"
      ? `${action}为行内图片`
      : target.kind === "gallery"
        ? `${action}并加入图片组`
        : `${action}为独立图片`;
  }
  indicator.classList.add("is-visible");
  return target;
}

export function hideImageDropIndicator(view: EditorView): void {
  indicatorByView.get(view)?.classList.remove("is-visible");
}
