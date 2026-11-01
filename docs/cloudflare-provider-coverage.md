# Cloudflare 供应商迁移覆盖

截至 2026-11-01，以下是迁移分支的本地实现范围，不是生产发布或真实投递验收清单。
旧 SDK 的 12 类供应商仍是范围参照；暂停或待迁移不表示取消目标，也不因合同差异伪造统一能力。
各阶段是否通过以各自独立 `verification.json` 的实际 `status` 为准。

| 旧 SDK 类型 | 迁移状态 | 具体边界 |
| --- | --- | --- |
| `cloudflare_temp_email` | 已有本地纵向链路 | 聚合侧类型 `cloudflare`；自营收件、受控创建及已配置发信等见各切片，仍需云端验收 |
| `temporam` | 已有本地纵向链路 | 随机分配、收件等；不把旧 NAS 真实投递证据算作新 Cloudflare 部署验收 |
| `moemail` | W12a 本地已验收 | 授权实例、随机分配、持久 cursor、Web/API；见 [MoEmail](cloudflare-moemail-slice.md) |
| `gptmail` | W12b 本地已验收 | 管理员域名、本地随机地址、有界列表摘要续批；见 [GPTMail](cloudflare-gptmail-slice.md) |
| `duckmail` | W12c 本地已验收 | 临时账户、显式匿名/Key 模式、数值分页；见 [DuckMail](cloudflare-duckmail-slice.md) |
| `mailtm` | 暂停正式接入 | 官方禁止代理条款未解决，实验仅留证据目录，不在正式运行代码中启用 |
| `tempmail_lol` | 许可与消费语义待澄清 | 当前官方条款限制聚合/转售；收件为消费式读取，不能直接套普通只读同步 |
| `etempmail` | 接口与授权待确认 | 当前公开前端的新建/恢复含 Turnstile；详情按列表序号，不证明稳定身份，见[剩余合同核查](cloudflare-remaining-providers.md) |
| `guerrillamail` | W12d 本地已验收 | 显式公共模式、随机地址绑定、会话轮换检查点、较小 ID 续页；见 [GuerrillaMail](cloudflare-guerrillamail-slice.md) |
| `im215` | W12e 本地已验收 | 已核公开 API 合同、授权 Key 创建、独立临时 Token、实际期限与持久游标；见 [215.im](cloudflare-im215-slice.md) |
| `mail2925` | 授权边界待解决 | 已读官方协议，限制商业用途、非授权第三方接入及账号共享；旧实现是主账号别名，不是远端创建，见[合同核查](cloudflare-remaining-providers.md) |
| `m2u` | 待迁移 | 后续已读到官方公开指南/FAQ/条款，但创建 schema、双 Token、稳定身份/分页与聚合授权仍待核，期限文案存在冲突；[W12f1](cloudflare-remote-allocation-slice.md) 只是基础，不是已接通适配器，见[合同核查](cloudflare-remaining-providers.md) |

## TempMail.lol 的当前限制

2026-10-31 已联网核查官方 `/en/terms`、`/en/terms-of-use`、`/en/api` 和 `/en/pricing`。
证据位于 `linshi/easyemail-cloudflare-migration-20261028/remaining-provider-contracts/`，只读公开资料，没有创建真实邮箱。
官方限制包括 `Using our API to create your own API or service.` 及 `The TempMail API may not be re-sold in any way`。
付费或一般商业用途许可不自动等于可转售临时邮箱服务；应先取得明确允许本产品聚合方式的许可。

此外官方文档描述 v2 `wipes the whole inbox on every read`，v3 `Emails you receive in a response are deleted`。
这会使 GET 收件带有上游删除/消费效应：读取成功而本地事务失败时不能安全重放，不能把它当作只读探测或普通同步。
即使许可获确认，也需独立的消费式收件契约、失败回执和风险说明，不先接入当前普通只读读取管线。
本阶段未更改旧 SDK，没有把该供应商默认接到新平台，也未取消后续经授权迁移目标。
