# Cloudflare 收件与提取切片（M2 本地实现）

## 边界

迁移工作区为 `C:\Users\Public\nas_home\EasyEmail`，分支为 `migration/cloudflare-web`。
原项目、旧 NAS、域名和生产数据不变。本切片不部署、不合并，不导入真实凭据。
本地 HTTP fixture 是合成供应商，不是真实邮件投递验收。

现有能力：登录后的 Web 与 API 共用邮箱分配、同步、缓存详情、验证码和认证链接提取。
自营邮箱通过管理员创建接口实际创建；Temporam v3 仅在平台分配随机地址，没有远端租约。
M2 的原始范围仅开放 128-bit 随机前缀。后续 M3l 已增加自营[受约束自定义前缀](cloudflare-custom-prefix-slice.md)，Temporam 仍为随机分配。
不开放凭地址恢复、任意上游地址或用户提供的供应商 Key，不通过放开任意地址查询完成“恢复访问”。

## 配置与凭据

Worker 绑定以下配置。示例全部是假值，不能直接连接真实供应商：

```json
{
  "PROVIDER_CONFIG": "[{\"id\":\"self\",\"type\":\"cloudflare\",\"baseUrl\":\"https://mail.example.test\",\"domains\":[\"mail.example.test\"]},{\"id\":\"temporam\",\"type\":\"temporam\",\"baseUrl\":\"https://api.temporam.com/v3\",\"domains\":[]}]",
  "PROVIDER_SECRETS": "{\"self\":{\"apiKey\":\"synthetic-admin-key\",\"sitePassword\":\"synthetic-site-password\"},\"temporam\":{\"apiKey\":\"synthetic-api-key\"}}",
  "MAILBOX_KEYRING": "{\"active\":\"k1\",\"keys\":{\"k1\":\"<independently-generated-32-byte-lowercase-hex>\"}}"
}
```

`PROVIDER_CONFIG` 为平台管理的非秘密配置；`PROVIDER_SECRETS` 与 `MAILBOX_KEYRING`
必须通过 Worker secrets 或隔离本地 `.dev.vars` 注入，禁止写入 Git、网页和普通日志。
本地不自动复制 `aikey` 中的生产秘密。仅 APP_ORIGIN 为 HTTP loopback 时允许 loopback HTTP fixture；
部署配置必须为 HTTPS，拒绝含用户名、密码、query 或 fragment 的上游地址。
请求不跟随重定向，单次操作 15 秒期限，响应体最大 2 MiB；不自动重试远端写入。

Cloudflare 管理员 Key、站点密码和邮箱 JWT 用途不同。管理员 Key 用于创建及 M3l 自定义能力预检，
邮件查询只用该邮箱 JWT 和必要站点密码。JWT 以 AES-GCM 加密保存 D1，随机 96-bit IV，
AAD 绑定用户、邮箱和供应商实例。Keyring 的旧 Key 应保留到完成独立的重加密迁移；
切换 active 只影响新写入，不自动重加密旧数据，移除旧 Key 会让相关邮箱失败关闭。

## 开放 API 与权限

路径均以 `/api/v1` 开头。Cookie 会话可操作自己的资源，写操作要求精确 Origin；
API Key 依作用域授权，不要求浏览器 Origin。旧 `mailboxes:read` Key 不自动得到正文或写权限。

| 方法与路径 | 作用域 | 行为 |
| --- | --- | --- |
| `GET /providers` | `mailboxes:read` | 实例 ID、类型及真实能力，不返回秘密或上游地址 |
| `GET /providers/:id/domains` | `mailboxes:read` | 自营配置域名；Temporam 在线域名与配置白名单交集 |
| `POST /mailboxes` | `mailboxes:write` | `{providerId, domain}` 与 `Idempotency-Key`；M3l 可选 `prefix` 见独立合同，仍不接收完整地址 |
| `GET /mailboxes`、`GET /mailboxes/:id` | `mailboxes:read` | 自己的邮箱元数据与同步状态 |
| `POST /mailboxes/:id/sync` | `mailboxes:write` | `{}` 从第一页开始；`{page: N}` 仅允许已记录的下一页 |
| `GET /mailboxes/:id/messages` | `messages:read` | 缓存列表，UUID keyset 分页，不隐式请求供应商 |
| `GET /mailboxes/:id/messages/:messageId` | `messages:read` | 缓存正文和附件元数据，无附件下载承诺 |
| `GET /mailboxes/:id/extractions?since=...` | `messages:read` | 明确起点的缓存提码和链接，支持 sender/subject/recipient |
| `POST /mailboxes/:id/extractions/check` | `messages:read` + `mailboxes:write` | M3i 单页同步与条件查询；供有界轮询使用，不在 Worker 内等待 |

`since` 是 UTC Unix 秒，必须大于零且不能超过当前时间 60 秒；它不是本地观察时间。
sender/subject 为大小写不敏感的包含匹配，不是发件人身份认证；recipient 必须等于该邮箱地址。
结果按供应商收件时间从新到旧，扫描最多 100 封，最多返回 10 封有提取结果的邮件，
`searchLimited` 表明扫描窗口是否截断。未知时间和超过允许时钟偏差的时间不作为新邮件返回。
Cloudflare 的无时区 SQLite 时间按 UTC 解释；Temporam 要求显式时区，不猜本地时区。

验证码与链接直接调用现有 `service/base/src/domain` 的纯领域实现，不复制算法。
相对链接补出的 `easyemail.local` 地址不返回；邮件正文和链接都是不可信数据。
Web 以文本渲染正文，不执行 HTML、脚本、自动访问链接或请求远端图片。

## 幂等、缓存与同步语义

创建先持久化用户与幂等 Key、请求摘要、随机地址，再执行远端写入。
同 Key 同请求回放；不同请求返回 409。进行中返回 202/pending。
远端响应不明、超时、或远端成功但本地保存失败返回 202/unknown，附脱敏错误码及 `retrySafe: false`。
中断留下的 pending 不自动抢占，也不静默改用另一个地址；人工/后台对账与接管尚待实现。
当前每用户最多 100 次持久化分配记录，含 unknown；这是有界开发切片，不是完整生命周期配额。

同步一次最多一页 10 封；Temporam 读取详情，因此分页预算不只计算列表请求。
`nextPage` 非空表示还有后续页。`complete` 表示此次遍历到末页且累计没有缺失详情，
不表示供应商提供了一致性快照；上游 offset/page 在新邮件插入时仍可能移动，应定期重新从第一页刷新。
`syncedAt` 仅表示最近一次成功页的观察时刻，不代表整个远端邮箱全量新鲜。
失败保留旧缓存与游标；整轮缺失累计保留到下一次从第一页开始，不会被正常末页清除。

每邮箱通过 45 秒 lease 和 token fencing 限制并发写回，获取 lease 时验证同步版本，
防止校验下一页后发生游标变化的旧请求继续写回。过期 lease 可由后续请求接管。
邮件插入与状态更新为一个 D1 batch；失去 lease 的旧执行不能写缓存或释放继任者 lease。
缓存指纹包含远端 ID、收件时间和规范化内容，兼容上游整数 ID 被复用，重复读取不重复入库。
上游内容改变会形成新缓存版本，不伪造远端删除或覆盖历史内容。

## 数据迁移与回退

`0001_identity.sql` 保持原样，`0002_mail.sql` 仅扩展列、索引和表。
未来测试发布应先应用 expand migration 再启动依赖新列的 Worker；旧 M1 Worker 可继续读取旧字段。
地址唯一索引要求旧数据无大小写不敏感的重复地址；发现冲突应停止并对账，不能删旧数据来通过迁移。
本地测试先建 M1 用户、会话、Key 和邮箱，再扩展并重启，核验归属和身份保留。
没有 destructive down migration；开发回退继续使用原 worktree/原部署，不删除新数据库或任何旧资源。

## 未完成

真实供应商、真实邮件投递及生产 Worker CPU/配额未验收。
M3a–M3i 已后续加入整理/聚合、发送、安全 HTML/附件、平台生命周期、管理/保留、自动选择、
创建历史及有界新结果等待；实现与未验边界以 [当前覆盖清单](cloudflare-feature-scope.md) 及各切片为准。
其他供应商、远端生命周期和 unknown 对账、完整后台与后续工作台仍未完成，不能因本地切片通过而宣称全部完成。
