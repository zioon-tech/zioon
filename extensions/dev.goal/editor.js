import { Compartment, Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import { appendUserMessageText } from "../../src/chat/session-document-format.js";

export function goalCommandHighlight(editor) {
  const view = editor.getView?.();
  if (!view) return { dispose() {} };
  const compartment = new Compartment();
  const build = (state) => {
    const ranges = [];
    let role = "user", fence = null;
    for (let number = 1; number <= state.doc.lines; number++) {
      const line = state.doc.line(number), source = line.text;
      const message = source.match(/^\s*(user|assistant|system|tool)\s+/);
      if (message) role = message[1];
      const content = message ? source.slice(message[0].length) : source;
      const delimiter = content.match(/^\s*(`{3,}|~{3,})/);
      if (delimiter) {
        if (!fence) fence = delimiter[1];
        else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length) fence = null;
        continue;
      }
      if (fence) continue;
      if (role !== "user") continue;
      const match = content.match(/^\s*(\/goal(?:-(?:status|pause|resume|cancel))?)(?=\s|$)/);
      if (match) {
        const from = line.from + (message?.[0].length || 0) + match[0].lastIndexOf(match[1]);
        ranges.push(Decoration.mark({ class: "zion-goal-command", attributes: { title: "持续目标命令" } }).range(from, from + match[1].length));
      }
    }
    return Decoration.set(ranges);
  };
  editor.addVisualExtension(compartment.of([
    ViewPlugin.fromClass(class {
      constructor(view) { this.decorations = build(view.state); }
      update(update) { if (update.docChanged) this.decorations = build(update.state); }
    }, { decorations: (plugin) => plugin.decorations }),
    EditorView.baseTheme({ ".zion-goal-command": { color: "var(--accent)", fontWeight: "600" } })
  ]));
  return { dispose() { try { view.dispatch({ effects: compartment.reconfigure([]) }); } catch {} } };
}

export function completeGoalTrigger(editor) {
  const view = editor?.getView?.();
  if (!view) throw new Error("请先打开会话编辑器");
  if (!view.state.facet(EditorView.editable)) throw new Error("会话仍在同步，请稍后重试");
  const position = view.state.selection.main.head, line = view.state.doc.lineAt(position);
  const prefix = view.state.doc.sliceString(line.from, position);
  const match = prefix.match(/(?:^|\s)[/／、。](?:g(?:o(?:a(?:l)?)?)?)?$/i);
  if (!match) return stageGoal(editor);
  const from = line.from + match.index + (/\s/.test(match[0][0]) ? 1 : 0);
  view.dispatch({ changes: { from, to: position, insert: "/goal " }, selection: { anchor: from + 6 },
    annotations: Transaction.userEvent.of("input.goal"), scrollIntoView: true });
  view.focus();
}

export function stageGoal(editor, objective = "") {
  const view = editor?.getView?.();
  if (!view) throw new Error("请先打开会话编辑器");
  if (!view.state.facet(EditorView.editable)) throw new Error("会话仍在同步，请稍后重试");
  const from = view.state.doc.length;
  const insert = appendUserMessageText(view.state.doc.toString(), `/goal ${objective}`);
  view.dispatch({
    changes: { from, insert },
    selection: { anchor: from + insert.length },
    annotations: Transaction.userEvent.of("input.goal"),
    scrollIntoView: true
  });
  view.focus();
}
