import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import type { BrowserContext, Page, Response } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArticleAdapter } from "../src/adapters/article/index.js";
import { ARTICLE_STATUS_SCRIPT, CAPTURE_ARTICLE_SCRIPT } from "../src/adapters/article/scripts.js";
import type { CapturedArticle } from "../src/adapters/article/types.js";
import type { BrowserProvider } from "../src/adapters/browser.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "duckdownloader-article-test-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function fixture(overrides: Partial<CapturedArticle> = {}) {
  let printPath = "";
  const article: CapturedArticle = {
    title: "Private document",
    sourceUrl: "https://tenant.feishu.cn/docx/Abc123",
    html: '<h2>First</h2><p>Native article text</p><img src="blob:https://tenant.feishu.cn/image">',
    images: [
      {
        reference: "blob:https://tenant.feishu.cn/image",
        sourceUrl: "https://tenant.feishu.cn/docx/Abc123",
        mediaType: "image/png",
        dataBase64:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      },
    ],
    warnings: [],
    complete: true,
    sections: 1,
    ...overrides,
  };
  const evaluate = vi.fn(async (expression: string) => {
    if (expression.includes(CAPTURE_ARTICLE_SCRIPT.slice(3, 70))) return article;
    if (expression.includes(ARTICLE_STATUS_SCRIPT.slice(3, 70))) return { ready: true };
    if (expression.includes("window.print()")) {
      const pdf = await PDFDocument.create();
      pdf.addPage([(210 / 25.4) * 72, (297 / 25.4) * 72]).drawText("Native article text");
      await writeFile(printPath, await pdf.save());
    }
    return true;
  });
  const page = {
    goto: vi.fn(async () => ({ status: () => 200 })),
    evaluate,
    route: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } as unknown as Page;
  const close = vi.fn(async () => {});
  const open = vi.fn(async (options: { printPath?: string }) => {
    printPath = options.printPath || "";
    return {
      context: { pages: () => [], newPage: async () => page } as unknown as BrowserContext,
      close,
    };
  });
  return { provider: { open } satisfies BrowserProvider, open, close, page, article };
}

describe("authorized article downloads", () => {
  it.each([null, 403])(
    "rejects an unreadable HTTP response (%s) and preserves existing output",
    async (status) => {
      const browser = fixture();
      vi.mocked(browser.page.goto).mockResolvedValueOnce(
        status === null ? null : ({ status: () => status } as Response),
      );
      const output = join(directory, "existing.pdf");
      await writeFile(output, "existing");
      await expect(
        new ArticleAdapter("feishu", browser.provider).download({
          url: browser.article.sourceUrl,
          guest: true,
          output,
        }),
      ).rejects.toThrow("页面返回");
      expect(await readFile(output, "utf8")).toBe("existing");
      expect(browser.close).toHaveBeenCalledOnce();
      expect(await readdir(directory)).toEqual(["existing.pdf"]);
    },
  );

  it.each([
    { ready: false, error: "需要手动完成访问验证" },
    { ready: false, needsLogin: true },
  ])("rejects access checks before extracting content: %j", async (status) => {
    const browser = fixture();
    vi.mocked(browser.page.evaluate).mockResolvedValueOnce(status);
    await expect(
      new ArticleAdapter("feishu", browser.provider).download({
        url: browser.article.sourceUrl,
        guest: true,
        output: join(directory, "blocked.pdf"),
      }),
    ).rejects.toThrow(/访问验证|需要登录/);
    expect(browser.close).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([{ title: "" }, { html: "" }, { sourceUrl: "https://tenant.feishu.cn/wiki/not-docx" }])(
    "rejects invalid captured content before creating an archive: %j",
    async (invalid) => {
      const browser = fixture(invalid);
      await expect(
        new ArticleAdapter("feishu", browser.provider).download({
          url: "https://tenant.feishu.cn/docx/Abc123",
          guest: true,
          output: join(directory, "invalid.pdf"),
        }),
      ).rejects.toThrow();
      expect(browser.close).toHaveBeenCalledOnce();
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it("bounds a page that never becomes readable and closes its session", async () => {
    const browser = fixture();
    await expect(
      new ArticleAdapter("feishu", browser.provider, { timeoutMs: 0 }).download({
        url: browser.article.sourceUrl,
        guest: true,
        output: join(directory, "timed-out.pdf"),
      }),
    ).rejects.toThrow("内容加载超时");
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("uses the WeChat profile for saved-session downloads without mixing sources", async () => {
    const browser = fixture({ sourceUrl: "https://mp.weixin.qq.com/s/authorized" });
    const profile = join(directory, "wechat-profile"),
      output = join(directory, "wechat.pdf");
    await new ArticleAdapter("wechat", browser.provider, { profile }).download({
      url: browser.article.sourceUrl,
      guest: false,
      output,
    });
    expect(browser.open).toHaveBeenCalledWith({
      headless: true,
      profile,
      printPath: expect.any(String),
    });
    expect(browser.close).toHaveBeenCalledOnce();
    expect((await readdir(directory)).sort()).toEqual(["wechat-profile", "wechat.pdf"]);
  });

  it("does not confirm or save a login target when its HTTP response is denied", async () => {
    const browser = fixture();
    const confirmLogin = vi.fn();
    vi.mocked(browser.page.goto).mockResolvedValueOnce({ status: () => 403 } as Response);
    await expect(
      new ArticleAdapter("feishu", browser.provider, {
        profile: join(directory, "profile"),
        confirmLogin,
      }).login(browser.article.sourceUrl),
    ).rejects.toThrow("页面返回 403");
    expect(confirmLogin).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("prints native PDF and keeps structured content when explicitly requested", async () => {
    const browser = fixture();
    const output = join(directory, "saved.pdf");
    const progress = vi.fn();
    await expect(
      new ArticleAdapter("feishu", browser.provider).download(
        { url: browser.article.sourceUrl, guest: true, output, keepIntermediates: true },
        progress,
      ),
    ).resolves.toBe(output);
    expect(browser.open).toHaveBeenCalledWith({ headless: true, printPath: expect.any(String) });
    expect(browser.close).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith(1, 1);
    const archive = (await readdir(directory)).find((name) =>
      name.startsWith("saved.pdf.archive-"),
    )!;
    const saved = await readFile(join(directory, archive, "article.html"), "utf8");
    expect(saved).toContain("Native article text");
    expect(saved).not.toContain("blob:");
    expect(await readFile(join(directory, archive, "article.md"), "utf8")).toContain("assets/");
    const manifest = JSON.parse(await readFile(join(directory, archive, "artifact.json"), "utf8"));
    expect(manifest.status).toBe("succeeded");
    expect(manifest.assets).toHaveLength(1);
    const content = JSON.parse(await readFile(join(directory, archive, "content.json"), "utf8"));
    expect(content.blocks.map((block: { type: string }) => block.type)).toEqual([
      "heading",
      "paragraph",
      "image",
    ]);
    expect((await PDFDocument.load(await readFile(output))).getPageCount()).toBe(1);
  });

  it("removes its HTML, structured content and images after a successful default export", async () => {
    const browser = fixture();
    const output = join(directory, "clean.pdf");
    await new ArticleAdapter("feishu", browser.provider).download({
      url: browser.article.sourceUrl,
      guest: true,
      output,
    });
    expect(await readdir(directory)).toEqual(["clean.pdf"]);
    expect((await PDFDocument.load(await readFile(output))).getPageCount()).toBe(1);
  });

  it("keeps incomplete text and warnings without replacing an existing PDF", async () => {
    const browser = fixture({ complete: false, warnings: ["Missing last section"] });
    const output = join(directory, "existing.pdf");
    await writeFile(output, "existing");
    await expect(
      new ArticleAdapter("feishu", browser.provider).download({
        url: browser.article.sourceUrl,
        guest: true,
        output,
      }),
    ).rejects.toThrow(/Missing last section|不完整/);
    expect(await readFile(output, "utf8")).toBe("existing");
    expect(browser.close).toHaveBeenCalledOnce();
    const archive = (await readdir(directory)).find((name) =>
      name.startsWith("existing.pdf.archive-"),
    )!;
    const manifest = JSON.parse(await readFile(join(directory, archive, "artifact.json"), "utf8"));
    expect(manifest.status).toBe("partial");
    expect(manifest.warnings).toContain("Missing last section");
  });

  it("uses a separate profile and verifies that the manual-login target became readable", async () => {
    const browser = fixture();
    const confirm = vi.fn(async () => {});
    const profile = join(directory, "feishu-profile");
    await new ArticleAdapter("feishu", browser.provider, { profile, confirmLogin: confirm }).login(
      browser.article.sourceUrl,
    );
    expect(browser.open).toHaveBeenCalledWith({ headless: false, profile });
    expect(confirm).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toContain("feishu-profile");
  });

  it("rejects source mismatches and absent login targets before opening browsers", async () => {
    const browser = fixture();
    const adapter = new ArticleAdapter("feishu", browser.provider);
    await expect(adapter.login()).rejects.toThrow(/--url/);
    await expect(
      adapter.download({ url: "https://tenant.feishu.cn/wiki/abc", guest: true }),
    ).rejects.toThrow();
    expect(browser.open).not.toHaveBeenCalled();
  });

  it("keeps existing output when native printing or browser close fails", async () => {
    const browser = fixture();
    browser.close.mockRejectedValueOnce(new Error("close failed"));
    const output = join(directory, "existing.pdf");
    await writeFile(output, "existing");
    await expect(
      new ArticleAdapter("feishu", browser.provider).download({
        url: browser.article.sourceUrl,
        guest: true,
        output,
      }),
    ).rejects.toThrow("close failed");
    expect(await readFile(output, "utf8")).toBe("existing");
  });

  it("does not replace an existing PDF if the final progress callback rejects", async () => {
    const browser = fixture();
    const output = join(directory, "existing.pdf");
    await writeFile(output, "existing");
    await expect(
      new ArticleAdapter("feishu", browser.provider).download(
        { url: browser.article.sourceUrl, guest: true, output },
        () => {
          throw new Error("consumer cancelled");
        },
      ),
    ).rejects.toThrow("consumer cancelled");
    expect(await readFile(output, "utf8")).toBe("existing");
  });
});
