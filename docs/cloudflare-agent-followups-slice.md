# Agent 同线程多消息 follow-up 后端（W11h3a）

本阶段实现 task/inbound 两种真实线程根的多封显式发信 API、持久队列、SMTP MIME 父链及回信归属。不新建任务来模拟跟进，不把 inbound UUID 写入旧 task-only FK。
**本文件记录后端阶段，不包含网页验收。后续网页接入见 [W11h3b](cloudflare-agent-followups-web-slice.md)；后台自动收件、Agent OAuth、真实公网投递和整体迁移仍未完成。**

## 数据、来源与兼容窗口

0048 采用 expand-only：新增 `agent_thread_sources`、`agent_followups`、共享排队及回信候选 view、索引与容量 trigger；旧表定义和旧行保持不变。
每封 follow-up 独立持有 ID、RFC Message-ID、原键/hash、正文、发送来源版本、队列状态及一次性 dispatch token。同根可以拥有多条 follow-up，不复用原 outgoing/job 的单线程 UNIQUE 行。

来源锁绑定 owner/root/实际 account/service 及实际 from/to 的 hash，不复制地址正文到线程根。首次显式跟进事务惰性建立：

- task 根必须仍保留原 from/to，且与当前实际来源一致；内容已清理且没有锁时拒绝猜测来源。
- inbound 根尚无锁时，创建时的 account/service 版本必须仍等于当前版本。首次发信前已有版本变化即拒绝，而不是假定同 ID 代表同身份。
- 有锁后可使用同地址的新版凭据或显示配置，但每一封新意图仍冻结当前 account/SMTP/service 版本和 endpoint hash。实际地址改变会拒绝；服务默认发件账号不能替换 root 的真实账号。

锁与发送意图在同一 batch 建立。最终 `queued -> pending` 重新检查 root/account/service、owner active、冻结版本、endpoint、实际 from/to 与共享额度。
回退旧 runtime 时保留新增表、trigger 和扩展后的同名额度 view；不要 DROP 或迁回旧 task 表。旧 runtime 暂停新 follow-up 队列，不会自动认识新 Message-ID，其来信可能仍是 unmatched。旧 task writer 达到混合队列上限时可能返回 storage failure，而非新端精确错误。
当前代码在尚无 0048 schema 时保留旧 task-only 收件和调度路径；新 follow-up API 必须先应用 0048 再使用。

## API 与权限

```text
GET  /api/v1/agent-threads/:id/followup-context
GET  /api/v1/agent-threads/:id/followups?limit=20&cursor=...
POST /api/v1/agent-threads/:id/followups
GET  /api/v1/agent-followups/:id
GET  /api/v1/agent-followups?requestKey=...
POST /api/v1/agent-followups/:id/cancel
```

读操作需要 `agent-tasks:read`；新建/取消还需要新权限 `agent-threads:send`。incoming 锚点还需要 `agent-inbox:read`。
不扩张旧 `agent-tasks:send`、`agent-threads:write` 或入站管理 Key 的发信权。Session 写操作强制同源 Origin，Bearer 沿用既有鉴权规则；原键、详情、列表和 context 返回前再次检查凭据有效性。

POST 完整输入由以下字段组成，拒绝额外字段：

```text
serviceId, serviceVersion, senderAccountId, accountRevision, smtpRevision,
subject, text, confirmRestricted, expectedThreadRevision,
replyToType: task | followup | incoming, replyToId, confirmUncertain
```

`expectedThreadRevision` 是人工管理版本。仅 open/needs_attention 可新建；队列中既有意图不因后续人工完成/归档而取消，取消有独立入口。
创建必须携带 UUID `idempotency-key`。201 首建、200 同键重放、409 异内容；丢 ACK 返回 503 时先 GET 原键，只在明确 404 时用同一键和完整 body 重试，不另建键替代核对。
取消仅对 queued + expectedRevision 有效；pending/unknown/accepted 不提供重试或撤回承诺。
列表最多20条，游标绑定同 owner/root，正文及地址仅由详情/原键读取，不出现在列表 DTO。

## 锚点、发送与不确定性

任务或历史 follow-up 锚点必须同 owner/root、有 submitted 证据且实际 from/to 相同。incoming 锚点必须当前 source/epoch/generation、committed、未 purge、有效关联同根、发件地址等于固定远端服务。
incoming 的 review revision 在 enqueue 事务再次检查；后续重新归类、清理或缓存代次变化不能留下半条发送意图。
客户端不能传任意 RFC headers；服务端解析所有权消息的 RFC ID，生成 `In-Reply-To` 和最多24个安全 References。入站锚点仅使用自己的 RFC ID，不读取或 pin R2 正文/附件。

每次 cron 最多处理一条到期 follow-up。准备阶段可在 deadline 内最多4次、间隔60秒退避，之后终止；没有跨 pending 的自动重试。
pending 预留与 quota 检查同事务；没有收到预留 ACK 不开 socket。最终回执丢失保留 pending，60秒后暴露 unknown。SMTP accepted 仍是送达未确认。
同根已有 pending/unknown 时，未确认风险的新意图不得入队；**入队后出现的新不确定状态也在最终 pending 边界重新检查**。未确认的后续意图有界等待并显示 `agent_followup_uncertain_predecessor`，不能绕过确认继续开连接。
`confirmUncertain=true` 只代表这一条新的明确意图承认不确定风险，不修改旧行、不释放旧 charge、不重发旧 Message-ID。

共享 queued 容量为每用户100，follow-up 历史为每用户10000、每根1000；数据库 trigger 也保护旧 task writer。额度 view 仅统计实际 submitted 的 follow-up，queued 不提前计费。unknown、拒绝和内容清理均不撤销已经发生的额度预留。

## 收件归属和生命周期

候选统一为 `(kind, threadId)` 后 DISTINCT。References 同时命中原 task 和同根多封 follow-up 仍只算一根；命中不同根才 ambiguous。头部关联不等于发件身份认证。
task 回复继续写旧 incoming.thread_id；inbound 回复保留旧字段 unmatched/null，在同一收件 commit batch 内写 `agent_inbound_messages`，之后才推进 cursor/清 claim。
membership 插入失败必须使整个收件 commit 回滚；commit ACK 丢失按原 sync request 核对，不能重复归属。
每封入站消息自己的 review revision 决定 membership 是否有效。种子被重新归类不废弃根，也不使未来成员连带失效。
retention 清理终态 follow-up 的地址、主题和正文，保留原键/hash、RFC 元数据、route hash、状态及实际 charge；不 pin 收件 R2，也不恢复已清理内容。

## 验证与未验边界

新增回归覆盖两类根、多个 follow-up、MIME 父链、权限、来源漂移、版本轮换、CAS/Origin、队列/历史容量、分页、并发原键、取消与归档、丢 ACK、pending guard、前序 unknown、共享 quota、retention、收件原子性及旧 schema/表行保留。
真实本地 workerd/D1、合成 SMTP/IMAP 传输及私有本地 R2 证据位于 `AI/GameEditor/linshi/easyemail-cloudflare-migration-20261028/agent-followups-*`，最终状态以独立 `verification.json` 为准。
不得使用 W11h2 的绿色收据代替本阶段新代码验证；本地 SMTP 合成验收不等于真实服务商投递，不等于 Cloudflare 部署或流量切换。Web 显式发送、父级未知原键核对与 Chrome 验收由 W11h3b 独立提供收据，不借用本后端阶段的结果。
