import DOMPurify from "dompurify";

export function safeMarkdownHref(source: string): string | null {
  const href = String(source || "").trim();
  if (!href || /[\u0000-\u0020\u007f]/.test(href)) return null;
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (!/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith("\\")) return href;
  return null;
}

/** SVGs may draw locally, but cannot execute actions or load external resources. */
export function sanitizePublicSvg(source: string): SVGElement | null {
  const cleaned = DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject", "a", "image", "use", "animate", "animateMotion", "animateTransform", "set"],
    FORBID_ATTR: ["href", "xlink:href"]
  });
  const doc = new DOMParser().parseFromString(cleaned, "image/svg+xml");
  if (doc.documentElement.localName !== "svg" || doc.querySelector("parsererror")) return null;
  const unsafeCss = (value: string) => /@import|expression\s*\(|javascript:|\\/i.test(value) ||
    Array.from(value.matchAll(/url\s*\(([^)]*)\)/gi)).some(match =>
      !/^#[\w:.-]+$/.test(match[1].trim().replace(/^(['"])(.*)\1$/, "$2")));
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    if (el.localName === "style" && unsafeCss(el.textContent || "")) { el.remove(); continue; }
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name) || unsafeCss(attr.value)) el.removeAttribute(attr.name);
    }
  }
  return document.importNode(doc.documentElement, true) as unknown as SVGElement;
}
