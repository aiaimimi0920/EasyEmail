# W5 会话浏览迁移

## 范围与权威数据

聚合收件箱增加可切换的会话视图，默认仍为逐封视图。API 和网页使用同一服务端分组查询，
不把当前页的几封邮件当成完整会话。数据来源是用户已经同步到平台的缓存，不自动拉取远端历史，
不把 outgoing 的 pending、accepted 或 unknown 合成为已投递成员。

`messages` 仍是缓存内容、归属和平台状态的权威表。`thread_*` 与 `message_thread_links`
是可派生的索引，不是外部身份、邮件真实性或投递证明。仅同用户、同邮箱归并。
旧 Desktop 的主题/对方地址启发式保留为明确标注的降级方式，不声称实现完整 RFC threading。

## 分组规则和输入限制

- 有有效 Message-ID、References 或 In-Reply-To 时按 token 图归并，支持子先父后和桥接合并。
  Message-ID 的 local-part 保留大小写，domain 小写；token 使用 SHA-256，索引不保存完整原始引用链。
- 每封最多使用自己的 1 个 ID、References 的首 13/尾 14 个 ID、In-Reply-To 的末 4 个 ID，
  去重后最多 32 个 token。引用字段各限 8192 字符；异常、超限或截断标记 `limited`。
- 没有可用 ID 证据时才按归一化主题和有效发件地址分组，标注 `subject`。
  剥离有限层的 Re/Fw/Fwd、回复/答复/转发前缀；空主题或无效发件人保持 `single`。
- `basis=headers|subject|single` 只是展示关系；邮件头由外部发件人提供，未经身份认证。
  相同主题不保证同一会话，同一 ID 也不是可信身份，不用于授权或自动执行邮件指令。
- 自营上游只新增有限的 `thread_headers` 合同：`version:1`、`inReplyTo`、`references`、`limited`。
  MIME 折行展开，拒绝剩余换行/零字节，不透传任意原始 headers。Temporam 无引用头时不猜造。

## API、可见范围和分页

```text
GET /api/v1/conversations
GET /api/v1/conversations/{messageId}/messages
```

均需 `messages:read`，登录用户与 API Key 共用归属检查。过滤字段与逐封聚合接口相同：
q、sender、recipient、mailboxId、providerId、folder、isRead、starred、since、until、labelId、folderId、limit、cursor。
标签/自定义文件夹筛选另需相应 read scope。旧 Key 不扩权，不新增会话写权限。

folder、labelId、folderId、mailboxId、providerId、回收站及 purged 状态先限定成员可见集合；
q、发件人、收件人、标记和日期选择“至少一封满足条件”的组，再展开该位置范围内全部成员。
因此搜索命中旧邮件时会显示同位置中不命中关键词的新回复，但不会越过文件夹、标签、邮箱或回收站边界。
`folder=all` 不含回收站，永久清除项始终不可见。

列表按最新成员时间/ID 倒序。`messageCount`、`unreadCount`、`starred` 和 `limited`
在 SQL 分页前对完整可见组聚合，而不是页内统计。`latest` 是当前可见组的最新一封。
成员按时间/ID 旧到新，默认 25、最多 100 封一页。列表/成员/逐封游标不能互换，
绑定用户、过滤条件和成员 anchor；游标只是分页位置，不是授权令牌。

anchor 使用实际消息 UUID，不暴露可变的合并 group key。anchor 被清除或移出位置后返回 404，
调用方应刷新列表。并发新邮件或整理会改变组及排序；分页不是数据库历史快照。

## 旧缓存、重复同步和事务

新增 `0018_conversations.sql` 仅扩展列、表和索引，不改旧内容、fingerprint、flags 或权限。
`thread_version=0` 尚未索引；1 表示旧缓存/旧上游有限证据；2 表示新版显式头合同。
允许 1→2 补齐，2 的首次证据冻结；后续相同内容但改变引用不反复改图。
线程元数据不加入旧 fingerprint，不因上游新增字段重复建缓存。

会话 GET 可能写入派生索引，每次最多补 20 条该用户旧缓存，不写已读/星标/内容、不访问供应商。
仍有待补记录时返回 503 `conversation_index_pending`；存储失败为 `conversation_index_failed`。
前端显示错误并等待手动刷新，不自动循环，不将旧成功列表冒充当前完整结果。
旧缓存只利用已有 own RFC ID，真实引用链须后续显式同步新版上游补齐。
并发 warmup 可重复；版本 fence 不降级已同步的 v2 证据。

新同步在原缓存 D1 batch 中写入/合并索引，与缓存插入、租约、邮箱到期/停用/释放及归属围栏一致。
失败整批回滚；统计插入数使用真实 INSERT 结果位置，不再假定每封固定两条 SQL。
失去同步租约不能写 links。不会为了建索引绕过原同步配额或重试未知外部写入。

## 网页与清理语义

网页提供逐封/会话切换、组计数、关联依据、成员加载更多和复用的邮件详情。
浏览不自动已读、不批量整理、不发送。已读、星标、归档和回复仍显式作用于所选单封；
回复保留原邮箱/消息 UUID，不把“会话”替换为发送来源。原整理批次未决时禁止切换视图。

平台 purge 和 retention 在原事务中清对应 links 和 thread 元数据，同时保留去重墓碑/发送 guard。
回收站和归档只影响可见范围，不清图。删除桥接邮件后不重新拆分其余历史组，
但已删 token 不再用于关联未来新邮件；这不是从所有外部副本中擦除原始邮件。

## 升级与回退

1. 先备份并在隔离数据验证，再应用全部 18 条聚合迁移；源码开发不自动授权生产迁移。
2. 启用新运行时前排空旧 sync/purge/retention writer，避免旧清理代码不识别新 links。
3. 自营上游新增字段是兼容扩展，可先升级；聚合兼容无该字段的旧上游，但只能获得有限证据。
4. 回退保留新列/表和墓碑，不 DROP、不清空数据库。旧运行时不能执行不懂新索引的清理/同步；
   如必须恢复旧 writer，需先制定派生索引重建方案和单独批准的维护窗口。

本地测试覆盖旧 0017 数据、20 条有界补齐、并发/重启、晚父/桥接、跨页、scope/位置、
游标、冻结/升级、事务故障、失 lease、purge/retention、Chrome 和完整上游真实 MIME 链。
这些都是隔离合成数据的本地运行证据，不是公网邮件投递、生产成本/延迟或完整产品验收。
订阅、普通邮箱、Agent、CC/BCC/附件发送、定时及可靠队列仍在总体迁移范围。
