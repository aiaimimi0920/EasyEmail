# W10f：普通邮件的平台状态与回收站

普通来源现在拥有独立的平台已读、星标、归档和可恢复回收站，接入统一搜索和Web。
本地实现不代表普通邮箱全部迁移或真实Cloudflare/IMAP验收完成。
本文记录W10f历史边界；W10g已扩展普通标签及自定义位置，当前分类合同见[普通邮件分类](cloudflare-normal-taxonomy-slice.md)。

## 权威状态与来源

- `normal_message_state` 仅以普通消息ID关联 `normal_inbox_messages`；不借用临时 `messages` 表或其标签、文件夹身份。
- `platformState` 明确包含 `isRead`、`starred`、`archived`、`trashedAt`。无平台操作的旧消息按false/NULL读取，不强制补写旧行。
- `remoteFlags` 仍是同步时的IMAP快照。远端已有 `\\Seen` 也不自动将独立平台状态初始化为已读。
- 平台阅读、已读、归档、回收站和恢复不发送 `STORE`、`MOVE`、`COPY` 或 `EXPUNGE`，不自动重连IMAP。
- 回收站不清除正文、附件或R2对象，不是远端删除、永久清除或隐私擦除。直接受保护详情仍可读取回收站内容。

## API与幂等

`POST /api/v1/normal-accounts/{accountId}/messages/organize`

请求要求16–128字符的 `idempotency-key`，并包含1–50个唯一普通 `messageIds`，以及至少一个显式布尔字段：

```json
{"messageIds":["普通消息UUID"],"isRead":true,"starred":true,"archived":false,"trashed":false}
```

支持单封及同账号有限批量，但普通标签和自定义文件夹分派尚未接通，明确拒绝，不静默忽略。
整个批次同时验证当前owner、active用户、账号revision、来源哈希、epoch和committed消息归属；任一目标失效则全批不改。
停用IMAP连接不阻止已有缓存的平台整理；移除账号、改变来源或UIDVALIDITY则不能整理旧来源消息。

读取来源需 `mail-accounts:read` + `messages:read`，写入另需 `messages:write`；包含 `trashed` 时另需 `messages:delete`。
网页登录写入检查Origin。旧Key不扩权；新普通整理/回收站预设不包含账号配置、连接同步、发信或远端删除。

状态与 `normal_organization_operations` 回执在同一D1事务内提交。相同键/规范化请求只返回原回执，不重放状态写入；
同键不同请求409。原操作之后有新整理时，旧键重试不能撤销新状态。
批次回包丢失时仅核对同一回执，不推断回滚；无法确认时503，调用方保留原键。

`GET /api/v1/normal-accounts/{accountId}/organization-operations/{key}` 只读取回执，不重新执行整理。
仍校验当前账号owner/active及原操作所需权限；回执标识原revision/epoch，不伪装成当前邮件状态。
每账号累计最多10,000条整理回执，达到上限拒绝新操作但保留原键核对；自动保留维护仍待完成。

## 查询与网页

统一 `/messages?sources=all|normal` 支持平台已读/星标筛选以及收件箱、归档、全部邮件、平台回收站。
`all` 文件夹不含回收站；`inbox` 不含平台归档。普通账号列表也支持显式 `folder`，默认收件箱。
显式folder分页绑定同一folder；旧无folder游标只用于原默认入口。混合分页继续按来源和消息身份区分。
普通缓存提码排除平台回收站，归档仍可提取；恢复不改远端flags、UID、消息内容或同步检查点。

Web两处阅读入口共用同一操作组件，回收站有即时确认。聚合页面开放共同状态筛选，普通账号页增加平台文件夹选择。
普通邮件仍不进入临时邮箱批量框；普通批量API已实现，混合来源批量UI及标签/文件夹仍继续迁移。
未确认请求的键、正文和账号存放在本次用户会话的内存控制器，跨页面导航保留并锁账号变更；
用户可只读核对或显式原键重试，不自动重放，不存入localStorage/sessionStorage。注销或完整刷新不会持久化该内存状态。

## 升级、回退与未验边界

先应用0027，再启用新reader/writer。只新增两张表，旧普通消息、manifest、投影、临时状态和回执不改写。
回退保留两张新表、不执行contract。旧W10e代码会忽略新平台标记，可能重新显示已归档或回收站邮件；
回收站不是访问控制边界，不应承诺混合版本下仍隐藏内容。重新升级可恢复这些平台状态。

普通标签/文件夹、混合批量、永久清除/安全对象维护、会话/订阅、草稿/授权发送、原键同步式等待仍未完成。
多文件夹、远端状态写入、SMTP/OAuth2、Agent、更多供应商和旧数据迁移仍在整体目标中。
真实平台查询计划、CPU/并发/成本和真实邮箱收发必须单独验收；本切片不授权生产部署、导入、切流或合并。
