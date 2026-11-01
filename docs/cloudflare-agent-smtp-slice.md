# Agent 独立 SMTP 配置（W11c）

本切片在 [Agent 独立邮箱账号](cloudflare-agent-accounts-slice.md) 上接通 SMTP 配置的 Web/API。
保存配置不连接服务器、不验证密码、不发送邮件；后续 [W11d](cloudflare-agent-tasks-slice.md) 接通显式任务的持久发送、SMTP 提交和取消，默认发送账号、自动收件及回复关联仍继续迁移。

## 隔离、凭据与状态

- 使用独立 `agent_smtp_configs` / `agent_smtp_operations`，不复用普通 SMTP 账号、回执或 outgoing/queue 表。
- SMTP 与 Agent IMAP 密码分别保存；也不与相同用户、相同 ID 的普通邮箱共享配置。
- 加密 AAD 固定 `agent-smtp-v1` / `ee-agent-smtp-v1`，另绑定用户及账号 ID；请求摘要由同一独立 context 派生 HMAC。
- 复用现有部署方 SMTP endpoint 白名单、严格字段解析和 vault 原语，不允许用户填写任意主机或收件人策略。
- 仅支持白名单应用密码 endpoint：465 TLS 或 587 强制 STARTTLS。Google OAuth endpoint 从目录过滤，保存时也拒绝；本阶段不复用普通 Google 授权。
- GET 只返回 endpoint 引用、用户名、凭据是否存在、enabled、SMTP revision、保存时 accountRevision、当前 parentRevision 和 current，不返回密码、密文、内部 hash 或 endpoint 收件人策略。

保存同时要求当前账号 revision 和 SMTP revision 匹配。首次 SMTP revision 为 0，账号必须已存在且属于当前用户。
endpoint hash、用户名或父账号 revision 改变时，不静默携带旧 SMTP 密码；启用配置要求父账号已启用且显式保有有效凭据。
`current` 只表示父版本匹配，不表示连接或发信经过验证。配置的 enabled 不是一个公开发送授权。

每用户最多 10000 个累计 SMTP 操作回执，与 Agent 账号操作额度独立；额度满仍能核对和重放原回执。
账号自身的删除/忘记凭据不需要预约 SMTP 回执，不能被该额度阻止。

## API 与权限

| 路径 | 合同 |
| --- | --- |
| `GET /api/v1/agent-accounts/smtp-endpoints` | 当前支持的应用密码 SMTP endpoint，不返回 recipients policy |
| `GET /api/v1/agent-accounts/:id/smtp` | 本人有效 Agent 账号的配置，未配置时 revision=0 |
| `PUT /api/v1/agent-accounts/:id/smtp` | UUID 原键、账号/SMTP 双 CAS 保存 |
| `GET /api/v1/agent-smtp-operations/:key` | 核对本人原操作，不返回旧配置快照 |

读取要求 `agent-accounts:read`；PUT 与操作回执核对额外要求 `agent-accounts:write`。
沿用 Agent 配置权限，已有 Agent 配置 Key 可操作 SMTP 配置，但不授予 IMAP 测试或发送权限；普通邮箱/服务目录 Key 不自动扩权。
Session PUT 需要精确同源 Origin；Bearer Key 可无 Origin。拒绝未知查询参数、未知字段、任意 scope/owner/hostname 和无效 UUID。

PUT 字段为 `expectedRevision`、`smtpRevision`、`endpointId`、`username`、可选 `password`、`enabled`、可选 `forgetCredential`。
忘记凭据须同时关闭配置且不提供新密码；它不会清除 IMAP 凭据或删除远端邮件。
同用户同键同规范化命令只返回原完成回执；同键不同命令为 `idempotency_conflict`。
回执包含原键、账号 ID、PUT、原父 revision、完成 SMTP revision 和完成时间，不含密码、用户名或邮箱地址。

## 原子写入与生命周期

预约、配置写入、完成回执在同一个真实 D1 batch。预约重新检查两层 CAS、配额、当前 session/Key 撤销/过期与用户 active；本次随机 operation ID 限定副作用所有权。
失败事务不留下半完成回执或配置；错误不返回 SQLite、密码或内部 HMAC 原文。
保留旧 vault key 时可重放旧 HMAC 请求；移除必要旧 key 后失败关闭，元数据 GET 核对仍可用。

新增 `0041_agent_smtp.sql` 为父 `(user_id,id)` 添加合法 UNIQUE 键，配置/回执采用复合 FK 防止跨 owner 指向账号。
schema-owned trigger 在父账号删除或忘记凭据时原子清空 SMTP 密文/用户名并禁用，旧 W11b 父账号写入方同样受保护。
有待清字段才推进 SMTP revision；达到最大安全整数时 revision 饱和但仍清凭据。父账号 revision 变化继续使旧 CAS 失效，达到上限的 SMTP 配置不可继续普通编辑，不能以溢出阻止凭据退休。
删除先提交时旧 SMTP 保存的父 CAS 被阻止；保存先提交时父删除会清除该配置。SMTP 回执保留，不因退休改写历史结果。

发布时先应用扩展迁移，再更新 Worker/Web；回退旧 runtime 时保留新表、索引与 trigger，不 DROP/清空、不导入无云端 owner 的桌面配置。
测试 harness 原来的分号分割不支持 SQLite trigger；本阶段增加仅测试使用的 SQL framing，保留字符串/注释及 BEGIN/CASE/END 内部分号。生产迁移仍由 Wrangler/SQLite 负责。

## Web 与未知操作

Agent 邮箱页下独立 SMTP 表单支持保存、刷新、忘记凭据。未保存 SMTP 修改、在途写入及未知原操作锁定父账号选择/修改/测试/移除；父表单未保存时也不能提交 SMTP。
ref guard 与 disabled 状态共同保护，不仅依靠异步渲染。切换页签保留原键，换用户卸载隔离内存；密码/原请求不写 LocalStorage/SessionStorage。

未知请求先 GET 原回执，明确 404 才按原键原请求 PUT；畸形/错目标 2xx 不清锁。
恢复 PUT 明确返回 `agent_smtp_changed` 时，再次只读核对原键：若已完成，确认原回执；仅再次 404 且旧双 CAS 已失效时结束该未提交原请求。普通 4xx、配额复合错误、核对失败或畸形回执不用于解锁。
用户确认丢弃编辑后，即使旧父版本导致配置刷新失败，也可刷新父账号，不会被 dirty 状态永久卡住。
配置读取核对目标、父版本、Agent/password 类型、current/凭据状态及时间；迟到读取不能替换新刷新，成功回执不代替最新配置读取。

## 验证边界

证据根：`C:\Users\Public\nas_home\AI\GameEditor\linshi\easyemail-cloudflare-migration-20261028`。
起点为 `agent-smtp-baseline/baseline.json`；最终范围、实际结果和源码哈希以 `agent-smtp-final/verification.json` 为准。
相关测试覆盖 scopes/Origin、严格输入、normal/Agent 同 ID/同键、双 CAS/并发回执、撤销/过期、写入失败回滚、额度、密文跨 context 拒绝、key rotation、扩展迁移、旧父写入方和 revision 饱和退休。
Chrome 覆盖表单、父子互锁、未知/畸形回执、版本失效恢复、迟到读取、用户隔离、移除与移动布局。
这些不代替真实 SMTP/TLS/服务商认证、邮件收投、生产 D1/R2 成本、任务队列、部署或整体迁移验收。
