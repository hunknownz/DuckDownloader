import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PDFDocument } from "pdf-lib";
import { DownloaderError, errorMessage } from "../../errors.js";
import type { ProgressCallback } from "../../ports.js";
import { ARTICLE_RESOURCES_SCRIPT } from "../article/scripts.js";
import type { BrowserSession, PaperRounding } from "../browser.js";
import { evaluateMainWorld } from "../evaluate.js";
import { finalizePdf, normalizePrintedPdf, waitForPdf } from "../pdf.js";
import { PRINT_DOCUMENT_SCRIPT } from "../scribd/scripts.js";

export const documentPaper = { width: (210 / 25.4) * 96, height: (297 / 25.4) * 96 };
export type WarningReporter = (message: string) => void;
export const reportWarning: WarningReporter = (message) =>
  process.stderr.write(`warning: ${message}\n`);

export async function printDocument(
  session: BrowserSession,
  htmlPath: string,
  pdfPath: string,
  timeoutMs = 120_000,
): Promise<PaperRounding> {
  const page = await session.context.newPage();
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("data:")) return route.continue();
    if (url.startsWith("file:")) {
      const path = relative(dirname(htmlPath), fileURLToPath(url));
      if (!isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"))
        return route.continue();
    }
    return route.abort("blockedbyclient");
  });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: timeoutMs });
  if (!(await evaluateMainWorld<boolean>(page, ARTICLE_RESOURCES_SCRIPT)))
    throw new DownloaderError("print: 排版后的本地图片未完整加载");
  let rounding: PaperRounding = "exact";
  if (session.printPdf) ({ paperRounding: rounding } = await session.printPdf(page, documentPaper));
  else await evaluateMainWorld(page, PRINT_DOCUMENT_SCRIPT);
  await waitForPdf(pdfPath);
  return rounding;
}

export async function finishDocumentPdf(options: {
  partial: string;
  output: string;
  title: string;
  rounding: PaperRounding;
  archive: string;
  keepIntermediates?: boolean;
  progress?: ProgressCallback;
  warn?: WarningReporter;
}): Promise<string> {
  await normalizePrintedPdf(options.partial, documentPaper, options.title, options.rounding);
  const pages = (await PDFDocument.load(await readFile(options.partial))).getPageCount();
  options.progress?.(pages, pages);
  const manifestPath = join(options.archive, "artifact.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.pdf = options.output;
  manifest.pdfPages = pages;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  await finalizePdf(options.partial, options.output, pages);
  if (!options.keepIntermediates) {
    try {
      await rm(options.archive, { recursive: true, force: true });
    } catch {
      (options.warn || reportWarning)(`PDF 已生成，但中间目录未能清理：${options.archive}`);
    }
  }
  return options.output;
}

export async function recordDocumentFailure(directory: string, error: unknown): Promise<void> {
  const path = join(directory, "artifact.json");
  const reason = errorMessage(error).split(/\r?\n/)[0]!;
  let manifest: { status: string; warnings: string[]; pdf?: string; pdfPages?: number };
  try {
    manifest = JSON.parse(await readFile(path, "utf8"));
  } catch {
    manifest = { status: "partial", warnings: [] };
  }
  manifest.status = "partial";
  delete manifest.pdf;
  delete manifest.pdfPages;
  if (!manifest.warnings.includes(reason)) manifest.warnings.push(reason);
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
}
