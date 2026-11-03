import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";
import { expect, it, vi } from "vitest";
import { writeArticleArchive } from "../src/adapters/article/archive.js";
import type { CapturedArticle } from "../src/adapters/article/types.js";

it("uses the browser request context for a loaded public image and validates redirects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "article-assets-"));
  const reference = "https://mmbiz.qpic.cn/image.png";
  const article: CapturedArticle = {
    title: "Article",
    sourceUrl: "https://mp.weixin.qq.com/s/abc",
    html: `<p>Text</p><img src="${reference}">`,
    images: [{ reference, sourceUrl: reference, mediaType: "" }],
    complete: true,
    warnings: [],
    sections: 1,
  };
  const dispose = vi.fn(async () => {});
  const get = vi.fn(async () => ({
    status: (): number => 200,
    ok: (): boolean => true,
    headers: () => ({ "content-type": "image/png" }),
    body: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    dispose,
  }));
  try {
    const result = await writeArticleArchive(article, "wechat", directory, {
      request: { get },
    } as unknown as BrowserContext);
    expect(result.manifest.assets).toHaveLength(1);
    expect(get).toHaveBeenCalledWith(reference, expect.objectContaining({ maxRedirects: 0 }));
    expect(dispose).toHaveBeenCalledOnce();
    expect(await readFile(result.htmlPath, "utf8")).toContain("assets/");
    get.mockResolvedValueOnce({
      status: () => 302,
      ok: () => false,
      headers: () => ({ location: "http://127.0.0.1/private" }) as never,
      body: async () => Buffer.alloc(0),
      dispose,
    });
    const unsafe = await writeArticleArchive(article, "wechat", directory, {
      request: { get },
    } as unknown as BrowserContext);
    expect(unsafe.manifest.status).toBe("partial");
    expect(unsafe.manifest.warnings.join("\n")).toContain("域名范围");
    get.mockRejectedValueOnce(
      new Error("TLS connection failed\nCall log:\n - cookie: synthetic-session-secret"),
    );
    const failed = await writeArticleArchive(article, "wechat", directory, {
      request: { get },
    } as unknown as BrowserContext);
    expect(failed.manifest.status).toBe("partial");
    expect(failed.manifest.warnings.join(" ")).not.toContain("synthetic-session-secret");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
