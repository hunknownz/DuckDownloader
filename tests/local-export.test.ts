import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import type { BrowserContext, Page } from "playwright-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserProvider } from "../src/adapters/browser.js";
import { SavedPageAdapter } from "../src/adapters/document/local.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "duckdownloader-local-export-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
function browserFixture(onClose?: () => Promise<void>) {
  let path = "";
  const evaluate = vi.fn(async (script: string) => {
    if (script.includes("window.print()")) {
      const pdf = await PDFDocument.create();
      pdf.addPage([(210 / 25.4) * 72, (297 / 25.4) * 72]).drawText("Local native text");
      await writeFile(path, await pdf.save());
    }
    return true;
  });
  const page = {
    evaluate,
    goto: vi.fn(async () => {}),
    route: vi.fn(async () => {}),
  } as unknown as Page;
  const close = vi.fn(async () => {
    await onClose?.();
  });
  const open = vi.fn(async (options: { printPath?: string }) => {
    path = options.printPath!;
    return { context: { newPage: async () => page } as unknown as BrowserContext, close };
  });
  return { provider: { open } satisfies BrowserProvider, open, close, page };
}

it("retypesets a local file, exports PDF, then removes the explicitly selected source and owned intermediates", async () => {
  const input = join(directory, "saved.html"),
    output = join(directory, "result.pdf");
  await writeFile(input, "<title>Local</title><main><h2>First</h2><p>Native local text</p></main>");
  const browser = browserFixture();
  await new SavedPageAdapter(browser.provider).convert({ input, output, cleanupSource: true });
  expect(await readdir(directory)).toEqual(["result.pdf"]);
  expect(browser.close).toHaveBeenCalledOnce();
  expect(vi.mocked(browser.page.goto).mock.calls.every(([url]) => url.startsWith("file:"))).toBe(
    true,
  );
});

it("preserves the source file by default and can retain intermediate content on request", async () => {
  const input = join(directory, "saved.html"),
    output = join(directory, "result.pdf");
  await writeFile(input, "<main><p>Body</p></main>");
  await new SavedPageAdapter(browserFixture().provider).convert({
    input,
    output,
    keepIntermediates: true,
  });
  expect(await readFile(input, "utf8")).toContain("Body");
  expect((await readdir(directory)).some((name) => name.startsWith("result.pdf.archive-"))).toBe(
    true,
  );
});

it("keeps the source, partial content and an existing PDF if any local image is missing", async () => {
  const input = join(directory, "saved.html"),
    output = join(directory, "existing.pdf");
  await writeFile(
    input,
    '<main><p>Keep body</p><img src="https://example.test/missing.png"></main>',
  );
  await writeFile(output, "existing");
  const browser = browserFixture();
  await expect(
    new SavedPageAdapter(browser.provider).convert({ input, output, cleanupSource: true }),
  ).rejects.toThrow(/不完整/);
  expect(await readFile(output, "utf8")).toBe("existing");
  expect(await readFile(input, "utf8")).toContain("Keep body");
  expect(browser.open).not.toHaveBeenCalled();
  const archive = (await readdir(directory)).find((name) => name.includes(".archive-"))!;
  expect(JSON.parse(await readFile(join(directory, archive, "artifact.json"), "utf8")).status).toBe(
    "partial",
  );
});

it("does not delete an input that changed while PDF export was running", async () => {
  const input = join(directory, "saved.html"),
    output = join(directory, "result.pdf");
  await writeFile(input, "<main><p>Original body</p></main>");
  const warn = vi.fn();
  const browser = browserFixture(async () => {
    await writeFile(input, "<main><p>New content created by the user</p></main>");
  });
  await new SavedPageAdapter(browser.provider, { warn }).convert({
    input,
    output,
    cleanupSource: true,
  });
  expect(await readFile(input, "utf8")).toContain("New content");
  expect(warn).toHaveBeenCalledOnce();
});

it("rejects URL inputs and source/output path collisions before launching a browser", async () => {
  const browser = browserFixture(),
    input = join(directory, "saved.html");
  await writeFile(input, "<main><p>Body</p></main>");
  const adapter = new SavedPageAdapter(browser.provider);
  await expect(adapter.convert({ input: "https://example.test/article" })).rejects.toThrow(/本地/);
  await expect(adapter.convert({ input, output: input, cleanupSource: true })).rejects.toThrow(
    /PDF|输出/,
  );
  expect(browser.open).not.toHaveBeenCalled();
  expect(await readFile(input, "utf8")).toContain("Body");
});

it.each(["print", "close"] as const)(
  "keeps the source and existing PDF after a %s failure",
  async (stage) => {
    const input = join(directory, "saved.html"),
      output = join(directory, "existing.pdf");
    await writeFile(input, "<main><p>Original body</p></main>");
    await writeFile(output, "existing PDF");
    const browser = browserFixture(
      stage === "close"
        ? async () => {
            throw new Error("close failed");
          }
        : undefined,
    );
    if (stage === "print")
      vi.mocked(browser.page.evaluate).mockRejectedValueOnce(new Error("print failed"));
    await expect(
      new SavedPageAdapter(browser.provider).convert({ input, output, cleanupSource: true }),
    ).rejects.toThrow(`${stage} failed`);
    expect(browser.close).toHaveBeenCalledOnce();
    expect(await readFile(input, "utf8")).toContain("Original body");
    expect(await readFile(output, "utf8")).toBe("existing PDF");
    const archive = (await readdir(directory)).find((name) => name.includes(".archive-"))!;
    expect(
      JSON.parse(await readFile(join(directory, archive, "artifact.json"), "utf8")).status,
    ).toBe("partial");
    expect(
      (await readdir(directory)).some((name) => name.startsWith(".duckdownloader-layout-")),
    ).toBe(false);
  },
);

it("keeps user resource directories after cleanup and waits for browser close before deleting the source", async () => {
  const input = join(directory, "saved.html"),
    output = join(directory, "reading.pdf");
  await writeFile(input, "<main><p>Original body</p></main>");
  await mkdir(join(directory, "user-assets"));
  await writeFile(join(directory, "user-assets", "keep.txt"), "User resource");
  const browser = browserFixture(async () => {
    expect(await readFile(input, "utf8")).toContain("Original body");
  });
  await new SavedPageAdapter(browser.provider).convert({ input, output, cleanupSource: true });
  expect((await readdir(directory)).sort()).toEqual(["reading.pdf", "user-assets"]);
  expect(await readFile(join(directory, "user-assets", "keep.txt"), "utf8")).toBe("User resource");
});
