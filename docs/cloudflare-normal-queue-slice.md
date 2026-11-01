# W10p：普通邮箱排队与定时发送

## 范围与所有权

在独立迁移工作区接通普通邮箱 Web/API 的持久发送意图。沿用唯一普通写信器、SMTP 序列化器、草稿 CAS 和私有发送附件，不创建第二套发送客户端。不访问现网或迁移生产数据。

`0035_normal_send_jobs.sql` 仅新增普通任务、操作回执表、共享入队用量 view 和时间索引。旧临时任务表具有非空 mailbox 外键，不能用虚构 mailboxId 表示普通账号，因此保留旧表并使用真实 `(user_id,account_id)` 外键。普通任务保存独立 `account_revision/smtp_revision`，响应也返回真实账号和冻结版本。

普通和临时任务通过服务器封闭 descriptor 复用 claim、reconcile、取消、重试准备、预约交接与清理算法。请求和 payload 不能选择表名、权限或来源。普通路由始终按用户和账号隔离，临时队列不混入普通任务。

## API

根路径为 `/api/v1/normal-accounts/{accountId}/send-jobs`：

- `POST`：普通发送原有正文、账号/SMTP 版本、可选回复、草稿及附件引用，另支持 `scheduledAt`。
- `GET`：当前账号分页列表，支持 `limit/cursor`。
- `GET ?requestKey=...`：只读核对原入队；不能同时传其他查询参数。
- `GET /{jobId}`：任务详情及原发送状态。
- `POST /{jobId}/cancel`、`POST /{jobId}/retry`：`expectedRevision` 和独立 `Idempotency-Key`。

入队和 retry 需要 `mail-accounts:schedule` 与 `mail-accounts:send`；cancel 需要前者。读取需要 `mail-accounts:read` 与 `messages:read`。非空附件另需 `attachments:read`，草稿另需 `drafts:write`，回复另需账号及邮件读取权限。新增 `normal-schedule` Web Key 预设，不扩大旧预设或已签发 Key。

`scheduledAt` 缺省或 null 表示后台尽快处理；整数 UTC 秒须为当前至未来 30 天。deadline 为 due 加 24 小时与所有附件到期时间的最小值，且必须晚于 due。排队不延长附件 TTL，也不保证准点或最终送达。

任务 request hash 版本化绑定原普通发送 hash 和 scheduledAt；原直接发送的 hash、无附件 MIME 和响应合同不变。任务 payload 使用固定 `queue:{jobId}` outgoing key；恢复与所有准备重试都使用此 key。

## 原子与不确定结果

入队 SQL 最终检查 active 用户、精确账号/SMTP 版本、启用和凭据、回复证据、草稿 CAS 及附件版本。同一 D1 batch 插入任务并把草稿置为 submitted。入队不建立 outgoing、不扣真实发信收件人数；草稿的 outgoingId 此时仍为 null，取消不会恢复草稿。

两类任务共用每用户 20 / 全平台 200 的 active 与 UTC 日入队限额。每分钟 cron 从两个来源统一排序选取最多 3 个候选；不是各 3 个。真实 SMTP 预约仍受共享收件人数限额，包括用户每分钟 3 人，因此排队不绕过发信配额。

claim 租约为 120 秒，最多 5 次准备；瞬态准备失败按 60/300/900/3600 秒退避，最多手动重试准备 3 次。runner 固定使用任务表账号/SMTP 版本，配置变化不得静默改用新版本发信。重新检查实际 R2 字节与完整 MIME 后，才能预约。

预约在同一事务中建立普通 outgoing pending guard，并将普通任务改为 submitted，交接附件 pin。取消与预约竞争同一个 claim 状态；旧 lease 或已取消 token 不能建立预约。预约回执丢失时绝不继续 SMTP，后续只按持久 guard reconcile。

SMTP accepted、rejected 或 unknown 一旦建立 outgoing，任务不再 dispatch，也不能手动 retry 发信。accepted 仅表示 SMTP 服务器接受，delivery 始终 unconfirmed，不等于公网投递成功。

## Web 与生命周期

写信器复用发送安排组件，首次冻结 endpoint kind、账号、版本、正文、附件、草稿、计划时间和幂等键。入队丢响应只 GET 原账号的原 requestKey；not_found 后才允许显式重提相同请求，不重新计算计划时间、不切换为 direct。

新建、新回复和重新打开草稿默认恢复立即发送；安排不写入草稿。共享队列组件使用普通账号路径，取消/retry 未决时保存原 path/kind/key/revision，后续核对是同键 POST 回放，不是只读 GET。未决期间锁定账号导航、回复替换与云草稿操作，但不锁死原操作恢复按钮。

queued/preparing 且未过 deadline 的普通任务 pin 用户、ID、version 匹配的附件；交接到 pending outgoing 后继续 pin。失败或取消后按原附件生命周期清理。

统一 retention 沿用 outgoingDays，清理 cancelled、过 deadline 的 failed、以及已有非 pending outgoing 的 submitted 内容和 manifest。仍可 retry 的 failed 与 pending 保留内容；永久保留任务 hash/outgoing key 和操作回执，清内容不重建任务、不释放 no-repeat guard。普通 outgoing 的正文及 manifest 仍由原维护入口独立清理。

## 验证与兼容窗口

正式收据位于 `linshi/easyemail-cloudflare-migration-20261028/normal-queue-final/`，独立 Wrangler 本地迁移及 dry-run 位于 `normal-queue-platform/`；以实际 verification 和 closeout 状态为准，不复用 W10o 的通过结果。新增测试覆盖重启、二进制附件、计划与取消、来源/权限隔离、共享配额及预算、预约竞态、丢 guard 回执、终态不重发、草稿回滚和 retention guard。

启用前先应用 0035，并排空旧入队、调度、附件清理及普通发送写入方。旧版本不了解普通任务 pin 和共享入队用量，不能在新任务启用后与它并行维护，也不能直接降级运行。若未来需要停止新功能，应停止新入队并保留识别 0035 的维护/核对能力，另行审核回退方案；不得删除新表、数据、操作回执或 outgoing guard。

当前回退仍是不合并迁移分支、继续原目录和原部署。本阶段不包含真实 SMTP 账号认证、公网投递、Cloudflare 实际发布、容量成本验收或旧生产队列导入。
