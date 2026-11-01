# M3m：账号管理与账号安全

## 范围

实现位于 `service/cloudflare`，仅用于迁移分支的本地 Worker、D1 和 Web。
管理员可搜索和分页查看用户、停用或启用账号、撤销目标用户全部凭据。
用户可验证当前密码并修改自己的密码。没有管理员重置他人密码、授予管理员角色、
邮箱验证、找回密码、OAuth、MFA 或公开注册策略。

Web 的“平台管理”包含用户管理和独立账号审计；“账号安全”提供改密码。
有风险的管理动作要求完整用户名确认，携带 `expectedRevision`。
版本冲突清除旧确认、刷新用户数据并要求重新确认，不自动重放写入。
成功修改密码或撤销自己的凭据后，清除 Cookie 和页面账号状态，回到登录页。
密码和 Key 不写入 localStorage/sessionStorage。

## HTTP 合同

| 方法与路径 | 权限与参数 |
| --- | --- |
| `GET /api/v1/admin/users` | 管理员会话；`q` 用户名子串、`status=active/disabled`、`limit`、`cursor` |
| `GET /api/v1/admin/users/:id` | 管理员会话；安全 metadata、revision、邮箱和有效凭据数量 |
| `GET /api/v1/admin/users/audit` | 管理员会话；可选 `userId`、`limit`、`cursor` |
| `POST /api/v1/admin/users/:id/status` | 管理员会话、精确 Origin；`status`、`expectedRevision`、`confirmUsername` |
| `POST /api/v1/admin/users/:id/revoke-credentials` | 管理员会话、精确 Origin；`expectedRevision`、`confirmUsername` |
| `POST /api/v1/account/password` | 用户会话、精确 Origin；`currentPassword`、`newPassword` |

API Key 不能调用账号管理或改密码接口，也不因所属账号为管理员而扩权。
管理员不能停用自己；可以撤销自己的全部会话和 Key，此时响应清 Cookie。
重复的同状态修改是 no-op，不新增审计、不撤销凭据；显式撤销始终推进 revision。
过期或冲突的 revision 返回 `409 account_state_changed`，不能覆盖较新的动作。
不存在的目标为 404；错误完整用户名为 `400 account_confirmation_required`。

用户列表和审计使用 UUID 字典序 keyset，不承诺时间顺序或一致性快照。
不返回密码 hash、token hash、原始 Cookie、Key、邮件正文或供应商秘密。
改密码每用户每分钟最多五次；新密码为 15–128 个 UTF-16 code units，UTF-8 最多 512 字节，
保留空格和 Unicode，不 trim。KDF 与现有注册使用相同的 scrypt 参数和独立随机 salt。

## 原子性与在途边界

新增 `0013_account_management.sql`，仅增加 `account_revisions`、`account_audit` 和索引，
不修改现有身份表列或旧数据。未建立 revision 的用户视作版本 0。
状态或密码写入、会话撤销、Key 撤销、revision 和最小审计在同一个 D1 batch 中完成。
任一 SQL 失败整批回滚，不允许只停用不撤销或只改密码不记审计。

batch 首句同时核对目标版本、有效源会话、当前管理员资格或旧密码 hash，
以本次唯一审计 marker 约束后续全部写入。两个管理员互相停用不能都获胜。
登录 INSERT 再核 active 状态和 KDF 使用的密码 snapshot；Key INSERT 再核源会话。
停用/重新启用不恢复旧凭据；启用后可用正确密码重新登录。
密码未改变且账号已重新启用时，持正确密码的在途登录可以成为新的认证，
这不等于旧会话复活。会话上限清理只在本次登录实际创建新会话后进行。

账号停用不删除邮箱、缓存、创建/发送/删除 guard、配额和历史。
已经完成鉴权或已经派发的同步、发送等业务请求可能继续完成；
本切片不实现所有资源写入的全局在途取消，也不承诺撤回已交给供应商的请求。
账号审计追加保留，不自动按邮件正文策略清除；完整隐私擦除另行设计。

## 升级与回退

这是 expand-only 结构升级，应用迁移时必须保持现有身份和资源记录不变。
先备份，先应用 0013，再完整升级或排空旧版本的登录/Key 签发实例，最后启用管理动作。
旧签发代码没有新的提交时 fence，不支持在新管理动作已启用后任意新旧混跑。
若回退应用，可保留新增表，不能删审计或清除 revoked 标记来“恢复”登录。
回退到旧签发代码前须关闭账号管理入口并排空相关在途请求；不以代码回退恢复已撤销凭据。

## 本地证据边界

回归覆盖真实 workerd/D1/HTTP、独立 Node scrypt、停用/启用/重启、凭据永久撤销、
版本竞态、审计/末尾 revision 故障回滚、旧 schema 升级及 Chrome 操作。
竞态测试入口只在 `tests/account-gated-worker.ts` 中暂停真实 SELECT snapshot，
不注入生产 Worker，不模拟成功鉴权，不替换 KDF 或 D1 的写入事务。
测试数据和截图存于 linshi；完整结果以独立验证收据为准。

本切片不代表生产发布、真实供应商创建/投递、完整上游 Worker 验收或整体迁移完成。
