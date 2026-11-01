# Agent 来信人工处理（W11g）

在 W11e 显式收件、W11f 服务默认邮箱基础上，接通待关注队列、忽略/重新关注、人工关联及重新关联已有任务的 Web/API。
这不是自动执行邮件、新入站线程创建、完整 thread/follow-up 或 Agent 模块整体完成。

## 权威数据与读写

- `agent_incoming_messages.association/service_id/thread_id` 保留自动邮件头证据，不因人工归类改写。
- 新 `agent_incoming_reviews` 是私有人工覆盖层，按实际 owner/account/message 唯一，使用独立 revision CAS。
- 初始无人工记录为 `unreviewed/revision=0`；原自动 linked 不待关注，其余自动结果进入待关注。
- 人工 `attention` 清除有效线程关联、进入关注队列；`dismissed` 无有效关联且离开队列；`linked` 使用明确所选任务。
- 读取保留旧顶层自动字段，并新增 `review`：`revision/state/threadId/effectiveThreadId/needsAttention/updatedAt`。
- `authentication` 始终 `unverified`。人工操作不更改 outgoing/job 的发送结果，不标记任务完成，不开 IMAP/SMTP 连接、不执行正文或链接。

## API、权限与版本

共同前缀 `B=/api/v1/agent-accounts/:accountId`：

| API | 合同 |
| --- | --- |
| `PUT B/messages/:messageId/review` | UUID `Idempotency-Key`；严格完整 5 字段 body，见下方 |
| `GET B/review-operations/:key` | 只读原键回执，不重新应用人工覆盖 |
| `GET B/messages/:messageId/review-targets` | `limit` 1–20、UUID cursor，有限任务摘要；不返回任务正文或凭据 |
| `GET B/messages` | 新增可选 `review=attention/handled`，`threadId` 按有效线程筛选 |

```json
{"accountRevision":1,"epochId":"uuid","expectedRevision":0,"state":"linked","threadId":"task-uuid"}
```

`state` 仅 `attention/linked/dismissed`；非 linked 时 `threadId` 必须显式 `null`。拒绝未知/缺失字段、非法 UUID、非安全整数及重复 query。
全部读取需 `agent-inbox:read`；人工写入及操作回执另需新 `agent-inbox:review`；关联写入和 targets 还需 `agent-tasks:read`。
旧 Key 不扩大权限；普通 Agent 收件/同步选项不包含人工写权限。Session 写入仍需同源 Origin，Bearer 仍按 scopes。
无 review 筛选时沿用旧 cursor 格式；有筛选时 cursor 绑定该筛选，不能跨 attention/handled/全部复用。

## 关联与事务

目标必须属于同用户、任务实际发件账号必须等于这封邮件的实际接收账号，outgoing 已有 `submitted_at` 且冻结 From 等于当前账号地址。
不使用服务默认邮箱替代真实收件来源；不要求历史任务账号 revision 等于当前版本，避免仅改名称/密码后不能整理历史邮件。
显式人工归类可用于别名或后来停用/归档的服务，不把 MIME From 与目录地址不一致说成通过身份验证；网页即时确认此边界。
`submitted_at` 是 socket 之前的持久派发证据，不证明 SMTP 接收或公网送达；拒绝/未知任务也可能已跨此 guard。

同一 D1 batch 内预约 operation、upsert overlay、完成回执。预约同时 fence 当前用户/凭证、账号版本/未删除、epoch、cache generation、活消息/committed batch、review CAS 及目标资格。
任何中间 SQL 异常整批回滚。批次成功但 ACK 丢失返回未确认；通过 GET 原键核对，不能另起键覆盖。
原键绑定 owner、路由账号/消息及规范化完整 body；同键异 body 冲突，重放只返回原完成回执，不恢复后来已改变的 overlay。
回执及重放在返回前再次核验当前凭证，读取后撤权不能泄漏迟到回执。

每用户累计最多 10000 次成功人工操作，达到上限返回 `agent_review_operation_limit`；旧键仍可核对。
本切片保留历史回执，不自动删除以退还累计额度；长期操作归档/物理容量与成本验收仍待后续完成。

## Web 与未知结果

Agent 邮箱收件区提供全部/待人工关注/已处理、任务候选分页、人工关联、忽略及重新关注；任务详情按有效线程展示回信。
页面同时展示有效任务和原邮件头状态，不把人工覆盖伪装成自动证据。
未知/畸形响应保留原键和完整原 body，先 GET 核对，仅明确 404 才重发同一 PUT。
未决时锁住账户/消息切换、配置/移除、同步及其他人工写入；同一页面切换导航保留内存操作，换用户卸载。
原请求仅在当前存活页面保留；整页刷新、关闭或退出不保留内存 body/key，也不自动重放。重新打开后应先读最新邮件，服务器 CAS 仍阻止旧版本覆盖。
提供原键和“放弃本页核对”的即时风险确认；放弃不撤销服务器写入。无 LocalStorage/SessionStorage 或自动发信。
有效写入回执已确认后，即使列表刷新失败也不重新构建未决操作，避免假锁定。

## 迁移、回收与回退

`0045_agent_review.sql` 只新增索引和两张私有表；复合 FK 约束消息/任务 owner，不改旧表定义、行或历史同步/任务 hash。
旧形状 incoming INSERT/读取仍可运行，未人工处理的旧消息按原自动状态解释。先应用扩展 schema 再更新新 runtime/Web。
回退 W11f runtime 时保留新表和回执，不 DROP 或清空；旧界面只看自动头部关联，不理解人工覆盖，不能声称降级界面仍反映全部人工状态。
人工记录不 pin R2，不修改既有保留策略、退役 journal 或对象清理。内容退役后仍保留 tombstone 和回执供原键核对，不重新取信或恢复有效消息。

## 验证边界

证据根：`C:\Users\Public\nas_home\AI\GameEditor\linshi\easyemail-cloudflare-migration-20261028`。
起点 `agent-review-baseline/baseline.json`；最终状态以 `agent-review-final/verification.json` 为准，不借用前一切片绿色收据覆盖新源码。
回归覆盖权限/归属/Origin/严格输入、CAS/原键/事务、读后来源/撤权/清理竞争、真实 D1 提交后丢 ACK、quota、目标分页、旧表/行保留、旧形状读写及 R2 不 pin。
Chrome 验证人工关注/关联/重新关联/忽略、未知结果原 body/key 恢复、账户锁定、刷新失败不重锁、跨用户与移动布局。
运行的是本地 workerd/D1/R2、真实 HTTP 与 Chrome；IMAP sockets 由合成 HTTP 传输替换，任务夹具直接写派发证据，不是真 TCP/TLS、真实服务商或公网投递验收。
未匹配来信新建线程、完整线程/follow-up、后台自动收件、Agent OAuth 和整体生产迁移仍未完成；本轮不读生产凭据、不提交/推送/合并/部署。
