# Cloudflare 基础写信、回复与发送状态切片

## 实现与证据边界

M3b 在 `service/cloudflare` 提供纯文本写信、基础回复和持久化发送历史，
Web 与开放 API 使用同一权限、配额及幂等状态机。复用共享的
`service/base/src/domain/cloudflare-send-policy.ts` 解析发送模式，不搬入旧 Node connector 的隐式恢复流程。

本地验证使用 workerd、D1、真实 loopback HTTP、合成供应商及独立 Chrome。
它不是实际 Cloudflare 供应商发送、真实收件人投递、生产部署或完整写信工作台验收。
当前最终收据位于隔离证据目录的 `m3b-final/verification.json`，历史阶段收据不覆盖。

## 显式发送配置

默认关闭发送。平台 `PROVIDER_CONFIG` 的自营 Cloudflare 行同时需要
`sendTransport` 和非空 `sendRecipients`；示例仅演示结构，不含生产域名或凭据：

```json
{
  "id": "self",
  "type": "cloudflare",
  "baseUrl": "https://mail.example.test",
  "domains": ["inbox.example.test"],
  "sendTransport": "binding",
  "sendRecipients": ["acceptance@example.test"]
}
```

- `worker`：只使用归属邮箱的解密 JWT，调用自营服务 `/api/send_mail`。
- `binding`：显式使用服务器保管的管理员凭据，调用 `/admin/send_mail_by_binding`。
- `sendRecipients` 是最多 100 个单一 ASCII 地址的允许列表，大小写不敏感匹配。
  只有单独的 `["*"]` 才明确允许任意收件地址；不支持域名通配或 substring 匹配。
- 无模式、无策略或空策略均不能发送；非法模式或策略使配置失败关闭。
- Temporam 仍是只读供应商，不接受发送配置，不伪造发送能力。
- 只允许当前用户数据库内 active 邮箱作为 from，且发件域必须仍在该供应商配置内。
  平台同步的 `paused` 不代表停用远端收信或发送。
- 不向网页返回供应商地址、管理员 Key 或邮箱 JWT；客户端不能指定任意 from、headers 或 credentials。
- 无申请发送权限、管理员委托 fallback、自动重试、重定向跟随或未知后切换模式。

管理员 binding 接口本身没有邮箱归属和普通收件黑名单检查。
本聚合层的用户归属、显式收件策略与原子配额不可省略；生产还需边缘防滥用及人工授权。
修改示例不代表修改现有实例的发送模式。

## API 与状态

| 方法与路径 | 权限与行为 |
| --- | --- |
| `POST /api/v1/mailboxes/:id/outgoing` | `messages:send`，会话还需精确 Origin；提交一次或回放原结果 |
| `GET /api/v1/outgoing` | `messages:read`，仅当前用户，时间倒序分页 |
| `GET /api/v1/outgoing/:id` | `messages:read`，当前用户发送详情及正文 |

POST 需要 `Idempotency-Key`，16–128 位字母、数字、横线或下划线。
JSON 允许 `to`、`subject`、`text` 和可选的本地 `replyToMessageId`；W1 新增可选配对 `draftId`/`draftRevision`，见[云端草稿](cloudflare-drafts-slice.md)。不提供时既有 hash 保持不变。
单一收件地址最大 254 字符，不接受地址列表、显示名、SMTPUTF8 或 quoted local part；
主题 1–200 字符且禁止控制字符，正文 1–6000 字符且不可全空白或含 NUL。
整个 JSON 仍受 8 KiB UTF-8 请求体上限约束，非 ASCII 正文可能更早达到字节上限。
不提供 HTML 编辑、附件、抄送、密送或定时发送。

```json
{
  "to": "acceptance@example.test",
  "subject": "Example",
  "text": "Plain text body"
}
```

返回 `{ "outgoing": { ... } }`，永远包含 `retrySafe: false`、`delivery: "unconfirmed"`。
同 Key、同规范化请求回放已存记录；不同正文、收件地址、邮箱或 reply 来源返回 409。
发送专用 Key 可通过相同 POST 回放自己所属用户的记录，不因此获得读取其他邮件或管理权限。
旧 Key 不自动增加新的 `messages:send`。

| 状态 | 语义与 HTTP |
| --- | --- |
| `pending` | 已持久化预留；可能尚未调用，也可能在途，202；不得再次 dispatch |
| `accepted` | 精确 HTTP 200 且供应商 JSON 为 `status: ok`；首次 201、回放 200；不证明送达 |
| `rejected` | 自营接口明确的发送前 401/403/429 拒绝，200；仍不自动重发 |
| `unknown` | 超时、断连、400、5xx、重定向、畸形响应或发后保存失败，202；不得重发 |

状态中的 error 只返回分类，不返回上游正文或秘密。
401/403/429 的发送前解释依赖当前自营接口的中间件合同；即使合同漂移也不会自动重发。
上游没有幂等或结果查询接口，聚合数据库与外部发送不能组成分布式事务：
崩溃在预留后、调用前也会保守地留 pending/unknown，宁可人工核验，不能宣称 exactly-once delivery。

pending 超过 60 秒的 GET 展示为 unknown，但 GET 不写库。
scheduled 每次最多将 5000 条过期 pending 持久化为 unknown，不删除幂等 guard。
发后保存失败时再次尝试保存 unknown；即使再次写失败，原 pending 预留仍阻止重复 dispatch。
重启、API Key 变化、配置变化不会使旧 Key 再次发送。

## 配额与历史

一次 SQLite `INSERT ... SELECT` 原子检查唯一 Key 和配额后预留，再由成功预留者发送。
当前保守默认值：每用户滚动 60 秒最多 3 次、UTC 日最多 20 次；
全平台滚动 60 秒最多 10 次、UTC 日最多 200 次。
所有预留包括 rejected/unknown 都计数，不自动退回，防止未知结果被用于绕过限额。
配额检查失败关闭，非原子先查后写和手动 fresh Key 均不能越限。

历史列表按 `(created_at DESC, id DESC)` keyset 分页，支持 limit 1–100；
游标必须属于当前用户。列表不返回正文，详情才返回正文。
不是强一致快照；并发新增请刷新。平台删除/保留策略尚未完成，不能随意清空幂等表。

## 回复和 Web

- 详情只从缓存 sender 提取严格的单一地址作为候选；无法安全解析则禁用快捷回复。
  上游解析接口未提供 Reply-To，不能声称遵循了 Reply-To。
- 用户点击回复只准备表单，仍需检查收件人、主题与正文，并勾选发送确认后显式提交。
- reply 来源必须是同用户、同邮箱的缓存消息；不可传任意线程头。
- 自营 parsed mail 的 `message_id` 经安全子集校验后保存。
  新 metadata 不参与原内容指纹；补 metadata 保持原本地消息 ID、已读/星标/归档，不复制消息。
- binding 模式有有效原 Message-ID 时生成单个 `In-Reply-To` 和 `References`；
  accepted 后仅称线程头已随请求提交，不声称真实客户端已归并会话，也不伪造完整历史 References 链。
- worker 模式不支持线程头，或缓存无合法 Message-ID 时明确返回 unavailable。
  非 accepted 的线程头状态为 unconfirmed，不把预留当成已提交。
- 网页保留不确定 attempt 的原正文和幂等键；切换工作台页面、检查时收到 429/401/403 均不丢弃它。
  新起一封邮件需要独立操作，unknown 时还需确认，不是重试旧邮件。
- 不把正文或 Key 写入 localStorage/sessionStorage。完整刷新/退出后通过持久发送记录检查结果；
  W1 提供显式保存的云端草稿与跨设备恢复；未保存的内存内容仍不承诺刷新后保留，不提供自动重发入口。

## 升级和回退

新增 `0004_outgoing.sql`，不改写 0001/0002/0003。
为 messages 添加 nullable RFC metadata，新增 outgoing 表、唯一约束与配额/时间索引。
升级前先应用 expand；旧读取方忽略新列、新表，原缓存和整理标记保持。
回退只切回旧应用，不删除新表、guard、历史或列，不能通过回滚数据库重放未知发送。
当前没有生产部署，本地验证不构成发布、切流或数据导入批准。

## 外部合同依据及未完成项

2026-10-28 已联网核对 Cloudflare 官方文档：

- [Workers sending API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
- [允许的自定义邮件头](https://developers.cloudflare.com/email-service/reference/headers/)

官方 builder 允许 `In-Reply-To`、`References`，原生 API 可返回 messageId；
但当前自营 HTTP wrapper 丢弃该返回值，只返回 status，聚合层不能编造 provider messageId 或投递回执。

尚未完成：真实供应商发送与外部收件验收、真实线程归并、Cloudflare CPU/并发/配额验证、
安全附件下载、管理及生命周期、生产数据保留和可靠投递队列；云端草稿的独立实现及边界见 W1。
这些目标仍保留，M3b 本地通过不等于整个迁移完成。
