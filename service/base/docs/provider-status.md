# EasyEmail Provider Status

该文件记录 `EasyEmail` 当前保留 provider 的运维状态。

canonical repo：

- `C:\Users\Public\nas_home\AI\GameEditor\EmailService\repos\EasyEmail`

> 说明
>
> - 状态为项目侧运行判断，不代表上游永久稳定。
> - 这里的“可用”以 **2026-04-04** 这轮真实联调为准：
>   - `GET /mail/providers/probe-all`
>   - 逐个 provider 执行 `open -> /code`
>   - `includeAliasEmail=true` 的 DDG alias 联调

## 当前保留 provider 总表

| Provider | 类型 | 当前状态 | 最近结论 | 备注 |
| --- | --- | --- | --- | --- |
| `cloudflare_temp_email` | operator-managed / 自有站点 | **可用** | `probe/open/read-empty` 通过 | 依赖站点侧 `x-custom-auth` 与动态域名池 |
| `mailtm` | free / anonymous | **可用** | `probe/open/read-empty` 通过 | 公开 API |
| `m2u` | free / anonymous | **可用** | `probe/open/read-empty` 通过 (2026-04-24) | `https://api.m2u.io`，无需 API key，读信需 `token + view_token`；已验证可通过同邮箱名手动恢复未来收信，当前代码侧仍优先恢复本地 session/token |
| `temporam` | free / anonymous web-flow | **可用** | 单元测试覆盖 `domains/open/list/detail/probe` (2026-06-06) | `https://www.temporam.com`，按公开视频站点同源端点 `/api/domains`、`/api/emails`、`/api/emails/{id}` 接入；不使用官方 API key |
| `guerrillamail` | free / anonymous | **可用** | `probe/open/read-code` 通过 (2026-04-07) | 修复 mail_id 数字类型导致消息跳过、textBody/htmlBody 重复赋值、OTP 未找到时提前 return |
| `duckmail` | free / anonymous | **可用** | `probe/open/read-empty` 通过 | 公开 API |
| `tempmail-lol` | free / anonymous | **可用** | `probe/open/read-empty` 通过 | 本轮修正了探活方式与请求重试 |
| `etempmail` | free / anonymous | **可用** | `probe/open/read-empty` 通过 (2026-04-26) | `https://etempmail.com`，详情页正文通过 `/email?id=N` 的 `iframe data:text/html` 抽取；2026-06-17 live recoverability probe 显示 recoverKey 立即恢复失败 |
| `moemail` | key-based（例外保留） | **可用** | `probe/open/read-empty` 通过 | 当前基址为 `https://sall.cc`；支持账户级恢复和同名重建 |
| `im215` | key-based（例外保留） | **可用** | `probe/open/read-empty` 通过 | 当前 key 可用，但仍建议持续观察上游波动 |
| `gptmail` | operator-supplied key | **可用** | `probe/open/read-empty` 通过 | 当前 key 池中混有 `401 invalid` / `429 quota` 项，依赖运行时轮换与 cooling |
| `mail2925` | credential-based | **可用** | `probe/open/read-code` 通过 (2026-04-07) | 修复 PageIndex 1→0（0-based 分页）、toAddress/bodyContent/sender 字段映射、OTP 未找到时提前 return |

## 匿名层

- `ddg` alias 已在 `includeAliasEmail=true` 场景下通过真实创建验证。
- 最新一次成功样例：
  - `murky-lividly-lard@duck.com`

## 推荐分层

### A. 默认优先可用

- `cloudflare_temp_email`
- `mailtm`
- `m2u`
- `temporam`
- `guerrillamail`
- `duckmail`
- `tempmail-lol`
- `etempmail`

### B. key-based 可用层

- `moemail`
- `im215`
- `gptmail`
- `mail2925`

## 当前策略建议

默认模式下：

- 优先 `available-first`
- 依据 health / recent failures / cooldown / latency 做决策
- 保留 `gptmail` 与 `im215`，但允许运行时依据 key 状态或容量错误自动降权

如果线上需要临时收口 provider 池，可先缩成：

- `cloudflare_temp_email`
- `mailtm`
- `m2u`
- `temporam`
- `guerrillamail`
- `duckmail`
- `tempmail-lol`
- `etempmail`

## 可恢复等级标签

EasyEmail 在 mailbox 创建 / 恢复成功响应中返回统一的可恢复等级字段：

- `recoverabilityLevel`
  - `unrecoverable`
  - `key_recoverable`
  - `recoverable`
- `recoveryRequiredFields.evidenceStatus`
  - `undetermined`
  - `verified`

服务商级标签发现入口：

- `GET /mail/catalog` 的 `catalog.providerRecoverabilityProfiles`
- `POST /mail/mailboxes/plan` 的 `plan.recoverabilityProfile`
- 真正创建或恢复 mailbox 后，`open` / `recover-by-email` 响应还会返回具体 mailbox 的 `recoveryDataCredential`、`temporaryAuthCredential` 与 `recoveryRequiredFields`
- `recoveryDataCredential` 是对外不透明的恢复数据凭证字典；调用方只需要完整保存，并在后续 `recover-by-email` 请求中原样传回，不需要理解其中字段含义。

判定标准：

- 只有能让同一邮箱地址在至少 90 天后继续接收未来验证码，才允许标记为 `key_recoverable` 或 `recoverable`。
- 短期 session、短期 cookie、短期 token 不计入可恢复。
- 账号恢复和同名重建对外统一归为 `recoverable`，因为调用方只关心未来能否继续用同一邮箱地址收信。
- 未完成 provider-specific 证据验证前，系统对外按 `unrecoverable` 返回，同时把 `evidenceStatus` 置为 `undetermined`，`reason` 置为 `recoverability_not_verified`。

当前 provider 默认证据状态：

| Provider | 默认 `recoverabilityLevel` | 默认 `evidenceStatus` | 说明 |
| --- | --- | --- | --- |
| `cloudflare_temp_email` | `recoverable` | `verified` | operator-managed / 自有站点，项目侧拥有完整控制权；默认 reason 为 `operator_controlled_mailbox_store` |
| `mailtm` | `key_recoverable` | `verified` | live probe 创建 `ee-recover-...@web-library.net` 后，用 `emailAddress + password` 重新换取 token 并成功 list inbox；同名二次创建返回 422，因此不是仅凭名字重建 |
| `m2u` | `recoverable` | `verified` | 已验证可通过同邮箱名手动恢复未来收信；默认 reason 为 `manual_same_address_recreation_verified`；`temporaryAuthCredential` 仍返回 token/viewToken 供当前 session 读信 |
| `temporam` | `recoverable` | `verified` | live probe 对同一 `localPart + domain` 连续创建得到相同邮箱地址，并能按地址查询 inbox；默认 reason 为 `temporam_same_address_stateless_inbox_verified` |
| `guerrillamail` | `recoverable` | `verified` | live probe 用新 sid 调 `set_email_user` 绑定同一 emailUser 后得到同一邮箱地址，并能 list inbox；默认 reason 为 `guerrillamail_same_user_recreation_verified` |
| `duckmail` | `key_recoverable` | `verified` | live probe 创建 `eerecover...@duckmail.sbs` 后，用 `emailAddress + password` 重新换取 token 并成功 list inbox；默认 reason 为 `duckmail_password_relogin_verified` |
| `tempmail-lol` | `unrecoverable` | `verified` | historical-token future-delivery E2E 对 5 个 2026-05 下旬 artifact 发信后均未收到新验证码；默认 reason 为 `tempmail_lol_historical_token_future_delivery_failed` |
| `etempmail` | `unrecoverable` | `verified` | live probe 创建邮箱后虽然拿到 recoverKey，但立即用 recoverKey 调恢复读 inbox 失败：`Invalid recovery key!`；默认 reason 为 `etempmail_recover_key_invalid_in_live_probe` |
| `moemail` | `recoverable` | `verified` | 已验证同邮箱名可继续接收未来邮件；默认 reason 为 `same_address_recreation_verified` |
| `im215` | `recoverable` | `verified` | 已验证同邮箱名可恢复未来收信；默认 reason 为 `same_address_recreation_verified` |
| `gptmail` | `recoverable` | `verified` | 已验证同邮箱名可继续接收未来邮件；默认 reason 为 `same_address_recreation_verified` |
| `mail2925` | `recoverable` | `verified` | 已验证同邮箱名可继续接收未来邮件；默认 reason 为 `same_address_recreation_verified` |
