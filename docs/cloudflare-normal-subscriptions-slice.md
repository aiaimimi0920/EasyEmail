# W10k 普通邮箱订阅邮件

## 范围与读写归属

在迁移分支为普通邮箱的当前来源缓存增加订阅分组、成员分页、平台隐藏偏好和聚合网页。
与临时邮箱共享 `subscriptionPlan`、安全退订方法解析、分组查询及偏好 CAS 事务构造，不复制识别算法。
此切片不建立新的收件身份、不重写 R2 原文，也不修改远端 IMAP 状态。

`normal_message_subscriptions` 按用户/账号/epoch/邮件保存首次可验证头证据。
List-ID 优先分组，存在订阅标记但 List-ID 无效时按合法发件地址降级；不凭正文猜测。
显式无订阅标记的 MIME 保存负证据；旧对象缺少订阅头时保存 `evidence_present=0` 的未知负索引，避免每次 GET 重读。
两种负索引都不显示订阅，不允许后来用不相关的新证据覆盖。
持久化 normalized 头没有 wire `version`，先校验七个字符串、长度、控制字符和 `limited`，再显式构造 wire v1 复用解析；畸形头 fail-closed。

新同步的消息、搜索、会话图、订阅投影和检查点在同一个 D1 batch，受原 claim/committed fence 保护。
旧缓存每次 GET 最多读取五个缺订阅投影的私有 R2 内容对象，核验大小/摘要后同事务补搜索和订阅投影。
仍有未索引对象返回 `409 normal_subscription_index_pending`，用户显式刷新继续，不自动访问 IMAP。
订阅补齐之后，独立搜索缺失仍有其自身五对象预算；不能将合计对象读取上界描述成五。
每次写入 SQL 及响应前复核用户、账号 revision、current epoch、sourceHash、committed batch，迟到读取不得写回或披露旧上下文。
账号停用连接仍可查看缓存；来源变化/软删除隐藏历史，不等于物理清除。

## API 与权限

- 不带 `sources` 的 `GET /api/v1/subscriptions` 保持旧临时邮箱格式、hash、游标及权限。
- 显式 `sources=all|normal|temporary` 使用独立混合游标；`all/normal` 要求 `mail-accounts:read`，另需 `messages:read`、`subscriptions:read`。
- 可用 `accountId` 限制普通账号；普通来源不能与临时 `providerId/mailboxId` 筛选混用。
- 普通成员：`GET /api/v1/normal-subscriptions/{accountId}/{subscriptionKey}/messages?epochId={epochId}`。
- 普通隐藏：`PATCH /api/v1/normal-subscriptions/{accountId}/{subscriptionKey}`，body 严格为 `{expectedVersion,expectedEpochId,hidden}`，UUID `idempotency-key`，另需 `subscriptions:write` 与同源写保护。
- 只读回执：`GET /api/v1/normal-subscription-operations/{requestKey}`，另需 `subscriptions:write`；不给只读 Key 泄露操作记录。

隐藏只影响平台订阅列表，不停止收件、不改远端订阅。偏好按 epoch 隔离，CAS 与最小操作回执同 batch。
新写入受账号归属/revision/epoch/source/非 trash 可见订阅存在性及每账号 10,000 条回执限额保护。
同键重放返回原回执，不覆盖新版本；原回执可在来源或 epoch 变化后只读核对，不会将旧操作重新应用于新组。
账号删除或跨用户不得读取历史回执；记录不保存列表名称、正文或退订 URL。
达到限额明确失败，不在本切片自动清理历史。

`q`、发件人/收件人、时间、已读及星标筛选决定组内是否至少有一封命中，计数和成员仍展开完整位置组。
标签、自定义文件夹、inbox/archive/trash 是每个成员的硬范围。
退订方法在分页前按完整位置组取 union、去重、稳定排序，最多八项，超出标记 `limited`。
混合列表同 UUID/时间仍按来源稳定分页；列表游标绑定来源、visibility、账号和上下文，成员游标额外绑定账号/epoch/订阅 key。

## Web 与外部行为

订阅页默认全部来源，可切换临时/普通；详情按来源分派，普通详情复用受保护阅读和平台整理，不提供未实现的回复。
普通整理 revision 会刷新订阅计数与成员；查询失败不保留可操作的陈旧成员/退订方法。
偏好 unknown 时保留原路径/body/epoch/key，跨工作台导航仍可原键重试或只读核对；曾经结果未知后，即使再遇 403/404 也不擅自丢弃原键。
旧 Key profile 不扩权，新建 `unified-subscriptions-read` 和 `unified-subscriptions` 明确授予普通读取权限，不含同步、账号编辑、发信或远端退订。

List-Unsubscribe-Post 只是识别证据。服务端不访问退订 URL，不发送 one-click POST。
网页继续后端及浏览器双重 URL 安全校验，只能用户显式复制，或确认后打开隔离窗口。
不展示虚假的“退订成功”；浏览不会自动已读、收件同步或发信。

## 迁移、验证与回退

`0030_normal_subscriptions.sql` 只新增三张派生/偏好/回执表和索引，复用 0029 已有复合 owner unique key。
测试覆盖旧 29→30 保数据/保 schema、重复迁移、复合 FK、同步及回填事务失败、晚到 R2、CAS 竞争、混合分页/权限与 Chrome 纵向链。
正式本地运行结果、源码快照和独立 Wrangler 证据位于 `linshi/easyemail-cloudflare-migration-20261028/normal-subscriptions-*`，以实际收据为准。
回退旧 Worker 可保留新增表，旧代码不读取它们；本切片不执行 DROP、生产迁移或切流。

普通发信、云端草稿接入、永久清除、历史 epoch/R2/回执安全维护、远端多文件夹/flags、SMTP/OAuth2、Agent、更多供应商和真实邮件/生产容量成本验收仍未完成。
