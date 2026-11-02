export type KeyedElementEntry = {
  element: HTMLElement;
};

export type ReconcileKeyedElementsOptions<T, E extends KeyedElementEntry> = {
  container: HTMLElement;
  items: readonly T[];
  entries: Map<string, E>;
  getKey(item: T): string;
  create(item: T, key: string): E;
  update(entry: E, item: T, key: string): void;
};

export type ReconcileKeyedElementsResult = {
  created: number;
  removed: number;
  moved: number;
};

export function reconcileKeyedElements<T, E extends KeyedElementEntry>(
  options: ReconcileKeyedElementsOptions<T, E>
): ReconcileKeyedElementsResult {
  const { container, entries, getKey, create, update } = options;
  const nextItems: Array<{ item: T; key: string }> = [];
  const nextKeys = new Set<string>();

  for (const item of options.items) {
    const key = String(getKey(item) || "");
    if (!key || nextKeys.has(key)) continue;
    nextKeys.add(key);
    nextItems.push({ item, key });
  }

  let removed = 0;
  for (const [key, entry] of Array.from(entries.entries())) {
    if (nextKeys.has(key)) continue;
    try { entry.element.remove(); } catch {}
    entries.delete(key);
    removed += 1;
  }

  let created = 0;
  for (const { item, key } of nextItems) {
    let entry = entries.get(key);
    if (!entry) {
      entry = create(item, key);
      entries.set(key, entry);
      created += 1;
    }
    update(entry, item, key);
  }

  let moved = 0;
  let cursor: Element | null = container.firstElementChild;
  for (const { key } of nextItems) {
    const entry = entries.get(key);
    if (!entry) continue;
    if (entry.element !== cursor) {
      container.insertBefore(entry.element, cursor);
      moved += 1;
    }
    cursor = entry.element.nextElementSibling;
  }

  return { created, removed, moved };
}
