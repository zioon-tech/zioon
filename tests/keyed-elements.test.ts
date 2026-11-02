import { beforeEach, describe, expect, it } from "vitest";
import {
  reconcileKeyedElements,
  type KeyedElementEntry
} from "../src/ui/keyed-elements";

type Item = { id: string; title: string };
type Entry = KeyedElementEntry & { label: HTMLSpanElement };

describe("reconcileKeyedElements", () => {
  let container: HTMLDivElement;
  let entries: Map<string, Entry>;

  beforeEach(() => {
    container = document.createElement("div");
    entries = new Map();
    document.body.replaceChildren(container);
  });

  const reconcile = (items: Item[]) => reconcileKeyedElements({
    container,
    items,
    entries,
    getKey: (item) => item.id,
    create: (_item, key) => {
      const element = document.createElement("div");
      element.dataset.id = key;
      const label = document.createElement("span");
      element.appendChild(label);
      return { element, label };
    },
    update: (entry, item) => {
      entry.label.textContent = item.title;
    }
  });

  it("reuses nodes while updating their content", () => {
    expect(reconcile([
      { id: "a", title: "A" },
      { id: "b", title: "B" }
    ])).toEqual({ created: 2, removed: 0, moved: 2 });
    const firstA = entries.get("a")?.element;
    const firstB = entries.get("b")?.element;

    expect(reconcile([
      { id: "a", title: "A2" },
      { id: "b", title: "B2" }
    ])).toEqual({ created: 0, removed: 0, moved: 0 });
    expect(entries.get("a")?.element).toBe(firstA);
    expect(entries.get("b")?.element).toBe(firstB);
    expect(entries.get("a")?.label.textContent).toBe("A2");
  });

  it("moves only existing keyed nodes and removes stale nodes", () => {
    reconcile([
      { id: "a", title: "A" },
      { id: "b", title: "B" }
    ]);
    const firstA = entries.get("a")?.element;
    const firstB = entries.get("b")?.element;

    const reordered = reconcile([
      { id: "b", title: "B" },
      { id: "a", title: "A" },
      { id: "c", title: "C" }
    ]);
    expect(reordered.created).toBe(1);
    expect(reordered.removed).toBe(0);
    expect(Array.from(container.children).map((node) => (node as HTMLElement).dataset.id)).toEqual([
      "b",
      "a",
      "c"
    ]);
    expect(entries.get("a")?.element).toBe(firstA);
    expect(entries.get("b")?.element).toBe(firstB);

    expect(reconcile([
      { id: "a", title: "A" },
      { id: "c", title: "C" }
    ]).removed).toBe(1);
    expect(firstB?.isConnected).toBe(false);
    expect(entries.has("b")).toBe(false);
  });

  it("ignores duplicate or empty keys", () => {
    reconcile([
      { id: "a", title: "first" },
      { id: "a", title: "duplicate" },
      { id: "", title: "empty" }
    ]);

    expect(entries.size).toBe(1);
    expect(container.children).toHaveLength(1);
    expect(entries.get("a")?.label.textContent).toBe("first");
  });
});
