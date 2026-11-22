# W11i1：Agent 持续收件容量前置修复

## 范围与实际问题

仅在 `C:/Users/Public/nas_home/EasyEmail` 的 `migration/cloudflare-web` 分支开发，原目录及 NAS 不变。
Agent 后台自动收件仍未实现。本阶段先修复会阻断持续收件的两个累计门槛：

- 每用户收件请求累计 10000 条后拒绝新键；失败回执也累计，内容清理不能解除。
- 每账号累计 1000 个未退休批次即拒绝；成功检查但没有新邮件的空批次也占 slot。

本阶段不是新增调度器、自动外部连接授权或历史元数据清理。旧回执、消息、线程归属、cursor 和对象 journal 均保留。

## 写入、容量及回收不变量

- `agent-inbox-capacity.ts` 独立拥有容量 predicate，由请求 INSERT 与 staging INSERT 共用；不更改 claim、账号版本、凭据或用户 fence。
- 空 `staged` 批次仍占一个 slot；成功 `committed` 且 items/bytes 均为零的批次不占容量。跳过结果保留在原回执，不因此重跑。
- 有内容的 `staged`、`committed`、`retiring` 批次继续占容量；只有现行清理流程确认全部对象删除并转为 `retired` 后，才释放整个批次。
- 保持每账号 1000 个活跃批次、1000 个 item、128 MiB 字节的上限；不提前或部分释放 Agent 内容额度。
- 请求前置检查额外 1 item / 1 byte，保持严格低于内容上限；它不是内容预约。staging 在原子 SQL 内按真实计划重新检查，拒绝时不写 R2、不移动 cursor。
- 移除请求历史总条数条件，但保留写前固定分钟准入：用户 10、平台 60；无存储配置也受限。429 不创建请求、不打开连接、不消费原键。
- 旧键仍先读原回执，不再扣新键准入；同键异 revision 仍冲突。INSERT 或 commit 丢 ACK 继续只核对原请求，不把未知当 rollback 或重连许可。

## 网页 429 行为修复

Chrome 新测试发现，首次请求明确遭 429 拒绝时，旧网页仍保留未知操作并锁住账号。
`useAgentInbox` 现在仅在原操作尚未未知、且收到明确 4xx 时释放 attempt，包括首次准入 429。
已经未知的原操作在 GET 核对遇到 429、无效响应或连接异常时仍保留原 key/body；只有确认回执或按既有规则读到明确 404 后才能继续原键路径。
不增加自动重试、刷新重放、浏览器持久化、解释性 UI 或旧 Key 权限。

## 0049 additive 升级与回退

`0049_agent_inbox_capacity.sql` 只增加匹配 live predicate 的部分索引，不修改旧表、旧索引、触发器、视图或数据。
容量聚合按账号使用 `agent_inbox_live_capacity`，不扫描已完成空批次和退休历史；建索引本身仍需遍历旧数据并占用空间。

先应用 0049，再排空旧 request/staging writer，才可依赖本阶段的持续收件准入。混跑旧 runtime 仍会按旧历史门槛拒绝。
回退到 0048 runtime 不损坏新增索引或回执，但旧终身门槛及空批次累计阻塞会恢复；这不是可用性无损回退。
不允许借本次索引迁移降级到不认识 Agent 私有收件、tombstone 或 typed-root 语义的更早 writer。

## 验证入口与边界

本阶段起点是 `agent-auto-inbox-baseline/baseline.json`，与 W11h3b closeout 的 2312 文件逐项一致，未覆盖或重建该起点。
新增定向测试覆盖超过 10000 个旧请求、超过 1000 个成功空批次、空 staged 保留、items/bytes 双重准入、删除 ACK 前容量不释放、旧原键与跨用户隔离、限速和并发、重启及 48→49 数据/对象保留和 query plan。
Chrome 验证历史容量、首次 429 解锁、未知核对 429 保留、丢成功响应仅 GET 原键、刷新不隐式连接及 390px 布局。

证据根：`C:/Users/Public/nas_home/AI/GameEditor/linshi/easyemail-cloudflare-migration-20261028`。
最终检查以 `agent-capacity-final-resolved/verification.json` 和 `agent-capacity-closeout.json` 的实际状态为准；历史红测与中间失败保留，不替换成绿色日志。
首次扩大回归保留于 `agent-capacity-final`：132 项中 131 项通过，唯一失败是旧容量夹具仍以成功空批次充满额度。
该夹具改为仍应占 slot 的空 staged 意图，保留原有拒绝、删除确认、来源退休及后续收件断言，不放宽生产容量保护。
检查包含 effective-lines checker tests、ratchet/strict、typecheck、相关后端及 Chrome 回归、portability、build、Wrangler 本地迁移与 dry-run、UTF-8 无 BOM、scoped diff、源码 hash 稳定和原目录保留证明。
不是全仓测试、真实 IMAP 供应商或真实公网投递验收，也不代表已发布。

## 尚未完成

最小永久回执、空批次、消息墓碑和对象 journal 仍随时间增长；限速只限制增长速度，并不让 D1 存储无限或元数据物理有界。
平台固定分钟 60 次的理论持续上界仍可达每日 86400 个意图，不能据此宣称成本或容量已满足长期实际负载。
后续自动收件必须独立完成 opt-in、持久授权、版本绑定、调度公平性、失败退避、手动互斥及晚到提交 fence，不能为 cron 伪造用户 Identity。
Agent OAuth、真实供应商/公网投递、Cloudflare 部署、旧数据迁移与生产切换仍未完成；整体迁移目标保持 active。
