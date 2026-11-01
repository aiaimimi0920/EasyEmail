# 文件快照布局候选与 NAS 写入代价（2026-10-28）

本记录续接 [原生发信验收](operations-native-send-20261028.md) 与
[网络诊断](operations-network-20261028.md)。本轮只在本地和 NAS 独立文件上验证；
没有更新生产镜像、覆盖生产快照、修改挂载选项或全局 flush 策略。

## 1. 已确认的全量写入原因

生产使用 file persistence，保存周期 60 秒，维护周期 30 秒，主动探测周期 300 秒。
只读样本包含 5,000 sessions、2,914 messages，约 39.27 MB。其中：

| section | UTF-8 字节数 |
| --- | ---: |
| instances，20 个 | 3,705,208 |
| sessions，5,000 个 | 6,093,082 |
| messages，2,914 条 | 29,451,089 |

现有快照是紧凑 JSON。instances 位于 sessions/messages 之前，早期实例的
`averageLatencyMs` 从 9 变成 1234，即使只有 3 字节长度差，也会移动后续邮件数据。
现有等长 COW 优化不能处理这种变化，正确回退为完整临时文件写入和 atomic rename。
这是一个已复现的布局问题，不是通过减少持久化频率解决的问题。

## 2. 最小布局候选，尚未发布

新增 `service/base/src/persistence/file-snapshot-codec.ts`，FileMailStateStore 只替换
编码调用，不改变对外接口或 SQLite：

- 小于 256 KiB 的普通 snapshot 保持原紧凑 JSON。
- 大快照仅在 instances 数组之后补 0–4095 个 ASCII space，使该 section 进入
  4 KiB 字节桶。按 UTF-8 字节数处理，不按 JavaScript 字符串长度。
- 数据、schema 与 JSON reader 不变；没有新索引文件、迁移标记或多文件提交协议。
- 同桶内的实例字段增长、缩短可继续使用既有 clone/patch/rename。
- 桶跨越、缓存超限、clone 不支持或外部替换仍使用原有安全回退。
- 仍计算完整 snapshot，仍保留最多 64 MiB 的成功编码缓存；不声称减少稳态内存。
- 仍只写一个连续 changed range，不是任意多段增量存储；其他 section 同时变化可能
  使范围扩大，不能宣称每次只写 4 KiB。

codec 面向当前 registry 产出的普通 EasyEmailSnapshot，不是任意带副作用 getter
或 root toJSON 的 JavaScript 对象序列化框架。小快照仍有逐 section 与整体编码的
额外处理，当前没有证据支持 CPU 或内存总体改善。

## 3. 真实 NAS 数据重放

生产快照只读加载到独立 Node 内存，修改一个早期 Cloudflare 实例的 latency；
候选和旧版分别写 NAS 独立受限目录。未写主服务状态，未启动邮件发送或后台维护。

首轮即时增长/缩短重放：

| 方案 | 应用写入字符计数增量 | kernel write_bytes 增量 | save 耗时 |
| --- | ---: | ---: | ---: |
| 旧版，增长 3 字节 | 39,271,404 | 39,350,272 | 608.86 ms |
| 旧版，缩短 3 字节 | 39,270,265 | 39,268,352 | 607.11 ms |
| 候选，增长 | 3,691,130 | 3,694,592 | 2,273.76 ms |
| 候选，缩短 | 3,691,138 | 3,694,592 | 2,273.68 ms |

kernel 计数是进程 `/proc/self/io` 的增量，不等于磁盘介质最终写放大。
候选文件只增加约 1.66 KB 空白。旧生产 reader 读取候选、新 reader 读取旧版文件，
均对完整 seed 做 deep equality 并通过。不是只比较数量或合成小样本。

后续阶段剖析发现：未同步源文件时，clone 可等待约 883 ms；另一个样本的
rename 等待约 1,434 ms。显式 fsync 源后的一次候选 save 约 633 ms，但测量外
fsync 自身约 894 ms，不能把这项成本删去后宣称加速。因此没有给生产加 fsync。

## 4. 按真实 60 秒保存间隔复验

2026-10-27 21:04:33–21:06:47 UTC，在同一 NAS 文件系统上运行两轮对照。
每轮等待实际配置中的 60,000 ms，交替测量顺序，不执行显式 fsync；旧 reader
在每次保存后都校验完整数据。实际文件系统类型为 `0x9123683e`。

| 轮次 | 方案 | save 耗时 | CPU | 应用写入字符增量 | kernel write_bytes |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | 旧版 | 1,086.80 ms | 646 ms | 39,270,389 | 39,546,880 |
| 1 | 候选 | 3,921.89 ms | 585 ms | 3,694,298 | 4,071,424 |
| 2 | 候选 | 558.10 ms | 505 ms | 3,691,130 | 3,694,592 |
| 2 | 旧版 | 993.04 ms | 666 ms | 39,270,874 | 39,546,880 |

第一轮候选的 encode/clone/patch/rename 分别约为 1,295/927/74/1,582 ms。
第二轮分别约为 431/0.57/85/6.83 ms。因此，单纯等到正常保存周期仍不能保证
低等待；也不能把所有 wall time 波动都归因于 clone。

**结论：写入量降低约 90% 已验证；总体耗时和尾延迟改善未验证，且存在真实退化样本。**
两轮不足以给出长期 p95，也不足以证明任何文件系统修复。当前保留候选与证据，
不将其纳入推荐生产更新，不改全局文件系统设置，不用更多循环挑选有利样本。

## 5. 回归、构建与代码约束

| 检查 | 结果 |
| --- | --- |
| 新回归在旧实现上运行 | 7 项，3 failed / 4 passed，失败符合预期 |
| persistence 聚焦 | 5 文件、29 tests passed |
| service/base 全量 | 80 文件、424 tests passed |
| TypeScript typecheck 与独立 outDir 编译 | 通过，产物只在 linshi |
| checker 单元测试 | 19 passed |
| ratchet / strict | 各扫描 1,061 文件，soft/mandatory/hard 全部为 0 |
| 有效行数 | store 124→125，codec 28，新回归 107 |
| UTF-8 无 BOM、scoped diff、git diff --check | 通过 |

无新增例外，无剩余 oversized baseline debt。没有提交、推送或触发 Actions。

## 6. 生产及网络问题的最新边界

21:07 UTC（北京时间 10 月 28 日 05:07）只读复核：

- 镜像仍为 `nas-snapshot-cow-20261026-003`，healthy、restart 0、OOM false。
- authenticated catalog readiness 通过，未认证 catalog 为 401。
- 5,000 sessions、2,914 messages；9 个 Cloudflare 和 Temporam 均 active、无
  errorClass，主维护持久状态 updatedAt 为 21:02:21 UTC。
- 从 20:16:42 UTC 至本次日志读取没有新恢复事件。72 小时有界窗口仍为 58 个
  connect timeout、4 个 reset、3 个 socket，最后一条为 17:43:44 UTC。
- EasyProxy 新认证修复只明确处理 HTTP outbound 的认证拒绝，不能直接解释旧
  Shadowsocks 样本中的 TLS 前 FIN。没有同 flow 的 407 证据，不追加根因断言。
- 隔离 snapshot 进程已经退出。三个 NAS 测试目录共保留约 236 MB 敏感快照，
  目录 0700、文件 0600；未下载正文，未删除原始证据或任何回滚资产。

发布仍需独立授权。推荐白名单保持为原生发信文档中的 8 个运行模块及 maps，
共 16 文件，不含快照布局候选，也不改生产实例的发信模式。当前没有合适的
tx-mail 专属生产实例，不能将既有通用实例直接切换为 binding。

## 7. 证据

本地证据根：`C:/Users/Public/nas_home/AI/GameEditor/linshi/easyemail-ops-20261025/round13`。

- `production-section-sizes.json`：真实 section 大小。
- `nas-replay-*.json`：即时重放、两种 reader 的互读验证。
- `nas-profile-*.json`：encode/diff/clone/patch/rename 分段和独立 fsync 成本。
- `nas-cadence-*.json`：两轮真实间隔对照，不增加 fsync。
- `live-readback-*.json`：认证 readiness、主维护状态、增量日志和受限文件权限。
- `layout-red.json`、`layout-green.json`、`service-tests.json`：测试机器结果。
- `affected-lines.json`、`lines-ratchet.json`、`lines-strict.json`：代码规模检查。
- `snapshot-layout-scoped.diff`、`source-audit.json`、`evidence-summary.json`：变更与证据索引。

NAS 原始数据仅在 `data/operator-snapshot-{layout,profile,cadence}-20261028` 下保留。
它们不是生产 persistence 配置，不应被主服务加载或用于覆盖现有邮件。
