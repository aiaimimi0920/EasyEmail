# EasyEmail 显式原生发信与 SDK 真实验收（2026-10-28）

本轮在 [发信安全修复](operations-send-safety-20261028.md) 基础上继续推进普通 SDK
发送路径问题。没有调整 Worker、Secrets、允许域、DNS、生产镜像或生产注册表。

## 1. 实现范围与默认兼容

新增可选实例配置 `sendTransport: "worker" | "binding"`，贯通 runtime YAML、
注册请求、实例 metadata、connector 和 OpenAPI schema。未配置仍是原有 Worker
普通发送路径；注册更新省略字段会保留旧值，显式 `"worker"` 可关闭原生模式。
空串、null、布尔值、未知字符串及大小写变体均拒绝，不静默开启。

`"binding"` 直接请求既有 `/admin/send_mail_by_binding`，不先调用
`/api/request_send_mail_access`、`/api/send_mail` 或 `/admin/send_mail`。
发件地址来自当前邮箱/session，调用方仅能提供显示姓名；按上游契约映射
`from/to/subject/text/html`，保留同时提供的两种正文。成功返回
`deliveryMode: "native_binding"`。

原生模式不是错误回退：HTTP 400/401/403/429/500、socket/reset 和 abort 不触发
另一条发送路径或模糊重放。底层仍保留现有 `UND_ERR_CONNECT_TIMEOUT` 的一次
连接阶段、同 endpoint、同 deadline 恢复；不能写成“任何错误都绝对不重试”。

复用已有 `requestAdminJson` 处理鉴权、deadline、redirect 和 transport 策略。
没有 adminAuth 时在访问网络前失败。Worker 仍负责发送域 allowlist 与总量限制。
管理员原生接口不走普通 mailbox 余额、recipient blocklist 或普通 sendbox 保存，
因此只适合显式选择该语义的实例，不能偷偷替换默认发送模式。

## 2. 新的真实 SDK / HTTP 投递验收

只读 `/open_api/settings` 确认当前 `tx-mail.aiaimimi.com` 可用于新建邮箱，
与既有 SEND_MAIL 允许域吻合。随后在 NAS 生产容器内运行独立 Node 进程：

- 生产编译 service、HTTP server、Temporam adapter；候选 Cloudflare client、
  configuration、send-binding 和 domain policy 仅通过内存模块接入。
- 独立内存 registry，仅包含复制的 Cloudflare/Temporam 实例；没有后台维护或持久化。
- HTTP 服务仅监听 `127.0.0.1` 的动态端口，随机 bearer token；没有对外增加端口。
- 通过 HTTP 打开 1 个真实 Cloudflare 发送邮箱、1 个真实 Temporam 收件邮箱，
  通过 `/mail/mailboxes/send` 发送，随后通过 `/mail/mailboxes/{id}/code` 读取。
- 一次性目录和 `attempt.json` 先于外部操作创建，禁止重复执行；发送结果不明不补发。

2026-10-27 20:43:54–20:44:08 UTC（北京时间 10 月 28 日 04:43:54–04:44:08）：

| 实际观测 | 结果 |
| --- | --- |
| 发送调用 | 1 次，仅 `/admin/send_mail_by_binding` |
| SDK 返回 | `deliveryMode=native_binding` |
| 接收 | 约 4,535 ms 后观测到真实邮件 |
| 发件人、主题、正文随机标记 | 全部匹配 |
| OTP 提取 | 与当次随机验证码一致 |
| synthetic observation | 未使用 |
| loopback 服务 | 已关闭，独立进程已退出 |
| 生产 registry / 主进程 | 未改动 |

这次证据比此前直接请求原生 endpoint 的验收更完整，覆盖了真实 HTTP 开箱、SDK
adapter 发送和 HTTP 收件提码；但仍是候选代码的隔离服务，不冒充生产主 HTTP
实例已经升级。也不宣称修复了 Resend token 或历史具体拒绝原因。

受限明细只保存在 NAS：

```text
/volume1/docker/easyemail-sdk/operator/ops-20261028-sdk-native-delivery
```

目录 0700，attempt、receipt、private-output 和 private-stderr 均 0600。
对外证据不包含邮箱凭据、收件地址、随机标记、验证码或邮件正文。

## 3. 本地验证与审查

新功能回归先运行旧实现：26 项中 25 failed / 1 passed，符合预期。
独立交叉审查发现 OpenAPI 注册 schema 遗漏，补充 schema 与回归测试；该回归先前
12 项中仅 schema 用例失败。最终结果和有效行数见 `round12` 的机器证据。

| 最终检查 | 实际结果 |
| --- | --- |
| 聚焦回归 | 6 文件、63 tests passed |
| service/base 全量 | 79 文件、417 tests passed |
| TypeScript typecheck | 通过 |
| 独立 outDir 编译 | 通过，产物在 linshi |
| effective-line checker 单元测试 | 19 passed |
| ratchet / strict | 各扫描 1,059 文件，soft/mandatory/hard 均 0，无 oversized baseline debt |
| git diff --check、修改文本 UTF-8 无 BOM | 通过 |
| 真实隔离验收后的主服务检查 | 5,000 sessions / 2,914 messages；测试 session/message/binding 均未写入 |

20:49 UTC 再次只读复核，生产仍 healthy、restart 0、OOM false，provider 均 active、
无 errorClass，主维护更新时间为 20:47:20 UTC；有界日志窗口未出现新的 retry。

源码最大文件为 client 440 有效行，原有受影响文件均低于 500；新 domain policy、
binding adapter、新增两个测试文件分别为 8、30、85、66 有效行。没有新增超限例外。

候选与当前生产运行文件逐项 SHA-256 对照，真正的既有 JavaScript 变化只有：

```text
src/providers/http-policy.js
src/providers/cloudflare_temp_email/connector/client.js
src/providers/cloudflare_temp_email/connector/configuration.js
src/runtime/config.js
src/runtime/cloudflare-temp-email-config.js
src/service/provider-management.js
```

另新增 domain policy、send-binding 两个 JavaScript 模块。其他大量 source map
字节差异与独立 outDir 路径有关，不能因此发布整棵 build。后续发布白名单应为上述
8 个运行模块及其 maps，共 16 文件；忽略其他未提交修改与非必要 map 漂移。

## 4. 未发布及启用边界

只读确认生产 9 个 Cloudflare 实例均不是 tx-mail 专属实例，其中已有实例承载其他域的
历史 session；**不能把原有通用实例一键切成 binding**。后续启用需选择专用、受控
发件实例，并验证不会影响既有自动分配或 host binding。

只读路由审查确认 `shared:false` 能排除普通 shared 自动复用，但不能提供严格的
“每次必须 preferredInstanceId 才可选”保证：旧 host binding 优先，preferred 不可用时
可能继续自动选取，专用实例仍可能参与 provision seed。当前没有现成的 explicit-only
标记。本轮没有为此扩张路由语义，也没有新增或启用生产发件实例。

生产镜像仍为 `nas-snapshot-cow-20261026-003`。网络诊断、发送安全、显式原生
发送改动均未发布，未提交、推送或触发 Actions。发布与实例启用需要准确独立确认，
不能扩张此前只更新 `http-policy.js` 和 map 的待批准提议。

证据根为 `C:/Users/Public/nas_home/AI/GameEditor/linshi/easyemail-ops-20261025/round12`：
`real-delivery-20261027T204413Z.json`、`binding-*-final.json`、`service-tests-final.json`、
`schema-red.json`、`lines-*.json`、`before-lines.json`、`after-lines.json`、
`runtime-manifest-comparison.json`、`source-audit.json` 和 `native-send-scoped.diff`。
