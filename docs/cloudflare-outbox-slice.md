# W8：私有发送附件

本切片迁移真实附件字节的 Web/API 路径，不是桌面本地文件暂存预览。
实现位于 `service/cloudflare`，使用可选的私有 `OUTBOX` R2 binding 和新增 `0021_outbox_attachments.sql`。
默认开发配置没有自动创建或绑定真实桶；缺失存储时显式不可用，不降级到 NAS、本地文件或无附件发送。
当前本地验证收据为 `outbox-final/verification.json` 和 `outbox-platform-r2/verification.json`，仅以实际 `status` 为准。
历史 W7 收据不覆盖本轮源码；本切片不等于整体迁移、生产发布或公网投递验收完成。

## 资源与权限

所有接口前缀为 `/api/v1`，资源归属于当前用户，不返回对象 key、公开下载 URL 或跨用户访问令牌。

| 接口 | 行为 | 权限 |
| --- | --- | --- |
| `GET /outbox-attachments` | 查询存储可用性和应用限额，不列出文件 | `attachments:read` |
| `POST /outbox-attachments` | 元数据预约，要求 `Idempotency-Key` | `attachments:write` |
| `PUT /outbox-attachments/{id}/content` | 上传真实二进制 | `attachments:write` |
| `GET /outbox-attachments/{id}` | 查看私有状态及元数据 | `attachments:read` |
| `GET /outbox-attachments/{id}/content` | 下载并核验原字节 | `attachments:read` |
| `POST /outbox-attachments/{id}/check` | 只读核验原对象，完成原 D1 预约 | `attachments:write` |
| `DELETE /outbox-attachments/{id}` | 持久终止后清理字节 | `attachments:write` |
| `POST /outbox-attachments/cleanup` | 有界清理自身资源，最多每分钟两次 | `attachments:write` |

会话写操作仍验证精确 Origin；API Key 显式授予 scope，旧 Key 不自动扩权。
带附件保存草稿还需 `drafts:write` 和 `attachments:read`；带附件发送还需 `messages:send` 和 `attachments:read`。
只读草稿/发送历史可以查看自己的清单元数据，但不因此获得文件字节读取权限。

元数据格式为 `{filename,mimeType,size,sha256}`，继续使用通用 8 KiB JSON 限制。
二进制只接受 `application/octet-stream`，拒绝非 identity 编码，按实际流量计数并核验 SHA-256；读取有 20 秒上限。
下载强制 `attachment`、`nosniff`、`no-store`，不以内联方式执行内容；文件名或摘要检查不是病毒扫描。

## 限额与生命周期

- 单文件 1 字节至 2 MiB；单封最多 5 个不同引用，原始字节总计最多 3 MiB。
- 发送前保守计算 base64、折行和头部/正文余量，不把收信下载限额当作发送预算。
- 固定 TTL 为预约后 24 小时，保存/打开草稿、重试上传均不续期。
- 用户未确认清理预约容量 16 MiB，平台 256 MiB；未完成上传也占预约。
- 用户上传最多滚动分钟 10 次、UTC 日 20 次；平台分别为 50 次、200 次。
- 所有预约限额和唯一键在同一 D1 `INSERT SELECT` 中检查，重复同键不重复收费。
- 删除/过期不立即退预约容量；只有 R2 清理及 D1 确认后才释放。保留防重放墓碑，不无限保存文件名。

D1 预约容量不是跨存储物理精确上限。D1/R2 没有共同事务；迟到 put 可能短暂产生孤儿对象，依靠补偿及有界库存核对回收。
每 15 分钟维护先将陈旧 pending send 标记为 unknown，再清理附件，最后执行原内容保留策略；W9 每分钟发送调度独立运行。
单轮最多处理 20 个终止/过期行，并扫描 20 个专用前缀对象；库存 cursor 持久保存在 D1。
只处理严格 UUID 形式的 `outbox/v1/<user>/<asset>`；缺失 D1 行的对象还须早于 TTL 加 300 秒，其他前缀不清理。
R2 lifecycle 不能假定已经配置；不承诺立即、全局或对收件人外部副本的删除。

## 不可变对象与失败恢复

资源 ID 和对象 key 永不复用；R2 使用 create-only 条件写，不覆盖已存在内容。
资源版本绑定 ID、文件名、媒体类型、大小和 SHA-256，而不是把 ETag 当成内容摘要。
草稿和发送请求只提交 `attachments:[{id,version}]`，服务端解析私有元数据；不接受客户端 base64、URL 或对象 key。

R2 写入成功但 D1 完成失败时返回未确认。`check` 只读取原对象核验并完成同一预约，不发送邮件、不分配另一资源。
客户端继续上传也保持原预约键和资源 ID；终止或到期行不可复活。
删除先将 D1 转为终止状态，再删除 R2；失败返回 202 待清理，可安全再次清理。
已终止后才完成的较早 put 会补偿删除，丢失补偿的对象由后续库存核对处理。

发送前读取/核验字节，实际 outgoing 预约事务再次检查 owner、version、ready、有效期、草稿、邮箱和供应商 fence。
pending outgoing 的持久清单 pin 住资源：发送预约先胜出，删除返回 409；删除先胜出，新发送无外部写入。
草稿引用不无限 pin 文件，用户删除或 TTL 可以让旧草稿附件不可用，须明确移除引用或重新上传。
显式 binding 通道只提交一次结构化发送；旧单地址 worker 模式提前拒绝，不剥离附件或循环拆信重试。
accepted 仍只表示渠道接收；unknown 不自动重发，删除附件不是撤回已经派发的邮件。

## hash、隐私与兼容

省略附件与空数组精确保留旧 W7/五元内容 hash 以及草稿 id/revision 的追加顺序。
非空引用在原内容 parts 后追加版本化附件段，资源不可变版本已绑定实际元数据和摘要。
原发送 key 在读取资源之前回放，因此文件清理后仍能核对原 accepted/unknown，不触发再次发送。
outgoing 和草稿只保留私有 manifest JSON，不在 D1 保存完整字节或第二份可变权威文件。
删除草稿清空引用；retention 与正文/收件人一起原子清空发送 manifest，保留最小 key/hash/配额 guard。

## Web

写信页提供真实文件选择、摘要与二进制上传、原上传核对/继续/取消、引用移除、有效期及不可用状态。
未决上传锁定保存、发送和切换草稿；已发起发送继续冻结原 key/body/附件引用。
不支持附件的通道保留引用并禁用发送；不得静默丢弃文件。
保存后可在另一浏览器打开同一用户草稿，文件仍须在原固定 TTL 内且资源有效。
从草稿移除引用不自动删除可能由另一份草稿使用的资源。
发送详情展示原 manifest，未把历史元数据说成字节永久可下载。
不使用 localStorage/sessionStorage 保存凭据、文件或未决操作。
未保存且刷新浏览器的文件选择/上传内存任务不承诺恢复，遗留预约由固定 TTL 回收；这不等于跨刷新可靠上传队列。

## 升级与回退

1. 先备份 D1 和独立私有 R2；新空环境应用全部 21 条迁移，已有 W7 环境只应用新增 0021。
2. 排空并停用旧发送、草稿、retention/scheduled writer，再启用新运行时；不支持新旧格式混合写入。
3. 配置专用私有 `OUTBOX` binding 后才启用上传。资源 provisioning、真实域名/渠道及生产部署均需独立批准。
4. 回退保留新增表、列、对象、cursor 和防重放 guard；关闭新上传/发送/草稿入口，不盲目恢复旧 writer。
5. 特别是旧 retention 不会清空 `attachments_json`，旧草稿 writer 也不理解附件 hash；不能只降镜像继续写。
6. 未决外部发送先核对，不通过重新发送探测结果；已有真实资源的清理单独审批，不自动 drop 表或删桶。

## 验证与未验边界

测试包含合成非 UTF-8/NUL 字节、2 MiB 上限、实际流量计数、摘要、权限/Origin、跨用户、容量并发、故障恢复、发送/删除竞争、分页清理、升级及旧 hash。
Chrome 测试实际选文件，丢上传/发送响应后核对原资源/原 key，恢复跨设备草稿，验证不支持通道、到期及移动端布局。
双完整 Worker 测试执行真实上游发送 handler，捕获合成 binding 的附件，逐字节及 SHA-256 检验 2 MiB 内容、文件名、类型、disposition、To/CC/BCC 和回复头。
该捕获不是真正 Cloudflare MIME 渲染、公网投递、收件端 BCC 隐私或反垃圾验收。
生产并发内存、CPU/计费、恶意文件扫描、公开注册抗滥用、真实 R2 故障和跨备份恢复尚未验证。
可靠队列、定时发送、普通邮箱、Agent、更多供应商、旧数据导入及独立真实环境验收仍在整体目标内。
