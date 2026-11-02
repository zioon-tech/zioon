export function safePackagePath(value) {
  if (typeof value !== "string" || value.length > 240 || !/^[a-zA-Z0-9_.\/-]+$/.test(value)
    || value.split("/").some((part) => !part || part === "." || part === ".."
      || ["node_modules", ".git"].includes(part)
      || /^(?:\.env|credentials|secrets)(?:\.|$)/i.test(part))) {
    throw Object.assign(new Error("Unsafe extension file path"), { statusCode: 422, code: "invalid_extension_package" });
  }
  return value;
}

export function normalizeSkillFiles(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 64) {
    throw Object.assign(new Error("At most 64 Skill text files are supported"), { statusCode: 422, code: "invalid_skill_package" });
  }
  const files = {};
  for (const name of Object.keys(input).sort()) {
    safePackagePath(name);
    if (!/\.(md|txt|json|ya?ml|py|sh|js|mjs|cjs|ts|css|html)$/.test(name)
      || typeof input[name] !== "string" || input[name].includes("\0")) {
      throw Object.assign(new Error("Skill assets must be UTF-8 text or scripts"), { statusCode: 422, code: "invalid_skill_package" });
    }
    files[name] = input[name].replace(/\r\n/g, "\n");
  }
  if (Buffer.byteLength(JSON.stringify(files)) > 200000) {
    throw Object.assign(new Error("Skill files exceed 200KB"), { statusCode: 422, code: "invalid_skill_package" });
  }
  return files;
}
