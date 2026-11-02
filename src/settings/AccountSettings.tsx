import { AccountPanel } from "../../packages/account-ui/src/AccountPanel";
import { currentAccountSession } from "../../packages/account-ui/src/client";
import { readWorkbenchRuntimeConfig } from "../runtime/workbench-runtime-config";

export const ACCOUNT_SETTINGS_PAGE_ID = "general.account";

export function registerAccountSettings() {
  if (!currentAccountSession()) return null;
  const config = readWorkbenchRuntimeConfig({
    state: (window as any).zion?.state,
    storage: globalThis.localStorage
  });
  return (window as any).zion?.settings?.registerPage?.({
    id: ACCOUNT_SETTINGS_PAGE_ID,
    title: "账号",
    description: "身份、成员与任务授权",
    category: "general",
    order: -100,
    keywords: ["account", "profile", "member", "grant", "账号", "成员", "授权"],
    sections: [{
      id: "general.account.manage",
      title: "账号",
      settings: [{
        id: "account.manager",
        label: "账号管理",
        kind: "custom",
        renderCustom: () => (
          <AccountPanel baseUrl={config.baseUrl} variant="workbench" />
        )
      }]
    }]
  });
}
