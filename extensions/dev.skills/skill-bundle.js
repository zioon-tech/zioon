export const SKILL_BUNDLE_LIMITS = Object.freeze({
  files: 128, bytes: 8 * 1024 * 1024,
  documentBytes: 4 * 1024 * 1024, auxiliaryBytes: 512 * 1024
});

// Code-point ordering is identical in browsers and every Node locale.
export function canonicalSkillBundle(files) {
  return JSON.stringify(Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  ));
}

export function validSkillBundlePath(path) {
  return typeof path === "string" && path.length <= 240
    && !path.includes("\\") && !path.includes("\0")
    && !/^[A-Za-z]:/.test(path)
    && !path.split("/").some((part) => !part || part === "." || part === "..");
}
