/** Owned by the editor surface, so loading or disabling a contribution cannot
 * reparent the live CodeMirror DOM or change which presentation rules match. */
export function createConversationLayout(parent: HTMLElement) {
  const layout = document.createElement("div");
  layout.className = "zion-conversation-layout zion-toc-layout";
  Object.assign(layout.style, {
    position: "relative", width: "100%", height: "100%", display: "flex",
    minWidth: "0", minHeight: "0"
  });
  parent.appendChild(layout);
  return layout;
}
