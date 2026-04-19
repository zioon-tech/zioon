/**
 * dev.settings — 保留 manifest 用于向后兼容
 * 设置面板已迁移到核心层 (src/settings/)
 * 此插件只保留 legacy 命令别名
 */
exports.activate = function () {
  // zion.settings.show → 转发到核心层 settings.open
  try {
    window.zion.commands.registerCommand("zion.settings.show", () => {
      window.zion.settings?.open?.();
    });
  } catch {}
};
