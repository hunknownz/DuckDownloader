import type { DownloadRequest, LocalExportRequest } from "./domain.js";

export type ProgressCallback = (loadedPages: number, totalPages: number) => void;

export interface SourceAdapter {
  login(targetUrl?: string): Promise<void>;
  download(request: DownloadRequest, progress?: ProgressCallback): Promise<string>;
}

export interface SavedPageConverter {
  convert(request: LocalExportRequest, progress?: ProgressCallback): Promise<string>;
}
