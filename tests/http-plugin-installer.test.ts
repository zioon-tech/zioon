import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { HttpPluginInstaller } from "../src/plugin/http-installer";

describe("HttpPluginInstaller", () => {
  it("extracts contributed styles from installed ZIP plugins", async () => {
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify({
      name: "dev.zip-style",
      version: "1.0.0",
      zion: {
        id: "dev.zip-style",
        name: "Zip Style",
        version: "1.0.0",
        main: "./main.js",
        contributes: {
          styles: ["./styles.css"]
        }
      }
    }));
    zip.file("main.js", "export function activate() {}\n");
    zip.file("styles.css", ".zip-style { color: red; }\n");

    const buffer = await zip.generateAsync({ type: "arraybuffer" });
    const installer = new HttpPluginInstaller({ baseUrl: "https://plugins.example" });
    const file = {
      name: "dev.zip-style.zip",
      arrayBuffer: async () => buffer
    } as File;
    const result = await installer.installFromFile(file);

    expect(result.success).toBe(true);
    expect(result.plugin?.styleContents).toEqual({
      "styles.css": ".zip-style { color: red; }\n"
    });
    expect((result.plugin?.manifest as any).zion.main).toMatch(/^data:text\/javascript;base64,/);
  });
});
