import { afterEach, describe, expect, it } from "vitest";
import { EditorCore } from "../src/editor/EditorCore";
import { attachEditor } from "../src/ext/registry";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Registry menu content sizing", () => {
  it("marks editor menus for compact content sizing and preserves full label tooltips", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const core = new EditorCore(host, "hello world");
    attachEditor(core);
    core.focus();

    const parentTitle = "运行聊天";
    const parentSubtitle = "DeepSeek V4 Flash · 最大";
    const childTitle = "DeepSeek V4 Flash - 高级推理与工具调用";
    const parentCommand = "test.long-menu-parent";
    const childCommand = "test.long-menu-child";
    const commandDisposables = [
      window.zion.commands.registerCommand(parentCommand, () => true),
      window.zion.commands.registerCommand(childCommand, () => true)
    ];
    const menuDisposable = window.zion.menus.register("editor/context", {
      command: parentCommand,
      title: parentTitle,
      subtitle: parentSubtitle,
      when: "editorFocus",
      submenu: [{
        command: childCommand,
        title: childTitle,
        when: "editorFocus"
      }]
    });

    core.view.dom.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10
    }));

    const buttons = Array.from(document.querySelectorAll(".zion-context-menu-item"));
    const parentButton = buttons.find(
      (button) => button.querySelector(".zion-context-menu-label-primary")?.textContent === parentTitle
    );
    const childButton = buttons.find((button) => button.textContent === childTitle);
    const rootMenu = parentButton?.closest(".zion-context-menu");
    const submenu = childButton?.closest(".zion-context-submenu");
    const parentLabel = parentButton?.querySelector(".zion-context-menu-label");
    const childLabel = childButton?.querySelector(".zion-context-menu-label");
    const parentPrimary = parentButton?.querySelector(".zion-context-menu-label-primary");
    const parentSecondary = parentButton?.querySelector(".zion-context-menu-label-secondary");

    expect(rootMenu?.classList.contains("zion-editor-context-menu")).toBe(true);
    expect(submenu?.classList.contains("zion-editor-context-menu")).toBe(true);
    expect(parentPrimary?.textContent).toBe(parentTitle);
    expect(parentSecondary?.textContent).toBe(parentSubtitle);
    expect(parentLabel?.getAttribute("title")).toBe(`${parentTitle} · ${parentSubtitle}`);
    expect(childLabel?.getAttribute("title")).toBe(childTitle);

    menuDisposable.dispose();
    commandDisposables.forEach((disposable) => disposable.dispose());
    core.view.destroy();
  });
});
