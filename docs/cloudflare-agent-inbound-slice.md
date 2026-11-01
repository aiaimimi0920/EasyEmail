# Agent 纯入站线程（W11h2）

本切片允许用户把尚无有效任务关联的 Agent 来信显式建成入站线程，接入现有线程列表、详情、状态筛选和人工完成、归档、恢复。它不发送邮件、不执行正文、不验证发件身份；不代表完整 follow-up、自动收件、Agent OAuth 或整体生产迁移完成。

## 权威模型与兼容边界

0047 采用 expand-only：新增 `agent_inbound_threads`、`agent_inbound_messages`、`agent_inbound_operations`、`agent_inbound_state_operations`，不重建旧表或把入站 UUID 塞进旧 task-only 外键。
根引用实际收件账号和消息，不借用服务默认发件账号，不创建虚假 task/outgoing/job。消息归属单独建表，为后续多消息模型保留边界；本轮写入口仅创建种子归属。
同用户、账号、种子消息只允许一根。初始状态为 `needs_attention`，管理版本为1；管理版本与旧发送任务/job版本独立。

归属捕获创建时的旧 review revision。只有捕获版本仍等于当前 review revision 时才有效；旧版人工处理 writer 的后续更高版本决定自动使入站归属失效，不要求旧 writer 理解新表。
失效不删除根、不篡改原创建回执、也不允许以新键为同种子再建一根。本轮没有重新激活归属或把另一封邮件加入原根的入口，后续必须复用原根扩展，不能解除种子唯一约束来制造重复线程。

原 `association / threadId / serviceId` 保持邮件头证据；`review.effectiveThreadId` 继续只表达旧任务关联，避免改变旧 review 回执含义。
新增 `inboundThread: { id, active } | null` 表达入站归属。`messages?threadId=` 按 active inbound 优先、否则旧任务有效关联筛选；Web 列表和详情共用 `agentIncomingThreadId` 判断，不能只看 `review.effectiveThreadId`。
active 入站归属使来信从收件“待人工关注”队列移入“已处理”，但新线程自身仍为“待人工关注”：两个队列管理不同责任。

## API、权限与事务

```text
PUT /api/v1/agent-accounts/:accountId/messages/:messageId/inbound-thread
GET /api/v1/agent-accounts/:accountId/inbound-thread-operations/:key
GET /api/v1/agent-threads
GET /api/v1/agent-threads/:id
PUT /api/v1/agent-threads/:id/state
GET /api/v1/agent-thread-operations/:key
```

创建完整输入为 `accountRevision / epochId / expectedRevision / serviceId / serviceVersion / confirmRestricted`，不允许额外字段；`expectedRevision` 指来信人工处理版本。
创建和原键读取需要 `agent-inbox:read`、`agent-inbox:review`、`agent-tasks:read`、`agent-services:read`、`agent-threads:write`；Session 写操作检查 Origin。
新 Web Key 预设显式组合上述权限，不增加旧 Key 的写入权限，不包含发信、同步或附件下载权限。

创建事务预约 operation 时重新检查凭据、账号版本、实际 source/epoch/cache generation、committed 未清理消息、review CAS、无有效任务关联、服务同 owner/version/active/trust、restricted 明确确认、种子唯一和容量。
同一 D1 batch 中再创建根及消息归属并完成回执。operation 对根采用 deferred FK，验证必须包含真实 workerd/D1 成功提交、后续约束失败整批回滚及 `foreign_key_check`，不能仅凭 SQLite 文档推断。
完整原键/body hash 固定历史结果，JSON 属性顺序不影响 hash。首建201，同键核对重放200，异 body409。丢 ACK 返回未知结果，客户端先 GET 原键，仅明确404才重发同一 PUT；不自动另建根。

建档根与创建 operation 各有每用户累计10000上限。状态 operation 在 task/inbound 间共享原键空间与累计10000上限，数据库双向碰撞及容量 trigger 也约束旧 task writer。
旧 runtime 不理解入站 state operation，撞新键/共享容量时可能只能返回 storage failure，需用新 runtime 核对，不能承诺旧客户端具有相同精确错误。

## 统一读模型与内容生命周期

线程返回 typed union：`kind:"task"` 带 task；`kind:"inbound"` 带 inbound 且不带 task。task 的原 DTO、任务状态和发送投影不变。
每个分支各取 `limit+1`（最多21），合并最多42行排序后截断，沿用绑定筛选的 `uuid.filter` cursor；双向根 ID 碰撞 trigger 支持统一键空间。不宣称跨两个并行 SELECT 的全局一致快照。

现有 `agent-tasks:read` 可以读两类线程元数据，这是统一工作台的显式读契约；入站根只公开同用户的账号、服务、消息索引和管理状态，不复制主题、地址、正文、MIME、附件或 R2 对象键。
内容仍经原 inbox API 的权限、实际 source/epoch/generation、purge 和 committed 检查；附件继续要求原下载权限。新根不 pin R2、不改变 retention/journal 删除规则；来源变化、账号删除或清理后，历史元数据与原键回执仍存在，不恢复邮件内容。

## Web 与验证边界

邮件详情提供显式服务选择、受限服务确认和“创建入站线程”。归属存在后不重复显示创建入口；人工 review 仍可作后续归类。
创建 hook 归收件组件所有，不归短生命周期的详情表单所有。unknown 时保留单一 body/key，锁同步、处理、账号切换与配置；普通页内导航只隐藏，不卸载。整页刷新、退出登录不持久化或自动重放。
线程详情按类型显示管理状态，入站正文仍通过“入站线程来信”区域读取，不显示虚构的发送状态。界面只保留控件、数据、短状态、必要错误与即时确认。

证据目录：`AI/GameEditor/linshi/easyemail-cloudflare-migration-20261028`。
红测在 `agent-inbound-red`：创建接口404。首轮 Chrome 在 `agent-inbound-web-first` 发现详情仍按 task-only ID 校验；修复统一判断后记录在 `agent-inbound-web-fixed`。
最终验证和源码冻结以 `agent-inbound-final/verification.json`、`agent-inbound-closeout.json` 的实际结果为准；不得把 W11h1 收据当成本轮新源码通过的证明。
所有测试使用合成本地 IMAP/R2 和真实本地 workerd/D1/Chrome，不等于真实服务商投递、云端部署、流量切换或完整迁移验收。回退只回退 runtime/Web，保留新增表和历史记录，不执行 DROP 或数据迁回旧任务表。
