# Agent 显式收件与头部回信关联（W11e）

在 W11d 持久任务发送基础上，接通独立 Agent 收件的 Web/API、真实 IMAP/MIME 路径和有限头部关联。
没有后台自动连接所有邮箱，没有执行邮件正文，没有把 `linked` 当作发件身份认证、任务完成或公网送达。
默认账号配置及显式选用见 [W11f](cloudflare-agent-senders-slice.md)，人工关注/重新关联已有任务见 [W11g](cloudflare-agent-review-slice.md)；新入站线程、完整线程生命周期、follow-up 和 Agent OAuth 继续迁移，整体目标未完成。

## 读写与隔离

- `agent_inbox_requests/state/batches` 与 `agent_incoming_messages` 独立于普通邮箱和临时邮箱。
- 原始邮件和解析内容保存到私有 R2 `agent-inbox/v1/:user/:account/:batch/:uid`；不写 normal inbox，不依赖 NAS。
- 复用 IMAP reader、MIME parser、UID 检查点规划和内容/附件摘要校验，不复制第二套收件协议。
- Agent 凭据仍使用独立 AAD；只接受部署白名单的应用密码 IMAP endpoint，不隐式套用普通 Google OAuth。
- 每次同步最多检查 100 个 UID、实际取回最多 3 封，单封原始邮件最多 2 MiB；跳过过大或已消失邮件会返回原因。
- UIDVALIDITY 或来源改变后建立新 epoch，旧邮件 ID/分页不再可读，不跨纪元复用 UID。

## API 与权限

共同前缀 `B=/api/v1/agent-accounts/:accountId`：

| 路径 | 合同 |
| --- | --- |
| `POST B/sync` | UUID `Idempotency-Key`；body 仅 `expectedRevision` 正整数 |
| `GET B/sync-requests/:key` | 原 UUID 键只读核对，不连接 IMAP |
| `GET B/messages` | `limit` 1–20、epoch/UID cursor；可筛选 `association`、`threadId` |
| `GET B/messages/:id` | 私有正文、安全展示所需元数据及关联结果 |
| `GET B/messages/:id/raw` | 摘要核验后的原始邮件下载 |
| `GET B/messages/:id/attachments/:index` | 原文摘要、真实解析附件长度和摘要均核对后下载 |

读取需要独立 `agent-inbox:read`；同步和原请求查询额外需要 `agent-accounts:sync`；原文/附件另需 `attachments:read`。
普通 `messages:read`、`mail-accounts:sync` 或 Agent 配置权限不自动赋予 Agent 收件阅读权限。
Session 写操作要求同源 Origin；Bearer 可以不带 Origin。未知字段、重复筛选、错 epoch/筛选 cursor、非法 UUID 均拒绝。
列表和详情检查实时 owner、active user、会话/Key；读对象后再次检查账号版本、epoch、清理代次和消息未被清除，迟到正文不泄漏。

## 原键、事务与失败语义

原键绑定账号和账号 revision，版本不同返回 `idempotency_conflict`；`pending/failed/committed` 原请求不会再连接。
预约请求前重新检查实时凭据和账号版本，另有每用户/全局每分钟 10/60 请求准入；每用户累计最多 10000 份回执。
独立账号租约为 90 秒；重放只读原回执，即使 INSERT 回应丢失也不借机重连。过期未提交请求显示 failed。

先保存完整 manifest 及容量预约，再写不可覆盖的 R2 对象；所有对象 HEAD 的字节数和 SHA-256 核验后才提交。
D1 同一 batch 原子提交批次可见性、incoming rows、原请求结果和 cursor，fence 包含确切 request 的 owner/account/revision/pending。
提交回执丢失按确切 request 的 committed 状态核对；SQL 中途异常整批回滚，失败不会推进 cursor。
每账号最多 1000 个未退役 batch、1000 封、128 MiB；staged/retiring 和清理失败对象仍计入容量。

## 自动关联的证据边界

- 只从真实 MIME 的单一非 group `From` mailbox 提取服务地址；重复头、多邮箱作者、超限或无效回复头不参与自动关联。
- 只使用有界 `In-Reply-To` / `References`，大小写不敏感去重；不使用入站自身 Message-ID、主题或正文猜测。
- 在提交事务内查询当前同用户服务及同接收账号任务；outgoing 必须有 `submitted_at`，即已跨持久派发 guard。
- `submitted_at` 在开 socket 之前落库，不证明 SMTP 接收成功；拒绝/未知发送也可能有该证据。
- 唯一线程命中为 `linked`；多线程命中为 `ambiguous`，没有“先命中获胜”。其他状态为 `unmatched/unknown_service/service_unavailable/invalid_headers`。
- blocked、停用、归档或删除服务不自动 linked；关联后仍返回 `authentication: "unverified"`，不表示 SPF/DKIM/DMARC 通过。
- 入站关联不改写 W11d outgoing、job 或 thread 投递结果；任务详情单独显示关联回信。

## 回收与保留

每 15 分钟维护失败/过期 staged、旧 epoch、已删除账号及符合已启用 `cacheDays` 的已提交 batch；不做后台收件连接。
先在 D1 事务中退役为 `retiring`、tombstone 消息、推进清理代次并写精确对象删除 journal；有效同步租约不被清理。
manifest 的 owner/account/batch/UID key、item count、累计字节必须一致，不按对象年龄猜测删除权限。
账号实际 username/endpoint/address 改变时，schema-owned trigger 原子失效旧 epoch/cursor/claim，使不可读旧来源即使已满额也可独立回收；仅名称或密码更新不触发来源退休。
R2 明确删除应答后记 cleaned，全部完成才变 `retired` 释放容量。删除失败保留 journal 并可重试。
有界 inventory 持续检查已确认清理键，补收租约过期后迟到的 put；未知键、其他命名空间和仍被读取的活消息不会仅因年龄而删除。
原请求的 committed/failed 结果不因缓存退役而改写，旧键不重新取信；回退旧 runtime 保留新表、journal、对象和回执，不 DROP 或清空。

## Web 与验证

Agent 邮箱页提供显式同步、缓存刷新、列表/详情、安全 HTML 和可核验附件；任务详情提供按实际 threadId 筛选的关联回信。
未知/畸形结果保留原键和原版本，先 GET 核对，仅明确 404 才重发同一请求；未决时锁住邮箱配置/移除，切页保留内存意图，换用户卸载。
不写 LocalStorage/SessionStorage，邮件 HTML 仍使用共享安全展示，不自动打开外部资源或执行正文。

证据根：`C:\Users\Public\nas_home\AI\GameEditor\linshi\easyemail-cloudflare-migration-20261028`。
起点 `agent-inbox-baseline/baseline.json`；最终实测状态以 `agent-inbox-final/verification.json` 为准，不借用 W11d 绿色收据覆盖本轮源码。
本地协议夹具和合成关联不等于真实服务商认证、Cloudflare 生产环境、真实收投或整体迁移验收；本轮不读取生产凭据、不提交/推送/合并/部署。
