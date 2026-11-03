import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import { parse as parsePlist } from "plist";
import type { LocalExportRequest } from "../../domain.js";
import { DownloaderError } from "../../errors.js";
import type { CapturedArticle, CapturedImage } from "../article/types.js";
import { expandHomePath } from "../paths.js";
import { documentImages, parseDocumentContent } from "./parse.js";

const maxImageBytes = 20 * 1024 * 1024;
const imageTypes: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
};
export interface SavedPage {
  readonly article: CapturedArticle;
  readonly sourcePath: string;
  readonly identity: {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly mtimeMs: number;
  };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array)
    throw new DownloaderError("webarchive: 文件结构无效");
  return value as Record<string, unknown>;
}
function normalizeUrl(input: string, base?: string): string {
  const url = new URL(input, base);
  url.hash = "";
  return url.href;
}
function decode(bytes: Uint8Array, encoding = "utf-8"): string {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    throw new DownloaderError(`saved-page: 不支持的文字编码 ${encoding}`);
  }
}

export async function readSavedPage(request: LocalExportRequest): Promise<SavedPage> {
  if (/^https?:/i.test(request.input))
    throw new DownloaderError("convert: 只接受本地保存的网页文件，不访问网址");
  const sourcePath = resolve(expandHomePath(request.input));
  const extension = extname(sourcePath).toLowerCase();
  if (![".html", ".htm", ".webarchive"].includes(extension))
    throw new DownloaderError("convert: 文件格式必须是 HTML 或 Webarchive");
  const identity = await lstat(sourcePath);
  const info = await stat(sourcePath);
  if (!info.isFile() || info.size > 96 * 1024 * 1024)
    throw new DownloaderError("saved-page: 文件无效或超过 96 MiB 限制");
  const bytes = await readFile(sourcePath);
  if (
    extension === ".webarchive" &&
    /<!ENTITY\s/i.test(bytes.subarray(0, 65536).toString("latin1"))
  )
    throw new DownloaderError("webarchive: 不支持自定义 XML 实体");
  const archiveAssets = new Map<string, { bytes: Buffer; mediaType: string }>();
  const warnings: string[] = [];
  let html: string,
    sourceUrl = "";
  let resourceBase = "";
  if (extension === ".webarchive") {
    const data = object(
      bytes.subarray(0, 8).toString() === "bplist00"
        ? parsePlist(bytes)
        : parsePlist(decode(bytes)),
    );
    const main = object(data.WebMainResource);
    if (!(main.WebResourceData instanceof Uint8Array))
      throw new DownloaderError("webarchive: 缺少网页正文数据");
    const mime = String(main.WebResourceMIMEType || "text/html");
    if (!["text/html", "application/xhtml+xml"].includes(mime))
      throw new DownloaderError("webarchive: 主资源不是 HTML");
    html = decode(main.WebResourceData, String(main.WebResourceTextEncodingName || "utf-8"));
    sourceUrl = typeof main.WebResourceURL === "string" ? main.WebResourceURL : "";
    resourceBase = sourceUrl;
    const resources = Array.isArray(data.WebSubresources) ? data.WebSubresources : [];
    if (resources.length > 1000) throw new DownloaderError("webarchive: 资源数量超过限制");
    let total = 0;
    for (const item of resources) {
      const resource = object(item);
      if (
        typeof resource.WebResourceURL !== "string" ||
        !(resource.WebResourceData instanceof Uint8Array)
      )
        continue;
      const mediaType = String(resource.WebResourceMIMEType || "").toLowerCase();
      if (!Object.values(imageTypes).includes(mediaType)) continue;
      const imageBytes = Buffer.from(resource.WebResourceData);
      total += imageBytes.length;
      if (imageBytes.length > maxImageBytes || total > 64 * 1024 * 1024)
        throw new DownloaderError("webarchive: 图片资源超过大小限制");
      archiveAssets.set(normalizeUrl(resource.WebResourceURL, resourceBase || undefined), {
        bytes: imageBytes,
        mediaType,
      });
    }
    if (Array.isArray(data.WebSubframeArchives) && data.WebSubframeArchives.length)
      warnings.push("Webarchive 中的子框架尚未完整导入");
  } else {
    const header = bytes.subarray(0, 4096).toString("latin1");
    const encoding =
      /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_-]+)/i.exec(header)?.[1] || "utf-8";
    html = decode(bytes, encoding);
  }
  if (Buffer.byteLength(html, "utf8") > 20 * 1024 * 1024)
    throw new DownloaderError("saved-page: HTML 正文超过 20 MiB 限制");
  const document = parseHTML(
    /<html[\s>]/i.test(html) ? html : `<!doctype html><html><body>${html}</body></html>`,
  ).document;
  const root =
    document.querySelector("#js_content") ||
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.body;
  if (!root) throw new DownloaderError("saved-page: 没有可读正文");
  for (const hidden of root.querySelectorAll("script,style,noscript,nav,form")) hidden.remove();
  if (root.id === "js_content")
    for (const chrome of root.querySelectorAll(".rich_media_meta_list,.reward_dialog"))
      chrome.remove();
  const text = (root.textContent || "").trim();
  if (
    !document.querySelector("#js_content") &&
    text.length < 2000 &&
    /^(?:环境异常\s*)?当前环境异常[，,\s]*完成验证后即可继续访问|^该内容已被发布者删除|^access denied/i.test(
      text,
    )
  )
    throw new DownloaderError("saved-page: 保存的是验证或访问拒绝页面，不是文章正文");
  const description = root.querySelector("#js_text_desc");
  let firstLine = "";
  if (description) {
    for (const child of description.childNodes) {
      if (child.nodeType === 1 && child.nodeName.toLowerCase() === "br") break;
      if (child.nodeType === 1 || child.nodeType === 3) firstLine += child.textContent || "";
    }
    firstLine = firstLine.replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, "").trim();
  }
  const characters = [...firstLine];
  const noteTitle = characters.length > 120 ? `${characters.slice(0, 120).join("")}…` : firstLine;
  const articleTitle = document.querySelector("#activity-name")?.textContent?.trim();
  const rawTitle =
    request.title ||
    articleTitle ||
    noteTitle ||
    document.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
    document.title ||
    root.querySelector("h1")?.textContent ||
    basename(sourcePath, extension);
  const title = rawTitle.trim();
  if (!title) throw new DownloaderError("saved-page: 标题为空");
  if (description) {
    const paragraphs = String(description.innerHTML)
      .split(/(?:<br\s*\/?>\s*){2,}/i)
      .map((part) => part.trim())
      .filter(Boolean);
    if (
      paragraphs.length > 1 &&
      !request.title &&
      !articleTitle &&
      title === firstLine &&
      !/<(?:a|img)\b/i.test(paragraphs[0]!)
    )
      paragraphs.shift();
    description.outerHTML = paragraphs.map((part) => `<p>${part}</p>`).join("");
  }
  const metaUrl =
    document.querySelector('link[rel="canonical"]')?.getAttribute("href") ||
    document.querySelector('meta[property="og:url"]')?.getAttribute("content") ||
    document.querySelector(".source a[href]")?.getAttribute("href") ||
    sourceUrl;
  try {
    const url = new URL(metaUrl);
    sourceUrl =
      ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch {
    sourceUrl = "";
  }
  const titleNode = root.querySelector("h1");
  if (titleNode?.textContent?.trim() === title) titleNode.remove();
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src") || "",
      lazy = img.getAttribute("data-src") || "";
    let useSaved = false;
    if (extension === ".webarchive") {
      try {
        useSaved =
          archiveAssets.has(normalizeUrl(src, resourceBase || undefined)) &&
          !archiveAssets.has(normalizeUrl(lazy, resourceBase || undefined));
      } catch {}
    } else useSaved = !!src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("//");
    if (useSaved) img.removeAttribute("data-src");
  }
  const fragment = root.innerHTML;
  const parsed = parseDocumentContent({ title, sourceUrl, html: fragment });
  warnings.push(...parsed.warnings);
  const imageNodes = documentImages(parsed.document.blocks);
  const images: CapturedImage[] = [];
  const references = new Set<string>();
  const baseDirectory = dirname(await realpath(sourcePath));
  let importedBytes = 0;
  for (const image of imageNodes) {
    if (references.has(image.reference)) continue;
    references.add(image.reference);
    try {
      let data: { bytes: Buffer; mediaType: string };
      const inline = /^data:(image\/(?:png|jpeg|gif|webp|avif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(
        image.reference,
      );
      if (inline)
        data = {
          bytes: Buffer.from(inline[2]!.replace(/\s/g, ""), "base64"),
          mediaType: inline[1]!.toLowerCase(),
        };
      else if (extension === ".webarchive") {
        const resource = archiveAssets.get(
          normalizeUrl(image.reference, resourceBase || undefined),
        );
        if (!resource) throw new DownloaderError("网页归档未包含这张图片");
        data = resource;
      } else {
        const url = new URL(image.reference, pathToFileURL(await realpath(sourcePath)).href);
        if (url.protocol !== "file:")
          throw new DownloaderError("图片没有保存在本地，离线转换不会联网补取");
        const path = await realpath(fileURLToPath(url));
        const rel = relative(baseDirectory, path);
        if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\"))
          throw new DownloaderError("图片路径越过保存网页的目录");
        const mediaType = imageTypes[extname(path).toLowerCase()];
        if (!mediaType) throw new DownloaderError("不支持的本地图片类型");
        if ((await stat(path)).size > maxImageBytes)
          throw new DownloaderError("本地图片超过大小限制");
        data = { bytes: await readFile(path), mediaType };
      }
      if (!data.bytes.length || data.bytes.length > maxImageBytes)
        throw new DownloaderError("图片为空或超过大小限制");
      if (importedBytes + data.bytes.length > 64 * 1024 * 1024)
        throw new DownloaderError("图片总量超过 64 MiB 限制");
      importedBytes += data.bytes.length;
      images.push({
        reference: image.reference,
        sourceUrl,
        mediaType: data.mediaType,
        dataBase64: data.bytes.toString("base64"),
      });
    } catch (error) {
      warnings.push(
        `图片未导入：${error instanceof Error ? error.message.split(/\r?\n/)[0] : "资源无效"}`,
      );
    }
  }
  return {
    sourcePath,
    identity,
    article: {
      title,
      sourceUrl,
      html: fragment,
      images,
      warnings: [...new Set(warnings)],
      complete: !warnings.length,
      sections: parsed.document.blocks.filter((block) => block.type === "heading").length || 1,
    },
  };
}
