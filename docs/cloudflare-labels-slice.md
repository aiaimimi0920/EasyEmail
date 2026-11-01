# 标签与批量整理（W2）

本切片面向 Cloudflare 聚合平台，网页与开放 API 共用 D1 规则。不是桌面插件，也不依赖 NAS。
它只修改平台整理数据，不访问供应商，不执行远端删除、远端文件夹移动或永久清除正文。

## 标签与权限

- 标签归用户私有，每用户最多 100 个活跃标签，一封邮件可有多个标签。
- 名称先做 NFC、首尾去空格，再做简单 Unicode lowercase 名称键；不是完整 Unicode case folding。
- 名称为 1–40 个 Unicode 码点，不允许控制或格式控制字符。颜色仅有 blue/green/orange/purple/gray。
- `labels:read` 允许读取标签和标签筛选；`labels:write` 允许创建、编辑和删除标签定义。
- 单封标签列表还需 `messages:read`；打标需 `messages:write` 与 `labels:read`，不要求编辑定义权限。
- 批量移入或移出平台回收站另外需要 `messages:delete`。网页登录写入仍校验 Origin。
- 不改写旧 API Key scopes，旧邮件 summary/detail JSON 不新增标签数据，旧只读调用方不被自动扩权。

## 接口

| 接口 | 合同 |
| --- | --- |
| `GET /api/v1/labels?limit=100&cursor=UUID` | 按 ID 分页，仅活跃标签；默认 25，最大 100 |
| `PUT /api/v1/labels/:uuid` | `{name,color,expectedRevision}`；创建版本 0，后续版本 CAS |
| `DELETE /api/v1/labels/:uuid` | `{expectedRevision}`；同一事务清关联、清名称并保存删除墓碑 |
| `GET /api/v1/mailboxes/:box/messages/:message/labels` | 返回此用户此邮件的活跃标签 |
| `GET /api/v1/messages?labelId=:uuid` | 聚合收件箱标签筛选；游标绑定用户及标签条件 |
| `POST /api/v1/messages/organize` | 强制 UUID `Idempotency-Key`，提交下述批量命令 |
| `GET /api/v1/organization/:key` | 只读持久化回执；需要原操作的全部 scopes |

批量命令示例：

```json
{
  "messageIds": ["11111111-1111-1111-1111-111111111111"],
  "isRead": true,
  "starred": false,
  "archived": true,
  "addLabelIds": ["22222222-2222-2222-2222-222222222222"]
}
```

`messageIds` 必需，1–50 个唯一 UUID。布尔值是显式赋值，不是 toggle；省略表示不修改。
可选 `trashed`、`removeLabelIds`；add/remove 各最多 20 个唯一 ID，不能交叠。
空操作、未知字段、重复 ID、无效或重复筛选参数均拒绝。统一请求正文上限仍为 8 KiB。

## 一致性与失败

标签创建配额、名称唯一性、版本比较在 D1 写入时判定。
同一个紧邻版本、同名称和颜色的保存可重放，用于恢复丢失响应；后续版本不能被旧保存覆盖。
删除墓碑阻断旧 ID 复活；删除后可以另用新 UUID 创建同名标签。

批量整理在同一个 D1 batch 内：先验证所有邮件归属且未 purged、所有标签归属且未删除，
插入持久 guard；随后所有整理写入受本次随机 operation ID fence 约束，最后完成回执。
任一目标无效时返回 `organization_target_changed`，本批无部分成功；SQL 故障整批回滚。
使用 `json_each` 绑定有限 ID 数组，避免最大批次超过 D1 单语句参数数量。

同 Key 同规范化命令只返回原回执，不重新执行，所以旧重试不会覆盖后续整理。
同 Key 不同命令返回 `idempotency_conflict`。数组顺序不影响规范化结果。
回执保存 Key、hash、权限、数量与时间，不保存正文、标签名或完整邮件 ID 数组。
没有自动清除幂等回执的策略，避免误删 guard 后旧 Key 被重新执行；规模保留策略仍需单独设计。

## 网页

聚合页提供标签管理、筛选、多选、当前加载页全选与批量工具栏。单封详情可添加和移除标签。
跨页可手工选取已加载邮件，最多 50 封；“选择当前页”只选最近加载的一页，不包含之前页。
搜索或刷新清空选择，慢旧列表响应不能覆盖新查询。

丢失标签保存响应时保留原 UUID、版本和内容，禁改输入，使用“核对原标签操作”。
批量结果未知时保留原 Key 与正文并禁改选集，使用“核对并完成原整理”；工作台内切换视图不会丢失该批状态。
这些未决请求是当前浏览器内存状态，不承诺关闭页面或刷新后的自动恢复；应保留显示的整理 Key，
必要时通过只读回执接口核对。平台整理没有外部邮件投递副作用，不将此边界泛化到发送流程。

## 迁移、回退与证据

新增 `0015_labels_organization.sql`，仅 expand：labels、message_labels、organization_operations 与索引。
先应用迁移再启动新运行时。旧运行时可继续读取旧表、写旧 flags，不会删除新标签或回执；
回退运行时代码时保留新表，不执行逆向 DROP，不清理旧数据或 API Key。
新旧运行时混用时显式 flags 写入仍是最后提交者生效，不宣称全局版本化整理。

当前源码的正式结果以证据目录 `labels-final/verification.json`、`labels-platform/verification.json`
及 `labels-final/closeout.json` 的实际 status 为准；不沿用 W1 的通过状态。
测试包括真实 workerd/D1、升级保留、并发配额、故障回滚、目标变化竞态和真实 Chrome 丢响应场景。
没有生产部署、真实供应商调用、生产负载或公网验收。
自定义文件夹、会话、联系人、订阅、普通邮箱与 Agent 模块仍未在此切片完成。
