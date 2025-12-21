/**
 * Post-build copy script for Vercel/Vite:
 * Copy the entire "extensions" directory into "dist/extensions" so
 * production can load built-in extensions via dynamic import paths like
 * "/extensions/<ext>/main.js".
 *
 * Node: v18.x, using fs.cp (recursive) is supported.
 */
import { cp, access, mkdir } from "fs/promises";
import { constants } from "fs";
import { dirname, resolve, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  try {
    const projectRoot = resolve(__dirname, "..");
    const srcDir = join(projectRoot, "extensions");
    const distDir = join(projectRoot, "dist");
    const destDir = join(distDir, "extensions");

    const hasDist = await exists(distDir);
    if (!hasDist) {
      console.warn("[copy-extensions] dist/ not found. Did build succeed?");
      return;
    }

    const hasSrc = await exists(srcDir);
    if (!hasSrc) {
      console.warn("[copy-extensions] extensions/ not found. Skipping copy.");
      return;
    }

    // Ensure destination parent exists
    if (!(await exists(destDir))) {
      try {
        await mkdir(destDir, { recursive: true });
      } catch {}
    }

    // Copy recursively and overwrite existing files
    await cp(srcDir, destDir, { recursive: true, force: true });

    console.log("[copy-extensions] Copied extensions -> dist/extensions");
  } catch (err) {
    console.error("[copy-extensions] Copy failed:", err);
    // Do not throw to avoid breaking build on Vercel; warn instead.
  }
}

main();