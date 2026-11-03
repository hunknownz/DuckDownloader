import { describe, expect, it } from "vitest";
import { parseArticleUrl } from "../src/adapters/article/urls.js";
import { resolveSource } from "../src/service.js";

describe("article source boundaries", () => {
  it.each([
    ["https://mp.weixin.qq.com/s/Article123_-", "wechat"],
    ["https://mp.weixin.qq.com/s?__biz=abc&mid=123&idx=1&sn=abc", "wechat"],
    ["https://tenant.feishu.cn/docx/Document123", "feishu"],
    ["https://tenant.larksuite.com/docx/Abc123", "feishu"],
  ] as const)("routes and validates %s", (url, source) => {
    expect(resolveSource(url).id).toBe(source);
    expect(parseArticleUrl(source, `${url}#section`).url).toBe(url);
  });

  it.each([
    ["wechat", "https://mp.weixin.qq.com/"],
    ["wechat", "https://mp.weixin.qq.com/s?foo=bar"],
    ["wechat", "https://mp.weixin.qq.com.evil.test/s/abc"],
    ["wechat", "http://mp.weixin.qq.com/s/abc"],
    ["feishu", "https://tenant.feishu.cn/wiki/abc"],
    ["feishu", "https://tenant.feishu.cn/sheets/abc"],
    ["feishu", "https://tenant.feishu.cn.evil.test/docx/abc"],
    ["feishu", "https://user:secret@tenant.feishu.cn/docx/abc"],
    ["feishu", "https://tenant.feishu.cn:9000/docx/abc"],
    ["feishu", "http://tenant.feishu.cn/docx/abc"],
  ] as const)("rejects %s input %s before browser work", (source, url) => {
    expect(() => parseArticleUrl(source, url)).toThrow();
  });
});
