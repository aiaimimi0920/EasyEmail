# 普通邮箱远端移动／永久删除后端（W14d2）

本阶段在 `migration/cloudflare-web` 工作区接通生产路由的后端实现，不发布到 Cloudflare，不修改 NAS，也未接通网页按钮。协议基础见 [W14d1](cloudflare-normal-mutation-protocol-slice.md)。整体迁移仍未完成。

## 接口和权限

以下路径同时支持 canonical INBOX，以及在账号路径后插入 `/server-folders/:folderId` 的精确非 INBOX 来源：

- `POST /api/v1/normal-accounts/:accountId/messages/:messageId/remote-mutations`
- `GET /api/v1/normal-accounts/:accountId/messages/:messageId/remote-mutations`：最近操作。
- `GET /api/v1/normal-accounts/:accountId/remote-mutation-operations/:requestKey`：永久原键回执。

请求必须包含 `Idempotency-Key`。共同权限为 `mail-accounts:read`、`messages:read`；移动另需 `mail-accounts:remote-move`，永久删除另需 `mail-accounts:remote-delete`。旧 `mail-accounts:remote-flags` 和平台删除权限不包含这两项权限。会话写入还必须通过 Origin 检查。GET 按回执实际 action 核对权限、owner、account 和来源 folder；同键 POST 在当前上下文、endpoint 或 OAuth 查询之前回放。

移动 body：

```json
{
  "expectedRevision": 1,
  "epochId": "00000000-0000-4000-8000-000000000001",
  "action": "move",
  "destinationFolderId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "destinationEpochId": "00000000-0000-4000-8000-000000000002",
  "confirmRemoteChange": true
}
```

目标必须是同一账号当前 catalog 中可选择的不同服务器目录，并已显式同步出当前 epoch；空目录也可以先同步建立 epoch。目标 INBOX 使用 catalog 中的 INBOX id，但来源 INBOX 只使用原 canonical 路径，不另建别名命名空间。

永久删除 body 仅含 `expectedRevision`、`epochId`、`action: "delete"` 和 `confirmPermanentDelete: true`；不能混入移动字段或确认 unknown 后重试的字段。这是实际远端删除，不是平台回收站。

## 持久边界与旧版本共存

追加 `0058_normal_remote_mutations.sql`，当前共有 58 项迁移。新增永久 operation，不改旧 flags、cache、batch 或 checkpoint。回滚应用程序时保留扩展 schema 和历史回执，不通过删表、删 guard 或重写 unknown 回滚。

- 任何网络工作（包括 OAuth 刷新）之前预约，冻结来源、目标、请求 hash 和账号 revision。
- 同一物理源 `(account, wireName, UIDVALIDITY, UID)` 的 pending／unknown／confirmed mutation 共用永久唯一锁。只有确定未派发的 failed 可释放。
- mutation 拒绝任一尚为 pending／unknown 的同物理源 flags，即使后面已有 confirmed flags。新 flags 不能取消旧 STORE 的迟到可能性。
- 数据库双向 INSERT 和 flags dispatch 触发器保护未升级的旧 flags worker，不依赖其调用新应用层检查；不阻止旧 finish 记录事实，保留 flags 自身的 exact acknowledgement 续接合同。
- 所需表、唯一索引或任一触发器缺失时，新 mutation API 返回 `remote_mutation_schema_required`，不开 socket。

每个不可逆阶段先原子记录意图，再发命令；同时重核源 message/batch/source/epoch/UIDVALIDITY/generation/watermark、目标 catalog/state/epoch/UIDVALIDITY/generation、发起凭据及 action scope、OAuth fence。首次写之前，还比较服务器 EXAMINE 得到的目标 UIDVALIDITY。原生 MOVE 与 COPY、Deleted、UID EXPUNGE 阶段不自动重连、重发、补偿或执行整目录 EXPUNGE/CLOSE。

INSERT 丢回执后查到已有行不重新获得执行权；phase 写入丢回执不发该命令。派发后异常保守记录 unknown。pending 超时仅在视图显示 unknown，不改变数据库状态或解锁。只有原键只读核对，不接受新键绕过锁。

已解析 COPYUID 单独作为历史事实写入，和下一阶段授权分离；因此目录失效、OAuth 撤销、后续源读取失败或期限结束，都不会主动清除已写入的目标 UID。若数据库拒绝／丢失证据写入，或 HTTP 返回后运行时取消未结束的 I/O，则仍保守 unknown，不能伪造已保存的 mapping，也不依赖响应后的后台任务必定继续执行。在运行时仍允许的生命周期内，期限后只允许迟到证据落库，不能恢复协议执行。

## 缓存与验证边界

响应 `cacheRetained: true`、`retrySafe: false`。远端成功不修改本地 UID/epoch/folder、message/batch/R2 身份、本地已读/星标/标签/回收站、容量、reply/send pin 或游标。目标缓存必须由其独立正常同步建立，不能将源 UID 搬到目标或伪造已同步记录。

本阶段测试进入真实本地 workerd、D1 和 R2，只有测试构建替换 socket；OAuth 服务和 IMAP 对端全部为合成数据。范围包含正常移动／删除、空目标、原键恢复、旧 schema 扩展、混合版本 SQL、阶段异常、存储丢回执、并发、权限及 OAuth 撤销、15 秒绝对期限与迟到 callback。实际结果以 `linshi/easyemail-cloudflare-migration-20261028/normal-mutation-guard-final/verification.json` 为准，不以测试源码或早期局部结果代替最终验证。

后续仍需网页 held key/body/source/destination 恢复、清楚的远端结果展示及浏览器纵向验收；真实 IMAP/TLS/OAuth 互操作、Cloudflare 资源／MX／真实邮件投递、成本评估、授权发布和主干合并也未完成。本阶段没有读取真实凭据、连接真实邮箱、提交、推送、合并或部署。
