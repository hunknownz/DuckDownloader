---
name: duckdownloader
description: 使用 DuckDownloader 安装环境、手动登录、下载已获授权的 Scribd 文档、公众号文章和飞书 docx，将本地 HTML / Webarchive 重新排版为 PDF 并清理中间文件，或排查 Camoufox、profile 与 PDF 导出问题。用户提到 DuckDownloader 或明确要求用该项目处理支持的来源链接、本地网页重新排版时使用；不用于普通网页下载、其他下载器或未实现来源的下载。
---

# DuckDownloader

把用户的请求落实为可验证的安装、登录或下载结果；排障时给出失败阶段和下一步依据。项目是 TypeScript CLI，通过官方 Camoufox TS SDK 启动浏览器；不要换成 Python 桥接、系统浏览器或截图拼 PDF。

## 定位项目与能力

从当前项目、用户给出的路径或此前已确认的 checkout 定位仓库，确认 `package.json` 的包名为 `duckdownloader`。没有 checkout 且用户要求安装时，clone `https://github.com/hunknownz/DuckDownloader.git` 到不冲突的目录；不覆盖已有目录。不要把技能安装目录当作项目目录，也不要硬编码原作者机器路径。

先读该 checkout 的 `AGENTS.md`、`README.md`；需要安装排障、profile 配置或高级命令时读 `docs/USAGE.md`，涉及导出效果或平台支持时再读 `docs/PDF_EXPORT.md`、`docs/PARITY_AUDIT.md` 或 `docs/WINDOWS.md`。本地转换的真实样例和平台边界见 `docs/LOCAL_CONVERSION_ACCEPTANCE.md`。命令和兼容版本以实际 checkout 为准。

先运行 `pnpm dev --help` 确认当前 checkout 的命令；本地网页任务再运行 `pnpm dev convert --help` 确认参数，避免把旧版本当作已经支持转换。运行 `pnpm dev sources --json` 查看联网来源能力，`pnpm dev inspect "<url>"` 仅识别链接，不联网、不证明权限。Scribd、公众号和飞书各自有适配器，是否启用必须按该 checkout 的能力目录判断；SlideShare、Everand、Fable 是规划中的来源，明确拒绝尚未实现的操作。用户要求调研或开发时可说明缺口，不伪装成已经能下载。

## 安装与执行

在已定位的项目目录执行命令。按 `package.json` 的 engines/packageManager 检查 Node.js、pnpm；当前推荐 Node.js 24，pnpm 11.19.0，Windows 使用 x64。缺少依赖时运行 `pnpm install --frozen-lockfile`，缺少兼容内核时运行 `pnpm browser:install`。只有证据指向内核损坏时才使用 `--force`；不清空整个浏览器缓存，也不调用 Python 的 `camoufox fetch`。

常用命令：

```text
pnpm dev --help
pnpm dev sources --json
pnpm dev inspect "<url>"
pnpm dev login
pnpm dev login --source wechat --url "<公众号链接>"
pnpm dev login --source feishu --url "<飞书 docx 链接>"
pnpm dev download "<url>" -o "<output.pdf>"
pnpm dev download "<url>" --guest -o "<output.pdf>"
pnpm dev convert "<saved.html 或 saved.webarchive>" -o "<output.pdf>"
pnpm dev convert "<saved.html>" -o "<output.pdf>" --cleanup-source
```

已有构建可用 `node dist/cli.js` 替换 `pnpm dev`。只有源码变化或缺少构建时才需要 `pnpm build`。优先传纯 URL，并引用含空格的路径；CLI 也接受完整 Markdown 链接。不要把 `uv run scribd-downloader` 当作本项目命令。

## 登录与 profile

默认下载复用保存的 profile；`--guest` 使用临时会话，不读取登录状态。不要因为登录下载失败就静默改为游客模式。

`pnpm dev login` 打开可见 Camoufox。让用户在该窗口中手动完成登录和验证码，不索要聊天中的密码、Cookie 或验证码。只有用户完成操作后才向登录进程发送 Enter，随后等待正常退出；如需用户配合，保留交互进程并说明等待什么。Scribd 的 Enter 只是保存并关闭会话；公众号和飞书会进一步确认目标正文可读，仍不能据此称为整个账号或订阅权限验证成功。

profile 默认位于用户主目录的 `.duckdownloader/profiles/scribd`；Windows 通常为 `%USERPROFILE%\.duckdownloader\profiles\scribd`。`DUCKDOWNLOADER_PROFILE_DIR` 可覆盖位置，支持 `~/`、`~\` 展开；使用当前进程环境和项目路径函数确认实际位置，不输出完整环境变量。公众号与飞书使用独立的 `.duckdownloader/profiles/wechat`、`.duckdownloader/profiles/feishu`；覆盖变量分别为 `DUCKDOWNLOADER_WECHAT_PROFILE_DIR`、`DUCKDOWNLOADER_FEISHU_PROFILE_DIR`。登录和下载必须使用对应来源的同一配置。新环境变量优先于旧的 `SCRIBDDOCK_*` 配置；新默认目录不存在时会原位复用同来源的 `.scribddock/profiles/<来源>`。不要因为改名而重新登录、复制或删除旧会话。内核缓存与 profile 是两个目录。

只有用户要求重置时才处理 profile。先确认相关会话已关闭，然后把实际 profile 重命名为带时间戳的备份，再重新登录；不要递归删除、杀掉全部浏览器、迁移原 Python 项目的 profile，或把备份提交到 Git。

## 下载与验收

只导出用户能够合法完整访问的内容；不绕过登录、订阅、验证码或 DRM，不把预览页当作完整结果。已有保存会话按默认模式下载；仅在用户要求或确认无需登录时选择 `--guest`。

明确输出位置，避免无意覆盖现有文件；未要求覆盖时可选择不冲突的文件名并告知用户。程序在完整 PDF 校验后才替换目标，失败应保留既有文件并清理本次临时目录。不要手工删掉旧文件来“修复”导出失败。

成功后确认退出码为 0、返回的文件存在，再按请求核查页数、文字或外观。报告绝对路径和实际检查过的结果。原生打印保留阅读器已有文字层，扫描图片没有可复制文字，本项目不自动 OCR；结果是阅读器导出的 PDF，不保证与上传原文件字节相同。非空文件、字体资源或内容流都不足以证明每页完整，要求视觉验收时需逐页检查。

公众号、飞书和本地网页都先提取为统一内容结构，再通过共享版式排版导出 PDF。不要直接把原网页打印当作重新排版完成；不要跳过提取、图片完整性和 PDF 校验。Scribd 保留原阅读器页面布局。

图文成功后默认只保留 PDF，并清理本次创建的内容结构、排版 HTML 和图片。`--keep-intermediates` 可保留 `content.json`、排版 HTML、Markdown、本地图片和清单，供排版调试。失败时保留 partial 资料与原 PDF；不能把 partial 当作下载验收通过。飞书仅支持 docx，wiki、表格、多维表格和复杂嵌入内容尚未适配。

stdout 成功时只有最终路径；渲染进度和错误在 stderr。退出码 0/1/2 分别表示成功、运行失败、参数错误。不要把截图、复制日志或技能校验代替真实下载验收。

## 本地网页与清理流程

用户提供 HTML、HTM 或 Webarchive 时使用 `convert`，不要把它重新变为网址下载。该命令只读取已保存内容与图片，支持 HTML/HTM、XML 和二进制 Webarchive，不联网补取缺失资源；保存的是验证页或图片不全时应报告缺口。`sources` 目录描述联网平台，本地转换是否可用以 `convert --help` 为准。

执行顺序：确认输入和输出 → 提取并规范化标题、段落、列表、引用、代码、表格及图片 → 共用 A4 阅读版式 → 原生 PDF 导出与校验 → 清理本次中间文件。原生打印只作为排版结果的 PDF 后端。

用户要求重新设计版面或视觉验收时，先加 `--keep-intermediates` 并保留源文件。渲染 PDF 检查正文、图注、表格、分页和首尾内容；有问题时从本次 `content.json` 和排版器排查。通过后，按用户清理请求删除本次生成的精确中间目录；以新建目录记录和匹配 PDF 路径的 artifact.json 确认归属，不用通配符删除旧归档。

用户明确要求删除源网页时才加 `--cleanup-source`；程序在 PDF 校验、浏览器关闭和写入成功后删除这一个输入文件，不删除用户资源目录。源文件发生变化或导出失败时保留。用户没有要求清理源文件时，默认只清理程序自己的中间文件。清理失败需报告 PDF 已生成及仍保留的位置，不声称全部清理成功。

## 排障

出现内核缺失、乱码、登录未生效、空白/裁切/不可复制 PDF 或 Windows 打印问题时，按 [references/troubleshooting.md](references/troubleshooting.md) 选择与证据匹配的分支。只记录脱敏后的错误阶段、系统与版本、模式、页数和检查结果；不读取或上传 profile 数据库、浏览记录、令牌或文档内容。

修复环境属于安装/排障请求的范围；修改程序、扩大来源范围、提交代码或发布版本仍按用户本次授权判断。提出优化建议不等于自动实现全部建议。
