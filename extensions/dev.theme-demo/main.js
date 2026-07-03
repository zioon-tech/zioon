/**
 * dev.theme-demo — 自定义主题 Demo
 *
 * 演示 `window.zion.theme.registerVariant()` API 的用法。
 * 注册一个 "Neon Glow" 霓虹主题，可像内置主题一样切换。
 *
 * 使用方式：
 * 1. 此扩展加载后，在状态栏或命令面板中切换主题
 * 2. 执行命令：zion.theme.setSelection("neon-glow")
 * 3. 或在设置中从主题选择下拉菜单里选择 "Neon Glow"
 */

const THEME_ID = "neon-glow";
const THEME_TITLE = "Neon Glow";
const THEME_DESCRIPTION = "霓虹光感暗色主题 — 演示 registerVariant API";

export async function activate(ctx) {
  // ---------- 注册主题 ----------
  // 通过 registerVariant 注入 CSS 样式并注册到主题选择器
  //
  // registerVariant(id, opts) 的参数：
  //   id        — 主题标识符，同时也是 data-theme-variant 属性的值
  //   title     — 主题选择器中显示的名称
  //   baseTheme — 基础主题 ("dark" / "light" / "system")
  //   css       — CSS 变量覆盖（不需要 [data-theme][data-theme-variant] 包装器，
  //                 registerVariant 会自动生成正确的属性选择器）
  //
  // 为什么不传 CSS 而是用 theme.css？
  //   theme.css 通过 manifest.json 的 contributes.styles 加载，
  //   但 registerVariant 仍然需要调用，这样主题才会出现在选择器里。
  //   传空字符串给 css，因为样式已经在 theme.css 中定义了。
  const disposable = window.zion.theme.registerVariant(THEME_ID, {
    title: THEME_TITLE,
    baseTheme: "dark",
    css: ""  // 样式在 theme.css 中，通过 contributes.styles 加载
  });
  ctx.subscriptions.push(disposable);

  // ---------- （可选）注册切换命令 ----------
  // 让用户可以通过命令面板快速切换到这个主题
  const cmdDisposable = window.zion.commands.registerCommand(
    "themeDemo.applyNeonGlow",
    () => {
      window.zion.theme.setSelection(THEME_ID);
      window.zion.notification.show(`已切换到主题：${THEME_TITLE}`, {
        type: "success"
      });
    }
  );
  ctx.subscriptions.push(cmdDisposable);

  // ---------- （可选）注册菜单项 ----------
  try {
    const menuDisposable = window.zion.menus.register("editor/context", {
      command: "themeDemo.applyNeonGlow",
      title: `切换主题：${THEME_TITLE}`,
      when: "editorFocus",
      order: 99
    });
    if (menuDisposable) ctx.subscriptions.push(menuDisposable);
  } catch {}

  console.log(`[theme-demo] 已注册主题 "${THEME_TITLE}" — 请在主题选择器中切换`);
}

export function deactivate() {
  // 不需要额外操作 — registerVariant 返回的 Disposable
  // 会在插件停用时自动清理（移除 CSS + 注销主题选项）
  console.log("[theme-demo] 已注销");
}
