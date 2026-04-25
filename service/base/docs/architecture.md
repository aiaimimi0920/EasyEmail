# EasyEmail Architecture

## 1. 服务定位

`EasyEmail` 是本地邮箱代理服务：

- 统一聚合多 provider
- 对外暴露一套 HTTP API
- 负责 mailbox 分配、验证码提取、策略路由、健康探测、状态持久化

---

## 2. Runtime contract（EasyProxy-like）

本轮 hard-cut 后，运行时契约改为 **文件驱动**：

- canonical config: `/etc/easy-email/config.yaml`
- canonical state dir: `/var/lib/easy-email`

配置文件顶层固定为：

- `server`
- `aliasEmail`
- `maintenance`
- `persistence`
- `strategy`
- `providers`

容器环境变量只保留最小入口：

- `EASY_EMAIL_CONFIG_PATH`
- `EASY_EMAIL_STATE_DIR`
- `EASY_EMAIL_RESET_STORE_ON_BOOT`

`EASY_EMAIL_SERVICE_*` 不再是 canonical 契约。

---

## 3. Provider 命名切断

正式 provider key：

- `cloudflare_temp_email`

运行时路由、provider type、runtime template、API path 均统一使用该 key。

---

## 4. 目录分层

- `src/domain/`：模型、策略模式、registry、OTP、领域错误
- `src/defaults/`：provider types / instances / runtime templates / strategy profiles
- `src/providers/`：provider adapters（含 `cloudflare_temp_email`）
- `src/service/`：服务编排
- `src/http/`：contracts / routes / handler / server
- `src/persistence/`：file / sqlite / database 状态存储
- `src/runtime/`：YAML config 加载与 runtime bootstrap
- `src/shared/`：仓内共享 helper

---

## 5. 策略与路由

自由模式（未显式 pin provider / 未被 domain 绑定）默认目标：

- 优先动态自动策略
- 依据 health、recent failures、cooldown、latency 做可用性决策
- 减少对固定 provider 顺序的依赖

---

## 6. Deploy 分层

工作区级 Docker / 发布资产位于：

- `deploy/service/base`

其中包括 Dockerfile、compose、config 模板、entrypoint、GHCR publish 脚本、smoke 脚本。
