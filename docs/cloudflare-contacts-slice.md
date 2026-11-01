# 用户私有联系人（W4）

本切片将旧 base 通讯录的核心合同迁移到 Cloudflare D1、Web 与开放 API。
联系人独立持久化，不从邮件自动采集，也不会因为保存或选择联系人而发送邮件。

## 数据与兼容合同

- 每条联系人归属一个用户，所有读取、唯一约束和写入均包含 `user_id`。
- 字段为 ID、姓名、邮箱、可选备注、版本、创建时间及更新时间。
- 邮箱 trim，支持单个 `Name <address>`，按 ASCII 小写保存；只接受与当前发信解析边界一致的单一 ASCII 邮箱子集。
- 姓名 NFC、trim，最多 80 码点；空姓名回退邮箱 local-part 首字符大写。备注 trim，null 或空串清空，最多 2000 字符。
- 拒绝未知字段、控制符和双向控制字符；备注允许换行和制表符，请求上限 8 KiB。
- **同用户同邮箱 POST 为 upsert**：保留原 ID/createdAt，覆盖姓名/备注并递增版本，不静默生成重复联系人。
- PATCH/DELETE 必须比较 `expectedVersion`；版本为安全整数，不能递增越界。
- 删除建立墓碑并清空姓名、邮箱和备注；重新创建相同邮箱得到新 ID，旧删除回放不会删除新联系人。

旧本地联系人表没有可信的云端用户归属，因此不自动导入、不建立全局共享通讯录。
将来导入必须单独确认源数据到云端用户的映射、权限、检查点与验收，不读取真实通讯录作为测试夹具。

## API 与权限

| 接口 | 请求与结果 |
| --- | --- |
| `GET /api/v1/contacts?limit=50&q=...&cursor=...` | 默认 50、最大 100；姓名/邮箱搜索，按姓名键、邮箱、ID 做 keyset 分页 |
| `GET /api/v1/contacts/:uuid` | 读取当前活跃联系人及版本 |
| `POST /api/v1/contacts` | `{displayName?,emailAddress,note?}`；首次成功 201，含 upsert |
| `PATCH /api/v1/contacts/:uuid` | `{expectedVersion,displayName?,emailAddress?,note?}`；至少一个修改字段 |
| `DELETE /api/v1/contacts/:uuid` | `{expectedVersion}`；版本化删除墓碑 |
| `GET /api/v1/contact-operations/:key` | 按用户读取持久化操作回执，不返回历史姓名/邮箱/备注 |

所有读取要求 `contacts:read`；修改和回执读取同时要求 `contacts:read` 与 `contacts:write`。
网页登录修改另校验 Origin，程序 Key 不继承会话权限；旧 Key 不自动获得新 scopes。
联系人权限不包含读取邮件或发送邮件，网页提供联系人只读和管理两种独立签发预设。

每次 POST/PATCH/DELETE 必须携带 UUID `Idempotency-Key`。
响应包含 `operation:{key,kind,contactId,version,deleted,completedAt}` 和 `replayed`；重放返回 200。
需要完整当前字段时另 GET，不能将历史操作回执当成联系人最新快照。
游标使用 UTF-8 base64url，并绑定用户和搜索条件；不是签名授权令牌，SQL 仍独立限定用户归属。
姓名键及 SQLite lower 仅对 ASCII 大小写折叠，不承诺完整 Unicode 语言排序或模糊分词。

## 并发、失败与隐私

联系人变更和回执完成位于同一次 D1 batch；实际写入再检查 CAS 与本次 operation ID fence。
同 Key、相同规范化请求只返回历史回执，不重复 upsert、修改或删除，不覆盖另一设备的新版本。
同 Key、不同请求返回 `idempotency_conflict`；其他版本竞争返回 `contact_changed`。
若初始回执读取为空，而另一请求已提交并改变目标版本或墓碑，会在提前返回前再次查回执。
存储或回执完成失败不伪造成功；SQLite trigger 故障回归覆盖新增、upsert、PATCH 和 DELETE 的整批回滚。

回执仅保存请求摘要、联系人 ID、版本、操作种类、删除标记和时间，不保留历史直接 PII。
墓碑和回执目前没有自动保留期，不自动清理；这不是生产完整隐私擦除、数据库物理擦除或备份删除合同。

## Web 与写信联动

独立联系人页提供搜索、分页、新增/upsert、编辑、版本冲突及显式确认删除；取消不写入。
网络错误、5xx 或 429 后锁定原 Key/路径/内容，点击核对只重放原请求；切换工作台保留未决上下文。
明确的请求失败可解除锁定并保留输入，编辑冲突不会清空用户尚未保存的内容。
账号切换重新挂载联系人与 Composer，不保留前用户页面状态。

写信页选择一个联系人只填单一 `to`，清除旧发送确认，不修改主题、正文或回复来源。
列表失败仍可手输地址；保存中、sending/unknown attempt 或 submitted 草稿不可通过联系人选择改变内容。
选择联系人不绕过 `messages:send`、发件身份、配额或供应商收件白名单。
联系人页面没有发送按钮；不能将底层单一地址映射为供应商所需数组误称为多收件人支持。

未决操作键仅在浏览器内存保存，不承诺刷新、关闭页面后的自动恢复。
已知原 Key 可经开放 API 读取持久回执；此边界不等于外部邮件投递成功。

## 升级、回退与验收

新增 `0017_contacts.sql`，只扩展私有联系人、墓碑与回执表，不改写旧表、已有 Key 或真实数据。
先应用全部迁移，再启用新运行时；回退时保留新表和回执，暂停联系人写入，不执行 DROP 或逆向清空。
旧云端运行时没有联系人 writer，不实施本地与 D1 双写；旧服务继续独立运行。

本切片的完整验证以 `contacts-final/verification.json`、`contacts-platform/verification.json`、
`contacts-final/closeout.json` 的实际 status 与源码快照为准，W3 收据只代表历史源码。
验证范围包括归属/scope/Origin、版本、分页、并发幂等、原子回滚、重启及 Chrome 丢响应与写信锁。
这些均使用合成数据和 loopback，不代表生产 D1、公网供应商或真实邮件投递通过。

CC/BCC、多收件人、联系人群组、自动采集、结构化电话/生日/地址、头像、导入导出不在本切片。
会话、订阅、普通邮箱、Agent、附件发送及可靠投递队列仍在整体迁移目标内，尚需独立实现和验收。
