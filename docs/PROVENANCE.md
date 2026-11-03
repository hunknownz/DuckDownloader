# 来源说明

Scribd 阅读器的网页加载与 `docManager` 适配逻辑参考并改写自 [ma-pony/scribd-downloader](https://github.com/ma-pony/scribd-downloader)。DuckDownloader 使用独立的 Git 历史，应用层、CLI、Camoufox TypeScript 接入及PDF 页框修复与输出保护在本项目中实现。

参考仓库当前没有发现明确的 LICENSE 文件。本项目不对参考代码另行声明许可证；后续发布许可证时需先确认相关代码的授权。依赖包遵循各自许可证。

公众号和飞书适配器依据用户自己的 ArtifactPress 图文采集实现和获授权页面重新接入此项目；沿用本项目的 TypeScript、Camoufox 和原生打印架构，不依赖原扩展或本地 WebSocket 桥。Markdown 转换使用 Turndown。
