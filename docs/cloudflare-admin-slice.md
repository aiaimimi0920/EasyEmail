# Cloudflare 平台管理切片（M3e）

本阶段是迁移分支上的本地管理纵向链路，不是生产发布或整个迁移完成。
实际入口位于 `service/cloudflare`，沿用同一 Worker、D1、Web 登录及加密 keyring，
没有引入第三个运行服务，也不依赖原 NAS、桌面或 Userscript。

## 权限与引导

- `platform_admins` 默认空表；第一个注册者不会自动成为管理员。
- 管理接口必须使用有效网页登录会话，写操作校验精确 `Origin`。
- 每次接口请求查询当前管理员成员关系及用户 active 状态，撤权后不能继续操作。
- API Key 一律没有管理权限，包括管理员自己创建的 Key。
- `/api/v1/me.user.isAdmin` 仅对当前管理员会话为 true；登录后 Web 重新读取此接口。
- 页面隐藏入口不是权限实现，服务端仍独立校验所有操作。

首次授权由部署操作者通过受控 D1 管理入口完成。先核实已经注册的用户 ID，
再插入 `platform_admins(user_id,created_at)`。不要按用户名猜测、开放注册自举、
写死管理员 ID，或把管理员凭据放到浏览器配置。
本地示例必须保留 `--local` 和隔离状态目录：

```powershell
rtk proxy npx wrangler d1 execute DB --local --persist-to $state --command "SELECT id,username,status FROM users"
# 人工核验 ID 后才执行，替换占位符，不使用生产用户做测试。
rtk proxy npx wrangler d1 execute DB --local --persist-to $state --command "INSERT INTO platform_admins(user_id,created_at) VALUES ('verified-user-id',unixepoch())"
```

管理员管理、用户冻结和账号恢复的产品 UI 尚未实现；不是本轮已交付能力。

## API

| 方法与路径（前缀 `/api/v1/admin`） | 语义 |
| --- | --- |
| `GET /providers` | 配置、版本、凭据来源/是否配置和当前版本探测状态；不读取上游 |
| `PUT /providers/:id` | 按 expectedRevision 新增/更新配置及凭据动作 |
| `POST /providers/:id/probe` | 显式认证只读接口探测；body 为 `{}` |
| `GET /overview` | 平台记录计数及当前只读硬配额 |
| `GET /audit?limit=25&cursor=...` | 有限分页、脱敏管理审计 |

配置更新格式：

```json
{
  "expectedRevision": 0,
  "config": {
    "id": "self",
    "type": "cloudflare",
    "baseUrl": "https://mail-api.example.test",
    "domains": ["mail.example.test"],
    "enabled": true,
    "sendRecipients": []
  },
  "secretAction": "keep"
}
```

省略 `sendTransport` 关闭发送；显式选择 `worker` 或 `binding` 时仍须配置收件允许名单。
单独 `*` 允许任意收件人，不能与具体地址混用。Temporam 不得声明发送能力。
Web 对新增/修改发送策略及清除凭据显示即时确认。

## 配置、身份与并发

- 环境 `PROVIDER_CONFIG` 保留为基线，D1 覆盖对应 ID；无覆盖时维持原行为。
- 已有 ID 的供应商类型和完整规范化 `baseUrl` 不可修改，包括路径。
  新 endpoint 必须使用新 ID，不能把已有邮箱 JWT 或平台凭据转发给新目的地。
- 新实例的 origin 只能来自部署基线 origin 或 `PROVIDER_ENDPOINT_ORIGINS` JSON HTTPS origin 数组。
  Web 管理员不能自行扩展此允许名单；loopback HTTP 仅限 loopback 开发配置。
- D1 与部署基线出现同 ID endpoint 身份冲突时 fail closed；数据库错误不回退环境凭据。
- 最多 20 个实例，停用实例仍计数。并发新增在原子 SQL 中再次校验数量。
- 环境配置版本为 0；首次覆盖版本为 1；每次成功更新递增。
  陈旧或并发失败写入返回 `409 provider_config_changed`，不覆盖配置/密文，不留下成功审计。
- 配置更新与审计在同一 D1 batch 中提交；审计以唯一 change token 和新版本为条件。
  审计存储失败会回滚配置更新。
- 分配 guard、同步 lease、发送 reservation 同时带供应商版本 fence，
  不能利用配置读取与原子写入之间的时间窗新增旧配置任务。
- 停用阻止新的外部工作，历史缓存和发送状态仍可查询。
  已取得 guard/lease/reservation 的操作可以完成，不伪造取消或重放外部写入。
- 附件返回前再次核对供应商版本及既有邮箱/邮件生命周期约束。
- 返回邮箱工作区时重新读取域名，配置修改后无需整页重载。
  即使所有供应商停用，待确认创建仍可用原 idempotency key 查询，不新建或重放外部分配。

## 凭据

- `keep` 保留当前来源；新实例没有凭据时仍为 none。
- `replace` 提交完整 `secret`（`apiKey` 及可选 `sitePassword`），加密保存。
- `clear` 清除平台密文并设为 none，**不会回退同 ID 的环境凭据**。
- 来源只有 environment / stored / none；管理 API 不返回明文、密文、原旧值或上游响应体。
- 加密复用 `MAILBOX_KEYRING` 的 AES-GCM，AAD 通过专属前缀、provider ID、
  type/baseUrl 摘要和 platform 身份与普通邮箱凭据分隔。交换密文不能成功解密。
- 保留旧 key 可读取旧密文；replace 使用当前 active key。移除旧 key 前须完成独立重加密计划，
  本轮不自动批量轮换邮箱或供应商密文。
- 表单只写、password 输入，不保存到 localStorage/sessionStorage；提交完成清空 secret 字段。
- 请求仍受 8 KiB 总大小上限约束，凭据控制字符及未知字段被拒绝。

## 显式探测与审计

- Cloudflare 仅认证读取 `GET /admin/worker/configs`，验证域名和版本 shape；
  不读取邮箱列表、原始邮件或额外计数，不发送邮件。
- Temporam 认证读取 `/domains`；验证供应商合同及配置域名子集。
- 15 秒截止，不重试、不跟随重定向；Cloudflare JSON 响应上限 256 KiB，
  Temporam 沿用既有 2 MiB 合同上限。
- 每管理员/供应商每分钟最多 3 次，平台每分钟最多 20 次，仍叠加用户 API 总限流。
- 独立 `provider_health` 表记录状态、受控错误码、检查时间、配置版本及配置摘要。
  环境-only 的同版本 metadata 更新也会使旧健康状态失效。
- 探测完成与审计原子提交，并校验开始时配置版本；旧探测不能给新配置发布健康结果。
- 审计仅保存操作者 ID、供应商 ID、动作、版本、凭据动作、受控错误码与时间。
  不记完整配置、请求体、邮件、上游响应体或任何密钥。
- 探测通过只是认证只读 API 合同通过，不等于收信、发信、线程或附件业务验收。

## 升级、回退与验证边界

新增 `0007_admin_providers.sql`，不修改 `0001`–`0006`，不改变旧表或删除数据。
升级测试核对用户、会话、Key、邮箱密文/生命周期、创建 guard、邮件 tombstone 和 unknown 发送记录。
旧 schema 阶段直接写入独立生成的旧格式合成夹具，不运行依赖新 schema 的业务 handler。

新管理代码必须在 expand migration 后运行。若只读旧版本需要回退，保留新增表和密文，
但旧版本不理解供应商覆盖/停用状态，**不得在有 D1 覆盖的同一活动实例中直接回滚旧业务代码**。
需先保持实例隔离并制定配置回放/凭据恢复方案；本轮的回退仍是继续使用原独立目录和原部署。

验证收据位于 linshi 下的 `easyemail-cloudflare-migration-20261028/m3e-final/`。
验证使用合成凭据、真实本地 workerd/D1、loopback HTTP 合同夹具及独立 Chrome。
尚未验收生产 Cloudflare 配额/CPU/并发、真实供应商、真实邮件投递或附件；
没有发布、切流、提交、推送、合并或改动原部署。

仍需继续：自动到期/数据保留、远端条件删除/撤销合同、供应商自动选择/退避、
更多供应商、等待新提取结果，以及已确认保留的后续普通邮箱和 Agent 邮件模块。
全局配额编辑、管理审计保留策略和用户管理 UI 不在本轮完成范围。
