# 普通邮箱远端移动／删除协议基础（W14d1）

本阶段实现单 UID 的 MOVE／COPY／删除协议，以及统一 socket 客户端入口。
它是后续远端移动／删除纵向功能的内部基础，**尚未开放生产 API 或 Web 控件**。
没有新 schema、权限、后台任务或缓存写入；不能把本地协议测试通过解释为用户功能已全部完成。

## 当前入口与所有权

`writeImapMutation(endpoint, username, authentication, command, beforeDispatch, source, destination)`：

- `command` 只允许 uid、uidValidity 和 action（move／delete），UID 范围为 1..4294967295。
- 源／目标目录走现有 canonical modified UTF-7 校验和 quoted-string 转义；不接受命令片段。
- move 必须指定不同目标；delete 不得指定目标。
- 凭据、命令和目录在创建 socket 前检查，命令在任何 await 前复制，必需提供阶段回调。
- 复用 withMailSocket 的单一 15 秒绝对期限、STARTTLS 替换和有界清理；没有重连、自动重试或自动补偿。
- 每个不可逆阶段调用回调，前后均检查期限；回调只是执行前钩子，**尚不是持久 guard**。

## 协议行为

认证后再次读取 CAPABILITY，不依赖认证前的能力广告。
move 先 EXAMINE 精确目标，取得唯一稳定 UIDVALIDITY；再 SELECT 源，核对可写状态、源 epoch 和实际 UID。
支持 MOVE 或 IMAP4rev2 时优先使用单次 `UID MOVE`。
无原生 MOVE 时，仅 UIDPLUS／IMAP4rev2 能授权以下单 UID fallback：

```text
UID COPY <uid> <destination>
UID STORE <uid> +FLAGS.SILENT (\Deleted)
UID FETCH <uid> (UID FLAGS)
UID EXPUNGE <uid>
UID FETCH <uid> (UID FLAGS)
```

永久删除只执行后四步，并要求永久支持 `\Deleted`。
不会发送无 UID 的 EXPUNGE 或 CLOSE，不影响其他客户端已标记 Deleted 的 UID。
COPYUID 必须唯一，绑定精确源 UID、目标 EXAMINE epoch 和单一目标 UID；接受等值单例 range，不接受多目标或虚构映射。
源最终精确 FETCH 不存在时才返回 `sourceRemoved: true`。
目标 mapping 是服务器 COPYUID 证据，不承诺该副本在其他客户端并发操作后仍然存在；也不创建目标缓存或推进目标游标。

## 不确定结果与后续接入门槛

MOVE 可以部分失败；COPY／STORE／EXPUNGE 也可能已执行但响应丢失。
缺 COPYUID、连接失败、超时或后续 fence 撤销，均不能仅凭异常认定“远端未改变”。
本层不持久化阶段，不声称错误 retry-safe；公开入口接入前仍必须完成：

1. 任何网络前持久预约，冻结 owner、账号 revision、源目录／epoch／UID、目标目录及请求 hash。
2. 每个不可逆 phase 前原子记录派发意图，复核调用凭据／OAuth、source／catalog／epoch／generation；有歧义时只读核对，不重获执行权。
3. 与旧 remote-flags 共用目标级互斥，覆盖并发预约、旧 worker 共存、超时 pending、unknown 与新 key，不能两张独立操作表各自并行写同一 UID。
4. 部分副作用持久归为 unknown，保留原 key；不能把旧“acknowledged unknown 后新 flag”语义直接套到可能重复 COPY 的移动。
5. 缓存保持原接收 identity、UID、目录、batch／R2 所有权、本地标签／回收站和 reply／send pin；目标只能由独立同步创建新接收事实。
6. 新权限、精确路由、明确永久删除确认与 Web held key/body/source/destination 恢复，再做真实本地 D1/R2 与浏览器纵向验收。

## 验证边界

显式测试入口：

```text
normal-mutation-protocol.test.mjs
normal-mutation-boundaries.test.mjs
normal-mutation-auth.test.mjs
normal-mutation-client.test.mjs
```

前三类在 Node 中打包生产代码并使用合成 streams，覆盖算法、epoch、COPYUID、认证／STARTTLS、阶段撤销和部分副作用。
client 测试使用真实本地 workerd，仅在测试构建替换 cloudflare:sockets；覆盖单 socket、phase mapping、丢响应、错误脱敏、15 秒超时后晚回调及有界关闭。
测试 worker 不挂到生产路由，未添加测试后门。
这不是实际网络 TLS 握手、服务商 IMAP4rev2 全协议／UTF-8 互操作、真实 OAuth、邮箱投递或生产部署验收。

本阶段联网核对官方 RFC 6851、4315 和 9051；原文及本地验证收据放在 linshi 的迁移证据目录。
最终结果以 `normal-mutation-transport-final/verification.json` 为准，预检失败记录不代表最终通过。
没有读取真实密钥、连接真实邮箱、修改 NAS／Cloudflare 资源，未提交、推送、合并或部署；整体迁移仍在推进。
