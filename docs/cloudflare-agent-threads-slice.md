# Agent 任务线程人工生命周期（W11h1）

本切片接通任务发起线程的独立列表、详情、关联回信阅读、状态筛选和人工状态操作 Web/API。
它不把旧发送投影改成人工状态机，不包含纯入站线程创建、同线程 follow-up、后台自动收件或 Agent OAuth，也不代表整体迁移完成。

## 旧核心检阅与本次边界

旧 `apps/desktop/src-tauri/src/services/agent_service.rs::associate_incoming_agent_reply` 按已知服务与邮件头关联；未匹配时使用服务默认邮箱创建待关注线程。
检索未发现该函数的生产收件调用点，不能用旧进度文档勾选代替真实端到端接入证据。
旧任务每次创建新线程，未发现同线程 follow-up 或人工归档/恢复/完成命令；来信会无条件写 `in_progress`，不适合直接移植到人工终态。
当前 Cloudflare 的 `agent_threads`、单 outgoing/job UNIQUE 和 task DTO 是持久任务/发送投影；本切片保留这些读写，而非填充虚假 outgoing 来表示入站线程。

## 权威数据与状态语义

- `0046_agent_thread_management.sql` 只新增两张表，不修改既有表定义或行。
- `agent_thread_management` 按 owner/thread 保存人工覆盖层、独立 revision 和更新时间；`agent_thread_operations` 保存 owner 全局原键和完整历史回执。
- 人工状态为 `open / needs_attention / completed / archived`。`completed` 仅表示用户人工标记完成，不证明 SMTP 接收、公网送达、远端执行或发件身份验证。
- 无覆盖层时 `manual=false/revision=0/updatedAt=null`：发送投影 archived 对应 archived，failed/needs_attention 或 pending 超过60秒对应 needs_attention，其余为 open。
- 首次人工操作后覆盖层持续优先，包括显式恢复 open。后来发送失败、超时或收到回信都不会自动覆盖人工决定；发送结果和来信人工处理队列仍独立显示。
- 新线程读取用 SQL 同一语句采样时间评估 pending 超时，DTO 使用同一时刻，避免跨60秒边界导致筛选页和返回状态不同。旧 task API 默认时间语义保持。
- 不修改 `agent_threads.state`、outgoing、send job、邮件头证据、收件 review 或 R2 生命周期；不连接邮箱、不执行内容、不创建发送意图。
- **归档不取消待派发任务**。只有旧任务 API 的派发前取消操作可以竞争 queued guard；归档后既有持久任务仍可能派发，网页操作前即时确认此边界。

## API 与权限

| API | 合同 |
| --- | --- |
| `GET /api/v1/agent-threads` | 可选 state、limit 1–20、cursor；owner 私有，task 摘要不返回正文 |
| `GET /api/v1/agent-threads/:id` | `thread={id,kind:"task",management,task}`，task 保留旧 DTO 和独立发送结果；回信通过既有 inbox API 按有效 threadId 读取 |
| `PUT /api/v1/agent-threads/:id/state` | UUID `Idempotency-Key`，严格完整 `{expectedRevision,state}`，revision 是人工版本而非 job revision |
| `GET /api/v1/agent-thread-operations/:key` | 只读原操作回执，不重新应用历史状态 |

全部新 API 需 `agent-tasks:read`；写入与回执另需新 `agent-threads:write`，Session 写入需同源 Origin。
旧 task send/read Key 不扩大，新线程管理 Key 不包含 send、sync、inbox review 或附件权限；回信正文/下载仍单独按原 scope 检查。
拒绝未知/重复 query、跨筛选 cursor、未知或缺失 body 字段、非法 UUID、非安全整数；非列表 API 不接受 query。
cursor 为 `uuid.filter`，filter 为具体状态或 all；按 UUID keyset 分页，不承诺跨页快照隔离。分页期间状态改变或随机 UUID 新增可能落到 cursor 前方，应刷新首页核对。

## 事务、并发与回执

同一 D1 batch 内预约 operation、upsert 人工状态、完成回执。预约 fence 有效用户/凭据、实际线程 owner、独立 revision CAS 和累计操作额度。
任何中间 SQL 失败整批回滚；批次真实提交后 ACK 丢失须按原键核对，不能另起键覆盖。
规范化 hash 绑定完整 `{threadId,expectedRevision,state}`；同 owner 同键异 body 或异线程冲突。
旧键只返回原完成回执，即使后来状态已经变化或邮件内容已清理，也不会复活原状态。
新列表、详情、回执和重放在数据 SELECT 后、返回前重新检查有效凭据，避免读后撤权的迟到响应。
每用户累计最多10000次成功状态操作；达到上限拒绝新键，旧键仍可读/重放。不自动删除回执来返还额度，长期容量/归档治理仍待后续。

## Web 与未知结果

新增“Agent 线程”工作台，不替换原“Agent 任务”创建和取消流程。
提供全部/四状态筛选、分页、任务正文与发送结果、人工完成/归档/恢复，以及按有效关联读取的回信。
未知或畸形响应保留原 body/key；恢复先 GET 原键，仅明确404才重新 PUT 同一请求。
未决时锁住本线程工作台的筛选、列表切换、刷新、分页和其他状态写入；普通导航只隐藏，不卸载该状态。
允许用户即时确认后放弃本页核对，不声称撤销服务器写入。写入确认后的刷新失败不重新建立 ghost lock；开始新操作清理旧成功提示。
操作键仅保留在存活页面内。整页刷新、关闭、退出会丢失内存恢复信息，不自动重放；重新进入先读最新线程，以 CAS 防止旧状态覆盖。
跨用户 key 重建并丢弃旧状态，无 LocalStorage/SessionStorage，不新增依赖或解释型 UI。

## 扩展与回退

先应用0046再更新 runtime/Web。旧形状 task writer 不需要写新表，新线程默认使用发送投影；原 task hash、job guard、队列和取消保持兼容。
回退上一 runtime 时保留新增表及回执，不 DROP、清空或迁回旧发送字段；旧 Web 不显示人工状态，不能宣称降级界面完整反映本切片数据。
后续纯入站线程和多消息 follow-up 需要独立扩展模型，不能因为本切片提供 thread API 就视为已经实现。

## 验证证据与边界

证据根：`C:\Users\Public\nas_home\AI\GameEditor\linshi\easyemail-cloudflare-migration-20261028`。
起点 `agent-threads-baseline/baseline.json`；最终执行结果以 `agent-threads-final/verification.json` 及独立 closeout 为准。
测试覆盖原四表不变、真实排队任务归档后仍仅派发一次、人工覆盖后迟到失败、严格输入/owner/scope/Origin、CAS/原键、事务回滚、真实 D1 丢 ACK、读后撤权、累计额度、旧 schema/行/旧 writer 保留与内容退役回执。
Chrome 验证筛选/分页/完成/归档/恢复、风险取消、unknown 同键同 body 先读恢复、确认后刷新失败不重锁、放弃核对、跨用户、最小权限 Key 与移动布局。
运行的是本地 workerd/D1/R2、真实 HTTP/Chrome；IMAP/SMTP socket 边界使用合成 HTTP 传输，不是真服务商登录、公网收投、生产成本或 Cloudflare 上线验收。
本切片不读取生产凭据，不提交、推送、合并、部署或创建云资源；原工作区与既有未提交修改均保留，整体迁移目标仍未完成。
