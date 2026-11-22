# Cloudflare 条件远端邮件删除（M3j）

本切片只在隔离 worktree、本地 workerd/D1 和合成邮件上开发验证。
不访问、删除生产邮箱，不部署，不改变旧 NAS 服务。远端邮箱地址删除和 Temporam 删除不在本切片内。

## 1. 源服务的资源身份与原子合同

旧 `DELETE /api/mails/:id` 只有地址与整数 ID 条件，ID 可能复用；聚合平台绝不调用它，
也不使用“先 GET 再无条件 DELETE”的竞态方案。旧接口暂留兼容，不代表其安全语义已升级。

自营上游 DB v0.0.8 增加 `raw_mail_resources` 和 `mail_delete_operations`。
插入、任何更新和删除触发器维护随机 128-bit 资源代次；相同 ID、相同原文重新插入也有新代次。
parsed API 在同一 SQL SELECT 中读取原文与 `resource_version`，不把旧正文与后来版本拼接。
只有两张表及三个触发器的实际定义完整匹配时才发布资源代次；缺失、漂移或未迁移时仍可读旧格式，
但不提供远端删除能力，条件删除返回 503。

```text
POST /api/mail_deletions
{"requestId":"UUID","mailId":"1","expectedVersion":"32 lowercase hex"}
GET /api/mail_deletions/:requestId
```

沿用 Address JWT 与可选站点密码，额外校验 JWT 的正整数 address_id 与当前地址代次。
请求实际流限 8 KiB；校验 UUID、正整数安全 ID、版本及精确字段。
删除开关仍是 `ENABLE_USER_DELETE_EMAIL`，新操作关闭时拒绝；既有结果可在关闭后重放/核对。
相同 requestId、相同 body 返回持久化结果；不同 body 为 409。
决策、操作记录与条件删除放在同一个 D1 batch 事务，失败回滚，不记录虚假成功。

| 终态 | 含义 |
| --- | --- |
| deleted | 原子决策中的资源代次匹配并已删除；不是声明同 ID 的未来新邮件也删除 |
| absent | 当前地址下已无此 ID；不能证明由本次删除 |
| changed | ID 已对应其他代次；没有删除新版本 |

GET 不创建、取消或重新执行操作。404 只表示当前未观察到该请求，不证明在途原请求永远不会到达。
操作记录不随 raw 邮件删除清理，不自动回收幂等键。

## 2. 聚合 API、授权和防重放

```text
POST /api/v1/mailboxes/:mailboxId/messages/:messageId/remote-delete
GET  /api/v1/mailboxes/:mailboxId/messages/:messageId/remote-delete
POST /api/v1/mailboxes/:mailboxId/messages/:messageId/remote-delete/check
```

首次 POST 要求 `Idempotency-Key`（16–128 位字母、数字、下划线或横线），body 为：

```json
{"confirmAddress":"ee_example@cf.example.test","confirmMessageId":"cached-message-uuid"}
```

写入和显式 check 独立要求 `messages:remote-delete`，Cookie 还要求精确 Origin。
旧 `messages:delete` 不升级为远端权限；GET 本地记录要求 `messages:read`。
catalog 保留旧无条件 `remoteMessageDelete: false`，新增 `conditionalRemoteMessageDelete` 表示适配器支持条件合同；
这不是当前实例已经升级的证明，实际入口仍以每封邮件的已观察代次和能力为准。
全部查询绑定 user、mailbox、message，管理员没有资源归属旁路。
首次操作要求缓存未 purge、已在平台回收站、有源代次、曾观察到源端删除开关开启、邮箱仍可用。
同一预约 INSERT 原子 fence 邮箱 active/停用/释放/到期、消息版本及 provider revision。
每用户首次写入和 check 各限每分钟 20 次，已有本地重放不发上游请求。

`remote_deletions` 在 HTTP 外发前持久化：用户幂等键、缓存消息、远端资源代次均有唯一约束。
同 key 不同请求冲突；换 key 不能再次删除同一缓存消息。首次执行之外没有自动写重试。
供应商超时、无效响应、403、429、404 或 5xx 均保守保留 unknown；客户端重新 POST 只返回原 guard。
pending 超过 60 秒在视图中也显示 unknown，不重新调度删除。

显式 check 只 GET 原 requestId 的上游结果并记录证据；即使 GET 404 也不允许另起写入。
预约保存原供应商 endpoint 与 revision，配置换代时停止外部核对，避免把旧邮箱凭据发送到新来源。
恢复原配置或后续受控迁移核验合同后再处理，不静默使用新 endpoint。
已知终态不可被较晚失败覆盖；结果存储或最终读取失败返回 503，提示刷新原记录，不构造正常降级终态。
在途预约已经外发后，停用、释放、清缓存或页面退出均不等于远端撤销，晚结果仍可被记录。

## 3. 缓存、Web 与数据兼容

新增 `0011_remote_deletions.sql`，0001–0010 保持不变；不物理删除历史消息、用户、Key 或操作 guard。
新 `source_version`、`remote_delete_enabled` 默认为无身份/关闭。
legacy fingerprint 不加入资源代次，也不按相同正文给历史缓存补认新身份。
有资源代次的观察使用独立 version fingerprint；代次不同即使原文相同也产生新观察，同代次重复同步不重复。
purge/retention 清内容但保留去重身份和远端 guard，不能通过清缓存或重启重新发起删除。
成功远端删除也保留平台缓存；永久清除缓存是另一个有独立确认的操作。

Web 只在可用的回收站消息显示删除入口；输入完整邮箱地址并确认不可恢复风险，取消不发送写入。
刷新后先 GET 本地 guard，pending/unknown 只显示核对原操作，绝不显示“失败，请重试删除”。
absent 和 changed 分别显示实际含义，不包装为本次删除成功。
Key 页面提供独立远端权限，不把平台清理 Key 静默升级。浏览器不保存供应商 JWT，不直连供应商。

## 4. 正向迁移、回退与证据边界

后续获准发布时先备份并对自营上游应用 admin DB migration（原子 D1 batch），再部署匹配版本；
聚合端先应用 0011 再上新 Worker/Web。升级顺序不构成当前生产变更授权。
完整上游 schema 的重复迁移保留已有 token；旧原文 backfill 仅补缺失行。
若缺失版本触发器或操作表，修复会先使现存资源代次失效，避免触发器失效期间变更正文后复活旧 token；
已有操作结果不清理。同名漂移触发器不静默覆盖，持续失败关闭，需受控修复。
dated SQL/fresh schema 是相同 SQL 的来源文件；修复已有异常库必须使用完整原子 batch，
不能分条在线执行；不保证事务的执行器必须先隔离全部读写并另行验证，不能视为本轮已验入口。
回退保留扩展表、触发器、缓存身份和所有 guard，回退旧代码不撤销已经完成的远端删除。
不执行 down migration、删除表、回滚快照后重放外部写入或恢复源邮件的虚假承诺。

`remote-contract` 覆盖实际上游条件处理器和版本 SQL；夹具的 JWT 分配及 MIME parsed 内容是合成实现，
不是完整 Hono middleware、真实 MIME parser 或生产 JWT 的端到端证明。
`remote-runtime`、`remote-migration` 覆盖聚合授权/归属、晚响应、事务故障、ID 复用、升级及持久化；
`remote-web` 在独立 Chrome 中验证确认/取消、unknown 跨刷新恢复、只读核对及移动布局。
本轮完整收据使用 `linshi/easyemail-cloudflare-migration-20261028/m3j-final/verification.json`。
真实供应商删除、生产 schema/CPU/D1 成本、完整上游构建、远端邮箱删除及整个迁移仍未验收完成。
