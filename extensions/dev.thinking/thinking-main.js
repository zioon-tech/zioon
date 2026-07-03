import "./styles.css";
import { installThinkingCards } from "./thinking-cards.js";

const I18N_NS = "dev.thinking";
const I18N_MESSAGES = {
  "zh-CN": {
    "category.chat": "聊天",
    "cmd.toggleVisibility": "切换思考过程显示",
    "ui.thinking": "思考",
    "ui.headerMenu": "思考过程",
    "ui.remove": "移除思考记录",
    "ui.inlineTitle": "思考（点击展开/收起）",
    "ui.inlineAria": "思考（点击展开或收起卡片）",
    "ui.toggleContent": "展开/收起思考内容"
  },
  "en-US": {
    "category.chat": "Chat",
    "cmd.toggleVisibility": "Toggle Thinking Visibility",
    "ui.thinking": "Thinking",
    "ui.headerMenu": "Thinking",
    "ui.remove": "Remove thinking record",
    "ui.inlineTitle": "Thinking (click to expand/collapse)",
    "ui.inlineAria": "Thinking (click to expand or collapse card)",
    "ui.toggleContent": "Expand/collapse thinking content"
  }
};

function t(key, fallback, values) {
  const fullKey = `${I18N_NS}.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

export async function activate(ctx) {
  try {
    const disp = window.zion?.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) ctx.subscriptions.push(disp);
  } catch {}
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
      title: t("ui.headerMenu", "Thinking"),
      section: t("category.chat", "Chat"),
      order: 30,
      kind: "toggle",
      getChecked: () => !!window.zion.state.get("chat.thinkingVisible"),
      onClick: () => window.zion.commands.executeCommand("thinking.toggleVisibility")
    });
    if (disp) ctx.subscriptions.push(disp);
  } catch {}
}
