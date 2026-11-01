# Agent 任务邮件与持久发送（W11d）

本切片在独立 Agent 服务、邮箱和 SMTP 配置上接通任务创建、真实 outgoing、线程标记、持久队列、SMTP 提交和派发前取消。
Web 与 API 使用同一后端；不依赖桌面、Userscript 或 NAS，也不把 Agent 任务伪装成普通邮件。
后续 [W11e](cloudflare-agent-inbox-slice.md) 接通显式收件与有限头部回信关联，[W11f](cloudflare-agent-senders-slice.md) 支持服务默认账号配置与网页显式选用；后台自动收件、完整线程操作和 Agent OAuth 尚未接通，整体迁移未完成。

## 任务意图与隔离

- 创建时必须显式指定 `serviceId` / `serviceVersion`、`senderAccountId` / `accountRevision` / `smtpRevision`、`subject` 和 `text`。
- 仅向该私有远程服务的不可变地址发送一封纯文本任务邮件；不接受自由 To/CC/BCC、附件、普通草稿、reply 或定时发送字段。
- `confirmRestricted` 可选，规范化为 boolean；受限服务必须本次显式确认。blocked、disabled、archived 或已删除服务不可使用；unknown 信任等级不等于禁止或可信认证。
- 发件邮箱必须是本人有效 Agent 账号，父账号/SMTP 版本一致、均启用且各自保有凭据。SMTP endpoint 仍由部署方白名单和收件人策略限定。
- 使用独立 `agent_threads`、`agent_outgoing_messages`、`agent_thread_messages` 和 `agent_send_jobs`；不复用 normal/temporary 的账号、任务或 outgoing 命名空间。
- Agent SMTP 凭据仍通过独立 AAD 解密，复用真正的 `smtpMime` / `sendSmtp`，没有另建协议实现或调用普通发送业务入口。

任务创建是持久发送意图：退出会话或撤销创建它的 API Key，不会自动取消已排队任务。
用户可在派发前显式取消；停用用户、停用或改变来源配置、服务版本或信任状态，会在派发预约时重新检查。
这不是永久绕过授权：后台每次仍要求当前 owner、用户 active、账号/SMTP/service 版本、凭据、endpoint hash 和允许收件人满足条件。

## API 与权限

| 路径 | 合同 |
| --- | --- |
| `GET /api/v1/agent-tasks` | 本人任务分页，limit 默认 25、最大 100；UUID keyset cursor |
| `GET /api/v1/agent-tasks?requestKey=:key` | 按原 UUID 键只读核对，不能混合其他筛选 |
| `POST /api/v1/agent-tasks` | UUID `Idempotency-Key`，原子创建任务、邮件、mapping 和 job |
| `GET /api/v1/agent-tasks/:id` | 本人任务详情及当前投递状态 |
| `POST /api/v1/agent-tasks/:id/cancel` | 只接受 `expectedRevision`，争夺尚未派发的 queued 状态 |

读取要求 `agent-tasks:read`，创建和取消额外要求 `agent-tasks:send`。
普通邮件发送、Agent 目录或配置权限不自动获得任务发送能力；Web 创建 Key 提供独立任务权限选项。
Session 写操作要求精确同源 Origin；Bearer 可以不带 Origin。所有查询和写入均检查本人归属。

原键摘要包含完整规范化意图和全部来源版本。同用户同键同意图只返回原任务；不同意图为 `idempotency_conflict`。
返回的是当前状态，不是历史快照；内容已被保留策略清理时，也不能复用旧键重新创建或发送。

## 事务、配额与派发

四表在同一个 D1 batch 中建立，以 owner 复合 FK 绑定实际线程和 outgoing，而非只检查 ID 存在。
创建预约在事务内重新检查当前 session/Key 的撤销/过期、active user、来源版本和额度，失败不留半任务。
每用户累计最多 10000 个任务，queued 最多 100 个；每项准备 deadline 为一天，不保证准点发送。

每分钟现有发送 runner 之后，在 `finally` 调用独立 Agent runner；每轮最多检查一个到期 Agent job。
派发前准备可做最多五次、60 秒退避；只适用于尚未跨过发送 guard 的临时准备故障。
永久无效来源和过期任务转为未提交失败，不打开 SMTP；没有手动重发 API。

真正发送前，一个 batch 同时将 outgoing 从 queued 变为 pending、job 从 queued 变为 submitted，并检查实时业务 fence 和共享收件人数配额。
只有明确取得两项预约成功结果才打开 SMTP。事务结果丢失时，即使数据库已提交 pending，也不打开 socket、不再次预约或发送。
Agent、普通和临时邮件共用 `send_recipient_charges`；Agent 在实际预约时通过 `submitted_at` 计费，queued/cancelled 不消耗收件人数，unknown 仍保留额度记录。
取消与发送竞争同一 queued guard：取消先提交则不发送；派发先提交则取消返回 409，不声称已撤回邮件。

## 结果、线程与保留

- 入队为 `queued` / thread `draft`，不是发送成功。
- `pending` 表示跨过不可重发的预约边界；超过 60 秒仍未结算时显示并维护为 `unknown` / `needs_attention`。
- SMTP 最终 250 仅为 `accepted` / `awaiting_reply`，不证明公网送达或收件人已处理。
- DATA 后断链或不明确结果为 `unknown`，拒绝为 `rejected`；不会自动重发这两类任务。
- 所有结果均保持 `delivery: "unconfirmed"`、`retrySafe: false`。没有“恰好一次送达”承诺。
- RFC Message-ID 与实际 MIME 一致，mapping 保存 `task_request` 标记；本阶段不按主题或正文猜测回信关联。
- `updatedAt` 显式取线程、outgoing 与 job 更新时间的最大值，避免同名 SQL 列覆盖后漏掉状态更新。
- 既有保留策略启用且配置 outgoingDays 时，有界清理 terminal 邮件正文、主题及地址；保留原键/hash、RFC ID、关联和配额，不清 queued/pending。

## Web 及不确定结果

任务页显式选择 Agent 邮箱与远程服务，显示列表、详情、状态刷新、取消以及带重复发送风险确认的另建操作。
账号目录用 UUID cursor，服务目录用有界 opaque base64url cursor；均可加载更多，不能将两种合同混用。
来源读取并行，SMTP 独立读取并随来源刷新重新核验，不依赖父账号 revision 恰好变化；迟到旧读取不能覆盖新结果。

创建结果未知时保留原键和不可变原 body，先按原键 GET；仅明确 404 才 POST 原请求。
畸形、错目标或错误投递语义的 2xx 不解锁。切换页签保留当前内存意图，换用户卸载；不写浏览器 LocalStorage/SessionStorage。
取消响应不明时保留旧显示并报告未确认，刷新读取真实状态，不因一次取消请求报出“已取消”。

## 迁移、回退与验收边界

新增 `0042_agent_tasks.sql` 扩展四表和索引；仅替换不拥有数据的 quota view 定义，把 Agent 预约并入，保留旧表定义和行。
未来发布应先应用扩展迁移，再更新 runtime/Web。回退旧 runtime 时保留新增表、view、任务和发送 guard，不 DROP/清空，不自动导入缺少云端 owner 的桌面任务。

证据根：`C:\Users\Public\nas_home\AI\GameEditor\linshi\easyemail-cloudflare-migration-20261028`。
起点为 `agent-tasks-baseline/baseline.json`，最终测试范围、源码哈希及实际结果以 `agent-tasks-final/verification.json` 为准；旧 W11c 收据不覆盖本切片。
回归包括原子失败回滚、权限/Origin/跨 owner、原键/CAS、撤销、发送 guard、未知结果不重发、取消竞争、共享配额竞争、扩展迁移及真实本地 SMTP 协议夹具。
Chrome 检查创建/状态/取消、未知及畸形回执、原键恢复、101 服务分页、SMTP 独立刷新/迟到读取、用户隔离和移动布局。
本地合成传输不是外部 SMTP/TLS、真实服务商认证或邮件收投验收；未读取生产凭据、部署、切流、合并或提交。
