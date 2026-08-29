export function registerSessionFlushCommand(opts) {
  const zion = opts?.zion || window.zion;
  const plugin = opts?.plugin;
  const flushRemote = opts?.flushRemote;
  return zion.commands.registerCommand("zion.sessions.flushPendingSave", async (id) => {
    try {
      let saved = false;
      if (typeof plugin?.flushDurably === "function") {
        saved = !!(await plugin.flushDurably(id));
      } else {
        saved = !!plugin?.flush?.(id);
      }
      if (typeof flushRemote === "function") {
        const durable = await flushRemote();
        if (durable === false) return false;
      }
      return saved;
    } catch {
      return false;
    }
  });
}
