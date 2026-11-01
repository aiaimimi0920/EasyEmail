# 条件地址删除 API

该合同从 DB v0.0.9 起提供，不替换旧 `DELETE /api/delete_address`。
只对受控客户端开放；旧接口也补充了代际校验与 D1 batch，但没有本合同的持久回执及幂等语义。

认证沿用 `Authorization: Bearer <Address JWT>`，部署设置站点密码时另带 `x-custom-auth`。
JWT 必须同时有 address 和严格合法的 address_id，支持安全整数或 canonical 十进制字符串。
所有入口要求迁移表定义匹配，address 使用 AUTOINCREMENT；未迁移或定义漂移返回 503。

## 能力与代际

`GET /api/address_deletion_capability` 校验当前地址 ID/name pair，返回：

```json
{"capability":{"address":"test@example.test","addressId":"123","enabled":true,"conditionalDelete":true,"cleanup":"d1-mailbox-data-v1","externalResourcesDeleted":false}}
```

地址已转移或不存在时返回 403，不返回新地址的凭据。

## 原子删除

```http
POST /api/address_deletions
Content-Type: application/json
```

```json
{"requestId":"12b09846-a5c0-4bb8-b6f8-0ef93279a238","addressId":"123","address":"test@example.test"}
```

请求严格限三个字段，实际请求流最多 8 KiB。addressId/address 必须等于 JWT 已认证身份。
新写入受 ENABLE_USER_DELETE_EMAIL 控制；关闭时返回 403，已有回执仍可重放/查询。
决策、回执和 D1 清理使用同一 batch，失败整体回滚；同键并发只有一个清理批次。

HTTP 200 响应包含 operation（requestId/addressId/address/state）、cleanup 和 externalResourcesDeleted=false。
state=deleted 表示匹配代际的地址及 raw_mails/address_sender/sendbox/auto_reply_mails/users_address 已清理；
changed 表示代际变化，未删除；absent 表示当前已不存在，不能证明由本次删除。

## 核对与保留

`GET /api/address_deletions/:requestId` 只查原回执，不执行删除；未观察到回执返回 404。
404 不证明原请求将来不会到达，调用方不能据此自动改键或重新删除。
删除后原代际 JWT 仍可查询自己的回执。回执不自动清理，原请求重放不影响同名新邮箱。

本合同只清理列明的 D1 数据，不操作 Telegram/Webhook KV 或 S3，不声称完全擦除外部资源。
`/api/*` 验签后检查当前 ID/name pair，读取返回前再次检查；失效代际返回 403，D1 校验失败返回 503。
仅精确的条件地址删除 POST 和合法 UUID 的地址/邮件回执 GET/HEAD 允许原代际核对自身操作。
旧删除保留 ID-only/name-only 调用，完整 pair 重新校验、D1 同批删除且检查实际命中；解绑阶段发生名称替换不清理新代际。
不能撤销已在途写入，也不覆盖独立 admin/user/Telegram 入口或既有外部签名 URL；聚合 Web 删除尚未启用。
数据库恢复、手工 ID 重用和旧请求恢复需要另行核对，不能把代码回退当成撤销删除。
