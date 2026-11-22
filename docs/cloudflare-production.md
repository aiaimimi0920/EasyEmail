# Cloudflare 正式域名部署

## 当前目标

用户于 2026-11-05 确认：网页和统一 API 使用 `https://mail.aiaimimi.com`，新邮箱使用 `xxx@aiaimimi.com`。当前仍处于开发阶段，按全新实例部署，不迁入旧邮箱数据，不建设旧 API 兼容层。旧资源保留供回退，但旧地址和新接口不承诺兼容。

无密钥部署描述为 `service/cloudflare/deployment.production.json`。它记录真实资源标识，不包含密码、邀请口令、邮箱密钥或供应商 Key。2026-11-05 已按该描述完成正式发布，实际结果见下文；描述文件本身不能替代发布回执。

| 组件 | 目标 |
| --- | --- |
| 聚合 Web/API | `mail.aiaimimi.com` / `easyemail-production-platform` |
| 自营邮箱 API | `email-api.aiaimimi.com` / `easyemail-production-email` |
| 收件后缀 | `aiaimimi.com` |
| 聚合 D1 | `easyemail-production-platform-db` |
| 自营 D1 | `easyemail-production-email-db` |
| 私有 R2 | `easyemail-production-inbox`、`easyemail-production-outbox` |

新实例不复用两个 migration 验收数据库，也不复用旧 `cloudflare-temp-email` 数据库。网页无需桌面、Userscript 或 NAS。

## 2026-11-05 实际部署与验收

两个正式 Worker、两个新 D1 与两个私有 R2 已部署。`mail.aiaimimi.com` 的 custom domain 已切换到聚合平台，根域 catch-all 已指向新自营 Worker。根域原 MX 和 SPF 保持原样；发信域 DKIM、Return-Path DNS 状态为 `ready`。两个 Worker 的 `workers.dev` 和 preview URL 均关闭。

自营 schema 已初始化，聚合层 59 项迁移全部执行，回读无待执行迁移，`PRAGMA foreign_key_check` 无异常。D1 中途连接关闭后先核对迁移账本，再续跑未执行项，没有清库或重放已提交项。

| 验收项 | 实际结果 |
| --- | --- |
| 根域收信 | `acceptance@aiaimimi.com` 已收到真实自营测试邮件，聚合 API 可读取正文 |
| 外部供应商 | Cloudflare 发到真实 Temporam 邮箱后，平台同步到新邮件；发件人、收件时间、正文及新鲜验证码验证通过 |
| 原生发信附件 | 修复后真实邮件的附件为 73 字节，下载 SHA-256 与上传原件完全一致，含中文与 CRLF 的字节未改变 |
| 持久发送队列 | 真实分钟 cron 派发一次，`attempts=1`、`manualRetries=0`，收件箱确认收到对应邮件；不将渠道 `accepted` 泛化为全部邮件已投递 |
| 云端调度 | 连续 18 分钟观察到 14 次分钟 cron 与 1 次维护 cron，均 `ok` 且无异常；修复发布后另观察到 1 次分钟 cron 正常执行 |
| 用户与 API 权限 | 无邀请注册、匿名 API、普通用户管理接口及跨用户资源访问被拒；只读 Key 可读、不可同步，撤销后为 401 |
| 真实网页 | 正式网页登录、打开根域邮箱、显示真实正文和附件信息、从缓存提取验证码通过；附件字节摘要另由真实 HTTP 下载验收 |

本次共发送 5 封有独立标记的受控测试邮件，均有收件证据；没有在未知结果下重放旧发送。最后一封新 Temporam 邮件用于验证修复后的适配器，而不是重发原请求。

### 真实验收发现并修复的问题

- 自营 native binding 把 JSON base64 字符串按文本投递，导致收件附件摘要不符。现在在 binding 边界转换成 `Uint8Array`；保留非法编码拒绝和收件下载摘要保护。旧坏附件继续返回 `409 attachment_source_changed`，没有关闭校验或篡改旧邮件。
- Temporam 实际返回 `from_email`、`to_email` 和六位小数的带时区时间；适配器已识别这些字段并正确解析时间，不用平台观察时间代替收件时间。
- 原 Temporam 测试邮件后来不再出现在远端列表，但详情仍可读；原因尚未确认，不能断言已过期、已删除或属于消费式读取。保留旧缓存与失败回执，不通过改写 D1 修饰结果。修复后另用新邮件完成实际同步验收。

### 发布与证据

当前自营 Worker version 为 `525470d5-05c1-48d4-8c38-b7f4c92bdf24`，聚合 Worker version 为 `89806202-f4d8-41c2-804c-d1c32d6549f9`。已回读核对其与 Wrangler 发布日志一致。

已发布候选的 manifest SHA-256 为 `63aa4f8a3d56991cd4d0468f0af58986c7024f527858cdc97802afeffd744fcd`。候选原样保留，其 `prepared-not-deployed` 是封存时的准备状态，实际发布由独立回执证明，不回写候选。

本机证据目录：`C:/Users/Public/nas_home/AI/GameEditor/linshi/ee-production-20261105/`。主要回执为 `postflight.json`、`content-fix-verification.json`、`closure-binary-permissions.json`、`closure-temporam-acceptance.json`、`web-acceptance.json` 以及 `cloud-schedule-tail.json`；封存候选和发布日志也保留在该目录，未加入 Git。

本地修复验证：有效行 checker 测试 19/19，ratchet 与 strict 均通过（2132 文件，无 hard/mandatory/soft 违规）；后端 TypeScript、相关内容/发送回归 38/38、release 组 22/22、双 Worker 准备与 dry-run、摘要检查及 `git diff --check` 通过。未把专项结果相加冒充全量测试，也未重跑整个历史全量。

## 发布顺序

1. 记录现有域名绑定、DNS、收信 catch-all、旧 Worker 版本、订阅和新资源初始状态。
2. 用现有发布工具准备双 Worker 候选，校验源码、配置、迁移及摘要；运行相关测试、类型和有效行检查。
3. 新自营库初始化 schema，新聚合库按顺序应用 59 项迁移，再回读账本与外键检查。不将 schema 初始化当作旧数据库升级。
4. 生成独立密钥，使用 Worker Secrets；设置邀请口令，未获邀请码不能注册。管理员仅授予核实后的部署者账号。
5. 发布自营 API 和聚合平台。接管 `mail.aiaimimi.com` 的旧自营 HTTP 入口是有意的产品切换，不保留旧 API 路径。
6. 将根域 catch-all 指向新自营 Worker；已有根域 MX 指向 Cloudflare 时不重复改写。核对发信域的 DKIM、Return-Path SPF/MX 和 DMARC。
7. 用独立标记验证真实收件、正文、提码、附件、跨用户权限、Temporam、授权发信与定时任务；渠道 accepted 不等于已送达。

## 初始限制

初始发信只允许描述中的明确验收收件地址，不开放任意收件人。增加可发送对象时，同时更新自营 binding 和聚合供应商策略并重新验收。Temporam 凭据来自现有凭据库，不能写入描述或测试。

普通 IMAP/SMTP 端点默认空，Google OAuth 需要独立的真实应用凭据与授权验收，不因网页入口已经存在就自动开启。保留策略默认关闭，避免未经确认清理新业务数据。

当前正式实例仅启用自营 Cloudflare 和 Temporam 两个供应商。其余适配器的本地实现、合同限制和公网未验收项见 [供应商覆盖表](cloudflare-provider-coverage.md)。这是一套可实际访问的受控开发部署，不是全功能、全供应商或任意外发的正式商用验收。

## 回退与边界

优先将 HTTP 域名和根域 catch-all 恢复到记录中的旧 Worker；保留新旧数据库、对象、版本和凭据。不自动清库、删资源、覆盖数据或重放发送。回退不能撤销已经投递的邮件。

这次全新部署不等于 NAS 退役、旧源码删除或迁移分支合并主干。Workers Paid 与 R2 沿用既有订阅；资源使用仍可能产生计量费用，不承诺零费用。
