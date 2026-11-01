# EasyEmail Cloudflare 发信链路与安全回退修复（2026-10-28）

本记录续接 [网络故障追踪](operations-network-20261028.md) 和
[部署运维记录](operations-20261025.md)。以下时间均明确使用 UTC；10 月 27 日
20:37 UTC 对应北京时间 10 月 28 日 04:37。

## 已确认的发送路径差异

通过 Cloudflare API 只读取得当前 `cloudflare_temp_email` Worker 设置及实际模块，
没有修改云端配置或发送邮件。Worker 模块 `worker.js` 为 1,889,298 字节，SHA-256：

```text
64d7823254f330604bc91d8822e49d14d6dd4412bd7ffdf327585a5a520f0acb
```

该值对应解析后的模块，不是包含随机 multipart boundary 的完整下载响应。
初次针对未压缩符号的正则检查没有命中；随后用 TypeScript AST 和函数名称标记定位
实际 minified 函数，不能把初次未命中当作相关分支不存在。

Worker 已配置原生 `SEND_MAIL` binding，同时存在全局 `RESEND_TOKEN` secret 和
SMTP 配置。普通 `/api/send_mail` 与管理员 `/admin/send_mail` 最终进入同一个
`sendMail` 实现：在已验证收件地址特例之外，先选择 Resend，再选择按域 SMTP，
最后才选择允许域的原生 binding。发信后端异常会统一映射为 HTTP 400。
独立 `/admin/send_mail_by_binding` 路径可直接调用原生 binding。

因此，既有原生 binding 到 Temporam 的真实投递成功，并不意味着 SDK 默认选择的
Resend 路径成功。历史 `round6/real-delivery.json` 只保留了 HTTP 400 和
`category=send_provider`，分类条件与错误消息中的 `resend` 有关；没有保留原错误全文，
无法进一步断言是密钥无效、发送域未验证还是其他 Resend 拒绝。
本次凭据库文件名及内容索引没有找到 Resend 凭据，未回显任何密钥。

没有删除全局 `RESEND_TOKEN`、调整 Worker 发送优先级、替换发件地址或扩大允许域。

## 本地修复：不因模糊失败重复发信

原 SDK 对错误字符串匹配 `no balance|failed to send mail|status 400|status 401|status 403`，
可能把 Resend 配置拒绝、SMTP 确认丢失和服务器错误都交给管理员接口再次发送。
管理员路径仍选择相同后端，既不能修复配置，也可能在首次发送已接受但响应失败时重发。
没有证据显示生产实际发生了重复投递；回归模型用于证明原逻辑存在该风险。

修改 `service/base/src/providers/cloudflare_temp_email/connector/client.ts`：

- 只有实际收到 HTTP 401/403，或 HTTP 400 且 detail 精确等于既有英文/中文余额拒绝，
  才创建内部 `MailboxSendAccessRejectedError`，允许原有管理员 delegation。
- 其他 400、429、500、网络异常和任意抛出的错误文本均不触发管理员重发。
- 不改变公开方法、返回类型、默认发送路径、重试次数或 Worker 配置。

新增 `cloudflare-send-recovery.test.ts`，覆盖后端错误、精确余额拒绝、认证拒绝、
缺少管理员凭据、任意错误文本和“已接受但确认丢失”的单次发送约束。

## 验证证据

| 检查 | 实际结果 |
| --- | --- |
| 修改前回归 | 16 项中 9 failed / 7 passed，符合预期 |
| 修改后聚焦 | 4 文件、34 tests passed；新测试文件 17 项 |
| service/base 全量 | 77 文件、388 tests passed |
| TypeScript typecheck、独立 outDir 编译 | 通过，输出仅写 linshi |
| NAS Node v22.23.1 候选代码隔离验证 | 8/8；外网请求 0、邮件 0，未改主进程/registry |
| effective-line checker 单元测试 | 19 passed |
| ratchet / strict | 均扫描 1,055 文件，soft/mandatory/hard 均 0 |
| 修改文件有效行数 | client 428 → 434；新增测试 83 |

20:37 UTC 再次只读复核：生产镜像仍为原 snapshot-cow 镜像，healthy、restart 0、
OOM false；没有本轮自有诊断进程残留。9 个 Cloudflare 与 Temporam 全部 active，
没有 errorClass，主维护循环更新时间为 20:32:20 UTC。72 小时有界日志窗口仍是
65 条恢复事件，最后一次在 17:43:44 UTC；不将其当作最终业务失败数。

证据根目录：

```text
C:/Users/Public/nas_home/AI/GameEditor/linshi/easyemail-ops-20261025/
```

`round11` 保存 red/green/full 测试 JSON、line 报告、模块静态分析、NAS 隔离验证、
修改前源码、本轮 scoped diff 与 source audit；原始 Worker 模块不发布到源码仓库。
`round10/status-20261027T203737Z.json` 与 `main-state-20261027T203739Z.json`
对应本次只读状态复核，实际文件时间戳以目录记录为准。

## 尚未完成的边界

本次修复只消除不安全重发，**不宣称已修复 Resend 拒绝**。本轮没有发出新邮件。
网络诊断与发送安全修复仍未上线；没有更新生产镜像、重启服务、提交或推送。
后续新增的显式原生模式与新的 SDK 真实验收见
[显式原生发信与 SDK 真实验收](operations-native-send-20261028.md)，按实例 opt-in，
保留默认行为，不以失败后自动切换后端代替幂等保障；发布前必须重新确认准确范围，
不能扩张此前两文件诊断补丁的授权。
