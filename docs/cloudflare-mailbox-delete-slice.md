# 远端邮箱删除迁移（M3k，本地切片）

本阶段继续迁移自营邮箱生命周期，不把已有“释放平台访问”改成远端删除。
所有开发和验证只用隔离 worktree、本地 workerd/D1 与合成数据，不操作现网邮箱。

## 1. 已确认的旧合同问题

旧 `DELETE /api/delete_address` 调用 `common-cleanup.ts` 的 `deleteAddressWithData`。
原实现中两个 JWT 字段都存在时，该函数不重新核验当前 address ID/name pair；同名地址转移或重建后，
旧 JWT 仍可能按名称清理新代际。它先写 Telegram KV，再逐条删除 D1 数据，没有跨语句回滚。
原全局 JWT middleware 只验证签名，不能作为地址仍属于该代际的证明。

旧操作也不删除 Webhook KV、S3 附件或既有邮件删除回执，不能称为完整隐私擦除。
旧 JWT 读取及解绑期间替换地址两个缺陷已在本地真实 Hono/HS256、workerd/D1 中 red→green，
不是生产复现或生产修复的结论。

## 2. 本次已实现的上游基础合同

DB v0.0.9 只扩展 `address_delete_operations`，不改写历史邮件或用户数据。
admin 初始化/迁移、新建 SQL 和 dated patch 接入同一表定义；重复迁移保留回执。

```text
GET /api/address_deletion_capability
POST /api/address_deletions
{"requestId":"UUID","addressId":"正整数安全 ID 字符串","address":"完整邮箱地址"}
GET /api/address_deletions/:requestId
```

全部入口沿用 Address JWT 和可选站点密码。JWT 的 address_id 支持严格安全整数 number 或
canonical 十进制 string，兼容既有 URL 参数签发方；空白、前导零、指数和不安全整数拒绝。
请求体仍按实际流限制 8 KiB，严格校验字段、媒体类型及 UUID；错误不回显 SQL/凭据。
这一共享校验同时修复 M3j 对合法字符串 ID JWT 的兼容问题，正文与版本删除语义不变。

能力查询要求当前 ID/name pair 匹配；写入 body 必须匹配已认证 JWT，不能凭公开地址操作。
决策、回执与 raw_mails/address_sender/sendbox/auto_reply_mails/users_address/address 清理在同一 D1 batch。
最终地址删除失败会回滚前面的全部清理。每次 batch 有私有 nonce，重叠同键请求不能重做清理。

- `deleted`：本次原子批次匹配并清理了指定地址代际及上述 D1 数据。
- `changed`：ID 或名称对应了其他代际，不删除相关数据。
- `absent`：已无该地址 ID/名称，不能证明由本次删除；不擅自清理孤立同名数据。

相同请求重放已有回执，关闭 ENABLE_USER_DELETE_EMAIL 后仍可重放/查询；新请求被拒绝。
查询不重新删除，删除后旧 JWT 可查自己的回执，但不能把回执认领到新代际。
回执保留，不随 address、原始邮件或相关表清理；新响应明确 externalResourcesDeleted=false。
正常 ID 不复用依赖 address 的 AUTOINCREMENT；备份恢复、手工重用 ID 或数据库重置不是已解决的分布式回退合同。

## 3. API 代际访问与旧清理安全基础

`/api/*` 在验签后核验当前 ID/name pair，合法的 number/canonical string ID 保持兼容。
旧代际、字段非法或不匹配返回 403；D1 校验故障返回脱敏 503，不派发受保护操作。
GET/HEAD 处理器返回前再次核验，避免等待期间地址被替换后仍返回按名称读取的内容。
这不是对已经派发的写操作的全局取消，也不覆盖独立 admin/user/Telegram 入口、既有签名下载 URL 或外部 KV/S3 副本。

精确例外仅为 POST `/api/address_deletions` 和合法 UUID 的 GET/HEAD 地址/邮件回执路径。
它们仍先验签及严格解析 claims，再由各合同核对 body 或按原 ID/name/requestId 查询自己的回执；
不通过宽泛路径前缀放行。原代际可在邮箱删除后只读查询原邮件回执，新代际不能认领旧回执。

旧 `deleteAddressWithData` 保留仅 ID、仅名称和两个字段的调用方式及 `{success}` 外部合同，
先解析并重新核验完整 pair，再尝试 Telegram 解绑。6 张 D1 表的删除改为同一 batch，
每个名字键清理都受原 pair 保护，地址行最后按 ID/name 删除并检查实际命中数。
解绑期间名称重建不会清理替代代际，末尾 SQL 异常回滚前面的 D1 清理。
Telegram/KV 不在 D1 事务中，解绑已发生而 D1 失败不能自动补偿；不宣称所有生命周期入口或外部资源已安全清空。

## 4. 聚合 API、权限与状态

新增 `0012_remote_mailbox_deletions.sql`，仅扩展持久回执，不删除或改写旧邮箱、邮件、创建记录、发送记录或 Key scopes。
catalog 新增 `conditionalRemoteMailboxDelete`，只有 Cloudflare 为 true；原 `remoteMailboxDelete=false` 表示不提供无条件删除。
这只是适配器能力，不证明每个已部署上游已经启用；每次新操作都真实预检上游 capability。
Temporam、旧上游、禁用或不匹配的能力均不能预约，不回退到 legacy DELETE。

```text
GET  /api/v1/mailboxes/:id/remote-delete
POST /api/v1/mailboxes/:id/remote-delete
     Idempotency-Key: 16-128 characters [a-zA-Z0-9_-]
     {"confirmAddress":"完整邮箱地址","confirmMailboxId":"平台邮箱 UUID"}
POST /api/v1/mailboxes/:id/remote-delete/check
     {}
```

GET 仅查平台记录，要求 `mailboxes:read`，不连接上游；没有记录时返回 `deletion:null` 和本地可尝试状态 `available`。
两个 POST 要求独立 `mailboxes:remote-delete`。旧 `mailboxes:delete` 或 `messages:remote-delete` 不隐式获得该权限。
所有操作校验用户归属；Cookie 会话写入还要求正确 Origin，API Key 则使用自身权限而非浏览器 Cookie。

首次请求预检真实地址代际、清理合同及 enabled 状态，再预约唯一操作。每邮箱最多一个记录，每用户幂等键唯一。
预约与停用、撤销同步 lease 同 D1 batch，SQL 重新核验 owner、地址、远端 ID、凭据、同步 revision、provider revision 和平台期限。
已停用但凭据仍有效的邮箱允许显式删除；已释放、到期、非 active 邮箱不能预约新外部写入。
正在处理或结果未知的发送/邮件删除阻止邮箱删除；反之，邮箱删除先预约会使后续发送、同步、邮件删除不能再预约。
迟到的同步或附件响应不能重新回填缓存或返回原附件字节。

- `pending/unknown` 返回 202；超过 60 秒的 pending 只在读取投影为 unknown，不改写证据。
- 重复 POST、换新键或重启都返回原邮箱操作，不再次写上游。
- check 仅 GET 原 requestId；404、网络错误和回执身份不匹配保持 unknown，不能解释为 absent。
- check 绑定原 provider endpoint/revision；配置变化不把邮箱 JWT 发到新 endpoint，也不跟随 HTTP 重定向。
- 只有经过严格核验的 `deleted/absent/changed` 才终结；终态不会被迟到的超时覆盖。
- 终态与清除平台凭据/释放旧代际访问同 batch；记录失败明确返回 503，不伪装成功。

`deleted` 仅表示上游 D1 合同成功；`absent` 不证明由本次删除，`changed` 不删除替代代际。
三者都释放平台对原代际的访问，保留平台缓存、去重、创建/发送/删除 guard、配额与回执。
不返回或再保存第二份邮箱凭据，不使用 admin key 删除邮箱。

## 5. Web 与凭据保留边界

邮箱设置提供独立“删除上游邮箱”，要求完整地址确认，可取消并防双击。
unknown/pending 只能核对原操作，刷新或重新打开从持久记录恢复；HTTP 请求失败先刷新平台记录，不直接再提交。
新增 Key 预设“查看与条件删除上游邮箱”，与平台释放及远端邮件删除分开。

显式释放和到期维护仍会清除凭据，不延长保留期，也不取消已派发的远端删除。
因此，释放/到期后若回包丢失，平台可能永久只有 unknown，无法再向上游查询；本地回执仍可读。
已在途请求可能成功，不能将页面停用或凭据清除称为撤销。
KV/S3/Telegram 不在本删除事务内，不宣称完整擦除或外部清理已完成。

## 6. 验证与回退

基础合同测试实际调用新生产处理器和真实 fresh SQL；旧聚合 provider 夹具的 JWT 分配仍为合成。
新的聚合邮箱删除夹具使用真实 Hono HS256 JWT、中间件 guard、生产删除处理器和完整本地 D1 schema；
邮件解析、admin HTTP wrapper 和发送渠道仍为合成，不是真实供应商验收。
后续[创建合同修复](cloudflare-creation-compatibility.md)使该夹具真实执行生产 newAddress 名称/域名规则、D1 INSERT 与 JWT 签发，仍非完整 admin middleware 集成。
新增安全测试另以真实 Hono/HS256 验签、中间件 guard 和生产 legacy D1 清理执行 HTTP 回归，
只隔离 Telegram/翻译/无关工具依赖，并合成解绑异常/交错；不代替完整上游构建、
全入口撤销、真实 Telegram/KV/S3 集成、生产 CPU/D1 成本或真实供应商删除验收。
新增 runtime、并发、边界、0011→0012 保留和 Chrome 回归分别加入标准 npm test / test:web。
包括同名重建/消失、预约双向互斥、丢回包、跨重启恢复、事务故障、迟到响应与不支持能力的拒绝。

在线 npm audit 发现初始测试依赖 Hono 4.12.14 存在已知漏洞，现将隔离鉴权测试固定到 4.13.14，
并将上游声明的最低兼容版本提升到 ^4.13.14；不执行批量 audit fix，不声称现网依赖已经升级。
额外测试真实签名 JWT 的 exp/nbf/iat 过期、未来和非数值字段，确保在业务派发前拒绝。
安全阶段的 182 项后端和 20 项浏览器结果属于历史快照；新聚合切片以 `m3k-aggregate-final/verification.json` 的实际源码和重跑范围为准。

回退保留扩展表及回执，不执行 down migration；回退代码不能撤销已经发生的外部删除。
本次没有任何真实资源删除、生产迁移、部署、提交或合并。
