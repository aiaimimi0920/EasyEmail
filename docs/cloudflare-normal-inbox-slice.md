# W10d：普通邮箱显式同步、私有阅读与网页

本切片在 W10c 私有存储上接通真实 HTTP/Web 入口。使用 `service/cloudflare` 的同一套 Worker、D1、R2、原生 IMAP 读取器；不依赖桌面、Userscript、旧 NAS 或浏览器直连邮箱服务器。
这是本地普通收件纵向链路，不代表统一聚合、完整普通邮箱或整体迁移已完成。没有生产资源创建、真实凭据导入或真实投递验收。
后续W10e已接通[带来源的聚合与缓存提取](cloudflare-normal-unified-slice.md)；本文中“尚未聚合/提码”描述W10d当时边界，不取消后续扩展。

## API 与权限

前缀 `/api/v1/normal-accounts/{accountId}`。账号均须归当前用户且未移除；所有访问先认证，缓存读取最终再检查用户 active、账号 revision 和当前来源 epoch。

| 方法与后缀 | 行为 | 必须具备的 scope |
| --- | --- | --- |
| `POST /sync` | expectedRevision 固定的单批只读同步，必须提供 Idempotency-Key | `mail-accounts:sync` |
| `GET /sync-requests` | 最近20条请求，含 pending/committed/failed 与显式跳过 | `mail-accounts:sync` |
| `GET /sync-requests/{requestKey}` | 核对原请求，不重新打开 IMAP | `mail-accounts:sync` |
| `GET /messages` | 当前来源的 UID 倒序缓存分页 | `mail-accounts:read` + `messages:read` |
| `GET /messages/{id}` | 经完整性核验的缓存正文与附件元数据 | 同上 |
| `GET /messages/{id}/raw` | 原始 MIME，始终 attachment 下载 | 上述两个 scope + `attachments:read` |
| `GET /messages/{id}/attachments/{index}` | 从已核验原文重新解析、按解码字节摘要核验下载 | 同上 |

旧 API Key 不自动扩权。普通收件不写入旧 mailboxes/messages，旧临时邮箱查询、正文、会话、订阅、提码和发送入口不会因此自动读到普通邮件。
普通来源暂不支持整理、删除、远端写入、草稿回复或 SMTP；新资源写方法明确拒绝，网页不提供会暗中借用临时邮箱发送的按钮。

POST 只接受 `{ "expectedRevision": 1 }`，沿用8 KiB JSON上限、精确 Origin 与服务器白名单。Key 为16–128字符的英文字母、数字、下划线或横线。
程序 API Key 不要求浏览器 Origin，仍需独立 scope 和 owner。缺少 INBOX、凭据、服务器不匹配或失效 claim 都不会被表示为提交成功。

## 请求与业务状态

新增0025中的 `normal_inbox_requests`。调用网络之前先唯一预约 `(account_id,request_key)`，固定账号 revision；请求身份与每次 claim 的随机 token 分开，避免复用 token 使旧执行者重新获得写入资格。
同键并发、HTTP响应丢失、重启后重放都只核对原记录；更改 expectedRevision 返回409，不另开网络读取。

HTTP 200 只表示成功取得请求状态，必须检查 `request.state`：

- `pending`：请求已预约/仍有有效 claim，不是邮件已保存；实际有效 lease 优先于预约时间，不能因预约较早而把仍可提交的任务说成失败。
- `committed`：存在同事务提交的批次回执，result 才提供 stored、skipped、cursor、reset、complete。后续配置修改不会改写历史回执。
- `failed`：本请求未形成提交，errorCode 为受控错误码。相同键不会静默重新连接；修复原因后可由用户明确发起新的只读同步。

进程中止且未形成 claim/回执的预约在90秒后显示中断；已有 claim 按其真实 lease 判定。最终提交资格仍由W10c的数据库 fence决定，而不是网页时钟或状态文本。
每账号最多1000条请求，连同原1000批次、累计1000封预约和128 MiB存储限制。已满时预约前停止网络读取；最终批次仍重新检查实际容量。没有自动清理或长期无限同步承诺。

## 来源、读取与兼容

- 每次读取验证来源哈希；更换服务器/用户名/收件地址后，旧内容立即不再属于当前来源。新的UIDVALIDITY形成新epoch，旧链接和旧分页游标不能指向新邮件。
- 停用连接或忘记凭据不等于删除缓存；来源身份未变时，缓存仍可按权限读取。移除账号则所有普通读取入口404。
- 分页每页1–20封，游标绑定epoch与UID；读缓存不会设置远端Seen、触发网络同步或推断平台本地已读状态。remoteFlags只是同步时快照。
- 新消息的摘要与邮件身份在同一D1事务插入。0024旧行摘要为NULL时，从经摘要核验的私有内容对象提取，不修改身份、检查点或原文；每页最多20次对象读取，不把兼容回退说成已验收的大规模查询性能。
- 正文/原文对象逐次核对声明大小、实际字节数和SHA-256。下载重新核对账号版本与epoch；来源变化、对象丢失、损坏、截断或附件摘要不一致时不返回原内容。
- 原文单封最多2 MiB；附件复用同一组PostalMime资源限制与解码摘要，响应始终 application/octet-stream、attachment、no-store、nosniff，不内联邮件文件。
- 普通原文与附件和旧附件共用下载速率预算，不能靠切换来源绕开用户/平台限额。原始对象key、密码、密文和服务器原始拒绝文本不进入API或网页。

## 网页

普通邮箱账号选中后提供显式同步、刷新缓存、邮件分页、详情、安全HTML、附件与原文下载、最近同步记录及显式跳过原因。
复用SafeMailBody、DOMPurify与无权限sandbox iframe；默认纯文本，不加载邮件图片、CSS、链接或脚本。复用原AttachmentList的安全下载流程。
未知同步保留原键/版本，账号编辑与移除锁定；导航回来可核对本次同步或显式重试原请求，不自动换键。同步键和密码均不写入浏览器持久存储；刷新后可查看服务端最近记录与已提交缓存。
重新加载、打开详情或下载不自动连接IMAP。连接测试文案明确是“本次检查未同步邮件”，不把已有缓存说成不存在。

## 升级、回退及后续

先应用0025；启用公开普通收件前排空旧普通同步writer。旧身份、回执与对象保留，新关联和摘要允许NULL；不执行删除或重建。回退暂停普通同步和公开入口，保留新表/列/对象，不隐式执行contract。
默认配置仍不绑定真实INBOX资源，不设置真实IMAP目标或导入凭据。Wrangler local与dry-run不等于生产部署。

下一阶段仍要完成普通来源与统一聚合工作台/搜索、会话、订阅、提码、整理/删除、发送与历史回执的完整接线，并实现staged对象、旧epoch和请求记录的安全保留维护。
多文件夹、远端状态操作、SMTP/OAuth2、Agent、更多供应商、旧数据迁移与真实Cloudflare/真实邮箱验收继续保留在整体目标中，不能以本切片可用代替它们。
