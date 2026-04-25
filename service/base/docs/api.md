# EasyEmail HTTP API

此文件用于整理 `EasyEmail` 当前**对外提供**的 HTTP API。

实现入口：

- `src/http/contracts.ts`
- `src/http/handler.ts`
- `src/http/server.ts`
- `src/http/routes/public.ts`
- `src/http/routes/admin.ts`
- `src/http/routes/internal.ts`

## 统一鉴权规则

`EasyEmail` 只有**一层 Bearer token 鉴权**：

- 如果 `/etc/easy-email/config.yaml` 中配置了：
  - `server.apiKey`
- 那么所有路由都要求：
  - `Authorization: Bearer <api-key>`

如果 `server.apiKey` 为空，则服务在本地 dev 场景下可无鉴权访问。

> 注意：
>
> - `public/admin/internal` 只是**逻辑分组**，不是三套不同鉴权系统。
> - 当前没有额外的 `x-admin-auth` / second-factor 逻辑。

---

## 一、Public Routes

适合调用方直接使用的 mailbox 主链接口。

| Method | Path | 用途 |
| --- | --- | --- |
| `GET` | `/mail/catalog` | 获取 catalog：provider types、instances、runtime templates、strategy profiles 等 |
| `GET` | `/mail/snapshot` | 获取当前完整运行时快照 |
| `POST` | `/mail/mailboxes/plan` | 只做 plan，不真正打开邮箱；可同时返回 alias 规划结果 |
| `POST` | `/mail/mailboxes/open` | 打开邮箱 session，返回 session / instance / binding；可附带 alias 结果 |
| `POST` | `/mail/mailboxes/recover-by-email` | 按邮箱地址从 EasyEmail 本地持久化 state 中恢复已有 mailbox session |
| `POST` | `/mail/mailboxes/report-outcome` | 回报 mailbox outcome，用于 provider 健康度 / cooldown / 失败反馈 |
| `POST` | `/mail/messages/observe` | 手动写入一条 observed message 到系统 |
| `GET` | `/mail/mailboxes/{sessionId}/code` | 从指定 session 读取验证码结果 |
| `GET` | `/mail/mailboxes/{sessionId}/auth-link` | 从指定 session 读取认证链接 |

### 备注

- `GET /mail/mailboxes/{sessionId}/code`
  - 返回 `VerificationCodeResult`：`code`、`source`、`observedMessageId`、`candidates` 等
  - 如果当前 provider 没读到验证码，则 `code` 可能为空
- `GET /mail/mailboxes/{sessionId}/auth-link`
  - 返回 `AuthenticationLinkResult`：`url`、`label`、`source`、`links` 等
  - 从邮件内容中自动提取认证/验证/登录链接
  - 如果没有识别到认证链接，则 `authLink` 为空
- `includeAliasEmail`
  - 调用方可在 `plan/open` 请求顶层传 `includeAliasEmail: true`
  - 当前 alias provider 首版只支持 `ddg`
  - alias 是**额外返回地址**
  - `session.emailAddress` 仍然表示主匿名邮箱地址
  - 如果服务端关闭 alias 功能，则会跳过 alias 创建
  - 如果 alias 创建失败，也不会影响主匿名邮箱 open 成功
- `recover-by-email`
  - 这是 **统一恢复入口**，内部会按 provider 能力选择策略
  - 请求里可额外传 `providerTypeKey` 和 `hostId`
  - 可能的 `strategy` 包括：
    - `session_restore`
    - `account_restore`
    - `recreate_same_address`
    - `not_supported`
  - `m2u` 这类匿名 token 型 provider 主要依赖 `token + view_token`，通常只能做 `session_restore`
  - `moemail` 这类账号型 provider 可以直接走账户 API，必要时也可以尝试同名重建
  - 如果服务端既没有本地 state，也没有 provider 侧可恢复能力，则会返回 `not_supported`

---

## Public Routes：请求 / 响应示例

> 说明：
>
> - 以下示例中的：
>   - `http://127.0.0.1:8080`
>   - `YOUR_EASY_EMAIL_API_KEY`
>   - `mailbox_...`
>   - `hostId`
>   都只是示例值。
> - 如果运行时没有设置 `server.apiKey`，可以去掉 `Authorization` 头。

### 1. 获取 catalog

```bash
curl http://127.0.0.1:8080/mail/catalog \
  -H "Authorization: Bearer YOUR_EASY_EMAIL_API_KEY"
```

### 2. 只做 plan，不真正开邮箱

```bash
curl -X POST http://127.0.0.1:8080/mail/mailboxes/plan \
  -H "Authorization: Bearer YOUR_EASY_EMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "hostId": "demo-host-001",
    "provisionMode": "reuse-only",
    "bindingMode": "shared-instance",
    "includeAliasEmail": true,
    "providerGroupSelections": ["guerrillamail", "mailtm", "m2u", "moemail"],
    "ttlMinutes": 20
  }'
```

### 3. 打开邮箱 session

```bash
curl -X POST http://127.0.0.1:8080/mail/mailboxes/open \
  -H "Authorization: Bearer YOUR_EASY_EMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "hostId": "demo-host-001",
    "providerTypeKey": "moemail",
    "provisionMode": "reuse-only",
    "bindingMode": "shared-instance",
    "includeAliasEmail": true,
    "ttlMinutes": 30
  }'
```

### 4. 读取验证码

```bash
curl http://127.0.0.1:8080/mail/mailboxes/mailbox_20260331101500_0001/code \
  -H "Authorization: Bearer YOUR_EASY_EMAIL_API_KEY"
```

### 5. 读取认证链接

```bash
curl http://127.0.0.1:8080/mail/mailboxes/mailbox_20260331101500_0001/auth-link \
  -H "Authorization: Bearer YOUR_EASY_EMAIL_API_KEY"
```

### 6. 回报结果 / 反馈 provider 健康度

```bash
curl -X POST http://127.0.0.1:8080/mail/mailboxes/report-outcome \
  -H "Authorization: Bearer YOUR_EASY_EMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "mailbox_20260331101500_0001",
    "success": false,
    "failureReason": "mailbox_delivery_failure",
    "observedAt": "2026-03-31T10:20:00.000Z",
    "source": "manual-smoke"
  }'
```

### 7. 手动注入一条 observed message

```bash
curl -X POST http://127.0.0.1:8080/mail/messages/observe \
  -H "Authorization: Bearer YOUR_EASY_EMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "mailbox_20260331101500_0001",
    "sender": "no-reply@example.com",
    "subject": "Your verification code is AB7X92",
    "textBody": "Login code: AB7X92\\nIgnore order 123456.",
    "observedAt": "2026-03-31T10:16:12.000Z"
  }'
```

---

## 二、Admin / Query Routes

这组接口主要用于：

- provider 管理
- 凭据管理
- query / 调试 / 值守

| Method | Path | 用途 |
| --- | --- | --- |
| `POST` | `/mail/providers/cloudflare_temp_email/register` | 注册或更新 `cloudflare_temp_email` runtime |
| `POST` | `/mail/providers/credentials/apply` | 将 credential sets 应用到某个 provider instance |
| `GET` | `/mail/providers/probe-all` | 对所有 provider instances 做 probe |
| `GET` | `/mail/providers/{instanceId}/probe` | 对单个 provider instance 做 probe |
| `GET` | `/mail/query/provider-instances` | 查询 provider instances |
| `GET` | `/mail/query/host-bindings` | 查询 host bindings |
| `GET` | `/mail/query/mailbox-sessions` | 查询 mailbox sessions |
| `GET` | `/mail/query/observed-messages` | 查询 observed messages 列表 |
| `GET` | `/mail/query/observed-messages/{messageId}` | 查询单条 observed message |
| `GET` | `/mail/query/stats` | 查询 persistence stats |

### 重点说明：原样邮件内容访问

这也是当前“本地自己做二次提取”的核心入口：

- `GET /mail/query/observed-messages?sessionId=<sessionId>`
- `GET /mail/query/observed-messages/{messageId}`

返回的 `ObservedMessage` 中会带：

- `sender`
- `subject`
- `textBody`
- `htmlBody`
- `extractedCode`
- `extractedCandidates`
- `codeSource`
- `actionLinks`（认证/验证链接列表，每项包含 `url`、`label`、`source`）

因此如果自动提取不满足需求，可以直接取回原始正文，在本地自行切分/提取。

---

## 三、Internal Route

这组接口是内部运维用入口。

| Method | Path | 用途 |
| --- | --- | --- |
| `POST` | `/mail/maintenance/run` | 立即执行一次 maintenance |

---

## 四、返回包装约定

当前 handler 的包装基本是稳定的：

- `GET /mail/catalog`
  - `{ "catalog": ... }`
- `GET /mail/snapshot`
  - `{ "snapshot": ... }`
- `POST /mail/mailboxes/plan`
  - `{ "plan": ... }`
- `POST /mail/mailboxes/open`
  - `{ "result": ... }`
- `POST /mail/mailboxes/report-outcome`
  - `{ "result": ... }`
- `POST /mail/messages/observe`
  - `{ "message": ... }`
- `GET /mail/mailboxes/{sessionId}/code`
  - `{ "code": ... }`
- `GET /mail/mailboxes/{sessionId}/auth-link`
  - `{ "authLink": ... }`
- `GET /mail/providers/probe-all`
  - `{ "probes": [...] }`
- `GET /mail/providers/{instanceId}/probe`
  - `{ "probe": ... }`
- `GET /mail/query/provider-instances`
  - `{ "instances": [...] }`
- `GET /mail/query/host-bindings`
  - `{ "bindings": [...] }`
- `GET /mail/query/mailbox-sessions`
  - `{ "sessions": [...] }`
- `GET /mail/query/observed-messages`
  - `{ "messages": [...] }`
- `GET /mail/query/observed-messages/{messageId}`
  - `{ "message": ... }`
- `GET /mail/query/stats`
  - `{ "stats": ... }`
- `POST /mail/maintenance/run`
  - `{ "maintenance": ... }`

---

## 五、错误约定

### 401

当配置了 `server.apiKey` 但未带正确 Bearer token 时，返回：

```json
{
  "error": "UNAUTHORIZED",
  "message": "A valid Bearer token is required. Set Authorization: Bearer <api-key>."
}
```

### 400

当前会在以下情况返回 400：

- JSON 解析失败
- query 参数非法

对应错误码通常是：

- `INVALID_JSON`
- `INVALID_QUERY`

### 404

未命中路由时返回：

```json
{
  "error": "EASY_EMAIL_ROUTE_NOT_FOUND",
  "path": "...",
  "method": "..."
}
```

### 500

业务异常 / provider 异常 / runtime 异常统一返回：

```json
{
  "error": "..."
}
```

---

## 六、当前建议给其他 AI 的阅读顺序

如果其他 AI 要快速理解 `EasyEmail`，建议顺序如下：

1. `docs/provider-status.md`
2. `docs/api.md`
3. `src/http/contracts.ts`
4. `src/http/handler.ts`
5. `src/service/easy-email-service.ts`
6. `src/providers/`
