const $ = (id) => document.getElementById(id);
const code = new URLSearchParams(location.search).get("user_code");
let csrf;
async function decide(decision) {
  $("device-approve").disabled = $("device-deny").disabled = true;
  try {
    const response = await fetch("/account/device-approve", { method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ user_code: code, decision }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error();
    $("device-actions").hidden = true;
    $("device-status").textContent = decision === "approve" ? "已确认，请回到终端继续。" : "已取消，可以关闭此页。";
  } catch {
    $("device-status").textContent = "请求未完成，请重试或重新发起终端登录。";
    $("device-approve").disabled = $("device-deny").disabled = false;
  }
}
$("device-approve").addEventListener("click", () => decide("approve"));
$("device-deny").addEventListener("click", () => decide("deny"));
try {
  if (!/^[A-F0-9]{12}$/.test(code || "")) throw new Error();
  const response = await fetch("/console/api/me", { credentials: "same-origin", signal: AbortSignal.timeout(10000) });
  if (response.status === 401) {
    $("device-status").textContent = "请先登录，然后确认终端中的验证码。";
    $("device-login").href = `/account/login?user_code=${encodeURIComponent(code)}`;
    $("device-login").hidden = false;
  } else {
    if (!response.ok) throw new Error();
    const me = await response.json();
    csrf = me.csrf;
    const info = await fetch(`/account/device-info?user_code=${encodeURIComponent(code)}`, {
      credentials: "same-origin", signal: AbortSignal.timeout(10000) });
    if (!info.ok) throw new Error();
    $("device-code").textContent = code;
    $("device-status").textContent = `当前账号：${me.user.email || me.user.name}。请确认验证码与终端一致。`;
    $("device-actions").hidden = false;
  }
} catch { $("device-status").textContent = "登录请求已过期或暂时不可用，请在终端重新运行 agent-fs login。"; }
