import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import postcss from "postcss";

describe("public reader page typography", () => {
  it("keeps inherited text line boxes within a usable header height", () => {
    const tokens = new Map<string, string>();
    postcss.parse(readFileSync("src/styles.css", "utf8")).walkRules(rule => {
      if (rule.selector === ":root") rule.walkDecls(decl => {
        if (decl.prop.startsWith("--")) tokens.set(decl.prop, decl.value);
      });
    });
    const resolve = (value: string): string => value.replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g,
      (_match, name, fallback) => resolve(tokens.get(name) || fallback || ""));
    const page = document.createElement("div");
    page.className = "public-reader"; document.body.appendChild(page);
    postcss.parse(readFileSync("src/public-reader/reader.css", "utf8")).walkRules(rule => {
      if (rule.selector === ".public-reader") rule.walkDecls(decl => {
        if (/^(font(?:-family|-size|-weight)?|line-height)$/.test(decl.prop))
          page.style.setProperty(decl.prop, resolve(decl.value));
      });
    });
    try {
      const style = getComputedStyle(page);
      const lineBox = style.lineHeight.endsWith("px") ? parseFloat(style.lineHeight)
        : parseFloat(style.fontSize) * parseFloat(style.lineHeight);
      expect(Number.isFinite(lineBox)).toBe(true);
      expect(lineBox).toBeGreaterThan(12);
      expect(lineBox).toBeLessThan(32);
    } finally { page.remove(); }
  });
});
