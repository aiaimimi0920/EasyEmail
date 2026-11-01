# W10l 普通邮箱授权直接发信

本阶段在 `migration/cloudflare-web` 上扩展普通邮箱 Web/API，不依赖桌面、Userscript、NAS 或实际邮箱密钥。范围是独立 SMTP 应用密码、纯文本 To/CC/BCC 直接发送，以及持久发送记录与原键核对。不是生产部署或真实投递验收。

## 部署合同与协议边界

先应用扩展式 `0031_normal_send.sql`，再启动新 Worker。旧代码可继续使用旧表，但回滚旧程序后必须暂停新 SMTP 入口；不可删除新表中的幂等守卫。不得把回滚理解为撤销已被 SMTP 接受的邮件。

管理员以 `SMTP_ENDPOINTS` 提供至多 20 个服务器：

```json
[{"id":"example","label":"Example SMTP","hostname":"smtp.example.com","port":465,"recipients":["*"]}]
```

白名单只接受公共 DNS 名称、465 implicit TLS，必须显式配置接收地址列表或单独的 `*`；用户不能指定 hostname、端口、安全模式或 From。Workers TCP 官方文档已联网核实：默认禁止 25，拒绝 localhost、私网和 Cloudflare IP，socket 应在 handler 内创建。是否能连接某个实际服务、证书与供应商策略，仍需独立实际验收。

协议限 AUTH PLAIN（必须由 EHLO 声明）、ASCII envelope、UTF-8 subject/text；SMTP 连接与交互合计 15 秒，清理等待至多 1 秒。响应行、多行次数和总字节均有界。所有 RCPT 都成功才提交 DATA；Bcc 仅进 envelope，不写 MIME header。MIME 使用折行的 UTF-8 encoded-word 与 base64 正文。

不支持 587/STARTTLS、LOGIN、OAuth2、SMTPUTF8、HTML、附件、普通云草稿、回复关联、队列/定时发送、自动保存 Sent 或自动重试。请求携带尚未支持的意图直接拒绝，不静默降级。

## 账号、凭据、并发与结果

SMTP 凭据使用独立 AES-GCM context，绑定 user/account/purpose，不沿用 IMAP 密码。账号版本、SMTP 用户名或 endpoint 身份变化时必须重新提供密码才能启用发送。普通账号移除或忘记 IMAP 凭据，在同一 CAS batch 内清空 SMTP 凭据并禁用 SMTP；单独忘记 SMTP 不清空 IMAP。

SMTP 配置有自己的 revision、带密钥的请求摘要和最小幂等回执，每用户至多 10,000 个回执。发送守卫按 user/requestKey 唯一，摘要包含源账号及双方版本、完整收件列表和正文。先以一个 SQL 写预约，原子核对 active user、账号归属/版本/状态、SMTP 版本/凭据/endpoint 与共享配额，然后才开 socket。并发相同请求只发送一次；同键不同意图返回 409。临时邮箱和普通邮箱共用 recipient 配额，不通过分两套 owner 表绕过限制；拒绝和 unknown 都计费。

DATA 开始前的失败可证明正文未提交；提交后的断连、超时或非法响应为 unknown。明确最终 4xx/5xx 为 rejected，最终 250 仅代表服务器接受，不能声称已投递。写回失败仍保留 durable pending 守卫，超过 60 秒视为 unknown，定时维护只标记，不重发。每用户最多 10,000 个永久发送守卫；达到上限需另行规划归档，不能直接删除防重记录。

Web 未确认发送保持原 path/body/key，核对按钮只 GET；记录不存在才允许显式以原键提交。另起邮件必须确认重复投递风险。SMTP 配置 unknown 使用原键回放，确定首次 4xx 可修正；独立刷新按钮能恢复外部 revision 冲突。工作台切换不卸载操作状态，不把密码放入 localStorage/sessionStorage。

## API

- `GET /api/v1/normal-accounts/smtp-endpoints`：可选服务器的 id/label。
- `GET|PUT /api/v1/normal-accounts/{accountId}/smtp`：独立 SMTP 配置；PUT 带 `Idempotency-Key`、`expectedRevision`、`smtpRevision`、`endpointId`、`username`、`enabled`，密码变更提供 `password`；忘记时关闭 enabled 并设置 `forgetCredential`。
- `POST /api/v1/normal-accounts/{accountId}/send`：`Idempotency-Key`、`expectedRevision`、`smtpRevision`、`to`、可选 `cc/bcc`、`subject/text`。新 scope `mail-accounts:send`，不会扩大原 `messages:send` 或普通账号配置 Key。
- `GET /api/v1/normal-accounts/{accountId}/outgoing?requestKey=...`：只读核对单次原发送；不带 key 时分页列表。需 `mail-accounts:read` 与 `messages:read`。账号移除后其私有历史守卫仍可核对。

定时维护按现有 outgoingDays 策略每次最多脱敏 100 条普通发送正文，保留 request hash、key、状态与配额人数。当前管理员手动维护预览/运行计数仍只覆盖旧 outgoing 表，不包含此独立的普通发送定时脱敏；该计数整合留给后续阶段，不能据旧预览声称已扫描所有普通发送。

本地验证采用合成 SMTP transport、实际 workerd/D1 和 Chrome；相关测试、有效行检查、构建、源码稳定性、原项目保留及独立 Wrangler 证据见 linshi 的 normal-send 阶段回执。没有真实发信、发布、合并或提交。
