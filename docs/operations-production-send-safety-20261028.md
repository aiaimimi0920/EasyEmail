# EasyEmail 16 文件最小增量生产发布（2026-10-28）

本记录续接 [冻结候选验证](operations-release-candidate-20261028.md)。用户明确同意后，
只发布“网络诊断 + 发送安全 + 显式 Cloudflare 原生发信能力”，不包含快照候选，
不启用任何生产实例的 binding 模式。以下时间除单独注明外均为 UTC。

## 实际发布内容

- 网络恢复日志增加有界、脱敏的失败阶段和单次尝试耗时，不增加重试次数或重置 deadline。
- 模糊 HTTP 400、socket/reset 等发送失败不再触发管理员路径重发；明确认证/余额拒绝
  仍保留既有 delegation，不能解释成禁用全部底层连接阶段恢复。
- 支持显式 `sendTransport: "binding"`，直达 `/admin/send_mail_by_binding`；默认仍走
  原有 Worker 路径。本次现有 9 个 Cloudflare 实例均未切换模式。

白名单是候选记录中的 8 个模块及其 maps，共 16 文件。使用已冻结、已验收的 NAS 镜像，
没有从 dirty 工作树重新编译，没有安装依赖、发布整树、提交、推送或触发 Actions。

```text
image: easyemail/easy-email-service:nas-send-safety-native-20261028-candidate-001
image ID: sha256:d2ee8e3ecdbe0fed97e9efb2862fc4128f3c0560ead70c0bd732bba141c8f5d2
container: easyemail-sdk
container ID: 3122f074937088c97bbba32b90a4d8e557c1b1b0a3855f3fe3ea72cf44493ebd
base URL: http://192.168.15.200:18081
```

保留候选 tag 是为了使用已验证的同一镜像，不表示生产仍运行旧版。实际容器按确切
image ID 创建，service.env 与部署登记已指向上述镜像。

## 备份、切换与回滚边界

02:39:37 的实时预检通过：旧生产镜像与冻结包摘要匹配，423 个生产运行文件无漂移，
没有 open mailbox，5,000 sessions / 2,914 messages。磁盘可用约 440.1 GB，待备份
data 普通文件合计 593,091,032 字节。保留的历史回滚容器均未运行。

先备份原 inspect、部署配置、config、runtime.env、API token 与在线状态；旧服务正常
退出后再归档完整 data 目录，并核验归档内状态文件与停机时最新状态原字节相同。
一致数据归档含 940 个成员，不用上线前旧快照替代停机时基线。

| 时点 / 指标 | 实测 |
| --- | --- |
| 发出停止请求 | 02:41:39.318 |
| 旧容器正常退出 | exit 0、OOM false；stop RPC 27.551 秒 |
| 一致数据备份完成 | 02:42:44.354 |
| 新容器启动 | 02:43:27.106 |
| 带认证 readiness 恢复 | 02:43:35.972 |
| 停止操作起点到 readiness | 116.890 秒，包含备份与 Docker 操作；不是精确业务不可用时长 |
| 健康通过、配置登记完成 | 02:44:31.902 |

```text
backup: /volume1/docker/easyemail-sdk/operator/ops-20261028-send-safety-native/rollback
rollback container: easyemail-sdk-rollback-send-safety-native-20261028
previous image: sha256:ab3bb5f637d875e79b841d08486ff276b7cbb57d610c71daed935ebcb06513cb
```

备份目录 0700，inspect、配置、状态及归档均 0600。敏感备份只留 NAS，未下载邮件或凭据。
旧镜像、旧容器与此前三个回滚容器、历史备份全部保留。没有执行运维清理、递归删除、prune、orphan
cleanup 或 `down --remove-orphans`。更新只修改 service.env 的 image，以及部署登记的
image、image ID、时间；Compose 文件原字节保持。

切换失败恢复按真实容器身份判断，保留失败候选，再恢复旧容器及原镜像登记。默认保留
当前最新 data，**不回灌旧 data.tar 覆盖新邮件**。发布脚本有一次性 attempt guard，
不能为回滚而重跑发布脚本。回滚流程的 4 项故障模拟在本轮再次通过；没有在生产演练回滚。

## 独立生产核验

02:48:57 的独立核验通过：

- healthy、restart 0、OOM false；完整 HostConfig 保持，除镜像、容器身份和本轮 ops
  label 外的 Config 保持；端口、网络、服务别名、挂载、768 MiB 内存与日志轮转保持。
- 实际 427 个运行文件与冻结候选逐项 SHA-256 相等；相对旧生产变化恰好为白名单
  16 文件，新增 4 个文件。快照 store 保持旧字节，没有混入 codec/diff/comparison 候选。
- provider types、runtime templates、bindings、strategies、5,000 sessions、2,914
  messages 与停机备份逐项相等，不只是数量相等。凭据集合、绑定及嵌入 credential JSON
  除启动时间戳外相等；实例的稳定配置、密钥、连接信息与发信模式保持。
- config.yaml、runtime.env、API token 原字节保持。未认证 catalog 401、带认证 200；
  stats、只读会话列表、邮件列表及一封既有邮件完整详情读取通过，未创建新业务数据。
- 9 个 Cloudflare 与 Temporam 均 active，无 errorClass，binding opt-in 为 0。
- 仍为 file driver、60 秒保存周期。Compose 语法与容器内服务别名验证通过。
- 当时 4 次 health 均 exit 0、输出空。启动后日志仅 3 行已识别启动/SQLite 提示，
  无 retry、无未分类日志；这不等于历史远端问题已经修复。内存单次样本 284.7 MiB，
  不是稳态内存基准，也不据此宣称性能提升。

### 首次严格字段比对为何失败

首次核验拒绝了启动带来的非时间字段变化，失败回执保留，没有直接跳过实例验证：

- 4 个实例的 `credentialSetsJson` 仅嵌入的 createdAt/updatedAt 变化，凭据值不变。
- GuerrillaMail 探测地址及 m2u 探测时间由既有启动探测更新，历史 session/message 不变。
- GPTMail 从 cooling 变为 degraded，旧冷却**尚未过期**。独立、无网络的基线行为
  验证确认，未修改的 runtime 启动会无条件调用 `resetOperationalState`，清除运行冷却，
  随后的失败 probe 回到 degraded；state/errorClass 保持，并非本次发送补丁新增的行为。

最终比对仅对这些有源码及实际行为证据的运行字段做归一化，其他实例字段继续严格
比较。GPTMail 未恢复可用，不能把“10 个重点实例健康”写成“全部 20 个实例健康”。
重启清冷却是已识别的既有行为，本次不扩大 16 文件范围去改变它。

### 跨周期观察与进程身份复核

02:50:00–02:56:11 进行 186 次只读采样；采样窗口约 370.4 秒，包含收尾核验的总耗时
374.454 秒。主维护持久化更新时间从 02:48:35.313 推进到 02:53:35.342，确认不是只
靠启动 readiness。容器和主 Node 均未变化，healthy、restart 0、OOM false。

窗口内仅观察到 1 次状态文件替换，文件从 39,268,014 变为 39,268,200 字节；主 Node
块写入计数增加 39,759,872 字节。长度变化仍按既有实现全量写入，不能将本次发布写成
快照尾延迟或全量写开销已经解决。观察器没有写生产状态，也没有合成业务负载或新发信。

后续只读检查中，GPTMail 已重新进入 cooling，四个冷却字段与停机基线逐值相等；
它不是恢复可用。复验脚本最初固定要求启动后的临时 degraded 状态，因正常回到 cooling
再次拒绝，保留失败回执后改为严格核对这两种已证状态，不忽略其他字段变化。

另一次复验发现此前将默认 exec UID 0 当作主 Node UID 的假设错误。实际宿主 `/proc`
显示 root entrypoint 的直接 Node 子进程 UID 为 10001；入口脚本明确使用 gosu easy，
入口字节与旧镜像保持。已修正文档与核验器，不修改运行用户、入口或文件权限来迎合
错误假设。该失败属于运维核验器假设，不是服务降权失效。

03:02:40 的最终完整复核通过：427 文件与冻结候选相等；数据、凭据、配置、隔离与服务
别名继续保持，主 Node UID 10001，最近 5 次 health 全部成功。9 个 Cloudflare 与
Temporam 均 active，持久化维护更新时间推进到 02:58:35.363；GPTMail cooling 的四个
冷却字段与停机基线相同，m2u 仍为既有 degraded。无新 retry、未分类日志或额外发信。
备份摘要与首次成功核验一致，四个回滚容器均保留且未运行。内存末次样本 252.5 MiB，
仍不据此推导稳态内存节省。最终回执为 `final-verification.json`，本轮摘要为 `closeout.json`。

## 验证范围与未解决项

本轮重新执行 checker 单元测试 19/19；ratchet、strict 各扫描 1,067 个文件，
soft/mandatory/hard 均 0，无 oversized baseline debt。生产发布不修改产品源码，
没有冒充重新运行此前的 417 项全量测试。候选的 8 项实际镜像集成测试与一次真实
HTTP 发信、Temporam 收件及提码验收沿用已冻结证据，没有重放邮件。

历史 pre-TLS 断开最终远端责任与原 Resend 拒绝全文仍未恢复；没有调整 EasyProxy、
Worker、Secrets、允许域或 DNS。快照未变化比较优化仍未发布，变化保存仍有完整编码
和共享 Btrfs 尾延迟代价，不因本次功能发布而宣称它们已解决。

本地证据根为 `C:/Users/Public/nas_home/AI/GameEditor/linshi/easyemail-ops-20261025/round24`：
`preflight.json`、`deployment-receipt.json`、`verification-20261028T024828Z.json`、
`instance-field-differences.json`、`instance-difference-semantics.json`、
`startup-characterization.json`、`process-identity.json`、`live-persistence-observation.json`、
`final-verification.json`、`closeout.json`、`lines-ratchet.json`、`lines-strict.json`。
首次预检错误地将 tag 和确切 image ID 按字符串比较，改为解析后比较 image ID；失败
现场保留。切换时一次监控命令失败，延长只读 inspect 预算后成功，未重放发布操作。
