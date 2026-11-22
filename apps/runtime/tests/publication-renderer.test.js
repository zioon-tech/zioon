import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { renderPublication } from "../src/spaces/publication-renderer.mjs";

const publication = (markdown) => ({ id: "publication", title: "公开的中文文档", revision: 3, markdown });
describe("immutable publication rendering", () => {
  it("renders real Markdown blocks, lists, code and Chinese tables", () => {
    const dom = new JSDOM(renderPublication(publication(
      "## 标题\n\n**重点** 和 `code`\n\n- 一\n- 二\n\n| 项目 | 状态 |\n| --- | --- |\n| 模型 | 可用 |\n\n```js\nconsole.log('hi')\n```"
    )));
    const doc = dom.window.document;
    expect(doc.querySelector("article h2")?.textContent).toBe("标题");
    expect(doc.querySelector("strong")?.textContent).toBe("重点");
    expect(doc.querySelectorAll("li")).toHaveLength(2);
    expect(doc.querySelector("tbody td")?.textContent).toBe("模型");
    expect(doc.querySelector("pre code")?.textContent).toContain("console.log");
  });
  it("makes embedded HTML and executable links inert", () => {
    const dom = new JSDOM(renderPublication(publication(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[点击](javascript:alert%281%29)\n\n[安全](https://example.test/path)'
    )));
    const doc = dom.window.document;
    expect(doc.querySelectorAll("script,[onerror],iframe")).toHaveLength(0);
    expect(doc.querySelectorAll("article a")).toHaveLength(1);
    expect(doc.querySelector("article a").getAttribute("href")).toBe("https://example.test/path");
    expect(doc.querySelector("article").textContent).toContain("<script>");
  });
  it("displays only copied images belonging to the current publication", () => {
    const dom = new JSDOM(renderPublication(publication(
      "![批准的图片](/p/publication/assets/copy)\n\n![外部图片](https://tracker.test/pixel)\n\n![别的发布](/p/other/assets/copy)\n\n![私人](/v1/assets/private/content)"
    )));
    const images = dom.window.document.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute("src")).toBe("/p/publication/assets/copy");
    expect(dom.window.document.body.textContent).toContain("外部图片");
  });
});
