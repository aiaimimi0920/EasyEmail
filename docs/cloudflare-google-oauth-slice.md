# Google 邮箱 OAuth 纵向切片（W10u）

## 范围与状态

在 `migration/cloudflare-web` 中，将 W10t 的内部 XOAUTH2 接缝接入网页授权、公共 API、加密凭据、刷新、IMAP 检查与同步、SMTP 发送。
不要求安装客户端，不提供手工粘贴 token 的替代入口。普通密码账号及原 `{ token: password }` 密文格式保持兼容。
本切片的验证状态以 `google-oauth-final5/verification.json` 的实际 `status` 为准；文档本身不是测试收据。
最终证据沿用 `google-oauth-final4` 的 358/358 后端结果，并逐文件核对后端及依赖哈希未变；之后仅修正两份浏览器测试和本文。
相关浏览器测试、其余检查及构建在 final5 重新执行，来源记录见 `runtime-evidence-reuse.json`；不宣称 final5 重新执行了后端。

没有读取生产凭据、配置 Google Console、创建云资源或部署。Google 页面、token/userinfo 和邮件服务器均为隔离合成对端；
本地 workerd、D1、R2、HTTP、Chrome 实际运行，不等于真实 Google 登录、真实 TLS 或公网投递验收。

## 配置与使用

部署方须创建 Google 的 **Web application** OAuth client，配置精确回调地址：

```text
https://<APP_ORIGIN 的主机>/oauth/google/callback
```

`APP_ORIGIN` 必须为精确 HTTPS origin；只对本地 loopback 开发允许 HTTP。
`GOOGLE_OAUTH_CLIENT_ID` 为配置，`GOOGLE_OAUTH_CLIENT_SECRET` 使用 Worker secret；仍需正确配置 `MAILBOX_KEYRING`。
本地占位变量见 `service/cloudflare/.dev.vars.example`，不得把真实秘密提交到源码或 `wrangler.toml`。

示例 endpoint 配置（仅示例，不自动写入实际部署）：

```json
{
  "IMAP_ENDPOINTS": [{"id":"google","label":"Google","hostname":"imap.gmail.com","port":993,"authentication":"google-oauth2"}],
  "SMTP_ENDPOINTS": [{"id":"google","label":"Google SMTP","hostname":"smtp.gmail.com","port":465,"recipients":["*"],"authentication":"google-oauth2"}]
}
```

SMTP 也支持固定 `smtp.gmail.com:587` 配合显式 `security: "starttls"`；不允许明文认证、25 端口或自选 Google token URL。
`recipients:["*"]` 仅用于说明配置结构，正式环境宜按现有发送策略收紧收件人范围。
未声明 authentication 的 endpoint 始终为原 password 模式；不依据密码或 token 字符串的前缀猜测。

网页选择 Google endpoint，填写相同的邮箱地址和用户名，无密码创建停用账号；确认保存后再点击授权。
Google 返回的已验证邮箱必须与此地址一致。成功后启用收件，但 **SMTP 仍须用户单独保存配置并启用**，不自动发信。
API Key 可以按原 scope 使用已授权账号的收件/发送能力，但不能发起、完成或断开网页授权。

## API 与数据所有权

| 入口 | 方法 | 权限及语义 |
| --- | --- | --- |
| `/api/v1/normal-accounts/:id/oauth/google/start` | POST | 原 session、精确 Origin、`expectedRevision`、`Idempotency-Key`；回 JSON authorizationUrl |
| `/oauth/google/callback` | GET | 匿名受限入口；只固定 303 到同源根 fragment，不交换 code |
| `/api/v1/oauth/google/complete` | POST | 原 session、精确 Origin、state 与 code 或 denied；一次交换并绑定 |
| `/api/v1/normal-accounts/:id/oauth/google/status` | GET | 账号归属及 `mail-accounts:read`，只返回非秘密状态 |
| `/api/v1/normal-accounts/:id/oauth/google/disconnect` | POST | session、Origin、版本及原操作键；仅本地断开 |

0038 为扩展迁移：旧账号 authentication 默认 password，新增 grant/flow 引用及独立 attempts/grants/disconnect receipts；
不改写旧列、密码密文、同步检查点、邮件对象、草稿、发送 guard 或 SMTP 密文。
OAuth 的账号/SMTP 密文只保存加密 grant 引用；access/refresh tokens 仅保存在独立 AAD 绑定的加密 grant 中。
旧 runtime 不理解引用，不会把 refresh token 当密码发出；回退仍须移除其不支持的 Google endpoint 配置。

## 状态、并发和模糊失败

- state 与 PKCE verifier 各 32 随机字节，仅 S256；attempt 绑定用户、原 session、账号 revision、配置指纹、固定 redirect 与十分钟期限。
- `pending → exchanging → completed/failed` 使用 D1 原子领取。交换模糊失败、过期或丢失 DB 确认不重新开放相同 code。
- 安装时重新核验 active user、原会话未撤销/过期、账号 revision、当前 flow、claim 和期限；旧 flow 不能覆盖新授权。
- 主 session 保持 `SameSite=Strict`。callback 不依赖跨站 Cookie；根页模块立即捕获并清除 fragment，经 `/me` 后由原 session 同源完成。
- StrictMode 共享单次逻辑完成，后端仍独立防重复；未登录或换 session 不能把原 code 安装到新身份。
- Google HTTP 使用固定 HTTPS URL、form 编码、16 KiB 响应上限和共享十秒 deadline；手动接收并拒绝重定向，无自动重试。
- access token 剩余不足 90 秒时，由 grant version/claim/lease 的唯一 owner 刷新；不改变账号逻辑 revision。
- 刷新成功可旋转 refresh token；未返回新 refresh token 时保留旧值。失败或 lease 模糊过期转 reauthorize，不能循环重用旧 token。
- 刷新写回及 SMTP 预约均有 grant fence；修改、删除、断开或重新授权后，晚到响应不能复活旧凭据或清掉新 grant。
- 发信 guard 先 replay；DATA 后 unknown 不触发 OAuth 重试或 SMTP 重发。accepted 仍不是 delivered。
- 表单 dirty、草稿、上传、队列、原键未决或未知发送时，不得通过授权外跳销毁恢复状态。

十五分钟维护清除到期 attempt 的秘密，封闭过期 refresh claim；终态 attempt 在到期 24 小时后回收，
因此 start/complete 的恢复窗口有界。disconnect 与邮件发送的持久操作回执不据此删除。
Google grant 及断开回执仍有历史增长，当前不是无限期成本已验收的实现。

## 仅本地断开，不冒充远端撤销

断开事务停用 IMAP/SMTP、清除平台令牌与引用、增加版本、终止未完成 flow；回执明确 `remoteRevocation: "not_requested"`。
它 **不调用 Google revoke**，也不宣称 Google 账号的应用权限已撤销。用户若需撤销，应到 Google 账号第三方连接管理页面操作。
这样避免后台旧 revoke 晚到后误撤较新的授权；远端撤销及其未知结果恢复仍是独立未完项。
已经预约并开始的外部邮件操作不能被本地断开撤回；晚到提交仍受原版本/guard 约束。

## 验证与回退

回归覆盖真实 HTTP 会话、state/PKCE、重复及并发完成、同用户不同 session、用户退出、账号修改、新 flow、断开、过期 owner、
scope/身份校验失败、受限 HTTP、refresh 旋转及 CAS、晚到 refresh、IMAP/同步/SMTP 与 DATA unknown；
Chrome 覆盖跨站回调的 Strict Cookie、fragment 清除、单次 finalize、未登录、SMTP/草稿/未知发送锁与本地断开。
密码、SMTP、同步、草稿、回复、附件、队列、保留与容量回归仍须随最终收据逐项核对，不以一条 OAuth 成功代替全仓通过。

历史 schema 测试用旧格式夹具建立旧数据，避免让新 writer 操作故意尚未升级的旧表；
对冻结列结构做精确比较的旧测试固定截至 0037，0037→0038 另逐列核验所有旧表数据、密码 AAD 与对象保留。

回退保留扩展后的 schema，不执行 DROP、列回退或数据清空；按独立源码快照恢复应用，并移除旧应用不理解的 Google 配置。
原目录、原服务和原镜像继续保留；本轮不提交、推送、合并或部署。
上线前仍需单独完成 Google Console/同意屏与受限 scope 审核、实际用户授权、刷新/撤销、真实 TLS/收投、成本及迁移数据验收。

## 官方合同

- https://developers.google.com/workspace/gmail/imap/imap-smtp
- https://developers.google.com/workspace/gmail/imap/xoauth2-protocol
- https://developers.google.com/identity/protocols/oauth2/web-server
- https://accounts.google.com/.well-known/openid-configuration
- https://developers.google.com/identity/protocols/oauth2/resources/best-practices

代码自身只输出脱敏错误；Google 的 code 必然短暂经过回调 query 和同源 fragment，应用随后清除 fragment。
正式启用前必须检查边缘访问日志、APM 和代理日志是否记录完整 callback query，不得宣称所有外部日志天然没有 code。
