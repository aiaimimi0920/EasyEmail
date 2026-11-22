# 版本条件邮件删除

此接口用于防止缓存中的整数邮件 ID 被复用后误删新邮件，不替代邮箱地址删除。
聚合客户端不应回退调用旧 `DELETE /api/mails/:id`。

## 迁移与认证

DB v0.0.8：先通过 admin DB migration 的原子 D1 batch 扩展 schema。
新建库的 `db/schema.sql` 已包含资源表、操作记录和版本触发器。
完整 schema 的重复迁移不重置代次；缺失触发器/操作表的修复使现存代次失效，既有操作结果保留。
`db/2026-10-28-mail-resources.sql` 是对应 SQL 来源；修复异常库时必须将整组作为原子 batch 执行，
不能分条在线执行；无法保证事务时先隔离全部读写并独立核验。不要清理幂等操作表后重放请求。
表或触发器缺失/定义漂移时条件删除失败关闭，parsed API 继续只读旧格式。

沿用 `/api/*` 的 `Authorization: Bearer <Address JWT>` 和站点可选 `x-custom-auth`。
JWT 必须含当前有效的 `address` 和正整数 `address_id`，旧地址重新创建后旧 JWT 不可操作新代次。
新写入受 `ENABLE_USER_DELETE_EMAIL` 控制；关闭后既有记录仍可重放或只读核对。

## 请求

parsed API 在同一个 SQL 快照返回原文对应的 `resource_version`（32 位 lowercase hex）和
`remote_delete_enabled`。缺少代次的历史正文不能仅按相同内容补认新代次。

```http
POST /api/mail_deletions
Content-Type: application/json

{"requestId":"00000000-0000-4000-8000-000000000001","mailId":"1","expectedVersion":"0123456789abcdef0123456789abcdef"}
```

实际 body 上限 8 KiB，必须且只能有这三个字段。mailId 为正整数的十进制字符串且不超过安全整数。
相同 requestId 与原 body 重放同一持久结果，不同 body 返回 409。
资源版本在原文插入、更新、删除及 ID 复用时由触发器维护，不是单纯内容 hash。
条件决策、持久记录和删除在同一 D1 batch 中提交；异常时一起回滚。

成功 HTTP 200 返回 `operation: {requestId, mailId, expectedVersion, state}`：

- `deleted`：匹配该代次并已删除，不代表同 ID 的未来新信也被删除。
- `absent`：此地址下已无该 ID，不能证明由本次删除。
- `changed`：已是其他代次，拒绝删除新版本。

```http
GET /api/mail_deletions/00000000-0000-4000-8000-000000000001
```

GET 只查询该地址代次下原操作，不创建、取消或重发删除。404 不证明尚在途的 POST 永远不会到达。
地址删除后原 JWT 仍可只读查询自己的邮件回执；同名新代际无法读取旧回执，旧 JWT 不能因此读信或新增邮件删除。
超时或响应丢失时保留结果未知，显式 GET 核对原 requestId，不更换 key 自动重试。
结果记录与邮件分开保留；回退代码/数据库快照不构成外部删除撤销。
本合同的本地验证不等于生产 schema、完整 JWT middleware 或真实邮件删除验收。
