import { createRoot } from "react-dom/client";
import { SettingCard } from "../settings/SettingsShell";
import { createEditorAppearancePage } from "../settings/editor-appearance";

/** Uses the actual Workbench setting controls and contribution definitions. */
export function mountEditorAppearanceControls(panel: HTMLElement, cleanup: Array<() => void>) {
  const host = document.createElement("section"); host.className = "zion-settings-content";
  panel.appendChild(host);
  const root = createRoot(host);
  const page = createEditorAppearancePage();
  root.render(<div>{page.sections.map(section =>
      <section key={section.id}><h3>{section.title}</h3>
        {section.settings.map(setting => <SettingCard key={setting.id} setting={setting} />)}
      </section>)}</div>);
  cleanup.push(() => { root.unmount(); host.remove(); });
}
