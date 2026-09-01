# EasyEmail Desktop 业务核心迁移与产品化开发计划

Status: **execution in progress; M0 and M1 complete, M2 contact slice implemented**
Created: **2026-09-01**  
Validated baseline: **`97dd334fbcd2f95330a8e19a23b366af54671220`**

## Execution progress

- **M0 complete (2026-09-01):** the 56-command Tauri registration is frozen by
  the machine-readable
  [`desktop-command-http-migration-map.json`](./desktop-command-http-migration-map.json),
  route/OpenAPI consistency and generic-command prohibitions are enforced by
  repository tests, and ADRs 0001-0004 record the API, persistence, credential,
  and graceful-shutdown decisions.
- **M0 validation:** 79 root Python tests passed; `service/base` typecheck, tests,
  and build passed; the complete desktop `verify` pipeline passed, including 231
  Rust tests and authenticated bundled-core readiness; the release contract
  passed.
- **M1 transport, refresh, and action UI slices (2026-09-01):** the desktop now has typed HTTP contracts for
  the complete existing temporary-mailbox API, preserves the full canonical open/access
  response without a lossy transport DTO, uses a stable per-installation host ID, and routes create, list,
  refresh, observed-message detail and verification polling through the authenticated
  bundled-core client. Single-session and host-batch refresh are now explicit server-owned
  HTTP resources; React no longer orchestrates per-session synchronization, provider errors
  are redacted, and partial batch failures remain visible in the UI. Recovery, outcome report,
  session update, release, authentication-link reading, and provider-backed mailbox sending now
  have explicit UI entries using the same bundled HTTP client. Runtime credentials remain outside
  React state/storage; recovery uses server-held state rather than retaining provider credentials
  in the UI. Static transport tests prohibit regressions to the migrated `temp_*` commands;
  `temp_upgrade_mailbox` remains assigned to M7A.
- **M1 complete (2026-09-01):** 190 `service/base` tests, 112 frontend unit/contract tests,
  234 desktop Rust tests, and 87 repository Python tests passed. The complete desktop `verify`
  pipeline, TypeScript/Vite production build, Rust format/clippy/test/check, authenticated
  bundled-core readiness smoke, packaged fake-provider mailbox open, and release contract
  validation also passed. The packaged smoke starts the bundled `service/base`, completes its
  authenticated provider probes, proves an unauthenticated mailbox-open request returns 401
  without reaching the provider, and proves the authenticated request returns the canonical open
  result through the real Cloudflare Temp Email connector. The controlled live gate then created
  real recipient/sender mailboxes, delivered and read a marker plus verification code, confirmed
  upstream deletion, restored the released session and message after restart, found no configured
  credential in launch/container logs, and left zero isolated Docker/runtime resources. See
  [`real-provider-lifecycle-validation.md`](./real-provider-lifecycle-validation.md).
- **M1 exit audit:** every temporary-mailbox command explicitly assigned to M1 in the
  machine-readable map uses the bundled HTTP client. The only remaining `temp_*` business invoke is
  `temp_upgrade_mailbox`, which the map owns in M7A. Global account, aggregate-message, and recent-
  verification loads remain assigned to later milestones and are outside this audit. The legacy
  Rust repository remains present and unchanged as the M8 importer source.
- **M2 contact slice (2026-09-01):** `service/base` now owns contact normalization,
  deterministic ordering, opaque keyset pagination, unique-email upsert, version/CAS update and
  delete semantics. A separate native SQLite relational database uses ordered checksummed
  migrations, a durable migration ledger, pre-migration backup, fail-closed schema checks and an
  explicit validated restore operation. Contact list/get/create/update/delete resources are
  covered by typed HTTP contracts, OpenAPI, the TypeScript client and the bundled desktop client;
  React no longer calls the `contact_*` Tauri business commands. The old Rust repository remains
  frozen as the M8 import source.
- **M2 contact validation:** 199 `service/base` tests, 113 frontend unit/contract tests, 234
  desktop Rust tests and 87 repository Python tests passed. The complete desktop `verify` pipeline
  also proved the production frontend build, Rust fmt/clippy/check, a self-contained bundled core,
  authenticated contact persistence, unauthenticated 401 and fake-provider mailbox open.
- **Next:** complete the M2 taxonomy/folder/label slice. Newsletter durable overrides and the
  derived subscription view must respect the M3/M4 account/message ownership boundary rather than
  fabricating subscription data before those sources exist.

本计划定义将已导入 `apps/desktop` 的 EasyEmailAM 从“React UI +
过渡期 Rust 业务后端”收敛为“React UI + 随桌面程序启动的
`service/base` HTTP 核心”的正式执行顺序。它是
[`easyemailam-migration.md`](./easyemailam-migration.md) 和
[`ui-bundled-runtime.md`](./ui-bundled-runtime.md) 的工程落地计划，
不替代这两份架构契约。

---

## 1. 目标产品与不可破坏的边界

### 1.1 目标产品

1. **Standalone Local Server**
   - 直接运行 `service/base`；
   - 本机、LAN 或可连接的远程机器均可部署；
   - 任何程序只需按 OpenAPI/HTTP 文档请求，不强制使用独立 SDK。
2. **Bundled Desktop UI**
   - 用户启动 UI 时，Tauri 自动启动同一份 `service/base` 核心；
   - UI 通过鉴权的 loopback HTTP API 读写业务数据；
   - 包内自带私有 Node 运行时，不要求用户安装 Node、Docker 或单独服务器。
3. **Userscript**
   - 继续作为完全独立的浏览器侧 provider 实现；
   - 不调用 `service/base`，不共享桌面端或服务端的业务模块；
   - 只允许对齐 provider 名称、上游端点和外部约定端口。

### 1.2 架构硬规则

- `service/base` 是唯一业务核心，拥有 provider、mailbox、IMAP、SMTP、
  message、队列、验证码、联系人、分类、newsletter、Agent、avatar 和持久化。
- Tauri 最终只保留进程生命周期、单实例、窗口/通知、安装器、应用数据
  目录和 OS 凭据库桥接。
- React 不导入服务端内部模块，不直接读写 SQLite/状态文件。
- 每个迁移能力必须有显式 HTTP 资源、类型契约、错误模型和 OpenAPI 定义。
- 禁止用通用 `POST /commands/{name}` 或其他 RPC 逃生口复制 Tauri command 表面。
- 已公布的 `/mail/*` 临时邮箱契约在完成版本化与迁移前不可破坏。
- 旧 Rust 业务实现只是迁移输入，不得演变成第二个永久核心。

---

## 2. 当前已验证基线

| 项目 | 当前状态 | 结论 |
| --- | --- | --- |
| EasyEmailAM 源码导入 | 已导入 `foundation@34838bc`，记录 182 个文件及 hash，源仓库保留 | 可回滚，不删除 sibling 仓库 |
| 桌面应用构建 | React/Tauri 编译、前端单测、Rust fmt/clippy/test/check 已通过 | 仅证明过渡基线可构建 |
| 私有核心打包 | 已打包 Node + `service/base` dist + YAML 依赖 | 不需外部 Node/Docker |
| 桌面宿主生命周期 | 随机 loopback 端口、高熵 token、catalog readiness、精确 child kill/wait 已实现 | 尚无 graceful shutdown |
| UI 的 HTTP 边界 | 启动路径已调用鉴权 `/mail/catalog` | 其余绝大多数功能仍使用 Tauri command |
| Windows candidate | GitHub Action 可生成未签名 MSI/NSIS、manifest 和 SHA-256 | `releaseEligible=false`，不得对外宣称正式发布 |
| 正式发布 | 阻塞 | 需先完成业务 HTTP 所有权、数据迁移、安装/升级、安全与供应链门禁 |

当前 `service/base` 存在与 temporam、provider probe/worker、runtime/config、
mailbox 服务及测试相关的未提交修改。它们不属于本计划文档的写入
范围。后续开发必须先记录基线，所有提交都采用显式路径分组，不得覆盖、
顺手格式化或提交这些现有改动。

---

## 3. 总体交付策略

### 3.1 纵向切片，不做一次性重写

每个功能切片必须按以下顺序闭环：

1. 冻结旧行为和数据不变式；
2. 在 `service/base` 增加 domain/service/persistence 实现；
3. 增加显式 HTTP contract、route、handler、错误码和 OpenAPI；
4. 增加 service、persistence、HTTP contract 测试；
5. 增加或修改 desktop typed HTTP client；
6. 把一组 UI 调用从 `invoke(...)` 切到 HTTP；
7. 用相同 fixture 对比旧新路径的语义结果；
8. 停用该组 Tauri business command；
9. 只有在数据导入与回滚通过后才物理删除对应 Rust 业务模块。

一个 pull request/写入批次原则上只处理一个可验收切片。若一个切片无法在
不删除旧实现的情况下独立验证，则应继续拆分，不得扩大修改半径。

### 3.2 API 兼容策略

- M0 必须先为 API 版本化形式作出 ADR。
- 默认建议保留当前 `/mail/*` 路径，以 OpenAPI `info.version`、稳定的
  error envelope 和独立 persistence schema version 管理 v1 兼容。
- 如决定改为 `/v1/...` 路径，必须先保留原路径兼容别名，并在所有已知调用方
  迁移、弃用期结束且发布说明完整后才能移除。
- 新资源使用稳定 ID、幂等写入键、明确的分页/排序及可机读错误码。
- 未支持的 persistence/provider 能力必须返回明确 capability/error，不得静默丢数据。

### 3.3 删除停止条件

在下列条件全部满足前，禁止删除某项旧 Rust 实现：

- UI 已无相应 `invoke`/command 引用；
- OpenAPI 及 HTTP contract 覆盖全部可见行为和错误语义；
- service/persistence/worker 不变式测试通过；
- 旧数据的版本化导入、幂等重跑与回滚已验证；
- 打包后真实运行时证明 UI 走 HTTP 完成该功能；
- 审查证明删除范围仅包含已被取代的业务模块。

---

## 4. 里程碑与依赖顺序

### 总览

| ID | 里程碑 | 依赖 | 规模 | 主要出口 |
| --- | --- | --- | --- | --- |
| M0 | 基线、契约与数据决策 | 无 | S | 命令映射、OpenAPI 基线、ADR、脏工作树保护 |
| M1 | 临时邮箱端到端 HTTP 迁移 | M0 | L | 创建/恢复/读信/验证码/更新/释放/发信的 UI HTTP 闭环 |
| M2 | 扩展持久化与低风险 CRUD | M0 | M | 联系人、taxonomy、newsletter HTTP 资源 |
| M3 | 账户与凭据库基础 | M0 | L | 账户资源、不透明 credential refs、OS vault 桥接 |
| M4 | 聚合消息与验证记录 | M1, M2, M3 | L | 统一 message query/action 与 verification API |
| M5 | SMTP 和持久发送队列 | M3, M4 | L | enqueue/claim/retry/cancel/send 闭环 |
| M6 | IMAP 同步和远程操作 | M3, M4 | XL | 账户测试、文件夹、同步、正文、标记/移动 |
| M7 | 提升、Agent、avatar 与开发身份清理 | M4, M5, M6 | XL | 剩余扩展能力由 HTTP 拥有 |
| M8 | 旧数据导入和 Tauri 瘦身 | M1-M7 | L | 可回滚 importer，删除旧 business commands/modules |
| M9 | 宿主生命周期与本地安全加固 | M8 | L | graceful shutdown、碰撞/崩溃恢复、token/CSP/log 加固 |
| M10 | 安装、升级、签名与正式发布 | M9 | L | 干净机验收、SBOM/许可证、签名、provenance、独立 release component |

M2 可在 M1 的 HTTP 切片模式稳定后与 M3 并行，但同一文件或数据模型的
改动必须串行合并。业务关键路径为：

```text
M0 -> M1 -> M3 -> M4 -> (M5 + M6) -> M7 -> M8 -> M9 -> M10
             \
              -> M2 -----------/
```

### M0 - 基线、契约与数据决策

**目标**：在扩大代码改动前，把业务表面、兼容约束和存储/凭据方案变成
可测量基线。

**交付物**：

- 建立 `UI action -> desktop client -> Tauri command -> Rust service/repository ->
  target HTTP resource` 的全量映射清单。
- 将当前 `docs/easyemail-openapi.json` 作为兼容基线，增加 deterministic 生成/差异检查。
- 固定统一 error envelope、分页、时间格式、ID、幂等键、并发修改版本和 API
  弃用策略。
- 作出并记录以下 ADR：
  1. API 版本化和原 `/mail/*` 路径兼容；
  2. 扩展领域的 repository 契约与 schema migration 策略；
  3. desktop 使用 SQLite 时，file/database adapter 的能力对齐或明确降级策略；
  4. bundled UI 与 standalone server 的凭据解析边界；
  5. graceful shutdown 控制面。
- 为已有临时邮箱路由增加 golden HTTP/OpenAPI 契约测试，防止迁移期回归。
- 记录开发开始时的 scoped `git status`，将现有 `service/base` 脏改动排除在
  新提交之外。

**出口门禁**：

- 映射清单覆盖 `commands.rs` 注册的全部业务 command；
- 空白或未决定的高风险项均有责任人和阻塞里程碑；
- 无功能性变更且基线测试仍通过；
- 无任何现有脏文件被覆盖、格式化或误提交。

### M1 - 临时邮箱端到端 HTTP 迁移

**目标**：用已成熟的 `service/base` 临时邮箱能力完成第一个真正的 UI
纵向切片，建立后续所有迁移的模板。

**实现范围**：

- 对齐 catalog、plan/open、session list/query、observed messages、code、auth-link、
  recovery、outcome report、update-session、release 和 mailbox send。
- 保留 `recoveryDataCredential`、`temporaryAuthCredential`、recoverability、
  `createdByProvider` 和 provider 溯源，禁止使用旧的有损 DTO 映射。
- 用模块级 HTTP client 闭包持有 base URL/token，不将 token 放入 React state、
  URL、local/session storage、日志或错误报告。
- 从 UI 移除 `temp_*` 业务 command 调用；旧 Rust 实现暂时冻结为只读迁移源。
- 更新用户可见错误处理：鉴权失败、provider 不可用、超时、无法恢复、
  离线和 core 退出不得被统一显示为“未知错误”。

**测试与验收**：

- service/domain/persistence 测试：open、recover、update、release、send 与重启读回；
- HTTP 测试：精确 method/path/header/body，401、400、404 及 provider 错误语义；
- UI transport 测试：所有临时邮箱操作不再调用 Tauri business command；
- 打包宿主 smoke：从 runtime descriptor 获取 token，成功完成鉴权 catalog 和
  fake-provider mailbox open，同时证明未鉴权请求为 401；
- 手工/CI 受控验收：用一个真实 provider 完成创建邮箱、收到测试邮件、
  读取正文/验证码和释放，且日志中无凭据。

**出口门禁**：临时邮箱 UI 路径 100% 通过 HTTP；但在 M8 importer 通过前
不物理删除包含历史数据读取能力的 Rust repository。

### M2 - 扩展持久化与低风险 CRUD

**目标**：在进入 IMAP/SMTP 前验证扩展领域的 schema migration、repository、
HTTP 资源和 UI 切换模式。

**实现范围**：

- 引入带独立 schema version 的联系人、mail taxonomy/folder/label 及 newsletter
  subscription 数据模型。
- 实现 list/get/create/update/delete/hide 等显式资源，定义稳定的唯一约束、
  排序、分页、软删除或硬删除语义。
- 如 standalone 的某种 persistence adapter 无法提供等价能力，必须显式暴露
  capability 差异并 fail closed，不得使用临时内存库伪装持久化。
- 把 `contact_*`、`mail_taxonomy_*`、`newsletter_subscription_*` UI 调用切到 HTTP。

**测试与验收**：

- 每种 adapter 的 migration up/down 或 forward/restore fixture；
- CRUD 契约、并发更新、唯一冲突、排序/分页及重启读回；
- 同一 UI fixture 的 old/new 语义对比；
- 该三组功能的 React 运行时无 business `invoke` 调用。

**当前进度（2026-09-01）**：联系人切片已按上述纵向顺序实现并通过完整 desktop
打包运行时验证；schema v1 只包含联系人，不提前混入 taxonomy/newsletter。下一切片
将以独立迁移版本增加 taxonomy/folder/label。Newsletter 列表所需的账户与聚合消息
来源仍归 M3/M4，因此 M2 只在来源契约确定后实现可持久化的显式 override，并保留
subscription 作为派生视图，不建立虚假双写数据源。

### M3 - 账户与凭据库基础

**目标**：为 normal IMAP、SMTP、Agent 和提升邮箱建立共享的账户与安全
凭据模型。

**实现范围**：

- 定义 normal、temporary-upgraded、Agent、system 和 anonymous 账户作用域，不允许用
  一个模糊 `accountType` 破坏隔离。
- 实现 account list/get/create/update/disable/delete/test 资源与版本化数据迁移。
- HTTP、SQLite 和日志只保存不透明 `credentialRef`、backend/key metadata 和脱敏诊断；
  禁止保存原始 password/token/blob。
- bundled desktop 采用 OS vault 桥接：webview 将新凭据交给受信 Tauri
  命令存入系统凭据库，只获得不透明 ref；`service/base` 仅通过子进程专用、
  鉴权且最小权限的 credential broker 解析 ref。
- standalone server 继续使用服务端配置的 credential source/ref resolver；非 loopback 场景
  必须在部署文档中要求 TLS/reverse proxy，禁止将凭据放入 query string。
- 移除 platform account 的 unsigned development session 身份用法；真实外部身份 API
  未实现前显式标记为不可用。

**安全验收**：

- 用 canary secret 扫描 SQLite、state files、web storage、标准输出、日志、crash report、
  candidate manifest 和 UI 错误，必须零命中；
- 凭据引用缺失时返回可机读 `reauthentication_required`，禁止静默清除账户；
- 一个账户不能读取另一 account scope 的凭据或邮件；
- 进程重启后凭据 ref 仍可解析，卸载/回滚不自动删除 OS vault 项。

### M4 - 聚合消息与验证记录

**目标**：建立同时承载 temporary、normal、promotion、Agent 和 outgoing
源的统一消息查询边界。

**实现范围**：

- 定义不可丢失的 source/account/session/provider/external-message 溯源字段和去重键。
- 实现 message list/detail/search、body 按需加载、folder/label 视图、action plan/apply 及
  outgoing/draft 状态。
- 将 verification code/history/reclassify/poll 建立在统一 message/OTP 服务上，复用
  现有 freshness/candidate/source 语义。
- 保留 HTML 消毒和原始正文访问的明确边界；默认列表不返回不必要的完整
  body。
- 将 message/verification UI 调用从 Rust repository/service 切到 HTTP。

**测试与验收**：

- 跨源去重、稳定分页、排序、大正文、HTML/XSS fixture 和邮件头编码；
- verification 新鲜度、多 candidate、无码、误分类重算与重启读回；
- promotion 前后 source linkage 稳定，消息不复制、不移动；
- 查询和正文接口的授权作用域测试。

### M5 - SMTP 和持久发送队列

**目标**：将 SMTP 网络操作、队列租约、重试和终态从 Rust 移到
`service/base`。

**实现范围**：

- 实现 send/enqueue、queue list/detail、cancel、retry、run-once 和 worker 可观测状态。
- 保留原子 claim、lease owner/expiry、stale lease recovery、终态 compare-and-set、
  scheduled-at、有界 exponential backoff 和幂等 send key。
- 账户/身份必须在 enqueue 时冻结可审计引用，原始凭据仅在真正发送时解析。
- 队列 worker 属于 `service/base`，不能由 React timer 或 Tauri 后台线程替代。

**测试与验收**：

- fake SMTP 的成功、短暂失败、永久失败、超时和凭据失效；
- 并发 worker 只能一次 claim，进程中止后 lease 可恢复，终态不被过期 worker 覆盖；
- restart 后 due queue 仍存在并可处理；
- HTTP/UI 端到端证明创建、取消、重试和结果统计；
- 受控真实 SMTP 测试仅在安全 secret environment 运行，不向 fork PR 暴露凭据。

### M6 - IMAP 同步和远程操作

**目标**：迁移账户连接、folder discovery、header/body 同步和远程 action，
并保持离线可用性。

**实现范围**：

- 支持 TLS/security mode、server capability、folder mapping、UIDVALIDITY/UID cursor、
  header 去重、正文延迟加载和同步检查点。
- 实现 account connection test、folder list、sync-now/status 以及 read/unread、star、archive、
  move、delete 等远程 action。
- 远程 action 采用 plan/apply 或具有冲突检测的幂等操作，不得在网络失败时
  静默把本地状态当作远程成功。
- 所有 IMAP 网络访问在 `service/base` provider/service layer 完成，Tauri 不保留
  native IMAP 备用路径。

**测试与验收**：

- fake IMAP 覆盖初次/增量同步、UIDVALIDITY 变化、重复 header、编码正文、
  folder rename、网络中断和部分成功；
- action 失败、重试、并发冲突和服务器能力差异；
- 离线启动仍可查看已持久数据，且 UI 显示“过期/未同步”而不伪装最新；
- 受控真实 IMAP 验收包括连接、文件夹发现、header/body 同步和一个可回滚 action。

### M7 - 剩余扩展能力

#### M7A - 临时邮箱提升

- 提升只改变产品可见性/account scope，不改变 provider 生命周期；
- 不复制、不移动 message，仅保留稳定 source linkage；
- 提升后可继续恢复/同步；provider 不支持时返回明确能力错误；
- 用 open -> receive -> promote -> restart -> query 的端到端测试验证。

#### M7B - Agent mail

- 迁移 Agent account/mailbox/task/thread/reply association 与 send task；
- 保持 account-scope 隔离、sender trust 检查、幂等 task 建立和 reply 溯源；
- 依赖 M5 的队列而不自建发信 worker，依赖 M6 的收信而不自建 IMAP 客户端；
- 使用 fake IMAP/SMTP 验证新 task、reply、不受信 sender、重复邮件和账户隔离。

#### M7C - Avatar 与 platform stub 清理

- 迁移 avatar settings/resolution/cache，实施 HTTPS-only、public-address 检查、DNS rebinding
  防护、redirect 上限、内容类型/大小上限、超时和 negative cache；
- UI 只消费经过消毒的 DTO/cache URL，不直接对任意 sender domain 发网络请求；
- 删除或永久禁用 unsigned platform development session；真实身份集成作为独立产品能力。

**M7 出口门禁**：除 OS integration 外，所有 EasyEmailAM 扩展业务 UI 操作
都已有显式 HTTP 资源，且 UI 不再调用对应 business command。

### M8 - 旧数据导入和 Tauri 瘦身

**目标**：安全承接已有 EasyEmailAM 用户数据，然后移除第二业务核心。

**版本化 importer**：

1. 要求桌面应用停止业务写入；
2. 备份 `easyemailam.sqlite`、`easyemailam.sqlite-wal`、`easyemailam.sqlite-shm` 和当前目标状态；
3. 验证源 schema migration 版本、integrity check 和各表 row count；
4. 幂等导入账户、临时邮箱、消息、folder/label、联系人、newsletter、
   verification、send queue、Agent 和 settings 等非 secret 数据；
5. 仅导入不透明 credential refs，检查 OS vault 项；缺失时标记重新鉴权，不复制 secret；
6. 验证 row count、外键/source linkage、queue state、一组 message hash 样本和幂等重跑；
7. 成功后写入带版本和源指纹的 import receipt，但保留源数据直到新版本验证期结束；
8. 任一阶段失败则丢弃新导入状态，恢复备份，源库保持不变。

**兼容边界**：

- importer 和回滚验证完成前，保持 `com.easyemailam.app`、数据目录、数据库名称和
  Windows Credential Manager target prefix 兼容；
- 不让 `service/base` 直接打开旧 SQLite 文件并就地改表；
- importer 是单向、显式、可重跑的转换，不建立双写或长期兼容层。

**Tauri 瘦身**：

- 删除已被取代的 Rust domain/service/repository/worker/IMAP/SMTP 模块和 command 注册；
- 用 allowlist 合同测试限制 Tauri command 仅剩宿主、OS vault、窗口/通知/打开器等边界；
- 移除业务 SQLite 直连权限，Tauri 仅决定应用数据路径；
- 复核 Rust/Node/frontend 依赖，删除仅为旧业务核心服务的依赖。

**出口门禁**：导入、幂等重跑、失败回滚、旧版本升级 fixture 全部通过；
Tauri 无邮件业务实现；旧源仓库和用户数据仍保留。

### M9 - 宿主生命周期与本地安全加固

**目标**：将当前“可启动、可强制回收”升级为可诊断、可恢复、不影响独立
服务器的产品级生命周期。

**实现范围**：

- 增加仅 bundled-child mode 启用的鉴权 graceful shutdown 控制面；Tauri 先请求关闭并
  限时等待，超时后只终止本实例创建的精确 child。
- 明确并测试 startup/readiness/close 超时、有界重试、端口碰撞、多 UI 启动、
  意外 core 退出、UI crash 后的 stale child 处理和 crash-loop 抑制。
- 使用随机 ephemeral 端口后仍验证实际 listener 属于本 child，避免连接到抢占
  端口的伪服务。
- 为临时 runtime config/token 设置用户级文件 ACL，成功启动后删除，崩溃后
  下次启动识别并清理；不记录 token 或 bearer header。
- 收紧 webview navigation、remote origin 和 CSP；将 loopback token 限制在最小模块生命周期，
  增加防止写入 web storage/日志的合同测试。
- 定义 core log 目录、旋转、大小/保留期、脱敏和用户可导出的诊断包。
- provider 网络不可用时允许离线启动并读取已持久数据，而不将 provider probe
  当作 core readiness。

**宿主验收**：

- 鉴权 catalog 和一个 fake-provider 业务流程；
- 未鉴权请求为 401，恶意/过大 payload 受限；
- 正常关闭经 graceful 路径，强制路径只杀精确 child；
- 独立启动的 `service/base` 在 UI 关闭后仍然存活；
- 端口碰撞、子进程崩溃、损坏状态、多实例、UI crash 及 restart 均有确定结果。

### M10 - 安装、升级、签名与正式发布

**目标**：从“未签名 migration candidate”升级为可公开分发、可验证、可回滚的
独立 Desktop 产品。

**工程交付物**：

- 干净 Windows 虚拟机安装 MSI 和 NSIS，验证无 Node/Docker、普通用户权限、只读
  安装目录和应用数据目录写入。
- 定义从上一个 desktop 版本到候选版本的 upgrade fixture，证明数据、凭据 ref、
  队列和 settings 保留；验证失败时恢复上一个二进制和导入前数据。
- 为 imported source、Node runtime、npm/crate 依赖和打包文件生成 SBOM 与许可证/
  NOTICE 清单，将不兼容或缺失来源条目设为发布阻塞。
- 在受保护 GitHub Environment 中隔离代码签名证书/密钥；不在 fork PR 或候选
  artifact workflow 中暴露。
- 生成已签名 MSI/NSIS、独立 desktop manifest、SHA-256、精确 Git/core/import-source
  revision、SBOM 和可验证 provenance/attestation。
- 新增 Desktop 独立 release component；禁止将其塞入 Client/Userscript 的现有精确
  artifact manifest。
- candidate workflow 继续保持 read-only 权限和 `releaseEligible=false`；正式发布使用
  独立 workflow、最小写权限、environment approval 和显式版本/tag 检查。

**正式发布硬门禁**：

1. 已声明的每个目标 OS 都能生成自包含安装包；
2. 干净机无 Node/Docker 安装并启动成功；
3. UI 自动启动 core，鉴权 loopback readiness 成功；
4. 用真实 provider 通过 UI -> HTTP 完成创建邮箱、收信、读取验证码/正文、
   重启读回和释放；
5. 关闭 UI 后其 child 退出，独立 Local Server 不受影响；
6. 端口碰撞、core crash、UI crash、损坏状态、旧数据导入、升级和回滚全部通过；
7. 机密性 canary 扫描、SBOM/许可证审查、代码签名验证和供应链 provenance 通过；
8. artifacts、checksums、manifest、source revisions 和 attestation 精确匹配；
9. 回滚包、数据备份与操作说明已实演；
10. `product-contract.json` 只在上述证据齐全后才可将 Desktop `releaseStatus`
    从 blocked 改为 releasable/released。

---

## 5. 测试分层与 CI 门禁

### 5.1 测试金字塔

| 层级 | 覆盖内容 | 何时必跑 |
| --- | --- | --- |
| L0 静态契约 | OpenAPI、route 清单、Tauri allowlist、产品契约、禁止架构 | 每次 PR |
| L1 domain/service unit | 不变式、错误映射、策略、脱敏 | 每个功能切片 |
| L2 persistence/migration | schema、幂等、并发、restart readback、rollback | 每个持久化改动 |
| L3 HTTP contract | 方法、路径、鉴权、payload、错误、分页、OpenAPI 一致性 | 每个 API 改动 |
| L4 UI transport | 精确 HTTP 请求、取消/超时、错误 UI、无旧 `invoke` | 每个 UI 切换 |
| L5 protocol fake | fake IMAP/SMTP/provider、worker、中断/重试/竞态 | M1/M5/M6/M7 |
| L6 packaged host | child、token、readiness、HTTP 业务流、close、碰撞/崩溃 | 每个 candidate |
| L7 controlled live | 真实 provider/IMAP/SMTP，不暴露 secrets | 里程碑验收/发布前 |
| L8 clean-machine | 安装、升级、卸载、回滚、签名与 provenance | 正式发布前 |

### 5.2 每个功能 PR 的最小命令门禁

```powershell
npm --prefix service/base run typecheck
npm --prefix service/base test
npm --prefix service/base run build
npm --prefix apps/desktop run verify
python -m unittest discover -s tests -p "test_*.py"
python scripts/validate-release-contract.py
```

若改动打包核心、Tauri 宿主或生命周期，还必须运行：

```powershell
npm --prefix apps/desktop run core:bundle
npm --prefix apps/desktop run core:verify
npm --prefix apps/desktop run host:smoke
```

在准备合并里程碑时运行仓库级验证：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-all.ps1
```

上述命令是最小建议，不能替代与改动直接相关的更小定向测试。

### 5.3 GitHub Actions 进化

1. **Validate（现在）**
   - PR/push 运行 root、service/base、desktop 和现有发布契约测试；
   - 增加 OpenAPI deterministic diff、Tauri command allowlist、migration fixture 和 secret canary。
2. **Desktop candidate（现在）**
   - 保持 `workflow_dispatch`、`windows-latest`、`contents: read`、unsigned、artifact-only；
   - 逐步将 L6 真实宿主测试纳入；manifest 继续 `releaseEligible=false`。
3. **Controlled live validation（待新建）**
   - 仅 manual/scheduled protected environment，不在 fork PR 上运行；
   - provider/IMAP/SMTP 测试账户与凭据定期轮换，输出只包含脱敏证据。
4. **Desktop release（M10 才允许新建）**
   - 受保护 environment approval，显式 tag/version，最小必要写权限；
   - 签名、SBOM、provenance、完整 gate manifest 通过后才创建 GitHub Release；
   - 不修改 Client/Userscript 的精确 artifact 集。

---

## 6. 横切质量要求

### 6.1 安全与信任边界

- loopback 只绑定 `127.0.0.1`/等价本地地址，启用 API key 时所有路由使用
  统一 Bearer 鉴权。
- renderer 获得的 runtime token 仅在内存中存活，禁止进入 state store、DOM、URL、
  clipboard、telemetry、日志或持久化 web storage。
- 原始邮件 HTML 默认不可执行，禁止远程脚本、任意 navigation 和未受控资源加载。
- 远程 avatar 抓取需防 SSRF，provider/account 凭据需脱敏，诊断包需二次 secret
  扫描。
- standalone server 若暴露到非 loopback 网络，文档必须要求 TLS、强 API key、
  firewall/ACL 与 reverse-proxy trusted-header 配置。

### 6.2 可观测性

- 统一 structured event：`requestId`、`operation`、`account/session/provider`的脱敏 ID、
  duration、result/errorCode，不记录 body/凭据。
- worker 暴露 queue depth、due count、leased count、retry count、dead-letter/terminal count。
- IMAP/provider 暴露最后成功同步、最后错误类型和下次重试，不暴露 server secret。
- 崩溃重启必须有有界次数与可见原因，不得无限自启隐藏原始错误。

### 6.3 数据正确性

- 所有时间在 API 中使用带时区的 RFC 3339，持久化测试覆盖时区/DST。
- 所有重试型写入必须幂等；竞态更新使用 version/CAS/transaction，不依赖
  UI 顺序性。
- message 永久保留 source traceability；promotion、folder view 和 Agent 关联不复制
  原始邮件。
- 数据迁移默认 forward-only；回滚使用导入前备份和上一个已验证二进制，
  不伪造危险 down migration。

### 6.4 性能预算（M0 量化，M4-M6 落地）

- UI 首屏不等待 provider 全量 probe/IMAP 同步；先达到本地 core readiness，再异步更新。
- 消息列表必须分页，正文延迟加载，不在列表接口返回全量 HTML/text body。
- provider probe、IMAP sync、SMTP worker 使用显式并发上限和 backpressure。
- 每个外部操作都有 timeout/cancellation；关闭阶段不无限等待 worker。

---

## 7. 每个能力的 Definition of Done

一项能力只有同时满足以下条件才标记为完成：

1. 业务不变式归属 `service/base` domain/service；
2. 持久化契约和 schema migration 已实现；
3. 显式 HTTP route、typed request/response、稳定错误码和 OpenAPI 已对齐；
4. service、persistence、HTTP、UI transport 和相关 protocol fake 测试通过；
5. UI 用打包 core 通过 HTTP 完成该操作；
6. UI 无对应 Tauri business command 调用且 allowlist 测试通过；
7. 旧数据导入、幂等重跑、restart readback 和失败回滚已验证；
8. 日志/错误/诊断已脱敏，安全和授权边界有负向测试；
9. HTTP 文档和用户错误处理已更新；
10. 删除旧实现时有 scoped diff 审查，无兼容数据或旁路被意外删除。

---

## 8. 回滚、暂停与停止扩张规则

### 8.1 阶段回滚

- **M0-M7**：保留旧 Rust 路径作为只读对照；若新 HTTP 切片未达到语义等价，
  回滚该切片 UI 切换，不修改用户旧数据。
- **M8 前**：回滚为使用保留的 EasyEmailAM 源仓库与数据目录。
- **M8 后、公开切换前**：恢复导入前 SQLite/WAL/SHM、目标状态备份和上一
  个已验证桌面二进制。
- **公开切换后**：只按已演练的 release rollback runbook 操作，不自动删除
  用户数据或 OS vault 凭据。

### 8.2 必须暂停并返回设计的情况

- 新 HTTP 合同无法表达旧行为而只能靠通用 command endpoint 规避；
- 新旧数据模型需长期双写才能工作；
- 原始凭据必须落入 SQLite、HTTP 日志、web storage 或静态配置才能工作；
- provider/IMAP/SMTP 错误无法与本地持久化状态一致回滚；
- 为了迁移需要覆盖现有脏工作树或删除 sibling EasyEmailAM 源；
- 测试只能证明编译成功，无法证明打包运行时的语义结果；
- 发布流程要求提前广泛授权、暴露 signing/provider secrets 或绕过干净机门禁。

---

## 9. 待决策项及最晚截止点

| 决策 | 建议方向 | 最晚决定时间 | 未决定时的阻塞 |
| --- | --- | --- | --- |
| API 版本化 | 保留 `/mail/*`，先做契约/模型版本；路径改版需兼容别名 | M0 结束 | 禁止增加扩展资源 |
| 扩展持久化 | 共享 repository contract；desktop SQLite；其他 adapter 对齐或显式 capability | M0 结束 | M2-M7 阻塞 |
| Desktop 凭据 broker | OS vault + opaque ref + child-only authenticated broker | M3 开始前 | normal/SMTP/IMAP/Agent 阻塞 |
| Graceful shutdown | bundled-child-only 鉴权控制面 + timeout + exact-child fallback | M9 开始前 | 正式发布阻塞 |
| 支持的目标 OS | 首个正式版本先声明 Windows；其他 OS 只在实现对应 vault/package 门禁后声明 | M8 结束 | M10 安装矩阵不确定 |
| 签名身份 | 受保护 environment 中的 Windows code-signing identity | M10 开始前 | 禁止公开发布 |
| 许可证谱系 | 对 imported source、Node、npm/crate 和资源生成 SBOM/NOTICE | M8 结束 | 禁止公开发布 |

---

## 10. 下一个可执行批次

M0 与 M1 已通过；**M2 联系人切片已经实现，M2 整体仍在执行中**。

建议精确交付顺序：

1. **已完成**：为单邮箱和匿名批量刷新增加 server-owned 显式 HTTP 资源，避免
   React 编排多个 session 同步，并覆盖鉴权、400/404、重复插入、host 隔离、
   provider 错误脱敏和 partial failure UI；
2. **已完成**：recovery、outcome report、update-session、release、auth-link 和 mailbox
   send 已有 UI 入口、类型化 bundled HTTP 调用和可操作错误语义；
3. **已完成**：打包宿主 fake-provider mailbox-open smoke 已通过真实 `service/base`
   provider connector 同时证明鉴权成功、未鉴权 401 且未鉴权请求不会触达 provider；
4. **已完成**：受控真实 provider 创建、收信、正文/验证码、上下游释放、持久化
   重启读回与 credential 日志扫描全部通过，证据见
   [`real-provider-lifecycle-validation.md`](./real-provider-lifecycle-validation.md)；
5. **已完成**：完整 M1 门禁通过；UI 审计确认命令映射中明确归属 M1 的临时邮箱
   command 不再使用 business `invoke`；`temp_upgrade_mailbox` 按映射保留给 M7A，
   全局 account/message/recent-verification 加载归属后续里程碑且不在本次审计范围；
6. **已完成**：旧 Rust 临时邮箱实现继续冻结为 importer 源，本批次未修改且在 M8
   importer/rollback 门禁前不物理删除。

M2 的首个精确批次：

1. **已完成**：核对 persistence 能力，冻结原生 SQLite、独立关系库、版本化迁移
   账本、迁移前备份和显式恢复契约；
2. **已完成**：联系人 schema v1、显式 CRUD、唯一邮箱 upsert、CAS、稳定排序、
   keyset 分页、HTTP/OpenAPI/TypeScript client 和重启读回测试；
3. **已完成**：`contact_*` React 调用已迁移到 bundled HTTP，完整桌面打包 smoke
   已证明联系人创建、持久化与鉴权边界；
4. **下一批次**：以 schema v2 实现 `mail_taxonomy_*`，冻结 kind、parent、唯一约束、
   删除策略和排序，并以重启读回及无 business `invoke` 为出口；
5. **后续批次**：在 M3/M4 来源模型明确后实现 `newsletter_subscription_*` 的持久
   override 与派生视图，不提前复制或伪造账户/消息所有权。
