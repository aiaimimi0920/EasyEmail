# EasyEmail 网络故障追踪与诊断优化（2026-10-28）

本记录续接 [2026-10-25 运维记录](operations-20261025.md)。时间明确标注 UTC；
2026-10-27 20:16 UTC 对应北京时间 2026-10-28 04:16。历史采样与当前部署分开描述。

## 1. 已复现的故障机制

2026-10-25 17:02:19–17:06:41 UTC，在 NAS 的独立 Node 进程中，对生产相同
Cloudflare origin 执行最多 36 次只读 health GET：默认地址选择、两个固定 IPv4
轮换，保留 SNI 与证书校验，不修改主进程 dispatcher、生产注册表或重试次数。
35 次 HTTP 200，1 次 `ECONNRESET`，失败位于固定 IPv4 的新连接，不是旧 socket 复用。

失败连接的 Node 阶段记录：

- 本地端口 58028，peer reference `da281e45c3aeab28`。
- 约 3 ms 完成 TCP，尚未触发 `secureConnect`，约 1,504 ms 报 `ECONNRESET`。
- Docker 网桥和 NAS 出口分别抓取同一有界窗口的包头，snaplen 128，未解密 TLS。
- 出口 SYN→SYNACK 约 0.697 ms；客户端发出 1,896 字节握手数据，服务端 payload 为 0。
- 出口约 1,500.893 ms 首先收到入站 FIN，随后客户端 FIN；该失败流没有 RST，
  也未观察到相同序号和长度的数据段重复。不能把错误码机械理解为收到 RST 包。

同时读取到的旧 EasyProxy 日志将同一 NAS 源端口关联到 TUN 入站和 Shadowsocks
出站，context reference 为 `3ee7d1a650b172c8`、节点 reference 为
`2b6bac8b08f0a377`。出站记录时间为 17:04:18.488 UTC，代理池在
17:04:19.983 UTC 记录节点失败，与入口 FIN 的时间对应。

因此，这个复现样本的直接机制已经缩小为：**经 EasyProxy 的出网链路在 TLS
握手完成前结束连接，Node 将其报告为 ECONNRESET**。不是 DNS 失败、TCP SYN
超时，也不能归因于快照写入补丁。NAS 的快速 TCP 成功不等于代理后方端到端连接成功。

证据仍不能区分 Shadowsocks 远端自身、远端到 Cloudflare 的链路、Cloudflare 边缘
哪一方首先结束连接。更早的每一条十秒级超时没有对应报文，不能全部归为同一根因。
Undici HTTPS 的 connect timer 直到 `secureConnect` 才清除，连接超时也可能发生于 TLS。

## 2. 历史记录保留与部署漂移

两份受限 pcap 保留在 NAS：

```text
/volume1/docker/easyemail-sdk/operator/ops-20261026-transport-capture-retry1
```

目录 0700、pcap 0600，捕获进程已经停止。没有下载原始 pcap、输出 payload、
原始上游地址、SNI、认证头或邮件正文；本地仅保存脱敏阶段和流量摘要。
解析器另用合成 pcap 验证 SYN、FIN、重复段与隐私输出，共 1 项测试通过。

10 月 28 日再次读取同名网关容器时，其镜像与启动时间已经变化，旧时间窗返回空。
这不推翻此前实际读取的 5 条关联日志。保留原工具响应的脱敏字段摘录
`round9/gateway-failed-flow-original-observation.json`；该摘录明确不包含未保留的
原始错误原因或 failure threshold，不补猜 `EOF`。当前 `gateway-failed-flow.json`
是后来对新容器的空窗重读结果，不应作为旧故障不存在的证据。

## 3. 2026-10-28 当前生产状态

20:16 UTC 只读复核：

- EasyEmail 镜像仍为 `sha256:ab3bb5f637d875e79b841d08486ff276b7cbb57d610c71daed935ebcb06513cb`，
  healthy、restart 0、OOM false，启动时间仍为 10 月 25 日 16:17:09 UTC。
- 未认证 `/mail/catalog` 返回 401；本轮自有 tcpdump 和 transport probe 无残留。
- EasyProxy 已由另一轮维护升级为
  `sha256:830343bbb88ad671f4e2753cdd884aa6773aace046616d58a9eafd0f9a0cc253`，
  启动于 10 月 27 日 18:00:48 UTC；运行中、restart 0、OOM false。
  本轮没有部署、修改或重启该网关，详见 EasyProxy 的
  `docs/upstream-auth-repair-2026-10-28.md`。
- 网关真实状态为 TUN enabled/applied/ready；有效 nft 捕获链仅有 prerouting，
  VM 本机测试不走同一转发入口。通过容器的 NET_ADMIN 只读查询取得 nft 结果；
  最初 host `sudo -n` 因需要密码失败，不将它误报为 nft 表缺失。

读取 EasyEmail 当前容器 72 小时、最多 20,000 行日志，共 65 条恢复事件：
`UND_ERR_CONNECT_TIMEOUT` 58、`ECONNRESET` 4、`UND_ERR_SOCKET` 3。
它们都是 Cloudflare origin reference `83d0a1b8a29cb061`，最后一条在
10 月 27 日 17:43:44 UTC；当前网关 18:00:48 启动后至本次复核没有新恢复事件。
这是日志窗口计数，不是最终业务请求失败数或全历史故障率。

读取保留的上一修复版网关容器，在 17:43:41 发现一个 HTTP 节点的 `EOF`；
该节点随后也承接 NAS 到目标的连接。但这条 failure 缺少目标 context，且时间先于
EasyEmail 的重试日志，不足以精确证明它就是同一次生产请求，未做强行关联。

## 4. 当前链路与生产代码复验

对同一目标的两个 IPv4，NAS 主机与网关主机分别执行 12 次验证证书的 TLS：
两组均 12/12 成功。TCP+TLS 总耗时中位数分别约 798.465 ms、328.317 ms。
两机 OpenSSL 分别为 3.0.8 和 3.0.20，源地址与转发路径不同；不将该小样本
差值全部归因于网关代码，不据此擅自切换 NAS 默认路由或增加直连规则。

20:11:40–20:11:49 UTC，直接调用生产编译代码的只读 probe，9 个 Cloudflare
实例均 health/settings 成功，未写入主服务 registry。随后读取主服务持久状态：
9 个 Cloudflare 和 Temporam 均 active、无 errorClass，更新时间均为 20:12:20 UTC，
说明主维护循环在新网关上线后仍实际推进，而不是仅靠隔离探测或无流量窗口。

仍不把两小时无 retry、24 次 TLS 或 9 个 probe 成功当作长期稳定性保证。
本轮没有重复发送邮件；此前原生 SEND_MAIL 到 Temporam 的投递验收仍是独立证据，
不等于普通 SDK 发信路径最初的 HTTP 400 已修复。

## 5. 本地诊断优化，尚未发布

只修改 `service/base/src/providers/http-policy.ts` 的现有恢复日志：

- `elapsedMs`：单次失败尝试耗时，单调时钟取整，不包含第二次尝试。
- `transportPhase=connect_or_tls`：Undici connect timeout，不误称 TCP-only。
- `transportPhase=tls_handshake`：仅在错误 code 和 Node 明确的 TLS 建立前断开
  消息同时匹配时记录；不输出该消息本身。
- 其余为 `unknown`；错误 getter 抛出、循环 cause 等不会影响原有恢复。

不增加尝试次数、不重置调用方 deadline、不放宽证书或 redirect 策略，不将
POST/PUT/PATCH/DELETE 的模糊断连变成可重放请求，不修改全局 TLS 或生产 dispatcher。

先新增测试，旧代码出现预期的 5 failed / 3 passed；实现后：

| 验证 | 结果 |
| --- | --- |
| HTTP policy 与诊断聚焦 | 24 passed |
| service/base 全量 | 76 文件、371 tests passed |
| TypeScript typecheck 与独立 outDir 编译 | 通过，产物仅写 linshi |
| NAS Node v22.23.1 独立进程，真实 loopback TLS 前 FIN | 通过，识别 tls_handshake，外网请求 0 |
| checker 单元测试 | 19 passed |
| ratchet / strict | 各扫描 1,054 文件，soft/mandatory/hard 均 0，无 oversized baseline debt |
| git diff --check、相关文本 UTF-8 无 BOM | 通过 |

本轮没有更新 EasyEmail 生产镜像、提交、推送或触发 Actions。若后续发布，仅需
`http-policy.js` 与 source map 两个运行文件，不应夹带其余工作区修改；上线前仍需
独立确认范围、保存配置和数据、保留旧容器及镜像，并核验完整运行文件清单。

## 6. 证据与剩余边界

```text
C:/Users/Public/nas_home/AI/GameEditor/linshi/easyemail-ops-20261025/
```

- `round9/captured-transport-probe.json`：36 次请求和独立 socket 阶段。
- `round9/packet-transport-summary.json`：NAS 两个接口的脱敏 TCP 摘要。
- `round9/gateway-failed-flow-original-observation.json`：旧网关实际观察字段与保留边界。
- `round10/evidence-summary.json`：当前状态、TLS/SDK 结果及原始证据 SHA-256。
- `round10/gateway-correlation-*.json`：旧保留容器与当前网关的限定窗口元数据。
- `round10/main-state-*.json`：主服务持久化的实际 provider 状态与更新时间。
- `round10/service-tests.json`、`nas-candidate-*.json`、`lines-*.json`：本地及 NAS 隔离验证。

已确认一个真实 ECONNRESET 的代理链/TLS 前断开机制；未证明每条历史超时同因，
未判定是具体远端节点还是其后方链路先断开。新诊断改动尚未上线。当前网关认证修复
来自独立维护，不能将该轮已发布修复冒充本轮发布，也不能证明它解释所有旧 SS 故障。
