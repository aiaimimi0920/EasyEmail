# W6：缓存订阅邮件与平台隐藏偏好

## 产品边界

Web 新增独立订阅入口，按当前用户、同一邮箱的已缓存邮件聚合，支持搜索、分页、完整位置范围计数、成员分页、逐封详情/操作及回复。
有效 `List-ID` 优先分组，没有有效 List-ID 时按可解析的发件地址降级。不同用户、不同邮箱即使 List-ID 相同也不合并。
这些头由发件人提供，不是发送身份、订阅关系或邮件真实性的证明。

隐藏/恢复只是平台列表偏好，不停止收件、不删除邮件、不调用上游、不代表远端已退订。
邮件提供的退订地址最多展示八个，HTTP(S)/单地址 mailto 规则在服务端和网页复核；拒绝危险协议、凭据 URL、控制字符及 mailto 的抄送/附加收件人参数。
用户必须显式确认后才在隔离新窗口或邮件客户端打开地址；也可显式复制。没有自动抓取、代理任意 URL、one-click POST 或“退订成功”回执。
`List-Unsubscribe-Post` 只参与识别，不作为地址或可执行命令。不要向未知地址提交凭据。

## 读写合同

```text
GET   /api/v1/subscriptions
GET   /api/v1/subscriptions/{mailboxId}/{subscriptionKey}/messages
PATCH /api/v1/subscriptions/{mailboxId}/{subscriptionKey}
GET   /api/v1/subscription-operations/{requestKey}
```

所有路由要求 `messages:read` 和新的 `subscriptions:read`；PATCH 和操作回执还要求 `subscriptions:write`。
写权限不包括同步、发信、删除或远端退订。旧 API Key 不自动扩权。Cookie 写请求仍要求同源，Key 可以按其权限调用接口。

列表和成员使用 inbox 筛选合同，默认 `folder=all`（不包含回收站），增加 `visibility=active|hidden|all`，默认 `active`。
可见性在两类读取中都生效；隐藏组须用 hidden/all 读取。指定标签/自定义文件夹还需相应 read scope。
位置、标签、文件夹、回收站和永久清除形成硬范围；搜索/已读等是组内任一封匹配时展示完整位置组的软条件。
计数在分页前计算，不是当前页邮件数；最新邮件按时间/ID 降序，成员按时间/ID 升序。
游标绑定用户、过滤器、可见性和目标组，不能跨用户/组/视图复用。它是实时 keyset 分页，不承诺跨同步或状态变化的数据库快照。

PATCH 请求严格为：

```json
{"expectedVersion":0,"hidden":true}
```

必须提供 UUID `idempotency-key`。首次版本 0，成功写入后从 1 递增；版本不一致返回 `409 subscription_changed`。
偏好与持久化回执同一 D1 batch 完成。同 Key 同内容回放原回执，不覆盖后续版本；同 Key 不同内容返回 `409 idempotency_conflict`。
响应 `operation.id` 是内部操作标识，`operation.requestKey` 才是 GET 对账路径参数。
对账 GET 不会重写偏好。Web 对不确定响应保持原 Key/原 body、锁定其他偏好写入，在工作台导航后仍能原请求核对。
跨页面刷新/浏览器重启不承诺恢复内存里的未决操作，应由调用方保存原 Key；网页不把邮件、凭据或操作写入 localStorage/sessionStorage。

## 证据来源与旧缓存

完整自营 Worker 的 parsed API 新增有限 allowlist `subscription_headers` v1，只包含 List-ID、List-Unsubscribe、List-Unsubscribe-Post、Precedence、List-Post、List-Help 和 Feedback-ID。
折行展开，各字段最多 8192 字符；超限/控制字符丢弃并标记 limited。不转发任意原始邮件头。
每封输出方法最多八个，每组同样最多八个且去重；超出时显示 limited，不把截断结果当完整能力。

聚合端仅采信显式同步得到的新合同；旧供应商或旧缓存没有字段时保持未知，不扫描正文猜造，不由 GET 自动同步。
首次显式证据对每封缓存邮件冻结，包括“非订阅”负证据；重复同步更改头不会重新分组或替换地址。
只有头元数据改变不改变原正文 fingerprint、不创建第二封缓存邮件。真实内容版本变化仍沿用原有缓存身份规则。

## 存储、清理与回退

新增 `0019_subscriptions.sql`：`message_subscriptions` 派生侧表、`subscription_preferences` 偏好和 `subscription_operations` 回执。
不增加 messages 列、不重写已有内容、flags、scopes、fingerprint、线程索引或旧幂等 hash。
订阅索引与原同步内容/线程索引共用一次 batch，继承用户/邮箱/lease/停用/暂停/释放/到期围栏。
手动 purge 和 retention 在原内容清除事务中删除订阅侧表中的名称、发件地址、List-ID 和退订 URL；失败整批回滚，不复活去重墓碑。
偏好/回执保留邮箱 ID、订阅 hash、布尔状态、版本和最小幂等证明，不保留退订地址或组名称；并非所有个人数据的完全擦除。

未来升级须先应用全部 **19 条**迁移，并排空旧 sync/purge/retention writer，再启用新运行时。
回退保留新表、偏好、回执和消息墓碑；旧 writer 不知道清理侧表，回退期间应暂停上述写入，不能恢复旧清理后声称隐私擦除完整。
当前只在独立迁移目录和合成数据上开发，没有生产导入、域名切换、NAS 更新或旧程序退役。

## 验证与非目标

专项测试覆盖跨邮箱/用户隔离、完整计数和分页、筛选和 scope、危险 URL、旧表精确保留、首次证据冻结、并发 CAS/幂等、事务故障回滚、lease 丢失、purge/retention 和重启。
Chrome 测试覆盖成员分页、逐封只读/回复、隐藏/恢复、丢响应原 Key 核对、冲突、外链取消/确认、浏览器二次 URL 校验、显式复制、列表分页、账号切换和 390px 页面。
双完整 Worker 使用真实合成 MIME 验证折行头、两个不同 sender 的 List-ID 分组、隐藏/隔离及重启；不是公网收信或真实退订验收。
实际命令和结果以 linshi 下本轮独立验证收据为准，不拿 W5 结果覆盖新源码。

不包含邮件内容授权的自动行为、远端订阅状态查询、自动退订、普通 IMAP 账号、Agent、附件发送、CC/BCC、可靠投递队列或真实公网投递。
