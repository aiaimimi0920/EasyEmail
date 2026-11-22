# Agent Google OAuth 纵向切片（W11j）

## 范围与验收边界

本切片在 `migration/cloudflare-web` 中复用普通邮箱 W10u 的 Google 授权、PKCE、加密 grant、刷新与 HTTP 安全边界，
接入独立 Agent 账号、连接检查、显式/持久授权收件、任务和线程 follow-up 的 SMTP XOAUTH2。
网页直接完成授权，不要求桌面客户端、Userscript 或手工粘贴 token。

本地结果以 `agent-google-oauth-final-verified/verification.json` 的实际 `status` 为准，不能用 W11i2 或 W10u 的旧绿色收据代替。
合成 Google 同意页、token/userinfo 和邮件对端只用于本地验收；workerd、D1、R2、HTTP 和 Chrome 实际运行，
但这不等于真实 Google 登录、真实 TLS、公网投递、Google 端撤权或 Cloudflare 发布。
本阶段未读取生产凭据、修改 Google Console、创建云资源、提交、推送、合并或部署。

## 账号与存储隔离

- 无 `authentication` 配置的端点继续使用原 password 模式，旧 `{ token: password }` 密文、请求摘要及操作回执保持兼容。
- Google 账号要求 username 与 emailAddress 一致，拒绝 password 字段；首次保存为停用、无凭据，授权成功后才允许 IMAP 连接。
- normal 与 Agent 使用不同账号、SMTP、attempt、grant、disconnect 表；同一 owner 下相同 UUID、请求键不会串用状态。
- `google-oauth-target.ts` 持有服务器固定白名单和生命周期的存储适配；SQL 标识符不来自请求、端点或数据库中的供应商输入。
- OAuth 算法继续共用，不复制第二套 token HTTP、PKCE 或刷新状态机。既有 normal facade 默认仍为 normal。
- normal 的 AAD、请求摘要和密文 purpose 保持原值；Agent 的 attempt/grant 使用独立 `agent-google` 标识与 purpose。
  Agent IMAP/SMTP 的加密 grant 引用继续分别绑定其原有凭据域；即使所有 UUID/用户/端点信息相同，跨域移植密文也不能解密。

`0051_agent_google_oauth.sql` 只新增独立 binding、只读账号 view、OAuth 表、索引和触发器；不 ALTER 现有账号表，不改写旧行，
不删除旧回执、同步游标、邮件对象、任务、线程、发送 guard 或自动收件设置。
旧 schema 的 Agent password 路径仍可读写；新增 OAuth 写入要求先应用 0051，不能静默降级成 password。
账号列表/读取按 view 提供明确 authentication，底层父表仍由原账号 writer 拥有。

## 授权与回调

配置继续使用 W10u 的 `APP_ORIGIN`、`GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET`、`MAILBOX_KEYRING` 与固定 Google 端点。
本阶段不另申请 scope、不改变 Google token/userinfo URL、不更新外部平台合同；生产启用仍需核验实际配置及当时的官方要求。
IMAP 固定 `imap.gmail.com:993`；SMTP 复用 `smtp.gmail.com:465` TLS 或显式 `:587` STARTTLS 的既有白名单能力。
Google endpoint 与 password 账号/SMTP 配置不得混用，也不根据字符串前缀猜测认证方式。

| 入口 | 方法 | 权限和语义 |
| --- | --- | --- |
| `/api/v1/agent-accounts/:id/oauth/google/start` | POST | 原 active session、精确 Origin、expectedRevision、原操作键 |
| `/oauth/google/callback` | GET | 同一受限匿名回调，按已存 state 查找唯一服务器 scope；只做同源 303 |
| `/api/v1/oauth/google/complete` | POST | 原 session 同源完成，不接受客户端指定 normal/Agent scope |
| `/api/v1/agent-accounts/:id/oauth/google/status` | GET | 账号归属及 `agent-accounts:read`；只输出非秘密状态 |
| `/api/v1/agent-accounts/:id/oauth/google/disconnect` | POST | session、Origin、版本和原操作键；仅在本地断开 |

state/PKCE、session、owner、账号 revision/flow、配置指纹及 exchange claim/期限共同绑定；一次领取后不重放 code。
跨站回调不依赖 Strict Cookie，根页立即捕获并清除 fragment，验证 `/me` 后同源完成；StrictMode 共享一次完成。
网页由服务器返回的账号 scope 选择 Agent/普通邮箱页面，不依赖浏览器存储推测，也不把 Agent 授权安装到同 UUID 的普通账号。
已退出或换 session 的回调不能安装；API Key 不能发起、完成或断开 Google 授权。

## 收发、自动收件与撤销

- 授权完成会增加账号 revision，清除旧 flow/旧 grant，并关闭、清空 Agent SMTP 引用；SMTP 必须另外保存并启用。
- 原自动收件授权随账号 revision/来源变化暂停；OAuth 完成或重新授权不会替用户自动开启或重新绑定持久授权。
- 常规 token refresh 只增加 grant version，不改变账号 revision；因此不无故使有效的自动收件绑定失效。
- 显式和自动收件共用 Agent claim、容量与 authority；获得 grant fence 后，连接前、stage 和 commit 都复核授权版本。
- 任务和 follow-up 在准备阶段取得 XOAUTH2；只有收到含 grant version fence 的原子 pending 预约确认后才开 SMTP socket。
  明确的 refresh busy 仅在派发前按原队列的有限次数退避，不能在 DATA 后重试。
- 同一 grant 的 IMAP/SMTP 竞争唯一 refresh claim；晚到 exchange/refresh 不能覆盖修改、移除、退出、停用 owner、断开或新授权。
- 旧 writer 也会通过 schema 触发器清除 flow；更换/清空凭据或来源时退休原绑定 grant，不能被旧 flow 恢复。
- 安装 ACK 丢失先读取原 attempt；刷新 ACK 丢失不开 socket，不重新开放旧 claim，也不复用已旋转的旧 refresh token。
- DATA 后 unknown、pending ACK 丢失及终态发送都沿用原永久 guard；重放原键或下一次 cron 不会重新交换 code、刷新后重发或再发 SMTP。
  accepted 只表示服务器接受，不是 delivered；回信头关联也不是发件人认证。

本地 disconnect 同一事务关闭账号和 SMTP、清除加密引用与 grant 秘密、结束未完成 flow、暂停自动收件。
Agent 断开不受历史 disconnect 回执数量门槛阻止；SMTP revision 饱和时仍能清除凭据。
账号 revision 已到安全整数上限时，只允许饱和式撤销，不允许再 start 新授权，防止合法的最后一次授权无法断开。
原键重放返回同一操作，不通过重试生成新授权。

断开明确返回 `remoteRevocation: "not_requested"`，不会调用 Google revoke，也不宣称 Google 端权限已撤销；
必要时用户须到 Google 的第三方连接页面撤权。已经预约并开始的外部操作不能被本地撤销收回。

网页对账号、SMTP、手动同步、自动收件配置及 OAuth 的 dirty/未决状态互锁；未知操作保留原键和原 body，
切换页面不清除未知状态，刷新或退出不持久化、不自动重放 code/token。
Agent 列表、详情、分页和授权返回详情在入状态前校验 scope、kind、认证方式、版本及预期账号 ID；异常响应不覆盖已确认状态。
不会展示 token；正式启用仍须检查边缘/代理/APM 日志是否记录完整 callback query，不能假定外部日志天然无秘密。

## 验证与回退

回归覆盖独立授权、相同 UUID、密文域移植、session/Origin/API Key 边界、迟到 exchange/refresh、自动收件重新绑定、
SMTP/账号 revision 饱和、回执门槛、安装与 refresh ACK、任务/follow-up 预约 ACK、收件提交 ACK、授权 fence 和 DATA unknown。
Chrome 覆盖完整跨站授权、Strict Cookie、单次 finalize、回到 Agent 页面、SMTP/自动收件不默认启用、dirty 锁、原断开键恢复、错误 scope/ID 的 DTO 防线及窄屏。
相关 password、普通 Google、Agent 收发/线程/自动收件回归、typecheck、有效行检查、build、Wrangler 本地迁移与 dry-run 另有独立新收据。
本阶段后端完整运行后仅剩一项过时的 SMTP 端点断言；最终验收重新运行该文件，并严格核验其余生产源码和共享夹具哈希未变。
收据明确区分本阶段通过子项的哈希核验复用与修正文件重跑，不宣称最终候选整套后端重新运行；Chrome 与其他最终检查独立重跑。
它不是全仓、全部供应商或生产业务验收。

回退保留扩展 schema 和旧数据/对象，恢复独立的源码快照；停用旧应用不理解的 Google endpoint，不做 DROP/清表/列回退。
原目录、现行 NAS、旧源码和回滚点都保留。attempt 的有界维护复用 W10u；grant、操作历史和对象 journal 仍会增长，
不宣称长期存储成本已经有界或完成实测。

仍待后续独立完成：真实 Google/供应商授权和真实收投、Cloudflare 测试发布、旧数据迁移演练、容量/费用验证、流量切换和主干合并。
