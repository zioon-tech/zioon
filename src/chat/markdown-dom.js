import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

function safeHref(value) {
  const href = String(value || "").trim();
  return /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(href) ? href : "#";
}

function safeImageSrc(value) {
  const src = String(value || "").trim();
  return /^(https?:|data:image\/(?:png|jpe?g|gif|webp);|blob:|app:\/\/|\/|\.\/|\.\.\/)/i.test(src)
    ? src
    : "";
}

function appendChildren(target, children) {
  for (const child of children || []) {
    target.appendChild(renderMarkdownNode(child));
  }
}

function element(tag, children, className = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  appendChildren(node, children);
  return node;
}

function renderTable(node) {
  const wrap = document.createElement("span");
  wrap.className = "zion-pending-markdown-table-wrap";
  const table = document.createElement("table");
  const rows = node.children || [];
  rows.forEach((row, rowIndex) => {
    const section = rowIndex === 0
      ? document.createElement("thead")
      : document.createElement("tbody");
    const tr = document.createElement("tr");
    (row.children || []).forEach((cell, cellIndex) => {
      const td = document.createElement(rowIndex === 0 ? "th" : "td");
      const align = node.align?.[cellIndex];
      if (align) td.style.textAlign = align;
      appendChildren(td, cell.children);
      tr.appendChild(td);
    });
    section.appendChild(tr);
    table.appendChild(section);
  });
  wrap.appendChild(table);
  return wrap;
}

function renderMarkdownNode(node) {
  switch (node?.type) {
    case "root": {
      const fragment = document.createDocumentFragment();
      appendChildren(fragment, node.children);
      return fragment;
    }
    case "text":
      return document.createTextNode(String(node.value || ""));
    case "paragraph":
      return element("span", node.children, "zion-pending-markdown-paragraph");
    case "heading": {
      const level = Math.max(1, Math.min(6, Number(node.depth) || 1));
      return element("span", node.children, `zion-pending-markdown-heading is-h${level}`);
    }
    case "strong":
      return element("strong", node.children);
    case "emphasis":
      return element("em", node.children);
    case "delete":
      return element("del", node.children);
    case "inlineCode": {
      const code = document.createElement("code");
      code.textContent = String(node.value || "");
      return code;
    }
    case "code": {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = String(node.value || "");
      pre.appendChild(code);
      return pre;
    }
    case "blockquote":
      return element("blockquote", node.children);
    case "list":
      return element(node.ordered ? "ol" : "ul", node.children);
    case "listItem": {
      const item = element("li", node.children);
      if (typeof node.checked === "boolean") {
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.disabled = true;
        checkbox.checked = node.checked;
        item.prepend(checkbox);
      }
      return item;
    }
    case "thematicBreak":
      return document.createElement("hr");
    case "break":
      return document.createElement("br");
    case "link": {
      const anchor = element("a", node.children);
      anchor.href = safeHref(node.url);
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
      return anchor;
    }
    case "image": {
      const src = safeImageSrc(node.url);
      if (!src) return document.createTextNode(String(node.alt || node.url || ""));
      const image = document.createElement("img");
      image.src = src;
      image.alt = String(node.alt || "");
      image.loading = "lazy";
      return image;
    }
    case "table":
      return renderTable(node);
    case "html":
      return document.createTextNode(String(node.value || ""));
    default: {
      if (Array.isArray(node?.children)) {
        const fragment = document.createDocumentFragment();
        appendChildren(fragment, node.children);
        return fragment;
      }
      return document.createTextNode(String(node?.value || ""));
    }
  }
}

export function renderMarkdownInto(target, markdown) {
  const tree = fromMarkdown(String(markdown || ""), {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()]
  });
  target.replaceChildren(renderMarkdownNode(tree));
  return target;
}
