export const sourceIds = ["scribd", "slideshare", "everand", "fable", "wechat", "feishu"] as const;
export type SourceId = (typeof sourceIds)[number];

export interface SourceSpec {
  readonly id: SourceId;
  readonly name: string;
  readonly hosts: readonly string[];
  readonly includeSubdomains?: boolean;
  readonly status: "ready" | "planned";
  readonly canLogin: boolean;
  readonly canDownload: boolean;
  readonly note: string;
}

export interface DownloadRequest {
  readonly url: string;
  readonly output?: string;
  readonly guest: boolean;
  readonly keepIntermediates?: boolean;
}

export type DocumentInline =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "break" }
  | { readonly type: "strong" | "emphasis" | "code"; readonly children: readonly DocumentInline[] }
  | { readonly type: "link"; readonly href: string; readonly children: readonly DocumentInline[] };

export interface DocumentCell {
  readonly header: boolean;
  readonly colSpan: number;
  readonly rowSpan: number;
  readonly blocks: readonly DocumentBlock[];
}

export type DocumentBlock =
  | {
      readonly type: "heading";
      readonly level: number;
      readonly content: readonly DocumentInline[];
    }
  | { readonly type: "paragraph"; readonly content: readonly DocumentInline[] }
  | {
      readonly type: "image";
      readonly reference: string;
      readonly alt: string;
      readonly caption?: readonly DocumentInline[];
    }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly (readonly DocumentBlock[])[];
    }
  | { readonly type: "quote"; readonly blocks: readonly DocumentBlock[] }
  | { readonly type: "code"; readonly text: string }
  | { readonly type: "table"; readonly rows: readonly (readonly DocumentCell[])[] }
  | { readonly type: "divider" };

export interface DocumentContent {
  readonly title: string;
  readonly sourceUrl: string;
  readonly blocks: readonly DocumentBlock[];
}

export const sources: readonly SourceSpec[] = [
  {
    id: "scribd",
    name: "Scribd",
    hosts: ["scribd.com", "www.scribd.com"],
    status: "ready",
    canLogin: true,
    canDownload: true,
    note: "Scribd 文档和嵌入链接，导出阅读器 PDF",
  },
  {
    id: "slideshare",
    name: "SlideShare",
    hosts: ["slideshare.net", "www.slideshare.net"],
    status: "planned",
    canLogin: false,
    canDownload: false,
    note: "待适配：优先验证获授权的原文件下载",
  },
  {
    id: "everand",
    name: "Everand",
    hosts: ["everand.com", "www.everand.com"],
    status: "planned",
    canLogin: false,
    canDownload: false,
    note: "待调研：仅考虑平台允许导出的内容，不移除 DRM",
  },
  {
    id: "fable",
    name: "Fable",
    hosts: ["fable.co", "www.fable.co"],
    status: "planned",
    canLogin: false,
    canDownload: false,
    note: "待调研：先确认可导出的内容和权限",
  },
  {
    id: "wechat",
    name: "微信公众号",
    hosts: ["mp.weixin.qq.com"],
    status: "ready",
    canLogin: true,
    canDownload: true,
    note: "公众号文章与文字消息，图文重排和原生 A4 PDF；不支持嵌入媒体",
  },
  {
    id: "feishu",
    name: "飞书 / Lark",
    hosts: ["feishu.cn", "larksuite.com"],
    includeSubdomains: true,
    status: "ready",
    canLogin: true,
    canDownload: true,
    note: "获授权 docx 图文、离线归档和原生 A4 PDF；不支持 wiki、表格与嵌入媒体",
  },
];
