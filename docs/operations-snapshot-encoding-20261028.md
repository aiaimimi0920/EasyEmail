# 未变化快照的编码复用优化（2026-10-28）

本记录续接 [逐实例布局与多区段写入](operations-snapshot-records-20261028.md)。本轮
只做源码优化、本地验证和 NAS 隔离重放；没有更新生产镜像，也没有重复发送邮件。
以下时间均为 UTC，21:57 UTC 对应北京时间 10 月 28 日 05:57。

## 1. 证据确认的开销

现有 file store 虽然能跳过完全相同内容的文件写入，但必须先完整编码，再比较 buffer。
NAS 真实数据为 5,000 sessions / 2,914 messages，约 39 MB。21:46 的只读原型在
相同 Node v22.23.1 上测得四次完整编码约 432–453 ms，而普通记录结构复制和比较
约 58–79 ms。数据含 14,526 个对象、164,503 个属性。

不能直接缓存原对象地址：`MailRegistry.snapshot()` 只新建数组，内部记录可以原地
修改；邮件正文、嵌套 actionLinks、metadata 和健康信息都必须能检测到变化。

## 2. 最小实现及安全边界

新增 `persistence/file-snapshot-comparison.ts`，只负责捕获用于比较的独立普通记录：

- 字符串作为不可变值复用，不重新复制约 39 MB 的字符串内容。
- 初次捕获复制容器；后续每次仍检查所有字段，复用内部已捕获的未变化子树。
- 全部相同时返回同一份内部状态，但从不因原始 registry 对象地址相同而跳过检查。
- 变化路径使用 copy-on-write，不修改上一成功捕获；保留数组空洞、undefined、
  属性顺序、null prototype 和自有 `__proto__` 数据键。
- 上限为 30,000 个对象、250,000 个属性、64 层嵌套。超过上限直接放弃比较缓存，
  不保留部分结果，不把该上限变成业务数据拒绝条件。
- getter、Proxy、toJSON、非普通对象、循环引用等不走缓存，继续使用原编码器的
  行为和报错路径；捕获阶段不执行 getter 或 Proxy property traps。

`file-state-store.ts` 只增加最小连接：在首次 await 前捕获当前值，状态相同时复用
上次成功编码的 buffer。目标文件的 stat 检查仍然执行；外部替换时可用原字节修复，
不会把“内容没变”误解为“目标文件一定还在”。

只有完整写入、rename 与 stat 成功后才更新比较状态，失败重试仍重新处理当前值。
`maxCachedSnapshotBytes` 为 0 或不足以保留编码结果时，不保留比较状态。现有 clone、
有界 patch、atomic rename、旧 JSON reader 和串行调用约束均不变。

没有新增数据库 schema、后台线程、文件常驻句柄、跨进程锁或 fsync 保证。

## 3. 迭代结果与实际取舍

初版每次重建比较结构，再用 `isDeepStrictEqual` 比较；NAS 上未变化保存为
161–242 ms，但额外保留堆约 8.6 MB，变化保存仍需完整编码。没有停在这个实现：
最终改为复用内部不变子树，并去掉热路径中逐字段创建的类型数组和独立深比较遍历。
初版源码、编译文件和回执均保留在 `round17/initial-candidate` 及原始重放证据中。

21:52 的上一布局候选与 21:56 的最终实现使用同一规模真实数据，在独立文件重放：

| 场景 | 上一布局候选 | 最终实现 |
| --- | ---: | ---: |
| 四次未变化保存 wall time | 456–541 ms | 82–86 ms |
| 同上进程 CPU time | 479–497 ms | 101–104 ms |
| 同上完整编码次数 | 每次 1 | 每次 0 |
| 同上 kernel write_bytes | 0 | 0 |
| 探测信息变化 | 完整编码，CPU 540 ms | 完整编码，CPU 640 ms |
| 邮件正文变化 | 完整编码，CPU 554 ms | 完整编码，CPU 674 ms |

最终实现初始化后额外保留堆约 2.63 MB，属于该进程该次测量，不是全局 RSS 或长期
内存保证。对象/属性上限是结构数量限制，`maxCachedSnapshotBytes` 仍是编码字节
限制，均不是整个进程的硬内存限额。

**收益只对未变化保存已经证明。** 变化保存仍需一次结构检查和完整编码；最终探测
变化保存仍出现约 3,843 ms 的 wall time，邮件变化约 2,166 ms。不能据此宣称所有
保存更快，也不能宣称 clone/rename 等 I/O 等待、长期 p95 或尾延迟已解决。
两组不是长期随机配对生产采样，不用小样本计算生产吞吐或总 CPU 节省比例。

最终实现六次保存均由旧生产 reader 完整读取并做 deep equality，通过 6/6；初版
对照另有 12/12，但不将初版用例冒充最终代码的额外验证。最终未变化保存没有 encode
阶段，变化保存恰好一次 encode；探测变化仍是小范围写入，正文长度变化仍完整回退。

## 4. 验证结果

回归先运行旧实现：新六项集成测试 2 failed / 4 passed，失败对应重复编码和外部
替换修复时的重复编码。实现后覆盖独立容器替换、原地修改、写入期间修改、失败重试、
缓存禁用、结构复用、特殊键、getter/Proxy、非普通值及三种独立捕获数量上限。

| 检查 | 最终结果 |
| --- | --- |
| service/base 全量 | 84 文件、449 tests passed |
| TypeScript typecheck / 独立编译 | 通过，输出在 linshi |
| 最终编译运行模块与 NAS 被测模块 | 4 个 JavaScript 模块逐字节相同 |
| checker 单元测试 | 19 passed |
| ratchet / strict | 各扫描 1,067 文件，soft/mandatory/hard 均 0，无 oversized debt |
| 修改文件有效行数 | store 116→121；新 comparison 69；两个新测试 94/91 |
| scoped diff、UTF-8 无 BOM | 通过 |

## 5. 生产与数据隔离

21:57:26 只读复核：生产仍为原 snapshot-cow 镜像，启动时间未变，healthy、restart
0、OOM false，带认证 readiness 通过；5,000 sessions / 2,914 messages，9 个
Cloudflare 和 Temporam 均 active，`metadata.errorClass` 均为空，binding opt-in 0。
主维护最近更新时间为 21:52:21.227；21:22:12 后的有界日志未出现新 retry。
无新 retry 不能证明历史远端断连根因已解决。

三个本轮诊断容器均已退出、OOM false，network none、只读 rootfs；生产快照仅以
只读单文件挂载输入。只有重放目录允许写入，邮件内容不下载到本机或输出到报告。
两个独立工作目录合计约 118 MB，目录 0700、快照 0600，继续保留而不自动删除：

```text
/volume1/docker/easyemail-sdk/operator/ops-20261028-encoding-probe
/volume1/docker/easyemail-sdk/operator/ops-20261028-encoding-cache
/volume1/docker/easyemail-sdk/operator/ops-20261028-encoding-cache-v2
```

证据位于 `C:/Users/Public/nas_home/AI/GameEditor/linshi/easyemail-ops-20261025/round17`：
`encoding-prototype.json`、`nas-cache-replay.json`、`nas-cache-replay-v2.json`、
`cache-red.json`、`service-tests-complete.json`、`gates-complete/`、`source-audit.json`、
`evidence-summary.json` 及 scoped diff。失败与中间迭代回执不覆盖。

**本轮快照源码仍为未发布候选，不进入待批准的发信/诊断镜像。** 该 16 文件冻结包
和上轮候选镜像保持原样；未提交、推送、启用生产 sender、重启服务或删除回滚现场。
