import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, buildBinary } from "plist";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSavedPage } from "../src/adapters/document/saved-page.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "duckdownloader-saved-page-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

describe("offline saved-page import", () => {
  it.each([
    { name: "invalid root", data: [], error: /结构无效/ },
    { name: "missing main body", data: { WebMainResource: {} }, error: /正文数据/ },
    {
      name: "non-HTML main",
      data: {
        WebMainResource: {
          WebResourceData: Buffer.from("image"),
          WebResourceMIMEType: "image/png",
        },
      },
      error: /不是 HTML/,
    },
    {
      name: "unknown encoding",
      data: {
        WebMainResource: {
          WebResourceData: Buffer.from("body"),
          WebResourceTextEncodingName: "unsupported-encoding",
        },
      },
      error: /文字编码/,
    },
    {
      name: "too many resources",
      data: {
        WebMainResource: { WebResourceData: Buffer.from("<p>Body</p>") },
        WebSubresources: Array.from({ length: 1001 }, () => ({})),
      },
      error: /资源数量/,
    },
  ])("rejects malformed Webarchive input before browser use: $name", async ({ data, error }) => {
    const input = join(directory, "invalid.webarchive");
    await writeFile(input, build(data));
    await expect(readSavedPage({ input })).rejects.toThrow(error);
  });

  it("rejects custom XML entities and oversized source files before importing them", async () => {
    const input = join(directory, "entities.webarchive");
    await writeFile(
      input,
      '<?xml version="1.0"?><!DOCTYPE plist [<!ENTITY custom "value">]><plist><dict/></plist>',
    );
    await expect(readSavedPage({ input })).rejects.toThrow("XML 实体");
    const huge = join(directory, "huge.html");
    await writeFile(huge, "Body");
    await truncate(huge, 97 * 1024 * 1024);
    await expect(readSavedPage({ input: huge })).rejects.toThrow("96 MiB");
  });

  it("keeps text when a Webarchive is missing an image or contains unsupported subframes", async () => {
    const input = join(directory, "partial.webarchive");
    await writeFile(
      input,
      buildBinary({
        WebMainResource: {
          WebResourceURL: "https://example.test/post",
          WebResourceData: Buffer.from(
            '<article><p>Preserved body</p><img src="missing.png"></article>',
          ),
        },
        WebSubframeArchives: [{}],
      }),
    );
    const result = await readSavedPage({ input });
    expect(result.article.complete).toBe(false);
    expect(result.article.html).toContain("Preserved body");
    expect(result.article.warnings.join(" ")).toMatch(/子框架/);
    expect(result.article.warnings.join(" ")).toMatch(/未包含这张图片/);
  });

  it("rejects an existing image outside the saved page directory", async () => {
    const page = join(directory, "page");
    await mkdir(page);
    await writeFile(join(directory, "outside.png"), image);
    const input = join(page, "article.html");
    await writeFile(input, '<main><p>Keep body</p><img src="../outside.png"></main>');
    const result = await readSavedPage({ input });
    expect(result.article.complete).toBe(false);
    expect(result.article.warnings.join(" ")).toContain("路径越过");
    expect(await readFile(join(directory, "outside.png"))).toEqual(image);
  });

  it.skipIf(process.platform === "win32")(
    "does not follow an image symlink outside the saved page directory",
    async () => {
      const page = join(directory, "page");
      await mkdir(page);
      await writeFile(join(directory, "outside.png"), image);
      await symlink(join(directory, "outside.png"), join(page, "linked.png"));
      const input = join(page, "article.html");
      await writeFile(input, '<main><p>Body</p><img src="linked.png"></main>');
      const result = await readSavedPage({ input });
      expect(result.article.complete).toBe(false);
      expect(result.article.warnings.join(" ")).toContain("路径越过");
    },
  );

  it.each(["empty", "oversized", "unsupported"] as const)(
    "retains partial text for an %s local image",
    async (kind) => {
      const asset = join(directory, kind === "unsupported" ? "image.svg" : "image.png");
      await writeFile(asset, kind === "empty" ? Buffer.alloc(0) : image);
      if (kind === "oversized") await truncate(asset, 21 * 1024 * 1024);
      const input = join(directory, "article.html");
      await writeFile(
        input,
        `<main><p>Keep text</p><img src="${kind === "unsupported" ? "image.svg" : "image.png"}"></main>`,
      );
      const result = await readSavedPage({ input });
      expect(result.article.complete).toBe(false);
      expect(result.article.warnings.join(" ")).toMatch(/为空|大小限制|图片类型/);
    },
  );

  it("deduplicates saved data images without losing either occurrence in the content", async () => {
    const input = join(directory, "inline.htm"),
      reference = `data:image/png;base64,${image.toString("base64")}`;
    await writeFile(
      input,
      `<main><p>Body</p><img src="${reference}"><img src="${reference}"></main>`,
    );
    const result = await readSavedPage({ input });
    expect(result.article.complete).toBe(true);
    expect(result.article.images).toHaveLength(1);
    expect(result.article.html.match(/<img/g)).toHaveLength(2);
  });

  it("normalizes a saved WeChat text post into a short title and separate paragraphs", async () => {
    const input = join(directory, "note.html");
    await writeFile(
      input,
      '<html><head><title>Note title First paragraph Last paragraph</title></head><body><div id="js_content"><p id="js_text_desc"><!-- saved marker -->Note title<br><br>First <strong>paragraph</strong>.<br><br>Last paragraph.</p><div class="rich_media_meta_list">Location May 11</div><div class="reward_dialog">Reward dialog</div></div></body></html>',
    );
    const result = await readSavedPage({ input });
    expect(result.article.title).toBe("Note title");
    expect(result.article.html).toContain("<p>First <strong>paragraph</strong>.</p>");
    expect(result.article.html).toContain("<p>Last paragraph.</p>");
    expect(result.article.html).not.toMatch(/Note title|Location|Reward dialog/);
    expect(result.article.complete).toBe(true);
  });

  it("uses an existing h1 as the title when a saved page has no title metadata", async () => {
    const input = join(directory, "untitled.html");
    await writeFile(input, "<main><h1>Actual article title</h1><p>Article body</p></main>");
    const result = await readSavedPage({ input });
    expect(result.article.title).toBe("Actual article title");
    expect(result.article.html).not.toContain("Actual article title");
    expect(result.article.html).toContain("Article body");
  });

  it("keeps the full first line when an explicit title override is requested", async () => {
    const input = join(directory, "override.htm");
    await writeFile(
      input,
      '<div id="js_content"><p id="js_text_desc">Original first line<br><br>Body paragraph</p></div>',
    );
    const result = await readSavedPage({ input, title: "Custom reading title" });
    expect(result.article.title).toBe("Custom reading title");
    expect(result.article.html).toContain("Original first line");
  });

  it("reads a saved HTML page with local image resources instead of the original remote data-src", async () => {
    await mkdir(join(directory, "article_files"));
    await writeFile(join(directory, "article_files", "chart.png"), image);
    const input = join(directory, "article.html");
    await writeFile(
      input,
      '<html><head><title>Saved article</title></head><body><main><h2>First</h2><p>Body</p><img src="article_files/chart.png" data-src="https://example.test/original.png"></main></body></html>',
    );
    const imported = await readSavedPage({ input });
    expect(imported.article.title).toBe("Saved article");
    expect(imported.article.complete).toBe(true);
    expect(imported.article.images[0]?.dataBase64).toBe(image.toString("base64"));
    expect(await readFile(input, "utf8")).toContain("Saved article");
  });

  it.each(["xml", "binary"] as const)(
    "imports %s Webarchive resources without visiting their URLs",
    async (format) => {
      const input = join(directory, "saved.webarchive");
      const archive = {
        WebMainResource: {
          WebResourceURL: "https://example.test/post",
          WebResourceMIMEType: "text/html",
          WebResourceTextEncodingName: "UTF-8",
          WebResourceData: Buffer.from(
            '<html><head><title>Archive</title></head><body><article><p>Complete saved text</p><img src="https://example.test/image.png"></article></body></html>',
          ),
        },
        WebSubresources: [
          {
            WebResourceURL: "https://example.test/image.png",
            WebResourceMIMEType: "image/png",
            WebResourceData: image,
          },
        ],
      };
      await writeFile(input, format === "xml" ? build(archive) : buildBinary(archive));
      const imported = await readSavedPage({ input });
      expect(imported.article.sourceUrl).toBe("https://example.test/post");
      expect(imported.article.complete).toBe(true);
      expect(imported.article.images[0]?.dataBase64).toBe(image.toString("base64"));
    },
  );

  it("retains text but marks unavailable online and escaping local images as incomplete", async () => {
    const input = join(directory, "bad.html");
    await writeFile(
      input,
      '<main><p>Keep text</p><img src="https://example.test/not-saved.png"><img src="../outside.png"></main>',
    );
    const result = await readSavedPage({ input });
    expect(result.article.complete).toBe(false);
    expect(result.article.warnings).toHaveLength(2);
    expect(result.article.html).toContain("Keep text");
  });

  it("rejects a verification page and unrelated file types instead of exporting them as articles", async () => {
    const input = join(directory, "challenge.html");
    await writeFile(input, "<body>当前环境异常，完成验证后即可继续访问。去验证</body>");
    await expect(readSavedPage({ input })).rejects.toThrow(/验证/);
    await expect(readSavedPage({ input: join(directory, "document.pdf") })).rejects.toThrow(/格式/);
  });

  it("detects a verification shell even when it has a main element and long inline scripts", async () => {
    const input = join(directory, "verification.html");
    await writeFile(
      input,
      `<main><h1>环境异常</h1><p>当前环境异常，完成验证后即可继续访问。</p><button>去验证</button><script>${"var loading = true;".repeat(300)}</script></main>`,
    );
    await expect(readSavedPage({ input })).rejects.toThrow(/验证/);
  });

  it.each(["https://example.test/post", "file:///saved/page.html"])(
    "resolves bundled relative images against the Webarchive main resource: %s",
    async (base) => {
      const input = join(directory, "relative.webarchive");
      const archive = {
        WebMainResource: {
          WebResourceURL: base,
          WebResourceMIMEType: "text/html",
          WebResourceData: Buffer.from(
            '<html><head><link rel="canonical" href="https://canonical.example/other/path"></head><body><main><p>Saved body</p><img src="image.png"></main></body></html>',
          ),
        },
        WebSubresources: [
          {
            WebResourceURL: new URL("image.png", base).href,
            WebResourceMIMEType: "image/png",
            WebResourceData: image,
          },
        ],
      };
      await writeFile(input, buildBinary(archive));
      const result = await readSavedPage({ input });
      expect(result.article.complete).toBe(true);
      expect(result.article.images[0]?.dataBase64).toBe(image.toString("base64"));
    },
  );
});
