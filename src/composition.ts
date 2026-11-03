import { ArticleAdapter } from "./adapters/article/index.js";
import { SavedPageAdapter } from "./adapters/document/local.js";
import { ScribdAdapter } from "./adapters/scribd/index.js";
import type { SourceId } from "./domain.js";
import type { SavedPageConverter, SourceAdapter } from "./ports.js";
import { DownloadService } from "./service.js";

export function createService(): DownloadService {
  return new DownloadService(
    new Map<SourceId, SourceAdapter>([
      ["scribd", new ScribdAdapter()],
      ["wechat", new ArticleAdapter("wechat")],
      ["feishu", new ArticleAdapter("feishu")],
    ]),
  );
}

export function createSavedPageConverter(): SavedPageConverter {
  return new SavedPageAdapter();
}
