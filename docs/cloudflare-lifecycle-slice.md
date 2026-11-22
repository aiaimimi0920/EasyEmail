# Cloudflare 平台生命周期切片（M3d）

本切片实现用户邮箱的停用、启用、释放平台访问，以及邮件回收站、恢复和永久清除平台缓存。
开发只使用迁移 worktree、本地 workerd/D1 和合成邮件；没有访问或删除生产邮箱、数据及凭据。
它不代替远端删除、上游到期检测、管理后台或生产保留策略，整体迁移目标仍保留这些工作。
本文保留 M3d 的阶段边界。后续 M3j 已在本地补充自营邮件条件远端删除，见 [远端删除切片](cloudflare-remote-delete-slice.md)；
后续 M3k 也已接通本地[条件远端邮箱删除](cloudflare-mailbox-delete-slice.md)。M3d 平台动作语义不变，真实环境验收仍未完成。

## 1. 先区分平台状态与上游资源

| 操作 | 平台行为 | 上游行为 |
| --- | --- | --- |
| 暂停平台同步 | 阻止新的同步，原功能保留 | 无变化，发送不受此开关限制 |
| 停用邮箱 | 阻止新的同步、发送 reservation、附件下载，缓存仍可读 | 不停用上游地址 |
| 启用邮箱 | 恢复平台外部操作资格，保留原 paused 状态 | 不创建、续期或恢复远端邮箱 |
| 释放平台访问 | 清除平台保存的邮箱凭据，取消同步 lease，不能从平台恢复 | 不删除上游地址，不撤销已外发的 JWT 副本 |
| 移到平台回收站 | 标记 trashed_at，默认列表、聚合 all、提取和回复源不再包含它 | 不删除上游邮件 |
| 恢复平台邮件 | 清除 trashed_at，保留原已读、星标及归档状态 | 无变化 |
| 永久清除平台缓存 | 清空该消息正文、主题、收发件人、附件 metadata 和 RFC Message-ID | 不删除上游原始邮件或附件 |

释放后邮箱仍在列表中，以明确的已释放状态保留地址和历史缓存。
收藏不改变上游有效期；任何平台状态都不延长第三方邮箱寿命。
M3d 当时没有自动到期或 purge 定时器；后续平台保留策略见 [M3f](cloudflare-retention-slice.md)，仍不能把“停用”标成“远端已过期”。

### 为什么本轮不直接接现有远端删除

亲读的自营合同在 `upstreams/cloudflare_temp_email/worker/src/mails_api/mails_crud.ts`：

- `DELETE /api/mails/:id` 受 ENABLE_USER_DELETE_EMAIL 控制，按 JWT address 与 id 删除。
- `DELETE /api/delete_address` 调用 deleteAddressWithData，具有连带数据删除行为。
- 现有合同不接收缓存消息版本的条件校验。先 GET 再 DELETE 仍有 ID 复用或内容变化的竞态。

不能将本地缓存版本的“删除当前邮件”无条件翻译成旧 ID 删除，也不能让管理员接口绕过用户归属。
M3d 当时 catalog 为 `remoteMailboxDelete: false`、`remoteMessageDelete: false`，不展示假远端删除成功。
后续 M3j/M3k 已补本地条件删除、稳定身份和持久化不确定结果；真实供应商及生产启用仍须独立验收。
Temporam 同样没有在当前实现中接入远端删除。

## 2. HTTP 与权限

| 方法和路径 | 请求与权限 |
| --- | --- |
| `POST /api/v1/mailboxes/:id/lifecycle` | action=disable/enable，需要 mailboxes:write |
| 同上，action=release | 需要独立 mailboxes:delete，confirmAddress 必须精确匹配该邮箱地址 |
| `DELETE /api/v1/mailboxes/:box/messages/:id` | 移入平台回收站，需要独立 messages:delete |
| `POST .../messages/:id/restore` | body={}，需要 messages:delete |
| `POST .../messages/:id/purge` | confirmMessageId 必须精确匹配，且消息已在回收站，需要 messages:delete |
| `GET /api/v1/messages?folder=trash` | 读取当前用户回收站，需要 messages:read |

会话写操作继续要求精确 Origin；API Key 不依赖 Cookie 或浏览器 Origin。
全部资源操作同时约束 user_id、mailbox_id、message id；跨用户和不存在均不泄露为不同结果。
旧 Key 的 scope 不自动增加。删除 scope 也不隐含读取、发送或创建能力。
Web 明确提供清理缓存和释放平台访问两种 Key 权限选择。

消息生命周期响应返回 lifecycle.id、trashedAt、purgedAt 和 upstreamChanged=false。
GET 详情增加 trashedAt；永久清除后详情、附件和普通整理 PATCH 均为 404。
回收站内详情仍可读、可下载已核验附件，但不能作为新回复的源。
聚合 folder=all 明确指不含回收站的全部缓存邮件；purged tombstone 在所有列表和搜索中不可见。
邮箱 metadata 增加 disabled、disabledAt、releasedAt，不覆盖已有上游 status 字段。

## 3. 写入时序与并发

- 停用、启用和释放只在状态转换时更新 sync_revision、清除 sync_token/lease。
  重复的 no-op enable 不取消后来取得的同步 lease。
- 同步 acquire、缓存 UPDATE/INSERT 和同步完成语句都检查邮箱 active、未停用、未释放。
  旧异步请求不能在转换后写入消息或覆盖后继 lease。
- 创建 outgoing reservation 的同一条原子 SQL 同时检查邮箱可用和回复源未删除。
  不能只在请求开始检查，再在停用/释放后无条件创建发送任务。
- 已经 reservation 的发送属于进行中的请求，停用/释放不伪造取消结果。
  它可能随后被渠道接受；相同幂等键始终回放原 guard，不再次派发。
- 下载在上游取件后、返回字节前再次检查邮箱和消息是否仍可用。
  等待期间停用、释放或 purge 后，不返回该二进制响应。
- purge 与 restore 的 SQL 条件再次检查互斥状态，不能恢复已清除内容。
- 数据库写入失败保持凭据或内容不变；不会先清除再返回失败的部分结果。

这不是全局取消协议：已经返回客户端的数据、已经派发的邮件和其他持有者的上游凭据不能追回。

## 4. 数据 expand 与保留边界

新增 `0006_lifecycle.sql`：mailboxes.disabled_at/released_at、messages.trashed_at/purged_at 及回收站索引。
0001–0005 不改写，不删除已有消息 ID、用户、会话、Key、凭据或发送记录。

purge 保留最小去重 tombstone：用户与邮箱关联、消息/远端 ID、fingerprint、附件版本和时间等。
缓存 UPDATE 不回填已 purge 的行；再次同步相同内容不会复活已清除的正文或 metadata。
相同远端 ID 下确实出现不同内容/附件版本时，仍按既有版本规则成为新的观察记录。
这不是承诺永远忽略该远端 ID 的后续新信。

保留 tombstone 是为了去重和 outgoing.reply_message_id 外键；保留发送 guard 是为了幂等和配额。
不能通过清除缓存或释放邮箱重置发送计数，也不能让未知发送结果失去防重放记录。
因此本操作叫“清除平台缓存”，不是完整账号隐私擦除或物理数据库文件擦除。
整体数据保留、guard 压缩与生产清理仍待独立设计和验收。

原服务仍使用自己的目录和数据。回退继续使用原部署，不将旧 Worker 直接接到启用了新生命周期语义的 D1。
旧 Worker 不认识这些标记，不能保证回收站过滤和停用约束；开发数据库不做 contraction。
发布阶段必须协调 schema expand 与对应 Worker 版本，不允许旧版继续承接新生命周期写入。

## 5. Web 与验证

单邮箱和聚合阅读共用邮件操作组件。移入回收站、永久清除均有即时确认，取消不发送写入。
释放要求输入完整邮箱地址，明确不可恢复及不删除上游的含义；其他页面切换不丢失创建/发送待确认状态。
返回邮箱页重新读取缓存列表及 metadata，不隐式同步供应商，避免展示另一入口已删除的旧结果。

回归覆盖双用户、独立 scope、Origin、幂等、升级保留、暂停与停用区分、sync lease 竞态、
下载竞态、发送进行中释放、guard 重启回放、D1 故障原子性、去重复活及 Chrome 确认/取消/移动端。
当前阶段完整收据：
`C:\Users\Public\nas_home\AI\GameEditor\linshi\easyemail-cloudflare-migration-20261028\m3d-final\verification.json`。

未验收真实供应商删除、生产 TTL/保留策略、管理后台、公开部署或完整迁移目标。
