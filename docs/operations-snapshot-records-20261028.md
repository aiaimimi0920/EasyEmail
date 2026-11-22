# 逐实例快照布局与有界多区段写入（2026-10-28）

本轮继续 [section 对齐候选](operations-snapshot-layout-20261028.md)，只做本地与
NAS 独立文件验证。没有生产更新授权，不更新镜像、不改生产配置、不重复发信。

## 1. 新确认的写入放大来源

只读统计生产 instances，9 个 Cloudflare 实例分别约 404–460 KB，主要来自 metadata。
其中 `domainsJson` / `providerDefaultDomainsJson` 各约 109 KB，`domains` /
`providerDefaultDomains` 各约 91 KB。上游探测会同时写入四个字段，九个实例重复保存。

不能直接删除这些兼容字段：

- `connector/configuration.ts` 会合并同组 JSON/CSV，并优先 provider-default 组。
- provisioning 的 seed 仍读取 `domains` / `domainsJson`。
- provider 查询接口返回完整 metadata；现有运维脚本也消费这些字段。
- 历史或手工配置不保证四个字段完全同值，删除字段可能改变实际域名池。

因此本轮保留全部键和值，只改变文件内布局与 patch 范围。前一候选虽然固定了
instances section 之后的偏移，但该 section 内的小长度变化仍会移动后续实例，
加上单个连续 changed range，导致一次探测更新仍需写约 3.7 MB。

## 2. 实现范围

`file-snapshot-codec.ts`：

- 大快照中，将每个实例的 status、healthScore、averageLatencyMs、updatedAt
  放到该记录尾部；大型 metadata 保持在其前面。字段和值不变。
- 每个实例记录单独补 0–4095 个 ASCII space，稳定后续记录的字节位置。
- 小于 256 KiB 的普通快照仍保留原紧凑 JSON。其他 section 不增加 padding。
- 基于 UTF-8 字节数计算所有范围；新旧 reader 均使用标准 JSON，无 schema 迁移。

新增 `file-snapshot-diff.ts`：

- 比较所有 4 KiB blocks，形成互不重叠的 changed ranges，裁去各范围两端相同字节。
- 只合并连续变化 blocks，不把中间大段完整相同的 metadata 一起改写。
- 上限为 128 ranges、总覆盖范围不超过 snapshot 的 50%；超过即完整回退，
  不返回截断 diff，不产生无界小写调用。

`file-state-store.ts` 继续 clone 到临时文件，完成所有 ranges 和短写后才 rename。
后续 patch 失败时关闭 handle、不发布部分文件、不更新成功缓存；保留现有 clone
不支持、长度变化、缓存限制和通常外部替换检测的保守回退。

没有新增后台线程、文件描述符常驻、独立 anchor 文件、目录清理或多文件事务。
仍由现有 persistence loop 串行调用，不声称支持其他进程并发写入或断电持久性。
编码仍依赖 registry 产出的普通记录，不扩展为任意带副作用 toJSON/getter 的序列化器。

## 3. 回归及独立审查

新增集成回归先运行上一候选：4 项全部按预期失败，分别证明连续大范围写入、
后续实例偏移变化、短写范围过大、无法模拟第二个独立 patch 失败。

实现后聚焦 5 文件、29 项通过。测试覆盖：

- 多个大 metadata 实例同时更新，写入不包含其中稳定的大段内容。
- latency/status 长度变化时后续实例位置不变，UTF-8 与完整 JSON 数据不变。
- 短写循环；第二个 patch 失败保留旧目标，随后可成功重试。
- diff 首尾、块边界、末尾非整块、不同长度、相同内容、50% 与 fragmentation 回退。
- 确定性字节变异可由完整 ranges 重建，不重叠、不丢字节。

独立只读交叉审查未发现当前普通记录、串行调用边界内的阻断性问题，确认
allocUnsafe 的各区段均被初始化。stat 指纹不是跨进程锁，atomic rename 不是 fsync；
这些现有边界没有被扩大解释成更强保证。

## 4. NAS 真实数据对照

2026-10-27 21:18:03–21:21:41 UTC，生产相同 Node v22.23.1、相同文件系统、
5,000 sessions / 2,914 messages，在独立目录分别比较：

1. 当前生产紧凑 JSON + 旧单范围 COW。
2. 上一 section 对齐候选。
3. 本轮逐实例对齐 + 有界多范围候选。

每种实现依次执行：单实例 latency 增长、全部 9 实例探测更新、等待实际 60 秒
保存周期后的探测更新、紧接一次探测更新。只在内存中修改 latency 和 updatedAt，
未修改真实主状态。未增加 fsync；每次保存后使用旧生产 reader 做完整 deep equality。

| 场景 | 方案 | 应用 wchar 增量 | kernel write_bytes | save 耗时 |
| --- | --- | ---: | ---: | ---: |
| 单实例 latency 增长 | 生产 | 39,270,378 | 39,268,352 | 1,648.56 ms |
| 同上 | section 候选 | 3,691,112 | 3,809,280 | 3,195.01 ms |
| 同上 | 本轮候选 | 596 | 4,096 | 1,446.66 ms |
| 9 实例探测更新 | 生产 | 39,269,402 | 39,415,808 | 2,137.75 ms |
| 同上 | section 候选 | 3,231,386 | 3,317,760 | 952.57 ms |
| 同上 | 本轮候选 | 1,849 | 118,784 | 1,055.37 ms |
| 等待 60 秒后更新 | 生产 | 39,270,183 | 39,989,248 | 2,550.23 ms |
| 同上 | section 候选 | 3,691,128 | 3,760,128 | 1,188.85 ms |
| 同上 | 本轮候选 | 532 | 135,168 | 1,265.95 ms |
| 紧接探测更新 | 生产 | 39,270,370 | 39,448,576 | 1,473.58 ms |
| 同上 | section 候选 | 3,692,400 | 3,776,512 | 1,682.32 ms |
| 同上 | 本轮候选 | 2,092 | 135,168 | 1,417.93 ms |

这些是独立进程 `/proc/self/io` 的增量，不等于介质最终写放大。wchar 包含进程
全部写入，不能将其严格等同于 JSON 差异字节。四个候选保存均只 patch 1 或 9 个范围。
本轮文件 39,319,041 字节，比同一输入的紧凑文件增加约 50.9 KB（约 0.13%）。

**证据支持进一步大幅降低写入量；不支持承诺 CPU、内存或长期尾延迟改善。**
候选依然观测到 clone 约 732 ms、rename 约 920 ms 的等待。12 个不同场景不是
长期随机配对采样，不能计算可靠 p95。与上一候选相比，部分 save 仍略慢。

本轮保留原始重放回执。末尾阶段检查发现 trace array 在切换实现、初始化下一个
文件时仍被引用，污染 baseline/section 最后一个 case 的阶段列表尾部；elapsed、
I/O、patchCalls 与数据比较结果在初始化前已经固定，不受影响。独立派生文件
`nas-traces-normalized.json` 明确记录修正：baseline 无阶段插桩；候选仅保留首次
rename 结束前的该次 save 阶段。原始回执未覆盖。脚本现已复制 trace array，
原脚本保留在 `diagnostic-source-before`；本轮没有为此重放或重复写入额外快照。

## 5. 最终检查与生产复核

| 检查 | 结果 |
| --- | --- |
| service/base 全量 | 82 文件、434 tests passed，无 pending |
| typecheck 与独立 outDir 编译 | 通过，产物在 linshi |
| checker 单元测试 | 19 passed |
| ratchet / strict | 各扫描 1,064 文件，soft/mandatory/hard 全为 0 |
| 有效行数 | store 125→116，codec 28→49，diff 33，新测试 115/54 |
| UTF-8 无 BOM、scoped diff、git diff --check | 通过 |

21:22 UTC（北京时间 10 月 28 日 05:22）只读复核：原镜像 healthy、restart 0、
OOM false；authenticated readiness 通过；sessions/messages 仍为 5,000/2,914。
9 个 Cloudflare 和 Temporam 均 active，主维护 updatedAt 为 21:17:21 UTC；
从正确的 `instance.metadata.errorClass` 字段读取，均无 errorClass。
此前 round13 临时 readback 曾读取顶层 `instance.errorClass`，该 null 字段不能
单独证明 metadata 为空；本轮修正诊断读取位置并重新验证，不改变历史回执。
21:07:46 UTC 之后无新增恢复日志，本轮独立重放进程已退出。

原始快照仅在 NAS `data/operator-snapshot-records-20261028` 下保留，目录 0700、
文件 0600，约 118 MB。未下载邮件、删除测试证据或删除回滚容器。

## 6. 发布边界与证据

本轮候选未发布。继续保留此前待批准的发信/诊断包白名单：8 个模块及 maps，
16 文件，不包含本轮 3 个 persistence 模块。没有默默扩张发布范围或启用生产 sender。
历史 Shadowsocks TLS 前断连的远端最终责任仍未确认，不能以本轮持久化优化结案。

证据根：`C:/Users/Public/nas_home/AI/GameEditor/linshi/easyemail-ops-20261025/round14`。
包含 `production-instance-sizes.json`、`metadata-sizes.json`、`ranges-red.json`、
`ranges-green-final.json`、`service-tests.json`、`nas-replay-*.json`、
`nas-traces-normalized.json`、`live-readback-*.json`、`affected-lines.json`、
`lines-{ratchet,strict}.json`、`source-audit.json`、`snapshot-records-scoped.diff`
和 `evidence-summary.json`。没有提交、推送或触发 Actions。
