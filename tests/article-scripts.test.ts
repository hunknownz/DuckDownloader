import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { ARTICLE_STATUS_SCRIPT, CAPTURE_ARTICLE_SCRIPT } from "../src/adapters/article/scripts.js";
import type { CapturedArticle } from "../src/adapters/article/types.js";
import { mainWorldCall } from "../src/adapters/evaluate.js";

function fixture(body: string, url: string, loaded = true) {
  const { document } = parseHTML(`<!doctype html><html><body>${body}</body></html>`);
  const originalCreate = document.createElement.bind(document);
  document.createElement = ((tag: string) =>
    tag === "canvas"
      ? {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage() {} }),
          toDataURL: () => "data:image/png;base64,aW1hZ2U=",
        }
      : originalCreate(tag)) as typeof document.createElement;
  for (const image of document.querySelectorAll("img"))
    Object.defineProperties(image, {
      complete: { value: loaded },
      naturalWidth: { value: loaded ? 1280 : 0 },
      naturalHeight: { value: loaded ? 720 : 0 },
    });
  const scroller = document.querySelector(".bear-web-x-container") || document.documentElement;
  Object.defineProperties(scroller, {
    clientHeight: { value: 600 },
    scrollHeight: { value: 600 },
    scrollTop: { value: 0, writable: true },
  });
  const context = { document, location: new URL(url), URL, setTimeout };
  return {
    document,
    scroller,
    run: <T>(script: string, args: unknown) =>
      runInNewContext(mainWorldCall(script, args).slice(3), context) as T,
  };
}

describe("article page scripts", () => {
  it("collects WeChat text and loaded images without including active page scripts", async () => {
    const f = fixture(
      '<h1 id="activity-name">Article</h1><div id="js_content"><p onclick="bad()">Readable <strong>text</strong></p><script>secret()</script><img src="https://mmbiz.qpic.cn/image.png"><a href="javascript:bad()">unsafe</a></div>',
      "https://mp.weixin.qq.com/s/abc",
    );
    const result = await f.run<Promise<CapturedArticle>>(CAPTURE_ARTICLE_SCRIPT, {
      source: "wechat",
      stepDelayMs: 0,
    });
    expect(result.title).toBe("Article");
    expect(result.complete).toBe(true);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.dataBase64).toBeUndefined();
    expect(result.html).toContain("<strong>text</strong>");
    expect(result.html).not.toMatch(/onclick|secret\(\)|javascript:/);
  });

  it("retains Feishu blob images and checks document-outline completeness", async () => {
    const body =
      '<div class="bear-web-x-container"><div class="catalogue__scroller"><a href="#h1">First</a></div><div class="editor-kit-container"><h1><span class="page-block-title-icon">💡<script>window.emojiSupportCheck()</script></span>Title</h1><div data-block-id="2" data-record-id="h1" data-block-type="heading1"><div class="ace-line">First</div></div><div data-block-id="3" data-record-id="image" data-block-type="image"><img src="blob:https://tenant.feishu.cn/image-id"></div></div></div>';
    const f = fixture(body, "https://tenant.feishu.cn/docx/Abc123");
    const result = await f.run<Promise<CapturedArticle>>(CAPTURE_ARTICLE_SCRIPT, {
      source: "feishu",
      stepDelayMs: 0,
    });
    expect(result.complete).toBe(true);
    expect(result.title).toBe("Title");
    expect(result.sections).toBe(1);
    expect(result.html).toContain("blob:https://tenant.feishu.cn/image-id");
    expect(result.images[0]?.dataBase64).toBe("aW1hZ2U=");
    expect(result.images[0]?.sourceUrl).toBe("https://tenant.feishu.cn/docx/Abc123");
    f.document.querySelector(".catalogue__scroller")!.innerHTML +=
      '<a href="#last">Missing last section</a>';
    const incomplete = await f.run<Promise<CapturedArticle>>(CAPTURE_ARTICLE_SCRIPT, {
      source: "feishu",
      stepDelayMs: 0,
    });
    expect(incomplete.complete).toBe(false);
    expect(incomplete.warnings.join("\n")).toContain("Missing last section");
  });

  it("reports explicit verification and permission denials", () => {
    const verify = fixture("请完成验证", "https://mp.weixin.qq.com/s/abc");
    expect(
      verify.run<{ ready: boolean; error: string }>(ARTICLE_STATUS_SCRIPT, { source: "wechat" })
        .error,
    ).toContain("手动");
    const denied = fixture("You don't have permission", "https://tenant.feishu.cn/docx/abc");
    expect(
      denied.run<{ ready: boolean; error: string }>(ARTICLE_STATUS_SCRIPT, { source: "feishu" })
        .error,
    ).toContain("权限");
  });

  it("retains readable text but marks unsupported embedded media as partial", async () => {
    const f = fixture(
      '<h1 id="activity-name">Media article</h1><div id="js_content"><p>Available text</p><iframe src="https://example.test/video"></iframe></div>',
      "https://mp.weixin.qq.com/s/abc",
    );
    const result = await f.run<Promise<CapturedArticle>>(CAPTURE_ARTICLE_SCRIPT, {
      source: "wechat",
      stepDelayMs: 0,
    });
    expect(result.html).toContain("Available text");
    expect(result.html).not.toContain("iframe");
    expect(result.complete).toBe(false);
    expect(result.warnings.join(" ")).toContain("媒体");
  });

  it("marks images without a usable address as incomplete", async () => {
    const f = fixture(
      '<h1 id="activity-name">Broken image</h1><div id="js_content"><p>Readable</p><img></div>',
      "https://mp.weixin.qq.com/s/abc",
    );
    const result = await f.run<Promise<CapturedArticle>>(CAPTURE_ARTICLE_SCRIPT, {
      source: "wechat",
      stepDelayMs: 0,
    });
    expect(result.complete).toBe(false);
    expect(result.warnings.join(" ")).toContain("图片");
  });

  it("discovers lazy HTTP images for the authenticated resource-download stage", async () => {
    const f = fixture(
      '<h1 id="activity-name">Lazy article</h1><div id="js_content"><img data-src="https://mmbiz.qpic.cn/real.png" src="data:image/png;base64,cGxhY2Vob2xkZXI="></div>',
      "https://mp.weixin.qq.com/s/abc",
      false,
    );
    const result = await f.run<Promise<CapturedArticle>>(CAPTURE_ARTICLE_SCRIPT, {
      source: "wechat",
      stepDelayMs: 0,
    });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.sourceUrl).toBe("https://mmbiz.qpic.cn/real.png");
    expect(result.html).toContain("https://mmbiz.qpic.cn/real.png");
    expect(result.complete).toBe(true);
  });
});
