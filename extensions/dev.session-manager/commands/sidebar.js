export function registerSessionSidebarCommands(opts) {
  const zion = opts?.zion || window.zion;

  const dShowSidebar = zion.commands.registerCommand("zion.sessions.showSidebar", () => {
    try {
      zion.sideBar.show();
      zion.sideBar.activateView("sessions.list");
      try {
        const active = zion?.state?.get("ui.activityBar.activeItemId");
        if (active !== "sessions.activity") {
          zion.activityBar.activateItem("sessions.activity");
        }
      } catch {}
    } catch {}
    return true;
  });
  const dHideSidebar = zion.commands.registerCommand("zion.sessions.hideSidebar", () => {
    try {
      zion.sideBar.hide();
    } catch {}
    return true;
  });
  const dToggleSidebar = zion.commands.registerCommand("zion.sessions.toggleSidebar", () => {
    try {
      const next = zion.sideBar.toggle();
      if (next) {
        zion.sideBar.activateView("sessions.list");
        try {
          const active = zion?.state?.get("ui.activityBar.activeItemId");
          if (active !== "sessions.activity") {
            zion.activityBar.activateItem("sessions.activity");
          }
        } catch {}
      }
      return next;
    } catch {
      return false;
    }
  });

  return [dShowSidebar, dHideSidebar, dToggleSidebar];
}

