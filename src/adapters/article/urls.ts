import { createHash } from "node:crypto";
import { DownloaderError } from "../../errors.js";
import type { ArticleSource } from "./types.js";

export function parseArticleUrl(source: ArticleSource, input: string): { url: string; id: string } {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    throw new DownloaderError(`${source}: 只接受不含账号密码和非标准端口的 HTTPS 链接`);
  url.hash = "";
  if (source === "wechat") {
    if (
      url.hostname !== "mp.weixin.qq.com" ||
      !(
        /^\/s\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) ||
        (url.pathname === "/s" &&
          url.searchParams.has("__biz") &&
          /^\d+$/.test(url.searchParams.get("mid") || "") &&
          /^\d+$/.test(url.searchParams.get("idx") || ""))
      )
    )
      throw new DownloaderError("wechat: 只支持微信公众号文章 /s 链接");
  } else if (
    !/\.(?:feishu\.cn|larksuite\.com)$/.test(url.hostname) ||
    !/^\/docx\/[A-Za-z0-9]+\/?$/.test(url.pathname)
  )
    throw new DownloaderError("feishu: 只支持飞书 / Lark docx 链接；wiki、表格与多维表格尚未适配");
  return { url: url.href, id: createHash("sha256").update(url.href).digest("hex").slice(0, 12) };
}
