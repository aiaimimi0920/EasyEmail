# MoEmail 授权实例接入（W12a）

本阶段将原 SDK 已有的 MoEmail 收件能力接入 Cloudflare 聚合 Web/API，不要求桌面、Userscript 或 NAS。
本地验收结果以 `moemail-final/verification.json` 的实际 `status` 为准；它不代表公共站点授权、真实邮件投递、生产发布或整体迁移完成。

## 上游合同与使用边界

- 2026-10-31 联网核对官方仓库 `https://github.com/beilunyang/moemail`，固定版本为 `5722ceb2fca1d4f7a957ba09e93492d1c7b5d02f`。
- 官方源码为 MIT 许可证；本阶段依据公开接口独立实现适配器，未复制其服务实现。
- 只配置自建或明确获准接入的实例。MIT 软件许可证不是公共托管站点的代理、配额或商业使用授权，不内置公共站点或演示 Key。
- 合同证据保存在 `linshi/easyemail-cloudflare-migration-20261028/provider-contracts/moemail-*`，包括固定版本的配置、创建、列表、详情、API Key 身份与期限代码。
- `GET /api/config` 返回逗号分隔的 `emailDomains`；创建是单次 `POST /api/emails/generate`，精确传入 `name`、`domain` 和 `expiryTime: 3600000`。
- 创建响应必须是 HTTP 200，包含精确地址及非空受限 ID。接口不支持幂等参数，不自动重试、不换地址、不自动删除冲突资源。
- `GET /api/emails/{id}` 返回最多 20 封邮件及 `nextCursor`；详情在同邮箱下的 `GET /api/emails/{id}/{messageId}`，时间字段是 Unix 毫秒。

## 配置与能力

管理员可新增 `type: "moemail"`，配置已授权 API 地址、域名白名单和写入型 API Key。
沿用现有端点 origin 白名单、平台密钥加密、不可变实例身份、版本 CAS、管理员会话和审计，不放宽 API Key 管理权限。
没有平台凭据时保持不可分配，不伪造“已配置”；管理员可显式探测，普通页面加载不自动探测。

已接通手动/自动随机分配、同步、缓存正文/聚合收件、提码与同一套 Web/API。
当前不支持 MoEmail 发信、自定义前缀、远端删除、地址恢复或附件下载；能力目录不宣称支持。
上游接口可以创建一小时邮箱，本阶段固定选择一小时，不偷偷创建永久邮箱。
创建预约和邮箱 DTO 的期限取上游一小时与平台保留期限中的较早者，之后不能继续同步；已缓存邮件仍按既有缓存策略处理。

## 凭据与续页的所有权

- 平台 API Key 留在后端凭据域；邮箱 ID 以现有邮箱 AES-GCM/AAD 加密，不能把密文换给别的用户或邮箱使用。
- 0052 仅新增 `provider_sync_cursors`，每邮箱最多一条续页状态；不重写旧邮箱、邮件、密文、创建回执或数字分页语义。
- 外部 cursor 视为不透明值，只 URL 编码为固定受控路径的查询参数，不当作 URL 跟随。
- 下一页 cursor 与邮件缓存、同步 revision 在同一 D1 batch 写入，复用原同步 lease、用户、状态及到期 fence。
- 第一页从上游当前起点读取；后续页必须匹配持久化的 `nextPage` 与用户。重启可以续页，过期 lease、失败 batch、错误归属不能推进游标。
- 仅 cursor 型适配器访问新表，原 Cloudflare/Temporam 数字分页不增加该表的读写。
- 列表与详情校验 ID、精确收件地址、邮件类型；超过 20 封、重复 ID、无效/原地循环 cursor、跨身份内容等整批失败，不覆盖已确认缓存。
- 列表后详情 404 计入 `missing`，不伪称同步完整。每批最多 20 次详情，整体沿用 15 秒 deadline、2 MiB 单响应限制和禁止重定向。

## 模糊创建与兼容回退

上游写成功但 ACK 丢失，或本地持久化失败时，原创建回执仍为 `unknown`、`retrySafe: false`。
同一键只核对已有回执，不重新 POST，不使用另一个供应商补偿。上游可能遗留资源；本阶段不声称自动恢复或自动清理。
未部署前可回退本切片代码，旧源码与数据不变。将来先应用 0052 再启用新运行时；若已配置 MoEmail，回退旧运行时前须先停用/移除新类型配置并保留数据备份。
不能让不认识 `moemail` 的旧运行时继续读取新类型配置；不通过删除表或清空回执实现回退。

## Mail.tm 候选未进入本阶段

补查官方文档 `https://docs.mail.tm/` 时发现 “No proxy services” 及 “Don't mirror or proxy our API under a different domain.”，另有禁止简单付费包装和可见署名要求。
该限制与对外聚合 API 的计划存在明显冲突；未经服务方澄清，不把候选接入正式工作区，也不将“技术可用”视为已获使用许可。
16 个本地候选文件保存在 `linshi/easyemail-cloudflare-migration-20261028/mailtm-retired-candidate`。
其中 12 个修改文件已按本阶段前快照恢复，4 个新建文件移至证据目录，没有删除候选内容、Git reset 或撤销上轮迁移成果。
恢复后重新核对 2,357 个工作区源码哈希和原目录 1,393 个文件及 Git 状态，与上轮 OAuth closeout 一致。
候选测试曾有一次冷却状态导致的失败，未完成最终验收，不以它的部分通过结果证明本阶段。

## 验证边界

新增本地 HTTP 合同夹具、Worker/D1 集成、旧 schema 扩展兼容和独立 Chrome 流程；没有请求真实邮箱创建、读取用户邮件或真实密钥。
验收覆盖分页重启、事务失败、lease 丢失、双用户隔离、创建未知不重试、身份/收件人校验、错误脱敏、管理员与网页流程。
最终冻结候选另跑受影响 Cloudflare/Temporam 回归、类型检查、构建、有效行 checker tests/ratchet/strict、52 个本地迁移及 Wrangler dry-run。
这些检查的具体数量、失败和通过以最终收据为准；不声称本轮重跑所有 Agent/OAuth 或全仓测试。
真实授权实例、Cloudflare 网络限制/实际成本、公网投递与生产切换仍需后续独立验收；本阶段没有 commit、push、merge 或 deploy。
