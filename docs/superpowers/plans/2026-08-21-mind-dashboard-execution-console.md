# Mind Dashboard 执行中控台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Mind Dashboard 从重复异常卡片列表改成高密度、只读、可定位的执行中控台。

**Architecture:** 新增纯函数数据模块负责时间窗口、事件缓存、异常聚合和资源/项目投影；`main.js` 只负责三视图状态、DOM 渲染与宿主定位动作；`styles.css` 使用宿主主题变量实现紧凑分区。账本订阅只重新读取发生变化的 Run 事件，三秒时钟仅刷新已有数据的相对时间与运行耗时。

**Tech Stack:** ES modules、DOM API、CSS custom properties、Node.js test runner

---

### Task 1: 建立可测试的数据投影

**Files:**
- Create: `/Users/bytedance/.zion-next/plugins/dev.mind-dashboard/dashboard-model.js`
- Create: `/Users/bytedance/.zion-next/plugins/dev.mind-dashboard/dashboard-model.test.mjs`

- [ ] **Step 1: 写异常聚合与恢复测试**

```js
test("groups repeated incidents and drops recovered groups", () => {
  const model = buildDashboardModel(snapshot, getEvents, { now: NOW, since: NOW - DAY });
  assert.equal(model.concerns.length, 1);
  assert.equal(model.concerns[0].count, 2);
  assert.equal(model.concerns[0].category, "超时");
});
```

- [ ] **Step 2: 写事件缓存测试**

```js
test("reloads events only for changed runs", () => {
  const cache = createRunEventCache(ledger);
  cache.update(firstSnapshot);
  cache.update(firstSnapshot);
  assert.equal(getEventsCalls, 1);
  cache.update(changedSnapshot);
  assert.equal(getEventsCalls, 2);
});
```

- [ ] **Step 3: 运行测试并确认失败**

Run: `node --test dashboard-model.test.mjs`

Expected: FAIL because `dashboard-model.js` does not exist.

- [ ] **Step 4: 实现投影和缓存**

```js
export function createRunEventCache(ledger) {
  const cache = new Map();
  const fingerprints = new Map();
  return {
    update(snapshot) {
      for (const run of snapshot.runs || []) {
        const fingerprint = `${run.updatedAt}:${run.lastEventAt}:${run.status}:${run.toolCalls}`;
        if (fingerprints.get(run.id) === fingerprint) continue;
        cache.set(run.id, ledger.getEvents(run.id) || []);
        fingerprints.set(run.id, fingerprint);
      }
    },
    get(runId) {
      return cache.get(runId) || [];
    }
  };
}
```

`buildDashboardModel` 必须输出 `totals`、`activeRuns`、`concerns`、`recentCompleted`、`projects` 和 `models`。异常以 `source + category` 聚合，并过滤发生时间早于同来源最近成功时间的记录。

- [ ] **Step 5: 运行测试**

Run: `node --test dashboard-model.test.mjs`

Expected: all tests pass.

### Task 2: 实现三视图中控台

**Files:**
- Modify: `/Users/bytedance/.zion-next/plugins/dev.mind-dashboard/main.js`
- Modify: `/Users/bytedance/.zion-next/plugins/dev.mind-dashboard/styles.css`

- [ ] **Step 1: 接入数据模块和视图状态**

```js
import {
  TIME_RANGES,
  buildDashboardModel,
  createRunEventCache
} from "./dashboard-model.js";

let activeView = "live";
let rangeKey = "today";
```

- [ ] **Step 2: 实现实时视图**

实时视图固定显示四项 KPI；异常行显示类别、重复次数、最近时间；运行行显示来源、耗时、Token、工具数和最新事件；无运行时显示最近成功运行。

- [ ] **Step 3: 实现资源和项目视图**

资源视图使用紧凑横条显示模型 Token 占比，并列出运行数、失败率、平均耗时和工具数。项目视图只聚合 `source.kind === "project"`，显示活跃数、未恢复异常数、Token 和最近活动。

- [ ] **Step 4: 实现定位交互**

```js
function openRunTarget(run) {
  if (run?.sessionId) openSession(run.sessionId);
  else openLogView();
}
```

行支持鼠标与键盘激活；顶部仅保留 tabs、时间范围、日志和刷新图标。

- [ ] **Step 5: 重写视觉层**

移除内部重复标题、渐变光晕和卡片堆叠。使用宿主背景、1px 分隔线、34px tabs、38px 至 44px 数据行和语义色左标记；仅状态使用胶囊。

### Task 3: 校验与提交

**Files:**
- Verify: `/Users/bytedance/.zion-next/plugins/dev.mind-dashboard/*.js`
- Verify: `/Users/bytedance/.zion-next/plugins/dev.mind-dashboard/*.css`

- [ ] **Step 1: 运行单元测试**

Run: `node --test dashboard-model.test.mjs`

Expected: all tests pass.

- [ ] **Step 2: 运行语法检查**

Run: `node --check main.js && node --check dashboard-model.js`

Expected: both commands exit successfully.

- [ ] **Step 3: 检查敏感信息约束**

Run: `rg -n "args|argument|prompt|result" main.js dashboard-model.js`

Expected: UI 不显示工具参数值、Prompt 或工具结果正文。

- [ ] **Step 4: 提交插件**

```bash
git add manifest.json main.js styles.css dashboard-model.js dashboard-model.test.mjs
git commit -m "feat: redesign mind dashboard as execution console"
```
