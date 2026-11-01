# 历史发送 HTTP 400 的记录追溯（2026-10-28）

本记录续接 [发送安全修复](operations-send-safety-20261028.md) 与
[显式原生发送验收](operations-native-send-20261028.md)。本轮只读核查 Cloudflare，
没有发送邮件、修改 Secrets、启用观测或更新 Worker。以下时间均为 UTC。

## 本次核查问题

历史隔离验收在 2026-10-25 15:14:29–15:14:38 发生 HTTP 400，原回执仅保存
`category=send_provider`，未保存具体错误全文。此前已确认普通 Worker 发送优先进入
Resend，错误统一映射为 400；不能据此断言 API key 无效或发送域未验证。

本次检查现有 Worker 日志与 D1 是否还能恢复该次拒绝原因，不通过重发来猜测。

## 当前云端配置与实际查询

22:06–22:09 通过 Cloudflare API 联网核实：

- 目标仍为 `cloudflare_temp_email`；脚本记录的 modified_on 为 9 月 1 日。
- settings 和脚本列表均未返回 `observability` 配置；`logpush=false`，Tail consumer 0。
  这不是证明历史每个时刻都未采集日志，不将当前配置倒推成完整历史。
- 当前 `worker.js` 为 1,889,298 字节，SHA256 与 round11 已分析模块相同：

  ```text
  64d7823254f330604bc91d8822e49d14d6dd4412bd7ffdf327585a5a520f0acb
  ```

- 对 `cloudflare-workers` dataset、准确 service filter 执行三次只读 telemetry 查询：

| 查询 | 时间窗 | 返回事件 |
| --- | --- | ---: |
| 历史 Resend 全文检索 | 10 月 25 日 15:10–15:20 | 0 |
| 历史任意日志对照 | 同上 | 0 |
| 最近任意日志对照 | 10 月 27 日 21:00–22:00 | 0 |

三次均 HTTP 200、COMPLETED、`dry=true`。没有保存共享查询、创建 live tail 或修改
日志配置。keys endpoint 能列出字段不代表存在历史事件；实际结论来自 events 查询。
空结果也不证明请求未到达 Worker，或此前错误不存在。

同时联网核对官方文档：当前 Workers pricing 列出的日志保留期为 Free 3 天、Paid
7 天；该失败距查询约 55 小时。不能只凭“日志太旧”解释空结果，保留窗口也不保证
当时已启用采集、实际采样、没有截断或覆盖所有请求。本轮未调整账户套餐或采样率。

## D1 与代码路径

只读取 sqlite_master 表名和 `PRAGMA table_info(sendbox)`，没有读取邮件行、用户表
内容或 settings 值。sendbox 字段只有 id、address、raw、created_at，没有专门的
status/error 字段；PRAGMA 返回 changed_db=false、changes=0、rows_written=0。

对已核实相同摘要的 Worker 代码重新审阅：`sendMailByResend` 收到 SDK error 后直接
抛出 `Resend error: <name> <message>`；`sendMail` 的 sendbox INSERT 位于发送成功
之后。因此发送后端抛错不会进入该 sendbox 写入路径，不能把 sendbox 当作失败日志。
管理员 wrapper 会 console.error 后返回 HTTP 400，但本次可访问 telemetry 中未找到
对应记录。该结论不扩张为“Cloudflare 所有内部系统都绝不保留其他证据”。

## 结论与操作边界

**现有可访问证据不能补回那次 Resend 拒绝的具体原因。** 本次排除了继续把 sendbox
当作失败记录查询的方向，并确认历史/近期日志查询均无命中；不伪造 invalid key、
domain unverified、quota 等具体归因，也不把它等同于 TLS 前网络断连。

没有直接开启全量云日志。Worker 现有日志存在包含邮箱地址的分支，开启持久采集前
应先审核脱敏与采样，再单独批准配置变更。此前 SDK 显式 binding 的真实验收仍然有效，
但不代表默认 Resend 配置已修复，也不代表生产实例已经切换发送路径。

本轮没有修改产品源码或待批准的 16 文件包。证据根为
`C:/Users/Public/nas_home/AI/GameEditor/linshi/easyemail-ops-20261025/round18`，保存
`worker-source-readback.json`、`cloudflare-evidence.json` 和最终审计；没有保存原始云
日志、下载邮件正文或回显任何密钥。

官方联网参考：

- <https://developers.cloudflare.com/workers/platform/pricing/>
- <https://developers.cloudflare.com/workers/observability/logs/workers-logs/>
- <https://developers.cloudflare.com/api/resources/workers/subresources/observability/>
