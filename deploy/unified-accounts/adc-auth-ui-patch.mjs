import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const hash = (text) => createHash("sha256").update(text).digest("hex");

/** Exact production-source patch; refuses a different ADC release before writes. */
export async function adcAuthUiPlan(root, patchUrl = new URL("./adc-auth-ui-patch.json", import.meta.url)) {
  const patch = JSON.parse(await readFile(patchUrl, "utf8"));
  const changes = [];
  for (const file of patch.files) {
    const before = await readFile(join(root, file.path), "utf8");
    if (hash(before) === file.after) continue;
    if (hash(before) !== file.before) throw new Error(`ADC auth source differs: ${file.path}`);
    const points = Array.from(before);
    for (const edit of [...file.edits].reverse()) {
      points.splice(edit.offset, edit.remove, ...Array.from(edit.insert));
    }
    const after = points.join("");
    if (hash(after) !== file.after) throw new Error(`ADC auth patch mismatch: ${file.path}`);
    changes.push({ path: file.path, before, after });
  }
  return changes;
}
