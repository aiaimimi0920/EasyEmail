# 普通邮箱服务器目录发现（W14b1）

后续多文件夹收件与阅读见 [W14b2](cloudflare-normal-folder-inbox-slice.md)。下文保留 W14b1 当时的范围和验证记录，不将旧收据当作新代码的验证。

本切片在 Cloudflare 聚合 Worker、D1 和 Web 上接通普通邮箱的服务器目录发现。
它只建立完整目录缓存，不改变现有 INBOX 同步，也不代表多文件夹收件、阅读或远端移动/删除已完成。
服务器文件夹与平台整理文件夹是两个独立概念，不能按显示名称混用。

## API 与权限

```text
GET  /api/v1/normal-accounts/:id/server-folders
POST /api/v1/normal-accounts/:id/server-folders/discover
```

GET 需要 `mail-accounts:read` 和 `messages:read`，只读取私有 D1 缓存，不刷新 OAuth 或连接服务器。
POST 另需 `mail-accounts:sync`；会话请求必须通过 Origin 校验，正文严格为 `{"expectedRevision":1}`。
账号必须启用、版本及服务器配置 hash 必须一致，并执行用户和平台分钟限流。
发现是只读 LIST，不使用远端写操作的永久幂等回执；网络或保存结果不确定时先 GET 核对，不能自动重新 LIST。
用户可在核对后显式发起新的目录发现，但旧快照不证明刚才的请求一定失败。

目录响应包含 `accountId/accountRevision/current/complete/snapshotId/snapshotAccountRevision/observedAt/items`。
没有当前来源的完整快照时，`current/complete` 为 false，快照信息为 null，items 为空；不是声称服务器目录为空。
完整发现得到零项目则为有快照的空目录，与“尚无目录”区分。

## 协议与身份

- 复用现有 TLS/强制 STARTTLS、PLAIN/XOAUTH2 与单次连接生命周期。
- 发出 `LIST "" "*"`，仅服务器 advertised `SPECIAL-USE` 时增加 `RETURN (SPECIAL-USE)`。
- 支持 atom、转义 quoted、literal 名称、NIL 分隔符及严格 modified UTF-7。
- 只有 INBOX 大小写归一，其他 wireName 精确保留；名称/分隔符不用于猜测服务器特殊角色。
- `\Noselect`、`\NonExistent` 标记不可选；特殊角色取服务器 attributes。
- folder ID 按账号、来源 hash 和精确 wireName 计算，不用显示名、角色或拆分路径作为身份。
- 每次最多 128 个文件夹、256 个响应轮次、256 KiB 协议响应、512 KiB 目录 JSON；只在完整 tagged OK 后发布。

协议错误、超限或部分目录都不会覆盖上次完整快照。
发现过程不执行 SELECT、EXAMINE、FETCH、STORE、MOVE、EXPUNGE、CREATE 或 DELETE。
本地协议基于 RFC 3501 IMAP4rev1 与 RFC 6154 的限定合同，不声称完整 IMAP4rev2 或真实服务商互操作已验收。

## 持久化与并发

追加式 `0054_normal_server_folders.sql` 新建独立目录表，不改写旧 INBOX cursor、epoch、邮件、平台文件夹或 0053 flags guard。
每账号仅一份最新完整目录及一个 45 秒 token/revision lease，不累积发现历史。
外连前和原子发布时校验账号、owner、发起 session/API Key 与 OAuth grant fence；旧执行者不能覆盖或释放继任 lease。
只有一个带 fence 的 UPDATE 发布完整 JSON，失败保留旧快照。
来源绑定 endpoint hash、用户名和邮箱地址；来源变化后 GET 隐藏旧目录，不删除底层历史数据。

## Web

普通邮箱页增加“服务器文件夹”区域：

- “发现服务器文件夹”是显式 POST，会连接服务器；“刷新缓存目录”是 GET，不外连。
- 显示名称、可选性、服务器角色和观察时间，明确标注 `收件同步：INBOX`。
- 发现期间与配置、普通收件/发信互锁，不新增后台自动发现。
- 缓存 GET 与手工请求共用读取代次；操作开始及结束均作废旧 GET，避免导航触发的晚响应覆盖新目录。
- 手工操作成功清除旧缓存错误；成功或失败均释放读取/操作状态，不因无效 GET 的 finally 被忽略而锁死按钮。

## 本地验证与发布边界

`normal-folders-{protocol,runtime,boundaries,storage,migration}.test.mjs` 接入 `npm test`；
`normal-folders-{web,web-races}.test.mjs` 接入 `npm run test:web`。
覆盖完整目录、名称编码、权限、来源变化、失败保旧、租约继任、撤销授权、数据库响应歧义、0053→0054 保数据升级及真实 Chrome 导航竞态。
最终结果以 `linshi/easyemail-cloudflare-migration-20261028/normal-server-folders-final-v2/verification.json` 的实际状态为准。
以前阶段的收据和候选保持历史冻结，不作为本切片源码的验证证明。

候选打包与本地迁移接线更新为 54 个顺序迁移；发布前应先备份并追加 0054，再升级 Worker/Web。
代码回滚时保留该表，由旧代码忽略，不 DROP 表、回退 schema 或清空目录及旧业务数据。
本切片不读取真实密钥、不连接真实邮箱、不发信、不部署 Cloudflare、不修改 NAS，也不提交、推送或合并分支。
下一步仍需每服务器文件夹独立身份/UID epoch/cursor、收件存储和阅读接入，远端移动/删除另行处理。
