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
| `m2u` | free / anonymous | **可用** | `probe/open/read-empty` 通过 (2026-04-24) | `https://api.m2u.io`，无需 API key，读信需 `token + view_token`；恢复主要依赖本地 session/token，不支持仅凭邮箱地址向上游恢复原 mailbox |
| `guerrillamail` | free / anonymous | **可用** | `probe/open/read-code` 通过 (2026-04-07) | 修复 mail_id 数字类型导致消息跳过、textBody/htmlBody 重复赋值、OTP 未找到时提前 return |
| `duckmail` | free / anonymous | **可用** | `probe/open/read-empty` 通过 | 公开 API |
| `tempmail-lol` | free / anonymous | **可用** | `probe/open/read-empty` 通过 | 本轮修正了探活方式与请求重试 |
| `etempmail` | free / anonymous | **可用** | `probe/open/read-empty` 通过 (2026-04-26) | `https://etempmail.com`，依赖 `recover_key + ci_session/lisansimo` 恢复会话；详情页正文通过 `/email?id=N` 的 `iframe data:text/html` 抽取 |
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
- `guerrillamail`
- `duckmail`
- `tempmail-lol`
- `etempmail`
