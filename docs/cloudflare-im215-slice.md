# 215.im 授权临时邮箱接入（W12e）

本切片在 `migration/cloudflare-web` 实现 215.im 的 Web/API 纵向链路。本地测试使用独立 loopback 协议对端，不创建真实邮箱，不把模拟收件当作公网投递验收。最终通过与否以本阶段独立 `verification.json` 为准。

## 官方合同与授权边界

2026-10-31 联网核查 `https://vip.215.im/terms`、`/privacy`、`/docs`、`/v1/llms.txt` 及 `https://maliapi.215.im/v1/openapi.json`，公开文档与下载收据保存于 `linshi/easyemail-cloudflare-migration-20261028/im215-contracts/`。
官方支持外部 API 集成，但不因此推定无限量商业聚合或转售授权；本实现仅供管理员配置其已获授权的实例和平台 Key。不得用于垃圾邮件、钓鱼或其他滥用。

新增供应商类型 `im215`。正式 API base 为 `https://maliapi.215.im/v1`；测试的本地 HTTP 端点仅在原有 localhost 开发边界内允许。
平台 Key 只用于域名列表与创建。匿名创建属于官方网页 bridge，本服务不伪造 Origin、Cookie，不调用 admin、wildcard 或智能替代域接口。

## 创建、身份与期限

- 管理员保存配置和探测不创建邮箱。公开 `/domains` 不能证明 Key 有效，所以 probe 返回 `provider_probe_unavailable`，不写假健康结果。
- 域名列表只保留合法、无重复且 `isVerified`/`isMxValid` 均就绪的域，并与管理员白名单取交集。
- 现有创建 guard 之后，单次 `POST /accounts` 精确发送 `localPart`、`domain` 和不含凭据的稳定 `Idempotency-Key`，不静默换域或自动重试写入。
- 校验 `mode: fixed`、临时且活跃的邮箱、精确地址及 ID。返回的独立 Token 必须通过 `/accounts/me` 验证后才能加密保存；不能拿平台 Key 代替邮箱 Token。
- 保留上游 `expiresAt` 的真实期限，显式 `null` 表示没有上游期限；缺失、非法、已过期日期不能当作无限期。创建返回与 profile 有不同期限时保守取较早值。
- 最终期限取平台保留策略、已有固定供应商限制及实际远端期限的最小值。邮箱记录、创建 guard 和 API 返回一致，成功完成与期限更新处于同一 D1 事务。未返回期限的旧供应商行为不变。
- 丢失 ACK、身份错误或本地落库失败保留 `unknown` 原键，不自动重建、不补偿删除。

## 收件与失败语义

每批先用独立 Token 校验 `/accounts/me`，再请求规范的 `/inboxes/{id}/messages`；不使用 deprecated 账户路径。
每页 `limit=10`，始终带 epoch `since` 以启用官方过滤游标协议，随后仅用经过验证的 `after_id` 续页；末页 `nextCursor: ""`，不猜 offset 或 UUID 数值顺序。
游标复用 `0052_provider_sync_cursors.sql`，随缓存一起提交、支持重启。拒绝重复 ID、外部游标 URL、旧 anchor 重现、无进展/缺游标/不完整第一页；最多 1000 页。
每批最多 12 次 HTTP（profile、列表、10 个详情），整体 15 秒、单响应 2 MiB，无自动重试。

详情固定请求 `/messages/{id}?address=<完整邮箱>`，严格验证消息 ID 与 inbox ID。邮件头 `to` 可能不含 BCC 投递地址；它不是投递所有权，不能据此拒绝合法 BCC。所有权由已校验 Token、规范 inbox ID 和完整地址参数共同约束。
仅映射附件名称、MIME、大小；含 Token 的 `downloadUrl` 不保存、不返回、不跟随，HTML 继续净化与 sandbox 隔离。
详情 404 计为 missing、不谎报完整；其他错误不提交这一批新缓存或游标。缓存事务失败、租约被替代或邮箱到期时，既有缓存/检查点保持；已到期邮箱在 HTTP 前拒绝同步。
Token 过期明确失败，不凭地址恢复、不隐式刷新、不重建，也不回退平台 Key 读信。不调用原子标读 `/messages/next`、远端删除或附件 serve 接口。

## 兼容、验证与回退

无新 schema、依赖或锁文件变更。共享创建改动需重跑旧供应商、创建历史、分配、保留、生命周期、收件、Web 和行数门禁，不复用旧切片日志证明新候选。
新增 `im215-runtime`、`im215-lifecycle` 和真实 Chrome 的 `im215-web` 测试；包含独立凭据、真实期限、21 封持久续页/新到邮件、BCC、正文安全/提码、事务失败、原键、跨用户与密文绑定等。
新版本中可先禁用实例以停止使用；旧版本不知道 `im215`，回退运行代码前必须从环境和持久运行配置中移除此类型并保留备份、邮箱数据与加密密钥，仅设为禁用不足以让旧解析器接受它。不能宣称旧版本能继续收取此供应商邮箱。

真实平台 Key、实际域名/Token 合同执行、真实邮件、生产 Cloudflare 网络/成本及发布均待另行授权验收；本地通过不表示整个迁移完成。
