export function normalizeSessionTagExclusionPath(raw) {
  const segments = String(raw || "")
    .replace(/^#/, "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!segments.length) return "";
  const path = segments.join("/");
  return path.length <= 200 ? path : "";
}

export function normalizeSessionTagExclusions(rawExclusions) {
  const seen = new Set();
  const exclusions = [];
  for (const raw of Array.isArray(rawExclusions) ? rawExclusions : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const path = normalizeSessionTagExclusionPath(raw.path);
    if (!path) continue;
    const subtree = raw.subtree === true;
    const key = `${path}\u0000${subtree ? "1" : "0"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    exclusions.push({ path, subtree });
  }
  return exclusions;
}

export function isSessionTagPathExcluded(tagPath, exclusions) {
  const path = normalizeSessionTagExclusionPath(tagPath);
  if (!path) return false;
  return normalizeSessionTagExclusions(exclusions).some((rule) => (
    path === rule.path || (rule.subtree && path.startsWith(`${rule.path}/`))
  ));
}

export function partitionSessionExtractedTags(tags, exclusions) {
  const items = Array.isArray(tags) ? tags : [];
  const rules = normalizeSessionTagExclusions(exclusions);
  const visible = items.filter((item) => (
    !isSessionTagPathExcluded(item?.label, rules)
  ));
  const ignoredRules = rules.map((rule) => {
    const matchedTags = items.filter((item) => {
      const path = normalizeSessionTagExclusionPath(item?.label);
      return path === rule.path || (rule.subtree && path.startsWith(`${rule.path}/`));
    });
    return {
      ...rule,
      matchCount: matchedTags.length,
      matchedTags
    };
  });
  return { visible, ignoredRules };
}
