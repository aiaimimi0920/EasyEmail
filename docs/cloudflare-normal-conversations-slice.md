# W10j：普通邮箱缓存会话

本切片将普通邮箱的缓存邮件接入聚合会话 API 与 Web，复用 W5 的头证据图和分页规则。
只在 `migration/cloudflare-web` 开发；本地合成测试不等于真实邮箱收件、公网投递或生产上线。

## 业务与来源边界

- `Message-ID`、`References`、`In-Reply-To` 复用相同规范化、SHA-256 token 与归并算法；支持子先父后和桥接归并。
- 域名部分忽略大小写，RFC ID 的 local-part 保留大小写；头 token 最多 32 个，超限有明确 `limited` 标记。
- 无有效头证据时才按规范化主题和发件人降级；空主题等情况独立成组。这不是完整 RFC threading，也不是可信身份认证。
- 临时来源按用户/邮箱隔离，普通来源按用户/账号/收件 epoch 隔离，绝不跨来源或跨 epoch 拼接会话。
- 仅查询当前来源、当前 epoch 的已提交缓存；停用账号仍可阅读缓存，软删除和来源变更隐藏旧缓存，不宣称物理擦除。
- 搜索、时间和平台 flags 选择至少一个成员命中的组；计数及展开仍包含该位置范围内的完整组。
- 文件夹、标签、回收站约束每一个可见成员，不能借展开读取范围外邮件；不合成发送记录。
- 浏览不会连接 IMAP、写已读、发送、打开认证/退订链接或修改远端 flags。普通详情仍没有未经授权的回复入口。

## API 与兼容

`GET /api/v1/conversations` 不带 `sources` 时保持旧临时邮箱合同和旧游标命名空间，仍只需 `messages:read`。

显式来源支持：

```text
GET /api/v1/conversations?sources=all|normal|temporary&folder=all
GET /api/v1/conversations?sources=normal&accountId=<account-uuid>&q=<text>
GET /api/v1/conversations/<message-uuid>/messages?sources=normal&accountId=<account-uuid>&folder=all
GET /api/v1/conversations/<message-uuid>/messages?sources=temporary&folder=all
```

- `normal` 和 `all` 额外要求 `mail-accounts:read`，即使当前没有普通缓存也不能省略；分类筛选仍要求相应标签/文件夹读权限。
- 普通成员必须显式指定 `accountId`；成员端不接受 `sources=all`。临时成员也可继续使用不带来源的旧接口。
- 新列表包含 `sourceKind`；普通会话包含 `accountId`、`epochId`，`latest` 和成员为普通缓存摘要及独立 `platformState`。
- 列表按时间、来源、ID 稳定倒序；同 UUID、同时间的普通/临时项保持独立。成员按时间和 ID 正序。
- 游标绑定用户、来源、账号、上下文 revision/epoch、筛选、列表/成员与成员 anchor；不能与逐封或旧会话游标互换。
- anchor 使用实际 message UUID，而不是可能因迟到父件改变的图 group key。

## 存储与有界旧缓存修复

`0029_normal_conversations.sql` 只扩展普通缓存的四个 thread 列及派生 links/索引，保留原始对象、摘要、manifest、flags、UID 身份和检查点。
links 以复合外键限制用户/账号及账号/epoch/message 归属；不修改 0001–0028 迁移。

新同步将搜索投影、会话图、收件 batch 和检查点放在原有同一个 D1 batch、同一个 claim/版本 fence 内提交。
图写入失败时整体回滚。旧 Worker 或恢复提交没有内容 Map 时可留下 `thread_version=0`，由后续读取有界补齐。

每次普通会话索引修复最多读取 5 个完整性核验后的私有 R2 内容对象，同时写搜索投影，避免同一旧行再次读取。
未完成返回 `409 normal_conversation_index_pending`，网页清空旧列表并仅在用户显式刷新后继续，不启动自动轮询。
若会话图已齐但独立搜索投影缺失，沿用搜索索引单次最多 5 个对象的修复预算；异常混合缺失时两个预算相加最多 10 个对象。
存储中的可选规范化头字段缺失兼容旧版；数组类型、个数或成员不合法时返回 `503 normal_content_unavailable`，不盲目信任 JSON 类型断言。

R2 读取后及返回前均重新验证当前账号 revision/source/epoch 和用户状态；迟到读取不能写入或泄露失效上下文。
版本变化只改变可见上下文，不重写对象哈希或原收件回执。

## Web

聚合页全部/普通/临时来源均可切换会话视图，搜索保留当前视图；正常刷新包含普通整理 revision。
列表 key、展开参数和详情分派携带来源/账号，避免同 ID 串开。
普通详情复用安全正文、下载和平台整理；临时详情保留原有回复能力。整理未决时沿用共同门闩禁止切换视图。

## 验证与回退

专项测试覆盖归并、主题降级/独立组、大小写/截断、旧缓存预算、当前 epoch、用户/账号/来源权限、混合稳定分页、位置/分类边界、事务回滚及迟到读取。
Chrome 场景覆盖混合/普通来源会话、完整成员分页、来源限定详情、平台整理刷新、无自动 IMAP/发送、失败清空和移动端。
正式验证收据、源码快照和独立 Wrangler 本地 28→29/重复迁移证据位于 `linshi/easyemail-cloudflare-migration-20261028`，以实际收据状态为准。

回退继续使用未改动的原项目/原部署；若未来单独测试发布后回退旧 Worker，可保留新增列/派生表，不执行 DROP。
这是 expand 阶段，不授权生产迁移、切流或旧数据删除。

尚未完成普通邮箱永久清除、历史 epoch 的物理保留清理、普通订阅/授权发信、Agent 邮件，以及真实邮箱和生产平台验收。
未来物理清除必须在事务内先处理普通会话 links、搜索、状态及分类关联，再处理缓存/对象生命周期，不能复用只处理临时邮箱的 purge 入口。
