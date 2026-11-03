import { parseHTML } from "linkedom";
import type { DocumentBlock, DocumentCell, DocumentContent, DocumentInline } from "../../domain.js";
import { DownloaderError } from "../../errors.js";

interface TreeNode {
  nodeType: number;
  textContent: string | null;
  childNodes: Iterable<TreeNode>;
}
interface TreeElement extends TreeNode {
  tagName: string;
  children: Iterable<TreeElement>;
  getAttribute(name: string): string | null;
  querySelector(selector: string): TreeElement | null;
  querySelectorAll(selector: string): Iterable<TreeElement>;
  closest(selector: string): TreeElement | null;
  remove(): void;
}
const clean = (text: string) => text.replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, "");
const ignored = new Set([
  "script",
  "style",
  "noscript",
  "link",
  "meta",
  "base",
  "form",
  "button",
  "input",
  "textarea",
  "nav",
]);
const media = new Set([
  "canvas",
  "math",
  "iframe",
  "video",
  "audio",
  "object",
  "embed",
  "mp-video",
  "mpvoice",
  "mp-common-videosnap",
  "svg",
]);
const inlineTags = new Set([
  "span",
  "a",
  "strong",
  "b",
  "em",
  "i",
  "code",
  "u",
  "s",
  "small",
  "sup",
  "sub",
  "mark",
]);
const blockSelector =
  "img,p,div,section,article,figure,table,ul,ol,blockquote,pre,h1,h2,h3,h4,h5,h6";

export function parseDocumentContent(input: { title: string; sourceUrl: string; html: string }): {
  document: DocumentContent;
  warnings: string[];
} {
  if (Buffer.byteLength(input.html, "utf8") > 20 * 1024 * 1024)
    throw new DownloaderError("document: 正文超过 20 MiB 限制");
  const root = parseHTML(`<!doctype html><html><body>${input.html}</body></html>`).document
    .body as unknown as TreeElement;
  const warnings: string[] = [];
  let visited = 0;
  function count(depth: number) {
    if (++visited > 100_000 || depth > 100)
      throw new DownloaderError("document: 内容结构过大或嵌套过深");
  }
  function inlines(node: TreeNode, depth: number): DocumentInline[] {
    count(depth);
    if (node.nodeType === 3) return [{ type: "text", text: clean(node.textContent || "") }];
    if (node.nodeType !== 1) return [];
    const e = node as TreeElement,
      tag = e.tagName.toLowerCase();
    if (ignored.has(tag) || tag === "img") return [];
    if (media.has(tag)) {
      warnings.push(`尚未完整导出的嵌入媒体：${tag}`);
      return [];
    }
    if (tag === "br") return [{ type: "break" }];
    const children = [...e.childNodes].flatMap((child) => inlines(child, depth + 1));
    const type =
      tag === "strong" || tag === "b"
        ? "strong"
        : tag === "em" || tag === "i"
          ? "emphasis"
          : tag === "code"
            ? "code"
            : undefined;
    if (type) return [{ type, children }];
    if (tag === "a") {
      const href = e.getAttribute("href") || "";
      try {
        const url = new URL(href, input.sourceUrl || undefined);
        if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password)
          return [{ type: "link", href: url.href, children }];
      } catch {}
    }
    return children;
  }
  function hasText(content: readonly DocumentInline[]): boolean {
    return content.some((part) =>
      part.type === "text"
        ? !!part.text.trim()
        : part.type === "break"
          ? false
          : hasText(part.children),
    );
  }
  function blocks(parent: TreeElement, depth: number): DocumentBlock[] {
    count(depth);
    const result: DocumentBlock[] = [];
    let pending: DocumentInline[] = [];
    const flush = () => {
      if (hasText(pending)) result.push({ type: "paragraph", content: pending });
      pending = [];
    };
    for (const node of parent.childNodes) {
      if (node.nodeType === 3) {
        pending.push(...inlines(node, depth + 1));
        continue;
      }
      if (node.nodeType !== 1) continue;
      const e = node as TreeElement,
        tag = e.tagName.toLowerCase();
      if (ignored.has(tag)) continue;
      if (media.has(tag)) {
        warnings.push(`尚未完整导出的嵌入媒体：${tag}`);
        continue;
      }
      if (tag === "br") {
        pending.push({ type: "break" });
        continue;
      }
      if (inlineTags.has(tag) && !e.querySelector(blockSelector)) {
        pending.push(...inlines(e, depth + 1));
        continue;
      }
      flush();
      if (tag === "img") {
        const reference = e.getAttribute("data-src") || e.getAttribute("src") || "";
        if (reference) result.push({ type: "image", reference, alt: e.getAttribute("alt") || "" });
        else warnings.push("图片缺少可用地址");
      } else if (/^h[1-6]$/.test(tag)) {
        const content = [...e.childNodes].flatMap((child) => inlines(child, depth + 1));
        if (hasText(content))
          result.push({ type: "heading", level: Math.max(2, Number(tag[1])), content });
      } else if (tag === "ul" || tag === "ol") {
        const start = Number(e.getAttribute("start") || 1);
        result.push({
          type: "list",
          ordered: tag === "ol",
          start: Number.isInteger(start) && start > 0 ? start : 1,
          items: [...e.children]
            .filter((child) => child.tagName.toLowerCase() === "li")
            .map((child) => blocks(child, depth + 1)),
        });
      } else if (tag === "blockquote") result.push({ type: "quote", blocks: blocks(e, depth + 1) });
      else if (tag === "pre") result.push({ type: "code", text: clean(e.textContent || "") });
      else if (tag === "hr") result.push({ type: "divider" });
      else if (tag === "table") {
        const rows = [...e.querySelectorAll("tr")]
          .filter((row) => row.closest("table") === e)
          .map((row) =>
            [...row.children]
              .filter((cell) => ["th", "td"].includes(cell.tagName.toLowerCase()))
              .map(
                (cell): DocumentCell => ({
                  header: cell.tagName.toLowerCase() === "th",
                  colSpan: Math.min(32, Math.max(1, Number(cell.getAttribute("colspan")) || 1)),
                  rowSpan: Math.min(100, Math.max(1, Number(cell.getAttribute("rowspan")) || 1)),
                  blocks: blocks(cell, depth + 1),
                }),
              ),
          );
        result.push({ type: "table", rows });
      } else if (tag === "figure") {
        const caption = e.querySelector("figcaption");
        const content = caption
          ? [...caption.childNodes].flatMap((child) => inlines(child, depth + 1))
          : undefined;
        caption?.remove();
        const children = blocks(e, depth + 1);
        let index = children.length - 1;
        while (index >= 0 && children[index]?.type !== "image") index--;
        const image = children[index];
        if (content && image?.type === "image") children[index] = { ...image, caption: content };
        result.push(...children);
      } else result.push(...blocks(e, depth + 1));
    }
    flush();
    return result;
  }
  const content = blocks(root, 0);
  if (!content.length) throw new DownloaderError("document: 未找到可排版的正文");
  return {
    document: { title: input.title, sourceUrl: input.sourceUrl, blocks: content },
    warnings: [...new Set(warnings)],
  };
}

export function documentImages(
  blocks: readonly DocumentBlock[],
): Array<Extract<DocumentBlock, { type: "image" }>> {
  return blocks.flatMap((block) =>
    block.type === "image"
      ? [block]
      : block.type === "quote"
        ? documentImages(block.blocks)
        : block.type === "list"
          ? block.items.flatMap(documentImages)
          : block.type === "table"
            ? block.rows.flatMap((row) => row.flatMap((cell) => documentImages(cell.blocks)))
            : [],
  );
}
