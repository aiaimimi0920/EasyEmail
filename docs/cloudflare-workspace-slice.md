# Cloudflare 邮箱整理与聚合收件箱切片（M3a）

## 实现范围

本切片位于 `service/cloudflare`，只在迁移分支本地开发和验证。
Web 与开放 API 共用 Workers 路由、D1 归属及权限检查；不经过 NAS 或桌面进程。

- 邮箱名称、备注、收藏，以及暂停/恢复平台同步。
- 邮件已读、星标、归档；全部是显式赋值，不提供不确定的远程 toggle。
- 跨邮箱缓存收件箱、搜索、来源、发件人、收件人、时间及整理状态筛选。
- 共享安全文本详情展示，保留单邮箱同步及新鲜度提取。
- 独立 `messages:write` 权限；既有 Key 不自动扩权。

## 平台状态不是远端变更

`paused` 只阻止聚合平台后续同步，并使旧同步租约失效；不会停收、删除、
释放或延长供应商侧邮箱。恢复后保留地址、凭据和已缓存邮件。
重复赋值为当前暂停状态不取消新的同步请求。

`isRead`、`starred`、`archived` 只属于当前平台缓存记录。
归档不会调用 IMAP move 或供应商删除；打开详情的 GET 不隐式标为已读。
同步同一内容不会覆盖这些标记。上游内容改变会形成新的内容版本，
不会承诺不同版本自动继承旧版本的整理状态。

邮箱 `status`、地址、供应商、所有者和凭据不可通过 metadata PATCH 修改。
PATCH 只更新请求中明确提供的白名单字段，拒绝空对象、未知字段或错误类型。
并发写同一字段采用最后一次成功写入；没有版本比较或完整事务快照承诺。

## API

所有路径以 `/api/v1` 为前缀。会话写入仍须精确 Origin；Key 使用 Bearer。

| 方法与路径 | 权限 | 行为 |
| --- | --- | --- |
| `PATCH /mailboxes/:id` | `mailboxes:write` | `displayName`（至多80字符）、`note`（至多1000字符）、`favorite`、`paused` |
| `PATCH /mailboxes/:mailboxId/messages/:id` | `messages:write` | `isRead`、`starred`、`archived` 严格布尔；仅返回状态，不返回正文 |
| `GET /messages` | `messages:read` | 跨邮箱缓存查询与时间倒序分页，不访问供应商 |

`GET /messages` 支持以下参数；重复或未知参数直接拒绝：

| 参数 | 合同 |
| --- | --- |
| `q` | 至多256字符，主题、sender、recipient、文本正文、原始 HTML 的子串搜索 |
| `sender`、`recipient` | 各至多320字符的子串筛选 |
| `mailboxId` | 当前用户的邮箱 UUID；他人或不存在均404 |
| `providerId` | 来源 ID 精确筛选；未知来源返回空结果 |
| `folder` | `inbox`（默认未归档）、`archive`、`all` |
| `isRead`、`starred` | 仅接受 `true` 或 `false` |
| `since`、`until` | 包含边界的上游收件 Unix 秒；未知收件时间不匹配时间筛选 |
| `limit` | 1–100，默认25 |
| `cursor` | 本查询返回的 `nextCursor`；不得跨用户或跨筛选条件复用 |

搜索使用 D1 的 `instr/lower`，`%`、`_` 不作通配符，全部参数绑定。
大小写折叠采用 SQLite 默认语义（ASCII），不承诺完整 Unicode case folding。
正文子串搜索可能扫描该用户的缓存；当前没有 FTS、生产数据量或成本验收。

排序为 `COALESCE(received_at, observed_at) DESC, id DESC`，相同时间按 UUID 降序。
未知上游时间仅可用观察时间参与列表排序，不能因此成为“新验证码”。
游标绑定用户及规范化筛选摘要，但不是签名授权令牌；SQL 始终单独检查归属。
分页不是强一致快照：并发同步、归档或筛选变更后应刷新，不承诺遍历期间数据冻结。
既有单邮箱 UUID 分页合同保留，没有把旧游标改为时间线游标。

## 数据升级与回退

`0003_organization.sql` 只新增列及索引，不改写 `0001`、`0002`，不删除数据。
既有邮箱默认空名称、空备注、未收藏、未暂停；既有邮件默认未读、无星标、未归档。
真实本地 D1 升级测试逐列比较原用户、会话、Key、邮箱密文、消息内容和关联。

升级顺序为先应用新增 schema，再启动新 Worker。旧读取方忽略新增字段；
如回退旧运行时，应保留扩展 schema，不执行 DROP 或尝试回退列。
旧运行时不认识 `paused`，因此不能把回退旧运行时当作保持暂停约束的方案。
本轮没有导入、升级或回退任何生产数据库。

## 验证入口与未完成项

测试包括 `organization-runtime`、`aggregate-inbox`、`organization-migration` 和
`organization-web`。Chrome 覆盖两个合成供应商、分页、筛选、整理、重载、
慢旧响应保护、文本安全及移动端宽度；供应商 fixture 不是真实邮箱投递。
最终收据位于迁移证据根目录的 `m3-final/verification.json`，历史 M1/M2 收据保留。

M3a 不等于整个 M3：真实供应商与投递、附件下载、基础写信/回复、
发送状态、管理后台、数据保留及生产配额/负载仍需实现或独立验收。
邮箱释放/删除、更多供应商、普通邮箱、Agent 邮件也仍保留在总体目标中。
未提交、推送、合并、部署或退役旧服务。
