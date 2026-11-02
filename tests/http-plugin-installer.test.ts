import JSZip from "jszip";
import { parse } from "acorn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpPluginInstaller } from "../src/plugin/http-installer";

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
let objectUrlBlobs: Map<string, Blob>;
let objectUrlCounter = 0;

beforeEach(() => {
  objectUrlBlobs = new Map();
  objectUrlCounter = 0;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      const url = `blob:test-plugin-${++objectUrlCounter}`;
      objectUrlBlobs.set(url, blob);
      return url;
    })
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn()
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalCreateObjectURL) {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectURL
    });
  } else {
    delete (URL as any).createObjectURL;
  }
  if (originalRevokeObjectURL) {
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectURL
    });
  } else {
    delete (URL as any).revokeObjectURL;
  }
});

function readBlobText(blob: Blob | undefined): Promise<string> {
  if (!blob) return Promise.resolve("");
  const candidate = blob as Blob & { text?: () => Promise<string> };
  if (typeof candidate.text === "function") return candidate.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to read Blob"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsText(blob);
  });
}

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
    expect((result.plugin?.manifest as any).zion.main).toMatch(/^blob:/);
    expect(result.plugin?.sourceEntries).toEqual({
      workbench: "./main.js"
    });
    expect(result.plugin?.scriptContents).toMatchObject({
      "main.js": "export function activate() {}\n"
    });
  });

  it("rewrites relative JavaScript imports in installed ZIP plugins", async () => {
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify({
      name: "dev.zip-modules",
      version: "1.0.0",
      zion: {
        id: "dev.zip-modules",
        name: "Zip Modules",
        version: "1.0.0",
        main: "./main.js"
      }
    }));
    zip.file(
      "main.js",
      "import { label } from './dashboard-model.js';\nexport function activate() { return label; }\n"
    );
    zip.file("dashboard-model.js", "export const label = 'dashboard';\n");

    const buffer = await zip.generateAsync({ type: "arraybuffer" });
    const installer = new HttpPluginInstaller({ baseUrl: "https://plugins.example" });
    const file = {
      name: "dev.zip-modules.zip",
      arrayBuffer: async () => buffer
    } as File;
    const result = await installer.installFromFile(file);

    expect(result.success).toBe(true);
    const mainUrl = String((result.plugin?.manifest as any).zion.main || "");
    expect(mainUrl).toMatch(/^blob:/);
    const mainCode = await readBlobText(objectUrlBlobs.get(mainUrl));
    const imports = parse(mainCode, { ecmaVersion: "latest", sourceType: "module" }).body
      .filter((node) => node.type === "ImportDeclaration");
    expect(imports.map((node) => node.source.value)).toEqual(["blob:test-plugin-1"]);
    expect(mainCode).not.toContain("from './dashboard-model.js'");
    expect(result.plugin?.sourceEntries).toEqual({
      workbench: "./main.js"
    });
    expect(result.plugin?.scriptContents).toMatchObject({
      "main.js": "import { label } from './dashboard-model.js';\nexport function activate() { return label; }\n",
      "dashboard-model.js": "export const label = 'dashboard';\n"
    });
  });
});
