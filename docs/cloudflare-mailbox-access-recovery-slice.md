# W15a：凭据证明的临时邮箱访问恢复

## 范围

在迁移分支接通自营 Cloudflare Email 的只读活体身份验证，以及聚合服务的 Web/API 导入与恢复。
这里的“恢复”是重新提交有效邮箱 JWT、保存加密访问凭据，不是按地址认领，不是恢复已删除邮件，也不是创建上游邮箱。
本地结果以独立 `mailbox-access-recovery-final/verification.json` 为准；不代表生产资源或真实邮件投递已验收。

## 两个服务的合同

自营 Email Worker 新增 `GET /api/mailbox_identity`，先验证站点密码和 HS256 邮箱 JWT，再经过地址代际的读前、读后检查。
返回 `contract: easyemail-mailbox-identity-v1`、准确的 `address`、不可复用的 `addressId` 及 token 的 `expiresAt`（没有 exp 时为 null）。
接口不延长邮箱存活、不修改地址时间、不读取邮件、不使用管理员身份。管理员万能创建凭据不能代替用户邮箱 JWT。
验证错误日志仅保留通用错误，不打印可能包含原 token 的 JWT 异常对象。

聚合适配器只访问管理员已配置的可信供应商地址，只带邮箱 JWT 和必要站点密码，不带管理员创建 Key。
要求精确合同、地址、正安全整数代际和有效 token 期限。旧上游返回 404 时明确不支持；没有 settings、邮件列表或管理员创建降级路径。
目录始终保留 `restoreByAddress: false`；独立 `credentialRecovery: proof-required-v1` 表示须上游活体验证，不保证任意旧部署都支持。
其他供应商本轮仍不支持此能力。

## 聚合 API

`POST /api/v1/mailbox-access-recoveries`：`mailboxes:write`，网页登录还须同源 Origin。
请求头 `Idempotency-Key` 为 16–128 位字母、数字、横线或下划线。JSON 只接受：

```json
{"providerId":"self","address":"existing@example.test","token":"<mailbox-jwt>"}
```

总请求仍受 8 KiB 限制，token 上限 4096 字符，不接受任意 endpoint、owner、remoteId 或忽略凭据的地址恢复。
成功返回 `recovery`，包含原 `requestKey`、`mailboxId`、`providerId`、`address`、`mode` 和 `createdAt`。
`mode` 为 `imported`、`restored` 或 `refreshed`。首次导入返回 201，已有记录恢复、更新或原键重放返回 200。

`GET /api/v1/mailbox-access-recoveries/:key`：`mailboxes:read`，只返回当前用户的不可变回执，不连接上游、不恢复凭据。
历史回执不声明邮箱现在仍可用；当前状态由 `/api/v1/mailboxes/:id` 另行读取。
网页增加最小 `mailboxes:read` + `mailboxes:write` Key 预设，不含邮件阅读、发送或远端删除权限；既有 write 权限仍包含创建和同步，未伪称恢复专用 scope。

## 所有权与生命周期

- 从未导入：活体证明通过后，原子保存 mailbox、完整 creation 地址 guard 和独立 recovery 回执；占用既有每用户 100 项分配额度。
- 同用户同 provider 同代际：复用原 mailbox ID，替换加密凭据，取消旧同步 lease，递增 revision。
- 已释放：只清 `released_at`，保留原 `disabled_at`；用户须另行显式启用，不自动启动收信或发信。
- active / disabled：允许显式更新凭据，但不改变停用、暂停、创建时间、平台期限、缓存或元数据。
- 已有邮箱的平台 expiry 原样保留；token 过期会由上游拒绝访问，不能通过恢复延长平台 retention。新导入期限取当前 policy 与 token 期限的较早值。
- 跨用户占用、跨 provider、同地址新代际、只有 pending/unknown creation guard 的地址：拒绝接管，不转移所有者。
- 平台过期或 tombstone、任何状态的远端邮箱删除回执：拒绝恢复，不清除历史证据。
- 未决发信、邮件删除或 queued/preparing 发送任务：阻断凭据恢复，避免重新激活旧外部意图。

最终 D1 写入重新核 caller/当前 Key scope、provider revision、retention revision、邮箱完整版本和生命周期、expiry、删除与静默状态。
身份验证与本地提交之间不是跨服务事务：上游仍可能立即删除邮箱。成功只表示保存了刚验证的凭据，不承诺持续可用或恰好一次投递。

## 持久化与重试

追加 `0059_mailbox_access_recoveries.sql`，聚合共 59 项迁移；不修改旧迁移，不增加依赖。
回执不存明文 token；请求摘要使用 Vault 派生 HMAC，凭据使用绑定最终 mailbox/owner/provider 的 AES-GCM。
一个 D1 batch 提交回执和全部身份写入，以每次随机 operation ID 为 nonce，竞争输家不能借赢家回执继续写。
新导入的永久 creation guard 使用外部创建请求不允许的 `recover:` 命名空间，并在创建历史明确标为导入。
每用户每分钟 5 次新验证、1000 项累计恢复回执；旧键回执读取与精确重放不消耗新验证额度。

上游请求全为只读。事务失败不能留下孤立 complete receipt、地址 guard 或半个 mailbox。
响应丢失后先 GET 原键；只有明确不存在回执，才允许用户显式用原键、原输入重试或结束本次验证。
已成功回执直接重放，不重新恢复，不能撤销后续 disable/release。

## 网页与兼容窗口

邮箱管理提供独立供应商、地址和密码式凭据输入；提交后立即清空输入框，未决原输入仅在当前会话内存中保留。
没有 URL、localStorage 或 sessionStorage 凭据持久化。导航不另起请求；回执不匹配或网络异常锁定原请求，默认只读核对。
刷新浏览器后可凭保存的请求键只读查询回执、打开当前 mailbox，不自动 POST。

先部署带身份合同的 Email Worker，再对聚合 D1 追加 0059，最后部署聚合 Worker/Web。缺 schema 在连接上游前拒绝；旧 Email Worker 明确不支持，不降级。
回退应用时保留全部新表、地址 guard、密文和回执，不回滚或删除数据。旧程序可继续读邮箱；旧 release/enable 行为不变。
旧进程不会理解恢复回执，因此实际发布须独立复核 mixed-version 和资源接线；本切片没有实施真实发布。

## 验证范围与未完成事项

测试覆盖完整双 Worker 的空邮箱证明、导入后本地合成收信、重启、恢复原记录、原键重放及密文；覆盖跨用户、错地址/代际、过期、删除、未知 creation guard、配额和迁移。
故障注入覆盖 batch 回滚、同键和跨 owner 竞争、调用授权撤销/缩权、provider 变更、生命周期/expiry 与未决发送竞态。
Chrome 覆盖导入、释放、恢复、只读原键、响应丢失、不匹配回执、明确不存在后的同键重试、移动布局及无浏览器存储。
真实云端部署、MX、公网投递、真实 IMAP/TLS/OAuth 互操作、其余供应商适配与整体迁移仍未完成；没有读取真实密钥或触碰 NAS。
