# 普通邮箱多文件夹独立收件（W14b2）

本切片在 W14b1 的私有完整目录上，接入按服务器文件夹的显式有界收件、缓存列表、正文、原始邮件和附件下载。
不依赖桌面、Userscript 或 NAS；所有状态由聚合 Worker、D1、私有 R2 与 Web/API 承载。
当前切片不等于完整多文件夹产品或真实服务商及生产验收。

## 数据与兼容

追加 `0055_normal_server_folder_inbox.sql`：

- `normal_server_folder_state` 以 account + 精确目录 ID 保存独立 epoch、UIDVALIDITY、UID 游标、版本、缓存代次及 90 秒 lease。
- `normal_server_folder_sync_requests` 保存永久原键 guard；同账号的请求键不得跨目录或旧 INBOX 入口复用。
- 现有 batches/messages 增加 nullable 目录 ID，batches 另有新请求外键；旧记录为 NULL，不重写消息身份或对象。
- `normal_receive_leases` 汇总旧 INBOX 和新目录 lease，使保留维护与对象清理保护全部正在收件的目录。

旧 `normal_inbox_state` 仍只表示 INBOX。目录中的 INBOX 委派旧请求、状态、邮件及对象，不复制一份收件箱。
非 INBOX 的相同 UIDVALIDITY/UID 不代表同一邮件；来源 hash、目录 ID 与独立 epoch 共同隔离。
目录 ID 由账号、服务器来源及精确 modified UTF-7 wireName 生成，不按显示名称或角色猜测身份。
目录被移除、不可选或账号来源改变时，新目录 API 不返回旧缓存。显示名、凭据轮换不改变服务器来源。
服务器目录缓存不受平台归档、回收站或平台文件夹归属筛选；INBOX 别名仍展示同一批未清除缓存，旧平台收件箱和整理视图保持原有规则。

升级顺序为备份、追加迁移、升级 Worker/Web。本切片当时包含 55 个顺序迁移，后续0056见[多目录平台整理](cloudflare-normal-folder-organization-slice.md)。
回滚代码时保留追加 schema 和数据，旧代码忽略非 INBOX 数据；不 DROP 表、回退账本或清空旧数据。
混合版本仅保证旧数据兼容，不允许旧维护 Worker 与新多文件夹收件同时运行：旧维护代码不认识新 lease。

## API 与权限

目录路径前缀：`/api/v1/normal-accounts/:accountId/server-folders/:serverFolderId`。

| 路径 | 方法 | 行为 |
| --- | --- | --- |
| `/sync` | POST | 显式同步本目录，body 仅 `expectedRevision`，必须提供原 `Idempotency-Key` |
| `/sync-requests` | GET | 最近 20 条本目录回执，只读 |
| `/sync-requests/:key` | GET | 原键核对，只读，不重新连接 |
| `/messages` | GET | 当前 epoch 缓存分页，`limit` 1–20，可传绑定目录的 `cursor` |
| `/messages/:id` | GET | 当前目录缓存正文，返回 `serverFolderId` |
| `/messages/:id/raw` | GET | 完整性核验后的原始 RFC822 字节 |
| `/messages/:id/attachments/:index` | GET | 按原文、大小和 SHA-256 核验的附件 |

目录读取、同步和回执均要求 `mail-accounts:read` 与 `messages:read`。
同步及回执还要求 `mail-accounts:sync`；下载另要求 `attachments:read`。会话写入仍校验同源。
同步只接受当前完整目录的可选目标；不从请求参数直接接受 wireName，不创建、移动或删除远端目录。
回执含原 `requestKey` 和目录 ID。非 INBOX 已有回执在目录移除或来源改变后仍可按原账号/目录/键只读核对，不因此授权读取旧缓存或重新外连。
INBOX 别名在当前来源下即使目录消失也可核对；账号来源改变后的历史 INBOX 回执仍使用旧账号级 `/sync-requests/:key`。

每批沿用现有边界：至多 100 个 UID 的窗口、3 封完整邮件、单封 2 MiB；超大或读取时消失的邮件按 UID 返回 skipped。
请求准入和对象 staging 共享账号原有活跃 batches/items/bytes 容量，不为每目录重复分配一份容量。
新目录永久请求至多 10000 条/账号，历史状态至多 256 个/账号；达到上限明确拒绝，不自动删 guard 或旧状态。

## 原子性与安全

领取 lease、认证后外连前复核、staging 与最终提交绑定账号版本/启用、活跃 owner、当前目录成员、发起会话/API Key、OAuth grant、目录 lease token/version/expiry。
使用精确转义的只读 `EXAMINE` 与 `BODY.PEEK[]`，不执行 SELECT/STORE/MOVE/EXPUNGE。
R2 完整性核验后，消息发布与目录游标在同一 D1 batch 提交；staged 内容不可读。
未知 INSERT、R2 或 commit 回应保留原 guard/对象；原键重放只核对，不自动外连、不删除歧义对象。
lease 精确释放不能释放继任者，保留维护不会在任何同账号 live receive lease 下清理缓存或 staged 对象。
清理后递增对应目录 cache generation，正文/下载在返回前重新核对来源、代次及发起凭据。

MIME 内容继续以账号地址记录归属；非 INBOX 的真实 To 头另存并用于列表及正文头部，Sent 不会错误显示为发给自己。
HTML 仍使用既有沙箱/净化组件，邮件与附件内容不会触发业务动作、自动外连或发信。

## Web 与暂未接入能力

在普通邮箱的服务器目录中点击“查看 … 邮件”，只读取本目录缓存；“同步此文件夹”才显式外连。
支持原键未知结果核对、缓存刷新、分页、正文、原文及附件下载；同步 pending/unknown 时锁住目录切换、账号编辑与其他写入。
切目录、账号或导航时取消旧读取，迟到数据不能覆盖新目标；不把凭据、邮件或操作键写入 localStorage/sessionStorage。
回执必须匹配账号、目录、版本、原键及合法状态，不完整回执和未知 JSON 408/429 保留原键。
目录刷新不会卸载未决操作的持有者；即使其他客户端移除了目录，原键核对入口仍保留。

本切片 W14b2 当时未接入聚合投影；后续[多文件夹聚合读取（W14b3）](cloudflare-normal-folder-projection-slice.md)已接入搜索、会话、订阅及私有隐藏偏好；平台整理／标签／位置见[W14c1](cloudflare-normal-folder-organization-slice.md)，非 INBOX 回复见[W14c2](cloudflare-normal-folder-reply-slice.md)，显式远端 flags 见[W14c3](cloudflare-normal-folder-flags-slice.md)。
旧账号级访问仍只认 INBOX source/epoch，旧远端 flags 最终 fence 额外核对 batch 的 source/epoch，不会因 UID 相同而写到 INBOX 的另一封邮件。
后续必须完整迁移这些能力，不能将其永久隐藏后宣称迁移完成。

## 验证记录

新增 `normal-folder-inbox-{protocol,view,runtime,boundaries,storage,oauth,migration}.test.mjs` 接入 `npm test`，Chrome 用例接入 `npm run test:web`。
覆盖相同 UID 的两目录、重启、INBOX 旧数据委派、跨目录/旧入口原键冲突、并发与继任 lease、账号/owner/目录/caller/OAuth 撤销、响应歧义、附件/游标、保留清理和 0054→0055 保数据升级。
Chrome 覆盖显式同步、POST 丢响应后的只读核对、导航与旧响应、隔离原文下载及 390px 布局。
另覆盖缺失/错误回执、未知 JSON 408/429，以及目录被另一客户端移除后仍能核对原同步。
最终状态以 `linshi/easyemail-cloudflare-migration-20261028/normal-folder-inbox-final-v3/verification.json` 为准；该文件生成并通过前，不以预检或 W14b1 收据代替。首轮因平台文件夹过滤串入服务器 INBOX 而中止；v2 的后端及 Chrome 通过，但发布夹具仍有旧迁移数断言，已统一为 55。各轮探针、红测和失败现场均保留。
不包含真实公网 IMAP/TLS/OAuth、真实投递、Cloudflare 资源创建、发布、提交或合并授权。
