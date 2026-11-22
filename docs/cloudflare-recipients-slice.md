# W7：多收件人、抄送和密送

本切片扩展写信、云端草稿与私有发送记录，不代表附件发送、定时队列或真实投递已完成。
仅在 `C:\Users\Public\nas_home\EasyEmail` 的 `migration/cloudflare-web` 开发，不部署或操作生产邮箱。

## 官方合同核验

2026-10-29 联网读取 Cloudflare 官方 [Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)、
[收件人示例](https://developers.cloudflare.com/email-service/examples/email-sending/recipients/) 和
[发送限制](https://developers.cloudflare.com/email-service/platform/limits/)。
结构化 binding 支持 To/CC/BCC，三类地址合计最多 50 个。BCC 使用独立发送字段，不拼接可见 To/CC 或自定义 Bcc 头。
这不证明任意既有部署已启用 Email Sending、域名授权或适当的 binding；真实渠道需独立验收。
上游已有 `/admin/send_mail_by_binding` 转交结构化字段，本切片不另造发送服务。

## API 与能力

```json
{
  "to": ["one@example.test", "two@example.test"],
  "cc": ["copy@example.test"],
  "bcc": ["private@example.test"],
  "subject": "示例",
  "text": "纯文本正文"
}
```

- 沿用 `POST /api/v1/mailboxes/{id}/outgoing`、`messages:send` 和 `Idempotency-Key`。
- `to` 兼容原来的单地址字符串，也可传非空地址数组。CC/BCC 是可省略的数组，空数组等价于省略。
- 单地址仅接受原有 ASCII addr-spec 子集；不接收显示名、逗号列表字符串、任意 headers 或 HTML。
- 去重前三类地址合计不得超过 50；仍受整个 JSON 请求 8 KiB 限制，未扩大正文或主题限制。
- 域名转小写，保留首个地址的 local-part 大小写；按不区分大小写的 To → CC → BCC 顺序去重。
  跨列表重复只保留首个位置，优先已公开的 To/CC，不会把 BCC 地址额外拼入可见头。
- 保存草稿沿用 `PUT /api/v1/drafts/{id}`。原有未完成单 To 字符串仍可保存，但未完成地址不能发送；
  显式地址数组及 CC/BCC 必须是有效地址，空 To 草稿用原来的空字符串表示。
- 详情/列表的 `to` 在单地址时仍为字符串，多地址时为数组；`cc`、`bcc` 返回数组。调用方应按联合类型读取。
- catalog 增加声明性 `multipleRecipients`：只有已配置发送白名单的 binding 模式为 true，
  不代表真实渠道可用或邮件送达。`worker` 模式明确返回 `409 multiple_recipients_unavailable`，不循环扇出、不降级丢地址。
- 逐个校验所有实际 To/CC/BCC 地址的允许策略；仅允许 To 不会隐式允许 CC/BCC。没有管理员回退。

## 原子性、成本与幂等

原有用户分钟/UTC 日 `3/20`、平台分钟/UTC 日 `10/200` 预算不扩大，但改为实际去重收件人数。
单次多收件人必须整体装入剩余预算；因此协议能表达 50 个地址不表示当前用户可一次发 50 个。
所有 pending/accepted/rejected/unknown 预约都扣 recipient cost，不因拒绝、断连或清理退费。
权重 SUM、邮箱/回复/供应商版本/草稿内容围栏与唯一幂等 guard 仍在同一原子预留中。

原单 To 的五元 hash 数组和草稿发送追加 id/revision 顺序精确保留。
单元素 To 数组、空 CC/BCC 规范化后等价于旧请求；真正多收件人追加版本化 CC/BCC 内容。
任何实际地址变化影响内容 hash。已存在发送 key 先回放，再检查当前草稿/邮箱，清理或过期不导致重新发送。
草稿消耗与发送预约同一 D1 batch；失败整批回滚，两个新 key 不能重复消费同一草稿。

只有一次 provider 请求和一次结构化发送，不建立隐式重试队列。
`accepted` 仅代表渠道接收，`delivery=unconfirmed`、`retrySafe=false`；未知结果不重试或换通道。

## 存储、隐私、升级与回退

`0020_outgoing_recipients.sql` 仅扩展 outgoing/drafts 的 `recipients_json`，outgoing 另增 `recipient_count`。
旧行 JSON 默认为 NULL，成本默认为 1，保留全部旧内容、hash、版本和 tombstone。
单 To 仍存旧列，先进内容保存在 JSON；不通过迁移重新计算旧 hash。

所有草稿、记录、发送回放仍校验 owner/read/write scope；BCC 只在所有者私有记录中展示。
删除草稿同时清 JSON、原 To 和正文；outgoing retention 同事务清所有 To/CC/BCC，
但保留原 key/hash、状态、recipient cost 等最小防重放和预算数据。GET 不触发发送或清理。
不把内容清理描述为所有数据永久擦除，也不删除收件人外部副本。

未来升级先应用 20 条迁移，再排空旧发送/草稿/retention writer，切换所有读写到新版本后启用此能力。
混用旧 writer 会漏扣权重、丢失 CC/BCC 或遗漏 PII 清理，因此不支持混合写入。
回退保留扩展列与 guard，暂停发送、草稿读写和旧版对新格式记录的展示；不能让旧 UI/旧 writer 再消费多收件人草稿。
本轮只使用隔离本地数据库，不执行生产迁移或实际回退。

## Web 与验证边界

写信页 To/CC/BCC 使用逗号分隔编辑；联系人可选目标字段、替换或追加，修改后必须重新确认发送。
云端草稿保存/恢复三类收件人；失响应后的原 key/body 在工作台导航内保持，所有地址编辑锁定。
不使用 localStorage/sessionStorage，不承诺跨浏览器刷新恢复内存中的未决发送。
不支持的通道保留草稿内容并禁用发送，不清空 CC/BCC 冒充支持。

专项测试覆盖旧 schema/hash、历史 key/草稿回放、输入/体积/白名单、权重预约并发、
草稿竞态/事务回滚、状态存储失败、retention 故障回滚、owner 隔离、Chrome 跨设备/失响应/390px。
双完整 Worker 执行真实上游发送 handler，将结构化 binding 替换为测试捕获器，验证地址与真实源邮件引用字段的端到端透传。
该捕获器不是公网发信、Cloudflare 实际生成的 MIME 或收件端头部隐私验收。
完整收据保存在 `linshi/easyemail-cloudflare-migration-20261028/recipients-*`，失败记录保留。

尚未完成：附件上传/发送、可靠队列/定时/取消、真实退信/投递事件、普通邮箱、Agent、更多供应商、生产与真实邮件验收。
