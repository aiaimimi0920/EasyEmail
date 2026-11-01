# W10a：普通邮箱账号、凭据与只读连接检查

本切片是普通邮箱迁移的基础，不是完整普通邮箱迁移完成。实现在 `service/cloudflare`，新增 `0023_normal_accounts.sql`。
不依赖 Windows 凭据库、桌面 Rust、Node 常驻进程或 NAS bridge；旧源码与现行服务保持原样。

## 数据所有权与兼容

- `normal_accounts` 是用户私有外部邮箱配置，不占用临时邮箱的全局地址分配索引；不同用户可独立配置同一外部邮箱地址。
- 不修改旧 `mailboxes`、`messages`、草稿、发送 guard 或已有 API Key；不会根据旧 opaque reference 猜造密码。
- 账号每次配置变更增加 revision；停用、忘记凭据和移除均使在途连接结果失效。
- 密码以现有 AES-GCM keyring 保存，AAD 绑定用户、账号和独立 `ee-normal-account-v1` purpose，不在 API/日志中回显。旧邮箱默认 AAD 保持原始字节兼容。
- 幂等请求使用 HKDF 派生 HMAC，避免在回执中保存可离线猜测的普通密码哈希。原请求键重放只返回回执和当前账号，不重写后续版本。
- keyring 轮换须保留旧 key，直到不再需要解密旧凭据或核对对应回执。缺 key 明确失败，不猜测或换键重放。

## API 与权限

路径前缀 `/api/v1`。网页登录会话的写操作仍要求精确 Origin；API Key 不要求浏览器 Origin，仍独立校验 scope 和 owner。

| 接口 | 行为 | scope |
| --- | --- | --- |
| `GET /normal-accounts/endpoints` | 部署方允许的服务器列表 | `mail-accounts:read` |
| `GET /normal-accounts`、`/{id}` | 私有配置、分页、版本及上次检查状态，无密码/密文 | `mail-accounts:read` |
| `PUT /normal-accounts/{uuid}` | expectedRevision=0 创建；否则 CAS 编辑，可轮换或忘记凭据 | `mail-accounts:write` |
| `DELETE /normal-accounts/{id}` | CAS 移除平台配置与密文，保留最小墓碑/回执，不操作服务器邮件 | `mail-accounts:write` |
| `POST /normal-accounts/{id}/test` | 指定 expectedRevision 的只读认证与 INBOX 检查 | `mail-accounts:sync` |

PUT/DELETE 必须携带稳定 `Idempotency-Key`。PUT 字段为 expectedRevision、emailAddress、displayName、endpointId、username、enabled、可选 password/forgetCredential。
新账号需要密码；编辑省略密码表示保留原凭据。忘记凭据必须关闭连接，且不能同时传新密码。
DELETE 只接受 expectedRevision。旧 Key 不自动获得以上权限。

当前每用户最多20个未移除账号、100个包含墓碑的账号；账号变更每分钟10次。连接检查每用户每分钟5次、平台30次。
请求沿用8 KiB JSON上限，用户名最多255字符、应用密码最多1024字符；拒绝控制字符、不完整 Unicode、未知字段与任意主机输入。

## 出站连接与安全边界

部署变量 `IMAP_ENDPOINTS` 是最多20项的 JSON 数组：

```json
[{"id":"gmail","label":"Gmail","hostname":"imap.gmail.com","port":993}]
```

默认空数组，不自动启用任何真实账户。每项严格限制 id、label、hostname、port；只允许公开格式的完整域名和993端口，拒绝 IP、URL、私有后缀和非 TLS 端口。
用户只能选择 endpointId，不能提交 hostname/port。连接始终 `secureTransport:on`、`allowHalfOpen:false`；不提供跳过证书验证或明文降级开关。
账号保存 endpoint 身份哈希，部署方修改目标主机/端口后必须显式重新保存账号才可连接，防止将旧凭据自动交给新目标。
生产 Workers 自身还会拦截私网/loopback/Cloudflare IP；本地模拟不能作为其生产 SSRF 行为证明。

连接检查仅执行 CAPABILITY、AUTHENTICATE PLAIN、EXAMINE INBOX、LOGOUT；应用密码通过 TLS 内 SASL PLAIN 交换。
不执行 SELECT、FETCH、STORE、MOVE、EXPUNGE 或 SMTP，不读取邮件正文，不设置已读。
仅 AUTH=PLAIN/隐式 TLS 993 已实现；OAuth2/XOAUTH2、STARTTLS、其他端口及多文件夹同步留待后续迁移，不声称所有普通邮箱均可用。

单次网络检查15秒总时限，关闭最多另等1秒；响应累计64 KiB、单行8 KiB、每命令100条响应上限；拒绝意外 literal、裸换行、错误 tag、重复认证挑战及重复/非法 UIDVALIDITY、EXISTS，EXAMINE必须明确READ-ONLY。
只存受控错误码，不保存服务器原始拒绝文本或认证交互。连接失败不会删除账号或自动重试。

## 并发与网页

连接检查通过D1领取45秒 lease。最终结果同时检查 claim token、lease、账号 revision/启用状态和用户 active；旧执行者不能写入后续版本。
失败清理只释放自己的 lease；有效检查失败时清除上次成功的 INBOX 信息，避免失败状态仍显示旧成功结果。用户已停用或 lease 失效时，不写晚到的 testedAt/error/INBOX 身份。响应明确关联 accountRevision。
配置与回执同一事务，失败不产生半个配置；未知提交用原键核对，不另起写操作。

Web提供新增/编辑/停用、只写密码、忘记凭据、移除、服务器选择和连接检查。
保存丢响应后锁定原正文/原键；导航及随后429不丢原操作。密码不进入 localStorage/sessionStorage，成功保存后输入清空。
连接成功明确显示“尚未同步邮件”；INBOX数量是 EXAMINE 元数据，不是已抓取或已缓存数量。
表单存在未保存修改时禁止连接检查，避免使用旧凭据的成功结果被误认为新密码已通过。

## 验证、升级与回退

先应用0023，再启用新运行时。旧服务可继续使用旧表；回退暂停普通邮箱写入/连接并保留新表，不自动删除账号、凭据或回执。
合成 workerd 测试通过构建期替换 TCP transport 驱动生产协议与路由；生产源码不包含测试 URL、fixture binding 或替代传输开关。
它证明本地合同，不证明真实账户可登录。W9 的无凭据公共 IMAP TLS/CAPABILITY 探针也不代替本切片的真实认证验收。

后续必须继续实现：带 UIDVALIDITY/UID 的收件身份与有限同步、正文与附件、聚合工作台接入、远端状态与授权SMTP/OAuth2；以及独立真实 Cloudflare 边缘与邮箱账户验收。
W10b 的内部 reader 和 MIME 基础见[读取切片](cloudflare-normal-read-slice.md)；连接测试仍不读取正文，不把内部读取能力冒充已经持久化同步。
所有生产配置、凭据导入、部署、发信和切流均不在本次本地开发操作中。
