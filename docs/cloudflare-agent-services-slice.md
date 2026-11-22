# Agent 远程服务目录（W11a）

这是 Agent 模块的第一个独立纵向切片：在 Cloudflare EasyEmail 的 Web 和开放 API 中管理用户私有的远程服务目录。
不是 Agent 邮箱、任务发信、自动回信关联或整个 Agent 模块完成。

## 数据与行为边界

- 远程服务是收件目标及用户维护的元数据，不是供应商实例、登录账号、普通联系人或可执行工具。
- 每项保留名称、邮箱、描述、类型、信任级别、状态和版本；默认类型 `email_agent`、信任 `unknown`、状态 `active`。
- 信任级别沿用旧模型的 `unknown / trusted / restricted / blocked`，状态独立为 `active / disabled / archived`。
- 这些值目前仅属于目录。设置 `trusted` 不验证发件身份，也不会授权执行邮件内容；设置 `blocked` 不改变普通邮件渠道的收发规则。
- 本切片不接收或执行邮件指令，不根据主题、正文或邮箱地址自动推断任务完成，不联系远程服务。
- 后续任务发信必须重新在预约事务中检查服务版本、信任和状态，并限定 Agent scope 的授权发送账号；不能只信任网页曾显示的值。
- 邮箱在创建后不可改写，避免未来回复归属在历史线程与新地址之间混淆。更换地址须新建服务。
- 平台移除为软删除墓碑，清空名称、地址、描述，保留身份与版本防止旧操作复活。相同邮箱可作为新 ID 重建，旧删除回执不会删除新记录。
- 不自动将无云端用户归属的桌面 `agent_services` 数据导入任何用户。

## Web

工作台新增“Agent 服务”入口，支持新增、查看、编辑、移除、搜索、信任/状态筛选和分页。
信任级别改变须显式确认，删除须确认其仅影响平台目录。未接入的任务发信只显示短状态，没有虚假发送按钮。

写入中锁定表单及后续写入。网络失败或畸形/不匹配的 2xx 回执保留不可变请求与原操作键；点击“核对原服务操作”时先 GET 回执，仅在确实无回执时使用原键和原请求重新提交。
写入回执验证原键、方法、服务身份、版本、删除标记与完成时间；不能把 `200 {}` 视为成功。
切换页签不丢失未决操作，切换登录用户会隔离状态。隐藏/搜索/刷新后的迟到分页不得覆盖当前列表。
不将请求正文、目录或操作键写入 LocalStorage/SessionStorage；整页刷新不自动恢复尚未拿到的创建 ID，程序调用方应自行保留原操作键。

## API 合同

| 方法与路径 | 合同 |
| --- | --- |
| `GET /api/v1/agent-services` | 私有列表，默认 `limit=25`，上限 100 |
| `GET /api/v1/agent-services/:id` | 读取本人未删除服务，其他用户与不存在均为 404 |
| `POST /api/v1/agent-services` | 新建，不是 upsert；重复有效邮箱为 409，不默默覆盖信任级别 |
| `PATCH /api/v1/agent-services/:id` | 指定 `expectedVersion`，可改名称、描述、类型、信任、状态，不可改邮箱 |
| `DELETE /api/v1/agent-services/:id` | JSON `{ "expectedVersion": N }`，平台墓碑，不发起远程删除 |
| `GET /api/v1/agent-service-operations/:key` | 原键只读核对；只返回服务 ID、操作、版本、删除状态与完成时间 |

列表支持 `q`、`trustLevel`、`status`、`serviceKind`、`limit`、`cursor`；拒绝未知或重复筛选。
游标绑定当前用户及规范化筛选，按不可变 ID 做 keyset 分页。列表不是跨并发编辑的完整快照，刷新可见最新状态。
地址仅允许单个 ASCII addr-spec，规范化为小写；名称使用 NFC、最多 80 个 Unicode 码点，描述最多 2000 个字符，拒绝控制/格式字符和身份注入字段。
自定义类型为 `[a-z][a-z0-9_-]{0,63}`，仅是元数据，不解释为代码、路径或 provider。

所有变更必须提供 UUID 格式的 `Idempotency-Key`。同用户同键同规范化请求返回原回执，不覆盖后续版本；同键不同请求为 `idempotency_conflict`。
创建首次为 201，已完成重放为 200。不同操作键并发新建同一邮箱只有一项成功；版本过期为 `agent_service_changed`。
会话写入要求精确同源；Bearer Key 可无 Origin，但必须拥有 `agent-services:read` 与 `agent-services:write`。
只读 Key 只需 `agent-services:read`；写权限不隐含读权限。目录权限不授予邮箱、发信、联系人或管理员权限，旧 Key 不自动扩权。

## 存储、事务及兼容

新增 `0039_agent_services.sql`，仅扩展两个私有表及索引，不改旧表或旧 Key 内容。
每用户最多 256 个累计服务记录、10000 个累计操作回执；删除不退累计额度。配额满后仍可重放和核对已存在的回执，不能因清理回执导致重复变更。
表单普通更新在服务额度满时仍可使用，但仍受操作额度限制。

预约回执、CAS 变更和回执完成在同一个 D1 `batch` 事务中；写入使用本次随机操作 ID 防止同键竞争者执行副作用。
预约 SQL 同时核验最新版本、当前会话/Key 未撤销且未过期、用户仍启用；不只依赖请求入口的旧身份快照。
事务失败不留下已成功的服务变更或半完成回执，错误不泄露 SQLite 原文、描述或内部哈希。
回执只保留身份/版本与请求摘要，不复制历史邮箱、名称或描述；本切片不是完整隐私擦除或永久审计系统。

将来发布须先应用扩展迁移，再发布 Worker/Web。回退旧 Worker/Web 时保留新增表和目录数据，不 DROP/清空，也不回滚旧用户数据。
旧读写方不引用新表，旧凭据作用域和现有普通/临时邮箱链路保持。没有在 NAS 或生产创建、导入或删除任何服务。

## 验证与未完成项

本地证据根目录：`C:\Users\Public\nas_home\AI\GameEditor\linshi\easyemail-cloudflare-migration-20261028`。
源码起点为 `agent-services-baseline/baseline.json`，最终检查以 `agent-services-final-r2/verification.json` 的实际状态为准，不把 W10u 的旧收据覆盖到本轮源码。

相关验证覆盖 workerd/D1 的 CRUD、严格输入、双用户隔离、scope/Origin、CAS、原键并发、SQL 触发失败回滚、凭据在途撤销、额度及扩展迁移；Chrome 覆盖真实表单、信任确认、未知/畸形响应恢复、迟到分页、API Key、纯文本渲染、账户切换及移动布局。
相关测试纳入 `npm test` 和 `npm run test:web`；本轮实际执行范围与数量见独立收据。

后续独立账号配置与只读连接基础见 [W11b](cloudflare-agent-accounts-slice.md)；任务/队列见 [W11d](cloudflare-agent-tasks-slice.md)、有限回信关联见 [W11e](cloudflare-agent-inbox-slice.md)、服务默认账号见 [W11f](cloudflare-agent-senders-slice.md)。完整人工关注与线程状态仍未接入。
本地夹具不是 Google/SMTP 真实收投、公网 D1 一致性、部署、成本或整体迁移验收。

## 第三方供应商边界

2026-10-30 联网核实 [Mail.tm 官方条款](https://docs.mail.tm/) 明确包含 “Don't mirror or proxy our API under a different domain.” 和可见归属链接要求。
未发现针对聚合服务的授权豁免，故本轮没有增加 Mail.tm adapter、创建真实账号或以假 API Key 绕过现有模型。更多供应商仍需逐项核实能力与使用授权。
