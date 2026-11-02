const $ = id => document.getElementById(id);
const labels = { operational: "正常", unavailable: "无法访问", unknown: "状态未知", maintenance: "维护中", degraded: "有事件" };
const incidentLabels = { investigating: "调查中", identified: "已定位", monitoring: "观察中", resolved: "已恢复", maintenance: "计划维护" };
const time = value => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚无记录";
const node = (tag, text, className) => { const el = document.createElement(tag); if (text) el.textContent = text; if (className) el.className = className; return el; };
let data = null, busy = false;
const render = () => {
  if (!data) return;
  const stale = Date.now() - data.generatedAt > data.staleAfterMs;
  const active = data.incidents.filter(i => i.status !== "resolved");
  const affected = new Set(active.flatMap(i => i.components));
  const events = new Set(active.filter(i => i.status !== "maintenance").flatMap(i => i.components));
  const components = data.components.map(c => ({ ...c, status: stale ? "unknown"
    : c.status === "operational" && affected.has(c.id) ? events.has(c.id) ? "degraded" : "maintenance" : c.status }));
  const unavailable = components.filter(c => c.status === "unavailable").length;
  const overall = stale ? "unknown" : unavailable ? "unavailable" : affected.size ? "maintenance" : "operational";
  $("overall-dot").className = "dot " + overall;
  $("overall-title").textContent = stale ? "检测结果已过期" : unavailable ? `${unavailable} 个服务入口暂时无法访问` : affected.size ? "部分服务有事件或维护公告" : "所有服务入口可访问";
  $("checked").textContent = `最近检查 ${time(data.generatedAt)} · ${data.region}`;
  $("components").replaceChildren(...components.map(c => {
    const row = node("div", "", "component"), name = node("div", "", "component-name");
    name.append(node("span", "", "dot " + c.status), node("strong", c.name));
    const detail = node("div", "", "component-detail");
    detail.append(node("small", stale ? "检测已过期" : `${c.latencyMs} ms`), node("span", labels[c.status], "state " + c.status));
    row.append(name, detail); return row;
  }));
  $("incident-time").textContent = `公告同步 ${time(data.incidentsCheckedAt)}`;
  $("incidents").replaceChildren(...(data.incidents.length ? data.incidents.map(i => {
    const article = node("article", "", "incident"), top = node("div", "", "incident-top");
    top.append(node("span", incidentLabels[i.status] || i.status, "state " + (i.status === "resolved" ? "operational" : "maintenance")), node("small", time(i.updatedAt)));
    article.append(top, node("h3", i.title), node("p", i.message));
    if (i.updates?.length > 1) {
      const history = node("details"), summary = node("summary", "查看进展记录");
      history.append(summary, ...i.updates.slice(1).map(u => {
        const entry = node("div", "", "update"); entry.append(node("small", `${time(u.updatedAt)} · ${incidentLabels[u.status] || u.status}`), node("p", u.message)); return entry;
      })); article.append(history);
    }
    return article;
  }) : [node("p", data.incidentsCheckedAt ? "目前没有已发布的事件记录。" : "公告暂时无法同步；这不表示没有事件。", "empty")]));
  $("method").textContent = data.monitoring + " 结果超过五分钟即显示“状态未知”。";
  $("storage").textContent = data.persistence === "durable" ? "最后一次检测与公开公告已保存至独立存储。" : "独立存储暂时无法写入，当前显示本次检测结果。";
};
async function refresh() {
  if (busy) return; busy = true; $("refresh").disabled = true; $("refresh").textContent = "检查中…";
  try {
    const response = await fetch("/api/check", { cache: "no-store", signal: AbortSignal.timeout(28000) });
    if (!response.ok) throw new Error();
    data = await response.json();
    try { localStorage.setItem("zioon.status.last", JSON.stringify(data)); } catch {}
    render();
  } catch {
    if (data) { data.generatedAt = Math.min(data.generatedAt, Date.now() - data.staleAfterMs - 1); render(); }
    else { $("overall-title").textContent = "监测暂时不可用"; $("checked").textContent = "暂时无法获取检测数据，请稍后重试。"; }
  } finally { busy = false; $("refresh").disabled = false; $("refresh").textContent = "重新检查"; }
}
try { data = JSON.parse(localStorage.getItem("zioon.status.last")); render(); } catch {}
$("refresh").onclick = refresh;
void refresh();
setInterval(() => { render(); if (!document.hidden) void refresh(); }, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
