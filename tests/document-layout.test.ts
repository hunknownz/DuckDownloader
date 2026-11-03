import { describe, expect, it } from "vitest";
import { parseDocumentContent } from "../src/adapters/document/parse.js";
import { renderDocument } from "../src/adapters/document/render.js";

describe("source-independent document structure and layout", () => {
  it("preserves block order, inline emphasis, nested lists, captions and table spans", () => {
    const parsed = parseDocumentContent({
      title: "Article",
      sourceUrl: "https://example.test/article",
      html: '<section style="font-size:99px" onclick="bad()"><h2>First</h2><p>Text <strong>bold</strong> <a href="https://example.test/more">link</a></p><ol start="3"><li>One<ul><li>Nested</li></ul></li><li>Two</li></ol><figure><img src="picture.png" alt="Chart"><figcaption>Figure one</figcaption></figure><table><tr><th colspan="2">Header</th></tr><tr><td>A</td><td>B</td></tr></table><pre><code>line 1\n  line 2</code></pre><script>secret()</script></section>',
    });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.document.blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "list",
      "image",
      "table",
      "code",
    ]);
    const list = parsed.document.blocks[2];
    expect(list).toMatchObject({ type: "list", ordered: true, start: 3 });
    if (list?.type === "list")
      expect(list.items[0]?.some((block) => block.type === "list")).toBe(true);
    expect(parsed.document.blocks[3]).toMatchObject({
      type: "image",
      reference: "picture.png",
      caption: [{ type: "text", text: "Figure one" }],
    });
    const table = parsed.document.blocks[4];
    if (table?.type === "table") expect(table.rows[0]?.[0]?.colSpan).toBe(2);
    expect(parsed.document.blocks[5]).toEqual({ type: "code", text: "line 1\n  line 2" });
    const output = renderDocument(parsed.document, new Map([["picture.png", "assets/chart.png"]]));
    expect(output).toContain('src="assets/chart.png"');
    expect(output).toContain('<ol start="3">');
    expect(output).toContain("<strong>bold</strong>");
    expect(output).toContain('colspan="2"');
    expect(output).not.toMatch(/onclick|secret\(\)|99px/);
  });

  it("retains text around inline images and flags unsupported media without executing it", () => {
    const parsed = parseDocumentContent({
      title: "A",
      sourceUrl: "",
      html: '<p>Before <span><img src="chart.jpg"></span> After</p><iframe src="https://example.test/embed"></iframe>',
    });
    expect(parsed.document.blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "image",
      "paragraph",
    ]);
    expect(parsed.warnings.join(" ")).toContain("媒体");
    expect(renderDocument(parsed.document, new Map([["chart.jpg", "assets/a.jpg"]]))).not.toContain(
      "iframe",
    );
  });

  it("escapes active links and groups a heading with its following figure", () => {
    const parsed = parseDocumentContent({
      title: "A <script>bad()</script>",
      sourceUrl: "javascript:bad()",
      html: '<h2>Chart</h2><figure><img src="chart.jpg"></figure><p><a href="javascript:bad()">Text</a></p>',
    });
    const output = renderDocument(parsed.document, new Map([["chart.jpg", "assets/a.jpg"]]));
    expect(output).toContain('class="lead-pair"');
    expect(output).not.toContain('href="javascript:');
    expect(output).toContain("&lt;script&gt;");
  });

  it("reports unsupported media nested inside inline text", () => {
    const parsed = parseDocumentContent({
      title: "Embedded content",
      sourceUrl: "",
      html: '<p><span>Readable text <video src="movie.mp4"></video></span></p>',
    });
    expect(parsed.warnings).toEqual(["尚未完整导出的嵌入媒体：video"]);
    expect(parsed.document.blocks).toMatchObject([{ type: "paragraph" }]);
  });

  it("keeps a section heading with its opening paragraph at a page boundary", () => {
    const parsed = parseDocumentContent({
      title: "Reading copy",
      sourceUrl: "",
      html: "<h2>Section</h2><p>Opening paragraph.</p><p>Next paragraph.</p>",
    });
    const output = renderDocument(parsed.document, new Map());
    expect(output).toContain(
      '<section class="lead-pair"><h2>Section</h2><p>Opening paragraph.</p></section><p>Next paragraph.</p>',
    );
  });
});
