# 快照尾延迟的 NAS 内核等待取证（2026-10-28）

本记录续接 [未变化快照的编码复用](operations-snapshot-encoding-20261028.md)。
本轮没有修改产品源码或生产配置，没有更新镜像，没有重复发送邮件。下面时间均为
UTC；22:26 对应北京时间 10 月 28 日 06:26。

## 1. 需要回答的问题

上一轮变化快照仍出现约 3.84 秒保存耗时，但只插桩了 capture/encode。应用层
异步调用的持续时间包含排队、系统调用和回调交付，不能仅凭它就把剩余时间全部
归因给磁盘，也不能把所有等待都当成 JavaScript 编码慢。

22:15 只读检查：NAS 和生产容器均没有 strace，宿主也没有 perf；没有为此安装
工具、修改宿主配置或提高容器能力。本轮采用独立进程的文件操作计时，以及仅针对
该进程 `/proc/<pid>/task/*/{status,wchan,syscall,stack}` 的只读采样。

只保留 syscall 编号、状态、内核函数名和时间，不采集 syscall 参数、邮件正文、
用户邮箱或凭据。此方法不是逐条 syscall 跟踪，不能证明采样间隔内没有其他等待。

## 2. 隔离方式与测量修正

- 使用当前生产镜像的 Node v22.23.1，加载上一轮最终编译的四个 persistence 模块。
- 生产快照仅以单文件只读挂载输入；5,000 sessions / 2,914 messages 只留在 NAS。
- 诊断容器 network none、只读 rootfs、cap-drop ALL、no-new-privileges、restart=no。
- 工作目录 0700，所有文件 0600；没有清理旧诊断文件或回滚现场。
- 只有独立工作文件允许写入；内存中的 probe/body 变异不是生产业务邮件。
- 同步记录 capture/encode/diff；异步分别记录 stat/copyFile/open/patch/close/writeFile/rename。
- 每次 save 后由旧生产 reader 完整读取，并做 deep equality；没有合并初始保存和后续保存。

最初三次采集器分别遇到远端辅助进程失败、`docker inspect` 超时、附着进程 wait
超时；原回执没有覆盖。事后逐一确认三个 Node 容器均 exit 0、OOM false，阶段
回执仍可恢复，但没有可用的完整内核采样，不能把它们当作完整取证成功。

之后改用只读挂载 harness 文件、detached 启动，并在收尾 inspect 之前独立保存
samples。384 MiB 组完整取得 575 次采样；768 MiB 对照组取得 618 次采样。
对照组辅助进程仍在收尾阶段失败（远端 exit 1、stderr 858 bytes，原 helper 未保留
错误全文），但 samples 和完整业务回执已先保存。之后通过只读 reconcile 恢复，
确认容器正常退出，明确保留 `collectorFinalizationFailed=true`，不伪装采集器成功。

两组实际执行 harness 的 SHA-256 相同：

```text
165aa4fb7e8ab27a5fffaccaadde1318d658ff84543a96a7d9a39bd194dd5129
```

生产容器实际限制是 768 MiB，MemorySwap 为 1,536 MiB；诊断原设 384 MiB。
两组诊断均显式设置 `--max-old-space-size=256`，生产没有该显式参数，因此对照
只匹配容器内存上限，不是生产完整资源行为复刻。实际采样间隔中位数约 28.5 ms，
不是精确 25 ms；两组不是长期、随机、配对的性能基准。

## 3. 已抓到的内核等待

### 3.1 384 MiB 组：内存回收与 Btrfs 等待并存

一次 probe 更新 save 为 5,208 ms，进程 CPU 664 ms：

- encode 1,870 ms；43 个线程采样落在 `wait_on_page_bit`，栈包含
  `shrink_page_list → try_to_free_mem_cgroup_pages → mem_cgroup_try_charge`。
  这证明该诊断进程确实遇到 memcg 回收等待，不能将这 1.87 秒全算作编码 CPU。
- rename 3,180 ms；111 个线程采样落在 `btrfs_pin_log_trans`，栈为
  `btrfs_pin_log_trans → btrfs_rename2 → vfs_rename → SyS_rename`。
  这部分等待确实已进入内核，不只是 libuv 排队。
- 小 patch 仍可观察到 `__lock_page → btrfs_file_write_iter → SyS_pwrite64`。

这纠正了诊断环境偏差，但不能反推生产正在发生同样的内存回收。

### 3.2 768 MiB 对照：仍有独立的文件系统等待

| 场景 | save 总耗时 | 主要阶段 | 对齐阶段的内核采样 |
| --- | ---: | --- | --- |
| 初始完整保存 | 1,574.7 ms | rename 998.0 ms | 35 次 `btrfs_pin_log_trans` |
| 第一次 probe 更新 | 1,476.4 ms | copyFile 714.2 ms | 25 次 `wait_on_page_bit`，syscall 16 |
| 第二次 probe 更新 | 948.2 ms | rename 296.1 ms | 11 次 `btrfs_pin_log_trans` |
| 第三次 probe 更新 | 1,969.5 ms | rename 1,325.2 ms | 46 次 `wait_current_trans` |
| 正文长度变化 | 3,150.8 ms | writeFile 1,132.0 ms；rename 1,470.8 ms | 创建与 rename 事务等待、B-tree/页等待 |

第一次 probe 更新的 clone 栈明确包含：

```text
wait_on_page_bit
__filemap_fdatawait_range
btrfs_wait_ordered_range
btrfs_clone_file_range
vfs_clone_file_range
ioctl_file_clone
SyS_ioctl
```

正文变化的 writeFile 阶段，38 次采样对应 `wait_current_trans → btrfs_create →
SyS_openat`。这里的 writeFile 是整个 Promise 调用，不应误写成“write syscall
独占 1.13 秒”。rename 阶段另有 `btrfs_pin_log_trans`、`btrfs_tree_lock` 和
Btrfs extent/B-tree 页等待。

对照组 encode 约 434–449 ms；未在这些采样阶段观察到上述 memcg 回收栈。
这不证明回收绝不发生，也不支持“加内存已解决尾延迟”：同组仍有 3.15 秒保存。

两组最终各 7/7 保存均通过旧 reader 完整数据相等检查。未变化保存仍没有完整
encode，kernel write_bytes 增量为 0；其耗时范围不是生产长期 p95。

## 4. 工程决策与尚未确认的原因

证据已将部分尾延迟从“异步操作慢”推进为具体内核机制：clone 的 ordered-range
等待、创建/rename 的 Btrfs 事务等待，以及受限诊断环境的 memcg 回收等待。
但本轮没有全局 I/O/事务跟踪，不能确定哪个并发 writer、Btrfs 内部事务、磁盘、
阵列或其他宿主服务延长了等待，更不能把 NAS 介质故障当作已证结论。

因此本轮没有继续堆叠产品优化，也没有：

- 因内核等待而盲目扩大 `UV_THREADPOOL_SIZE` 或生产内存限制。
- 取消 atomic rename、提前更新成功缓存、原地覆盖生产快照或放松失败恢复语义。
- 关闭文件系统安全机制、改挂载参数、加 fsync 或执行全局 drop_caches。
- 为压低单次 wall time 而自动退回每次完整写入，增加持续写放大。

继续保留上一轮的编码复用、逐实例布局与有界 patch 候选；本轮没有将它们混入
待批准的发信/诊断 16 文件冻结包。长期尾延迟与存储层最深责任尚未解决。

## 5. 生产复核与证据

22:25:45：生产容器 ID、镜像及启动时间与本轮 preflight 相同；healthy、restart
0、OOM false，authenticated readiness 通过。5,000 sessions / 2,914 messages，
9 个 Cloudflare 与 Temporam 均 active，`metadata.errorClass` 均为空，binding
opt-in 0。主维护更新时间为 22:22:21.342。

从 22:11:42 开始的有界日志未出现新 retry；不能据此宣称历史远端断连已经修复。
22:23–22:26 生产 memory.failcnt 保持 17,484，增量 0；该数值是累计历史计数，
不能拿它诊断本轮正在发生 OOM，也不能把它解释为 17,484 次业务失败。

五个诊断容器均已停止、exit 0、OOM false；保留的五个本轮目录约 198 MB，目录
与文件权限均受限。回滚目录仍在，没有更新生产或删除任何回滚容器。

证据根为 `C:/Users/Public/nas_home/AI/GameEditor/linshi/easyemail-ops-20261025/round19`：
`preflight.json`、`resources.json`、`nas-io-detached.json`、`io-analysis.json`、
`memory-control-reconciled.json`、`nas-io-memory-control-normalized.json`、
`io-control-analysis.json`、`final-metadata.json`、`production-readback.json`、
`source-audit.json`、`evidence-summary.json`。早期失败和 reconcile 回执另行保留。
