import { zionIconHtml } from "../icons";
import "./access-change-dialog.css";

export function showAccessChangeDialog(drafts: Array<{ sessionId: string; text: string }>, reenter: () => void) {
  const gate = document.createElement("dialog");
  gate.className = "zion-access-change-dialog";
  gate.setAttribute("aria-labelledby", "zion-access-change-title");
  gate.setAttribute("aria-describedby", "zion-access-change-description");
  gate.setAttribute("aria-modal", "true");
  const icon = document.createElement("div");
  icon.className = "zion-access-change-icon"; icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = zionIconHtml("lock");
  const title = document.createElement("h2");
  title.id = "zion-access-change-title"; title.textContent = "请重新进入工作台";
  const message = document.createElement("p");
  message.id = "zion-access-change-description";
  message.textContent = "账户或访问权限已变化。重新进入后，即可按最新权限继续使用。";
  const retained = document.createElement("p"); retained.className = "zion-access-change-retained";
  retained.textContent = drafts.length ? `当前打开的 ${drafts.length} 个会话已保留，可先下载备份。` : "当前没有需要备份的打开会话。";
  const actions = document.createElement("div"); actions.className = "zion-access-change-actions";
  const download = document.createElement("button"); download.type = "button";
  download.textContent = "下载保留的内容"; download.disabled = !drafts.length;
  download.onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(drafts, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "zion-session-drafts.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const button = document.createElement("button"); button.type = "button"; button.className = "is-primary";
  button.textContent = "重新进入"; button.autofocus = true; button.onclick = reenter;
  actions.append(download, button); gate.append(icon, title, message, retained, actions);
  gate.addEventListener("cancel", event => event.preventDefault());
  document.body.appendChild(gate); gate.showModal(); button.focus();
  return gate;
}
