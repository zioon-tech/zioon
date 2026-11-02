import { createHash, randomUUID } from "node:crypto";
import { normalizePluginManifest } from "../../../../packages/plugin-sdk/src/manifest.mjs";
import { normalizeExtensionConfig, normalizeExtensionPackage, privateExtensionRelease } from "../../../../packages/runtime-client/src/extension-package.mjs";
import { digest } from "./catalog.mjs";
import { storeReleaseContent } from "./release-content.mjs";

export const emptyDevelopmentRegistry = () => ({ schemaVersion: 1, revision: 0, entries: [] });
const listingId = (userId, pluginId) =>
  `development.u${createHash("sha256").update(userId).digest("hex").slice(0, 16)}.${pluginId}`;

export async function readDevelopmentRegistry(marketplace, userId, legacy) {
  return (await marketplace.account(userId)).development || await legacy() || emptyDevelopmentRegistry();
}

// Object bytes are verified before the transaction. Registry metadata, release
// metadata and the installation switch commit together in PostgreSQL.
export async function saveDevelopmentRegistry(marketplace, userId, next, legacy) {
  const before = await readDevelopmentRegistry(marketplace, userId, legacy);
  const prepared = new Map();
  const changed = new Set();
  for (const record of next.entries) {
    if (!record.build) continue;
    const old = before.entries.find((entry) => entry.pluginId === record.pluginId);
    if (old?.build?.digest === record.build.digest && old.build.generation === record.build.generation
      && (old.backend || old.build.hasRuntime === false)) continue;
    changed.add(record.pluginId);
    const packed = await marketplace.artifactStore.get(record.build.ref);
    const plugin = normalizePluginManifest(packed.manifest);
    record.build.hasRuntime = Boolean(plugin.entries.runtime);
    if (!plugin.entries.runtime) continue;
    const version = `0.0.${record.build.generation}`;
    const artifact = normalizeExtensionPackage({
      schemaVersion: 1, kind: "plugin", manifest: {
        slug: `dev-${createHash("sha256").update(record.pluginId).digest("hex").slice(0, 24)}`,
        name: record.name, summary: `Development: ${record.name}`, version,
        category: "开发", license: "UNLICENSED"
      },
      plugin: { ...plugin, runtime: { apiVersion: plugin.runtimeApiVersion }, version },
      files: packed.files
    });
    const full = { ...privateExtensionRelease(artifact, userId), id: listingId(userId, record.pluginId),
      development: { pluginId: record.pluginId, generation: record.build.generation, buildDigest: record.build.digest } };
    prepared.set(record.pluginId, { full, metadata: await storeReleaseContent(full, marketplace.artifactStore, artifact) });
  }
  const defaultConfig = prepared.size && marketplace.defaultExecutionConfig
    ? await marketplace.defaultExecutionConfig(userId) : null;
  const result = await marketplace.transaction(userId, undefined, async (state, client) => {
    const current = state.development || await legacy() || emptyDevelopmentRegistry();
    if (current.revision !== next.revision - 1) throw Object.assign(new Error("Development registration changed"), {
      statusCode: 409, code: "revision_conflict"
    });
    for (const old of current.entries) {
      if (next.entries.some((r) => r.pluginId === old.pluginId && r.build
        && (!changed.has(r.pluginId) || prepared.has(r.pluginId)))) continue;
      const id = listingId(userId, old.pluginId);
      delete state.installations[id];
      await client.query("DELETE FROM marketplace_development_releases WHERE user_id=$1 AND listing_id=$2", [userId, id]);
    }
    for (const record of next.entries) {
      const release = prepared.get(record.pluginId);
      if (!release) {
        const old = current.entries.find((entry) => entry.pluginId === record.pluginId);
        if (!changed.has(record.pluginId) && old?.backend) record.backend = old.backend;
        else delete record.backend;
        continue;
      }
      const { full, metadata } = release;
      const previous = state.installations[full.id];
      const releaseDigest = digest(full);
      // Development has its own namespace; published/private versions are
      // immutable and are never overwritten by a directory watcher.
      await client.query(`INSERT INTO marketplace_development_releases
        (user_id,listing_id,version,digest,artifact_digest,manifest_json,published_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (user_id,listing_id,version)
        DO UPDATE SET digest=EXCLUDED.digest,artifact_digest=EXCLUDED.artifact_digest,
          manifest_json=EXCLUDED.manifest_json,published_at=EXCLUDED.published_at`,
      [userId, full.id, full.version, releaseDigest, full.artifact.digest, metadata, Date.now()]);
      const install = previous?.digest === releaseDigest ? previous : {
        listingId: full.id, version: full.version, digest: releaseDigest,
        enabled: previous?.enabled ?? true, disabledComponents: previous?.disabledComponents || [],
        config: previous?.config || normalizeExtensionConfig(defaultConfig || {
          nodeId: record.nodeId, workspaceRoot: record.directory
        }),
        executionEpoch: randomUUID(), installedAt: previous?.installedAt || Date.now(), updatedAt: Date.now()
      };
      state.installations[full.id] = install;
      record.backend = { listingId: full.id, epoch: install.executionEpoch, status: "installed" };
      await client.query(`DELETE FROM marketplace_development_releases WHERE user_id=$1 AND listing_id=$2
        AND version NOT IN (SELECT version FROM marketplace_development_releases
          WHERE user_id=$1 AND listing_id=$2 ORDER BY published_at DESC LIMIT 8)`, [userId, full.id]);
    }
    state.development = next;
    return { registry: next };
  });
  return result.registry;
}
