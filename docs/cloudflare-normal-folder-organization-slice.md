# 普通邮箱多目录平台整理（W14c1）

本切片在 W14b3 的目录聚合读取上接入平台已读、星标、归档、回收站、私有标签及单一平台位置。
这些操作只修改平台 D1 缓存状态，不连接 IMAP，不写远端 flags，不执行 MOVE、COPY、EXPUNGE 或远端删除。
整体迁移、真实服务商互操作和生产验收尚未完成。

## API 与来源合同

- 非 INBOX 使用 `POST /api/v1/normal-accounts/:account/server-folders/:folder/messages/organize`。
- 请求 body 复用原 `messageIds`、平台状态及 taxonomy patch；平台 `folderId` 不是服务器目录 `:folder`。
- 标签及位置读取走同目录 `messages/:id/labels` 和 `messages/:id/folder`，检查当前账号、目录、来源和 epoch。
- 一次最多五十封，全部消息必须属于该账号的同一当前目录 epoch；不能静默只修改其中有效的一部分。
- 平台位置与归档互斥，回收站可恢复；未提供字段保留原值。设置位置（含 null）清除归档，设置归档（含 false）清除平台位置。
- 服务器目录缓存列表仍按真实来源展示，不因平台位置、归档或回收站隐藏。聚合平台筛选继续按平台状态展示。

写入前置 INSERT 在同一个 D1 batch 内核对用户与账号 revision、调用凭据、当前 source/epoch/generation、目录 catalog 成员及 selectable/wireName、所有消息和 committed batch 的精确来源，并检查私有标签／平台位置。
只有成功插入本次 operation ID 的事务才能更新状态、关联和完成回执；旧 INBOX 同时补齐 caller 和 batch/source/folder NULL 准入 fence。

权限不扩大：需要 `mail-accounts:read`、`messages:read`、`messages:write`；回收站／恢复还需 `messages:delete`，标签修改需 `labels:read`，设置平台位置（包括 null）需 `folders:read`。
会话写入继续检查同源 Origin；历史回执仍要求原操作持久化的全部权限。

## 原键与历史回执

追加 `0056_normal_folder_organization.sql`，只给 `normal_organization_operations` 增加 nullable `server_folder_id`，总迁移数为 56。
不修改旧记录的 hash、epoch、原键、quota 或完成时间；账号级 `(account_id, request_key)` 主键保持，目录之间不能重用同一键产生第二次写入。

旧 INBOX 仍使用 `normal-organization-v1` hash，服务器 INBOX 别名委派同一合同；非 INBOX 使用包含服务器目录 ID 的独立 hash。
独立目录已完成操作先按持久化目录身份检查原键，不依赖当前 catalog，来源改变或目录消失后仍可 GET 核对或 POST 重放原回执，不重新修改邮件。
GET 为同目录 `organization-operations/:key`；旧账号级历史入口也保留全部操作。访问其他目录的原键不能获得该目录回执。

INBOX 别名的 NULL 历史记录没有持久化 alias ID；该 folder URL 仍需当前 catalog 判定别名。catalog／账号来源失效后的 INBOX 历史统一使用原账号级回执入口，不承诺旧 alias URL 永久可用。
10000 条操作配额仍按账号共享；达到配额或标签／平台位置删除，不阻断已完成原键回放。

完整旧 schema 继续提供 INBOX 整理；独立目录整理要求 0056，未升级返回明确错误，不在请求中隐式迁移。
升级按备份、追加迁移、Worker/Web 顺序执行。回滚代码保留表、数据、对象、guard 和新增列，不 DROP、不清空或回退迁移账本；仍不允许旧维护 Worker 与多目录收件并行运行。

## Web 与批量

聚合、会话、订阅和独立服务器目录详情复用平台整理、标签和位置组件，传递完整目录路径。
W14c1 当时不挂载非 INBOX 回复或远端 flags；后续[W14c2](cloudflare-normal-folder-reply-slice.md)接入同一写信器的目录回复，[W14c3](cloudflare-normal-folder-flags-slice.md)接通精确目录的显式服务器 flags 与原键恢复。

聚合批选将临时邮箱、普通 INBOX 及各独立服务器目录分成不同组，按固定顺序串行提交；每组冻结目标、patch、路径和原键。
这不是跨组原子事务。遇到未确认组即停止后续提交，保留已完成及未执行组，显式核对／原键重试后才继续。
普通整理与混合组均检查回执账号、目录、原键、数量、完成状态和 `upstreamChanged=false`，不匹配时保留原 owner，不换键。
导航不销毁未决操作；整页刷新／退出仍不持久化组件内原键，API 历史和永久 guard 保留，此边界未扩大为跨刷新自动恢复。

## 验证与边界

新增 `normal-folder-organization-{runtime,boundaries,migration,web}.test.mjs` 并接入显式测试清单。
覆盖完整目标、跨目录原键、INBOX alias、权限／Origin、caller/catalog/epoch/generation/revision 竞态、批次不一致、回滚／丢响应及保数据升级。
Chrome 覆盖三目录批量、目录级详情 taxonomy、独立目录批量、回执串目录时持键、导航与 catalog 失效后的只读核对／原键重试，以及 390px 截图。
结果以 `linshi/easyemail-cloudflare-migration-20261028/normal-folder-organization-final-v2/verification.json` 的实际状态为准，未通过前不以预检代替。

非 INBOX 回复后续见 W14c2，显式远端 flags 见 W14c3；远端移动／删除尚未迁移，订阅成员的账号级索引补齐耦合仍保留。
真实 IMAP/TLS/OAuth、Cloudflare 资源/MX/公网投递/成本、正式部署与合并均未验收或执行。
