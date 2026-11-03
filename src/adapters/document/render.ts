import type { DocumentBlock, DocumentContent, DocumentInline } from "../../domain.js";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function inline(parts: readonly DocumentInline[]): string {
  return parts
    .map((part) => {
      if (part.type === "text") return escapeHtml(part.text);
      if (part.type === "break") return "<br>";
      const text = inline(part.children);
      if (part.type === "link")
        return /^https?:\/\//.test(part.href)
          ? `<a href="${escapeHtml(part.href)}">${text}</a>`
          : text;
      const tag = part.type === "strong" ? "strong" : part.type === "emphasis" ? "em" : "code";
      return `<${tag}>${text}</${tag}>`;
    })
    .join("");
}

export function renderBody(
  blocks: readonly DocumentBlock[],
  assets: ReadonlyMap<string, string>,
): string {
  function block(value: DocumentBlock): string {
    switch (value.type) {
      case "paragraph":
        return `<p>${inline(value.content)}</p>`;
      case "heading": {
        const level = Math.max(2, Math.min(6, value.level));
        return `<h${level}>${inline(value.content)}</h${level}>`;
      }
      case "image": {
        const path = assets.get(value.reference);
        return path
          ? `<figure><img src="${escapeHtml(path)}" alt="${escapeHtml(value.alt)}">${value.caption ? `<figcaption>${inline(value.caption)}</figcaption>` : ""}</figure>`
          : '<p class="missing">[Image unavailable]</p>';
      }
      case "list": {
        const tag = value.ordered ? "ol" : "ul";
        return `<${tag}${value.ordered ? ` start="${value.start}"` : ""}>${value.items.map((item) => `<li>${renderBody(item, assets)}</li>`).join("")}</${tag}>`;
      }
      case "quote":
        return `<blockquote>${renderBody(value.blocks, assets)}</blockquote>`;
      case "code":
        return `<pre><code>${escapeHtml(value.text)}</code></pre>`;
      case "divider":
        return "<hr>";
      case "table":
        return `<table>${value.rows
          .map(
            (row) =>
              `<tr>${row
                .map((cell) => {
                  const tag = cell.header ? "th" : "td";
                  return `<${tag} colspan="${cell.colSpan}" rowspan="${cell.rowSpan}">${renderBody(cell.blocks, assets)}</${tag}>`;
                })
                .join("")}</tr>`,
          )
          .join("")}</table>`;
    }
  }
  let result = "";
  for (let i = 0; i < blocks.length; i++) {
    const current = blocks[i]!;
    const next = blocks[i + 1];
    if (current.type === "heading" && (next?.type === "image" || next?.type === "paragraph")) {
      result += `<section class="lead-pair">${block(current)}${block(next)}</section>`;
      i++;
    } else result += block(current);
  }
  return result;
}

export function renderDocument(
  document: DocumentContent,
  assets: ReadonlyMap<string, string>,
): string {
  const source = /^https?:\/\//.test(document.sourceUrl)
    ? `<a href="${escapeHtml(document.sourceUrl)}">${escapeHtml(document.sourceUrl)}</a>`
    : "本地保存的网页";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data:; style-src 'unsafe-inline';"><title>${escapeHtml(document.title)}</title><style>
@page{size:210mm 297mm;margin:0}*{box-sizing:border-box}html,body{margin:0;background:#fff;color:#202124;font:16px/1.85 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}main{box-decoration-break:clone;padding:18mm;max-width:210mm;margin:auto;overflow-wrap:anywhere}h1{font-size:28px;line-height:1.4;margin:0 0 7mm}h2{font-size:22px}h3{font-size:19px}h4,h5,h6{font-size:17px}h2,h3,h4,h5,h6{line-height:1.5;margin:7mm 0 3mm;break-after:avoid}p{margin:0 0 3.5mm;orphans:3;widows:3}.source{font-size:11px;color:#666;border-bottom:1px solid #ddd;padding-bottom:4mm;margin-bottom:7mm}figure{margin:4mm 0;break-inside:avoid}figure img{display:block;width:auto;height:auto;max-width:100%;max-height:210mm;margin:auto;object-fit:contain}figcaption{font-size:12px;line-height:1.6;color:#666;text-align:center;margin-top:2mm}.lead-pair{break-inside:avoid}blockquote{border-left:3px solid #427b69;background:#f4f8f6;margin:4mm 0;padding:3mm 4mm}blockquote p:last-child,li p:last-child,td p:last-child,th p:last-child{margin-bottom:0}ul,ol{padding-left:7mm;margin:3mm 0}li{padding-left:1mm;margin-bottom:2mm}pre{white-space:pre-wrap;background:#f5f6f7;padding:4mm;font:13px/1.65 ui-monospace,monospace}code{font-family:ui-monospace,monospace}table{border-collapse:collapse;width:100%;table-layout:fixed;margin:4mm 0;font-size:13px;line-height:1.6}td,th{border:1px solid #cdd4d1;padding:2mm;vertical-align:top}th{background:#eef3f1}tr{break-inside:avoid}hr{border:0;border-top:1px solid #ccd4d1;margin:6mm 0}a{color:#166b50}.missing{color:#a33}
</style></head><body><main><header><h1>${escapeHtml(document.title)}</h1><p class="source">${source}</p></header><article>${renderBody(document.blocks, assets)}</article></main></body></html>`;
}
