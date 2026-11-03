import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";
import { expect, it, vi } from "vitest";
import { writeArticleArchive } from "../src/adapters/article/archive.js";
import type { CapturedArticle } from "../src/adapters/article/types.js";

function articleWithImage(image: CapturedArticle["images"][number]): CapturedArticle {
  return {
    title: "Article",
    sourceUrl: "https://mp.weixin.qq.com/s/abc",
    html: `<p>Preserved text</p><img src="${image.reference}">`,
    images: [image],
    complete: true,
    warnings: [],
    sections: 1,
  };
}

it.each([
  {
    status: 403,
    headers: { "content-type": "image/png" },
    body: Buffer.from("image"),
    warning: "HTTP 403",
  },
  {
    status: 200,
    headers: { "content-type": "text/html" },
    body: Buffer.from("denied"),
    warning: "图片类型",
  },
  {
    status: 200,
    headers: { "content-type": "image/png", "content-length": String(21 * 1024 * 1024) },
    body: Buffer.from("image"),
    warning: "大小限制",
  },
  {
    status: 200,
    headers: { "content-type": "image/png" },
    body: Buffer.alloc(21 * 1024 * 1024),
    warning: "大小限制",
  },
  {
    status: 200,
    headers: { "content-type": "image/png" },
    body: Buffer.alloc(0),
    warning: "数据为空",
  },
  { status: 302, headers: {}, body: Buffer.alloc(0), warning: "重定向" },
])(
  "preserves partial text and disposes rejected image responses: $warning",
  async ({ status, headers, body, warning }) => {
    const directory = await mkdtemp(join(tmpdir(), "article-rejected-image-"));
    const reference = "https://mmbiz.qpic.cn/image.png";
    const dispose = vi.fn(async () => {});
    const get = vi.fn(async () => ({
      status: () => status,
      ok: () => status === 200,
      headers: () => headers,
      body: async () => body,
      dispose,
    }));
    try {
      const result = await writeArticleArchive(
        articleWithImage({ reference, sourceUrl: reference, mediaType: "" }),
        "wechat",
        directory,
        { request: { get } } as unknown as BrowserContext,
      );
      expect(result.manifest.status).toBe("partial");
      expect(result.manifest.warnings.join(" ")).toContain(warning);
      expect(result.manifest.assets).toEqual([]);
      expect(dispose).toHaveBeenCalledOnce();
      expect(await readFile(result.htmlPath, "utf8")).toContain("Preserved text");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("follows an allowed image redirect and rejects an endless redirect chain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "article-redirects-"));
  const reference = "https://mmbiz.qpic.cn/first.png";
  const dispose = vi.fn(async () => {});
  const redirect = {
    status: () => 302,
    ok: () => false,
    headers: () => ({ location: "/next.png" }),
    body: async () => Buffer.alloc(0),
    dispose,
  };
  const get = vi
    .fn()
    .mockResolvedValueOnce(redirect)
    .mockResolvedValueOnce({
      status: () => 200,
      ok: () => true,
      headers: () => ({ "content-type": "image/png; charset=binary" }),
      body: async () => Buffer.from("image"),
      dispose,
    });
  const article = articleWithImage({ reference, sourceUrl: reference, mediaType: "" });
  try {
    const success = await writeArticleArchive(article, "wechat", directory, {
      request: { get },
    } as unknown as BrowserContext);
    expect(success.manifest.status).toBe("succeeded");
    expect(get).toHaveBeenNthCalledWith(2, "https://mmbiz.qpic.cn/next.png", expect.any(Object));
    expect(dispose).toHaveBeenCalledTimes(2);
    get.mockReset().mockResolvedValue(redirect);
    const partial = await writeArticleArchive(article, "wechat", directory, {
      request: { get },
    } as unknown as BrowserContext);
    expect(partial.manifest.status).toBe("partial");
    expect(get).toHaveBeenCalledTimes(6);
    expect(partial.manifest.warnings.join(" ")).toContain("重定向");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  { sourceUrl: "https://evil.example/image.png", mediaType: "", warning: "域名范围" },
  { sourceUrl: "https://mmbiz.qpic.cn/image.png", mediaType: "", warning: "离线导入" },
  {
    sourceUrl: "blob:https://mp.weixin.qq.com/image",
    mediaType: "image/png",
    dataBase64: "invalid!",
    warning: "base64",
  },
  {
    sourceUrl: "blob:https://mp.weixin.qq.com/image",
    mediaType: "image/unknown",
    dataBase64: "aW1hZ2U=",
    warning: "类型无效",
  },
])(
  "does not fetch missing offline or invalid encoded images: $warning",
  async ({ warning, ...image }) => {
    const directory = await mkdtemp(join(tmpdir(), "article-invalid-image-"));
    const get = vi.fn();
    try {
      const result = await writeArticleArchive(
        articleWithImage({ reference: image.sourceUrl, ...image }),
        "wechat",
        directory,
        warning === "离线导入" ? undefined : ({ request: { get } } as unknown as BrowserContext),
      );
      expect(result.manifest.status).toBe("partial");
      expect(result.manifest.warnings.join(" ")).toContain(warning);
      expect(get).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

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
