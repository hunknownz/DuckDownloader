import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import type { BrowserContext, Page } from "playwright-core";
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
  it("prints native PDF, preserves blob images in sidecars and closes its session", async () => {
    const browser = fixture();
    const output = join(directory, "saved.pdf");
    const progress = vi.fn();
    await expect(
      new ArticleAdapter("feishu", browser.provider).download(
        { url: browser.article.sourceUrl, guest: true, output },
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
