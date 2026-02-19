import { installThinkingCards } from "./thinking-cards.js";

export async function activate(ctx) {
  // 初始化可见性状态（默认显示）
  if (typeof window.zion.state.get("chat.thinkingVisible") !== "boolean") {
    window.zion.state.set("chat.thinkingVisible", true);
  }

  // 注册装饰器：注入 ViewPlugin
  const dispDec = window.zion.editor.registerDecorator({
    id: "dev.thinking.decorator",
    apply(editor) {
      editor.addVisualExtension(installThinkingCards());
      return { dispose() {} };
    }
  });
  ctx.subscriptions.push(dispDec);

  // 命令：切换可见性
  const dispToggle = window.zion.commands.registerCommand("thinking.toggleVisibility", () => {
    const cur = !!window.zion.state.get("chat.thinkingVisible");
    window.zion.state.set("chat.thinkingVisible", !cur);
  });
  ctx.subscriptions.push(dispToggle);

  try {
    const reg = window.zion?.__editorHeaderMenuRegistry;
    const disp = reg?.register?.({
      id: "dev.thinking.headerMenu",
      title: "Thinking",
      section: "Chat",
      order: 30,
      kind: "toggle",
      getChecked: () => !!window.zion.state.get("chat.thinkingVisible"),
      onClick: () => window.zion.commands.executeCommand("thinking.toggleVisibility")
    });
    if (disp) ctx.subscriptions.push(disp);
  } catch {}
}
