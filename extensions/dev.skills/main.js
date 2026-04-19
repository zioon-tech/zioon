const DEFAULT_CONFIG = {
  maxActiveSkills: 3,
  tokenBudget: 30000,
  metadataScanTokens: 100,
  safetyMargin: 5000,
  enableUsageTracking: true,
  enableDependencyResolution: true,
  scoring: {
    keywordMatchWeight: 2,
    tagMatchWeight: 3,
    categoryMatchWeight: 4,
    historyBoostWeight: 0.5,
    exactNameBoost: 5
  }
};

const SKILLS_SNAPSHOT_STORAGE_KEY = "zion.skills.snapshot.v1";

function getState() {
  return window.zion && window.zion.state;
}

function safeJSONParse(text) {
  try { return JSON.parse(String(text || "")); } catch { return null; }
}

function loadSnapshot() {
  try {
    const raw = localStorage.getItem(SKILLS_SNAPSHOT_STORAGE_KEY) || "";
    const parsed = safeJSONParse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

let snapshotIdle = 0;
function saveSnapshotSoon() {
  if (snapshotIdle) cancelIdleCallback(snapshotIdle);
  snapshotIdle = requestIdleCallback(
    () => {
      snapshotIdle = 0;
      try {
        const state = getState();
        if (!state) return;
        const snap = {
          savedAt: Date.now(),
          paths: state.get("skills.paths") || [],
          enabled: state.get("skills.enabled") || [],
          catalog: state.get("skills.catalog") || [],
          cacheContent: state.get("skills.cacheContent") || {},
          usageHistory: state.get("skills.usageHistory") || {},
          tokenBudget: state.get("skills.tokenBudget") || DEFAULT_CONFIG.tokenBudget,
          config: state.get("skills.config") || DEFAULT_CONFIG,
          dependencyGraph: state.get("skills.dependencyGraph") || {},
          lastScan: state.get("skills.lastScan") || 0
        };
        localStorage.setItem(SKILLS_SNAPSHOT_STORAGE_KEY, JSON.stringify(snap));
      } catch {}
    },
    { timeout: 1200 }
  );
}

function restoreFromSnapshotIfNeeded() {
  try {
    const state = getState();
    if (!state) return;
    const snap = loadSnapshot();
    if (!snap) return;

    const paths = state.get("skills.paths") || [];
    const catalog = state.get("skills.catalog") || [];
    const lastScan = state.get("skills.lastScan") || 0;

    // Only restore when state looks like a fresh boot/defaults.
    const looksEmpty =
      (!Array.isArray(paths) || paths.length === 0) &&
      (!Array.isArray(catalog) || catalog.length === 0) &&
      (!lastScan || lastScan === 0);
    if (!looksEmpty) return;

    if (Array.isArray(snap.paths)) state.set("skills.paths", snap.paths);
    if (Array.isArray(snap.enabled)) state.set("skills.enabled", snap.enabled);
    if (Array.isArray(snap.catalog)) state.set("skills.catalog", snap.catalog);
    if (snap.cacheContent && typeof snap.cacheContent === "object") state.set("skills.cacheContent", snap.cacheContent);
    if (snap.usageHistory && typeof snap.usageHistory === "object") state.set("skills.usageHistory", snap.usageHistory);
    if (typeof snap.tokenBudget === "number") state.set("skills.tokenBudget", snap.tokenBudget);
    if (snap.config && typeof snap.config === "object") state.set("skills.config", snap.config);
    if (snap.dependencyGraph && typeof snap.dependencyGraph === "object") state.set("skills.dependencyGraph", snap.dependencyGraph);
    if (typeof snap.lastScan === "number") state.set("skills.lastScan", snap.lastScan);
  } catch {}
}

function ensureDefaults() {
  const state = getState();
  if (!state) return;

  if (!state.get("skills.paths")) state.set("skills.paths", []);
  if (!state.get("skills.enabled")) state.set("skills.enabled", []);
  if (!state.get("skills.catalog")) state.set("skills.catalog", []);
  if (!state.get("skills.cacheContent")) state.set("skills.cacheContent", {});
  if (!state.get("skills.usageHistory")) state.set("skills.usageHistory", {});
  if (!state.get("skills.tokenBudget")) state.set("skills.tokenBudget", DEFAULT_CONFIG.tokenBudget);
  if (!state.get("skills.config")) state.set("skills.config", DEFAULT_CONFIG);
  if (!state.get("skills.dependencyGraph")) state.set("skills.dependencyGraph", {});
  if (!state.get("skills.lastScan")) state.set("skills.lastScan", 0);
}

function getLocalToolsBase() {
  const state = getState();
  const raw = (state && state.get("localTools.baseUrl")) || "http://127.0.0.1:8765";
  return String(raw || "http://127.0.0.1:8765").replace(/\/$/, "");
}

function getEnabledSet() {
  const state = getState();
  const enabled = (state && state.get("skills.enabled")) || [];
  return new Set(Array.isArray(enabled) ? enabled : []);
}

function getCatalog() {
  const state = getState();
  const catalog = (state && state.get("skills.catalog")) || [];
  return Array.isArray(catalog) ? catalog : [];
}

function escapeXML(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function generateAvailableSkillsXML(catalog, enabledSet) {
  const enabledSkills = (catalog || []).filter((s) => enabledSet.has(s.id));
  const skillXMLs = enabledSkills
    .map((skill) => {
      const name = escapeXML(skill.name || skill.id);
      const desc = skill.description ? `<description>${escapeXML(skill.description)}</description>` : "";
      const location = skill.path ? `<location>${escapeXML(`${skill.path}/SKILL.md`)}</location>` : "";
      return `  <skill>\n    <name>${name}</name>\n    ${desc}\n    ${location}\n  </skill>`;
    })
    .join("\n");

  return `<available_skills>\n${skillXMLs}\n</available_skills>\n\nWhen you need detailed instructions for a skill, use the Read tool to access the file at the specified location.`;
}

async function listDirEntries(base, dir) {
  try {
    const url = `${base}/files/entries?path=${encodeURIComponent(dir)}&max_depth=1`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return [];

    const j = await res.json().catch(() => null);
    const rootPath = String((j && j.path) ? j.path : dir).replace(/\/$/, "");
    const raw = (j && typeof j === "object" && "results" in j) ? j.results : j;
    const entries = [];
    const seen = new Set();
    const addEntry = (path, type) => {
      const key = path + "|" + type;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ path, type });
    };

    if (Array.isArray(raw)) {
      raw.forEach((it) => {
        const p = String(it?.path || it?.full_path || it || "").trim();
        if (!p) return;
        const isDir = p.endsWith("/");
        const type = String(it?.type || it?.kind || "").toLowerCase() || (isDir ? "dir" : "file");
        addEntry(p.replace(/\/$/, ""), isDir ? "dir" : type);
      });
      return entries;
    }

    if (typeof raw === "string") {
      raw.split(/\r?\n/).forEach((ln) => {
        if (!/^-\s+/.test(ln)) return;
        const name = ln.replace(/^-\s+/, "").trim();
        if (!name) return;
        const isDir = /\/$/.test(name);
        const cleanName = name.replace(/\/$/, "");
        addEntry(`${rootPath}/${cleanName}`, isDir ? "dir" : "file");
      });
    }

    return entries;
  } catch {
    return [];
  }
}

async function fileExists(base, path) {
  try {
    const url = `${base}/files/read?path=${encodeURIComponent(path)}&offset=0&limit=1`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return false;
    const json = await res.json().catch(() => null);
    return json !== null && !json.error;
  } catch {
    return false;
  }
}

async function readFile(base, path, { headOnly = false } = {}) {
  try {
    const url = `${base}/files/read?path=${encodeURIComponent(path)}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return "";
    const json = await res.json().catch(() => null);
    if (!json) return "";
    const text = json.content || "";
    return headOnly ? text.slice(0, 6144) : text;
  } catch {
    return "";
  }
}

function normalizeArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return String(val).split(/[,\s]+/).filter(Boolean);
}

function parseSkillFrontMatter(text) {
  try {
    const m = /^---\s*[\r\n]+([\s\S]*?)[\r\n]+---\s*/.exec(text || "");
    if (!m) return {};
    const meta = {};
    m[1].split(/\r?\n/).forEach((ln) => {
      const kv = ln.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+)\s*$/);
      if (!kv) return;
      const key = kv[1].trim();
      let val = kv[2].trim();
      const arr = val.match(/^\[(.*)\]$/);
      if (arr) {
        meta[key] = arr[1].split(",").map((s) => s.trim()).filter(Boolean);
        return;
      }
      if (/^(true|false)$/i.test(val)) val = val.toLowerCase() === "true";
      else if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
      meta[key] = val;
    });

    return {
      name: meta.name,
      description: meta.description,
      category: meta.category,
      difficulty: meta.difficulty,
      tags: normalizeArray(meta.tags || meta.tag),
      allowedTools: normalizeArray(meta["allowed-tools"] || meta.allowedTools),
      dependencies: normalizeArray(meta.dependencies)
    };
  } catch {
    return {};
  }
}

async function isLocalToolsHealthy(base) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${base}/health`, { method: "GET", signal: controller.signal });
    clearTimeout(t);
    return !!res && res.ok;
  } catch {
    return false;
  }
}

async function scanAllSkills() {
  const state = getState();
  if (!state) return [];

  const paths = state.get("skills.paths") || [];
  const base = getLocalToolsBase();
  const prevCatalog = getCatalog();
  const healthy = await isLocalToolsHealthy(base);
  if (!healthy) {
    // Avoid wiping previously scanned skills when the local service is temporarily unavailable
    // (common during sleep/wake).
    return prevCatalog;
  }
  const catalog = [];

  for (const dir of Array.isArray(paths) ? paths : []) {
    try {
      const entries = await listDirEntries(base, dir);
      for (const entry of entries) {
        if (!entry || entry.type !== "dir") continue;
        const skillDir = String(entry.path || "").replace(/\/$/, "");
        if (!skillDir) continue;
        const skillMd = `${skillDir}/SKILL.md`;
        if (!(await fileExists(base, skillMd))) continue;

        const headText = await readFile(base, skillMd, { headOnly: true });
        const meta = parseSkillFrontMatter(headText);
        const id = skillDir.split("/").filter(Boolean).pop();
        if (!id) continue;

        catalog.push({
          id,
          name: meta.name || id,
          description: meta.description || "",
          category: meta.category || "",
          tags: meta.tags || [],
          difficulty: meta.difficulty || "",
          allowedTools: meta.allowedTools || [],
          dependencies: meta.dependencies || [],
          path: skillDir,
          file: skillMd
        });
      }
    } catch {}
  }

  // If the service is healthy but nothing was found, allow wiping only when no paths are configured.
  // This avoids "everything disappeared" when the directory mapping temporarily fails.
  const pathList = Array.isArray(paths) ? paths : [];
  const shouldKeepPrevious = pathList.length > 0 && catalog.length === 0 && prevCatalog.length > 0;
  if (shouldKeepPrevious) {
    return prevCatalog;
  }

  state.set("skills.catalog", catalog);
  state.set("skills.lastScan", Date.now());
  saveSnapshotSoon();

  const enabled = state.get("skills.enabled") || [];
  if (!Array.isArray(enabled) || enabled.length === 0) {
    state.set("skills.enabled", catalog.map((s) => s.id));
  }

  return catalog;
}

async function getCatalogOrScan() {
  const catalog = getCatalog();
  if (catalog.length > 0) return catalog;
  return await scanAllSkills();
}

function registerMessageContributor() {
  if (!window.zion || !window.zion.messages || typeof window.zion.messages.registerContributor !== "function") {
    return { dispose: () => {} };
  }

  return window.zion.messages.registerContributor({
    id: "dev.skills.standard",
    order: 25,
    stage: "pre",
    contribute: async (messages) => {
      try {
        const catalog = await getCatalogOrScan();
        const enabled = getEnabledSet();
        if (enabled.size === 0) return messages;
        const availableSkillsXML = generateAvailableSkillsXML(catalog, enabled);
        const systemMessage = { role: "system", content: availableSkillsXML };
        return [systemMessage, ...messages];
      } catch {
        return messages;
      }
    }
  });
}

function updateStatusBar() {
  try {
    const catalog = getCatalog();
    const enabled = getEnabledSet();
    const text = `Skills: ${enabled.size}/${catalog.length}`;
    window.zion.statusBar.registerItem({
      id: "dev.skills.status",
      text,
      tooltip: "Manage Skills",
      onClick: () => window.zion.commands.executeCommand("skills.openPanel"),
      priority: 78
    });
  } catch {}
}

function createButton(text, style, onClick) {
  const btn = document.createElement("button");
  btn.textContent = text;
  Object.assign(btn.style, style || {});
  btn.onclick = onClick;
  return btn;
}

function showModal(title, content) {
  const overlay = document.createElement("div");
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(0,0,0,0.35)",
    zIndex: "100000"
  });
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };

  const modal = document.createElement("div");
  Object.assign(modal.style, {
    position: "fixed",
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
    width: "720px",
    maxWidth: "92vw",
    maxHeight: "72vh",
    overflow: "auto",
    background: "var(--panel)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "10px",
    boxShadow: "0 16px 48px rgba(0,0,0,0.45)",
    padding: "14px"
  });
  modal.onclick = (e) => e.stopPropagation();

  const h = document.createElement("div");
  h.textContent = title;
  Object.assign(h.style, { fontWeight: "600", marginBottom: "10px", fontSize: "13px" });

  const pre = document.createElement("pre");
  pre.textContent = content;
  Object.assign(pre.style, {
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    lineHeight: "1.55",
    margin: "0"
  });

  const close = createButton(
    "Close",
    {
      marginTop: "12px",
      padding: "6px 12px",
      background: "var(--accent)",
      color: "var(--panel)",
      border: "none",
      borderRadius: "8px",
      cursor: "pointer"
    },
    () => overlay.remove()
  );

  modal.appendChild(h);
  modal.appendChild(pre);
  modal.appendChild(close);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

async function loadSkillBody(skill) {
  const base = getLocalToolsBase();
  const file = skill && (skill.file || (skill.path ? `${skill.path}/SKILL.md` : ""));
  if (!file) return "";
  const content = await readFile(base, file, { headOnly: false });
  return content || "";
}

function renderSkillsList(container) {
  const state = getState();
  if (!state) return;

  container.innerHTML = "";
  const catalog = getCatalog();
  const enabled = state.get("skills.enabled") || [];
  const enabledSet = new Set(Array.isArray(enabled) ? enabled : []);

  if (catalog.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = 'No skills found. Add a directory path and click "Scan Now".';
    Object.assign(empty.style, { fontSize: "12px", opacity: "0.7", padding: "10px 4px" });
    container.appendChild(empty);
    return;
  }

  const sorted = catalog.slice().sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  for (const skill of sorted) {
    const row = document.createElement("div");
    Object.assign(row.style, {
      border: "1px solid var(--border)",
      borderRadius: "10px",
      padding: "10px",
      marginBottom: "8px",
      background: enabledSet.has(skill.id) ? "rgba(128,128,128,0.06)" : "transparent"
    });

    const header = document.createElement("div");
    Object.assign(header.style, { display: "flex", alignItems: "center", gap: "10px" });
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = enabledSet.has(skill.id);
    toggle.onchange = () => {
      const next = new Set(enabledSet);
      if (toggle.checked) next.add(skill.id);
      else next.delete(skill.id);
      state.set("skills.enabled", Array.from(next));
    };

    const title = document.createElement("div");
    title.textContent = skill.name || skill.id;
    Object.assign(title.style, { fontSize: "13px", fontWeight: "600", flex: "1", minWidth: "0" });

    header.appendChild(toggle);
    header.appendChild(title);
    row.appendChild(header);

    const desc = document.createElement("div");
    desc.textContent = skill.description || "No description";
    Object.assign(desc.style, { fontSize: "12px", opacity: "0.8", marginTop: "6px", marginLeft: "22px" });
    row.appendChild(desc);

    const meta = document.createElement("div");
    const parts = [];
    if (skill.category) parts.push(String(skill.category));
    if (skill.tags && skill.tags.length) parts.push(skill.tags.map((t) => `#${t}`).join(" "));
    if (skill.difficulty) parts.push(String(skill.difficulty));
    meta.textContent = parts.join(" · ");
    Object.assign(meta.style, { fontSize: "11px", opacity: "0.65", marginTop: "6px", marginLeft: "22px" });
    row.appendChild(meta);

    const actions = document.createElement("div");
    Object.assign(actions.style, { display: "flex", gap: "8px", marginTop: "8px", marginLeft: "22px" });

    actions.appendChild(
      createButton(
        "Preview",
        {
          padding: "4px 10px",
          borderRadius: "8px",
          border: "1px solid var(--border)",
          background: "transparent",
          color: "var(--fg)",
          cursor: "pointer",
          fontSize: "12px"
        },
        async () => {
          const body = await loadSkillBody(skill);
          showModal(skill.name || skill.id, body || "(empty)");
        }
      )
    );

    row.appendChild(actions);
    container.appendChild(row);
  }
}

function renderPathsList(container) {
  const state = getState();
  if (!state) return;

  container.innerHTML = "";
  const paths = state.get("skills.paths") || [];
  const list = Array.isArray(paths) ? paths : [];

  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = "No paths configured";
    Object.assign(empty.style, { fontSize: "11px", opacity: "0.6" });
    container.appendChild(empty);
    return;
  }

  list.forEach((p, idx) => {
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "8px", alignItems: "center", marginBottom: "6px" });

    const label = document.createElement("div");
    label.textContent = String(p);
    Object.assign(label.style, {
      flex: "1",
      fontSize: "11px",
      opacity: "0.8",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      fontFamily: "var(--font-mono)"
    });

    const del = createButton(
      "×",
      {
        width: "26px",
        height: "26px",
        borderRadius: "8px",
        border: "1px solid var(--border)",
        background: "transparent",
        color: "var(--fg)",
        cursor: "pointer",
        opacity: "0.8"
      },
      () => {
        const next = list.slice();
        next.splice(idx, 1);
        state.set("skills.paths", next);
        renderPathsList(container);
      }
    );

    row.appendChild(label);
    row.appendChild(del);
    container.appendChild(row);
  });
}

function openSkillsPanel() {
  const state = getState();
  if (!state) return;

  const existing = document.getElementById("zion-skills-panel");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "zion-skills-panel";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(0,0,0,0.35)",
    zIndex: "99998"
  });
  let d1 = null;
  let d2 = null;
  const closePanel = () => {
    try { d1 && d1.dispose && d1.dispose(); } catch {}
    try { d2 && d2.dispose && d2.dispose(); } catch {}
    try { overlay.remove(); } catch {}
  };
  overlay.onclick = (e) => {
    if (e.target === overlay) closePanel();
  };

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    position: "fixed",
    right: "24px",
    top: "60px",
    width: "520px",
    maxWidth: "92vw",
    maxHeight: "78vh",
    overflow: "auto",
    background: "var(--panel)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "12px",
    boxShadow: "0 12px 32px rgba(0,0,0,0.42)",
    padding: "14px",
    zIndex: "99999",
    fontFamily: "var(--font-sans)"
  });
  panel.onclick = (e) => e.stopPropagation();

  const title = document.createElement("div");
  title.textContent = "Skills";
  Object.assign(title.style, { fontWeight: "700", fontSize: "14px", marginBottom: "10px" });
  panel.appendChild(title);

  const stats = document.createElement("div");
  Object.assign(stats.style, { fontSize: "12px", opacity: "0.75", marginBottom: "10px" });
  const refreshStats = () => {
    const catalog = getCatalog();
    const enabled = getEnabledSet();
    stats.textContent = `Enabled ${enabled.size}/${catalog.length} · Base ${getLocalToolsBase()}`;
  };
  refreshStats();
  panel.appendChild(stats);

  const pathsWrap = document.createElement("div");
  Object.assign(pathsWrap.style, { marginBottom: "12px" });

  const pathsHeader = document.createElement("div");
  pathsHeader.textContent = "Skill Directories";
  Object.assign(pathsHeader.style, { fontSize: "12px", fontWeight: "600", marginBottom: "6px" });
  pathsWrap.appendChild(pathsHeader);

  const inputRow = document.createElement("div");
  Object.assign(inputRow.style, { display: "flex", gap: "8px", marginBottom: "8px" });
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "/absolute/path/to/skills";
  Object.assign(input.style, {
    flex: "1",
    height: "30px",
    borderRadius: "10px",
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--fg)",
    padding: "0 10px",
    outline: "none",
    fontSize: "12px"
  });
  const addBtn = createButton(
    "Add",
    {
      height: "30px",
      padding: "0 12px",
      borderRadius: "10px",
      border: "1px solid var(--border)",
      background: "transparent",
      color: "var(--fg)",
      cursor: "pointer",
      fontSize: "12px"
    },
    () => {
      const p = String(input.value || "").trim();
      if (!p) return;
      const paths = state.get("skills.paths") || [];
      const next = Array.isArray(paths) ? paths.slice() : [];
      if (!next.includes(p)) next.push(p);
      state.set("skills.paths", next);
      input.value = "";
      renderPathsList(pathsList);
    }
  );
  inputRow.appendChild(input);
  inputRow.appendChild(addBtn);
  pathsWrap.appendChild(inputRow);

  const pathsList = document.createElement("div");
  renderPathsList(pathsList);
  pathsWrap.appendChild(pathsList);
  panel.appendChild(pathsWrap);

  const actions = document.createElement("div");
  Object.assign(actions.style, { display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px" });
  actions.appendChild(
    createButton(
      "Scan Now",
      {
        height: "30px",
        padding: "0 12px",
        borderRadius: "10px",
        border: "none",
        background: "var(--accent)",
        color: "var(--panel)",
        cursor: "pointer",
        fontSize: "12px",
        fontWeight: "600"
      },
      async () => {
        await window.zion.commands.executeCommand("skills.scanNow");
        renderSkillsList(skillsList);
        refreshStats();
      }
    )
  );

  actions.appendChild(
    createButton(
      "Enable All",
      {
        height: "30px",
        padding: "0 12px",
        borderRadius: "10px",
        border: "1px solid var(--border)",
        background: "transparent",
        color: "var(--fg)",
        cursor: "pointer",
        fontSize: "12px"
      },
      () => {
        const catalog = getCatalog();
        state.set("skills.enabled", catalog.map((s) => s.id));
        renderSkillsList(skillsList);
        refreshStats();
      }
    )
  );

  actions.appendChild(
    createButton(
      "Disable All",
      {
        height: "30px",
        padding: "0 12px",
        borderRadius: "10px",
        border: "1px solid var(--border)",
        background: "transparent",
        color: "var(--fg)",
        cursor: "pointer",
        fontSize: "12px"
      },
      () => {
        state.set("skills.enabled", []);
        renderSkillsList(skillsList);
        refreshStats();
      }
    )
  );

  actions.appendChild(
    createButton(
      "Clear Usage",
      {
        height: "30px",
        padding: "0 12px",
        borderRadius: "10px",
        border: "1px solid var(--border)",
        background: "transparent",
        color: "var(--fg)",
        cursor: "pointer",
        fontSize: "12px"
      },
      async () => {
        await window.zion.commands.executeCommand("skills.clearCache");
      }
    )
  );

  const closeBtn = createButton(
    "Close",
    {
      height: "30px",
      padding: "0 12px",
      borderRadius: "10px",
      border: "1px solid var(--border)",
      background: "transparent",
      color: "var(--fg)",
      cursor: "pointer",
      fontSize: "12px",
      marginLeft: "auto"
    },
    () => closePanel()
  );
  actions.appendChild(closeBtn);
  panel.appendChild(actions);

  const skillsList = document.createElement("div");
  renderSkillsList(skillsList);
  panel.appendChild(skillsList);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  d1 = window.zion.state.onDidChange("skills.catalog", () => {
    renderSkillsList(skillsList);
    refreshStats();
  });
  d2 = window.zion.state.onDidChange("skills.enabled", () => {
    renderSkillsList(skillsList);
    refreshStats();
  });
  return { dispose: closePanel };
}

function registerCommands() {
  const cmds = [];
  try {
    cmds.push(window.zion.commands.registerCommand("skills.openPanel", () => openSkillsPanel()));
    cmds.push(
      window.zion.commands.registerCommand("skills.scanNow", async () => {
        await scanAllSkills();
        updateStatusBar();
      })
    );
    cmds.push(
      window.zion.commands.registerCommand("skills.clearCache", () => {
        const state = getState();
        if (!state) return;
        state.set("skills.cacheContent", {});
        state.set("skills.usageHistory", {});
      })
    );
    cmds.push(
      window.zion.commands.registerCommand("skills.showStats", () => {
        try {
          const state = getState();
          if (!state) return;
          const history = state.get("skills.usageHistory") || {};
          const catalog = getCatalog();
          const lines = Object.entries(history || {}).map(([id, entries]) => {
            const skill = catalog.find((s) => s.id === id);
            const name = (skill && (skill.name || skill.id)) || id;
            const total = Array.isArray(entries) ? entries.length : 0;
            return `${name}: ${total}`;
          });
          alert(`Skills Statistics:\n\n${lines.length ? lines.join("\n") : "No usage data."}`);
        } catch {}
      })
    );
  } catch {}
  return cmds;
}

function registerStateListeners() {
  const disposers = [];
  try {
    disposers.push(window.zion.state.onDidChange("skills.enabled", () => updateStatusBar()));
    disposers.push(window.zion.state.onDidChange("skills.catalog", () => updateStatusBar()));
    const keysToPersist = [
      "skills.paths",
      "skills.enabled",
      "skills.catalog",
      "skills.cacheContent",
      "skills.usageHistory",
      "skills.tokenBudget",
      "skills.config",
      "skills.dependencyGraph",
      "skills.lastScan"
    ];
    for (const k of keysToPersist) {
      try { disposers.push(window.zion.state.onDidChange(k, () => saveSnapshotSoon())); } catch {}
    }
  } catch {}
  return disposers;
}

export async function activate(ctx) {
  ensureDefaults();
  restoreFromSnapshotIfNeeded();

  const commands = registerCommands();
  const contributor = registerMessageContributor();
  const listeners = registerStateListeners();

  try { ctx.subscriptions.push(...commands); } catch {}
  try { ctx.subscriptions.push(contributor); } catch {}
  try { ctx.subscriptions.push(...listeners); } catch {}

  // Register skills settings into core Settings Panel
  try {
    if (window.zion?.settings?.registerItem) {
      const state = getState();
      const paths = (state && state.get("skills.paths")) || [];
      const catalog = getCatalog();
      const enabled = getEnabledSet();

      window.zion.settings.registerItem({
        id: "skills-config",
        section: "Skills",
        title: "Skills 配置",
        order: 30,
        render(container) {
          const st = getState();
          if (!st) return;
          container.innerHTML = "";

          const style = document.createElement("style");
          style.textContent = `
            .sk-cfg-info { font-size:11px;opacity:.7;margin-bottom:10px }
            .sk-cfg-path-row { display:flex;gap:6px;margin-bottom:8px;align-items:center }
            .sk-cfg-input { flex:1;padding:4px 8px;border:1px solid var(--border,#3c3c3c);border-radius:6px;background:transparent;color:var(--fg,#ccc);font-size:12px;font-family:var(--font-mono,monospace) }
            .sk-cfg-input:focus { outline:1px solid var(--accent,#6272a4) }
            .sk-cfg-btn { padding:4px 12px;border:1px solid var(--border,#3c3c3c);border-radius:6px;background:transparent;color:var(--fg,#ccc);cursor:pointer;font-size:12px }
            .sk-cfg-btn:hover { background:rgba(255,255,255,.06) }
            .sk-cfg-btn.primary { border-color:var(--accent,#6272a4);color:var(--accent,#6272a4) }
            .sk-cfg-path-item { display:flex;gap:6px;align-items:center;margin-bottom:4px }
            .sk-cfg-path-text { flex:1;font-size:11px;opacity:.8;font-family:var(--font-mono,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
            .sk-cfg-path-del { padding:2px 8px;border:1px solid var(--border,#3c3c3c);border-radius:4px;background:transparent;color:var(--fg,#ccc);cursor:pointer;font-size:11px;opacity:.7 }
            .sk-cfg-path-del:hover { opacity:1;color:#ff6b6b }
            .sk-cfg-actions { display:flex;gap:8px;margin-top:10px }
            .sk-cfg-label { font-size:12px;opacity:.85;font-weight:500;margin-bottom:4px }
            .sk-cfg-section { margin-bottom:12px }
          `;
          container.appendChild(style);

          // Stats
          const cat = getCatalog();
          const en = getEnabledSet();
          const info = document.createElement("div");
          info.className = "sk-cfg-info";
          info.textContent = `已启用 ${en.size}/${cat.length} 个 skills`;
          container.appendChild(info);

          // Paths section
          const pathsSection = document.createElement("div");
          pathsSection.className = "sk-cfg-section";
          const pathsLabel = document.createElement("div");
          pathsLabel.className = "sk-cfg-label";
          pathsLabel.textContent = "Skills 目录";
          pathsSection.appendChild(pathsLabel);

          const pathList = document.createElement("div");
          const refreshPaths = () => {
            pathList.innerHTML = "";
            const currentPaths = st.get("skills.paths") || [];
            for (let i = 0; i < currentPaths.length; i++) {
              const row = document.createElement("div");
              row.className = "sk-cfg-path-item";
              const text = document.createElement("div");
              text.className = "sk-cfg-path-text";
              text.textContent = currentPaths[i];
              text.title = currentPaths[i];
              const del = document.createElement("button");
              del.className = "sk-cfg-path-del";
              del.textContent = "×";
              del.onclick = () => {
                const next = currentPaths.slice();
                next.splice(i, 1);
                st.set("skills.paths", next);
                refreshPaths();
              };
              row.appendChild(text);
              row.appendChild(del);
              pathList.appendChild(row);
            }
          };
          refreshPaths();
          pathsSection.appendChild(pathList);

          const addRow = document.createElement("div");
          addRow.className = "sk-cfg-path-row";
          const input = document.createElement("input");
          input.className = "sk-cfg-input";
          input.type = "text";
          input.placeholder = "/path/to/skills/directory";
          const addBtn = document.createElement("button");
          addBtn.className = "sk-cfg-btn";
          addBtn.textContent = "添加";
          addBtn.onclick = () => {
            const v = input.value.trim();
            if (!v) return;
            const current = st.get("skills.paths") || [];
            if (!current.includes(v)) {
              st.set("skills.paths", [...current, v]);
            }
            input.value = "";
            refreshPaths();
          };
          addRow.appendChild(input);
          addRow.appendChild(addBtn);
          pathsSection.appendChild(addRow);
          container.appendChild(pathsSection);

          // Actions
          const actions = document.createElement("div");
          actions.className = "sk-cfg-actions";

          const scanBtn = document.createElement("button");
          scanBtn.className = "sk-cfg-btn primary";
          scanBtn.textContent = "立即扫描";
          scanBtn.onclick = async () => {
            await window.zion.commands.executeCommand("skills.scanNow");
            refreshPaths();
            const newCat = getCatalog();
            const newEn = getEnabledSet();
            info.textContent = `已启用 ${newEn.size}/${newCat.length} 个 skills`;
          };
          actions.appendChild(scanBtn);

          const enableAllBtn = document.createElement("button");
          enableAllBtn.className = "sk-cfg-btn";
          enableAllBtn.textContent = "全部启用";
          enableAllBtn.onclick = () => {
            const allCat = getCatalog();
            st.set("skills.enabled", allCat.map(s => s.id));
            const newEn = getEnabledSet();
            info.textContent = `已启用 ${newEn.size}/${allCat.length} 个 skills`;
          };
          actions.appendChild(enableAllBtn);

          const clearBtn = document.createElement("button");
          clearBtn.className = "sk-cfg-btn";
          clearBtn.textContent = "清除缓存";
          clearBtn.onclick = () => {
            window.zion.commands.executeCommand("skills.clearCache");
          };
          actions.appendChild(clearBtn);

          container.appendChild(actions);
        }
      });
    }
  } catch (e) {
    console.warn("[dev.skills] failed to register settings item", e);
  }

  try {
    Promise.resolve().then(async () => {
      try { await scanAllSkills(); } catch {}
      try { updateStatusBar(); } catch {}
    });
  } catch {}

  updateStatusBar();

  // When returning from sleep, the local tools service may restart later.
  // Retry a scan when the page becomes visible again.
  try {
    let retryTimer = 0;
    const scheduleRetry = () => {
      if (retryTimer) window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(async () => {
        retryTimer = 0;
        try { await scanAllSkills(); } catch {}
        try { updateStatusBar(); } catch {}
      }, 600);
    };
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) scheduleRetry();
      else saveSnapshotSoon();
    });
    window.addEventListener("focus", () => scheduleRetry(), { passive: true });
    window.addEventListener("pagehide", () => saveSnapshotSoon(), { passive: true });
  } catch {}
}
