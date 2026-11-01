# M3n 完整自营上游与双 Worker 本地集成

## 范围

自营 Cloudflare Email 使用 `upstreams/cloudflare_temp_email/worker/src/worker.ts` 的完整入口，
保留全部 Hono 路由、Telegram、用户管理、S3 与发信模块。不用精简 fixture 或替换业务模块获得构建通过。
聚合 Cloudflare EasyEmail 继续使用 `service/cloudflare`，两者通过 loopback HTTP 连接。
部署、域名、密钥、生产数据及原工作区不在本切片授权内。

## 构建和验证

在自营 `worker` 目录使用 packageManager 指定的 pnpm 10.10.0。
`worker/pnpm-lock.yaml` 是专门保留的生成锁文件；其他上游目录原有 lock 忽略规则不变。
初次安装需联网；安装会应用现有 Telegraf patch，不用 npm install 替代。

```powershell
rtk proxy npm exec --yes --package=pnpm@10.10.0 -- pnpm install --frozen-lockfile --ignore-scripts
rtk proxy npm run typecheck
rtk proxy npm run build:local -- C:/Users/Public/nas_home/AI/GameEditor/linshi/ee-upstream-build
```

输出目录必须为绝对路径，且其中不能已有 `bundle` 或本地配置；不覆盖旧构建。
此入口只执行 Wrangler `deploy --dry-run`，不上传、不读取根 `config.yaml`，
仅写合成的 `.test` 域名、假 D1 ID 与假 JWT secret。不能将这些值用于公网发布。
原 `build/dev/deploy` 仍通过旧根配置入口，未改其运行语义。

安装聚合包依赖后，在 `service/cloudflare` 中运行：

```powershell
$env:EASYEMAIL_TEST_ROOT = 'C:/Users/Public/nas_home/AI/GameEditor/linshi/ee-upstream-tests'
$env:TEMP = $env:EASYEMAIL_TEST_ROOT
$env:TMP = $env:EASYEMAIL_TEST_ROOT
$env:WRANGLER_SEND_METRICS = 'false'
New-Item -ItemType Directory -Force -Path $env:EASYEMAIL_TEST_ROOT | Out-Null
rtk proxy npm run test:upstream
```

测试根要足够短：Windows workerd 的 SQLite 文件名还有 64 字节 ID 与 journal/WAL 后缀。
夹具会预检路径长度，避免过长路径表现为无意义的 D1 internal error。
所有 D1、MIME、用户和令牌都是合成的；未预期的自营外部 fetch 被拒绝并使收尾断言失败。

## 数据及错误语义

- 明文与 gzip 两个分支都要求数据库持久化及真实 raw/parsed API 内容一致，二进制附件有 SHA-256 验证。
- `test:upstream` 同时覆盖 E2E HTTP 收信和本地 workerd 原生 email trigger；双 Worker 用例关闭 E2E 路由并走真实默认导出的 email handler。
- 存储失败会 setReject 并立即返回，不再继续转发、通知或自动回复。它沿用旧失败分支的拒收语义，不承诺 SMTP 临时失败重试。
- 管理员删箱与定时删箱的关联 D1 清理各在单个 DB.batch 内，地址最后删除；故障注入证明回滚。
- 四种批量地址清理在执行前从 D1 读取一次截止时间，并在全部关联 DELETE 中绑定同一值；事务跨秒也不会扩大中途选集，保留未到期邮箱的邮件、额度、绑定和地址。另有四种筛选规则的固定日期回归，不只依赖跨秒用例。
- 管理员删箱不受普通用户删除开关限制；用户路径的代际 fence 和开关语义不变。
- 管理员/定时 D1 清理仍不宣称清除 KV/S3 等外部资源；条件删除协议与回执结构不变，没有新增 schema 迁移。
- 类型修复不关闭 strict，不靠大范围 any/ts-ignore；WebAuthn v13 元数据读取真实 sibling 字段，附件明确使用 arraybuffer。

## 可观察验收与边界

覆盖鉴权、实际建箱、MIME 收信、gzip、正文/附件、黑名单与未知地址、存储失败、
条件删信/删箱、同名新代际旧 JWT 拒绝、定时清理及失败回滚。
聚合链路覆盖随机/精确建箱、原生收信、增量同步、验证码、独立 API Key、双用户隔离、
二进制附件下载、条件删除回执和聚合重启后的状态。

依赖安全版本经 npm registry 与 pnpm audit 联网核实，审计结论以本轮正式收据为准。
不等同公网 Email Routing、真实 SMTP、真实 S3、Telegram、Webhook、AI 或 Passkey 设备完整业务验收。
没有运行整个旧桌面产品的回归，也不表示所有可选上游路由都经过业务测试。
测试通过后仍需隔离 Cloudflare 资源的真实供应商/投递验收；生产变更及合并另行批准。
