# Cloudflare 聚合平台身份切片

## 当前实现边界

代码位于 `service/cloudflare`，是独立的 Workers HTTP 入口与 React 网页。
它不依赖 Tauri、Userscript、原 Node server 或 NAS；没有连接生产数据库。
自营邮箱供应商与聚合平台的用户表、会话及密钥不共享。

M1 采用用户名、密码和邀请口令注册。用户名不表示邮箱所有权，
目前没有邮箱验证、找回密码、OAuth 或 MFA；M3m 增加用户管理与自行改密码，
范围及并发/升级限制见 [账号管理切片](cloudflare-account-slice.md)。
未配置注册口令，或者少于 32 个字符时，注册关闭；已有用户仍可登录。
公开注册、账号恢复及上线前的边缘防滥用另行实现和验收。

## 身份与凭据

- 密码使用 Workers 原生 `node:crypto.scrypt`，参数 `N=16384, r=8, p=5`、
  随机 128-bit salt、256-bit 输出，存储算法版本及固定参数。
  这是 OWASP 为约 16 MiB 内存列出的 scrypt 最低配置之一，不是普通 SHA-256 密码哈希。
- Workers 官方暂不提供原生 Argon2。选择 scrypt 是运行时约束下的标准 KDF，
  不以降低 PBKDF2 迭代次数或自制串联算法绕过限制。
- 会话和 API Key 各使用 256-bit 随机秘密，只在数据库保存 SHA-256 摘要。
  对高熵随机凭据使用摘要和对低熵用户密码使用 KDF 是不同边界。
- 浏览器凭据保存在 `__Host-ee_session`，`Secure; HttpOnly; SameSite=Strict; Path=/`。
  固定七天过期，退出立即在数据库撤销，每用户至多保留二十个会话。
- 所有浏览器写入校验精确 `Origin`；除 loopback 本地开发外，配置必须为 HTTPS。
  API Key 不使用 Cookie，不允许管理 Key 或退出浏览器会话。
- API Key 完整秘密只在创建响应显示一次，列表只返回前缀及元数据；
  默认三十天，最大九十天，每用户最多二十个有效 Key。M1 只有 `mailboxes:read`；
  M2 新增独立的 `mailboxes:write` 与 `messages:read`，M3a 新增 `messages:write`，
  M3b 新增独立的 `messages:send`，M3c 新增 `attachments:read`；已有 Key 不自动扩权。
- M3d 新增 `messages:delete`、`mailboxes:delete`，分别用于清理平台缓存和释放平台访问，
  不隐含远端删除或读取权限，详见 [生命周期切片](cloudflare-lifecycle-slice.md)。
- 不在 localStorage/sessionStorage 存储凭据；错误日志只记录随机 request ID 和错误分类。

原生 KDF 仍有 CPU 成本。本地耗时不等于云端 CPU 计费或免费套餐适用性。
生产发布前必须实测 Workers 付费 CPU 预算、并发内存、登录负载及边缘限流；
不能声称本切片已通过免费 Workers 10 ms CPU 预算验收。

## D1 所有权与生命周期

迁移文件：`service/cloudflare/migrations/0001_identity.sql`。

| 表 | 数据所有权与约束 |
| --- | --- |
| `users` | 平台账号，用户名唯一；禁用后会话与 Key 均不可用 |
| `sessions` | 摘要、所属用户、创建/过期/撤销时间；每次认证联查有效用户 |
| `api_keys` | 所属用户、摘要、scope、过期及撤销状态；原子语句限制有效数量 |
| `mailboxes` | 用户资源归属与供应商引用；M2 增加加密凭据，M3a 增加平台整理字段，不返回密文或秘密 |
| `auth_rate_limits` | 持久化固定分钟计数；subject 使用摘要，不记录原 IP |

每次查询和撤销均在 SQL 中带 `user_id`。跨用户与不存在的资源均为 404。
邮箱、Key 和单邮箱消息列表按随机 UUID 字典序做 keyset 分页，limit 为 1–100，游标仅用于继续遍历，
不是时间顺序或一致性快照；并发新增资源可能需要刷新。

没有通过公开地址绑定或恢复邮箱的接口。M1 的 `synthetic-fixture` 仅验证元数据隔离；
M2 已加入分配、加密凭据、显式同步及消息归属，详见 [收件切片](cloudflare-mail-slice.md)。
本地供应商 HTTP fixture 仍不能证明真实线上邮箱创建或真实收信。

认证入口限制每 IP 每分钟三十次、每账号每分钟五次；
已认证请求每用户每分钟一百二十次。固定窗口边界允许短时突发，
这些应用计数不能代替上线时 Cloudflare 边缘防滥用与成本保护。
每十五分钟的 scheduled handler 分批清理过期会话和限流计数，单表单次至多五千条。
Key 撤销元数据保留；更完整的数据保留和审计策略尚待后续切片。

## HTTP 接口

所有 `/api/v1` 错误返回 JSON `{ "error": { "code": "...", "requestId": "..." } }`，
不回落到 SPA HTML。JSON 请求体最大 8 KiB，包括没有 Content-Length 的流式请求。

| 方法与路径 | 权限/行为 |
| --- | --- |
| `POST /api/v1/auth/register` | 精确 Origin、用户名、密码及邀请口令；原子注册与创建会话 |
| `POST /api/v1/auth/login` | 精确 Origin、用户名和密码；Cookie 会话 |
| `POST /api/v1/auth/logout` | 会话、精确 Origin；立即撤销当前会话 |
| `POST /api/v1/account/password` | 会话、精确 Origin、验证当前密码；修改后撤销全部会话和 Key |
| `GET /api/v1/me` | 会话或有效 API Key；返回身份及凭据种类 |
| `GET /api/v1/api-keys` | 仅会话；元数据分页 |
| `POST /api/v1/api-keys` | 仅会话、精确 Origin；name、scopes、可选 expiresInSeconds |
| `DELETE /api/v1/api-keys/:id` | 仅会话、精确 Origin；当前用户的 Key，撤销可重复 |
| `GET /api/v1/mailboxes` | 会话或 `mailboxes:read`；归属分页 |
| `GET /api/v1/mailboxes/:id` | 会话或 `mailboxes:read`；归属校验 |
| `GET /healthz` | 仅进程存活，不宣称数据库、供应商或业务可用 |

程序使用 `Authorization: Bearer <API_KEY>`，不需要 Origin。
存在可见但无效的 Authorization 时不会回退到 Cookie；中间代理可能将空头规范化为缺失，
空头本身不是有效认证。未开放 CORS，不向其他站点放行浏览器凭据。

Web 的 M1 账号与元数据能力保留；M2 新增供应商选择、随机邮箱分配、同步、缓存文本阅读、
新鲜度提取及 Key 权限选择。旧桌面源码仍保留作迁移参考。
M3a 增加邮箱 metadata PATCH、消息状态 PATCH 和时间倒序的跨邮箱缓存查询，
权限与游标合同见 [整理切片](cloudflare-workspace-slice.md)。
M3b 新增基础写信/回复及发送历史，默认关闭，详见 [发送切片](cloudflare-send-slice.md)。
M3c 的安全 HTML、独立附件权限、下载与兼容边界见 [正文与附件切片](cloudflare-content-slice.md)。

## 公开依据

以下资料已于 2026-10-28 联网核对，并以本地 workerd 及独立 Node KDF 对照验证实现：

- [Cloudflare node:crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [D1 local development](https://developers.cloudflare.com/d1/best-practices/local-development/)
- [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
