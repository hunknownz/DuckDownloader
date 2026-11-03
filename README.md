# DuckDownloader

将 Scribd 文档、微信公众号文章和获授权的飞书文档保存到本地，支持独立登录会话和游客模式，使用 Camoufox 原生打印保留可复制文字。

Scribd 已支持文档及嵌入链接；飞书支持获授权的 docx 图文。公众号支持文章和文字消息，已通过包含 4 张配图的真实文章及纯文字消息验收。实际能力以 `pnpm dev sources --json` 为准；平台与验收范围见[图文验收记录](docs/ARTICLE_ACCEPTANCE.md)。

## 安装

用 AI Agent 安装：

> 帮我安装 https://github.com/hunknownz/DuckDownloader

安装时一并安装仓库附带的 [`duckdownloader` skill](skills/duckdownloader/SKILL.md)，用于登录、下载和排障。

手动安装需先准备 Node.js 24 和 Git：

```bash
git clone https://github.com/hunknownz/DuckDownloader.git
cd DuckDownloader
npm install -g pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm browser:install
```

skill 的手动安装方法见[使用说明](docs/USAGE.md#ai-agent-skill)。

## 使用

通过 skill 下载，直接对 Codex 说：

> 用 $duckdownloader 下载 https://www.scribd.com/document/990798737/AAGnet，保存到 Downloads 目录。

需要登录时，按 Agent 提示在浏览器中完成登录，再告诉它“已登录”。

也可以使用命令行。

先登录：

```bash
pnpm dev login
```

在弹出的浏览器中完成登录，再回终端按 Enter。登录会话会保存在本机。

下载文档：

```bash
pnpm dev download "https://www.scribd.com/document/990798737/AAGnet" -o document.pdf
```

公开且可完整访问的文档可加 `--guest`，无需登录。省略 `-o` 会自动命名文件；更多命令见 `pnpm dev --help`。

公众号和飞书使用目标链接登录，分别保存会话：

```bash
pnpm dev login --source wechat --url "<公众号文章链接>"
pnpm dev login --source feishu --url "<飞书 docx 链接>"
pnpm dev download "<链接>" -o document.pdf
```

公众号和飞书先提取为统一内容结构，再按 A4 阅读版式重新排版导出。成功后默认只保留 PDF；加 `--keep-intermediates` 可保留内容结构、HTML、Markdown、本地图片和清单。未完成的采集会保留已有内容并返回错误，详情见[输出说明](docs/USAGE.md#输出与-pdf)。飞书当前不接受 wiki、表格或多维表格链接。

PDF 可选择、复制和搜索原有文字；扫描图片不会自动转成文字。仅下载自己有权访问和导出的内容。

## 更多说明

[使用与排障](docs/USAGE.md) · [Windows 指南](docs/WINDOWS.md) · [AI Agent skill](skills/duckdownloader/SKILL.md)
