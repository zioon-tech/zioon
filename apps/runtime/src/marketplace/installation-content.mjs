import { normalizeExtensionPackage, safeExtensionPath, privateExtensionRelease } from "../../../../packages/runtime-client/src/extension-package.mjs";
import { normalizeSkillFiles } from "../../../../packages/runtime-client/src/package-files.mjs";

const fail = (message) => { throw Object.assign(new Error(message), { statusCode: 422, code: "installation_content_invalid" }); };

// Publisher identity/version remain fixed. Only effective account content changes.
export function installationFiles(release) {
  if (release.artifact) {
    const { files = {}, body, digest, ...descriptor } = release.artifact;
    return { ...files, ...(body ? { "SKILL.md": body } : {}),
      "zion-extension.json": JSON.stringify(descriptor, null, 2) };
  }
  return {
    "zion-extension.json": JSON.stringify({ schemaVersion: 1, kind: "bundle",
      name: release.name, summary: release.summary, description: release.description,
      components: release.components.map(({ body, ...component }) => component) }, null, 2),
    ...(release.installationAssets || {}),
    ...Object.fromEntries(release.components.filter((c) => c.kind === "skill")
      .map((c) => [`skills/${safeExtensionPath(c.id)}/SKILL.md`, c.body]))
  };
}

export function releaseFromInstallationFiles(original, files) {
  for (const name of Object.keys(files)) safeExtensionPath(name);
  let descriptor;
  try { descriptor = JSON.parse(files["zion-extension.json"]); } catch { fail("zion-extension.json 必须为有效 JSON"); }
  if (original.artifact) {
    if (descriptor.files !== undefined || descriptor.digest !== undefined || descriptor.body !== undefined) fail("清单不能包含文件内容或摘要");
    const assets = { ...files };
    delete assets["zion-extension.json"];
    const artifact = normalizeExtensionPackage({ ...descriptor, files: assets,
      ...(original.artifact.kind === "skill" ? { body: assets["SKILL.md"] } : {}) });
    if (artifact.kind !== original.artifact.kind || artifact.manifest.slug !== original.artifact.manifest.slug
      || artifact.manifest.version !== original.version
      || artifact.plugin?.id !== original.artifact.plugin?.id) fail("个人修改不能改变扩展身份或来源版本");
    const modified = privateExtensionRelease(artifact, "installation");
    // Keep component IDs stable for Skill selections and installation toggles.
    if (modified.components.length !== original.components.length) fail("扩展组件身份已改变");
    return { ...original, name: modified.name, summary: modified.summary, description: modified.description,
      artifact, components: modified.components.map((c, i) => ({ ...c, id: original.components[i].id })) };
  }
  if (descriptor.schemaVersion !== 1 || descriptor.kind !== "bundle"
    || Object.keys(descriptor).some((k) => !["schemaVersion", "kind", "name", "summary", "description", "components"].includes(k))
    || !Array.isArray(descriptor.components) || descriptor.components.length !== original.components.length) fail("扩展组件清单无效");
  for (const key of ["name", "summary", "description"]) {
    if (typeof descriptor[key] !== "string" || !descriptor[key].trim() || descriptor[key].length > 20000) fail("扩展说明无效");
  }
  const components = descriptor.components.map((c, i) => {
    const source = original.components[i];
    if (c.id !== source.id || c.kind !== source.kind
      || JSON.stringify(Object.keys(c).sort()) !== JSON.stringify(Object.keys(installationFilesDescriptor(source)).sort())) fail("扩展组件身份已改变");
    if (source.kind !== "skill") {
      if (JSON.stringify(c) !== JSON.stringify(installationFilesDescriptor(source))) fail("配方组件不可修改执行定义");
      return source;
    }
    const body = files[`skills/${safeExtensionPath(c.id)}/SKILL.md`];
    if (typeof body !== "string" || !/^---\r?\n[\s\S]*?\n---(?:\n|$)/.test(body)
      || !/^name:\s*\S+/m.test(body) || !/^description:\s*\S+/m.test(body)) fail(`技能 ${c.id} 缺少有效 SKILL.md`);
    if (typeof c.name !== "string" || typeof c.description !== "string" || c.name.length > 300 || c.description.length > 20000) fail("技能说明无效");
    return { ...c, body };
  });
  const assets = { ...files };
  delete assets["zion-extension.json"];
  normalizeSkillFiles(assets);
  return { ...original, name: descriptor.name, summary: descriptor.summary, description: descriptor.description,
    components, installationAssets: assets };
}
function installationFilesDescriptor({ body, ...component }) { return component; }
