import { createHash, randomUUID } from "node:crypto";
import { CATEGORIES, digest, normalizeContribution, OFFICIAL_RELEASES } from "./catalog.mjs";
import { hashExtension, safeExtensionPath, normalizeExtensionConfig, normalizeExtensionPackage, privateExtensionRelease,
  publicExtensionRelease, extensionSettingsFor, validateExtensionSettings } from "../../../../packages/runtime-client/src/extension-package.mjs";
import { artifactStoreFromEnvironment } from "./artifact-store.mjs";
import { storeReleaseContent, readReleaseContent } from "./release-content.mjs";
import { normalizeHostDescription } from "../../../../packages/plugin-sdk/src/host-contract.mjs";
import { releaseFromInstallationFiles } from "./installation-content.mjs";

const fail = (statusCode, code, message) => { throw Object.assign(new Error(message), { statusCode, code }); };
const emptyState = () => ({ installations: {}, contributions: {}, events: [] });
const clone = (value) => JSON.parse(JSON.stringify(value));
const userIdOf = (context) => String(context?.principal?.user?.id || context?.principal?.userId
  || context?.request?.principal?.userId || "");

export function overlaySkills(snapshot, overlay = { catalog: [], enabled: [] }) {
  const marketIds = new Set(overlay.catalog.map((skill) => skill.id));
  return { ...snapshot,
    catalog: [...snapshot.catalog.filter((skill) => !marketIds.has(skill.id)), ...overlay.catalog],
    enabled: [...new Set([...snapshot.enabled.filter((id) => !id.startsWith("marketplace:")), ...overlay.enabled])]
  };
}

export class MarketplaceService {
  constructor({ pool, reviewerIds = [], artifactStore, defaultExecutionConfig }) {
    this.pool = pool;
    this.artifactStore = artifactStore || artifactStoreFromEnvironment();
    this.defaultExecutionConfig = defaultExecutionConfig;
    this.reviewerIds = new Set(reviewerIds);
  }

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS marketplace_releases (
        listing_id text NOT NULL, version text NOT NULL, digest text NOT NULL,
        manifest_json jsonb NOT NULL, status text NOT NULL DEFAULT 'published',
        published_at bigint NOT NULL, PRIMARY KEY (listing_id,version));
      CREATE TABLE IF NOT EXISTS marketplace_accounts (
        user_id text PRIMARY KEY, revision integer NOT NULL DEFAULT 0,
        state_json jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS marketplace_private_releases (
        user_id text NOT NULL, listing_id text NOT NULL, version text NOT NULL,
        digest text NOT NULL, artifact_digest text NOT NULL, manifest_json jsonb NOT NULL,
        published_at bigint NOT NULL, PRIMARY KEY (user_id,listing_id,version));
      CREATE TABLE IF NOT EXISTS marketplace_development_releases (
        user_id text NOT NULL, listing_id text NOT NULL, version text NOT NULL,
        digest text NOT NULL, artifact_digest text NOT NULL, manifest_json jsonb NOT NULL,
        published_at bigint NOT NULL, PRIMARY KEY (user_id,listing_id,version));
    `);
    for (const manifest of OFFICIAL_RELEASES) {
      const existing = (await this.pool.query(`SELECT digest FROM marketplace_releases
        WHERE listing_id=$1 AND version=$2`, [manifest.id, manifest.version])).rows[0];
      if (!existing) {
        const metadata = await storeReleaseContent(manifest, this.artifactStore);
        await this.pool.query(`INSERT INTO marketplace_releases
          (listing_id,version,digest,manifest_json,published_at) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (listing_id,version) DO NOTHING`,
        [manifest.id, manifest.version, digest(manifest), metadata, Date.now()]);
      }
      const row = (await this.pool.query(`SELECT digest FROM marketplace_releases
        WHERE listing_id=$1 AND version=$2`, [manifest.id, manifest.version])).rows[0];
      if (row.digest !== digest(manifest)) fail(409, "release_immutable", `版本内容已改变：${manifest.id}@${manifest.version}，请发布新版本`);
    }
    await this.migrateInlineContent();
    return this;
  }

  async migrateInlineContent() {
    let migrated = 0;
    for (const table of ["marketplace_releases", "marketplace_private_releases"]) {
      const rows = (await this.pool.query(`SELECT * FROM ${table} WHERE NOT (manifest_json ? 'contentRef')`)).rows;
      for (const row of rows) {
        const metadata = await storeReleaseContent(row.manifest_json, this.artifactStore);
        const values = [row.listing_id, row.version, metadata, row.digest];
        const privateClause = table === "marketplace_private_releases" ? " AND user_id=$5" : "";
        if (privateClause) values.push(row.user_id);
        const result = await this.pool.query(`UPDATE ${table} SET manifest_json=$3
          WHERE listing_id=$1 AND version=$2 AND digest=$4 AND NOT (manifest_json ? 'contentRef')${privateClause}`, values);
        migrated += result.rowCount;
      }
    }
    const accounts = (await this.pool.query("SELECT user_id,state_json FROM marketplace_accounts")).rows;
    for (const row of accounts) {
      if (!Object.values(row.state_json.contributions || {}).some((c) => !c.manifest.contentRef)) continue;
      await this.transaction(row.user_id, undefined, async (state) => {
        for (const contribution of Object.values(state.contributions)) {
          if (!contribution.manifest.contentRef) {
            contribution.manifest = await storeReleaseContent(contribution.manifest, this.artifactStore);
            migrated++;
          }
        }
        return {};
      });
    }
    return { migrated };
  }

  async releaseFor(userId, listingId, version, { content = false } = {}) {
    if (!userId) fail(401, "authentication_required", "请先登录账户");
    const release = (await this.releases(this.pool, userId)).find((r) =>
      r.id === listingId && r.version === version && ["published", "private"].includes(r.status));
    if (!release) fail(404, "release_unavailable", "所选版本不可读取");
    return content ? readReleaseContent(release, this.artifactStore) : release;
  }

  async releases(client = this.pool, userId = "") {
    const publicRows = (await client.query(`SELECT manifest_json,digest,status,published_at
      FROM marketplace_releases ORDER BY published_at,listing_id,version`)).rows;
    const privateRows = userId ? (await client.query(`SELECT manifest_json,digest,
      'private' AS status,published_at,artifact_digest FROM marketplace_private_releases WHERE user_id=$1
      UNION ALL SELECT manifest_json,digest,'private' AS status,published_at,artifact_digest
      FROM marketplace_development_releases WHERE user_id=$1
      ORDER BY published_at`, [userId])).rows : [];
    return [...publicRows, ...privateRows].map((row) => ({
      ...row.manifest_json, digest: row.digest, status: row.status, publishedAt: Number(row.published_at)
      , ...(row.artifact_digest ? { artifactDigest: row.artifact_digest } : {})
    }));
  }

  async account(userId) {
    if (!userId) return { revision: 0, ...emptyState() };
    const row = (await this.pool.query("SELECT revision,state_json FROM marketplace_accounts WHERE user_id=$1", [userId])).rows[0];
    return row ? { ...clone(row.state_json), revision: row.revision } : { revision: 0, ...emptyState() };
  }

  async transaction(userId, expectedRevision, operation) {
    if (!userId) fail(401, "authentication_required", "请先登录账户");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO marketplace_accounts (user_id,state_json) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, emptyState()]);
      const row = (await client.query("SELECT revision,state_json FROM marketplace_accounts WHERE user_id=$1 FOR UPDATE", [userId])).rows[0];
      if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision !== row.revision)) {
        fail(409, "revision_conflict", "账户扩展已发生变化，请刷新后重试");
      }
      const state = clone(row.state_json);
      const result = await operation(state, client);
      state.events = state.events.slice(-100);
      await client.query("UPDATE marketplace_accounts SET state_json=$2,revision=revision+1 WHERE user_id=$1", [userId, state]);
      await client.query("COMMIT");
      return { ...result, revision: row.revision + 1 };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async snapshot(userId) {
    const [releases, account] = await Promise.all([this.releases(this.pool, userId), this.account(userId)]);
    const listings = new Map();
    const compare = (a, b) => {
      const av = a.version.split(".").map(Number), bv = b.version.split(".").map(Number);
      return av[0] - bv[0] || av[1] - bv[1] || av[2] - bv[2];
    };
    for (const release of releases.filter((entry) => ["published", "private"].includes(entry.status)).sort(compare)) {
      listings.set(release.id, release);
    }
    // A withdrawn installed release stays visible and manageable.
    for (const install of Object.values(account.installations)) {
      if (!listings.has(install.listingId)) {
        const release = releases.find((r) => r.id === install.listingId && r.version === install.version);
        if (release) listings.set(release.id, release);
      }
    }
    return {
      accountId: userId, revision: account.revision, categories: CATEGORIES,
      entries: [...listings.values()].map((listing) => {
        const install = account.installations[listing.id];
        const sourceRelease = install && releases.find((r) => r.id === listing.id && r.version === install.version);
        const installedRelease = install?.activeRevision?.release || sourceRelease;
        return { ...listing,
          versions: releases.filter((r) => r.id === listing.id && ["published", "private"].includes(r.status)).sort(compare).reverse()
            .map((r) => ({ version: r.version, digest: r.digest, changelog: r.changelog })),
          ...(install ? { installation: { ...this.installationStatus(install, installedRelease),
            updateAvailable: sourceRelease ? compare(listing, sourceRelease) > 0 : false },
            installedRelease, sourceRelease } : {}) };
      }),
      contributions: Object.values(account.contributions),
      events: account.events, canReview: this.reviewerIds.has(userId)
    };
  }

  installationStatus(install, release) {
    const components = (release?.components || []).map((component) => ({
      id: component.id, kind: component.kind, name: component.name,
      status: !install.enabled || install.disabledComponents?.includes(component.id) ? "disabled"
        : component.kind === "skill" ? "ready"
          : !release?.artifact ? (component.kind === "mcp" ? "configuration_required" : "host_required")
            : !install.config || validateExtensionSettings(install.config, release).length ? "configuration_required"
              : release?.artifact?.plugin?.connection?.required && !install.config.credentialsFile ? "connection_required"
              : install.validation?.epoch === install.executionEpoch ? "ready" : "validation_required",
      ...(component.kind !== "skill" && install.validation?.epoch === install.executionEpoch
        ? { tools: install.validation.tools } : {}),
      ...(release?.artifact?.plugin?.entries?.workbench ? { uiStatus: "ready" } : {}),
      ...(component.requirements ? { requirements: component.requirements } : {})
    }));
    const ready = components.filter((c) => c.status === "ready").length;
    return { ...install, components, updateAvailable: false,
      status: !install.enabled || (components.length > 0 && components.every((c) => c.status === "disabled")) ? "disabled" : ready === components.length ? "ready"
        : ready ? "partially_ready" : components.some((c) => c.status === "configuration_required") ? "configuration_required"
          : components.some((c) => c.status === "connection_required") ? "connection_required"
          : components.some((c) => c.status === "validation_required") ? "validation_required" : "host_required",
      ...(release?.status === "withdrawn" ? { notice: "此版本已撤回，请选择其他版本或卸载" } : {}) };
  }

  async install(userId, listingId, input = {}) {
    const defaultConfig = this.defaultExecutionConfig ? await this.defaultExecutionConfig(userId) : null;
    return this.transaction(userId, input.expectedRevision, async (state, client) => {
      const releases = await this.releases(client, userId);
      const wanted = releases.find((release) => release.id === listingId
        && release.version === input.version && ["published", "private"].includes(release.status));
      if (!wanted) fail(404, "release_unavailable", "所选版本不可安装");
      if (input.digest !== wanted.digest) fail(409, "digest_mismatch", "内容摘要不匹配，请重新检查版本");
      const previous = state.installations[listingId];
      // Repeated add preserves the account's disabled/configuration state.
      if (previous?.version === wanted.version) return { installation: this.installationStatus(previous, wanted) };
      if (previous?.workspace && input.discardWorkspace !== true) fail(409, "installation_workspace_exists",
        "此安装已有个人文件，请明确选择切换来源版本；旧文件会保留，不会被覆盖");
      const install = { listingId, version: wanted.version, digest: wanted.digest,
        enabled: previous?.enabled ?? true, disabledComponents: previous?.disabledComponents || [],
        ...(previous?.config ? { config: previous.config }
          : defaultConfig ? { config: normalizeExtensionConfig(defaultConfig) } : {}),
        instanceId: randomUUID(),
        ...((previous?.workspace || previous?.archivedWorkspaces) ? {
          archivedWorkspaces: [...(previous.workspace ? [previous.workspace] : []), ...(previous.archivedWorkspaces || [])].slice(0, 8)
        } : {}),
        executionEpoch: randomUUID(),
        installedAt: previous?.installedAt || Date.now(), updatedAt: Date.now() };
      state.installations[listingId] = install;
      state.events.push({ action: previous ? "version_changed" : "installed", listingId, version: wanted.version, at: Date.now() });
      return { installation: this.installationStatus(install, wanted) };
    });
  }

  async change(userId, listingId, input, remove = false) {
    if (!Number.isInteger(input.expectedRevision)) fail(428, "revision_required", "请提供当前账户版本");
    return this.transaction(userId, input.expectedRevision, async (state, client) => {
      const current = state.installations[listingId];
      if (!current) fail(404, "installation_not_found", "账户尚未添加此扩展");
      if (remove) {
        delete state.installations[listingId];
        state.events.push({ action: "uninstalled", listingId, at: Date.now() });
        return { removed: true };
      }
      if (typeof input.enabled !== "boolean") fail(422, "invalid_installation", "enabled 需为布尔值");
      current.enabled = input.enabled;
      current.executionEpoch = randomUUID();
      delete current.validation;
      current.updatedAt = Date.now();
      state.events.push({ action: input.enabled ? "enabled" : "disabled", listingId, at: Date.now() });
      const release = current.activeRevision?.release || (await this.releases(client, userId)).find((r) => r.id === listingId && r.version === current.version);
      return { installation: this.installationStatus(current, release) };
    });
  }

  async skillsFor(context) {
    const userId = userIdOf(context);
    if (!userId) return { catalog: [], enabled: [] };
    const [account, releases] = await Promise.all([this.account(userId), this.releases(this.pool, userId)]);
    const catalog = [], enabled = [];
    for (const install of Object.values(account.installations)) {
      const metadata = install.activeRevision?.release || releases.find((r) => r.id === install.listingId && r.version === install.version);
      const release = metadata?.components?.some((c) => c.kind === "skill")
        ? await readReleaseContent(metadata, this.artifactStore) : metadata;
      for (const component of release?.components || []) {
        if (component.kind !== "skill") continue;
        const id = `marketplace:${release.id}/${component.id}`;
        catalog.push({ id, name: `${release.name} · ${component.name}`,
          description: component.description, category: release.category,
          body: component.body, contentHash: digest([component, metadata.contentRef.digest]), runtimeCached: true,
          source: "marketplace", pluginId: release.id, sourceNodeId: "runtime:marketplace",
          sourceNodeLabel: "账户扩展市场",
          sourcePath: install.workspace ? install.workspace.directory
            + (release.artifact?.kind === "skill" ? "" : `/skills/${component.id}`) : "", sourceFile: release.artifact?.kind === "skill"
            ? "SKILL.md" : `skills/${component.id}/SKILL.md`,
          files: release.artifact?.kind === "skill" ? Object.keys(release.artifact.files || {})
            : Object.keys(release.installationAssets || {}).filter((path) => path.startsWith(`skills/${component.id}/`)
              && !path.endsWith("/SKILL.md")).map((path) => path.slice(`skills/${component.id}/`.length)) });
        if (install.enabled && !install.disabledComponents?.includes(component.id)) enabled.push(id);
      }
    }
    return { catalog, enabled };
  }

  async selectSkills(userId, updates) {
    const selected = updates.filter((update) => String(update?.id || "").startsWith("marketplace:"));
    if (!selected.length) return;
    return this.transaction(userId, undefined, async (state, client) => {
      const releases = await this.releases(client, userId);
      for (const update of selected) {
        for (const install of Object.values(state.installations)) {
          const release = releases.find((r) => r.id === install.listingId && r.version === install.version);
          for (const component of release?.components || []) {
            if (`marketplace:${release.id}/${component.id}` !== update.id || component.kind !== "skill") continue;
            const disabled = new Set(install.disabledComponents || []);
            if (update.enabled) disabled.delete(component.id); else disabled.add(component.id);
            install.disabledComponents = [...disabled];
          }
        }
      }
      return {};
    });
  }

  async skillFileFor(context, id, path, expectedHash) {
    const userId = userIdOf(context);
    const catalog = await this.skillsFor(context);
    const skill = catalog.catalog.find((s) => s.id === id);
    if (!skill) fail(404, "skill_not_found", "技能未安装");
    if (expectedHash && skill.contentHash !== expectedHash) fail(409, "extension_changed", "技能内容已改变，请重新读取");
    safeExtensionPath(path);
    if (!skill.files?.includes(path)) fail(404, "skill_file_not_found", "此文件不在技能包中");
    const { release } = await this.installationFor(userId, skill.pluginId);
    const loaded = await readReleaseContent(release, this.artifactStore);
    const componentId = id.slice(`marketplace:${skill.pluginId}/`.length);
    const content = loaded.artifact?.kind === "skill" ? loaded.artifact.files?.[path]
      : loaded.installationAssets?.[`skills/${componentId}/${path}`];
    if (typeof content !== "string") fail(404, "skill_file_not_found", "技能文件不存在");
    const latest = (await this.skillsFor(context)).catalog.find((s) => s.id === id);
    if (latest?.contentHash !== skill.contentHash) fail(409, "extension_changed", "读取期间技能已改变");
    return { path, content, contentHash: skill.contentHash };
  }

  async uploadPrivate(userId, userName, input) {
    if (!Number.isInteger(input.expectedRevision)) fail(428, "revision_required", "请提供当前账户版本");
    const artifact = normalizeExtensionPackage(input.artifact);
    if (!input.artifact?.digest) fail(422, "artifact_digest_required", "请先 pack 再上传包含摘要的制品");
    const fullManifest = privateExtensionRelease(artifact, userId, userName);
    const manifest = await storeReleaseContent(fullManifest, this.artifactStore, artifact);
    return this.transaction(userId, input.expectedRevision, async (state, client) => {
      const previous = (await client.query(`SELECT artifact_digest FROM marketplace_private_releases
        WHERE user_id=$1 AND listing_id=$2 AND version=$3`, [userId, manifest.id, manifest.version])).rows[0];
      if (previous && previous.artifact_digest !== artifact.digest) {
        fail(409, "release_immutable", "此私有版本内容已固定，请使用新版本号");
      }
      if (!previous) {
        const count = (await client.query("SELECT count(*)::int AS count FROM marketplace_private_releases WHERE user_id=$1", [userId])).rows[0].count;
        if (count >= 100) fail(422, "private_release_limit", "最多保存 100 个私有版本");
        await client.query(`INSERT INTO marketplace_private_releases
          (user_id,listing_id,version,digest,artifact_digest,manifest_json,published_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [userId, manifest.id, manifest.version, digest(fullManifest), artifact.digest, manifest, Date.now()]);
        state.events.push({ action: "private_uploaded", listingId: manifest.id, version: manifest.version, at: Date.now() });
      }
      const release = (await this.releases(client, userId)).find((r) => r.id === manifest.id && r.version === manifest.version);
      return { release, reused: Boolean(previous) };
    });
  }

  async configure(userId, listingId, input) {
    if (!Number.isInteger(input.expectedRevision)) fail(428, "revision_required", "请提供当前账户版本");
    const config = normalizeExtensionConfig(input.config);
    return this.transaction(userId, input.expectedRevision, async (state, client) => {
      const install = state.installations[listingId];
      if (!install) fail(404, "installation_not_found", "请先安装扩展");
      const release = install.activeRevision?.release || (await this.releases(client, userId)).find((r) => r.id === listingId && r.version === install.version);
      if (!release?.artifact || release.kind === "skill") fail(422, "execution_host_unsupported", "此扩展不包含可执行制品");
      const errors = validateExtensionSettings(config, release);
      if (errors.length) fail(422, "invalid_extension_settings", errors.join("; "));
      if (install.workspace && (config.nodeId !== install.config?.nodeId || config.workspaceRoot !== install.config?.workspaceRoot)) {
        fail(409, "installation_workspace_bound", "已有个人文件，不能重新绑定目录或设备；请先切换来源版本建立新副本");
      }
      install.config = { ...config, ...(release.artifact.plugin?.settingsSchema ? { settings: extensionSettingsFor(config, release) } : {}) };
      install.executionEpoch = randomUUID();
      delete install.validation;
      install.updatedAt = Date.now();
      state.events.push({ action: "configured", listingId, at: Date.now() });
      return { installation: this.installationStatus(install, release) };
    });
  }

  async assertExecution(userId, listingId, expectedEpoch) {
    if (!userId) fail(401, "authentication_required", "请先登录账户");
    const account = await this.account(userId);
    const install = account.installations[listingId];
    if (!install?.enabled) fail(403, "extension_disabled", "扩展未安装或已停用");
    if (expectedEpoch && expectedEpoch !== install.executionEpoch) fail(409, "extension_changed", "扩展版本或配置已改变，请重新验证");
    const source = (await this.releases(this.pool, userId)).find((r) =>
      r.id === listingId && r.version === install.version && r.digest === install.digest);
    const release = source && ["published", "private"].includes(source.status) ? install.activeRevision?.release || source : source;
    if (!release?.artifact || !["published", "private"].includes(release.status)) fail(422, "execution_host_unsupported", "此版本不包含可执行制品");
    if (!install.config) fail(422, "configuration_required", "请配置授权 Node 和工作目录");
    if (validateExtensionSettings(install.config, release).length) fail(422, "configuration_required", "请完成插件设置");
    if (release.artifact.plugin?.connection?.required && !install.config.credentialsFile) {
      fail(422, "connection_required", "请连接插件所需的服务");
    }
    const effectiveInstall = { ...install, config: { ...install.config,
      ...(release.artifact.plugin?.settingsSchema ? { settings: extensionSettingsFor(install.config, release) } : {}) } };
    return { install: effectiveInstall, release, configDigest: hashExtension(effectiveInstall.config), artifactDigest: release.artifactDigest };
  }

  async executionFor(userId, listingId, expectedEpoch) {
    const { install, release, configDigest } = await this.assertExecution(userId, listingId, expectedEpoch);
    const loaded = await readReleaseContent(release, this.artifactStore);
    const artifact = normalizeExtensionPackage(loaded.artifact);
    if (artifact.digest !== release.artifactDigest) fail(409, "digest_mismatch", "已安装制品摘要不匹配");
    return { install, artifact, configDigest };
  }

  async installationFor(userId, listingId, expectedEpoch) {
    if (!userId) fail(401, "authentication_required", "请先登录账户");
    const install = (await this.account(userId)).installations[listingId];
    if (!install) fail(404, "installation_not_found", "账户尚未安装此扩展");
    if (expectedEpoch && install.executionEpoch !== expectedEpoch) fail(409, "extension_changed", "安装已发生变化，请刷新后重试");
    const source = await this.releaseFor(userId, listingId, install.version);
    if (source.digest !== install.digest) fail(409, "digest_mismatch", "来源摘要已改变");
    return { install, source, release: install.activeRevision?.release || source };
  }

  async prepareInstallation(userId, listingId, epoch) {
    const defaultConfig = this.defaultExecutionConfig ? await this.defaultExecutionConfig(userId) : null;
    return this.transaction(userId, undefined, async (state) => {
      const install = state.installations[listingId];
      if (!install || install.executionEpoch !== epoch) fail(409, "extension_changed", "安装已发生变化");
      if (!install.config && defaultConfig) install.config = normalizeExtensionConfig(defaultConfig);
      if (!install.config) fail(422, "configuration_required", "账户需要先开通沙箱或配置授权设备");
      install.instanceId ||= randomUUID();
      install.workspace ||= { directory: `${install.config.workspaceRoot === "/" ? "" : install.config.workspaceRoot}/.zion/installed/${createHash("sha256")
        .update(userId).digest("hex").slice(0, 16)}/${createHash("sha256").update(listingId).digest("hex").slice(0, 16)}/${install.instanceId}`,
      baseDigest: install.digest, createdAt: Date.now() };
      return { install: clone(install) };
    });
  }

  async activateInstallation(userId, listingId, epoch, files, sourceHash) {
    const { install, source } = await this.installationFor(userId, listingId, epoch);
    const original = await readReleaseContent(source, this.artifactStore);
    const { contentRef, ...modified } = releaseFromInstallationFiles(original, files);
    const release = await storeReleaseContent(modified, this.artifactStore, modified.artifact);
    const next = { digest: release.contentRef.digest, sourceHash, release, activatedAt: Date.now() };
    return this.transaction(userId, undefined, async (state) => {
      const current = state.installations[listingId];
      if (!current || current.executionEpoch !== epoch || current.workspace?.directory !== install.workspace?.directory) fail(409, "extension_changed", "重新加载期间安装已改变");
      current.revisions = [next, ...(current.revisions || []).filter((r) => r.digest !== next.digest)].slice(0, 8);
      current.activeRevision = next;
      current.executionEpoch = randomUUID();
      delete current.validation;
      current.updatedAt = Date.now();
      return { installation: this.installationStatus(current, release) };
    });
  }

  async restoreInstallation(userId, listingId, epoch) {
    return this.transaction(userId, undefined, async (state) => {
      const current = state.installations[listingId];
      if (!current || current.executionEpoch !== epoch) fail(409, "extension_changed", "安装已发生变化");
      delete current.activeRevision;
      current.executionEpoch = randomUUID();
      delete current.validation;
      current.updatedAt = Date.now();
      return { restored: true, epoch: current.executionEpoch };
    });
  }

  async installationRevisionFor(userId, listingId, digest) {
    const { install } = await this.installationFor(userId, listingId);
    const revision = (install.revisions || []).find((r) => r.digest === digest);
    if (!revision) fail(404, "installation_revision_not_found", "个人生效版本不存在");
    return readReleaseContent(revision.release, this.artifactStore);
  }

  async recordValidation(userId, listingId, epoch, tools, description) {
    const handlers = description ? normalizeHostDescription(description).handlers : undefined;
    const catalogDigest = hashExtension([tools, handlers || []]);
    const previous = (await this.account(userId)).installations[listingId];
    if (previous?.enabled && previous.executionEpoch === epoch
      && previous.validation?.catalogDigest === catalogDigest) return { validation: previous.validation };
    return this.transaction(userId, undefined, async (state) => {
      const install = state.installations[listingId];
      if (!install?.enabled || install.executionEpoch !== epoch) fail(409, "extension_changed", "验证期间扩展已改变");
      install.validation = { epoch, tools, ...(handlers ? { handlers } : {}), catalogDigest, at: Date.now() };
      state.events.push({ action: "validated", listingId, at: Date.now() });
      return { validation: install.validation };
    });
  }

  async clearValidation(userId, listingId, epoch) {
    return this.transaction(userId, undefined, async (state) => {
      const install = state.installations[listingId];
      if (install?.executionEpoch === epoch) delete install.validation;
      return {};
    });
  }

  async saveContribution(userId, userName, input) {
    const publisher = { id: `u${createHash("sha256").update(userId).digest("hex").slice(0, 16)}`,
      name: String(userName || "贡献者").slice(0, 100), origin: "community" };
    if (input.artifact && !input.artifact.digest) fail(422, "artifact_digest_required", "请先 pack 再提交包含摘要的制品");
    const fullManifest = input.artifact ? publicExtensionRelease(input.artifact, userId, userName)
      : normalizeContribution(input, publisher);
    const manifest = await storeReleaseContent(fullManifest, this.artifactStore, fullManifest.artifact);
    return this.transaction(userId, input.expectedRevision, async (state) => {
      const id = input.id || randomUUID();
      const previous = state.contributions[id];
      if (input.id && !previous) fail(404, "contribution_not_found", "草稿不存在");
      if (previous && !["draft", "changes_requested"].includes(previous.status)) fail(409, "contribution_locked", "已提交版本不可修改，请新建版本");
      if (!previous && Object.keys(state.contributions).length >= 100) fail(422, "contribution_limit", "最多保存 100 份贡献");
      const contribution = { id, manifest, status: "draft", updatedAt: Date.now(),
        createdAt: previous?.createdAt || Date.now() };
      state.contributions[id] = contribution;
      state.events.push({ action: "draft_saved", contributionId: id, at: Date.now() });
      return { contribution: { ...contribution, manifest: fullManifest } };
    });
  }

  async submit(userId, id, input) {
    return this.transaction(userId, input.expectedRevision, async (state, client) => {
      const contribution = state.contributions[id];
      if (!contribution) fail(404, "contribution_not_found", "草稿不存在");
      if (!["draft", "changes_requested"].includes(contribution.status)) fail(409, "contribution_locked", "此版本已经提交");
      const { manifest } = contribution;
      if ((await this.releases(client)).some((r) => r.id === manifest.id && r.version === manifest.version)) {
        fail(409, "release_immutable", "此版本已发布，请使用新版本号");
      }
      contribution.status = "submitted";
      const { contentRef, ...fullManifest } = await readReleaseContent(manifest, this.artifactStore);
      contribution.digest = digest(fullManifest);
      contribution.updatedAt = Date.now();
      state.events.push({ action: "submitted", contributionId: id, at: Date.now() });
      return { contribution };
    });
  }

  async reviewQueue(reviewerId) {
    if (!this.reviewerIds.has(reviewerId)) fail(403, "reviewer_required", "需要市场审核权限");
    const rows = (await this.pool.query("SELECT user_id,state_json FROM marketplace_accounts")).rows;
    return Promise.all(rows.flatMap((row) => Object.values(row.state_json.contributions)
      .filter((c) => c.status === "submitted").map(async (c) => ({
        ...c, manifest: await readReleaseContent(c.manifest, this.artifactStore), userId: row.user_id
      }))));
  }

  async contributionFor(userId, id) {
    const contribution = (await this.account(userId)).contributions[id];
    if (!contribution) fail(404, "contribution_not_found", "草稿不存在");
    return { ...contribution, manifest: await readReleaseContent(contribution.manifest, this.artifactStore) };
  }

  async review(reviewerId, userId, id, input) {
    if (!this.reviewerIds.has(reviewerId)) fail(403, "reviewer_required", "需要市场审核权限");
    if (reviewerId === userId) fail(403, "self_review_forbidden", "不能审核自己的贡献");
    if (!["publish", "changes_requested"].includes(input.decision)) fail(422, "invalid_decision", "请选择发布或退回修改");
    return this.transaction(userId, undefined, async (state, client) => {
      const c = state.contributions[id];
      if (!c || c.status !== "submitted") fail(409, "contribution_not_submitted", "该贡献不在待审核状态");
      if (input.digest !== c.digest) fail(409, "digest_mismatch", "请重新检查提交内容");
      if (input.decision === "publish") {
        const { contentRef, ...fullManifest } = await readReleaseContent(c.manifest, this.artifactStore);
        if (digest(fullManifest) !== c.digest) fail(409, "digest_mismatch", "待审核内容摘要已改变");
        const metadata = await storeReleaseContent(fullManifest, this.artifactStore, fullManifest.artifact);
        await client.query(`INSERT INTO marketplace_releases
          (listing_id,version,digest,manifest_json,published_at) VALUES ($1,$2,$3,$4,$5)`,
        [c.manifest.id, c.manifest.version, c.digest, metadata, Date.now()]);
        c.status = "published";
      } else {
        c.status = "changes_requested";
        c.feedback = String(input.feedback || "请完善技能内容与来源说明").slice(0, 4000);
      }
      c.reviewedBy = reviewerId; c.updatedAt = Date.now();
      state.events.push({ action: c.status, contributionId: id, actorId: reviewerId, at: Date.now() });
      return { contribution: c };
    });
  }
}
