# 完整 Worker 的隔离本地验证

本地构建入口不读取 EasyEmail 根 `config.yaml`，也不使用生产域名或密钥。
在 `worker/` 目录使用 pnpm 10.10.0 安装 `worker/pnpm-lock.yaml` 锁定的依赖并应用 Telegraf patch：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm build:local /absolute/isolated/output
```

输出路径必须为绝对路径；不得已有 `bundle` 或本地配置。脚本使用 `.test` 域名、占位 D1 ID、
合成 JWT secret，通过 Wrangler `deploy --dry-run` 构建完整 `src/worker.ts`，不会上传。
旧 `build/dev/deploy` 的根配置流程不变。合成配置不能用于公网部署。

EasyEmail 聚合包的 `npm run test:upstream` 使用独立 D1、真实完整入口及双 Worker HTTP 链路。
需要先安装聚合包依赖，设置绝对 `EASYEMAIL_TEST_ROOT`；Windows 路径须足够短以容纳 SQLite journal/WAL 文件名。
测试既检查 E2E HTTP 收信，也检查本地原生 email trigger、gzip、附件摘要、鉴权、删除与 scheduled。

存储失败现在拒收并停止后续动作；管理员删箱先清关联数据后删地址，定时删箱采用原子 D1 batch。
四种批量地址清理共用 D1 计算的一次性截止时间，避免事务跨秒后中途扩大选集；回归同时覆盖筛选规则和真实跨秒批次。
这些 D1 操作不承诺清除 KV/S3。没有新增环境变量、生产端点或数据库迁移。
本地模拟投递不是公网 Email Routing/SMTP 投递验收；可选外部集成仍需独立验证。
