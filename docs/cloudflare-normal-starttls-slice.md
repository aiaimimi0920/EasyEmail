# W10s 普通邮箱强制 STARTTLS

## 范围与配置

迁移工作区 `C:/Users/Public/nas_home/EasyEmail`，分支 `migration/cloudflare-web`。
本阶段仅本地实现及验证，不读取生产密钥，不进行提交、部署、导入或切流。

`IMAP_ENDPOINTS` / `SMTP_ENDPOINTS` 仍由管理员配置，用户只选择受控 endpoint id，不能指定任意主机。

| 协议 | 端口 | security | 行为 |
| --- | --- | --- | --- |
| IMAP | 993 | 缺省或 `tls` | 原有隐式 TLS |
| IMAP | 143 | 必须显式 `starttls` | CAPABILITY → STARTTLS → 新 TLS socket → CAPABILITY → 认证 |
| SMTP | 465 | 缺省或 `tls` | 原有隐式 TLS |
| SMTP | 587 | 必须显式 `starttls` | EHLO → STARTTLS / 220 → 新 TLS socket → EHLO → 认证 |

```json
{
  "IMAP_ENDPOINTS": "[{\"id\":\"example\",\"label\":\"IMAP 升级\",\"hostname\":\"imap.example.test\",\"port\":143,\"security\":\"starttls\"}]",
  "SMTP_ENDPOINTS": "[{\"id\":\"example\",\"label\":\"SMTP 升级\",\"hostname\":\"smtp.example.test\",\"port\":587,\"security\":\"starttls\",\"recipients\":[\"receiver@example.test\"]}]"
}
```

这些是不可用的合成域名示例，不是实际邮箱配置。拒绝明文模式、端口 25 / 任意端口、缺失升级模式、模式/端口错配、私网名称及未知字段。
Web 下拉项显示实际主机、端口及 TLS/STARTTLS；SMTP 元数据不返回收件人 allowlist 或凭据。

## 安全与资源不变量

- 缺 STARTTLS、升级拒绝、握手失败或升级后缺 AUTH PLAIN 均失败闭合；没有明文认证、降级或第二次连接。
- 升级前忽略认证能力；升级后重新查询能力，SMTP 不读取第二个 greeting。
- `mail-socket-session.ts` 独立拥有一个连接生命周期：15 秒总 deadline、1 秒有界 cleanup、一次升级及当前 socket 所有权。
- 释放旧流锁后获取新 socket 的 reader/writer；不把旧明文 buffer 搬入 TLS 解析器，已读到的残余明文字节直接拒绝。
- 升级前后累计响应预算不重置：IMAP 连接检查 64 KiB / 读取批次 7 MiB，SMTP 64 KiB。
- 新旧 socket 的 opened/closed rejection 都被观察；超时后禁止升级或后续写入。晚到 opened 不能重新发送认证命令。
- 原有 EXAMINE / READ-ONLY、BODY.PEEK、UID cursor、持久同步 guard 与发送预约规则继续适用。
- SMTP DATA 前错误为 rejected；DATA 后不明确结果为 unknown；明确负响应为 rejected；最终 250 后 close 失败不撤销 accepted。accepted 仍不是投递确认。

## 兼容、重绑定与回退

旧 993 / 465 配置 hash 的输入字节不变，显式 `tls` 与缺省模式等价。
STARTTLS 采用独立 hash 前缀；模式/端口变化使旧账号及 SMTP 配置在发起连接前被既有 fence 拒绝。
重新保存时，IMAP 与 SMTP 都不能将旧凭据静默带到变化的 endpoint / 登录身份；启用时必须重新提供应用密码。
普通账号版本变化仍会使旧 SMTP 配置失效，发送前须重新保存 SMTP 配置。

不新增 D1 schema，不重写旧 guard、cursor、邮件对象或已接受/未知发送记录。
将来启用新配置时须先升级并排空旧 reader/writer，再开放新 endpoint。
旧 runtime 不认识 `security` 字段，遇到新配置会 fail closed；回退前必须恢复旧端点配置。新 STARTTLS 账号须重新配置并提供凭据，不能直接把 hash 改回旧值。
W10q/W10r 关于 tombstone、对象 journal 和旧容量门槛的回退限制继续有效。

## 本地证据与未验证边界

证据根：`C:/Users/Public/nas_home/AI/GameEditor/linshi/easyemail-cloudflare-migration-20261028`。
基线为 W10r `normal-capacity-final/verification.json` 的 2060 个 sourceHashes；本阶段最终结果以 `normal-starttls-final/verification.json` 的实际 status 为准。

测试区分两套 socket/流，覆盖升级前后命令时序、原连接精确 options、旧 hash、握手失败/超时、晚到 opened、buffer 注入、累计字节预算、close 失败/挂起、DATA 结果与原键重放。
另有逐阶段晚到回归：STARTTLS 完成、升级后 CAPABILITY/EHLO、认证 challenge/回复，在 close 不结算 pending I/O 时也须限时返回；迟到回复不能推进认证、信封或再次升级。
本地 workerd / D1 / R2 的 HTTP 集成覆盖认证检查、合成 MIME 字节缓存、重启与 guard；Chrome 覆盖准确标签、同步/正文、SMTP 提交、发送锁、移动布局及浏览器存储边界。
定向回归同时检查旧隐式 TLS、普通账号/同步/草稿/回复/附件/队列/保留路径；不把定向范围说成完整后端、完整 test:web、upstream 或全仓测试。

Cloudflare API 已于本轮联网核实：[TCP sockets 官方文档](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)。
`secureTransport: "starttls"` 的 `startTls()` 返回新的 Socket，旧流失效且每个原 socket 只能升级一次。
本地测试模拟该 API 替换语义，不证明外部 TLS 证书、真实服务商登录、端口可达性、Workers 资源成本或公网投递成功；这些必须在独立授权的环境验收。

OAuth2、远端多文件夹/flags、Agent 邮箱、更多供应商、旧数据导入和真实部署仍未完成。
