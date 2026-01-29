import { loadServiceBaseUrlConfig } from "../../src/settings/serviceBaseUrl";
import { mountSettingsViewInto } from "./ui.js";

export async function activate(ctx) {
  try {
    const dispCmd = window.zion.commands.registerCommand("zion.settings.show", () => {
      try {
        window.zion.activityBar.activateItem("settings.activity");
      } catch {}
    });
    ctx.subscriptions.push(dispCmd);
  } catch {}

  try {
    const dispItem = window.zion.activityBar.registerItem({
      id: "settings.activity",
      pluginId: "dev.settings",
      icon: "⚙️",
      tooltip: "Settings",
      sideBarViewId: "settings.baseUrl",
      order: 30
    });
    const dispView = window.zion.sideBar.registerView({
      id: "settings.baseUrl",
      pluginId: "dev.settings",
      title: "Settings",
      icon: "⚙️",
      order: 30,
      location: "sidebar",
      headerActions: [
        {
          id: "settings.refresh",
          title: "Refresh",
          ariaLabel: "Refresh",
          icon: "↻",
          onClick: () => {
            try {
              window.zion?.state?.set?.("settings.serviceBaseUrl", loadServiceBaseUrlConfig());
            } catch {}
          }
        }
      ],
      component: {
        render: (container) => mountSettingsViewInto(container)
      }
    });
    ctx.subscriptions.push(dispItem, dispView);
  } catch {}
}
