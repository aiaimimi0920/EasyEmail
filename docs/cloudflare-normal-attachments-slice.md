# W10o 普通邮箱发送附件

## 范围

普通邮箱 Web/API 写信、回复及云端草稿复用现有私有 Outbox 上传资源，通过唯一普通 SMTP 写信器发送附件。不另建上传服务，不增加真实账号认证或公网发送，不改变现网。

已有上传限制保持不变：每文件 1 字节至 2 MiB、每封最多 5 个、原始附件总量 3 MiB，上传资源保留 24 小时。保存草稿不续期、不锁定资源；未来发送必须再次验证。SMTP 实际序列化结果另受 5 MiB 限制。

## 请求和权限

以下既有路由接受可选 `attachments: [{ id, version }]`，不接受客户端文件名、MIME type、字节或其他 manifest 字段：

```text
PUT /api/v1/normal-accounts/{accountId}/drafts/{draftId}
POST /api/v1/normal-accounts/{accountId}/send
```

非空附件必须额外具备 `attachments:read`；上传、核对上传及删除资源仍独立要求 `attachments:write`。普通草稿/发送/回复原有权限保持。Web 新增普通附件 API Key 预设，不扩大已有 Key 或旧预设的权限。

资源必须属于当前用户，引用必须具有精确不可变版本，且 ready、未过期。实际 R2 读取核对大小、对象版本、etag、长度及 SHA-256，不能只信数据库摘要。附件准备与完整 MIME 构造均发生在发送预约、配额扣取与草稿消费之前；最终 INSERT 再使用 SQL resource fence。

缺省附件和空数组语义相同，保持 W10n 及之前的无附件请求 hash、草稿 hash、MIME 字节和无附件 outgoing 响应形状。非空附件只条件追加版本化的有序引用。回复仍使用服务器从原信校验出的线程头，附件不改变来源 fence。

## MIME 与发送结果

有附件时使用 `multipart/mixed`，第一段为原纯文本正文，附件字节沿用已校验的 base64，按 76 列折行。文件名使用 RFC 2231 continuation，按 Unicode code point 切分扩展参数，避免超长头、参数注入和切断 UTF-8；不同时提供同名 plain filename，避免当前 PostalMime 优先采用 fallback 而丢失 Unicode 名字。无附件仍走旧序列化分支。

BCC 只出现在 SMTP envelope，不写入 MIME。最终接受仍仅表示 SMTP 服务器接受，不表示已投递。DATA 后连接不明、最终响应不明或完成写回失败，沿用 unknown/no-repeat guard；不自动重发，不更换操作键。

## 存储与生命周期

`0034_normal_attachments.sql` 仅扩展两列，不重建或回写旧表：

- `drafts.normal_attachments_json`：普通草稿私有 manifest；非空时必须是普通来源及有效 JSON array。普通草稿继续保证旧 `attachments_json IS NULL`，保留 0032 的 source CHECK。
- `normal_outgoing_messages.attachments_json`：预约时持久化 manifest；不保存 raw bytes。

共享删除/到期/inventory 清理的 `NO_PENDING_ASSET` 同时保护普通 pending 引用，按用户、ID 和 version 匹配。普通 pending 到龄转 unknown 后解除持有；accepted/rejected/unknown 不永久阻止清理。普通 outgoing retention 清 manifest 与内容，但保留 request hash、配额及永久防重复 guard。删除草稿清普通附件引用，保留墓碑。

同键回放先于附件/R2/草稿/账号重新验证，因此资源过期或清理、草稿删除、服务重启后，原发送仍可读回，不重新发信。改附件或顺序则是不同内容，同键冲突。

## Web 状态

复用 `OutboxAttachments` 的原上传操作键核对、丢响应恢复、到期状态和显式移除引用。上传未决时同步阻止发送、新回复、另起邮件、云草稿替换及账号切换。附件引用进入不可变 attempt，原发送核对只做 GET，不重新读取当前可变草稿。

保存/核对同一组附件不重置已完成的 readiness；重开不同引用才等待重新核验。过期附件保留可见引用并禁发，用户必须显式移除或重新上传；已保存草稿内容变化后仍须重新保存才能发送。

## 验证和发布边界

同源码正式收据：`linshi/easyemail-cloudflare-migration-20261028/normal-attachments-final/verification.json`；独立本地平台收据：`normal-attachments-platform/verification.json`。以生成收据的实际状态和计数为准，不用历史切片绿灯代替本轮验证。

新增测试覆盖实际 multipart 二进制、五文件和长 Unicode 文件名、无附件精确兼容、权限/归属、R2 损坏/丢失、大小限制、附件/草稿竞态、pending 清理保护、unknown/写回失败后原键恢复、retention、33→34 保数据扩展、Chrome 原上传及原发送恢复。

启用前必须先应用 0034，并排空旧普通草稿/发信写入方；不能让旧写入方忽略附件列后发送无附件邮件。回滚应保留新 schema、数据和所有发送 guard，停止新附件入口并使用对应备份/版本处理含附件意图，不能直接降级旧写入方继续处理它们。

本切片不包含普通发送队列、STARTTLS/OAuth2、远端多文件夹/flags、安全清理总控、真实 Cloudflare 发布、真实邮箱认证、公网投递或容量成本验收；不 commit、push、merge 或 deploy。
