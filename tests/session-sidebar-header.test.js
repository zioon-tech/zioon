import { describe, expect, it, vi } from "vitest";
import { renderSessionsTagHeader } from "../extensions/dev.session-manager/ui/sidebar-header.js";
import { createZionIconFromCodicon, hasZionIcon, zionIconName } from "../src/ui/icons";

describe("sessions tag split header", () => {
  it("registers the selected new-session icon", () => {
    expect(hasZionIcon("message-circle-plus")).toBe(true);
    expect(zionIconName("message-circle-plus")).toBe("message-circle-plus");
  });

  it("registers the card view toggle icon", () => {
    expect(hasZionIcon("layout-grid")).toBe(true);
    expect(zionIconName("layout-grid")).toBe("layout-grid");
  });

  it("keeps comments and sessions on distinct activity icons", () => {
    const commentsIcon = createZionIconFromCodicon("comment-discussion");
    expect(commentsIcon.classList.contains("codicon-comment-discussion")).toBe(true);

    const sessionsIcon = createZionIconFromCodicon("messages-square");
    expect(hasZionIcon("messages-square")).toBe(true);
    expect(zionIconName("messages-square")).toBe("messages-square");
    expect(sessionsIcon.dataset.zionIcon).toBe("messages-square");
  });

  it("renders snapshots, delegates add, and detaches", () => {
    const add = vi.fn();
    let sink = null;
    const detach = vi.fn();
    const manager = {
      attachTagSplitHeader: (nextSink) => {
        sink = nextSink;
        nextSink({ visible: false, width: 180, nodeCount: 0 });
        return { dispose: detach };
      },
      createRootTagIfOpen: add
    };
    const context = {
      setVisible: vi.fn(),
      setWidth: vi.fn()
    };
    const container = document.createElement("div");
    const disposable = renderSessionsTagHeader(container, context, {
      manager,
      t: (_key, fallback) => fallback
    });

    expect(container.querySelector(".zion-sessions-header-title").textContent).toBe("Tags");
    expect(context.setVisible).toHaveBeenLastCalledWith(false);
    expect(context.setWidth).toHaveBeenLastCalledWith(180);

    sink({ visible: true, width: 200, nodeCount: 13 });
    expect(context.setVisible).toHaveBeenLastCalledWith(true);
    expect(context.setWidth).toHaveBeenLastCalledWith(200);
    expect(container.querySelector(".zion-sessions-header-count").textContent).toBe("13");

    container.querySelector(".zion-sessions-header-add").click();
    expect(add).toHaveBeenCalledTimes(1);

    disposable.dispose();
    expect(detach).toHaveBeenCalledTimes(1);
    expect(context.setVisible).toHaveBeenLastCalledWith(false);
  });
});
