import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PDFDocument } from "pdf-lib";
import type { Page, Route } from "playwright-core";
import { expect, it, vi } from "vitest";
import type { BrowserSession } from "../src/adapters/browser.js";
import { printDocument, recordDocumentFailure } from "../src/adapters/document/export.js";

it("prints only local archive assets and preserves the native backend's rounding contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "document-print-"));
  const output = join(directory, "document.pdf"),
    html = join(directory, "article.html");
  const route = vi.fn(),
    printPdf = vi.fn(async () => ({ paperRounding: "ceil" as const }));
  const page = {
    route,
    goto: vi.fn(async () => {}),
    evaluate: vi.fn(async () => true),
  } as unknown as Page;
  const session = { context: { newPage: async () => page }, printPdf } as unknown as BrowserSession;
  try {
    const pdf = await PDFDocument.create();
    pdf.addPage().drawText("Native text");
    await writeFile(output, await pdf.save());
    expect(await printDocument(session, html, output)).toBe("ceil");
    expect(printPdf).toHaveBeenCalledOnce();
    const handler = route.mock.calls[0]![1] as (route: Route) => Promise<void>;
    for (const [url, allowed] of [
      [pathToFileURL(join(directory, "assets", "a.png")).href, true],
      ["data:image/png;base64,aW1hZ2U=", true],
      [pathToFileURL(join(directory, "..", "private.png")).href, false],
      ["https://mmbiz.qpic.cn/image.png", false],
    ] as const) {
      const proceed = vi.fn(async () => {}),
        abort = vi.fn(async () => {});
      await handler({
        request: () => ({ url: () => url }),
        continue: proceed,
        abort,
      } as unknown as Route);
      expect(proceed).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(abort).toHaveBeenCalledTimes(allowed ? 0 : 1);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects incomplete local images before calling the native PDF backend", async () => {
  const printPdf = vi.fn();
  const page = {
    route: vi.fn(async () => {}),
    goto: vi.fn(async () => {}),
    evaluate: vi.fn(async () => false),
  };
  const session = { context: { newPage: async () => page }, printPdf } as unknown as BrowserSession;
  await expect(
    printDocument(session, "/archive/article.html", "/archive/article.pdf"),
  ).rejects.toThrow("图片未完整加载");
  expect(printPdf).not.toHaveBeenCalled();
});

it("records a failed export even when no archive manifest could be written", async () => {
  const directory = await mkdtemp(join(tmpdir(), "document-failed-manifest-"));
  try {
    await recordDocumentFailure(directory, new Error("Native print failed\nprivate details"));
    await recordDocumentFailure(directory, new Error("Native print failed"));
    expect(JSON.parse(await readFile(join(directory, "artifact.json"), "utf8"))).toEqual({
      status: "partial",
      warnings: ["Native print failed"],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
