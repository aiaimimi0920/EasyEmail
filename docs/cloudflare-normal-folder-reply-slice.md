# 普通邮箱多目录回复（W14c2）

本切片将非 INBOX 缓存邮件的回复接入既有普通邮箱写信器，不另建草稿或发送状态机，不依赖桌面端、Userscript 或 NAS。

## API 与兼容

新增只读预览：

```text
GET /api/v1/normal-accounts/{accountId}/server-folders/{serverFolderId}/messages/{messageId}/reply
```

要求 `mail-accounts:read`、`messages:read`；回复预览增加精确 `serverFolderId`，Web 必须核对账号、消息、目录和账号版本。
旧 `/normal-accounts/{accountId}/messages/{messageId}/reply` 明确仅接受 INBOX，不能用目录消息 ID 绕过旧 URL 边界。

草稿、直接发送和队列仍只使用全局 `replyToMessageId`。服务器从账号和全局消息 UUID 推导来源，不接受客户端提交目录、claim 或 MIME 线程头。
原消息 ID 已为全局主键；无需新增列或迁移文件，仍为 56 项。`normal-send-input.ts`、`draft-input.ts` 的旧 hash 结构保持不变。
同一 UID 可以存在于多个目录，不能通过 UID 猜测来源或回退到 INBOX。

## 来源与授权

`normal-reply-source.ts` 拥有来源选择与最终 SQL fence，复用搜索上下文的完整目录归属：

- 当前账号归属及 revision、active 用户、未移除账号。
- message/batch 的账号、epoch、source、目录归属及 committed 状态；未 purged、未进平台回收站。
- 当前 state 的 source、epoch、缓存代次、已发布 UID；目录同时核对 catalog source、wireName、selectable。
- 原文和内容 SHA-256；原文 R2 长度／SHA-256 验证后再次检查相同来源。

Reply-To／From 单目标解析、Message-ID／References 线程头、纯文本回复及用户可编辑收件人规则保持原合同。
不读取其他目录的正文或补齐其索引，避免一个目录的回复依赖不相关目录的 R2 可用性。

HTTP 预览／保存／直接发信／入队同时检查当前 session 或 API Key。异步队列不把创建者凭据当运行身份：
runner 显式传入内部 `JobClaim`，核对 normal 来源、user、job、preparing、claim token、lease 和 deadline。
撤销创建者 Key 不取消已授权的持久任务；失效 claim 则不能预约 SMTP。没有魔法字符串凭据绕过。

## 草稿、队列、防重与保留

最终草稿 INSERT／UPDATE、发送预约和入队 SQL 都使用同一来源 fence；读后变化不能消费草稿、创建任务或打开 SMTP。
复用现有附件引用、草稿 CAS、定时／取消、持久发送 guard、unknown 和丢响应只读核对逻辑。
永久原键回放仍先于来源／R2 读取；原信清理或目录失效不能使成功或 unknown 请求再次 SMTP。

已有保留策略按账号和全局消息 UUID pin 原信，覆盖 editing 草稿、活跃队列、pending outgoing；不新增按目录漂移的 pin。
本切片回归验证草稿到队列、队列到 pending outgoing 的 pin 交接，以及终态之后原信重新可被保留策略选中。

## Web 与范围边界

独立服务器目录、聚合、会话和订阅详情共用回复按钮和唯一普通写信器。
预览不自动保存或发送；保留未保存 IMAP／SMTP／正文、未决操作、nonce、晚到响应和退出登录隔离。
本切片当时不接入非 INBOX 远端 flags，后续见[W14c3](cloudflare-normal-folder-flags-slice.md)；远端移动／删除仍未迁移，不伪造远端已读。
不实现 reply-all、转发或第二套 composer。

## 验证与回退

最终证据入口为 `linshi/easyemail-cloudflare-migration-20261028/normal-folder-reply-final/verification.json`，以实际 status 和源码快照为准。
新增 runtime、boundaries、races、lifecycle、Chrome 测试，另回归旧 INBOX 回复／草稿／发信／附件／队列／保留，以及目录收件和聚合阅读。
测试只使用本地 workerd、D1、R2 与合成 SMTP，不代表真实公网邮件投递成功。

本轮没有 schema 变更；回退代码前仍须停写并保全目录回复草稿、队列和永久发送 guard，旧代码不能继续编辑其不认识的目录来源。
没有提交、推送、合并、部署、真实密钥读取、真实邮箱连接或生产资源修改。整体迁移尚未完成。
