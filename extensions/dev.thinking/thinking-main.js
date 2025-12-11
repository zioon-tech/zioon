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

  // 状态栏按钮：Thinking On/Off
  let btnDisp = null;
  const updateBtn = () => {
    const vis = !!window.zion.state.get("chat.thinkingVisible");
    btnDisp?.dispose?.();
    btnDisp = window.zion.statusBar.registerItem({
      id: "dev.thinking.btn",
      text: vis ? "Thinking: On" : "Thinking: Off",
      tooltip: "Toggle rendering of model reasoning (思考内容)",
      onClick: () => window.zion.commands.executeCommand("thinking.toggleVisibility")
    });
  };
  updateBtn();
  ctx.subscriptions.push(window.zion.state.onDidChange("chat.thinkingVisible", updateBtn));

  // 命令：切换可见性
  const dispToggle = window.zion.commands.registerCommand("thinking.toggleVisibility", () => {
    const cur = !!window.zion.state.get("chat.thinkingVisible");
    window.zion.state.set("chat.thinkingVisible", !cur);
  });
  ctx.subscriptions.push(dispToggle);
}