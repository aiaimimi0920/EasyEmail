# 双服务发布候选准备（W13a）

## 范围与当前边界

本切片将完整自营 Email Worker 和完整 EasyEmail 聚合 Web/API Worker 打包为独立、可重定位的候选目录。
它不是生产发布，不创建 Cloudflare 资源，不设置密钥，不切换 DNS/Email Routing，不修改 NAS，也不合并迁移分支。
本地结果以本切片独立 `verification.json` 的实际状态为准，不把 dry-run、合成 MIME 或健康检查当作公网真实投递。
其他供应商仍见[覆盖表](cloudflare-provider-coverage.md)；发布准备不会取消协议或许可尚待确认的目标。

## 无密钥目标描述与两套资源

入口是 `service/cloudflare/scripts/prepare-release.mjs`，仅支持 `plan`、`prepare`、`verify`。
`deployment.example.json` 的 account、数据库 ID、域名全部是合成示例，必须由部署方核实后替换；格式检查不证明资源真实存在或属于当前账号。
描述文件必须是 UTF-8 无 BOM JSON，最多 128 KiB，严格拒绝未知字段和凭据值字段。

两个 Worker 使用不同 name、HTTPS origin、D1 name/ID。聚合层的 `INBOX`/`OUTBOX` 指向不同私有 R2 bucket。
聚合 Worker 显式启用 `global_fetch_strictly_public`，使自营供应商的 HTTPS 请求经 Cloudflare 公网入口抵达目标 Worker，避免同区请求被送往私有 origin。此标志不放宽应用层供应商 origin 白名单；自营 Worker 不增加该标志。隔离环境须分别验收直连 API 和聚合层调用，本地转发通过不能证明云端同区路由正确。
默认配置显式固定 account、禁用 workers.dev 和 preview URL，使用独立 custom domain，不沿用旧根 `config.yaml`。
聚合层带网页资源和当前 59 个 D1 迁移；自营层带完整 bundle 和新实例 `schema.sql`。
默认模式将自营每日维护和聚合每分钟任务/每 15 分钟维护写入候选配置；隔离验收模式不配置定时触发器。
不复制 `.dev.vars`、根配置、运行数据、依赖目录或测试 Worker；source map 包含源码，不得当作公开静态网页资源发布。

默认只接入自营供应商、关闭发信。可显式增加：

- `email.sendRecipients`：最多 50 个唯一的小写完整收件地址，不能使用 `*`。两边同时接上 binding 模式和相同收件白名单，仍需 Cloudflare 发信授权/收件验证及真实验收。
- `platform.providerEndpointOrigins`：额外供应商 HTTPS origin；这只是网络允许列表，不自动启用供应商或注入凭据。
- `platform.imapEndpoints`、`platform.smtpEndpoints`：沿用生产配置解析器的准确字段、端口、认证模式和收件策略，不能用任意地址或明文降级。

生成配置强制管理员密码检查、禁匿名创建，关闭自动回复、Webhook、AI 和 another Worker，启用压缩邮件存储。
其他供应商后续由明确授权的管理员配置，普通邮箱与 Agent 账号由各自用户配置，不预填生产凭据。

## 隔离验收模式

`deployment.acceptance.example.json` 是全合成、默认关闭公网入口的示例，不是已核实的云端目标。显式增加根字段 `acceptance: { "workersDev": false }` 后，两个 Worker 的 `routes` 和 `triggers.crons` 都为空数组，`workers_dev` 和 `preview_urls` 均为 false，不生成 custom domain、MX 或 Email Routing 操作。显式空 cron 数组避免遗漏字段时保留旧调度；只允许把这种配置用于已核实的隔离资源。

此模式要求全部六个资源名称以 `easyemail-migration-` 开头，两个 HTTPS origin 严格对应各自 Worker 名称及同一个账号的 `<name>.<subdomain>.workers.dev` 形式；邮箱域名只能使用保留的 `.test` 后缀。拒绝发信收件白名单、额外供应商 origin、IMAP/SMTP 端点及未知字段。名称和格式检查不证明 ID 归属、R2 私有性或真实隔离，发布前仍须独立回读控制面。

`REGISTRATION_TOKEN` 在此模式下属于必需 secret，而非可选配置；缺少该值时生产运行时代码会关闭注册。工具只列 secret 名称，不生成或设置其值，不自动授予管理员，不设置真实发信 binding。

仅在另行批准公网验收入口后，才可将 `acceptance.workersDev` 显式改成 true 并执行获批的发布操作；preview URL 仍保持关闭。这个布尔值只是候选配置，不代表授权，也不会触发部署。默认 custom-domain 模式不接受 workers.dev origin，避免忘记验收标记后误生成 custom domain。旧描述符未使用 workers.dev 的行为保持不变。

本地 `plan`、双包 `prepare`/Wrangler dry-run、摘要锚定 `verify` 和本机 Chrome 可以验证这种配置。Chrome 仍使用计划中的 HTTPS origin，但传输全部转到本机 workerd；这不能证明 Cloudflare 上的 workers.dev 入口、路由、调度或真实收信已验收。没有远端 schema、secret 或应用部署授权时，只运行本地命令。

本模式依据实时核对的官方 [Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/) 与 [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) 语义，并以仓库锁定版本的实际 dry-run 为准；不依赖省略字段的默认值。

## 本地命令

先安装两个包各自锁定的构建依赖，见[完整上游切片](cloudflare-upstream-slice.md)。本命令不自动安装依赖。
从 `C:\Users\Public\nas_home\EasyEmail\service\cloudflare` 执行：

```powershell
rtk proxy npm run release:plan -- .\deployment.example.json
$output = 'C:\Users\Public\nas_home\AI\GameEditor\linshi\easyemail-release-unique'
rtk proxy npm run release:prepare -- .\deployment.example.json $output
$candidate = Join-Path $output 'candidate'
rtk proxy npm run release:verify -- $candidate '<prepare 输出的 manifestSha256>'
```

`prepare` 只接受**源码目录之外、父目录已存在、目标尚不存在的绝对目录**；拒绝复用或覆盖已有现场。
在同一目录重跑不会继续或清空；先检查失败证据，使用新的目录重试。
构建子进程使用隔离的 cwd、临时/配置目录，清空 Cloudflare 身份环境变量；三个 Wrangler 调用全部显式 `deploy --dry-run`。
没有 deploy/execute/provision 模式，不会代用户创建数据库、bucket 或设置 secret。
失败保留 `evidence/failure.json` 和各步 UTF-8 日志；成功返回 `prepared-not-deployed`，不返回 deployed/ready。

```text
<output>/
  candidate/
    email/bundle/worker.js (+ map)
    email/schema.sql
    email/wrangler.json
    platform/server/worker.mjs (+ map)
    platform/web/
    platform/migrations/
    platform/wrangler.json
    target.json
    required-secrets.json
    release.json
  evidence/
    platform-build/
    email-build/
    email-dry-run/
    platform-dry-run/
    result.json
```

## 完整性与可重定位

构建前后核对分支/HEAD 和源码输入哈希，包括构建脚本、编译配置、lock、依赖补丁与 schema；不证明已安装 `node_modules` 的供应链完整性。
`release.json` 记录输入、工具链声明及全部候选文件的相对路径、字节数、SHA-256，不包含自身哈希。
`verify` 拒绝文件增删、字节变动、symlink/junction，重算目标配置及 secret 名称清单。
提供 `prepare` 返回的外部 `manifestSha256` 才有独立摘要锚定；不提供时仅是内部一致性检查。
这不是数字签名；攻击者同时修改产物、manifest 及外部摘要时，不能凭本工具证明其可信。
候选可整体复制到其他本地路径运行，配置没有源工作区绝对路径；校验/准备 CLI 仍来自当前工具链，不声称候选内置自举器。

## 后续真实发布门禁（本切片不执行）

1. 用户明确批准测试发布范围、账号/隔离域名/资源、费用与回退窗口；不复用正在承载旧业务的数据库。
2. 核实 Cloudflare 资源归属，独立创建/确认 D1、R2 与自定义域名；先备份既有配置/数据/版本。
3. 新自营实例初始化 schema；已有实例必须逐项评审所需增量迁移，不能把 `schema.sql` 当作通用升级程序。
4. 聚合数据库按 59 个顺序迁移和 D1 迁移账本执行，重复 apply 应无待执行项，检查 FK 与业务数据。
5. 独立设置 secret，不能将值写入 descriptor、Wrangler vars、示例、日志或版本库：
   - Email：随机 `JWT_SECRET`，JSON 字符串数组 `PASSWORDS`、`ADMIN_PASSWORDS`。
   - 聚合：`MAILBOX_KEYRING`（active key id 与独立随机密钥）、`PROVIDER_SECRETS`（`self.apiKey` 对应管理员密码，`self.sitePassword` 对应站点密码）。
   - 可选：至少 32 字符 `REGISTRATION_TOKEN`；配置 Google 端点时还需独立 OAuth client ID/secret、准确回调 URI 和 Google 授权设置。
6. 明确邀请注册策略；不设置口令则关闭注册。首位管理员需核实用户 ID 后独立授予，不能把“首个注册账号”自动当管理员。
7. 配置 Email Routing/MX，把测试收件域转给 Email Worker；原生发信另核授权域及验证收件人。OAuth 和第三方供应商分别验收。
8. 发布后以两个用户、独立 API Key、真实邮件标记、附件哈希、队列及调度执行验收；检查实际日志、限流和平台成本。

## 回退与保全

准备失败不影响旧 NAS 或原工作区，可直接继续使用旧系统；本切片没有生产数据迁移。
未来发布要保留旧 Worker 版本与配置、备份及回执。需要回退时先停止新旧不兼容 writer 和在途任务，核查未知外部请求。
不默认删除新表、重放发送、清空 D1/R2、回滚 schema 或恢复不认识新 guard 的旧 writer。
回退发布版本不等于回退外部邮件或数据；迁移/切流/旧系统退役仍须分别批准。

## 本地验收口径

`npm run test:release` 覆盖配置拒绝/endpoint 复用、构建输入覆盖、真实双包准备、完整性与 CLI、重定位后运行及真实 Chrome。
runtime 只加载候选生产 bundle，使用候选 schema/59迁移、私有 D1/R2；不注入测试 provider 或 Worker。
通过 workerd 原生 `/cdn-cgi/local/email` 触发 Email handler，不开启 `E2E_TEST_MODE` 或测试 HTTP 收信路由。
聚合 Worker fetch 只允许转发到候选指定的 Email origin，其他 fetch 拒绝；Email Worker fetch 全部拒绝。
这不是操作系统级网络隔离，也不证明 `cloudflare:sockets`、Chrome 后台网络等所有协议已被封锁；本组候选不配置 IMAP/SMTP 端点。
Chrome 使用描述符原样 HTTPS origin 和 `__Host-` Secure/HttpOnly/SameSite Cookie，传输在本机转发，不改全局 DNS/代理，不使用真实浏览器 profile。
验证注册/登录、创建、原生 MIME 入站、同步去重、正文/提码/二进制附件、权限隔离、重启持久性、R2 接线和 cron。
390px 截图、浏览器错误/路由请求及源码稳定/原目录保全另有收据；这些仍不是 Cloudflare 真实资源、真实供应商或公网邮件投递证明。
本地资源绑定和跨用户下载校验也不代替云端 R2 public access、custom domain、preview URL 等控制面配置核查。
