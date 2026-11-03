import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { PDFDocument } from "pdf-lib";
import type { Page } from "playwright-core";
import type { DownloadRequest } from "../../domain.js";
import { DownloaderError, errorMessage } from "../../errors.js";
import { defaultOutputFilename, isWindowsReservedFilename } from "../../filenames.js";
import type { ProgressCallback, SourceAdapter } from "../../ports.js";
import type { BrowserProvider, PaperRounding } from "../browser.js";
import { CamoufoxProvider } from "../camoufox.js";
import { evaluateMainWorld } from "../evaluate.js";
import { expandHomePath, sourceProfileDirectory } from "../paths.js";
import { finalizePdf, normalizePrintedPdf, waitForPdf } from "../pdf.js";
import { PRINT_DOCUMENT_SCRIPT } from "../scribd/scripts.js";
import { writeArticleArchive } from "./archive.js";
import {
  ARTICLE_RESOURCES_SCRIPT,
  ARTICLE_STATUS_SCRIPT,
  CAPTURE_ARTICLE_SCRIPT,
} from "./scripts.js";
import type { ArticleSource, CapturedArticle } from "./types.js";
import { parseArticleUrl } from "./urls.js";

const paper = { width: (210 / 25.4) * 96, height: (297 / 25.4) * 96 };
export interface ArticleOptions {
  readonly profile?: string;
  readonly confirmLogin?: () => Promise<void>;
  readonly timeoutMs?: number;
}

export class ArticleAdapter implements SourceAdapter {
  private readonly profile: string;
  private readonly timeoutMs: number;
  constructor(
    private readonly source: ArticleSource,
    private readonly browsers: BrowserProvider = new CamoufoxProvider(),
    private readonly options: ArticleOptions = {},
  ) {
    this.profile = resolve(expandHomePath(options.profile || sourceProfileDirectory(source)));
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  private async prepareProfile(): Promise<void> {
    await mkdir(this.profile, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(this.profile, 0o700);
  }

  async login(targetUrl?: string): Promise<void> {
    if (!targetUrl)
      throw new DownloaderError(
        `login: 请运行 duckdownloader login --source ${this.source} --url <来源链接>`,
      );
    const ref = parseArticleUrl(this.source, targetUrl);
    await this.prepareProfile();
    const session = await this.browsers.open({ headless: false, profile: this.profile });
    try {
      const page = session.context.pages()[0] || (await session.context.newPage());
      const response = await page.goto(ref.url, {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs,
      });
      if (!response || response.status() >= 400)
        throw new DownloaderError(`login: 页面返回 ${response?.status() ?? "无响应"}`);
      if (this.options.confirmLogin) await this.options.confirmLogin();
      else {
        const reader = createInterface({ input: stdin, output: stdout });
        try {
          await reader.question("请在浏览器中完成登录或访问验证，确认正文可读后回到终端按 Enter：");
        } finally {
          reader.close();
        }
      }
      await this.waitReadable(page, 10_000);
    } finally {
      await session.close();
    }
  }

  private async waitReadable(page: Page, timeout = this.timeoutMs): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const status = await evaluateMainWorld<{
        ready: boolean;
        error?: string;
        needsLogin?: boolean;
      }>(page, ARTICLE_STATUS_SCRIPT, { source: this.source });
      if (status.ready) return;
      if (status.error) throw new DownloaderError(status.error);
      if (status.needsLogin)
        throw new DownloaderError(
          `需要登录：先运行 duckdownloader login --source ${this.source} --url <来源链接>`,
        );
      await delay(500);
    }
    throw new DownloaderError(
      `内容加载超时；请先用 login --source ${this.source} --url <来源链接> 检查登录和访问权限`,
    );
  }

  async download(request: DownloadRequest, progress?: ProgressCallback): Promise<string> {
    const ref = parseArticleUrl(this.source, request.url);
    const requested = request.output ? resolve(expandHomePath(request.output)) : undefined;
    if (process.platform === "win32" && requested && isWindowsReservedFilename(basename(requested)))
      throw new DownloaderError("output: Windows 保留文件名");
    const parent = requested ? dirname(requested) : process.cwd();
    await mkdir(parent, { recursive: true });
    const temporary = await mkdtemp(join(parent, ".duckdownloader-article-"));
    const partial = join(temporary, "document.pdf");
    let archiveDirectory: string | undefined;
    try {
      if (!request.guest) await this.prepareProfile();
      const session = await this.browsers.open({
        headless: true,
        printPath: partial,
        ...(request.guest ? {} : { profile: this.profile }),
      });
      let output: string | undefined;
      let title = "";
      let paperRounding: PaperRounding = "exact";
      let manifest: Awaited<ReturnType<typeof writeArticleArchive>>["manifest"] | undefined;
      try {
        const page = await session.context.newPage();
        const response = await page.goto(ref.url, {
          waitUntil: "domcontentloaded",
          timeout: this.timeoutMs,
        });
        if (!response || response.status() >= 400)
          throw new DownloaderError(`source: 页面返回 ${response?.status() ?? "无响应"}`);
        await this.waitReadable(page);
        const article = await evaluateMainWorld<CapturedArticle>(page, CAPTURE_ARTICLE_SCRIPT, {
          source: this.source,
          timeoutMs: this.timeoutMs,
        });
        if (!article.title || !article.html)
          throw new DownloaderError("source: 提取结果缺少正文或标题");
        parseArticleUrl(this.source, article.sourceUrl);
        title = article.title;
        output = requested || resolve(parent, defaultOutputFilename(title, ref.id));
        archiveDirectory = await mkdtemp(join(parent, `${basename(output)}.archive-`));
        const archive = await writeArticleArchive(
          article,
          this.source,
          archiveDirectory,
          session.context,
        );
        manifest = archive.manifest;
        if (archive.manifest.status === "partial")
          throw new DownloaderError(
            `内容不完整，已保留 ${archiveDirectory}：${archive.manifest.warnings.join("；")}`,
          );
        const printable = await session.context.newPage();
        await printable.route(/^https?:\/\//, (route) => route.abort("blockedbyclient"));
        await printable.goto(pathToFileURL(archive.htmlPath).href, {
          waitUntil: "load",
          timeout: this.timeoutMs,
        });
        if (!(await evaluateMainWorld<boolean>(printable, ARTICLE_RESOURCES_SCRIPT)))
          throw new DownloaderError("print: 本地图片未完整加载");
        if (session.printPdf) ({ paperRounding } = await session.printPdf(printable, paper));
        else await evaluateMainWorld(printable, PRINT_DOCUMENT_SCRIPT);
        await waitForPdf(partial);
      } finally {
        await session.close();
      }
      if (!output || !manifest || !archiveDirectory)
        throw new DownloaderError("PDF: 没有完成的文档");
      await normalizePrintedPdf(partial, paper, title, paperRounding);
      const pages = (await PDFDocument.load(await readFile(partial))).getPageCount();
      progress?.(pages, pages);
      manifest.pdf = output;
      manifest.pdfPages = pages;
      await writeFile(
        join(archiveDirectory, "artifact.json"),
        JSON.stringify(manifest, null, 2),
        "utf8",
      );
      await finalizePdf(partial, output, pages);
      return output;
    } catch (error) {
      if (archiveDirectory) {
        const path = join(archiveDirectory, "artifact.json");
        try {
          const manifest = JSON.parse(await readFile(path, "utf8"));
          manifest.status = "partial";
          delete manifest.pdf;
          delete manifest.pdfPages;
          manifest.warnings.push(errorMessage(error));
          await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
        } catch {}
      }
      if (error instanceof DownloaderError) throw error;
      throw new DownloaderError(`${this.source}: 下载失败 (${errorMessage(error)})`, {
        cause: error,
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
