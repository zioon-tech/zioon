import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import * as Y from "yjs";
import { createSessionDocumentProjector } from "../extensions/dev.session-manager/session-document-projector.js";
import { pendingAssistantField, setPendingAssistant } from "../extensions/dev.session-manager/editor/pending-assistant-plugin.js";

const projector = createSessionDocumentProjector();
const events = (output = "new answer") => [
  { runId: "r", sequence: 1, type: "message.delta", data: { delta: output.slice(0, 3) } },
  { runId: "r", sequence: 2, type: "message.delta", data: { delta: output.slice(3) } },
  { runId: "r", sequence: 3, type: "run.completed", data: { output } }
];
function prepare(source: string, offset = source.length) {
  const document = new Y.Doc();
  const text = document.getText("content");
  text.insert(0, source);
  const anchor = {
    encoded: Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, offset, -1))).toString("base64")
  };
  projector.prepareRun({ document, runId: "r", mode: "final", documentAnchor: anchor });
  return { document, text, anchor };
}
const finish = document => projector.projectEvents({ document, runId: "r", events: events() });

describe("final document projection", () => {
  it("publishes one prepared final tool body per batch while preserving arguments and anchors", () => {
    const document = new Y.Doc();
    const text = document.getText("content");
    text.insert(0, "user question");
    const anchor = Y.createRelativePositionFromTypeIndex(text, 4);
    const argumentsValue = { text: "参数".repeat(2_000), count: 0, nullable: null };
    const result = { output: "结果".repeat(2_000), ok: false, values: [] };
    const batch = [
      { runId: "r", sequence: 1, type: "tool.requested", data: { callId: "c", name: "read", arguments: argumentsValue } },
      { runId: "r", sequence: 2, type: "tool.completed", data: { callId: "c", result, artifactIds: ["artifact"] } }
    ];
    const plan = projector.planCards({ document, runId: "r", events: batch });
    const full = plan.cards.get("tool:r:c");
    expect(full).toMatchObject({ args: argumentsValue, result, ok: true, artifactIds: ["artifact"], sequence: 2 });
    const { args, result: ignored, ...header } = full;
    const compact = { ...header, bodyRef: "a".repeat(64), bodySessionId: "s", bodyKind: "tools", bodyBytes: 24000 };
    let prepared = 0;
    projector.projectEvents({ document, runId: "r", events: batch, prepareCard(card) {
      prepared++;
      expect(card).toEqual(full);
      return compact;
    } });
    expect(prepared).toBe(1);
    expect(document.getMap("cards").get("tool:r:c")).toEqual(compact);
    expect(text.toString().match(/zion-tool:id=tool:r:c/g)).toHaveLength(1);
    expect(Y.createAbsolutePositionFromRelativePosition(anchor, document)?.index).toBe(4);
    const restored = new Y.Doc();
    try {
      Y.applyUpdate(restored, Y.encodeStateAsUpdate(document));
      expect(restored.getMap("cards").get("tool:r:c")).toEqual(compact);
      expect(JSON.stringify(restored.getMap("cards").toJSON())).not.toContain(argumentsValue.text);
    } finally { document.destroy(); restored.destroy(); }
  });

  it("continues a completed referenced reasoning segment from its hydrated predecessor", () => {
    const document = new Y.Doc();
    const original = { id: "thinking:r:seg", kind: "thinking", runId: "r", segmentKey: "seg",
      text: "完整思考".repeat(1000), status: "completed", sequence: 2 };
    document.getMap("cards").set(original.id, { ...original, text: undefined, bodyRef: "a".repeat(64) });
    document.getMap("runProjection").set("r", { lastSequence: 2, reasoningIds: { seg: original.id }, reasoningCount: 1 });
    const batch = [
      { runId: "r", sequence: 3, type: "reasoning.delta", data: { reasoningSegmentId: "seg", delta: "，继续。" } },
      { runId: "r", sequence: 4, type: "reasoning.completed", data: { reasoningSegmentId: "seg" } }
    ];
    const readCard = id => id === original.id ? original : undefined;
    const plan = projector.planCards({ document, runId: "r", events: batch, readCard });
    expect(plan.cards.get(original.id).text).toBe(original.text + "，继续。");
    projector.projectEvents({ document, runId: "r", events: batch, readCard });
    expect(document.getMap("cards").get(original.id).text).toBe(original.text + "，继续。");
    expect(document.getMap("cards").get(original.id)).not.toHaveProperty("bodyRef");
    expect(projector.planCards({ document, runId: "r", events: batch }).cards.size).toBe(0);
    document.destroy();
  });

  it("does not prepare card bodies for a detached projection", () => {
    const document = new Y.Doc();
    document.getMap("runProjection").set("r", { detached: true, lastSequence: 0 });
    const batch = [{ runId: "r", sequence: 1, type: "tool.completed", data: { callId: "c", result: "body" } }];
    expect(projector.planCards({ document, runId: "r", events: batch }).cards.size).toBe(0);
    expect(projector.projectEvents({ document, runId: "r", events: batch })).toBe(false);
    expect(document.getMap("cards").size).toBe(0);
    document.destroy();
  });

  it.each(["live", "final"])("appends a single durable input only at tail completion (%s)", mode => {
    const { document, text, anchor } = prepare("user question");
    document.getMap("runProjection").delete("r");
    text.delete(13, text.length - 13);
    projector.prepareRun({ document, runId: "r", mode, documentAnchor: anchor, appendUserPrompt: true });
    projector.projectEvents({ document, runId: "r", events: events().slice(0, 2) });
    expect(text.toString()).not.toMatch(/\nuser $/);
    // A completed model turn can still be followed by another tool/model turn.
    projector.projectEvents({ document, runId: "r", events: [
      { runId: "r", sequence: 3, type: "message.completed", data: { content: "new answer" } }
    ] });
    expect(text.toString()).not.toMatch(/\nuser $/);
    const completed = [...events().slice(0, 2), { runId: "r", sequence: 4, type: "run.completed", data: { output: "new answer" } }];
    projector.projectEvents({ document, runId: "r", events: completed });
    expect(text.toString()).toBe("user question\nassistant <!-- zion-assistant:id=r --> new answer\nuser ");
    projector.projectEvents({ document, runId: "r", events: completed });
    expect(text.toString().match(/\nuser /g)).toHaveLength(1);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(document));
    expect(restored.getText("content").toString()).toBe(text.toString());
    document.destroy(); restored.destroy();
  });

  it.each(["run.waiting", "run.aborted", "run.failed"])("does not create the next input on %s", type => {
    const { document, text } = prepare("user question");
    const projections = document.getMap("runProjection");
    projections.set("r", { ...projections.get("r"), appendUserPrompt: true });
    projector.projectEvents({ document, runId: "r", events: [
      events()[0], { runId: "r", sequence: 2, type, data: { output: "new" } }
    ] });
    expect(text.toString()).not.toMatch(/\nuser $/);
    document.destroy();
  });

  it.each(["edited", "deleted"])("preserves %s instead of creating another input", change => {
    const { document, text } = prepare("user question");
    const projections = document.getMap("runProjection");
    projections.set("r", { ...projections.get("r"), appendUserPrompt: true, mode: "live" });
    if (change === "edited") text.insert(text.length, "my answer");
    if (change === "deleted") text.delete(14, text.length - 14);
    const before = text.toString();
    finish(document);
    expect(text.toString()).not.toMatch(/\nuser $/);
    expect(text.toString()).toBe(before);
    document.destroy();
  });

  it.each([
    ["live", "\nuser later", "\nuser \nuser later"],
    ["final", "\nuser later", "\nuser \nuser later"],
    ["live", "\nassistant old reply", "\nuser \nassistant old reply"],
    ["live", "\nmore original text", "\nuser \nuser <!-- zion-continuation:id=r -->\nmore original text"],
    ["live", "\nuser \nassistant old reply", "\nuser \nassistant old reply"],
    ["live", "\nuser \nmultiline draft", "\nuser \nuser \nmultiline draft"]
  ])("inserts or reuses an empty input before the untouched suffix (%s, %s)", (mode, suffix, expected) => {
    const { document, text } = prepare("user question" + suffix, 13);
    const projections = document.getMap("runProjection");
    projections.set("r", { ...projections.get("r"), mode, appendUserPrompt: true });
    projector.projectEvents({ document, runId: "r", events: events().slice(0, 2) });
    const before = text.toString();
    if (!suffix.startsWith("\nuser \n")) expect(before).not.toContain("\nuser \n");
    finish(document);
    const completed = text.toString();
    expect(completed).toBe("user question\nassistant <!-- zion-assistant:id=r --> new answer" + expected);
    finish(document);
    expect(text.toString()).toBe(completed);
    document.destroy();
  });

  it.each(["live", "final"].flatMap(mode =>
    ([
      ["\nuser later", 14],
      ["\n\nuser later", 13],
      ["\n\n\nuser later", 13],
      ["\n\nuser later", 14]
    ] as const).map(([suffix, offset]) => [mode, suffix, offset] as const)
  ))("keeps role and blank-line suffixes outside the owned answer (%s, %s, %s)", (mode, suffix, offset) => {
      const source = "user question" + suffix;
      const document = new Y.Doc();
      const text = document.getText("content");
      text.insert(0, source);
      const anchor = {
        encoded: Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, offset, -1))).toString("base64"),
        guard: Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, offset - 1, 0))).toString("base64")
      };
      projector.prepareRun({ document, runId: "r", mode, documentAnchor: anchor, appendUserPrompt: true });
      projector.projectEvents({ document, runId: "r", events: events().slice(0, 2) });
      expect(document.getMap("runProjection").get("r")?.detached).not.toBe(true);
      finish(document);
      expect(document.getMap("runProjection").get("r")).toMatchObject({ committed: true, status: "completed" });
      const untouched = source.slice(offset);
      const boundary = untouched.startsWith("\n\n") ? "\nuser <!-- zion-continuation:id=r -->" : untouched.startsWith("\n") ? "" : "\n";
      expect(text.toString()).toBe(
        source.slice(0, offset) + (source[offset - 1] === "\n" ? "" : "\n")
        + "assistant <!-- zion-assistant:id=r --> new answer\nuser "
        + boundary + untouched
      );
      const completed = text.toString();
      finish(document);
      expect(text.toString()).toBe(completed);
      document.destroy();
  });

  it("inserts the input outside unfinished output fences while keeping the middle suffix intact", () => {
    const { document, text } = prepare("user question\nuser later", 13);
    const projections = document.getMap("runProjection");
    projections.set("r", { ...projections.get("r"), mode: "live", appendUserPrompt: true });
    projector.projectEvents({ document, runId: "r", events: events("```txt\nexample") });
    expect(text.toString()).toContain("```txt\nexample\n```\nuser \nuser later");
    document.destroy();
  });

  it("inserts after an assistant fragment without duplicating the previous user message", () => {
    const source = "user question\nassistant existing fragment\nmore text\nuser later";
    const { document, text } = prepare(source, source.indexOf("\nmore text"));
    expect(text.toString().match(/user question/g)).toHaveLength(1);
    finish(document);
    expect(text.toString()).toContain("existing fragment\nassistant <!-- zion-assistant:id=r --> new answer\nuser <!-- zion-continuation:id=r -->\nmore text\nuser later");
    document.destroy();
  });

  it.each(["改写", "删除", "复制"])("preserves %s of the owned placeholder and retains detached status", action => {
    const { document, text } = prepare("user question");
    const start = text.toString().indexOf("assistant ");
    if (action === "改写") text.insert(text.length, "my own answer");
    if (action === "删除") text.delete(start, text.length - start);
    if (action === "复制") text.insert(text.length, "\n" + text.toString().slice(start));
    const edited = text.toString();
    finish(document);
    expect(text.toString()).toBe(edited);
    expect(document.getMap("runProjection").get("r")).toMatchObject({ detached: true });
    document.destroy();
  });

  it("keeps later typing and replays terminal events without duplicates", () => {
    const { document, text } = prepare("user question\nuser later", 13);
    text.insert(text.length, " typed while running");
    projector.projectEvents({ document, runId: "r", events: events().slice(0, 1) });
    expect(text.toString()).not.toContain("new answer");
    finish(document);
    const committed = text.toString();
    finish(document);
    expect(text.toString()).toBe(committed);
    expect(committed).toContain("user later typed while running");
    text.insert(text.toString().indexOf("new answer"), "edited ");
    finish(document);
    expect(text.toString()).toContain("edited new answer");
    document.destroy();
  });

  it("preserves a suffix when the model streams code fences and role-shaped examples", () => {
    const { document, text } = prepare("user question\nuser later", 13);
    const output = "```txt\nuser example\nassistant example\n```";
    projector.projectEvents({ document, runId: "r", events: events(output) });
    expect(text.toString()).toContain(output + "\nuser later");
    expect(text.toString().match(/user later/g)).toHaveLength(1);
    document.destroy();
  });

  it("accepts a trigger inside a code fence and leaves the selected suffix in that fence", () => {
    const source = "user inspect\n```js\nconst a = 1;\nconst b = 2;\n```\nuser later";
    const { document, text } = prepare(source, source.indexOf("\nconst b"));
    finish(document);
    expect(text.toString()).toContain("const a = 1;\n```\nassistant <!-- zion-assistant:id=r --> new answer");
    expect(text.toString()).toContain("```\n\nconst b = 2;\n```\nuser later");
    document.destroy();
  });

  it("waits for an unsynced relative anchor and projects when its Yjs update arrives", () => {
    const local = new Y.Doc();
    local.getText("content").insert(0, "user local");
    const document = new Y.Doc();
    const anchor = { encoded: Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(local.getText("content"), 10, -1))).toString("base64") };
    projector.prepareRun({ document, runId: "r", mode: "final", documentAnchor: anchor });
    expect(document.getText("content").toString()).toBe("");
    Y.applyUpdate(document, Y.encodeStateAsUpdate(local));
    finish(document);
    expect(document.getText("content").toString()).toContain("user local\nassistant <!-- zion-assistant:id=r --> new answer");
    local.destroy(); document.destroy();
  });

  it("merges remote edits before committing and never revives a remotely deleted answer", () => {
    const { document, text } = prepare("user question");
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(document));
    const remoteText = remote.getText("content");
    remoteText.delete(14, remoteText.length - 14);
    Y.applyUpdate(document, Y.encodeStateAsUpdate(remote));
    finish(document);
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(document));
    expect(text.toString()).toBe("user question\n");
    expect(remoteText.toString()).toBe(text.toString());
    remote.destroy(); document.destroy();
  });

  it("maps pending feedback through typing and keeps the mapped offset on later tokens", () => {
    let state = EditorState.create({ doc: "user question\nuser later", extensions: [pendingAssistantField] });
    state = state.update({ effects: setPendingAssistant.of({ runId: "r", fallbackOffset: 13, text: "one" }) }).state;
    state = state.update({ changes: { from: 0, insert: "prefix\n" } }).state;
    state = state.update({ effects: setPendingAssistant.of({ runId: "r", fallbackOffset: 13, text: "one two" }) }).state;
    expect(state.field(pendingAssistantField).entries.get("r").fallbackOffset).toBe(20);
  });

  it("does not redirect output to a surviving neighbor when the captured character was deleted", () => {
    const document = new Y.Doc();
    const text = document.getText("content");
    text.insert(0, "user question\nuser later");
    const anchor = {
      encoded: Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, 13, -1))).toString("base64"),
      guard: Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, 12, 0))).toString("base64")
    };
    text.delete(0, 13);
    projector.prepareRun({ document, runId: "r", mode: "final", documentAnchor: anchor });
    const before = text.toString();
    finish(document);
    expect(text.toString()).toBe(before);
    expect(document.getMap("runProjection").get("r")).toMatchObject({ detached: true });
    document.destroy();
  });

  it("keeps tool and reasoning cards with the committed answer and does not replay them", () => {
    const { document, text } = prepare("user question");
    const recorded = [
      { type: "reasoning.delta", data: { delta: "think" } },
      { type: "reasoning.completed", data: {} },
      { type: "tool.requested", data: { callId: "call", name: "read", arguments: {} } },
      { type: "tool.completed", data: { callId: "call", name: "read", result: "file" } },
      { type: "message.completed", data: { content: "answer" } },
      { type: "run.completed", data: { output: "answer" } }
    ].map((event, index) => ({ ...event, runId: "r", sequence: index + 1 }));
    projector.projectEvents({ document, runId: "r", events: recorded });
    expect(text.toString()).toContain("answer");
    expect(document.getMap("cards").size).toBe(2);
    expect([...document.getMap("cards").values()].find(card => card.kind === "thinking").text).toBe("think");
    const committed = text.toString();
    projector.projectEvents({ document, runId: "r", events: recorded });
    expect(text.toString()).toBe(committed);
    document.destroy();
  });

  it("commits partial output on abort", () => {
    const { document, text } = prepare("user question");
    projector.projectEvents({ document, runId: "r", events: [
      events("partial")[0],
      { runId: "r", sequence: 2, type: "run.aborted", data: { reason: "user" } }
    ] });
    expect(text.toString()).toContain("par");
    expect(document.getMap("runProjection").get("r")).toMatchObject({ committed: true, status: "aborted" });
    document.destroy();
  });

  it("resumes a waiting Run without duplicating its previous output", () => {
    const { document, text } = prepare("user question");
    projector.projectEvents({ document, runId: "r", events: [
      { runId: "r", sequence: 1, type: "message.delta", data: { delta: "before", turn: 1 } },
      { runId: "r", sequence: 2, type: "run.waiting", data: {} }
    ] });
    projector.projectEvents({ document, runId: "r", events: [
      { runId: "r", sequence: 1, type: "message.delta", data: { delta: "before", turn: 1 } },
      { runId: "r", sequence: 3, type: "message.delta", data: { delta: " after", turn: 2 } },
      { runId: "r", sequence: 4, type: "run.completed", data: { output: "before after" } }
    ] });
    expect(text.toString()).toBe("user question\nassistant <!-- zion-assistant:id=r --> before after");
    document.destroy();
  });
});
