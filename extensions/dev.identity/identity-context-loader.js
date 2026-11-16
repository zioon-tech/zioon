import { createHash } from "node:crypto";
import { buildBiographyDigest, buildIdentityContext, parseBiographyEventsJsonl } from "./identity-core.js";
import { identityInitialFiles } from "./identity-files.js";
import { createIdentitySnapshot, IDENTITY_PROFILE_FILE_PATHS, IDENTITY_BIOGRAPHY_EVENTS_FILE_PATH } from "./identity-runtime-shared.js";

const hash = text => createHash("sha256").update(String(text || "")).digest("hex");
const marker = /\n?<!-- zion-biography-source:([a-f0-9]{64}) -->\s*$/;
export const biographyDigestSource = text => String(text || "").match(marker)?.[1] || "";
export const stampBiographyDigest = (digest, eventsText) =>
  `${String(digest).replace(marker, "").trimEnd()}\n<!-- zion-biography-source:${hash(eventsText)} -->\n`;

export async function loadIdentityProjection({ fileService, sourceRoot, runContext, location, previous = {} }) {
  const paths = location
    ? { ...IDENTITY_PROFILE_FILE_PATHS, events: IDENTITY_BIOGRAPHY_EVENTS_FILE_PATH }
    : IDENTITY_PROFILE_FILE_PATHS;
  let loaded = await fileService.readTextFiles({
    fileRoot: sourceRoot, files: paths, runContext,
    knownHashes: previous.sourceHashes || {}, metadataOnly: location ? ["events"] : [], includeHashes: true
  });
  let files = { ...previous.files, ...loaded.files };
  let hashes = loaded.hashes || Object.fromEntries(Object.entries(loaded.files).map(([key, value]) => [
    key, loaded.missing?.includes(key) ? null : hash(value)
  ]));
  let digestSource = Object.hasOwn(loaded.files, "biography")
    ? biographyDigestSource(files.biography) : previous.digestSource || "";
  if (location) {
    const validDigest = digestSource && digestSource === hashes.events;
    if (!validDigest && !Object.hasOwn(loaded.files, "events")) {
      // Capture another complete view, including changed profiles, rather than
      // mixing a newer event log with an older profile/digest read.
      loaded = await fileService.readTextFiles({
        fileRoot: sourceRoot, files: paths, runContext,
        knownHashes: Object.fromEntries(Object.entries(hashes).filter(([key]) => key !== "events")),
        includeHashes: true
      });
      files = { ...files, ...loaded.files };
      hashes = loaded.hashes;
    }
    if (!validDigest) {
      files.biography = buildBiographyDigest(parseBiographyEventsJsonl(files.events));
      digestSource = hashes.events || hash("");
    } else files.biography = String(files.biography || "").replace(marker, "").trimEnd();
    delete files.events;
    // Provisioning remains explicit. Defaults are used only for absent files;
    // a deliberately empty profile stays empty and reads never create files.
    for (const [key, spec] of Object.entries(identityInitialFiles())) {
      if (key !== "biography" && Object.hasOwn(paths, key) && hashes[key] === null) files[key] = spec.content;
    }
  }
  if (previous.content && Object.keys(hashes).length === Object.keys(previous.sourceHashes || {}).length
    && Object.entries(hashes).every(([key, value]) => previous.sourceHashes?.[key] === value)) return previous;
  return createIdentitySnapshot({
    sourceRoot: loaded.fileRoot, files, sourceHashes: hashes, digestSource,
    content: buildIdentityContext(files, {
      sourceRoot: loaded.fileRoot,
      accessMode: location?.backend === "agent-fs"
        ? location.accessMode === "cli" ? "cli" : "runtime-tools" : "file-service"
    })
  });
}
