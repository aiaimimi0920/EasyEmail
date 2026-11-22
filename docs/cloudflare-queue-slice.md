# W9：持久发送队列、定时与取消

实现位于 `service/cloudflare`，新增 `0022_send_jobs.sql`，不重建旧表或改写旧发送 hash。
这是本地迁移候选；独立验证依据为证据目录的 `queue-final-r2/verification.json` 和 `queue-platform/verification.json`，仅以实际 `status` 为准。
W8 及更早收据不覆盖新源码；没有生产部署、真实资源创建或公网投递验收。

## 用户合同与 API

所有路径前缀为 `/api/v1`。Web 与程序复用相同授权、校验和持久状态机。

| 接口 | 合同 | 权限 |
| --- | --- | --- |
| `POST /mailboxes/{id}/send-jobs` | 接受不可变发送意图，要求原 `Idempotency-Key` | `messages:schedule` + `messages:send` |
| `GET /send-jobs` | 私有摘要、时间/ID 游标，不返回正文 | `messages:read` |
| `GET /send-jobs/{id}` | 私有任务、内容和已有 outgoing 结果 | `messages:read` |
| `POST /send-jobs/{id}/cancel` | 原操作键 + `{expectedRevision}`，仅预约前可取消 | `messages:schedule` |
| `POST /send-jobs/{id}/retry` | 同一不可变意图的安全准备重试，不重置预算/期限 | `messages:schedule` + `messages:send` |

入队接受原发送字段，再加 `scheduledAt`：省略或 `null` 表示立即排队，整数表示 UTC 秒。
JSON 仍限 8 KiB；附件只接受 `{id,version}`，关联草稿仍需 `drafts:write`，附件仍需 `attachments:read`。
手动 retry 继续既有授权意图，不修改附件、草稿或发送内容，不重新授予资产字节下载权限。
旧 Key 不自动获得 schedule scope；会话写操作仍要求精确 Origin，所有操作验证 owner。
任务接受后撤销/到期的 Key 只阻止未来请求，不撤销已有意图；须显式 cancel。账号和邮箱资格仍在预约时复核。

## 时间、限额与状态

- 计划时间须在未来 30 天内。执行窗口为到期后最多 24 小时；附件原固定 TTL 可以更早终止窗口。
- 用户活动任务最多 20、平台 200；UTC 日接受上限分别为 20、200。唯一键与预算在同条写入中检查。
- 每分钟 cron 最多处理 3 个候选，准备 lease 为 120 秒；重复/并发 cron 不依赖“只触发一次”。
- 准备最多 5 次；只对无 outgoing guard 的暂时失败退避 60/300/900/3600 秒。
- 手动 retry 最多 3 次，且仍受总准备 5 次、原 deadline、内容未清理和无 outgoing guard 约束。
- 真正派发继续使用原按收件人数计费的用户/平台分钟和日配额；未知/拒绝结果不退额度。

```text
queued -> preparing -> submitted -> 展示原 outgoing 的 pending/accepted/rejected/unknown
queued/preparing -> cancelled 或 failed
failed -> queued（仅未预约、尚有准备预算/期限，并且用户显式 retry）
```

`submitted` 是内部状态，不是投递成功；`accepted` 仅表示渠道接受，所有 delivery 仍为 unconfirmed。
取消只阻止尚未预约的派发，不是撤回邮件。预约已提交后不允许通过 cancel/retry 改写结果。

## 一次外部尝试的边界

D1 是任务、claim、幂等 guard、配额及状态的权威，R2 是不可变附件字节的权威。
每个任务持有固定且不能由 HTTP 直接指定的 `queue:<uuid>` outgoing key，重启或 lease 接管不换 key。
立即发送与后台任务复用输入、准备、原子发送预约和单次 provider dispatch，不复制第二套发送器。

最终 outgoing INSERT 同时检查：用户 active、邮箱状态/到期、回复源、供应商 revision、收件人数预算、附件版本/期限及 job state/token/lease/deadline。
此 INSERT 与 job 转 submitted、交接附件 pin 在同一个 D1 batch 中提交。取消操作和预约互相排斥，由数据库先提交者裁决。
旧 worker 在 lease 接管/取消后即使已读完正文与字节，也不能越过最终 fence。

提交确认丢失、进程中断、供应商断连或结果写回失败，均不能通过再次发送探测结果。
已有 guard 优先于任何准备异常；后续只对账到 submitted/pending/unknown，不重新 queued。
这是“持久化意图 + 最多一次外部尝试”，不是恰好一次送达：预约后、网络调用前崩溃可能保守漏发。
不要把 D1 写入放进 `Promise.race` 超时后盲重试，超时不会取消已开始的写入。

## 草稿、附件和清理

草稿版本、原内容 hash 与 editing fence 跟 job INSERT 在同一事务内消费为 submitted、revision+1。
draft 表不增加 queued 状态，不把 job ID 冒充 outgoing ID；job 保存独立关联与不可变内容快照。
取消不恢复旧草稿，删除其展示副本不撤回已接受意图，防止同一草稿二次消费。

未过 deadline 的 queued/preparing pin 附件，并阻止邮箱远程删除。入队与实际发送均检查原附件资格。
pin 不是续期；执行时过期仍失败。到期、取消、失败或交接至 outgoing 后释放相应 pin，不永久占用对象。
邮箱停用、释放、到期、账号停用或新 allowlist 不再允许收件人时，不会继续使用旧资格发送。

任务正文、收件人、附件清单形成独立副本，跟随现有 outgoing 保留策略清除：
cancelled、已过 retry 窗口的 failed、以及已有非 pending outgoing 的 submitted 才可清理。
活动意图不清理；保留 job/key/hash、关联、配额计数、版本和动作回执，不能删整行破坏幂等。
每次维护的任务内容清理有界；现有 retention 运行计数仍是原四类，不把新任务清理数量伪记为发送清理数量。
已消费草稿原有显式删除规则不变；这不是全部副本的隐私擦除承诺。

## Web 与调度

写信保留原立即发送；新增后台排队、定时本地时间选择，同时显示 UTC 对应时间并要求显式确认。
入队丢响应冻结原 key/body/time；工作台内导航后仍用原键核对。刷新后从私有持久任务列表核对已接受任务。
任务列表/详情提供状态、期限、准备次数、取消和安全 retry。动作丢响应保留原操作键，429 不替换未决操作。
不依赖浏览器 interval 执行，不用 localStorage/sessionStorage 保存未决状态；任务接受前关闭页面不保证已入队。
浏览器刷新丢失尚未确认的内存操作键时，须先检查持久任务，不能另起发送来探测。

`* * * * *` 只执行发送队列；原 `*/15 * * * *` 保留身份清理、pending 过期、R2 维护和 retention，不把维护放大到每分钟。
Cron 是 UTC、best-effort 调度，不保证秒级或准点；配置传播也不是即时。只返回/等待 scheduled Promise，不另造常驻线程。
官方核实材料保存在 `queue-official-recon.json`；本地 workerd 不能证明生产套餐 CPU、D1/R2 成本、网络延迟或调度 SLA。
列表使用一次有界历史查询关联 outgoing，而不是每条任务再发一个 D1 查询。

## 升级、回退与验收

1. 先备份并排空旧发送、草稿、邮箱删除、附件清理和 scheduled writer；在隔离环境应用全部 22 条迁移，已有 W8 环境只新增 0022。
2. 再启用新运行时与两条 cron；旧 writer 不认识 job pin，不能在队列活跃时混用。
3. 回退先停新入队与队列调度，核对 queued/preparing 及 pending/unknown，不自动重放或删任务。
4. 保留新表、操作回执、原 outgoing guard 和对象；未解决的意图/发送不得交给旧 writer 或旧清理器。
5. 开发阶段无生产变更。真实资源、发信与切流仍须另行明确批准。

验证覆盖 workerd+D1 重启、并发 cron、取消/旧 claim/账号/邮箱/provider revision fence、guard 提交确认丢失、结果写入失败、草稿回滚、附件 TTL/pin/精确字节、配额/权限/Origin、迁移及保留清理。
Chrome 验证时间选择、入队和取消丢响应/429 原键恢复、跨导航/刷新任务核对及 390px 布局。
首轮 `queue-final` 的 Chrome 清理阶段超时记录保留；独立诊断不改变 90 秒时限或业务断言，完整 Chrome 复测通过。
后端 348 项结果复用自首轮；复用前后 532 个源码哈希完全一致，收据明确记录来源，不声称第二次命令重跑了后端。
验收后的本文件收据路径修正独立记录于 `queue-docs-final/verification.json`，不将文档更新冒充运行代码重新测试。
生产调度/套餐成本、真实 MIME/投递/BCC 隐私、可靠上传队列、普通邮箱、Agent、更多供应商及旧数据导入仍须独立实施与验收。
