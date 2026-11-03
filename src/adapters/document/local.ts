import { lstat, mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { LocalExportRequest } from "../../domain.js";
import { DownloaderError, errorMessage } from "../../errors.js";
import { defaultOutputFilename, isWindowsReservedFilename } from "../../filenames.js";
import type { ProgressCallback, SavedPageConverter } from "../../ports.js";
import { writeArticleArchive } from "../article/archive.js";
import type { BrowserProvider, PaperRounding } from "../browser.js";
import { CamoufoxProvider } from "../camoufox.js";
import { expandHomePath } from "../paths.js";
import {
  finishDocumentPdf,
  printDocument,
  recordDocumentFailure,
  reportWarning,
  type WarningReporter,
} from "./export.js";
import { readSavedPage } from "./saved-page.js";

export class SavedPageAdapter implements SavedPageConverter {
  constructor(
    private readonly browsers: BrowserProvider = new CamoufoxProvider(),
    private readonly options: { warn?: WarningReporter } = {},
  ) {}
  async convert(request: LocalExportRequest, progress?: ProgressCallback): Promise<string> {
    const imported = await readSavedPage(request);
    const output = request.output
      ? resolve(expandHomePath(request.output))
      : join(
          dirname(imported.sourcePath),
          defaultOutputFilename(imported.article.title, "saved-page"),
        );
    if (extname(output).toLowerCase() !== ".pdf" || output === imported.sourcePath)
      throw new DownloaderError("convert: 输出必须是独立的 PDF 文件");
    if (process.platform === "win32" && isWindowsReservedFilename(basename(output)))
      throw new DownloaderError("output: Windows 保留文件名");
    await mkdir(dirname(output), { recursive: true });
    const temporary = await mkdtemp(join(dirname(output), ".duckdownloader-layout-"));
    const partial = join(temporary, "document.pdf");
    let archive: string | undefined;
    try {
      archive = await mkdtemp(join(dirname(output), `${basename(output)}.archive-`));
      const staged = await writeArticleArchive(imported.article, "saved-page", archive);
      if (staged.manifest.status !== "succeeded")
        throw new DownloaderError(
          `内容不完整，已保留 ${archive}：${staged.manifest.warnings.join("；")}`,
        );
      const session = await this.browsers.open({ headless: true, printPath: partial });
      let rounding: PaperRounding = "exact";
      try {
        rounding = await printDocument(session, staged.htmlPath, partial);
      } finally {
        await session.close();
      }
      const result = await finishDocumentPdf({
        partial,
        output,
        title: imported.article.title,
        rounding,
        archive,
        ...(request.keepIntermediates ? { keepIntermediates: true } : {}),
        ...(progress ? { progress } : {}),
        ...(this.options.warn ? { warn: this.options.warn } : {}),
      });
      if (request.cleanupSource) {
        const warn = this.options.warn || reportWarning;
        try {
          const current = await lstat(imported.sourcePath);
          if (
            ["dev", "ino", "size", "mtimeMs"].every(
              (key) =>
                current[key as keyof typeof imported.identity] ===
                imported.identity[key as keyof typeof imported.identity],
            )
          )
            await unlink(imported.sourcePath);
          else warn("PDF 已生成，但源网页文件在转换期间发生变化，已保留该文件");
        } catch {
          warn("PDF 已生成，但源网页文件未能清理");
        }
      }
      return result;
    } catch (error) {
      if (archive) await recordDocumentFailure(archive, error).catch(() => {});
      if (error instanceof DownloaderError) throw error;
      throw new DownloaderError(`convert: ${errorMessage(error).split(/\r?\n/)[0]}`, {
        cause: error,
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
