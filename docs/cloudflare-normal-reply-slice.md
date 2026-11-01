# W10n：普通邮箱回复

## 范围与复用

普通邮箱回复复用已存在的私有收件缓存、草稿 CAS/墓碑/共享限额、唯一普通写信器和 SMTP 持久发送 guard。
不新增第二套写信状态机，不需要桌面端、Userscript 或 NAS。W10n 初始范围为 INBOX 纯文本回复；后续普通附件与队列复用该来源，非 INBOX 回复见[W14c2](cloudflare-normal-folder-reply-slice.md)。仍不含 reply-all。

## 回复来源与线程

```text
GET /api/v1/normal-accounts/{accountId}/messages/{messageId}/reply
```

这是显式只读预览，不连接 IMAP/SMTP。要求 `mail-accounts:read` 与 `messages:read`，只允许当前用户、当前账号/来源 epoch、已提交且已发布 UID 内、未进平台回收站的邮件。
预览返回当前账号 DTO，以及 `accountId/accountRevision/messageId/to/subject/threading`；`threading` 为 `available` 或 `unavailable`。
预填回复目标来自经过真实长度与 SHA-256 校验的私有 R2 原始邮件，不能使用客户端、缓存摘要或展示 sender 推导。用户仍可编辑收件人和主题；发信只强制线程来源由服务器校验，不强制内容等于预览。
存在 Reply-To 时必须恰好一个字段、一个合法 ASCII 单邮箱；不存在才使用同样受约束的 From。多地址、分组、重复或非法目标均拒绝，不默默取第一个。
主题去除控制符、补 `Re:`，不超过 200 UTF-16 units，截断不留下孤立高代理。

实际 SMTP `In-Reply-To` 只使用服务器验证过的原 Message-ID；References 优先原 References，否则仅在 In-Reply-To 恰有一个合法父 ID 时回退，再追加原 Message-ID。
复用有限头解析与折行，客户端不能提交线程头。原 Message-ID 缺失或无效时允许回复，但不伪造任何线程头，回执明确 `unavailable`。

## 草稿、发送与原子边界

普通草稿 PUT 与普通 send 新增可选 `replyToMessageId`，有值时额外要求邮件读取权限。
新增 `0033_normal_reply.sql`：草稿使用独立 `normal_reply_message_id`，不占用临时来源的 `reply_message_id`；普通发送记录增加回复 ID 与线程状态。
CHECK 强制普通回复草稿必须有普通账号来源、发送回复 ID/线程状态必须成对非空。没有将新回复引用设成会级联删除 guard 的外键。
旧行新列均为 null；无回复的临时/普通草稿和发送 hash 保持精确旧合同。有回复时只在旧内容数组后追加独立版本标记及原邮件 ID。

保存和发送预约在实际 SQL 中再次检查账号归属/版本、active 用户、当前 epoch/source、committed 批次、发布 UID、原邮件 hash 与非回收站条件。
读后发生变化不会创建发送 guard、消费草稿或打开 SMTP。草稿消费继续和发送预约同一个 D1 batch。
原键回放先检查持久 guard，不再读取原信或 R2；原信消失、账号移除、结果 unknown/写回失败都不能引起第二次 SMTP。
发送内容到期清理同时清回复 ID/线程状态，保留请求 hash、配额与防重 guard；草稿删除清回复引用并保留墓碑。

## 网页

普通独立页、聚合收件箱、会话与订阅共用阅读组件的回复入口。点击只取服务器预览，成功后转到同一个普通写信器，不自动保存或发送。
预览前后及改变账号 DTO/revision 之前同步检查当前编辑器、草稿和账号配置锁；同账号新 revision 也不能绕过旧编辑器 guard。
有未决操作或未保存内容时直接拒绝，须先保存或显式处理原内容，避免重复确认或静默覆盖。手动添加/切换/刷新/移除账号也保护未保存 IMAP/SMTP 配置。
nonce 在接受或拒绝时均只消费一次；登出销毁用户树并中止预览，晚到响应不能污染新用户。
回复草稿保存、重开后保留原信关联；“改为新邮件”显式去掉关联，已保存草稿须先保存变更后发送。
发送 attempt 仍冻结原账号、body 和 key；丢响应只读核对原结果，不根据当前回复意图重建请求。
已有 `normal-draft-send` Key 模板包含此路径所需权限；不扩大旧 `normal-drafts` 模板的读取或发信权限。

## 升级与回退

当前仅在隔离迁移分支和合成数据开发，没有生产发布、真实账号认证或真实邮件投递。
未来启用前应用 0033 并排空旧版草稿/发送写入方。旧版本不认识普通回复语义，可能丢失来源或线程，不能混合写入或直接降级。
需要回退时停写并保全新草稿、普通回复记录与所有发送 guard，另按获批方案恢复；不能删除新列、墓碑或 guard 强行兼容旧版。
当前原项目和原部署保持独立，可继续使用；分支未经合并或切流。

## 验证口径

正式记录为证据根下 `normal-reply-final-r2/verification.json`、`normal-reply-platform-r2/verification.json` 与最终 closeout，只认实际 status 和同一源码快照。
覆盖运行时/授权/输入/原文完整性、SQL source fence 竞态、旧 hash/数据保留、完整 package Web 套件、独立 Wrangler 32→33 重复升级、R2 字节和 dry-run。
初次红灯、测试夹具约束错误和后续修复日志全部保留，不用旧阶段或定向结果替代正式结果。
首轮完整回归后端通过，Web 的旧普通账号测试仍依赖同账号重选静默清空密码，故失败；保留原现场，改为断言禁用及内容保留，再显式刷新页面放弃修改，不撤回保护逻辑。
所有浏览器发信均对本地合成 SMTP；`accepted` 仅表示 SMTP 接受，不表示真实收件人收到。
