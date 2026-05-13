import { describe, expect, it } from "vitest";
import {
  buildRegexAnchors,
  filterDeletedItems,
  findAssistantBlockEndOffset,
  planAssistantMarkerInsertion,
  reconcileExactAnchors,
  reconcileMountedItems,
  reconcileNearestAnchors
} from "../src/chat/restore";

describe("chat restore helpers", () => {
  it("builds regex anchors and filters deleted items", () => {
    const anchors = buildRegexAnchors("调用 read\n思考\n调用 write\n", /调用\s+([^\n]+)/g, (match) => ({
      from: match.index,
      to: match.index + match[0].length,
      name: match[1]
    }));
    expect(anchors.map((it) => it.name)).toEqual(["read", "write"]);

    const items = filterDeletedItems(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      ["b"]
    );
    expect(items.map((it) => it.id)).toEqual(["a", "c"]);
  });

  it("reconciles mounted, exact and nearest anchors", () => {
    const items = [
      { id: "mounted", name: "read", from: 0, to: 7, expanded: true, result: "ok", ok: true },
      { id: "exact", name: "write", from: 10, to: 20, expanded: false },
      { id: "nearest", name: "write", from: 100, to: 110, expanded: false }
    ];
    const existingItems = new Map([["mounted", { expanded: false, result: null, ok: false }]]);
    const mountedHits: string[] = [];
    const matched: Array<{ id: string; from: number; to: number }> = [];
    const anchors = [
      { from: 10, to: 20, name: "write", occupied: false },
      { from: 40, to: 50, name: "write", occupied: false }
    ];

    const processedIds = reconcileMountedItems({
      items,
      existingItems,
      onMounted: (item) => {
        mountedHits.push(String(item.id));
      }
    });
    expect([...processedIds]).toEqual(["mounted"]);
    expect(mountedHits).toEqual(["mounted"]);

    reconcileExactAnchors({
      items,
      processedIds,
      anchors,
      isExactMatch: (item, anchor) => item.from === anchor.from && item.to === anchor.to,
      onMatch: (item, anchor) => {
        matched.push({ id: String(item.id), from: anchor.from, to: anchor.to });
      }
    });

    reconcileNearestAnchors({
      items,
      processedIds,
      anchors,
      canUseAnchor: (item, anchor) => item.name === anchor.name,
      onMatch: (item, anchor) => {
        matched.push({ id: String(item.id), from: anchor.from, to: anchor.to });
      }
    });

    expect(matched).toEqual([
      { id: "exact", from: 10, to: 20 },
      { id: "nearest", from: 40, to: 50 }
    ]);
    expect(anchors.every((it) => it.occupied === true)).toBe(true);
  });

  it("finds assistant block end and plans fallback insertion", () => {
    const docText = [
      "user hi",
      "",
      "assistant first",
      "body",
      "user next",
      "assistant second",
      "tail"
    ].join("\n");

    const end = findAssistantBlockEndOffset(docText);
    expect(docText.slice(0, end).endsWith("tail")).toBe(true);

    const hintAtFirstAssistant = docText.indexOf("assistant first");
    const hintedEnd = findAssistantBlockEndOffset(docText, hintAtFirstAssistant);
    expect(docText.slice(0, hintedEnd).endsWith("body")).toBe(true);

    const plan = planAssistantMarkerInsertion({
      docText,
      markerText: "调用 read",
      hintPos: hintAtFirstAssistant,
      trailingNewlines: 1
    });

    expect(plan.insertText).toBe("\n调用 read\n");
    expect(plan.markerTo - plan.markerFrom).toBe("调用 read".length);
    expect(plan.insertPos).toBe(hintedEnd);
  });
});
