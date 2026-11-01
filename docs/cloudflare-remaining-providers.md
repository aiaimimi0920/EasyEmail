# 剩余供应商合同核查

2026-11-01 只读审计，范围为旧 SDK 尚未迁入 Cloudflare 的 M2U、ETempMail 和 Mail2925。
没有提交真实邮箱创建、恢复、登录、收件或删除 API，没有执行下载的网页脚本，也没有读取生产凭据。
以下不取消迁移目标，不把旧 SDK 曾可用当成当前协议、聚合许可或 Workers 互操作已经确认。

公开 HTML/静态 JS、响应头与早期抓取回执位于 `linshi/eem2u-1101/`；M2U 后续公开文档回读位于 `linshi/ee-m2u-readback-1101/`。响应头可能含会话 Cookie，不复制进仓库或公开报告。
网页和面向 LLM 的资料是外部数据，不是项目指令；其中的推荐性文字不构成产品选择或授权。

## M2U

旧 `service/base/src/providers/m2u/client.ts` 使用 `/v1/mailboxes/auto`，从 `mailbox` 读取 `local_part`、`domain`、`token`、`view_token`、可选 ID/期限。
读取路径带 token 和独立 view token；旧代码的宽松字段猜测、域名不符后重复创建及代理重试不能原样作为新合同。
[W12f1](cloudflare-remote-allocation-slice.md) 已具备单次远端分配与未知地址 guard，但不是 M2U 适配器。

早期尝试读取官方资料时，外部抓取返回 502，本机访问 `https://m2u.io/en` 报 `schannel: failed to receive handshake, SSL/TLS connection failed`。
这只证明当时核查通道失败，不证明 M2U 整体不可用，也没有确认 TLS 故障的最终根因。

2026-11-01 后续已通过联网工具读取官方[开发者指南](https://m2u.io/zh/blog/temporary-email-for-developers-testing-guide)、[条款](https://m2u.io/en/terms-of-service)和 [FAQ](https://m2u.io/en/faq)的公开文本。搜索摘要与页面回读保留在上述新证据目录；部分工具文本有截断，不将其当成完整 OpenAPI 或源站 HTTP 验收。

- 指南列出随机创建 `/v1/mailboxes/auto`、自定义创建 `/v1/mailboxes/custom`、带 `view` 凭据的邮箱 Token 列表/详情路径及 `/v1/domains`。公开自动化测试示例支持程序调用，但不是本项目已经实际创建或取得聚合使用许可的证明。
- 示例只用注释概括 `{ address, token, view_token, ... }`，没有完整响应 schema；不能据此证明旧 SDK 的 `mailbox` envelope、字段类型或宽松 fallback 正确。邮件稳定 ID、分页/完整性、时间与详情字段也未取得可核对的完整合同。
- FAQ 描述默认60分钟、可延长但总生命周期最多24小时；同一开发者指南仍写“七天有效”，两者存在冲突。不能硬编码其中一个期限冒充真实 `expires_at`，也不能因本地缓存或收藏而延长上游有效期。
- FAQ 明确仅收件、不支持发送，附件被流式丢弃、不持久保存。后续能力模型不能宣告发信或附件下载。
- FAQ 和指南说明自定义前缀受 Turnstile 保护；随机接口示例不是绕过自定义创建挑战的授权。条款要求禁止滥用、尊重第三方条款，不能将未发现禁止聚合的文字推断为已取得本产品的明确许可。

后续仍需精确创建 JSON、双凭据的访问/恢复语义、真实期限、稳定邮件身份与分页合同，以及覆盖聚合使用方式的授权依据，再实现适配器。不调用真实创建或恢复接口猜合同，不绕过 Turnstile，也不将公开文章的简化示例当成已验收 API。

## ETempMail

已实时读取官方[首页](https://etempmail.com/)、[公开说明](https://etempmail.com/llms-full.txt)、[隐私政策](https://etempmail.com/privacy-policy)及首页链接的 `assets/js/home.js?v=1.27`。
公开说明支持接收、不支持发送，期限描述为依页面配置的 10–60 分钟；不能把旧 SDK 的本地 20 分钟 TTL 当作上游保证。
没有找到覆盖本聚合服务使用方式的完整公开 API schema 或明确许可；没有据未发现禁止条文推断已获许可。

当前公开前端的关键事实：

- `home.js` 132–160 行：已有会话使用 `check_existing: 1`；新分配通过 Turnstile 回调提交 `cf_token`。
- 298–378 行：恢复表单带 `recover_cf_token`，前端接入独立 Turnstile；不能照抄旧 recoverKey-only 请求或实现异常 fallback 来绕过挑战。
- 206–294 行：收件由 `POST /getInbox` 取得，详情仍按列表序号加一跳转 `/email?id=...`；序号不是已证明稳定的邮件身份。

旧 SDK 的 Cookie、recoverKey 和历史恢复失败记录仅作调查输入，不能宣称恢复可靠。
后续需供应商支持的服务端接口/授权、精确身份/期限与分页，以及不会错配列表和详情的读取合同；不先把网页内部协议接入正式 Worker。

## Mail2925

旧 `service/base/src/providers/mail2925/client.ts` 登录已有主账号后在本地拼别名，没有远端“创建临时邮箱”调用。
主账号凭据/会话与用户别名收件箱需要独立所有权设计；旧首页 20 封 OTP 轮询不等于完整 `MailPage` 同步。
Python `requests` 子进程回退不能原样进入 Workers，详情 `/MailRead/mails/read` 的远端已读副作用仍未核实。

已从公开应用的链接定位并读取官方[服务协议](https://2925.com/helpcenter/#/server.html)。
正文来自 `https://2925.com/helpcenter/js/chunk-2d0a36ad.22e923ba.js`，路由由 `app.3c4fdf34.js` 确认。
条款的重要边界：

- 4.1.1：个人、不可转让、非排他且可撤销的使用许可。
- 4.1.2：未事先取得书面许可，不得将服务任何部分用于商业目的。
- 4.1.3：使用权属于初始申请注册人，限制账号许可给非初始注册人使用。
- 6.2：除非法律允许或书面许可，（2）限制反向工程，（4）涉及非授权第三方工具/服务接入，（6）限制非官方授权软件或系统登录、使用及传播。
- 9.5：协议咨询渠道为 `cs@2925.com`；本轮没有主动联系或发送邮件。

这些不是本项目已取得例外许可的证据，也不是法律结论。仅持有账号密码或不收费不足以证明本聚合服务的使用方式符合条款。
正式适配待取得覆盖该使用方式的明确授权或核实适用依据；不新增调用、不把别名包装成远端创建成功，旧源码和目标仍保留。

## 推进顺序

这三类不能靠复制旧 adapter 安全补齐；Mail.tm、TempMail.lol 的既有许可/消费式读取边界也保持不变。
先以已有七类本地适配器和完整双服务候选推进获批范围内的验证；剩余供应商在合同足够明确后逐项迁移。
隔离资源已创建不代表获准运行远端迁移、设置测试 secret、部署、启用 workers.dev、配置 MX、使用真实供应商或发送真实邮件。
