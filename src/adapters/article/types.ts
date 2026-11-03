export type ArticleSource = "wechat" | "feishu";

export interface CapturedImage {
  readonly reference: string;
  readonly sourceUrl: string;
  readonly mediaType: string;
  readonly dataBase64?: string;
}

export interface CapturedArticle {
  readonly title: string;
  readonly sourceUrl: string;
  readonly html: string;
  readonly images: readonly CapturedImage[];
  readonly warnings: readonly string[];
  readonly complete: boolean;
  readonly sections: number;
}
