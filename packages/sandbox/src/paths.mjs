export function canonicalSandboxPath(path) {
  if (typeof path !== "string" || !path.startsWith("/")
    || path.includes("\0") || path.includes("\\")
    || (path !== "/" && path.slice(1).split("/").some((part) =>
      !part || part === "." || part === ".."))) {
    throw new Error("File path must be a canonical absolute path in the sandbox");
  }
  return path;
}

export function sandboxPathWithinRoots(path, roots = []) {
  canonicalSandboxPath(path);
  return !roots.length || roots.some((root) => {
    canonicalSandboxPath(root);
    return root === "/" || path === root || path.startsWith(`${root}/`);
  });
}
