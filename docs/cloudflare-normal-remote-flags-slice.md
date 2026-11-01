# 普通邮箱显式服务器已读与星标（W14a）

本切片把旧桌面单 UID 的 `\Seen` / `\Flagged` 操作迁移到 Cloudflare Web/API。
平台本地已读、星标、归档和回收站语义不变；阅读邮件不自动写远端。
W14a 当时仅覆盖 INBOX；后续[多目录远端标记（W14c3）](cloudflare-normal-folder-flags-slice.md)扩展到精确非 INBOX 目录。不包含 MOVE/COPY、删除、EXPUNGE、批量 flags 或 Agent 远端写，不代表整个普通邮箱或迁移已完成。

## API 与权限

新增 `mail-accounts:remote-flags`，并同时要求 `mail-accounts:read` 和 `messages:read`。
原 `messages:write`、普通同步及普通发信 Key 不自动获得远端标记权限。
会话 POST 还校验 Origin；API Key 校验所有权，并在最终派发前复核发起凭据是否撤销或到期。

```text
POST /api/v1/normal-accounts/:accountId/messages/:messageId/remote-flags
GET  /api/v1/normal-accounts/:accountId/messages/:messageId/remote-flags
GET  /api/v1/normal-accounts/:accountId/remote-flag-operations/:requestKey
```

POST 强制 `Idempotency-Key`，正文仅接受：

```json
{
  "expectedRevision": 1,
  "epochId": "11111111-1111-4111-8111-111111111111",
  "flag": "\\Seen",
  "value": true,
  "acknowledgedUnknownId": null
}
```

`flag` 只允许 `\Seen` 或 `\Flagged`；UID 由有权访问的当前缓存行解析，调用方不能注入 UID、文件夹、服务器或任意命令。
详情 DTO 新增 `accountRevision`，供四种详情入口提交真实版本，不从列表或 UI 猜测。
GET 是 D1 回执查询，不连 IMAP；返回 `operation:null` 表示当时没有登记，不保证另一个在途请求以后不会登记。

## 持久化、并发与结果

0053 仅新增操作表及索引，不迁移/改写现有 MIME、平台状态、收件检查点或旧临时邮箱表。
操作保留 user/key 唯一约束、规范请求摘要和按消息递增的序号；累计每用户最多 10000 条，并有用户及全局速率上限。
这些最小 guard 不因回收内容而删除；上限不是“连续收件”额度，也不伪报无限历史容量。

在任何外部连接前预约；相同 user/key/body 仅返回原回执，不重复连接、STORE 或 OAuth 刷新。
同键不同请求返回 409。预约 INSERT 响应丢失时只读核对；即使读到自己已存在的 pending，也不据此重获执行权。
同一消息的不同 key 用最新操作 ID 在 INSERT 内 CAS，pending 阻止新意图，其他消息不共用永久锁。

状态为 `pending`、`confirmed`、`failed`、`unknown`，所有回执 `retrySafe:false`。
`failed` 表示最终未记录派发，`unknown` 表示派发/存储结果不确定；二者不因 HTTP 200 就变成成功。
pending 超过 60 秒对外呈现 unknown，不自动执行；同键永久不能再次执行。
另起新意图必须提交**最新** unknown 的准确 `acknowledgedUnknownId`，网页要求显式勾选风险确认。
这不是重试旧命令或撤回旧命令，也不能保证服务器处理时序、其他客户端或外部网络的延迟。

## 协议与最终派发

复用现有 TLS / STARTTLS、PLAIN / Google XOAUTH2 认证，保留旧 EXAMINE 只读读取链的命令顺序。
写链使用 SELECT INBOX，要求 READ-WRITE、唯一且匹配的 UIDVALIDITY、稳定 UID，以及明确包含目标系统 flag 的 PERMANENTFLAGS。
先 FETCH 精确 UID/FLAGS 确认目标存在，再记录派发，发出唯一一次 `UID STORE <uid> +/-FLAGS.SILENT (<flag>)`，最后精确 FETCH 核对结果。
合法服务器 keyword（例如 `$NotJunk`、`$Forwarded`）只作为有界响应数据保留，不成为可写请求参数。
不存在、身份变更、重复或恶意响应、NO/BAD、读后不匹配均不伪报确认。

派发记录的同一 SQL 核对 owner active、发起会话/Key live、账号 enabled/revision、OAuth 授权 fence、source hash、epoch、cache generation、UID/UIDVALIDITY、未清除且 committed 的消息和最新操作序号。
预约 30 秒后禁止派发；socket 总 deadline 15 秒，60 秒 unknown 窗口留出本地执行余量。
`assertActive` 使用绝对时限，且在数据库派发回调前后和实际写流前检查，防止超时后晚返回回调继续发送。
无法撤回已经交给外部服务器的命令；派发后的配置/权限变化不抹除历史事实。

confirmed 必须同时取得 STORE 完成与目标 flags 读回；只表示该次观察确认，不保证此后无人修改。
确认回执与 cached remote flags 同事务写入，但缓存更新还核对当前来源与不存在较新操作；旧执行者晚完成只保留自己的历史回执，不覆盖更新缓存。
原始内容观察时间和平台状态不被改写，单独用回执 finishedAt 显示本次标记观察时间。

## Web 与恢复

普通收件、聚合时间线、会话成员和订阅成员共用详情动作，按钮明确为“服务器标为已读/未读”和“服务器加/取消星标”。
稳定父级 provider 持有 immutable 原请求 key/body，跨详情卸载和导航保留；不向 localStorage/sessionStorage 写入。
网络错误、伪成功或回执不匹配时，不清除 held 请求、不换 key；可以只读核对，或显式重送**原 key/body**，后端仍只读重放已登记回执。
只有首次请求收到明确的后端预约前错误码/状态组合才解锁；未知的代理 4xx、408/429 超时和自相矛盾的 failed 回执均保留原键。
整页刷新后由服务端最新消息回执重新发现 pending/unknown，不自动 POST 或打开 socket。

## 本地验证与发布边界

测试入口是 `tests/normal-flags-{protocol,view,runtime,boundaries,storage,migration,web}.test.mjs`，已加入对应 package test 脚本。
使用真实 Worker/D1/R2/routes 和生产协议代码，仅构建期替换 socket 为显式合成 IMAP transport；数据库响应丢失由独立 test Worker 注入。
Chrome 验证四入口、平台/远端独立、响应丢失、伪成功、GET404 原键恢复、unknown 显式确认、权限预设、窄屏及无自动外连。
最终结果以 linshi 中 `normal-remote-flags-final/verification.json` 的实际状态与日志为准，不引用开发中红测为通过证据。

本切片未读取真实密钥、未连接真实邮箱、未进行公网 TLS/远端 flags 互操作或 Cloudflare 部署。
发布必须先在独立资源中备份并追加 0053，再升级 Worker/Web；回滚代码时保留新增表和 guard，旧 Worker 可继续忽略它们，不 DROP、回退 schema 或删除回执。
上一 W13a 候选与收据保留为历史冻结证据，不把它们当作包含本次新源码的候选；当前打包测试必须重新验证 53 个迁移。

协议参考：[RFC 3501](https://www.rfc-editor.org/rfc/rfc3501) 的 SELECT、PERMANENTFLAGS、UID STORE 和 flag/atom 语法。
该文档已被 RFC 9051 取代；这里沿用现有 IMAP4rev1 兼容基础，不声称完整 IMAP4rev2 实现。
