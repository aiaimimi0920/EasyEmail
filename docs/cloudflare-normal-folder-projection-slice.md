# 普通邮箱多文件夹聚合读取（W14b3）

本切片将 W14b2 已同步的非 INBOX 邮件接入主工作台的聚合搜索、会话和订阅。
没有新增 schema、依赖、外部同步或发送模式；迁移总数仍为 55。整体产品和真实生产验收尚未完成。

## 读取与来源合同

- 每个当前可选服务器目录保留独立 source、epoch 和 cache generation；INBOX 委派旧状态，不重复建目录上下文。
- 会话图和订阅分组仍以用户、账号、epoch 为范围。相同 UID、RFC Message-ID 或 List-ID 不会跨目录合并。
- 聚合消息及组的 `latest` 对非 INBOX 附带 `serverFolderId`、`serverFolderName`；INBOX 省略这两个字段，保留旧详情和写入能力。
- 成员消息携带自己的目录身份；会话通过 anchor 消息限定原 partition，订阅成员严格缩小到请求 `epochId`。
- 聚合筛选中的 `folder=inbox/archive/all/trash` 仍指平台状态，不代表远端 Sent/Archive 目录；服务器目录独立列表的语义不变。
- 非 INBOX 搜索 recipient 使用真实 To 头；私有 MIME 的 `recipient` 仍保存账号归属。旧提码入口继续只查 INBOX，不扩大等待或验证码语义。

所有聚合读取均为缓存读取，不连接 IMAP、执行远端退订或隐式已读。
目录被移除、不可选、wireName/source/epoch/代次改变时，旧缓存不再可见；上下文稳定排序，目录枚举顺序不会使 cursor 失效。
账号修订或目录集合变化会使旧 cursor 失效，调用方应重新读取首页。

## 投影与并发

新收件在原有消息/游标 D1 batch 内同步生成搜索、会话与订阅派生数据。
历史缓存沿用每次最多五封的惰性补齐；超过窗口返回相应 `normal_*_index_pending`，只在显式刷新时继续。
无订阅证据的邮件也写入空 marker，防止重复补同一封。

投影 fence 在 SQL 内核对 owner、账号修订、message/batch 的账号/目录/epoch/source、committed、purged、当前目录成员及 state 代次。
对象读取后的派生写同时核对调用凭据；返回前重新核对凭据与全部目标上下文，撤销和目录移除竞态不能发布已失效数据。
订阅成员仍先补齐账号范围索引，再按请求 epoch 读取；因此无关目录的历史补齐 pending 或对象故障可能阻塞目标成员读取，后续可再细化索引调度。

新代码在完整 0054 schema 上继续提供旧 INBOX 聚合能力，应用 0055 后追加目录能力；不支持手工只执行半份 migration。
回滚代码保留既有表、对象、投影和永久 guard，不 DROP、清空或回退迁移账本。旧维护 Worker 不可与新多目录收件并行运行。

## Web 与写入边界

聚合逐封、会话成员和订阅成员均使用同一个目录详情 path 派生器；正文、raw、附件不能退回旧 INBOX 路由。
切换目录/消息时卸载旧详情、取消读取和下载，迟到结果不能覆盖新目标。列表及详情展示目录名称。

本切片 W14b3 当时仅接入非 INBOX 缓存阅读，不挂载回复、远端 flags、平台整理、标签或平台文件夹组件。
后续[多目录平台整理（W14c1）](cloudflare-normal-folder-organization-slice.md)接通平台标记／标签／位置及目录分组批量，[目录回复（W14c2）](cloudflare-normal-folder-reply-slice.md)接通现有写信器，[目录远端标记（W14c3）](cloudflare-normal-folder-flags-slice.md)接通独立权限的显式服务器 flags 与只读原键恢复。
旧 INBOX 与临时邮箱的原有写能力保持。

订阅隐藏/恢复是已接入的私有列表偏好，不是邮件写入或远端退订。
原 PATCH 合同继续使用 `expectedEpochId`、`expectedVersion`、`hidden` 和永久请求键，服务端由唯一当前 epoch 解析目录。
写入使用同一 source/catalog/epoch/caller fence；同一 List-ID 在其他目录的偏好不受影响，旧键重放只返回原回执。
继续要求既有读权限、`subscriptions:write` 及会话同源检查，不增加 Key 权限或自动外部动作。

## 验证与剩余工作

新增 `normal-folder-projection-{runtime,backfill,boundaries,web}.test.mjs`；混合写计划增加目录拒绝回归。
覆盖相同 UID/邮件头/订阅 key 的目录隔离、历史有界补齐、空 marker、原子新收件投影、分页、重启、旧 schema、目录/来源/epoch 失效、批次不一致和 caller 撤销。
Chrome 覆盖三个聚合入口、原文和附件逐字节下载、只读组件和批选边界、订阅隐藏恢复、迟到详情及 390px 布局。
实际结果以 `linshi/easyemail-cloudflare-migration-20261028/normal-folder-projection-final/verification.json` 为准；生成并通过前，不以预检或历史收据代替。

非 INBOX 平台整理及标签／位置后续见 W14c1，回复见 W14c2，显式远端 flags 见 W14c3；远端移动／删除仍待迁移，不能因隐藏入口而宣称全部完成。
真实 IMAP/TLS/OAuth 互操作、Cloudflare 资源、MX、公网投递、成本和部署/合并仍未验收或执行。
