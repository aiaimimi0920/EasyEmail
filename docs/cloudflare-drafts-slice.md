# W1 云端草稿与跨设备恢复

## 范围和所有权

草稿属于 Cloudflare EasyEmail 的用户数据，保存在聚合 D1；不写入自营或第三方供应商，不保存供应商凭据。
网页和开放 API 共用 CRUD、版本及发送规则。用户显式点击“保存云端草稿”；没有自动保存承诺。
不使用 localStorage/sessionStorage 保存正文或发送键。未保存的内存编辑在完整刷新后仍可能丢失。
本切片不表示第一阶段公网验收已完成，也不包含 HTML 编辑、抄送/密送、附件发送或可靠调度队列。

## API 合同

所有路径以 `/api/v1` 为前缀。会话写入要求精确 Origin；程序使用 Bearer Key。
新增独立 `drafts:read` 和 `drafts:write`；旧 Key 不自动扩权，草稿写权限不包含发送权限。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /drafts?limit=25&cursor=...` | `drafts:read`；当前用户未删除记录，含 editing/submitted；列表不返回正文 |
| `GET /drafts/:id` | `drafts:read`；当前用户完整草稿，其他用户和已删除记录均 404 |
| `PUT /drafts/:id` | `drafts:write`；完整替换内容，以 expectedRevision 做 CAS |
| `DELETE /drafts/:id` | `drafts:write`；JSON expectedRevision，清空内容并保留防复活墓碑 |

客户端生成 UUID `id`。创建用 `expectedRevision: 0`；成功为 201/revision 1。
更新用已读取的版本，成功后加一；版本过时、已经提交或已经删除返回 409，不覆盖新内容。
相同预期版本和相同规范化内容，若当前版本恰为预期加一，可回放已保存结果，便于恢复丢失的响应。
它不是任意历史操作日志：后续版本已变化时返回冲突，需 GET 核对。
删除重放仅在当前墓碑恰为预期加一时成功；同一 ID 不可重建。

PUT 字段：

```json
{
  "expectedRevision": 0,
  "mailboxId": null,
  "to": "",
  "subject": "",
  "text": "",
  "replyToMessageId": null
}
```

允许未完成的收件地址、空主题/正文和未选择发件邮箱。非空 mailboxId 必须属于当前用户；
replyToMessageId 必须是同用户、同邮箱且未清除的缓存消息。保存不要求邮箱仍可发信，防止到期后无法取回正文。
to/subject/text 上限为 254/200/6000 字符；to 和 subject 禁止控制字符，text 禁止 NUL，未知字段拒绝。
JSON 总计仍受 8 KiB UTF-8 限制；非 ASCII 内容可能先达到字节上限。保存不是发送验证。

每用户最多 100 份未删除记录，editing/submitted 都计数，原子 INSERT 检查，不因并发超限。
列表按 `(updated_at DESC,id DESC)` keyset 分页，limit 1–100，游标只属于该用户。
分页不是强一致快照；其他设备修改或删除记录后应刷新。未知/重复查询参数拒绝。

## 与发送的原子关联

既有 `POST /mailboxes/:id/outgoing` 新增可选配对字段 `draftId`、`draftRevision`。
未提供配对字段时原请求 hash、配额和幂等语义保持不变。
提供时必须同时具备 `messages:send` 和 `drafts:write`，且请求内容与保存版本完整相等。
正常邮箱/供应商/收件允许列表/回复来源/配额检查仍全部执行。

D1 事务同时创建 outgoing 预留并将对应草稿从 editing 改成 submitted，记录 outgoingId、版本加一。
只有成功预留者执行一次外部发送。授权读取后，另一设备修改/删除也由提交 SQL 的版本和内容 hash fence 阻断。
事务失败时没有外部发送；供应商调用发生在事务之后。

submitted 只表示提交，不表示送达。pending、accepted、rejected、unknown 均不自动恢复为可编辑草稿。
同草稿换一个发送 Key 不会再次 dispatch；相同原 Key 仍可核对原 outgoing，包括草稿记录删除后。
未知结果保留旧 Key，不自动重试、退配额或切换渠道。另起一封邮件是独立显式操作。

## 网页行为

写信页提供保存、云端记录列表、打开、刷新、核对版本及显式确认删除。
首次保存响应丢失也保留该草稿 UUID，重复保存不创建第二份记录。
冲突保留本地编辑，核对云端前允许取消或确认放弃未保存修改；不提供静默强制覆盖。
恢复 submitted 记录只读，不能作为新草稿直接再次发送；可核对发送历史或明确新建另一封。
当前发送尝试未决时禁止切换/保存/删除草稿，仍允许使用原发送键核对结果。
新建、替换当前未保存内容或删除草稿有即时确认；不把认证链接或邮件内容当作操作授权。

## 数据升级与回退

`0014_cloud_drafts.sql` 只新增 drafts 表和索引，不改写既有表/记录，不删除发送 guard。
先应用扩展迁移再启用新运行时；回退旧应用保留新表，不做 DROP/数据回滚。
删除草稿清空收件地址、主题、正文、邮箱/回复引用和内容 hash；保留用户/ID/版本/状态/时间和 outgoing 关联。
不宣称物理擦除 Cloudflare 备份，也不撤回供应商或收件人持有的已发邮件。

## 验证与边界

用 workerd/D1、合成供应商和独立 Chrome 验证真实 API/网页。覆盖持久化、CAS、双用户、独立 scope、
配额并发、删除防复活、存储回滚、版本读取后竞态、丢失响应和跨设备恢复。
既有发送 Key 合同、未知发送保护及迁移数据保留必须回归，不用草稿 CRUD 通过代替发送安全。
正式收据为隔离证据根 `drafts-final/verification.json`，以实际 status 为准。
没有生产部署、真实邮件投递、生产负载或成本验收。
