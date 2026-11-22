# 普通邮箱显式 XOAUTH2 认证基础切片（W10t）

本文记录 W10t 当时的范围。后续 Web/API 授权实现及仍未完成的真实验收见 [Google OAuth 纵向切片](cloudflare-google-oauth-slice.md)。

## 范围

本切片给原生 IMAP/SMTP 客户端补齐显式 SASL XOAUTH2 接缝，保留现有密码认证。
它是后续完整 OAuth2 的必要基础，不是可供用户使用的 Google OAuth 登录功能。
没有新的公共路由、Web 控件、凭据导入、provider 配置、数据库迁移或生产操作。
普通账号及 SMTP 的现行 Web/API 仍只接受密码，不接受手工 access token 对象。

协议依据已联网核对的 [Google XOAUTH2 合同](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol)。
完整授权流程还需遵循 [Web server OAuth2 合同](https://developers.google.com/identity/protocols/oauth2/web-server)。
Google 的 IMAP/SMTP 授权使用完整邮件 scope；公网应用的审核和数据使用要求不能用合成测试替代。

## 类型、边界及所有权

- `mail-authentication.ts` 只拥有内部凭据类型、输入边界及 UTF-8 SASL 序列化。
- 旧 `string` 参数始终表示密码；只有 `{ method: "xoauth2", accessToken }` 表示 OAuth access token。
- 未知类型、额外字段、控制字符、非法 UTF-16、非法 bearer 字符及超过 4096 字符的 token 在建立 socket 前拒绝。
- 不根据字符串前缀猜测 token，不把 refresh token 当作 access token，也不隐式切换认证方式。
- `normal-imap-auth.ts` 拥有 IMAP SASL 协商；`smtp-auth.ts` 拥有 SMTP SASL 协商。
- `mail-socket-session.ts` 仍独占总 deadline、STARTTLS replacement socket 和有界清理；认证模块不重连、不延长预算。
- 现有 Vault、AAD、账号/SMTP 密文、账号版本及发送 guard 的格式均不改变。

## 协议规则

### IMAP

TLS/STARTTLS 完成后，必须重新获得的 CAPABILITY 中有 `AUTH=XOAUTH2`，否则直接失败，不降级到 PLAIN。
有 `SASL-IR` 时在 AUTHENTICATE 命令中发送初始响应；没有时等到空 continuation 后发送一次。
尚未发送 token 就收到非空 challenge 或无交互的成功，不继续披露凭据或读取 INBOX。

发送 token 后再收到 continuation 被视为认证错误，只发送一次空响应。
随后即使收到 tagged OK 也仍然失败；重复 challenge 不触发第二次空响应或 token 重发。
错误内容不解析为新的授权指令，不反射到异常或公共响应。
成功后仍为 EXAMINE/BODY.PEEK，只读 UID、literal 和 cursor 规则不改变。

### SMTP

升级后 EHLO 必须明确支持 XOAUTH2。初始响应只发送一次；收到 334 error challenge 后只发送空响应，
读取一次终止响应后失败，235 也不能把该路径改成成功。不发送 MAIL、RCPT 或 DATA。
原 PLAIN 初始响应及单次 continuation 行为保持。

认证失败发生在 DATA 之前，结果为 rejected。DATA 之后断线或到期且结果不明确，仍为 unknown；
明确负回复仍为 rejected，最终 250 仍只表示 accepted，不表示收件方已投递。
这里不自动刷新 token、不创建新的授权、不重试真实发信。

## 本地证明与边界

回归包括：TLS/STARTTLS、IMAP SASL-IR/非 IR、相同 PLAIN 字节、能力缺失、错误后伪成功、重复 challenge、
最大 token、Unicode 用户名、非法输入以及独立 pending-read / pending-write 的迟到回复。
即使 close 不结算挂起 I/O，15 秒 deadline 与 1 秒清理后也不能再发 token、空 ACK、EXAMINE 或 MAIL。

独立测试 Worker 在本地 workerd 中调用相同原生客户端，TCP peer 为合成 HTTP bridge。
公共账号/SMTP API 的 password-only 边界也在本地 HTTP 中回归。
测试入口和 transport 不得进入生产 bundle；没有真实证书、TLS 握手、Google 登录或公网投递。
相关旧账号、同步、草稿、回复、附件、队列、保留及 Web 回归不等于完整全仓测试。

当前权威收据为证据目录内的 `mail-auth-final/verification.json`，仅以实际 `status` 为准：
`C:\Users\Public\nas_home\AI\GameEditor\linshi\easyemail-cloudflare-migration-20261028`。

## 完整 OAuth2 仍待迁移

下一阶段必须交付服务端授权 URL、state/PKCE、一次性 code 交换、加密 access/refresh token、
有界刷新与独立 token 版本、撤销/忘记、账号及 SMTP 绑定、Web/API 入口和故障/并发回归。
不能把本切片的协议通过或用户手填 token 当作上述功能完成。

现有 `SameSite=Strict` session 不能假定随跨站 callback 到达；授权发起、callback 和同源 finalize
须绑定原用户与原会话，并在安装凭据时重新检查会话撤销/过期、active user 及账号版本。
code 交换模糊失败不能退回可重复交换状态；晚到刷新不能覆盖新 token 或复活已撤销凭据。
token 刷新版本不能直接复用账号逻辑 revision，否则会错误地使 SMTP、同步 claim 和排队任务失效。

## 回退

本切片不写新格式数据，也不启用新的生产配置。
可按切片备份恢复这组源码及测试，不影响既有密码密文和配置 hash；不得据此降级之前保留/容量切片的 schema。
原目录、原服务继续保留，不自动提交、合并、部署、导入凭据或切流。
