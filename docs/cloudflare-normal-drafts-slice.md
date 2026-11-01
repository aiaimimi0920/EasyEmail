# W10m：普通邮箱云端草稿

## 范围

普通邮箱复用现有云草稿的用户私有存储、CAS、内容指纹、列表分页、删除墓碑、网页状态和原子发送消费。
本阶段只支持纯文本 To/CC/BCC 草稿与直接 SMTP 发信；不包含普通邮箱回复、附件或排队/定时发送。
不复制旧桌面实现，不要求安装客户端、Userscript 或连接 NAS。

## 数据与来源

新增 `0032_normal_drafts.sql`，只向 `drafts` 增加 `normal_account_id`、`normal_account_revision` 和来源分页索引。
旧行默认两列均为空，原内容、revision、hash、发送引用和墓碑不重写。
普通来源使用独立账号外键，不能填入临时 `mailbox_id`；CHECK 要求账号版本、空临时来源、空回复及空附件同时成立。
账号归属与当前版本在应用查询和实际写入 SQL fence 中检查；单列外键本身不代表跨用户隔离。
来源类型和普通账号 ID 在草稿建立后不可切换。每用户 100 份非删除草稿的限额由两种来源共享、原子检查。
停用账号仍可保存离线草稿；已移除账号的旧草稿可读取、清空并留下墓碑，但不能新建或修改。

## API

```text
GET /api/v1/normal-accounts/{accountId}/drafts[?limit=25&cursor={draftId}]
GET|PUT|DELETE /api/v1/normal-accounts/{accountId}/drafts/{draftId}
POST /api/v1/normal-accounts/{accountId}/send
```

PUT 完整替换可编辑草稿，字段为 `expectedRevision`（草稿版本）、`accountRevision`（账号版本）、`to`、可选 `cc/bcc`、`subject` 和 `text`。
首次 PUT 使用客户端生成的 UUID 和 `expectedRevision: 0`；响应丢失时保留原 ID/原内容，精确重放不重复递增版本。
DELETE 只接受 `expectedRevision`，清除内容并保留身份墓碑，不能复活。列表按 `(updated_at DESC,id DESC)` 分页，游标不能跨用户、账号或临时来源。

普通草稿读取同时要求 `mail-accounts:read` 与 `drafts:read`；写入同时要求 `mail-accounts:read` 与 `drafts:write`。
从草稿发送在原 `expectedRevision`（账号版本）和 `smtpRevision` 之外，提交成对的 `draftId/draftRevision`，同时要求 `mail-accounts:send` 与 `drafts:write`。
会话写入仍验证精确 Origin。新增独立的普通草稿、普通草稿发信 Key 模板，不扩大旧 Key 或旧发信模板的权限。

原 `/drafts` 路由只处理临时草稿，旧响应形状、临时内容 hash 与发送 key 合同保持不变。
不含草稿的普通直接发信也保持 `normal-smtp-send-v1` 请求 hash；有草稿时，额外绑定草稿 ID 与版本。
普通草稿内容 hash 独立标记来源并绑定账号版本，不绑定可更新的 SMTP 配置版本。

## 发送与恢复

发送前要求草稿仍为 editing，且所属用户、账号、草稿版本、账号版本和规范化收件人/正文完全一致。
普通 outgoing 预约与草稿的 submitted 状态、revision 增量、outgoing 引用在同一个 D1 batch 内完成。
只有该持久预约成功后才打开 SMTP socket；事务失败不发信，事务内账号/SMTP/草稿 fence 失败也不发信。
SMTP rejected、unknown 或成功写回失败都不会恢复 editing；新 key 不能再消费相同草稿。
原发送 key 的回放先核对持久 guard，删除草稿或移除账号后也不再次 dispatch。
SMTP 最终接受仅表示 `accepted`，不代表收件人实际收到。

网页复用 `useCloudDraft` 与 `CloudDrafts`，按普通账号隔离加载。未保存、草稿操作中或发送待核对时锁定账号切换。
保存响应丢失保留草稿 ID；发送响应丢失保留原路径、body 和 key，核对只 GET 发送回执，不用新 key 重发。
发送未确认期间不能保存、打开或删除草稿；另起邮件仍需确认重复风险。
旧草稿的账号版本与当前账号不同时，必须明确确认当前发件地址，重新关联并保存后才可发送，不静默改绑。

## 升级与回退边界

当前仅在 `migration/cloudflare-web` 和独立本地测试数据开发，未执行生产迁移、真实收发或发布。
未来部署须先备份并应用 0032，再使用来源感知的新代码；启用普通草稿写入前必须排空旧草稿读写请求。
旧版聚合代码并不识别新增来源，不能在已有普通草稿的数据上与旧版并行读写，也不能直接降级运行。
若未来上线需回退，应停写、保全新增普通草稿与发送 guard，再按获批方案恢复备份或回退到仍识别新来源的版本，不能删新增列或墓碑来强行降级。
当前安全回退仍是继续使用未受影响的原工作区与原部署，不合并迁移分支。

## 验证口径

本阶段最终正式记录为证据目录中的 `normal-drafts-final-r2/verification.json` 与 `normal-drafts-platform-r2/verification.json`，只认实际 `status` 和绑定源码快照。
覆盖普通草稿 API/权限/来源/并发/事务失败/未知发送、旧临时草稿及发送兼容、真实 Chrome 合成 SMTP、31→32 保数据升级与本地 Wrangler dry-run。
首次红灯、类型适配、异步浏览器断言与历史迁移夹具问题保留原始记录；不把诊断通过或旧阶段收据代替本轮正式结果。
首轮完整正式回归的后端 162/162 通过、Web 69/71 通过，两处失败均发生在立即读取禁用状态的断言。
邮箱刷新时序记录证实网络拦截可先于 React 提交 loading 状态；普通账号锁定也需经过两级 effect 传播。保留网络阻塞和原断言，改为等待实际 DOM 禁用状态，不加固定 sleep、不忽略失败或改生产保护。
原始多次快速导航诊断末次超时，不能作为通过证据；独立单次夹具诊断和最终全套复验分别记录。
真实 Cloudflare 部署、真实账号及邮件投递、普通回复/附件/队列、统一维护和安全清理仍未完成。
