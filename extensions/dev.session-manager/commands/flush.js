export function registerSessionFlushCommand(opts) {
  const zion = opts?.zion || window.zion;
  const plugin = opts?.plugin;
  return zion.commands.registerCommand("zion.sessions.flushPendingSave", (id) => {
    try {
      return !!plugin?.flush?.(id);
    } catch {
      return false;
    }
  });
}

