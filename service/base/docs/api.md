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
| `POST` | `/mail/mailboxes/open` | 打开邮箱 session，返回 session / instance / binding，以及临时认证凭证、可恢复等级、恢复所需字段、实际 provider；可附带 alias 结果 |
| `POST` | `/mail/mailboxes/recover-by-email` | 按邮箱地址、本地 state、provider 恢复能力和调用方提交的 `recoveryDataCredential` 恢复 mailbox session |
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
  - 请求里可额外传 `providerTypeKey`、`providerInstanceId`、`hostId`、`recoveryDataCredential` 和 `recoveryFields`
  - 推荐用法：调用方在 `open` 返回中保存 `recoveryDataCredential` 这个字典，后续恢复时原样放入 `recover-by-email.recoveryDataCredential`；调用方不需要理解字典里的任何字段含义
  - 如果创建邮箱时保存了 `createdByProvider.providerInstanceId`，恢复时应优先传回 `providerInstanceId`，服务端会只把恢复请求转发给该实例；未传时会按 `providerTypeKey` 遍历该类型可用实例
  - `recoveryDataCredential` 是新的对外不透明恢复数据凭证；服务端会从中推断 `emailAddress`、`providerTypeKey`、`providerInstanceId`、`hostId` 和 provider 必要恢复字段
  - `recoveryFields` 是兼容旧调用方的底层字段入口；新调用方应优先使用 `recoveryDataCredential`
  - 无本地 session 时，服务端会优先调用具体 provider 的 `recoverMailboxSession`，把恢复数据凭证字典作为恢复字段转发给 provider；provider 无法恢复时，再尝试通用 `mailboxRef` 重建 fallback
  - 可能的 `strategy` 包括：
    - `session_restore`
    - `account_restore`
    - `recreate_same_address`
    - `not_supported`
  - `m2u` 当前代码侧主要依赖 `token + view_token` 做 `session_restore`，但已验证可通过同邮箱名手动恢复未来收信，因此可恢复等级按 `recoverable` 处理
  - `moemail` 这类账号型 provider 可以直接走账户 API，必要时也可以尝试同名重建
  - 如果服务端既没有本地 state，也没有 provider 侧可恢复能力，则会返回 `not_supported`
- `recoverabilityLevels`
  - `open` 请求可传 `recoverabilityLevels: ["recoverable"]`、`["key_recoverable"]` 或 `["unrecoverable"]` 做 provider 筛选
  - 未验证 provider 默认不会进入 `recoverable` / `key_recoverable` 筛选结果
  - 如调用方明确接受待验证 provider，可传 `includeUndeterminedRecoverability: true`
- 服务商级标签发现
  - `GET /mail/catalog` 返回 `catalog.providerRecoverabilityProfiles`
  - `POST /mail/mailboxes/plan` 返回 `plan.recoverabilityProfile`
  - 这两个字段用于调用方在真正创建邮箱前查看 provider / instance 的当前可恢复等级标签与证据状态

### 邮箱可恢复等级字段

`POST /mail/mailboxes/open` 和恢复成功的 `POST /mail/mailboxes/recover-by-email` 都会返回以下新增字段：

- `recoveryDataCredential`
  - 恢复数据凭证；类型固定为字典：`Record<string, string>`
  - 这是给外部调用方保存和回传的唯一推荐字段
  - 调用方不需要解析、不需要理解、不需要改写这个字典；未来调用 `recover-by-email` 时把它完整传回 `recoveryDataCredential` 即可
  - 字典内部会包含服务端恢复路由和 provider 恢复所需的必要数据；具体 key 对不同 provider 可以不同
- `temporaryAuthCredential`
  - 当前 session 后续读信所需的临时认证材料
  - 只返回 mailbox 级 token / recover key / view token / mailbox id 等；不返回 operator API key、全局账号密码、admin secret
- `recoverabilityLevel`
  - 对外只允许三档：
    - `unrecoverable`
    - `key_recoverable`
    - `recoverable`
  - `key_recoverable` 要求调用方保存的关键密钥能在至少 90 天后恢复同地址未来收信
  - `recoverable` 合并账号恢复与同名重建；外部调用方无需关心底层机制
- `recoveryRequiredFields`
  - `fields`：调用方需要保存并在未来恢复时提交的字段
  - `evidenceStatus`：内部证据状态，当前为 `undetermined` 或 `verified`
  - `minimumHorizonDays`：固定为 `90`
  - `reason`：为什么给出当前等级
  - `serverSidePrerequisites`：服务端必须持有的 provider 侧配置，例如 API key 或 admin auth；这些 secret 不会返回给调用方
- `createdByProvider`
  - 实际创建该邮箱的 provider 信息
  - 当请求走 fallback / strategy selection 时，以最终成功 provider 为准
- `providerRecoverabilityProfiles` / `recoverabilityProfile`
  - provider / instance 级可恢复标签，用于 catalog 展示和 plan 预览
  - 字段包含 `providerTypeKey`、`providerInstanceId`、`recoverabilityLevel`、`evidenceStatus`、`minimumHorizonDays`、`reason`
  - 该标签不包含具体 mailbox token；具体临时认证凭证只在真正 open / recover 成功后返回

默认策略仍然是 fail-closed：未完成 provider-specific 证据验证前，对外 `recoverabilityLevel` 返回 `unrecoverable`，同时 `recoveryRequiredFields.evidenceStatus` 返回 `undetermined`，`reason` 返回 `recoverability_not_verified`。

当前已按实测或项目侧控制权标记为 `recoverable` 的 provider 包括：`cloudflare_temp_email`、`im215`、`mail2925`、`gptmail`、`moemail`、`m2u`、`temporam`、`guerrillamail`。其中 `m2u` 的自动代码恢复仍以本地 session/token 为主，`recoveryRequiredFields.serverSidePrerequisites` 会标记 `m2u_manual_same_address_recreation`。

当前已按 live probe 标记为 `key_recoverable` 的 provider 包括：`mailtm`（`emailAddress + password` 重登录换取 token）、`duckmail`（`emailAddress + password` 重登录换取 token）。`tempmail-lol` 对 5 个 2026-05 下旬 historical token 发信后均未收到新验证码，因此当前标记为 `verified + unrecoverable`；`etempmail` 已完成 live probe，但 recoverKey 立即恢复失败，因此当前也标记为 `verified + unrecoverable`。

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

### 3.1 恢复已有邮箱 session

已知邮箱地址或从 `open` 返回中保存过 `recoveryDataCredential` 时，应使用恢复入口，不要再调用 `open` 重新创建同名邮箱。

```bash
curl -X POST http://127.0.0.1:8080/mail/mailboxes/recover-by-email \
  -H "Authorization: Bearer YOUR_EASY_EMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "emailAddress": "seed@example.com",
    "providerTypeKey": "cloudflare_temp_email",
    "hostId": "python-register-orchestration"
  }'
```

推荐调用方保存 `open` 返回的完整恢复字典，并在恢复时原样传回：

```json
{
  "recoveryDataCredential": {
    "emailAddress": "seed@example.com",
    "providerTypeKey": "cloudflare_temp_email",
    "providerInstanceId": "cloudflare_temp_email_shared_default",
    "hostId": "python-register-orchestration"
  }
}
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
- `POST /mail/mailboxes/recover-by-email`
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
