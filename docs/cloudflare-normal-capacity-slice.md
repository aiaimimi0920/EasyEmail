# W10r：普通收件持续容量与写前准入

## 范围与问题

在 `C:/Users/Public/nas_home/EasyEmail` 的 `migration/cloudflare-web` 分支开发；原目录和现行部署不变。
W10q 已释放内容额度，但请求入口和 staging 仍以 requests/batches **历史总数 1000** 为门槛，历史回执保留与后续同步因此冲突。
本阶段解决此终身门槛，不删除幂等记录，不执行生产清理、导入或部署，也不声称历史元数据物理总量已经有界。

## 生命周期与容量不变量

- `normal-inbox-capacity.ts` 统一请求预检和 stage 原子 SQL fence。只统计未退休 staged，或仍有未释放 items/bytes 的批次。
- 保留上限：每账号 1000 个活跃批次、1000 个未释放 item、128 MiB 未释放字节。零对象 staged 未退休前也占 batch slot。
- 完全释放的 committed 历史批次、零剩余占用的 retired 批次不占活跃 slot；有未确认 bytes 的 retired 批次仍计入容量。
- 请求预检保持占用严格低于 items/bytes 上限；staging 根据实际新计划原子检查加总。预检不是内容预约，也不绕过 claim/version/revision fence。
- R2 PUT 仍在持久 staging intent 之后；字节释放仍要求删除 ACK 与 D1 回执原子更新。没有提前释放、未知对象删除或历史 guard pruning。
- requests、batches、message tombstones、cursor、订阅/用户状态及对象 journal 都继续保留；旧键结果不因容量回收而缩水或重新执行。

## 写前准入和恢复

1. 原有 HTTP 写权限、Origin 与通用 API 限速保留；服务入口也先检查 `mail-accounts:sync`。
2. 先按账号和原键读取已有回执，再检查新请求的当前 revision/enabled。
3. 仅新键先消耗独立的固定分钟准入：用户 10、全平台 60。缺少 R2/凭据/网络失败也不能无速率限制地新增永久失败记录。
4. 准入拒绝返回 HTTP 429 和原有 `Retry-After: 60`，不创建 request/batch/claim，也不开连接；拒绝键没有被消费，可稍后显式重试。
5. 准入与 INSERT 之间若有同键竞争，或 INSERT 提交后响应不确定，先按原键核对，找到 guard 只返回现有结果，不猜测性重连。
6. 仅 INSERT winner 能进入网络同步。持久化后的配置/busy/网络/存储错误仍是原键 terminal receipt，不自动重跑。
7. 原有独立网络预算 `normal-inbox-sync` 用户 10、全平台 60 仍保留；没有重复扣同一类别。旧键绕过新键与网络预算，但仍受通用 API 保护。

两个准入桶顺序扣减，不是联合事务；平台拒绝可能已消耗用户次数。同键首次并发 miss 也可能保守多扣。
若被拒绝的一方核对时 winner 尚未 INSERT，可返回 429，之后原键可查 winner；不承诺所有同时首次入场调用都返回 200。
固定分钟允许边界突发，不等价于滑动窗口。Web 保持显式操作：429 不锁住未创建意图；丢响应仍按原键核对。

## 0037 additive 索引与升级/回退

- `normal_inbox_live_capacity` 部分索引与容量 predicate 一致，聚合不扫描已完全释放的历史批次。
- `normal_inbox_requests_recent` 匹配最近回执的完整降序排序，避免同秒记录的临时排序。
- `normal_inbox_object_ack_batch` 将已确认对象字节求和限定到对应 batch，不扫描全体已确认 journal。
- 仅增加索引，不删除旧索引、不重写表或回执。建索引本身需要遍历历史并消耗空间，不能称为常数成本迁移。
- 先应用 0037，再排空旧请求/staging writer，才可依赖新准入保证。混跑旧 runtime 仍可能绕过新准入并保留旧终身门槛。
- 回退到认识 0036 的 runtime 不损坏这些新增索引，但累计超过 1000 时旧同步门槛会重新出现；需把可用性回退与数据可读分开。
- W10q 的更早版本回退限制继续有效：旧 runtime 不认识 tombstone/generation/retired/released 语义，不能直接降级或仅恢复 D1 而继续清理 R2。

## 验证与证据边界

阶段基线使用 `normal-retention-final-resolved/verification.json` 的 2050 个 `sourceHashes`；本阶段独立收据为 `normal-capacity-final/verification.json`、`normal-capacity-platform/verification.json`，仅以实际 status 为准。
定向回归覆盖超过 1000 条历史成功/失败请求、完整旧回执及重启、活跃/退休 staging、实际 items/bytes fence、并发新键缺配置、用户/平台拒绝、pending/revision/owner/权限、同键竞争和丢 INSERT 响应。
36→37 测试核对升级前后全部用户表定义/数据、重复 apply、2 MiB 对象字节与三个 query plan；独立 Wrangler 另验本地升级及 dry-run。
Chrome 验证历史容量、429 后解锁、显式再次操作、丢成功响应的原键 GET 恢复；原普通阅读/下载、聚合与保留网页也在相关回归范围。
checker tests、ratchet/strict、typecheck/build、UTF-8 无 BOM、scoped diff、原工作区保留与源码哈希稳定另记录在收据中。不把定向范围说成全仓或完整后端通过。

## 尚未完成

永久最小回执、墓碑与对象 journal 仍随时间增长；分钟限速仅限制增长速度，平台 60/min 的理论持续上界仍达每日 86400 次，不保证无限期容量。
本阶段没有压缩/归档/删除这些记录；后续需独立保留语义、D1 总容量/成本、索引体积与实际负载验收，不能从本地 query plan 推算真实 Cloudflare 账单。
STARTTLS/OAuth2、远端多文件夹/flags、Agent 邮箱、更多供应商、旧数据导入和真实部署/认证/公网投递继续迁移。
