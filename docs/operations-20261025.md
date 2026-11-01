# EasyEmail 2026-10-25 运行审查与最小增量优化

## 范围与授权

本次先检查 NAS 与 Cloudflare 真实部署、近期日志，再做有回归证明的源码优化。
用户第一轮明确同意将“消息维护循环优化 + 容器健康检查”更新到 NAS。第二、三轮
修复先只在本地验证；随后用户另行明确同意发布这些 NAS 修复，第四轮已完成最小增量
更新与独立核验（见本文末尾）。各轮均没有提交或推送 Git。

工作区在任务开始前已有大量未提交改动。本次没有用整个工作区重建生产镜像；
第一轮增量镜像只替换消息清理模块并新增健康检查模块；第四轮增量镜像基于第一轮
线上 exact image，只复制审计过的 32 个运行文件，不重装依赖或夹带其他工作区改动。

## 现场事实

- NAS：`192.168.15.200:18081`，容器与 Compose project：`easyemail-sdk`。
- 网络：`EasyAiMi`，服务别名：`easy-email-service`，容器端口：`8080`。
- 更新前镜像：`easyemail/easy-email-service:nas-message-identity-20260911-002`。
- 更新前 image ID：`sha256:ecb5512d7914ed206cf87daf86195697f8707ad9a4d54608282b5951f494152f`。
- 更新前容器自 2026-09-10 18:25 UTC 运行，restart count 为 0，未见 OOM。
- 最近 168 小时日志中有 6 条 `easy_email_upstream_retry`，错误码均为
  `UND_ERR_CONNECT_TIMEOUT`；这一日志窗口不能证明所有历史业务请求均成功。
- 未认证 catalog 返回 401，带认证 catalog 返回 200；响应约 14.7 KB。
- 线上使用 file persistence，60 秒一次；维护周期 30 秒，主动 provider probe 为 300 秒。
- 快照约 39.27 MB，包含 5,000 个会话、2,914 封消息、20 个 provider instance。
- 连续资源采样显示大部分时间 CPU 接近 0%，维护/落盘附近出现峰值。
  单点 29.30% 或 54.21% 不能解释为持续 CPU 使用率。
- 观察到 `etempmail`、`m2u`、`temporam` 的 instance 状态为 degraded；未以此为由删除
  provider、替换凭证或改变路由。

Cloudflare API readback 确认 `mail.aiaimimi.com` 对应 Worker `cloudflare_temp_email`，
版本 `615b83f8-1c1a-448d-b494-0993284cf5c6` 承担 100% 流量。
该 Worker 的 settings 未返回启用的 observability。无凭证请求 health/settings 返回
403，但使用 NAS 当前 provider 凭证的只读检查均返回 200；health 内容为 `OK`，
settings 版本为 `v1.8.0`。不能将预期鉴权 403 判断成 Worker 故障。
本次没有变更 Cloudflare 部署、绑定、DNS、凭证或日志保留策略。

## 已上线优化

### 消息维护按会话一次分组

原 `cleanupMailboxMessages()` 为每个会话调用 `listMessagesBySession()`，后者每次
遍历完整消息集合。线上数据规模对应每轮约 14,570,000 次匹配，且每 30 秒重复。

新实现只遍历消息集合一次建立分组，再沿原会话顺序执行原排序和保留策略。
保留最近 5 条、默认跳过 open session、保留孤儿消息、相同时间戳的稳定顺序及
返回的删除记录均不改变。没有缩小线上数据保留量。

在 NAS 同一进程对真实持久化状态执行 5 轮只读 shadow comparison：

| 项目 | 原实现 | 新实现 |
| --- | ---: | ---: |
| 函数耗时中位数 | 849.478 ms | 4.734 ms |
| 会话数 | 5,000 | 5,000 |
| 消息数 | 2,914 | 2,914 |

5 轮保留/删除结果均完全一致。此测试只在内存副本运行，不保存状态、不删除线上邮件。
该热点约减少 99.4% 耗时，不代表端到端邮件延迟或整个服务 CPU 同幅下降。

### 容器健康检查

新增 `service/base/src/runtime/healthcheck.ts`，Dockerfile 配置 60 秒检查间隔、
5 秒 Docker 超时、30 秒启动宽限及连续 3 次失败判定。

探针读取现有配置，以当前 Bearer token 请求本地 `/mail/catalog`，验证 200 与 catalog
对象；不会创建邮箱、轮询 provider 或读取邮件正文。禁止跟随重定向，响应上限为
256 KiB，HTTP 超时为 4 秒。成功不输出内容；失败只输出固定文本
`easy_email_readiness_failed`，不向 Docker health log 写入 token、配置或响应体。
健康状态不等于真实邮件投递验收，也不会自行重启容器。

## 第一轮完成的本地修复（第四轮已发布）

1. `service/base/src/http/handler.ts`：显式 `sync=true` 且指定 session 的查询，完成上游
   同步后从最新内存状态读取，避免 SQLite 查询仓库在下一次 flush 前仍返回旧消息。
   未请求同步的查询保留原 repository 行为。
2. `service/base/src/http/server.ts`：监听错误拒绝启动 Promise，使 `EADDRINUSE` 能进入
   runtime 原有清理流程。新增测试证明 owned relational database 随之释放且可重新打开。

## 第一轮发布与回滚记录

- 镜像：`easyemail/easy-email-service:nas-maintenance-20261025-001`。
- Image ID：`sha256:93a22e47acdb108fc8383f6790908c286f6942360cb65e29a9647d84ec884cca`。
- 部署完成：2026-10-25 05:36:14 UTC；Docker health 为 healthy，restart count 为 0。
- 停止旧容器至新服务 readiness：40.367 秒。
- 更新前后会话数 5,000、消息数 2,914、binding 数 52、credential set/binding 数各 4。
- 备份与恢复后的会话、消息逐项完全一致；provider type、runtime template、binding、
  strategy 也完全一致。credential set/binding 只因原有启动逻辑刷新 createdAt/updatedAt，
  凭证身份及其余字段相同；没有更换秘密值。
- 配置、token、端口、网络、内存限制、tmpfs、日志轮转和 restart policy 保持不变。
- `deploy/service.env` 与 `operator/deployment-manifest.env` 已更新当前镜像身份。
- 原镜像保留；原容器改名为 `easyemail-sdk-rollback-20261025` 并停止，未删除。
- 受限备份：`/volume1/docker/easyemail-sdk/operator/ops-20261025/rollback`，目录权限 0700，
  配置/数据归档和旧 inspect 文件权限 0600，可能含秘密，不能复制到普通工单或 Git。
- 机器部署回执：`/volume1/docker/easyemail-sdk/operator/ops-20261025/deployment-receipt.json`。

回滚时先停止新容器并保留它，再将旧容器改回 `easyemail-sdk` 启动，恢复部署文件中的
原镜像身份；数据格式未变，默认继续使用现有数据目录，**不要自动回灌旧数据归档**，
以免覆盖升级后收到的新消息。回滚属于服务变更，执行前重新核对现场与授权。

注意：保留的旧容器仍有原 Compose labels。下一次 Compose reconcile 前必须明确处理
这个回滚容器的归属，不能直接运行清理脚本或 `down --remove-orphans`，否则可能失去
容器级回滚点。本轮没有清理其他容器、镜像或数据。

## 验证与证据

本地证据目录：`C:/Users/Public/nas_home/AI/GameEditor/linshi/easyemail-ops-20261025`。

- `live-before.json`、`live-details.json`：部署、日志、安全白名单配置与连续采样。
- `cloud-readback.json`、`deployment-preparation.json`：Cloudflare readback 与认证健康检查。
- `shadow-benchmark.json`：真实 NAS 状态的行为一致性与函数耗时。
- `service-tests.json`：服务端全套测试；`focused-tests.json`、`healthcheck-tests.json`、
  `startup-cleanup-tests.json`：定向回归证据。
- `candidate-image.json`：基镜像身份、增量文件 SHA-256 与隔离探针实测。
- `deployment-receipt.json`：部署回执；`verification-after.json`：独立部署后复核。
- `preservation-after.json`：与受限备份逐项比较，确认邮件/会话、配置与凭证保持边界。
- `lines-after.json`、`lines-strict.json`：effective-lines ratchet/strict 检查。

第一轮结束时，服务端测试为 66 个文件、313 项全部通过；TypeScript build 通过；effective-lines
检查器自身 19 项测试通过。ratchet 与 strict 均扫描 1,039 个文件，三个超限档位均为 0，
没有剩余 oversized baseline debt；`git diff --check` 通过。

独立复核确认 LAN 未认证 401、认证 200，Docker 服务别名可用，4 个增量文件 SHA-256
与候选镜像清单一致；后续连续 5 次 Docker health check 均成功且日志为空。
截至 05:40 UTC，restart count 为 0，持久化继续更新，会话/邮件内容保持一致。
更新后短窗采样内存约 205–242 MiB，CPU 样本为 0%；重启与采样时点会影响该数据，
不将其宣称为稳定内存收益。更新后的日志只见启动信息与 Node SQLite 实验性提示，
没有新异常日志；长期负载和真实邮件投递仍需后续观察。

本次不声称测试了桌面 UI、全部外部 provider 生命周期或新的真实邮件投递。

## 后续值得单独处理的事项

- 完整 file snapshot 仍每 60 秒写约 39 MB。下一轮可评估变更感知持久化或增量存储，
  但需要保持崩溃恢复与 read-after-write 合同；不能直接通过延长保存间隔来掩盖开销。
- 第一轮、第三轮检查时生产入口仍是历史信号处理实现。第二轮补齐显式 `runtime.close()`
  的排空顺序，第三轮完成本地信号链验证，第四轮已发布；未为证明退出行为而额外停止
  新生产容器，不能把本地端到端结果描述成一次新的生产停止测试。
- SQLite helper 的同步执行与大输出问题已在第二轮修复、第四轮打包发布；线上仍使用 file
  driver，没有迁移数据库或切换 driver。
- 线上没有持久化 Worker 请求日志证据；启用采样日志前先明确隐私字段、保留期和费用，
  不能把“无可用历史日志”表述为“没有错误”。

## 第二轮：错误归因与本地修复

本轮没有再次更新 NAS 镜像，没有修改生产配置、GitHub Secrets 或任何凭证。
2026-10-25 06:11:19 UTC 的只读复核确认：当前仍为上述 maintenance 镜像，
容器 running/healthy、restart count 为 0、OOMKilled 为 false，最近 5 次 health exit code
均为 0。未认证 catalog 为 401，认证后为 200；快照仍含 5,000 个会话和 2,914 封消息，
文件最近写入时间为 06:10:18 UTC。此次数量检查不能替代第一轮逐项数据保留验证。

### 上游故障归因

05:42 UTC 出现过 `ECONNRESET` 与 `UND_ERR_CONNECT_TIMEOUT` 重试日志。
第二轮当时的日志缺少 provider 维度，尚不能精确归因；第三轮通过生产实际调用链
将此类事件缩小到 Cloudflare Temp Email 适配链（见后文），仍不能据此归因于维护补丁。
随后在生产容器内启动独立进程，仅执行已审查为只读的 domains/config 请求：
Mail.tm 与 MoeMail 均返回 200，Temporam 返回 401。

进一步只输出布尔值的配置核验确认：Temporam 的 YAML 配置、runtime 解析结果、
持久化实例 metadata 和最终请求配置均没有 API key；官方 `/v3/domains` 响应也指明缺少 key。
这与间歇性连接错误是两个不同问题。凭证库按 `temporam` 名称检索未找到已登记的密钥项；
没有尝试注册新账号、猜测 key、创建邮箱或更改 provider 路由。

本地修复：

- 官方 `https://api.temporam.com/v3` 缺少 key 时，在请求和重试之前返回固定
  `TEMPORAM_CONFIGURATION_FAILURE`；probe 保存 `errorClass=configuration` 和
  `state=missing-api-key`，不再把它泛化成普通 provider 故障。
- legacy/custom host、custom path、非默认端口保持原有兼容行为；提供了 key 但被上游
  401 拒绝时仍按 provider 错误处理，不误标为缺少配置。
- materializer 及两个相关 workflow 的 env 映射补齐
  `EASYEMAIL_PROVIDER_TEMPORAM_API_KEY`、`EASYEMAIL_PROVIDER_TEMPORAM_BASE_URL`、
  `EASYEMAIL_PROVIDER_TEMPORAM_PREFERRED_DOMAIN`；测试覆盖仅设置单项时不被提前跳过。
  这是本地配置链代码修复，不代表 GitHub 中已设置真实 secret，亦未触发 Actions。

### SQLite 大快照与进程边界

真实 Python helper 回归先复现了超过 1 MiB stdout 引起的 `ENOBUFS`，并复现同步 helper
阻塞事件循环。当前生产使用 file driver，未发现线上已触发此 SQLite 故障的证据。

本地新增异步 `spawn` runner，保留原 Python 协议、SQLite schema 和查询语义：

- stdout 上限 128 MiB，stderr 上限 64 KiB；超时或超限后终止子进程，等待 `close` 后再释放队列。
- 固定错误码，不附加原始 stderr、argv、快照、邮件或凭证；显式设置 Python UTF-8 与禁 bytecode 环境。
- 同进程、同规范化绝对数据库路径的操作串行；失败后后续操作仍能执行，空队列回收。
- 每个路径最多 64 个 active/pending 操作，累计输入 UTF-8 字节预算 128 MiB；
  30 秒 deadline 包含排队等待，过期操作不再启动 helper。
- `saveSnapshot()` 在调用时立即序列化，防止等待期间引用变化导致快照语义漂移。
- Dockerfile 只复制 5 个 `.py` helper 文件到默认 `/app/ops/scripts/`，不复制缓存目录。

128 MiB 是协议/排队字节上限，不是 Node 总内存峰值保证；JSON 编解码及 buffer 合并仍有内存开销。
路径队列不声称协调符号链接别名或其他进程；同一数据库仍需单一写入所有者。

### 显式关闭时的写入排空

异步化不能保留原“先 final flush、再停 HTTP”的顺序。本地 runtime 现在先关闭 HTTP 入口、
停止 maintenance 调度，并等待在途 handler Promise（包括客户端已断开者）及 provider probe，
然后最终 flush、关闭 owned relational database。关闭幂等，最终 flush 失败仍尝试释放数据库。

回归覆盖了断线后延迟写入、在途探测最后更新、无需显式 flush 的重启恢复、重复 close 和
final flush 失败后的端口/数据库释放。**第二轮当时未改 shell PID 1 或 Node main 信号处理，
因此第二轮结果不包含信号关闭链验收；第三轮的补齐与验证见后文。**

### 第二轮验证记录

证据位于前述临时目录的 `round2/`：

- `read-only-provider-probes.json`、`temporam-auth-diagnostics.json`：只读上游/配置归因。
- `sqlite-red.json`、`shutdown-red.json`、`temporam-red.json`：修复前失败回归。
- `sqlite-tests.json`、`temporam-queue-tests.json`、`shutdown-tests.json`：定向回归。
- `service-tests.json`：71 个服务端测试文件、342 项全部通过；TypeScript 编译输出在 `build/`。
- Python 配置链与相关 workflow tests 共 18 项通过（5 + 4 + 9）。
- `sqlite-package-smoke.json`：编译后 JS + 5 个 Python helper 在隔离工作目录中，
  使用默认 helper 路径完成中文读写；这是打包布局模拟，不是新 Docker 镜像运行验收。
- checker 自身 19 项通过；`lines-ratchet.json` / `lines-strict.json` 均扫描 1,045 个文件，
  soft/mandatory/hard 超限均为 0，无 oversized baseline debt。
- `live-verification.json`：上述 06:11 UTC 生产状态复核。

本轮未提交、推送、迁移线上数据库或再次上线。后续如发布这些修复，需另行明确增量范围、
停机预算和回滚方案，不能沿用只批准“维护循环 + 健康检查”的旧授权。

## 第三轮：信号关闭链与安全日志归因

本轮仍只修改和验证本地代码，没有再次发布 NAS、推送测试镜像、变更凭证或触发 Actions。
先前批准的生产发布范围没有扩大。工作区内其他未提交改动均保留。

### 完整信号关闭链

修复前的独立容器回归确认：旧 Node main 作为 PID 1 时，收到 TERM 后 55 秒仍未退出。
仅验证 `runtime.close()` 不能覆盖此入口问题。

- 新增 `runtime/signal-shutdown.ts`，在 runtime 启动 Promise 期间就注册 SIGTERM/SIGINT。
  收到信号后等待启动完成，再等待 `runtime.close()`；重复信号不会重复关闭。
- 正常排空并最终保存后退出 0；启动/关闭失败退出 1，只写固定事件，不输出原始错误。
  45 秒兜底触发 `easy_email_shutdown_timeout` 并退出 1；超时路径不承诺数据已保存。
- shell entrypoint 提前安装 trap，转发 TERM/INT，回收同步循环及正在执行的 sleep/Python，
  并等待 Node 真正退出；bootstrap/chown 子进程也纳入启动阶段的停止管理。
- 外部停止优先于 import-sync 重启标志；正常 import-sync 更新仍能先关闭旧进程再启动。
  原 reset-store 行为未改变，本次所有验证均明确设置 `EASY_EMAIL_RESET_STORE_ON_BOOT=false`。
- Compose 增加 `stop_grace_period: 60s`，真实解析结果为 `1m0s`。未来部署或手动停止应保留
  60 秒预算，不能继续依赖 Docker 默认 10 秒超时；本轮没有更改生产容器的停止预算。

本地验证包含两层：

1. 7 项真实 POSIX shell 回归：TERM、INT、在途 sync Python、正常更新恰好重启一次、已有
   flag 时外部停止不重启、子进程退出码与回收、bootstrap 阶段停止。
2. 8 组真实 Linux 容器测试：direct/supervisor × TERM/INT × file/SQLite。每组先写入
   合成中文消息并确认尚未定时 flush，再发送信号；均退出 0、最后写入已持久化、重启 API
   读回正文一致，随后 Docker stop 也退出 0。使用 `--network none`，未访问外部邮件 provider。

测试数据存于本次自有容器的原生 Linux overlay；回执和导出的快照位于 `linshi`。
SQLite 验收不使用 Windows/SMB bind mount，以免把共享文件系统锁/性能干扰混为产品问题。
小型合成数据下信号退出耗时约 0.266–0.625 秒，不是生产约 39 MB 快照的停机时间保证。

### 重试日志的安全归因

只读检查生产实际 JS 调用链：`easy_email_upstream_retry` 仅由 `providers/http-policy.js`
发出；恢复函数的调用点仅出现在 Cloudflare Temp Email connector。因此当前这类历史
重试可缩小到该适配链，但无法区分具体的 9 个实例，也未证明底层断连或连接超时原因。

本地重试日志新增白名单规范化的 `providerTypeKey`，以及对 HTTP(S) origin 做 SHA-256
并截取 16 个十六进制字符的 `upstreamRef`。同一 origin 的不同路径可稳定关联；不输出
原始 hostname、URL、userinfo、path、query、headers、body 或错误详情。未知 provider 与
无效 URL 不原样写日志。该引用用于关联，不是承诺不可反推的匿名化标识。

只在原有重试边界内增加诊断字段，未改变次数、方法安全判断、请求 body 限制或原 signal
deadline；未声称连接问题已修复，也没有开启 Cloudflare 请求日志或改变隐私保留策略。

### 第三轮验证与发布边界

证据位于前述临时目录的 `round3/`：

- `service-tests.json`：73 个服务端测试文件、352 项全部通过；TypeScript typecheck 与编译通过。
- `shell-red.log`、`runtime-red.json`：修复前 shell/入口失败证据。
- `shell-tests-final.log`：7 项真实 Linux shell 回归通过。
- `runtime-both-drivers-tests.json`：上述 8 组容器端到端结果全部通过。
- `local-release-verification.json`：Compose 停止预算解析、6 个关键镜像文件 SHA-256 与本地
  源码/编译输出一致、自有信号测试容器无残留。
- `source-audit.json`、`final-verification.json`：第三轮文件 UTF-8 无 BOM 审计与最终检查回执。
- `lines-ratchet.json` / `lines-strict.json`：均扫描 1,051 个文件，soft/mandatory/hard
  超限均为 0；checker 自身 19 项通过，无 oversized baseline debt；`git diff --check` 通过。
- `live-verification.json`：2026-10-25 06:53:17 UTC 只读复核确认生产镜像身份未变，
  running/healthy、restart count 0、OOMKilled false，最近 5 次 health exit code 均为 0。
  最近 1 小时未见结构化重试事件，未分类日志 0；较早窗口存在连接错误，不能因其离开
  滚动窗口就声称故障已消失。这不代表所有历史请求成功或后续没有错误。

本地测试镜像为 `easyemail/easy-email-service:local-shutdown-20261025-002`，image ID 为
`sha256:dab2c80d96ad29018bf3b7bf7e9fc73d3662cfa6aeabc58dc5e230b45f8ff48d`。
它包含当前 service 的完整编译结果，只用于本机验证，**不是可直接上线的最小增量发布包**。
未来发布应基于线上 exact image 审计依赖图并制作限定文件清单；特别注意新日志模块依赖的
`domain/provider-taxonomy.js` 在当前工作区源自任务前已有 untracked 模块，不能盲目整目录复制。

第三轮结束时仍未发布这些修复；后续授权、最小增量包与实际更新见第四轮。

## 第四轮：获批后最小增量发布与独立核验

用户另行明确回复“同意”，批准发布已验证的第二、三轮 NAS 修复。没有沿用第一轮的
窄范围授权，没有变更 Cloudflare、GitHub Secrets、生产凭证或 provider 路由。

### 最小增量镜像与候选验证

- 基镜像：第一轮线上 `nas-maintenance-20261025-001`，exact image ID 为
  `sha256:93a22e47acdb108fc8383f6790908c286f6942360cb65e29a9647d84ec884cca`。
- 新镜像：`easyemail/easy-email-service:nas-runtime-safety-20261025-002`，image ID 为
  `sha256:e457a89b97df642eb38e1bde03490559c4a61cf8ec0d865e3733f9449ac01709`。
- 逐项审查生产 JS 与本地编译结果的差异，只复制 13 个获批 JS 模块及对应 source map、
  entrypoint、5 个 Python helper，共 32 个运行文件。基镜像全部层保持为新镜像前缀，
  HEALTHCHECK 保留，没有重新安装 npm 或系统依赖。
- 48 条模块依赖边已核对；此前特别标出的 `domain/provider-taxonomy.js` 在线上已存在，
  SHA-256 与当前编译结果相同，因此未复制它或其他 domain 文件。
- 将 NAS 构建出的确切镜像导入本机，image ID 一致；4 项隔离冒烟、8 组 file/SQLite
  信号保存与重启恢复全部通过，32 个运行文件哈希全部匹配。未用第三轮完整测试镜像上线。

### 第一次停止超时与恢复

第一次尝试开始于 07:07:19 UTC。旧容器停止请求超过部署脚本的 75 秒 Docker 管理连接
超时，新容器尚未创建、部署配置尚未修改。脚本当时只在停止请求成功返回后设置 `stopped`
标志，因而遗漏了“请求超时但容器实际上已停止”的恢复分支；失败回执中的
`rollbackStarted=true` 不足以证明旧服务真的恢复。

发现后立即显式恢复旧容器。07:11:17 UTC 独立确认旧镜像 running/healthy、认证 catalog
200、会话 5,000、邮件 2,914。没有恢复旧数据覆盖现有数据，第一次配置备份和失败回执保留。

随后修正部署脚本：失败恢复根据 Docker 实际容器状态，而不是仅依据响应后的布尔标志；
2 项本地回归覆盖“超时后实际已停止需启动”和“已运行时不重复重启”。Docker 管理连接
等待上限改为 180 秒，容器停止预算仍为 60 秒，并增加受限的阶段事件记录。

### 成功切换与当前回滚点

第二次使用独立 `ops-20261025-runtime-safety-retry1` 目录，不覆盖第一次备份或回执。
仍先确认没有 open mailbox，等待原服务完成一次定时保存，再停止、备份一致数据、切换。

- 开始：2026-10-25 07:13:53 UTC；完成：07:16:54 UTC。
- 旧容器停止请求实际约 78.54 秒返回，超过第一次脚本的 75 秒管理超时；这一观测说明
  不能把容器 60 秒信号预算等同于整个 Docker 操作的总耗时，不证明额外开销的底层原因。
- 从发出停止请求到新服务 readiness：127.680 秒，包含 Docker 停止、创建和启动开销。
  本次还发生过一次失败恢复，不能仅用第二次切换耗时代表整个维护过程。
- Docker health healthy、restart count 0；实际 `StopTimeout=60`，部署 Compose 已增加
  `stop_grace_period: 60s`，真实 Compose 语法检查通过。
- 线上仍为 file persistence、60 秒保存间隔；没有迁移数据库或切换到 SQLite driver。
- 端口、网络别名、环境变量、凭证、CPU/内存限制、tmpfs、日志轮转和 restart policy 保持。
  部署文件仅更换镜像身份/部署时间，并新增停止预算。
- 本次旧容器保留为 `easyemail-sdk-rollback-runtime-safety-20261025`，状态 exited，原镜像保留。
  第一轮的 `easyemail-sdk-rollback-20261025` 及其镜像同样保留。
- 本次受限备份目录：
  `/volume1/docker/easyemail-sdk/operator/ops-20261025-runtime-safety-retry1/rollback`。
  目录 0700，配置归档、数据归档、inspect 和原部署文件均 0600，不得公开或提交 Git。

回滚应先核对现场与授权，保留新容器，再启动本次旧容器；默认继续使用现有数据，
不要自动回灌历史归档。两个旧容器仍有原 Compose labels，不能执行 orphan cleanup。

### 独立验收与证据

独立核验确认：

- 5,000 个会话、2,914 封邮件与停止后备份逐项一致，不只是数量相同。
- provider types、runtime templates、bindings、strategies 完全一致；20 个 instance 的身份集合
  保留；credential sets/bindings 除原有启动时间戳刷新外完全一致。
- `config.yaml`、`runtime.env`、API token 字节完全一致；环境变量与运行隔离设置保持。
- LAN 未认证 catalog 401，认证 200，Docker 服务别名可用，线上 32 个运行文件哈希匹配候选。
- Temporam 已在真实启动 probe 中识别为 `configuration / missing-api-key`，但真实 key 仍缺失，
  这不是该 provider 已恢复可用；新的真实邮件投递仍未验收。

本地证据均位于前述临时目录的 `round4/`：`preparation-inspect.json`、`diffs/`、
`candidate-image.json`、`candidate-verified.json`、`candidate-runtime-tests.json`、
`candidate-smoke.log`、`first-attempt-recovery.json`、`deployment-receipt.json`、
`verification-after.json`。首次独立核验脚本还遇到 NAS Python 不支持 `str.removeprefix`，
仅修正验证脚本兼容写法后通过，未因此改动生产代码或配置。

本轮发布后的短窗口无新增结构化重试或未分类日志，不表示历史网络问题已解决。
真实投递、长期负载、下一次生产停止行为和完整快照写入开销仍需各自独立验收或研究。

## 第五轮：用户提供 Temporam key 后的生产配置生效

用户提供真实 key 后，将其保存到 `aikey/密钥/Temporam-当前接入.json`，没有写入产品仓库、
命令行参数或公开回执。先在 NAS 使用生产实际 adapter 做只读 `/v3/domains` 验证：200、
probe 成功、返回 6 个域名；没有借该验证创建邮箱或发送邮件。

确认生产没有 bootstrap 文件或 import code，不存在本机新增字段被当前 R2 同步覆盖的已知
路径。原 YAML 的 `providers.temporam` 为 null；只将其补成包含 apiKey 的 mapping，并通过
YAML 解析后的深比较确认其他字段保持不变。最初准备脚本遇到 YAML collection 处理问题，
均发生在停止与写配置之前；修正临时脚本后才执行正式变更。

- 配置操作开始：2026-10-25 15:08:11 UTC；完成：15:10:17 UTC。
- 使用原容器与原 runtime-safety 镜像，仅重新加载配置，没有构建或替换镜像。
- Docker stop 预算 60 秒，RPC 预算 180 秒；实际 stop RPC 30.329 秒、退出码 0，
  从停止请求到 readiness 66.389 秒。此次是真实生产新信号链的退出观测。
- 备份位于 `/volume1/docker/easyemail-sdk/operator/ops-20261025-temporam-key/rollback`，
  目录 0700、归档与 inspect 文件 0600；新配置文件 0600，原 uid/gid 保持。
- 15:11:45 UTC 独立核验：running/healthy、restart count 0、OOM false；最近 5 次 health
  exit 0、输出为空；未认证 catalog 401、认证 200。
- 5,000 个会话、2,914 封邮件与停止后的备份逐项一致；provider types、runtime templates、
  bindings、strategies 保持。runtime.env、token、Compose、service.env、部署 manifest 字节未变。
- 生产配置与持久化实例的 key 匹配，实际 Temporam probe 成功，实例为 active、state 为 ok。
  旧 `errorClass=configuration` 仍残留，不能把它误读成当前鉴权失败；该元数据恢复问题的
  本地修复见第六轮，尚未发布到生产。

本地安全回执位于 `round5/probe-readonly.json`、`configuration-receipt.json`、
`independent-verification.json`，相对于前述运维临时目录。原生产回滚容器、镜像与各轮备份保留。

## 第六轮：新增真实投递验收、连接诊断与快照写入优化

用户另行要求推进上述三项，并明确允许使用 Cloudflare 发件邮箱及 aikey 中的既有凭据。
本轮没有变更 Cloudflare Worker、DNS、发信绑定、GitHub Secrets 或生产路由；以下源码优化
仍为本地成果，没有沿用此前特定发布的“同意”自动发布新范围。

### Cloudflare 原生发信到 Temporam 的真实投递

使用 aikey 中 Cloudflare API token 只读核对 Worker settings：存在 SEND_MAIL/send_email
绑定，原生发送域 allowlist 为 `tx-mail.aiaimimi.com`，并存在 Resend secret 与 SMTP 配置项。
“存在配置项”不代表其秘密值或每个发信域均有效。

最初对默认 Cloudflare 收件域使用普通 send 路径返回 400，不能据此断言 Cloudflare 原生
发信能力缺失。改用已启用发送域和现有 `/admin/send_mail_by_binding` 后返回 200。首轮
测试主题中的 UUID 被 OTP 提取器识别为候选，adapter 使用 subject 摘要返回，不读取正文，
因而验收器的正文断言在三分钟内未满足；后续只读 list/detail 均确认对应真实邮件存在。
这不是三分钟内没有投递的证据，也没有为该测试夹具改动 OTP 业务规则。

将随机标记改为纯字母后重新发送一封受控邮件：

- 发送开始：2026-10-25 15:29:19 UTC；实际观察完成：15:29:24 UTC。
- Cloudflare 原生发送 HTTP 200；Temporam 的真实 list/detail 由当前部署 adapter 读取。
- 发件人、主题、正文随机标记全部匹配，提取的验证码与实际发送值一致。
- 从发出发送请求到观察匹配消息 4,374 ms；这是单次小样本，不是持续投递 SLA。
- 未调用 synthetic observe/注入接口。使用 NAS 当前部署代码与隔离内存 registry，
  没有向生产 5,000 个历史会话注入测试 session，也没有触发保留数量清理或删除外部邮箱。
- 这是 Cloudflare 原生发信到 Temporam adapter 的真实验收，不等于普通 SDK send 路径、
  主服务 HTTP 全生命周期、生产测试邮件持久化或所有 provider 均已验收。

安全回执为 `round6/real-delivery-native2.json`。首轮误判及 API 形状核验也保留。包含测试
邮箱凭据和真实正文的详细记录只保留在 NAS 对应 `ops-20261025-*-delivery*` 受限目录，
目录 0700、文件 0600，不能公开或提交 Git。

### 历史连接错误：已缩小范围，但没有伪造根因闭环

重新读取当前和两个回滚容器的 168 小时日志。当前镜像中的错误已有明确归因：
`cloudflare_temp_email`、origin reference `83d0a1b8a29cb061`；9 个 Cloudflare instance
实际上共用同一 origin。07:42、10:21、11:16 UTC 仍出现过连接超时，15:34:32 UTC 又出现
ECONNRESET，故不能以较短无错误窗口宣称历史连接故障已经修复。

NAS 实测 DNS 返回 2 个 A、2 个 AAAA；IPv4 TLS 验证成功，TLSv1.3；数次正常 authenticated
health GET 均为 200。强制 IPv6 可稳定得到 EADDRNOTAVAIL，Docker bridge 的 EnableIPv6=false，
容器没有 global IPv6 address，确认了当前 IPv6 不可用的本地条件。Node v22.23.1 已启用
autoSelectFamily，而强制 IPv6 的错误约 4 ms 即返回，不能把它直接认定为上述十秒级连接
超时或 ECONNRESET 的根因，也没有盲目强制全局 IPv4、关闭证书校验或扩大重试次数。

旧日志没有目标 IP、socket 阶段或同期报文，无法事后区分 Cloudflare 边缘链路丢包、对端
连接复位与本地复用连接竞争。该项仍未闭环；后续需要在再次发生时做同 origin 的有界连接
诊断/报文关联，不能补造历史证据。安全证据为 `network-readonly.json` 与
`transport-log-evidence.json`。

### 完整快照：按真实变化优化，而非只测重复输入

当前快照约 39.27 MB：messages 约 29.45 MB、sessions 约 6.09 MB、instances 约 3.71 MB。
NAS 五轮 JSON.stringify 约 355–386 ms，SHA-256 再增加约 149–220 ms；因此未使用每轮
同步全量 hash 作为“免费”变更检测。连续 140 秒生产观察的 3 次保存都不完全相同，不能
将固定输入测试的 80% 写入减少直接套用为生产收益。

进一步确认一个 credential cooldown 实例在无状态迁移时仍反复更新 updatedAt。NAS
实际实例的只读 shadow comparison 确认旧函数会产生新内容；本地新函数对相同、仍有效的
credential cooldown 保持幂等，过期、原因改变、需要清理失败计数时仍按原逻辑处理。

本地 file store 进一步保持现有 JSON 文件格式和 `.tmp` + rename 原子替换：

1. 每次仍序列化，正确识别记录的原地修改；只缓存最后成功持久化的 UTF-8 buffer，最多
   64 MiB，可通过内部 options 关闭。当前数据会额外保留约 39.27 MB buffer，不是零内存成本。
2. 内容与目标文件身份/mtime/ctime/size 均未变时，不重复写入；外部替换或删除会重新保存。
3. NAS 已实际确认 Btrfs 支持 COPYFILE_FICLONE_FORCE。相同长度、较小范围变化时，先克隆
   旧文件到临时文件，只修改差异范围，关闭句柄后再原子 rename；不会原地修改当前快照。
4. 克隆后再次核对源文件身份；源变化则全写。格式长度变化、大范围变化、缓存超限或
   文件系统不支持 reflink 时保留全量写入。失败不把新内容标记为已持久化。
5. 仍要求单一持久化写入 owner；没有增加跨进程 writer 协调或更强的断电 fsync 保证。
   没有延长 60 秒保存间隔、缩减保留量、迁移 SQLite 或引入不兼容压缩格式。

在 NAS 同文件系统的隔离目录、使用真实状态副本运行旧/新实现：两个相同长度的时间戳
变化样本，进程 `/proc/self/io` 的 block write accounting 从约 39.5 MB 降为每次 4 KiB；
完全相同的输入不替换文件，长度变化时仍完整写约 39 MB。最终 JSON 逐项相同，原地正文
变更也正确持久化。冷运行和部分 reflink 样本反而更慢，未宣称 CPU、RSS 或每次保存延迟
均下降；该优化的直接证据是写放大减少，不是持续负载下 SSD 物理写入量的保证。

证据为 `snapshot-baseline.json`、`snapshot-live-observation.json`、`snapshot-changed-fields.json`、
`cooldown-shadow.json`、`clone-capability.json`、`snapshot-shadow-cow.json`。NAS shadow 文件
保存在数据卷内的独立 0700 目录，进程 umask 0077；没有写入生产状态文件或清理这些证据。

### 源码验证与发布边界

本地修改了 file-state-store、provider-operational-state 和 provider-management；最后一项
在成功 probe 后清除旧 errorClass，失败仍保留最新分类，并保持 API key 等其他 metadata。
新增回归覆盖重复输入、原地修改、目标文件替换/删除、失败重试、缓存上限、reflink 回退、
源在克隆期间改变、写失败关闭句柄、块边界和 cooldown 幂等。

初次全套测试暴露旧 probe concurrency 测试只 mock 外层 facade，未拦截内部 adapter，
实际发起网络请求并超时；已改为注入 fake adapter，断言真正达到且不超过 3 并发。
另一个 64 次 Python helper 排队测试在默认高并行运行中超过 30 秒；没有放宽产品或测试
deadline，改为 `--maxWorkers=2` 运行全套。最终结果与 checker 回执见 round6 最终证据。

本轮未提交或推送 Git，未触发 Actions；新增源码优化尚未更新 NAS 镜像。后续如获批准
发布，仍须基于当前 exact image 仅打包上述限定模块及 source maps，保留 key 配置和现有
回滚点，不得整仓发布或回灌旧数据。

最终本地验证：76 个 service 测试文件、366 项全部通过（`--maxWorkers=2`）；TypeScript
typecheck 与独立 outDir 编译通过。checker 自身 19 项通过，ratchet/strict 均扫描 1,054 个
文件，soft/mandatory/hard 全部为 0，无剩余 oversized baseline debt；`git diff --check`
通过。本轮 7 个源码/测试文件均低于 500 有效行，最大 305 行；加运维文档共 8 个文本文件
已核对 UTF-8 无 BOM。

15:49:07 UTC 最终生产核验：仍为 runtime-safety 原镜像、原容器及原运行隔离设置；32 个
线上运行文件哈希匹配第四轮清单，证明本轮源码尚未混入生产。healthy、restart 0、OOM false，
最近 5 次 health 均 exit 0 且输出空；Temporam active/ok、key 匹配，5,000 个会话、2,914 封
邮件及上述 registry 分区仍与第五轮停止后备份逐项一致。证据：
`round6/service-tests-final.json`、`source-audit.json`、`lines-ratchet-final.json`、
`lines-strict-final.json`、`final-production-verification.json`。

## 第七轮：续接核验与有界连接阶段诊断

再次核对第六轮真实投递回执和源码哈希，确认验收确实使用 Cloudflare 原生 send_email
绑定，非模拟注入；三个生产模块及四个相关测试文件仍与第六轮最终审计逐字节一致。
本轮没有重新发送测试邮件、重复配置 key 或发布源码优化。

15:55:50 UTC 只读核验：生产原容器、镜像和运行配置保持；32 个运行文件哈希仍全部匹配。
healthy、restart count 0、OOM false，最近 5 次健康检查全部 exit 0 且输出空；Temporam key
匹配、active/ok。5,000 个会话、2,914 封邮件及 provider types/runtime templates/bindings/
strategies 仍与第五轮停止后备份逐项一致。旧 errorClass 仍存在，不能误读为当前 key 失败。

### 不将连接阶段线索伪装成历史根因

15:55:11–15:57:17 UTC，在容器内独立 Node 进程对相同 origin 做有界诊断；不注入主进程，
不改 registry、dispatcher、网络、证书校验或重试。输出只含阶段、时间、白名单错误码和
地址引用，不输出原始地址、URL、认证头、正文或任意错误详情。

- 两次默认自动选址连接及两个 IPv4 地址各两次连接均完成 TLSv1.3 证书验证。
- 一次默认连接 TCP 在 12 ms 完成，TLS 到 5,134 ms 才完成；其余成功样本 TCP 4–17 ms、
  TLS 总耗时约 420–795 ms。证实本次有延迟发生于 TCP 已连接后的 TLS 阶段，但未复现超时。
- 独立运行时源码确认 Undici HTTPS 的连接超时计时在 secureConnect 才清除，默认 10 秒；
  因而 UND_ERR_CONNECT_TIMEOUT 不能直接等同于 TCP 握手超时。TLS 慢是当前线索，不是
  对历史三次超时的事后因果证明。
- 强制 IPv6 对照仍在约 10 ms 返回 EADDRNOTAVAIL；默认连接本次使用 IPv4。
- 6 次 authenticated health GET 均 200，覆盖 0/1/5/15/35/55 秒空闲间隔。1 秒间隔复用
  同一 socket，5 秒及以上样本重新建连，均未复现 ECONNRESET；不能据此排除稀发复用竞争。
- 历史根因仍未闭环：旧故障缺少同刻 TCP/TLS/socket 及报文证据，本次也没有复现相同错误。
  未猜测性修改生产连接策略；下一步需要再次故障时的关联诊断，而非扩大重试或强制 IPv4。

证据位于运维临时目录 `round7/current-production.json`、`bounded-transport-trace.json`、
`undici-connector-source.txt`。本轮重新执行 TypeScript typecheck 与 4 个相关测试文件，
15 项全部通过；原第六轮全套 76 文件、366 项通过的回执和源码哈希已重新核对。
checker 自身 19 项通过；ratchet 与 strict 结果见 `round7/lines-*.json`。本轮无源码发布、
Git 提交、推送或 Actions，仍保留原生产与回滚点。

## 第八轮：获批后发布快照优化与诊断恢复修复

用户对第七轮末明确提出的三个模块发布范围回复“同意”。本轮只发布 file-state-store、
provider-operational-state、provider-management 及其 source maps；未将工作区其他 dirty
改动、测试脚本或文档装入生产，也未改变 Cloudflare 配置、生产凭据和 provider 路由。

### Exact 候选及隔离验证

- 基镜像仍为 runtime-safety，ID 为
  `sha256:e457a89b97df642eb38e1bde03490559c4a61cf8ec0d865e3733f9449ac01709`。
- 新镜像为 `easyemail/easy-email-service:nas-snapshot-cow-20261026-003`，ID 为
  `sha256:ab3bb5f637d875e79b841d08486ff276b7cbb57d610c71daed935ebcb06513cb`。
- 保留全部基镜像层和 image runtime config，不重新安装依赖；12 条直接依赖已逐项核验。
  候选与上线前生产的 423 个运行文件完整清单比较，恰好只有获批的 6 个文件不同。
- 将 NAS 构建的确切镜像导入本机，ID 一致。候选本机 6 项冒烟、NAS 6 项冒烟，以及
  file/SQLite、direct/supervisor、TERM/INT 共 8 组保存与重启恢复验收全部通过。
  NAS 冒烟在隔离 Btrfs 目录实际验证原生 reflink；没有使用生产数据目录进行写测试。
- 重新编译并运行全套 service 测试，76 个文件、366 项全部通过（maxWorkers=2）。
  部署失败恢复的 4 项本地回归覆盖 stop/create RPC 响应不确定和候选已启动情形；恢复
  按实际容器身份判断，不仅依靠 RPC 返回后的布尔标志，且不自动回灌旧数据归档。

### 生产切换及回滚点

- 操作开始于 2026-10-25 16:16:19 UTC，完成于 16:18:13 UTC，即北京时间 10 月 26 日。
- 先确认没有 open mailbox，并观察到一次旧服务的定时保存；停止前备份部署配置，停止
  并确认退出码 0、OOM false 后备份完整 data 目录，再创建和启动确切 image ID。
- 容器 stop budget 60 秒、Docker RPC budget 180 秒。实际 stop RPC 18.105 秒，发出停止
  请求到新服务 readiness 59.624 秒；整个操作含 health 等待和配置登记，不等同于停机时长。
- 备份路径为 `/volume1/docker/easyemail-sdk/operator/ops-20261026-snapshot-cow/rollback`，
  目录 0700，配置、数据归档、inspect 和原部署文件均 0600，禁止公开或提交 Git。
- 本次原容器保留为 `easyemail-sdk-rollback-snapshot-cow-20261026`，原镜像保留；之前
  两个回滚容器也保留且未启动。不得使用 Compose orphan cleanup 删除这些回滚点。
- Compose 本身字节未变；service.env 只更新镜像引用，deployment manifest 只更新镜像
  引用、ID 和部署时间。容器使用确切 ID 创建，避免可变 tag 在切换时引入镜像漂移。

### 独立上线核验

16:19:21 UTC 的独立核验通过：healthy、restart 0、OOM false；完整 HostConfig 保持，
除 Image/Hostname/本轮 ops label 外的容器配置保持，网络与服务别名保持。423 个运行文件
哈希全部匹配候选，未认证 catalog 401、认证 200，Compose 真实语法检查通过。

5,000 个会话、2,914 封邮件及 provider types、runtime templates、bindings、strategies
与停止后备份逐项一致；credential sets/bindings 除启动时间戳外保持，provider secret 和
连接信息保持。config.yaml、runtime.env、API token 字节未变。Temporam active/ok、key
保持，成功 probe 后旧 errorClass 已清除并持久化。仍为 file driver、60 秒保存间隔。

上线前单次 Docker 内存样本 178.7 MiB，上线后核验样本 286.1 MiB，limit 均为 768 MiB。
这不是配对的稳态内存基准，不将差值全部归因于约 39 MB 快照缓存；没有声称内存优化。
短窗口无新 retry 或未分类日志，不证明历史连接故障已解决，根因边界仍见第六、七轮。

本地证据位于前述运维临时目录的 `round8/`：`candidate-image.json`、`candidate-verified.json`、
`candidate-runtime-tests.json`、`service-tests.json`、`deployment-receipt.json`、
`independent-verification.json`。本轮没有 Git 提交、推送或 Actions。

### 上线后的实际保存观察与最终复核

16:21:04–16:23:24 UTC，对新生产主 Node 进程及状态文件进行 140.17 秒、141 次只读采样。
该窗口跨越多个 60 秒保存周期，仅观察到 1 次状态文件替换；在该次变化前，文件约 131 秒
没有重写。唯一一次替换使文件从 39,268,043 字节变为 39,268,040 字节，长度变化按设计回退
全量写入；主 Node 的进程块写入计数增加 39,874,560 字节。没有将“隔离等长样本 4 KiB”
说成本次长度变化也只写 4 KiB，也没有把该短窗口换算成长期固定节省比例或物理 SSD 磨损。

最初观察器的 /proc 子进程枚举没有定位到 Node，在采样前退出；仅修正运维脚本，通过
Docker top 识别唯一主 Node PID 后完成观察，没有为此改变产品代码、容器或生产状态。
观察完成时同一容器和主 Node 仍健康，restart 0、OOM false，观察器未写生产状态文件。

16:24:52 UTC 再次独立完整复核通过：上述数据、配置、凭证、运行隔离及 423 个运行文件
清单仍保持；最近 5 次 health 全部 exit 0 且输出空。Temporam active/ok、旧 errorClass
已清除。Docker 内存单次样本 299 MiB / 768 MiB，短窗口无 retry 或未分类日志。

checker 自身 19 项、ratchet 和 strict 全部通过，后两者扫描 1,054 个文件，soft/mandatory/
hard 均为 0，无剩余 oversized baseline debt；git diff --check 通过。最终证据包括
`round8/live-persistence-observation.json`、`final-verification.json`、`lines-*.json`、
`source-audit.json` 和 `closeout.json`。快照优化及诊断清理已上线；历史连接根因仍未闭环，
原生 Cloudflare 到 Temporam 的真实投递沿用第六轮已通过的实证，本轮未重复发送邮件。

## 第九、十轮：代理链路复现与当前部署复验

后续抓取到一次 TCP 成功后、TLS 完成前的真实断开，并关联旧 EasyProxy TUN/
Shadowsocks 链；10 月 28 日已按当前网关镜像重新做只读验证，并增加尚未发布的
有界、脱敏恢复诊断。精确时间线、证据、测试及未闭环边界见
[网络故障追踪与诊断优化](operations-network-20261028.md)，不以短期健康窗口覆盖旧故障。

## 第十一轮：发信路径差异与安全回退

只读核实当前 Worker 的 Resend/SMTP/原生 binding 选择顺序，修复 SDK 对模糊发送
失败重复执行管理员发送的问题；相关代码、388 项测试和 NAS 隔离验证见
[发信链路与安全回退修复](operations-send-safety-20261028.md)。该修复尚未发布，
不将原生 binding 的既有投递成功扩大成普通 Resend 路径已经修复。

## 第十二轮：显式原生模式与新的 SDK / HTTP 真实投递

新增按实例显式选择 binding 的配置与发送适配，默认路径不变；候选代码已通过 NAS
隔离 HTTP 开箱、单封真实发送到 Temporam、收件和 OTP 一致性验收（约 4,535 ms），
生产主实例仍未升级。实现、完整验证、允许域与发布边界见
[显式原生发信与 SDK 真实验收](operations-native-send-20261028.md)。
