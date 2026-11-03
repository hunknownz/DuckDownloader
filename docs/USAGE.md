# 使用与排障

基本安装和下载见 [README](../README.md)，Windows 的 PowerShell 用法见 [Windows 指南](WINDOWS.md)。支持来源和实际能力以当前 CLI 为准；公众号和飞书接入采用与 Scribd 相同的 TypeScript / Camoufox 架构。SlideShare、Everand、Fable 仍待适配。

## 环境与内核安装问题

最低 Node.js 版本为 22.15，推荐 24 LTS；使用 pnpm 11.19.0。应用使用官方 Camoufox TypeScript SDK，不需要 Python。

`pnpm browser:install` 会复用兼容的已有内核。需要重新安装内核时使用 `pnpm browser:install --force`，兼容版本由锁定的 SDK 决定。

如果安装报 GitHub API 403/rate limit，可以稍后重试，或通过本机环境变量 `GITHUB_TOKEN` 提供令牌。不要把令牌存入仓库或发到聊天中。

如果 PowerShell 禁止执行 `npm.ps1` 或 `pnpm.ps1`，可改用 `npm.cmd`、`pnpm.cmd` 执行相同命令。

## 其他命令

```bash
pnpm dev sources --json
pnpm dev inspect "https://www.scribd.com/document/990798737/AAGnet"
```

`sources` 显示实际来源能力；`inspect` 只识别链接，不联网、不验证内容权限。输入支持完整 Markdown 链接，建议直接使用纯 URL。

构建后也可以运行编译后的 CLI：

```bash
pnpm build
node dist/cli.js --help
```

下载默认复用保存的登录会话；`--guest` 不读取已保存的 profile。`login` 中按 Enter 表示保存并关闭会话，不代表程序已经验证了账号或订阅权限。

公众号与飞书必须在登录时指定目标链接；确认该页面正文可读后才保存并关闭窗口。该检查只适用于此链接，不验证整个账号的权限。公众号文章、文字消息及飞书 docx 已启用下载：

```bash
pnpm dev login --source wechat --url "https://mp.weixin.qq.com/s/<文章ID>"
pnpm dev login --source feishu --url "https://<租户>.feishu.cn/docx/<文档ID>"
pnpm dev download "<相同来源链接>" -o document.pdf
```

公开公众号文章可按需使用 `--guest`。遇到登录或验证码时，使用对应来源的 `login` 在可见窗口手动完成，不自动改换浏览器或游客模式。

## Profile 与缓存

| 数据 | macOS | Windows |
| --- | --- | --- |
| 登录 profile | `~/.duckdownloader/profiles/scribd` | `%USERPROFILE%\.duckdownloader\profiles\scribd` |
| Camoufox 内核缓存 | `~/Library/Caches/camoufox` | `%LOCALAPPDATA%\camoufox\camoufox\Cache` |

环境变量 `DUCKDOWNLOADER_PROFILE_DIR` 可覆盖 profile 路径，支持 `~/`、`~\` 展开。登录和后续下载需要使用同一配置；内核缓存和登录 profile 互相独立。

公众号和飞书的默认 profile 分别是 `~/.duckdownloader/profiles/wechat`、`~/.duckdownloader/profiles/feishu`，对应覆盖变量为 `DUCKDOWNLOADER_WECHAT_PROFILE_DIR`、`DUCKDOWNLOADER_FEISHU_PROFILE_DIR`。不同来源不共享登录数据。

改名兼容：仍接受旧的 `SCRIBDDOCK_PROFILE_DIR`、`SCRIBDDOCK_WECHAT_PROFILE_DIR`、`SCRIBDDOCK_FEISHU_PROFILE_DIR`；新环境变量优先。未指定路径时，先使用新的 `.duckdownloader/profiles/<来源>`；若它不存在而旧的 `.scribddock/profiles/<来源>` 目录已存在，则原位复用旧目录，不复制或搬移登录数据。

重置登录时，先关闭使用该 profile 的 Camoufox，再把自己的 profile 目录改名备份，然后重新运行 `login`。不要直接删除 profile 或把 Cookie、密码、环境变量文件和下载内容提交到 Git。

## 输出与 PDF

省略 `-o` 时使用文档标题命名，只有通用网站标题时使用文档 ID。Windows 文件名和被查看器占用的输出处理见 [Windows 指南](WINDOWS.md)。

下载成功时 stdout 只有最终文件路径，进度和错误输出到 stderr。退出码为成功 0、运行失败 1、参数错误 2。

每次下载使用独立临时目录，PDF 校验成功后才替换目标；失败保留已有文件并清理本次临时目录。

公众号与飞书通过统一内容结构和共享版式重新排版为 A4 PDF。成功后默认只保留 PDF；加 `--keep-intermediates` 可保留 `<PDF文件名>.archive-<随机值>` 目录，包含：

- `article.html`：清洗后正文与本地图片，支持离线打开。
- `article.md`：Markdown 正文与相对图片路径。
- `content.json`：来源无关的标题、段落、列表、引用、代码、表格、图片与图注结构。
- `source.html`：由内容结构生成的清洗页面，保留原图片引用，不是原页面源码。
- `assets/`：本地图片；`artifact.json`：来源、状态、资源哈希、警告及成功时的 PDF 页数。

版式统一控制标题、段距、页边距、列表、代码、表格、图注及分页，标题与开头段落或图片尽量一起排版。公众号文字消息用首行作标题，按空行分段，排除地点、发布时间和交互控件。图文 PDF 不保留网页所有交互和原布局。飞书累积滚动加载的块并检查目录，复杂块与嵌入媒体尚未完整覆盖。遇缺失章节、图片或不支持内容时会保留 partial 归档并返回错误，不生成看似成功的 PDF；现有 PDF 仍保留。归档可能含私人文档内容，请和 profile 一样妥善保存。

结果是阅读器导出的 PDF，与上传原文件不保证相同。保留原有文字层、字体和图形，扫描件不自动 OCR。页数、资源和非空内容流不证明视觉完整性；需要时逐页检查。不绕过登录、订阅、验证码或 DRM，不把预览当作完整文档。

字体等待、页面溢出和平台打印行为见 [PDF 导出与验证](PDF_EXPORT.md)。

## 本地网页重新排版

```bash
pnpm dev convert saved.html -o reading.pdf
pnpm dev convert saved.webarchive -o reading.pdf --title "阅读版标题"
pnpm dev convert saved.html -o reading.pdf --cleanup-source
pnpm dev convert saved.html -o reading.pdf --keep-intermediates
```

`convert` 只接受本地 `.html`、`.htm`、`.webarchive`，不接收网址，不需要登录 profile。Webarchive 支持 XML 和二进制格式。HTML 图片应已保存到网页文件所在目录及其子目录，Webarchive 图片应包含在归档内；资源缺失时保留文本和警告，不联网补取。验证页、无正文文件及不支持的嵌入媒体会明确失败。

默认清理本次生成的内容结构、排版 HTML、Markdown、图片和清单。 验收范围见[本地转换验收](LOCAL_CONVERSION_ACCEPTANCE.md)。`--keep-intermediates` 用于排版调试。`--cleanup-source` 只有在 PDF 已校验、浏览器已关闭并成功写入目标后才删除指定的源网页文件；不删除用户已有的资源目录。若源文件在转换期间发生变化，则保留该文件并发出警告。清理失败会明确提示，已生成的 PDF 仍然有效。

## AI Agent skill

将仓库的整个 `skills/duckdownloader` 目录复制到 `$CODEX_HOME/skills`；未配置 `CODEX_HOME` 时使用用户主目录的 `.codex/skills`，Windows 通常为 `%USERPROFILE%\.codex\skills`。已有同名 skill 时先比较版本，保留自己的修改。

使用 `$duckdownloader` 安装、登录、下载或排障。项目更新后，重新复制 skill 目录。

## 开发与验收资料

- [开发约定与检查命令](../AGENTS.md)
- [来源契约](SOURCE_CONTRACT.md)
- [Python 参考对齐审计](PARITY_AUDIT.md)
- [路线图](ROADMAP.md)
- [来源说明](PROVENANCE.md)
