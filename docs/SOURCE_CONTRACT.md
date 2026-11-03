# 来源适配契约 v0

产品目录包含 Scribd、SlideShare、Everand、Fable、微信公众号和飞书/Lark。Scribd 与两种图文来源绑定独立适配器；实际可用能力以 `sources --json` 为准。SlideShare、Everand、Fable 尚未绑定适配器。新来源通过真实授权样例验收前保持 `canDownload: false`。

## 核心应用层

`SourceSpec` 描述来源 ID、域名、状态、能力和说明。飞书允许点分隔的租户子域；其他来源默认精确匹配主机名。`DownloadRequest` 包含规范化 URL、可选输出路径、guest 和 keepIntermediates 标志。`SourceAdapter` 提供异步 `login(targetUrl?)` 和 download，后者接收只包含 PDF 页数的进度回调，返回文件路径。指定登录链接时必须与所选来源一致。

`DownloadService` 检查 URL、来源与能力，然后调用明确绑定的适配器。domain、ports、service、errors 不依赖浏览器或 PDF SDK；依赖边界由测试检查。composition.ts 装配具体实现。

## 浏览器集成

集成层的 `BrowserProvider` 接收 headless、可选 profile 和临时打印输出路径，返回 `BrowserSession`，来源适配器负责关闭会话。Playwright 对象不进入核心应用层。

`BrowserSession.printPdf` 为可选的原生 PDF 打印能力。Windows 的 Camoufox provider 在指定打印路径时通过本机 loopback Marionette 连接同一浏览器，明确选择 Firefox WebDriver PDF 后端；其他平台沿用 `window.print()`。选定后端失败直接中止，不自动换用另一后端或浏览器。PDF 响应经过文件完成、页数、纸张与内容流校验后才替换输出。

默认 `CamoufoxProvider` 通过官方 camoufox TypeScript SDK 启动 Camoufox，使用与宿主一致的 OS、en-US locale 和主世界脚本执行。登录有界面并保存 profile，下载无界面；不自动回退到其他浏览器。浏览器使用官方 SDK 的平台缓存，profile 默认采用 ~/.duckdownloader/profiles/scribd；旧名称的环境变量及已存在的旧 profile 按 [改名兼容说明](USAGE.md#profile-与缓存) 读取。

Windows profile 默认为 `%USERPROFILE%\.duckdownloader\profiles\scribd`，继承所在目录的 NTFS 权限；POSIX 系统设置 `0700`。profile 和输出路径支持 `~/`、`~\` 主目录展开。自动文件名避开 Windows 保留名称；Windows 上显式指定保留文件名时在启动浏览器前失败。平台安装和验证范围见 [Windows 指南](WINDOWS.md)。

Camoufox 官方 SDK 自身控制支持的内核版本范围。锁定 Node 依赖不等于锁定远端平台接口；不能擅自启动不受 SDK 支持的内核。

## 输入与失败

只接受完整 HTTP/HTTPS URL 或完整 Markdown 链接；公众号与飞书适配器进一步要求 HTTPS。不接受相似域名、URL 内账号密码和非标准端口。公众号接受 `/s/<id>` 与带 `__biz/mid/idx` 的 `/s` 链接，飞书接受 `/docx/<token>`，不将 wiki、表格和多维表格当作 docx。未实现的来源在启动浏览器前失败，不跨来源兜底。

每次下载在目标目录内创建唯一临时目录。通过 PDF 校验后才使用 rename 替换目标；失败保留已有输出并删除本次临时文件。资源失败、页面不全、布局异常和 PDF 内容流缺失必须有明确错误。

## 内容边界

Scribd 输出为阅读器 DOM 经 Firefox 打印重建的 PDF，非上传原文件的字节副本。检查页数、尺寸、资源、加载、布局和内容流不证明每一页视觉完整。

导出页面同时考虑可见边框和实际滚动内容尺寸，容纳阅读器已有的右侧或底部溢出。重新布局后仍检查页面边框、宽高及内容溢出，不通过扩大超时或跳过校验掩盖裁切。

阅读器的字体清单通过 FontFace 加载并注册；只接受 HTTPS 的 scribdassets.com 及其子域资源，45 秒内未加载完则明确失败。空字体清单允许纯图片文档通过。

浏览器能看见内容、可以完整阅读、允许下载/导出是不同能力。遵守平台授权，不绕过登录、订阅、验证码或 DRM，不把预览当作完整文档。Everand、Fable 在确认允许导出的内容及真实样例之前保持待调研。

导出调用 Camoufox/Firefox 的原生打印，等待落盘 PDF 稳定最长 60 秒，要求文件包含 PDF 结束标记。Windows 的原生 PDF 命令另有 90 秒上限。浏览器关闭成功后校正 PDF 页框、校验并替换输出。CSS 像素按 0.75 转为 PDF 点；文本、字体和矢量内容保留，不自动降级为截图。

Quartz 输出必须具有可识别的开头页面裁剪矩形。允许整页等比缩放：纵横比与打印布局相符，比例在 0.5–2 内，且所有页使用相同比例。通过这些检查后平移、等比恢复正文尺寸，并同步页框和注释坐标。无法识别、非等比或跨页比例不一致时中止。Windows 原生后端声明纸张向上取整为整数 PDF 点；必须与预期尺寸的 ceil 相符，才去除不足 1 点的纸张填充并平移正文和注释以保持顶部对齐。其他后端必须直接提供与布局相符的纸张尺寸；不通过猜测扩大页框掩盖裁切。

## 公众号与飞书图文

两种来源复用 Camoufox、原生打印和 PDF 输出保护。登录必须提供目标链接，使用各自独立 profile；按 Enter 后还要确认该页面正文可读，这不等同于验证整个账号的权限。图文按 A4 重新排版，PDF 页数来自打印结果，飞书章节数单独记录。

公众号滚动加载正文配图；飞书按稳定块 ID 累积虚拟滚动内容，核对目录章节、底部到达状态及图片。尚未支持的内容块、嵌入媒体、超时和图片缺失会使归档标记为 partial。此检查不证明所有类型的飞书文档都已适配。

每次运行在 PDF 同目录创建唯一的 `<filename>.archive-<random>`，保存清洗后的正文 HTML、带本地图片的 HTML、Markdown、assets 与 artifact.json；`source.html` 也是提取后的正文，不是原页面源码。清除脚本、事件和不安全链接。HTTP 图片只从明确的来源资源域名下载，逐次校验重定向，复用当前浏览器请求上下文；blob 图片从当前可读页面保存。不会读取或导出 Cookie。

图片资源受单张 20 MiB、总量 64 MiB 限制。归档记录资源哈希、字节数与警告；内容不完整时保留可读结果并返回错误，不替换既有 PDF。浏览器关闭、PDF 验证均成功后才替换输出。归档 HTML 的本地打印阶段阻止 HTTP/HTTPS 请求，不依赖在线图片。

## 共享图文重排与清理

公众号和飞书先生成来源无关的 `DocumentContent` / `DocumentBlock` / `DocumentInline`，涵盖标题、段落、嵌套列表、引用、代码、表格、图片及图注，再交给共享 A4 排版器。原网页样式、脚本和交互控件不进入排版结果。公众号文字消息用首行作标题、按空行分段；完整正文保留，页面地点与发布时间不属于正文。

归档使用 schemaVersion 2.0，新增 content.json；source.html 由统一结构生成。成功时默认清除本次归档，keepIntermediates 为 true 时保留。PDF 仅在浏览器关闭和完整校验后替换目标；失败保留 partial 资料及既有 PDF。排版阶段只允许加载本地归档内文件或 data 资源，禁止联网补取。
