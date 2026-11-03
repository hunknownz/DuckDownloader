import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";
import TurndownService from "turndown";
import { DownloaderError } from "../../errors.js";
import { documentImages, parseDocumentContent } from "../document/parse.js";
import { renderBody, renderDocument } from "../document/render.js";
import type { CapturedArticle, CapturedImage } from "./types.js";

const maxImageBytes = 20 * 1024 * 1024;
const mediaExtensions: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
};

function allowedImageUrl(input: string): URL {
  const url = new URL(input);
  const hosts = [
    "mmbiz.qpic.cn",
    "mmbiz.qlogo.cn",
    "thirdwx.qlogo.cn",
    "mp.weixin.qq.com",
    "feishu.cn",
    "feishucdn.com",
    "larksuite.com",
    "larksuitecdn.com",
  ];
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
  )
    throw new DownloaderError("图片地址不在来源资源域名范围内");
  return url;
}

async function imageBytes(
  image: CapturedImage,
  context?: BrowserContext,
): Promise<{ bytes: Buffer; mediaType: string }> {
  if (image.dataBase64) {
    if (
      image.dataBase64.length > Math.ceil(maxImageBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.dataBase64)
    )
      throw new DownloaderError("图片 base64 数据无效或过大");
    return { bytes: Buffer.from(image.dataBase64, "base64"), mediaType: image.mediaType };
  }
  if (!context) throw new DownloaderError("离线导入缺少本地图片，不会请求网络资源");
  let url = allowedImageUrl(image.sourceUrl);
  for (let redirect = 0; redirect <= 5; redirect++) {
    const response = await context.request.get(url.href, {
      timeout: 20_000,
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    try {
      if ([301, 302, 303, 307, 308].includes(response.status())) {
        const location = response.headers().location;
        if (!location || redirect === 5) throw new DownloaderError("图片重定向无效或过多");
        url = allowedImageUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok()) throw new DownloaderError(`图片请求返回 HTTP ${response.status()}`);
      const mediaType = (response.headers()["content-type"] || "")
        .split(";")[0]!
        .trim()
        .toLowerCase();
      if (!mediaExtensions[mediaType]) throw new DownloaderError(`不支持的图片类型：${mediaType}`);
      if (Number(response.headers()["content-length"] || 0) > maxImageBytes)
        throw new DownloaderError("图片超过大小限制");
      const bytes = await response.body();
      if (bytes.length > maxImageBytes) throw new DownloaderError("图片超过大小限制");
      return { bytes, mediaType };
    } finally {
      await response.dispose();
    }
  }
  throw new DownloaderError("图片重定向过多");
}

export interface ArticleArchive {
  readonly htmlPath: string;
  readonly manifest: {
    schemaVersion: string;
    source: string;
    sourceUrl: string;
    title: string;
    status: "partial" | "succeeded";
    sections: number;
    blockCount: number;
    assets: Array<{
      sourceUrl: string;
      reference: string;
      path: string;
      mediaType: string;
      bytes: number;
      sha256: string;
    }>;
    warnings: string[];
    pdf?: string;
    pdfPages?: number;
  };
}

export async function writeArticleArchive(
  article: CapturedArticle,
  source: string,
  directory: string,
  context?: BrowserContext,
): Promise<ArticleArchive> {
  await mkdir(directory, { recursive: true });
  const parsed = parseDocumentContent(article);
  const warnings = [...article.warnings, ...parsed.warnings];
  const assets: ArticleArchive["manifest"]["assets"] = [];
  const localized = new Map<string, string>();
  let totalBytes = 0;
  for (const image of article.images) {
    try {
      let path = localized.get(image.reference);
      if (!path) {
        const { bytes, mediaType } = await imageBytes(image, context);
        if (!bytes.length || !mediaExtensions[mediaType])
          throw new DownloaderError("图片数据为空或类型无效");
        totalBytes += bytes.length;
        if (totalBytes > 64 * 1024 * 1024) throw new DownloaderError("文档图片总量超过限制");
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        path = `assets/${sha256}${mediaExtensions[mediaType]}`;
        await mkdir(join(directory, "assets"), { recursive: true });
        await writeFile(join(directory, path), bytes);
        assets.push({
          sourceUrl: image.sourceUrl,
          reference: image.reference,
          path,
          mediaType,
          bytes: bytes.length,
          sha256,
        });
        localized.set(image.reference, path);
      }
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error))
        .split(/\r?\n/)[0]!
        .replace(/https?:\/\/\S+/g, "[资源地址]");
      warnings.push(`图片未保存：${reason}`);
    }
  }
  for (const image of documentImages(parsed.document.blocks))
    if (!localized.has(image.reference)) warnings.push("图片没有对应的本地资源");
  const html = renderBody(parsed.document.blocks, localized);
  const markdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }).turndown(
    html,
  );
  const htmlPath = join(directory, "article.html");
  await writeFile(
    join(directory, "content.json"),
    JSON.stringify(parsed.document, null, 2),
    "utf8",
  );
  await writeFile(
    join(directory, "source.html"),
    renderDocument(
      parsed.document,
      new Map(
        documentImages(parsed.document.blocks).map((image) => [image.reference, image.reference]),
      ),
    ),
    "utf8",
  );
  await writeFile(
    join(directory, "article.md"),
    `# ${article.title}\n\n来源：${article.sourceUrl}\n\n${markdown}\n`,
    "utf8",
  );
  const document = renderDocument(parsed.document, localized);
  await writeFile(htmlPath, document, "utf8");
  const manifest: ArticleArchive["manifest"] = {
    schemaVersion: "2.0",
    source,
    sourceUrl: article.sourceUrl,
    title: article.title,
    status: !article.complete || warnings.length ? "partial" : "succeeded",
    sections: article.sections,
    blockCount: parsed.document.blocks.length,
    assets,
    warnings: [...new Set(warnings)],
  };
  await writeFile(join(directory, "artifact.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { htmlPath, manifest };
}
