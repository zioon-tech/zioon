// Immutable catalog metadata and separately stored content share the original
// release digest, so migrating bytes does not invalidate existing installations.
export async function storeReleaseContent(release, store, artifact) {
  if (release.contentRef) return release;
  const sourceArtifact = artifact || release.artifact;
  const content = { schemaVersion: 1,
    ...(sourceArtifact ? { artifact: sourceArtifact } : {}),
    components: (release.components || []).map((component) => ({ ...component })),
    ...(release.installationAssets ? { installationAssets: release.installationAssets } : {}) };
  const metadata = { ...release };
  delete metadata.installationAssets;
  if (sourceArtifact) {
    const { files, body, ...descriptor } = sourceArtifact;
    metadata.artifact = descriptor;
    metadata.artifactDigest = sourceArtifact.digest;
  }
  metadata.components = content.components.map(({ body, ...descriptor }) => descriptor);
  metadata.contentRef = await store.put(content);
  return metadata;
}

export async function readReleaseContent(release, store) {
  if (!release.contentRef) throw Object.assign(new Error("Release content has not been migrated"), {
    code: "artifact_migration_required", statusCode: 503
  });
  const content = await store.get(release.contentRef);
  if (content?.schemaVersion !== 1 || !Array.isArray(content.components)) {
    throw Object.assign(new Error("Invalid release content"), { code: "artifact_integrity_error", statusCode: 409 });
  }
  return { ...release, components: content.components, ...(content.artifact ? { artifact: content.artifact } : {}),
    ...(content.installationAssets ? { installationAssets: content.installationAssets } : {}) };
}
