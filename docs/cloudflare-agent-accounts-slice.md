# Agent 独立邮箱账号（W11b）

本切片将 Agent 自有邮箱配置从桌面迁至 Cloudflare Web/API，接通独立身份、凭据保存和只读 IMAP 连接检查。
它延续 [Agent 服务目录](cloudflare-agent-services-slice.md)，但账号不是远程服务；任务发信后续由 W11d 接通，自动收信及回复关联仍待迁移。

## 隔离与复用

- Agent 使用独立 `agent_accounts` 和 `agent_account_operations`，不向 `normal_accounts` 填入隐藏行。
- 现有普通账号、统一收件箱、普通邮件/附件、草稿、SMTP、队列及 Google OAuth 仍只读取旧命名空间，不能凭 Agent ID 获得其配置或凭据。
- API 输出固定 `scope=agent`、`kind=agent_owned`；请求不能指定 scope、owner、表名或 arbitrary host。
- 同用户可显式独立配置同一个外部邮箱；normal/Agent ID 和原操作键属于不同命名空间，不共享密码、版本或连接结果。
- 复用既有部署方 IMAP 服务器白名单、严格配置输入、AES-GCM/HMAC vault 和真实 IMAP 协议，不另写协议实现。
- Agent AAD 固定 `ee-agent-account-v1` / `agent-imap-v1`，另绑定用户和账号 ID；与普通邮箱同 ID 的密文也不能互换。
- 本切片接受应用密码/密码认证的受控 TLS 或 STARTTLS endpoint。Google OAuth endpoint 在目录中过滤，服务端保存和测试同样拒绝；不假装已支持 Agent OAuth。
- 连接测试使用 `EXAMINE INBOX`，不使用写入邮件的 IMAP 命令，不同步、下载或派发任务，不建立常驻循环。

## 配置与状态

账号包含邮箱地址、名称、endpoint 引用、用户名、加密只写凭据、enabled、revision 和最近连接结果。
邮箱地址创建后不可改写；新地址须新建账号。修改用户名或 endpoint 身份时，不复用旧凭据，启用连接必须显式保存有效凭据。
忘记凭据须同时关闭连接；移除为平台墓碑，清空邮箱、名称、用户名及凭据，不登录远端删除邮件，也不使旧账号 ID 复活。

每用户最多 20 个未移除账号、100 个累计账号及 10000 个累计操作回执，普通账号额度不受此目录消耗。
移除不退累计额度，保留原键回执避免重放副作用。达到回执额度后不能继续变更，但仍可核对和重放已有回执。
密钥轮换保留旧 vault key 时可重放旧 HMAC 请求；移除必要旧 key 后重放失败关闭，不改写记录。元数据回执只读查询不要求解密密码。

## API

| 方法与路径 | 作用与权限 |
| --- | --- |
| `GET /api/v1/agent-accounts` | 本人账号分页；`agent-accounts:read` |
| `GET /api/v1/agent-accounts/endpoints` | 当前支持的只读 IMAP 配置；`agent-accounts:read` |
| `GET /api/v1/agent-accounts/:id` | 本人有效账号；`agent-accounts:read` |
| `PUT /api/v1/agent-accounts/:id` | 客户端 UUID 新建或 CAS 更新；read + write |
| `DELETE /api/v1/agent-accounts/:id` | 平台移除；read + write |
| `POST /api/v1/agent-accounts/:id/test` | 指定版本只读检查；read + sync |
| `GET /api/v1/agent-account-operations/:key` | 核对原操作；read + write |

write/sync 的完整权限为 `agent-accounts:write` / `agent-accounts:sync`。
旧 `mail-accounts:*` 和 `agent-services:*` 不自动扩权，Agent 权限也不授予普通邮箱、联系人或 Key 管理能力。
Session 写入和测试要求精确同源 Origin；Bearer Key 可无 Origin。测试权限不授权配置写入或发信。

PUT 使用已有普通配置字段合同与 `expectedRevision`；新建必须为 0。DELETE/test 仅接受 `expectedRevision`。
PUT/DELETE 必须带 UUID `Idempotency-Key`；原键同规范化命令重放只返回原回执，不返回旧账号快照覆盖当前状态。
回执仅包含原键、账号 ID、PUT/DELETE、递增 revision、删除标志和完成时间；不含邮箱、用户名、密码或密文。
列表只接受单个 `limit` 和 `cursor`；默认 25、上限 100，按账号 ID keyset 分页。它不是跨并发修改的完整快照。

## 事务与网络生命周期

预约回执、账号变更和回执完成在同一真实 D1 batch；预约同时核对 CAS、额度、当前凭据未撤销/未过期、用户 active。
各业务写入绑定本次随机预约 ID，竞争者不能借相同原键执行第二次副作用；失败不留下半完成回执或配置。
只读测试有独立短租约，沿用协议层 deadline、字节预算和 socket 清理所有权。
取得租约、成功结果落库和失败记录均检查当前账号 revision、token、租约、启用状态、用户及调用凭据；迟到结果不能覆盖新配置或清除继任租约。
撤销不能收回此前已经发到远端的认证字节；本切片不宣称能中止所有在途网络操作。

## Web

独立“Agent 邮箱”页支持配置、列表、凭据忘记、连接测试和带即时确认的移除。
共用 `MailAccountForm` 保留普通表单导出入口与既有 OAuth 行为，Agent 以显式 prop 锁定已有邮箱地址。
未保存表单、进行中操作和未确认写入会锁定本页后续动作；切换页签不丢原请求，换用户重新挂载隔离内存状态。
未知写入先只读 GET 原回执，只有明确 404 才用原键原请求重新提交；不因畸形/错误目标的 2xx 清锁。
连接测试成功响应也核验原账号/版本、Agent 身份、认证/只读标志和 INBOX 结果；不匹配时保持原账号并报告未确认，不展示检查通过。
列表请求有 generation fence；刷新会同时读取 endpoint，迟到初始列表不能覆盖新视图或导致表单永久缺失。
密码、原请求与操作键仅在当前内存中保留，不写 LocalStorage/SessionStorage；整页刷新后 API 调用方应自行保存原键和客户端账号 ID 以核对。

## 迁移、验证与未完成项

`0040_agent_accounts.sql` 仅新增两表与索引，不修改旧表、旧 Key 或旧数据。将来发布先应用扩展迁移，再更新 Worker/Web。
回退旧 Worker 时保留新增表与数据，不 DROP/清空；不自动导入没有云端用户归属的桌面账号。

本地证据根：`C:\Users\Public\nas_home\AI\GameEditor\linshi\easyemail-cloudflare-migration-20261028`。
起点为 `agent-accounts-baseline/baseline.json`，最终测试范围、结果、源码哈希以 `agent-accounts-final/verification.json` 实际状态为准。
相关用例覆盖私有配置、normal/Agent 同 ID/同地址/同键隔离、双向密文拒绝、轮换、事务失败回滚、CAS/原键竞态、撤销与租约、额度和扩展迁移。
Chrome 覆盖表单、真实本地只读 IMAP、未知及畸形回执、异常测试成功响应、迟到列表、账户切换、独立 Key、移除确认和移动布局；不是外部服务商验收。

后续 [W11c](cloudflare-agent-smtp-slice.md) 接通独立 SMTP 配置 Web/API，保存本身不连接或发送；[W11d](cloudflare-agent-tasks-slice.md) 接通显式账号任务/真实邮件/线程标记/队列原子关联、持久发送和取消。
仍待迁移服务默认发送账号、自动收信/回信匹配、完整线程与人工关注操作，以及 Agent OAuth 和完整邮件工作台。
真实服务商认证、真实收投、生产 D1/R2、部署、成本和整体迁移验收尚未完成。
