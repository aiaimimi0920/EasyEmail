# Cloudflare 安全正文与附件切片（M3c）

本切片在 `migration/cloudflare-web` 的独立目录实现安全 HTML 阅读和受控附件下载。
只做本地合成数据验收，不更新 NAS、自营 Worker、生产 D1、域名或发送配置。
M3c 不是整个迁移或第一阶段产品完成；真实供应商与生产运行仍需单独验收。

## 1. HTML 的信任边界

正文默认仍以 React 转义后的纯文本显示。用户点击“安全 HTML”才建立阅读 iframe。
此处不复用旧写信编辑器的较宽 HTML 策略：编辑器输入和不可信收信是不同信任边界。

- DOMPurify `3.4.17` 精确锁定，只允许段落、标题、强调、列表和表格等语义排版标签。
- 不允许任何邮件提供的属性，包括链接地址、资源 URL、样式、事件、data 与 ARIA 属性。
- 不展示图片；不加载远程像素、CSS、字体或媒体；链接文字可以显示，但不能点击导航。
- 脚本、表单、SVG、MathML、嵌套 iframe、object/embed、template 等不进入阅读文档。
- 只把净化后的 HTML 放进 `srcDoc`，不把原始邮件插入主页面 DOM。
- iframe 使用空 `sandbox`，没有 scripts、same-origin、popups 或顶层导航许可。
- iframe 自身 CSP 为 `default-src 'none'; base-uri 'none'; form-action 'none'`，并使用 no-referrer。
- 应用 CSP 只增加 `frame-src 'self'`；没有为邮件放开主应用的内联脚本、样式或远程连接。

这是可读且不可交互的语义视图，不承诺复原邮件的品牌样式、图片和所有客户端布局。
单邮箱和聚合收件箱共用阅读组件。离开阅读页会卸载正文和取消未完成下载，
但不会丢弃已保留的邮箱分配幂等状态或发送待确认状态。

## 2. 附件的真实来源与下载合同

自营现有 `/api/mail/:mail_id` 按邮箱 JWT 的 address 和远端 ID 返回解压后的 raw row。
聚合层复用该合同，不使用与收信 MIME 附件无可靠关联的 `/api/attachment/*` S3 接口，
也不读取邮件中的 URL、签名下载地址或管理员邮箱数据。

自营 `parsed_mail_api.ts` 的附件 metadata 增量增加：

```text
filename / mimeType / disposition / size（原字段保留）
index（原始 MIME 附件序号）
sha256（前 100 个附件的解码字节 SHA-256）
```

`parsed_attachment_metadata.ts` 顺序计算摘要，不截断旧 metadata 列表，不改变旧客户端字段。
该上游改动尚未发布。因此当前线上旧接口没有摘要的邮件不能下载；发布兼容的上游后须显式重新同步。
聚合缓存至多 100 个附件，并通过 `attachmentsTruncated` 明确表示列表截断。
摘要格式、序号、大小非法会使同步失败，不静默降级为可信下载。

下载流程：

1. 校验独立权限、用户归属、邮箱归属、消息归属、附件序号和邮箱 active 状态。
2. 只允许具有合法摘要、序号及安全整数大小，且单附件不超过 5 MiB 的缓存项。
3. 用该邮箱 JWT 显式读取一次原始邮件；不发送平台管理员 Key，不重试、不跟随重定向。
4. 验证响应 row 的远端 ID 和 address，解析对应 MIME part。
5. 解码字节数与缓存大小、SHA-256 全部一致才返回；不一致为 `attachment_source_changed`。
6. 返回 `application/octet-stream`、强制 attachment、安全 UTF-8 文件名、no-store 和 nosniff。

请求总超时 15 秒，raw JSON 上限 8 MiB；PostalMime `4.1.4` 解析限制为 MIME 深度 32、
headers 256 KiB、parts 200、嵌套 RFC822 深度 5、转发地址 100。
上游与聚合解析器版本不同，解析差异会拒绝返回文件，不能用文件名或大小替代字节核验。
不持久化原始 MIME 或附件二进制；上游过期、删除或替换后，缓存 metadata 不保证还能下载。
提供文件下载不代表文件安全或无恶意软件，平台不内联预览、自动执行或扫描文件。

Temporam 仓内 v3 合同尚无可确证的附件 ID、字节或 raw MIME 下载方式。
当前不猜测下载 URL，不宣称支持其附件下载。

## 3. API 与权限

```text
GET /api/v1/mailboxes/:mailboxId/messages/:messageId/attachments/:index
```

- Cookie 会话或独立 `attachments:read`，旧 API Key 不自动增加权限。
- 该 scope 不隐含 `messages:read`、发送或邮箱管理权限；Web 提供明确的阅读加下载 Key 选项。
- 详情返回每个附件的 `downloadAvailable`、顶层 `attachmentDownloadAvailable` 和 `attachmentsTruncated`。
- 供应商 catalog 的 `attachmentDownload` 表示已实现协议，不表示每封缓存邮件都可下载。
- GET 详情、聚合搜索和 HTML 切换只读缓存；只有下载按钮或显式下载 API 才取 raw。
- 下载应用限流为每用户每固定分钟 10 次、全平台 100 次，另受全局已认证请求限流约束。
- 归属不匹配/不存在为 404；不可核验或源变化为 409；上游无效/解析失败为 502；限流为 429。

浏览器使用同源 fetch，不向供应商暴露用户 Key。成功响应才创建临时 Blob 下载，
离开详情时 AbortController 取消取件，Blob URL 用后释放，不缓存到 localStorage/sessionStorage。
文件名移除控制符、双向字符、路径字符及 Windows 保留设备名风险，并处理孤立 UTF-16 surrogate。

## 4. 数据 expand 与旧读写兼容

新增 `0005_attachment_identity.sql`，只扩展 `messages.attachment_version` 和 `attachments_truncated`。
0001–0004 不改写；不删除旧数据，不改账号、会话、Key scope、凭据或发送幂等 guard。

- 旧消息 fingerprint 算法排除新增的摘要、序号、截断和 RFC Message-ID 字段，保留旧字段顺序。
- 第一次摘要回填保留消息 ID、fingerprint、observed_at、正文和用户整理状态，不新建重复消息。
- 不带摘要的旧接口不能覆盖已经回填的摘要。
- 同远端 ID、正文及 metadata 下附件字节变化时，建立新的缓存版本，不覆盖历史摘要和整理状态。
- 再同步相同版本仍去重；下载旧版本遇当前 raw 已变则 409，不返回另一份文件。
- metadata 更新与新增消息继续使用相同同步 lease fence，并和同步状态提交到同一 D1 batch。

回退可继续用原目录和原部署；开发数据库可以保留 expand 字段。
本切片不执行 schema contraction、生产导入、双写、切流或自动发布。

## 5. 验收证据与未完成边界

测试覆盖自营摘要合同、独立 Node 哈希对照、空文件、大小/序号/摘要边界、用户隔离、权限、
重启、升级保留、旧 metadata、二进制版本变化、lease 丢失、D1 原子回滚、限流、重定向、
超时、非法/超大 raw、MIME 层数/parts/headers 边界，以及真实 Chrome 的净化、无外部请求、
附件下载字节核对、错误提示、离开页面取消及移动端阅读。

当前阶段完整收据：
`C:\Users\Public\nas_home\AI\GameEditor\linshi\easyemail-cloudflare-migration-20261028\m3c-final\verification.json`。
旧 M1/M2/M3a/M3b 收据保留为历史证据，不替代当前源码验证。

没有完成真实供应商附件验收、自营上游完整部署/业务回归、生产 CPU/内存/并发/费用测量、
恶意附件扫描、附件发送、管理后台、邮箱生命周期、生产数据保留及后续完整工作台。
