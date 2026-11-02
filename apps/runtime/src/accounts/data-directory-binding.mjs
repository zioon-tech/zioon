import {
  mkdirSync,
  realpathSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { accountError } from "./account-policy.mjs";

export function bindRuntimeDataDirectory({
  dataDirectory,
  spaceId,
  paths = []
}) {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const directory = realpathSync(dataDirectory);
  const marker = join(directory, ".zion-space.json");
  const binding = {
    version: 3,
    spaceId,
    storage: "postgresql"
  };
  try {
    writeFileSync(marker, JSON.stringify(binding), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const current = JSON.parse(readFileSync(marker, "utf8"));
    const compatible = current.spaceId === spaceId && (
      (current.version === 3 && current.storage === "postgresql")
      || (current.version === 2 && current.backend === "postgres")
    );
    if (!compatible) {
      throw accountError(
        409,
        "storage_binding_conflict",
        "This data directory is bound to another Runtime"
      );
    }
    if (current.version !== 3) {
      writeFileSync(marker, JSON.stringify(binding), { mode: 0o600 });
    }
  }
  for (const { path, directory: isDirectory = false } of paths) {
    mkdirSync(isDirectory ? path : dirname(path), { recursive: true });
    let canonical;
    try {
      canonical = realpathSync(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      canonical = join(realpathSync(dirname(path)), path.split(/[\\/]/).at(-1));
    }
    const difference = relative(directory, canonical);
    if (difference === ".." || difference.startsWith("../") || isAbsolute(difference)) {
      throw accountError(
        409,
        "storage_outside_space",
        "Account storage must be inside this Runtime's data directory"
      );
    }
  }
  return directory;
}
