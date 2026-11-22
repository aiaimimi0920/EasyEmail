# W11i2：Agent 持久授权自动收件

## 范围与所有权

仅在 `C:/Users/Public/nas_home/EasyEmail` 的 `migration/cloudflare-web` 分支开发，原目录、NAS 和云端资源不变。
本阶段将 Agent 应用密码账号的显式收件扩展为默认关闭、按账号持久授权的后台收件；不实现 Agent OAuth，不自动发信或改变任务投递事实。
账号、自动设置及版本属于同一用户。cron 使用独立的 typed automation authority，不保留或伪造创建时的 Cookie/API Key 身份。

启用必须提交 `persistentAuthorization: true`。授权保存后，退出网页或撤销创建 Key 不会停止已授权任务；关闭自动收件、停用/移除/修改账号，或停用用户后停止。
普通连接测试只更新观测字段，不使授权失效。账号设置变动则使旧绑定失效，必须显式重绑；不能因恢复旧服务器配置就自行恢复被暂停的调度。
已经发出的 IMAP 读取无法撤回，但 claim、staging 和 commit 均检查授权、账号及用户 fence，失效后的内容不得提交。

## Web 与 API

接口：

```text
GET/PUT /api/v1/agent-accounts/:id/auto-inbox
GET /api/v1/agent-inbox-automation-operations/:key
```

GET 设置需要 `agent-accounts:read`；PUT 和操作回执核对额外需要新 scope `agent-inbox:automate`。
旧 Key 不自动增加权限。网页新预设只包含以上两个 scope，不包含邮件读取、显式同步或发送权限。
PUT 使用 UUID `Idempotency-Key`，请求体严格包含以下五项：

```json
{
  "expectedAccountRevision": 1,
  "expectedRevision": 0,
  "enabled": true,
  "intervalMinutes": 15,
  "persistentAuthorization": true
}
```

间隔仅允许 5、15、60 分钟；关闭时 `persistentAuthorization` 必须为 false。
设置与不可变操作回执在同一 D1 batch 内以账号/设置版本 CAS 写入。原键重放返回原回执，不覆盖后续设置；同键异体冲突。
设置写前用户限速为 10/min。启用写入受每用户 10000 条设置操作历史上限保护；关闭不受该历史上限阻断，但仍保留鉴权、CAS 和限速。
旧回执不删除；到达上限后继续启用/改启用配置需要后续独立的元数据容量设计，不能宣称配置历史无限可用。

网页包含显式启用确认、间隔、保存/刷新、短状态及原键核对。自动设置的未保存/未决状态与账号、SMTP、手工同步互锁。
未知结果只持有原键/原 body，先 GET 核对，明确 404 后才尝试原键 PUT；CAS 已过时后再次确认原键不存在才释放未知。
已确认写入后的刷新失败不重新进入未知状态。普通页面导航保留未知；整页刷新和退出不持久化、也不自动重放原意图。

## 调度、容量与失败

- 复用每分钟 cron；按 `next_due_at, account_id` 排序，每次最多处理 3 个候选，不承诺准点。
- 自动与手工共享账号 claim、用户 10/min、平台 60/min 收件准入，以及既有活跃批次/items/bytes 容量。
- 确认遭写前限速拒绝的候选，用设置版本、账号版本、来源、原 due 和空 run token CAS 延后 60 秒；不创建收件请求、不改变历史结果，避免同一用户持续占住队首。
- 不确定预约 ACK 不按 429 处理，不开 socket、不重放旧 run；90 秒 lease 到期后仅核对该 run 的原回执。
- 过期 lease 每次最多回收 20 个。已 committed 的请求恢复为成功；未完成请求记录 interrupted，不重新连接该 run。
- 网络/存储失败指数退避至最多 1 小时，成功清零失败计数；账号/来源失效停止调度并要求显式重绑。
- endpoint 移除或 hash 漂移在预约前停止；即使恢复旧 endpoint，也须显式重新保存授权。
- 容量满时不插入请求、不建立连接。已保留内容、对象删除 ACK、空 staged 等容量规则沿用 W11i1，不提前释放。
- IMAP 读取、计划、D1 staging、R2 写入、事务内 commit/cursor 与两类 typed-root 回信关联复用原实现，自动权限不扩大手工路径。

候选上限和让位是有界调度措施，不等于多租户严格加权公平、无限账号吞吐或生产成本验收。
最小请求回执、空批次、墓碑和对象 journal 仍会增长，未实现物理有界历史压缩或长期总存储保障。

## 0050 升级、混跑与回退

`0050_agent_inbox_automation.sql` 仅新增自动设置表、不可变操作表、due/lease 部分索引及账号变更 trigger；不修改旧表定义、旧数据或对象。
先应用 0050 再上线新 runtime。默认没有授权行，不能从已启用 IMAP 账号推导自动连接许可。
旧显式收件与新自动收件通过原账号 claim 互斥；账号变更 trigger 同时约束旧账号 writer。
回退前先停用自动授权并核对在途请求、排空租约；回退 runtime 后保留新增表、索引、回执和内容，不执行 down migration 或清理旧数据。
回退到 W11i1 会停止后台自动调度，但保留手工收件；不应回退到不认识私有 Agent 收件、tombstone 或 typed-root 的更早 writer。
任何发布、生产迁移、切流、源目录退役均需另行明确批准，本阶段未执行。

## 验证与证据

本阶段基线为 `agent-auto-inbox-implementation-baseline/baseline.json`，逐项等于 W11i1 closeout 的 2321 文件；未覆盖前一阶段起点。
新增 7 个后端/DTO 测试文件及 2 个 Chrome 测试文件，均注册到包的测试脚本。
覆盖默认关闭、重启、独立权限/确认、原键/CAS、停用/版本/owner 的晚到 fence、手动互斥、预约/claim/commit/finish 丢 ACK、退避/限速让位/容量、endpoint 漂移、关闭历史上限和两类线程自动关联。
Chrome 覆盖显式确认、间隔/状态/重绑/关闭、最小 Key、未知原键恢复、坏回执拒绝、刷新失败、导航/退出和 390px 布局。

证据根：`C:/Users/Public/nas_home/AI/GameEditor/linshi/easyemail-cloudflare-migration-20261028`。
最终检查以 `agent-auto-inbox-final-resolved/verification.json` 和 `agent-auto-inbox-closeout.json` 的实际 status 为准，旧 W11i1 收据不覆盖本轮源码。
历史红测和中间失败保留，包括最初 404、网页 label 定位失败、lease 全扫描、限速让位缺失、endpoint 漂移未暂停和历史上限阻止关闭。
首次扩大回归 `agent-auto-inbox-final` 的后端 262/262 通过，Chrome 45/46；失败是旧线程测试在跟进来源刷新未完成时立即断言已解锁。
线程测试现用受控延迟确认“加载期间锁住、完成后解锁”，保留原键、版本和不重发断言，不改生产行为或加长业务超时。
resolved 重新执行完整 20 文件 Chrome 组与后续检查；后端结果仅在哈希证明与首次冻结相比只有本说明和该 Web 测试不同后复用，并记录原日志/快照哈希，不宣称后端重新执行。
最终检查包含源码 hash 冻结、相关后端/Chrome 回归、checker tests、ratchet/strict、typecheck、portability、build、Wrangler 本地 50 迁移/重复 apply/FK/dry-run、UTF-8 无 BOM、scoped diff 和原目录保留。
这些是本地 workerd/D1/R2、真实 HTTP/Chrome 与合成 IMAP/SMTP 验证，不是完整全仓测试、真实服务商认证或公网真实邮件投递验收。

## 剩余整体目标

Agent OAuth、真实供应商和公网投递验收、Cloudflare 测试发布、旧数据迁移与生产切换仍未完成。
整体迁移目标保持 active；本阶段完成不表示可以合并主干或退役原 NAS 服务。
