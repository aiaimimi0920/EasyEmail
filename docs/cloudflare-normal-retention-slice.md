# W10q：普通收件缓存保留与对象回收

## 范围与入口

普通邮箱复用平台既有 `cacheDays` / `trashDays` 保留策略、管理员预览与原键维护回执，以及十五分钟维护 cron。没有新建维护服务或用户端后台进程，也不会连接 IMAP 删除远端邮件。

- `cacheDays` 按平台 `observed_at`，不是远端邮件日期计算。
- `trashDays` 按平台回收站时间计算。
- 关闭策略或设为 0 不清相应普通缓存；已落盘的删除意图仍继续回收。
- 未提交的 staged intent 经过 24 小时且无活跃同步 claim 后可退休。这是失败写入的资源回收，不是删除远端邮件。
- 普通旧 epoch、软删除账号的缓存同样按保留策略处理，不因不可见就立即删除。

## D1 与 R2 的职责

`0036_normal_inbox_retention.sql` 只做扩展。默认不清任何既有内容；旧身份、cursor、claim、账号、发送记录和操作回执均保留。

一个有界维护事务先选择最多 100 封普通邮件与 100 个遗留 staged batch：

1. 给邮件写不可逆 `purged_at` tombstone 和本次 run 身份，清摘要、flags 与线程派生字段。
2. 记录每个不可变原文/内容对象的删除意图与原预约字节数。
3. 清搜索正文、线程 links、订阅 MIME 证据、标签和文件夹关联。用户已读/标星/归档状态行不删除；其源邮件不再可见。
4. 每个受影响账号增加 `cache_generation`，阻止并发读取返回旧内容、索引回填复活已清内容。
5. 裁剪 batch manifest 中已清理内容的 metadata，保留 skipped UID、原 `item_count`、source identity 和提交回执。

独立对象回收器每轮处理最多 20 条待确认意图，再扫描最多 20 个 inventory 对象。执行前重读 D1，验证完整 user/account/batch/UID namespace、终态 batch 和无存活内容引用。未知对象、其他 prefix 和没有删除意图的对象不删除。

R2 删除确认后，再用一个 D1 事务记录 `cleaned_at` 并累计 `released_bytes`。删除失败、D1 回执丢失或存储未配置，都不能提前释放对应字节额度。逻辑邮件额度可由 tombstone 释放。被退休 intent 的迟到 put 仍可能短暂重现，由持久 journal 加滚动 inventory 回收，不能声称删除确认后永远没有瞬时物理占用。

管理员页面显示新增普通缓存/遗留写入计数和“普通对象待确认回收”。run 的逻辑计数不等于物理对象全数删除；同幂等键只核对原批次，不再消费下一页。定时回收放在维护 `finally` 中，前面的 identity/outgoing 维护失败也不跳过已有对象意图。

## 安全保护

- 未过期同步 claim 暂缓该账号的内容清理和 staged retirement。
- editing 回复草稿、仍在 deadline 内的 queued/preparing/failed 回复任务、pending outgoing 保护其原始邮件。
- 普通单信、列表、下载、回复、搜索、聚合、会话、订阅、提取与操作 reservation 排除 tombstone 或验证 generation。
- 普通任务重试、发信防重放 guard、用户操作回执、订阅偏好、原始同步请求与 cursor 不作为内容缓存删除。
- 同步回执 `stored` 使用原 batch `item_count`，不是裁剪后 manifest 的长度。
- 已清邮件不能因源 UID 再次出现或晚索引写入恢复；内容清理不可撤销。

## 升级与回退

先在独立本地 D1/R2 验证 35 → 36 和重复 apply，再考虑实际 Cloudflare 升级。实际启用前必须排空旧同步、读取、索引、入队、发送及清理写入方，并备份 D1 和对应 R2 对象。

扩展 schema 本身不会清数据，但旧 runtime 不识别 tombstone、generation、retired batch 或已释放额度。**一旦新维护运行，禁止旧 runtime 与其混跑，也不能直接降级旧二进制。** 正常回退应保留新 schema、全部 guard/journal，并使用理解新状态但停止新增清理的兼容 runtime。完整 D1/R2 快照恢复属于独立、需明确批准的生产恢复操作；不能只恢复 D1 而让仍运行的 journal 清理器继续操作 R2。

这次没有取消既有每账号累计 1000 个 sync requests / batches 的元数据安全上限。回收 items/bytes 可以解除对应内容容量限制，**不代表无限期同步或完整容量/成本验收已完成**。不按未知对象年龄自动删除，也不擅自删除永久幂等记录来绕过元数据上限。

## 本地验证范围

新增 runtime、边界、竞态、有界预算、升级与 Chrome 场景覆盖：默认关闭/0 天、trash、当前与旧 epoch、软删除账号、回复 pin、事务回滚/丢回执、R2 删除失败与重启、维护前置失败、缓冲读取/索引回填、迟到 put、未知对象保护、100 条逻辑批次与 20 条对象预算、真实本地 R2 字节保持及原键恢复。

验收收据放在 `linshi/easyemail-cloudflare-migration-20261028/normal-retention-final-resolved/verification.json`，独立 Wrangler 证明放在相邻 `normal-retention-platform-resolved/verification.json`。扩大后端整轮回归与修复后定向复测分开记录，不把初跑失败标成全绿。收据存在且状态为 passed 才是已收尾证据；源码与此文档不替代运行结果。

不包含真实邮箱认证、公网收投、远端 flags/多文件夹、STARTTLS/OAuth2、Agent 邮箱或生产部署。整体迁移继续进行。
