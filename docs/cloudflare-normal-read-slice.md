# W10b：普通邮箱 UID 读取与 MIME 基础

本切片在 `service/cloudflare` 实现普通邮箱收件所需的原生读取和纯解析模块。
它不是已开放的普通邮箱同步 API：尚无普通邮件入库、聚合 Web 阅读、附件下载或持久化检查点。
W10a 的账号页面和 `/normal-accounts/{id}/test` 仍只检查连接，不执行 FETCH。

## 所有权和兼容窗口

- `normal-imap-reader.ts` 只拥有字节 framing；协议行与 RFC822 literal 分开读取，正文不经过协议行的 UTF-8 解码。
- `normal-imap-protocol.ts` 共享 TLS 内认证、CAPABILITY 与 EXAMINE；连接检查保持原响应结构和 64 KiB 累计上限。
- `normal-imap-fetch-input.ts` 解析有界 FETCH 属性；`normal-imap-fetch.ts` 核验目标 UID、大小、日期及 literal。
- `normal-imap-read.ts` 拥有 UID epoch、窗口、批次和临时检查点，不拥有账号、数据库或网络连接的创建/关闭。
- `normal-imap-client.ts` 为连接检查与读取共用 `cloudflare:sockets` 生命周期；`readImapMessages` 是内部模块接口，不是公开 HTTP 路由。
- `normal-mime-content.ts` / `normal-mime-headers.ts` 把字节映射为现有内容合同和有限语义头，不决定持久来源 ID。

本次不新增 D1 schema，不改旧临时邮箱、缓存、发送 guard 或 API Key 权限。
没有普通来源进入共享消息表，因此也没有给旧 `messages:read` Key 自动开放普通邮箱内容。
回退可保留新模块而停止后续接线；原工作区和现行部署仍独立运行，不执行数据删除。

## 原生读取合同

仅支持部署方白名单内的隐式 TLS 993、AUTH=PLAIN 和 INBOX。
认证后使用 EXAMINE，tagged OK 必须明确 `[READ-ONLY]`；拒绝重复/无效的 UIDVALIDITY、EXISTS、UIDNEXT 和 UIDNOTSTICKY。
UIDVALIDITY 与 UID 共同定义远端代际身份；sequence number 仅作为协议语法读取，不作为持久身份。

`readImapMessages(endpoint, username, password, cursor)` 接受 `null` 或 `{uidValidity, afterUid}`。
非法 cursor 在创建 socket 之前拒绝。相同 epoch 只向后扫描；epoch 改变返回 `reset: true` 并重新扫描，不能覆盖旧 epoch 的历史。
UIDNEXT 是本次扫描上界的快照；`complete` 仅指当前上界，不代表服务器以后不会收到新信。

每次扫描最多 100 个 UID 数值构成的窗口，并只尝试其中至多 3 个存在 UID。
空窗口推进到窗口末端，但不谎称全邮箱完成；有更多存在 UID 时只推进到已尝试的第三个 UID。
这保证响应和工作量有界，但历史 UID 极度稀疏时仍需很多调用，不能视为已完成生产成本优化。

每封先取 UID、RFC822.SIZE、INTERNALDATE、FLAGS，再用 `BODY.PEEK[]` 取原始字节并复核身份。
FETCH 属性顺序可变，UID 等字段可以在 literal 后；允许有界 FLAGS-only 通知，但不会用通知代替完整目标响应。
只有 FLAGS 通知而没有完整目标数据时失败，不将其当作“已抓取”或“已消失”。
metadata 与正文之间的 UID、大小或 INTERNALDATE 改变、截断流和缺失完成响应均拒绝整批成功。
不执行 SELECT、STORE、MOVE、EXPUNGE、APPEND 或 SMTP，不改变服务器 Seen。

读取结果包含 `items`、`skipped`、`cursor`、`reset`、`complete` 和 INBOX 元数据。
`message_missing`、`message_too_large` 是显式跳过结果，不生成空邮件。
后续持久化必须将这些结果与检查点一起保存、呈现；不能只存 cursor 后声称所有 UID 均已入库。
批次或 MIME 失败时不得持久推进检查点；重试从最后已提交的检查点开始。

## 资源与失败边界

- 协议单行 8 KiB，每条命令最多 100 条响应；意外 literal 仍被旧连接检查拒绝。
- 每封原始 RFC822 最多 2 MiB，批次累计网络响应最多 7 MiB；超限在分配/解析前拒绝。
- 每次完整网络交换 15 秒总时限，不随命令刷新；关闭只发起一次，最多另等 1 秒，避免 cleanup 无限挂起。
- 成功、失败与超时均关闭所属 socket；底层纯 reader 的直接调用方仍必须拥有并关闭连接。
- 外部错误只映射受控错误码，不回显服务器拒绝文本、认证内容或 MIME 原文，不自动重试。

## MIME 映射和不受信内容

使用锁定的 PostalMime 4.1.4，显式限制 nesting 32、headers 256 KiB、parts 200、内嵌 RFC822 深度 5、转发地址 100。
attachmentEncoding 固定为 arraybuffer；摘要针对解码后的附件字节，保留原始 index。
只输出前 100 个附件的 metadata，超过则 `attachmentsTruncated: true`；文件名 512、类型 256 字符。
sender 2048、subject 4096、text/html 各 131072 JS 字符，沿用现有缓存合同。

recipient 绑定已认证账号地址，不依赖 To/BCC 是否包含该地址；receivedAt 使用稳定 INTERNALDATE，而不是不可信 Date 或当前时间。
合法的负 Unix 秒保持不变，避免历史邮件在 reader 与 mapper 之间失配。
原始字节独立计算 SHA-256，RFC Message-ID 仅供有限线程归一化，不冒充 UID 身份；重复 Message-ID 不接受为单一 ID。
只提取白名单线程/订阅头并复用现有归一化，不返回任意原始头。

HTML 原值仍是不受信内容。未来网页必须继续通过现有 `SafeMailBody` 的 DOMPurify、sandbox 和 CSP 呈现，不能直接 innerHTML。
附件 metadata 的存在不代表已接通下载：必须另有普通来源路由、账号权限和 epoch 核验，不能交给 Cloudflare 临时邮箱 provider 下载。
本切片没有把上述内容写入旧缓存，因此不会提前展示虚假的可下载按钮。

## 验证与尚未接线的部分

测试覆盖逐字节分片、非 UTF-8/NUL、协议伪 tag 正文、属性乱序、sequence 变化、UID epoch 重置、空窗口、三封上限、跳过、大小/日期/UID 改变、重复身份、READ-ONLY、FLAGS 通知及真实 EOF。
MIME 测试覆盖 Unicode、稳定时间/收件人、二进制附件摘要、101 附件截断、正文限额、不受信头和 nesting/header/part 限额。
workerd 合成 transport 在构建期替换 `cloudflare:sockets`，执行生产 client、2 MiB literal、MIME、非法 cursor、超时与关闭；测试入口不接生产 Worker。

正式阶段收据使用证据根下 `normal-read-final-r2/verification.json`，仅以实际 `status` 为准；红灯和失败现场不覆盖。
本地合成 transport 不证明真实 TLS 证书、邮箱账号认证、Cloudflare 边缘 CPU/并发/成本或真实收信。

后续仍必须实现：普通来源及权限过滤、账号 revision/同步 lease fence、epoch/UID 的持久幂等、原子 cursor 与 skip 回执、正文/附件存储、聚合 Web/API、远端操作及授权发信。
不得把普通账号强塞进旧临时邮箱的全局唯一地址、lease、provider credential 或 source version 合同。
Agent、更多供应商、旧数据导入及独立真实部署验收继续保留在迁移目标中。

规范参考：本轮协议实现依据 RFC3501 的 EXAMINE、UID、BODY.PEEK 与 literal 语义，及 Cloudflare TCP sockets 生命周期；不声称完整 IMAP rev2/ESEARCH 支持。

- https://www.rfc-editor.org/rfc/rfc3501.html
- https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
