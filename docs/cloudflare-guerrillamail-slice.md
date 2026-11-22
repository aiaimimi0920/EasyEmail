# GuerrillaMail 公共会话接入（W12d）

将旧 SDK 的 GuerrillaMail 随机邮箱及收件能力迁至 Cloudflare 聚合 Web/API，用户不需要桌面、Userscript 或 NAS。
本地验收以 `guerrillamail-final-v2/verification.json` 的实际 `status` 为准，不等于真实会话/投递、云端发布或整体迁移完成。

## 先核对真实协议，而不是照搬旧网页

2026-10-31 联网读取官方 API 页面、其明确链接的 Google Docs v1.6、条款、About/FAQ 与官方集成博客。
公开原文保存在 `linshi/easyemail-cloudflare-migration-20261028/guerrillamail-contracts/`，没有调用真实邮箱 API 或创建真实会话。

- 官方页面：`https://www.guerrillamail.com/GuerrillaMailAPI.html`，正文仍有 2011 年旧协议。
- 官方指向的较新协议：`https://docs.google.com/document/d/1Qw5KQP1j57BPTDmms5nspe-QAjNEsNg8cQHpAAycYNM/edit`。
- 当前协议使用 `https://api.guerrillamail.com/ajax.php`；`sid_token` 可以替代 Cookie，终端 IP/agent 只建议提供，不再强制。
- 地址不再按 1 小时到期；邮件保留 1 小时与会话约 18 分钟不活跃可能失效是不同概念。不伪造地址期限，也不调用旧的 extend。
- 文档明确欢迎将公共 API 加入自己的应用，但禁止资源过度使用、未授权访问及滥用；不能推导出无限量、任意商业再授权。
- 这是公共 Inbox ID：知道地址/Inbox ID 的人可能读取邮件。平台隔离不是上游私密所有权，随机强熵前缀也不是排他租约。

## 配置与创建

新增 `type: "guerrillamail"`，必须显式 `authentication: "anonymous"` 和非空域名白名单；不读取、不回退平台 Key。
网页选择该类型会选中公共模式，不提供伪造的 API Key 替换输入。平台仍要求登录、Origin、用户归属、独立 API scope 及既有配额。
`baseUrl` 是完整 `https://api.guerrillamail.com/ajax.php`，不是自动猜测的根目录。

域名来自管理员明确配置，不存在已验证的只读域名接口；域名选择和自动选择预检不初始化会话。
应配置该 API 实际返回的规范邮箱域名；不猜测旧 SDK 的未公布 `email_domain` 参数，也不自动把不同域名当作相同收件箱。
返回域名不同会保留未知创建并失败，不向用户报告选中域名成功。私有 site、自定义域名授权和公共域名别名映射尚未接入，不能据此宣称支持。

先预约平台随机地址和原键，再调用一次 `get_email_address` 初始化会话、一次 `set_email_user` 绑定精确随机前缀。
这两个调用都可能创建上游状态；虽然官方允许 GET，它们不是只读操作，只在显式创建的 guard 之后执行。
绑定响应必须匹配完整预约地址，再加密保存 `sid_token`；不采纳返回的其他随机地址或别名，不要求远端具备排他创建语义。
能力目录使用 `session-select`，而不是把它宣传成私密账户创建。
初始化/绑定 ACK 丢失、响应身份不一致、本地落库失败均保留原键 `unknown`，不重新创建、不自动补偿删除。

管理员探测返回 `409 provider_probe_unavailable`，不调用会生成会话/欢迎邮件的 `get_email_address`，不写成功健康或清冷却。
未用真实供应商完成规范域名/会话验收前，不把合成夹具结果当作真实可用证明。

## 收件与持久续页

刷新用 `check_email(seq=0)`，续页用官方 `get_older_list(seq=最小消息ID,limit=20)`。
不把仅用于初始化的 `get_email_list` 当轮询接口，也不猜测其文档中互相矛盾的 10/20 条 offset 页尺寸。

- 每批最多 20 条列表和 20 次详情，加列表最多 21 次 HTTP 读取；单响应 2 MiB、单次读取 15 秒 deadline，不自动重试。
- `count` 作类型/最低数量校验；第一页空列表必须同时为零计数，否则明确失败。较小 ID 空尾页允许保留全局正计数，不据其猜测全局或剩余计数；非空页后保留“继续同步下一页”。
- 消息 ID 使用规范正十进制并按 BigInt 比较，拒绝重复 ID、越过已保存上界或不前进的续页；不接受服务器提供的任意请求 URL。
- cursor 复用 0052，一邮箱一行，与邮件缓存和 revision 同 batch。达到平台 1,000 页边界仍有邮件时明确失败，不截断后谎报完成。
- 新邮件不会挪动已选较小 ID 的边界，但这仍不是事务快照；刷新第一页才能看到后来进入的新邮件。
- 每批列表必须匹配原邮箱；详情必须匹配消息 ID 和完整收件地址。响应带 `auth` 时必须成功。
- 详情 `false` 是文档规定的已缺失邮件，计入 `missing`；协议/HTTP/身份错误整批失败，不覆盖确认缓存。
- fetch 可能改变上游已读状态；平台显式同步本就需要写权限。它不是删除邮件的消费式读取，不调用远端删除接口。

正文根据 `content_type` 分开纯文本/HTML，使用固定 `entities@9.0.0` 解码主题/摘要中的 HTML 实体，保持 Unicode 码点与安全纯文本。
网页仍独立净化、隔离 HTML，不依赖供应商声称的过滤，不加载邮件图片、外部链接或资源。
当前没有经验证的附件元数据/下载合同，不提供该能力，不伪造文件名或下载 URL。

## 会话轮换不是普通缓存提交

每次响应都核对 `sid_token`。先验证邮箱/详情身份和授权，再把同一邮箱的新 Token 加密检查点保存，成功后才用它读取下一封。
新增 `MailReadContext` 可选回调，只有需要轮换的适配器使用；其他供应商不因此增加凭据写入。
检查点校验用户/邮箱、原密文 CAS、同步 lease/期限、暂停/停用/释放/到期和供应商 revision，晚持有者不能覆盖凭据。
只保存协议凭据，不推进同步 revision、cursor 或邮件缓存；随后邮件事务失败时新 Token 仍可重试读取，已确认缓存不变。

如果检查点本身失败，立即停止详情读取，返回 `mailbox_credential_checkpoint_failed`；上游可能已使旧 Token 失效，不能声称已回滚或保证自动恢复。
如果失效会话返回另一个地址，返回 `provider_session_changed`，不安装新凭据、不替换邮箱、不自动调用初始化/绑定接口恢复。
这些失败保留错误和旧缓存，不能用静默重选地址或重新认领公共地址掩盖。

## 支持、回退与未验收边界

支持管理员公共模式配置、随机分配、显式同步、重启续页/会话、聚合、阅读、提码与 Web/API。
不宣称发信、附件下载、自选前缀、地址恢复、远端删除、私有 site 或排他邮箱所有权。
旧供应商配置/hash、密文和数字分页不变；没有 schema 变更。可选回调是内部扩展，不改变现有外部 API 的参数要求。

回退先停止新供应商操作，备份并从运行时配置移除新类型，再回退源码/依赖；仅 `enabled=false` 不能让旧解析器认识新类型。
保留邮箱、邮件、cursor 和未知回执，旧运行时不操作这些新邮箱；不删除表、不清空 guard，也不自动提交、推送、合并或发布。

本地测试覆盖 HTTP 合同夹具、Token 轮换检查点、缓存失败、检查点失败、各项 fence、会话替换、原键未知、双用户、重启与独立 Chrome。
冻结候选重新跑受影响旧供应商及共享同步回归、类型/构建、checker tests/ratchet/strict、本地 52 迁移重复 apply/FK 与 Wrangler dry-run。
不是全仓或全部 Agent/OAuth 重跑；真实 API、规范域名、真实邮件、云端网络/成本、数据迁移和生产切流仍待验收。
