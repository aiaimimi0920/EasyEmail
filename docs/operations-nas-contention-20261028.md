# EasyEmail 共享 NAS 卷的 I/O 竞争取证（2026-10-28）

本记录续接 [快照尾延迟内核取证](operations-snapshot-io-20261028.md)。本轮只读检查
NAS 存储状态、块设备计数与容器日志文件元数据，没有重放快照、发送邮件、启动
诊断容器、安装工具或修改生产配置。时间均为 UTC，22:36 对应北京时间 06:36。

## 1. 空间与背景维护状态

22:31–22:32 检查 `/volume1`：

- 挂载为 Btrfs，源设备 `/dev/mapper/cachedev_2`。
- statvfs 总空间约 660.48 GiB，可用约 409.85 GiB，约 62.05% 可用。
- `btrfs filesystem usage -b` 显示 Device missing 0，Global reserve used 0；
  未分配空间约 357 GB，不支持把当前现象归因于卷容量耗尽。
- `btrfs balance status` 返回没有 balance；scrub 记录已结束，没有正在进行的 scrub。
  scrub 记录来自 2025-09-09，虽然当时 0 errors，但不能冒充本轮介质完整性验证。
- `btrfs device stats` 的 write/read/flush/corruption/generation 错误计数均为 0。
- 可访问的 dmesg 缓冲区中，预设 Btrfs、块 I/O、ATA、hung-task、md-fault 分类未匹配
  错误。只保存分类计数及时间范围，未导出原始内核日志。没有错误记录不等于硬件无故障。

Btrfs 的 statvfs inode 数为 0；这不是“inode 已耗尽”的证据，不能按固定 inode
文件系统的方式直接报警。这里只记录原始返回值，不据此执行任何清理。

## 2. 与 EasyEmail 所在卷对应的真实设备链路

通过块设备 major/minor 与 sysfs slaves/partition 映射确认：

```text
/volume1 -> /dev/mapper/cachedev_2 -> dm-10
  -> dm-5 -> md2 -> sata2p3 -> sata2
  -> dm-1 -> md4 -> nvme0n1p1 -> nvme0n1
```

sata2 的 rotational 为 1，型号 `WD7500BPKX-22HPJT0`，调度器显示 `[cfq]`；
nvme0n1 的 rotational 为 0。没有因为挂载选项含 `ssd` 就假定全部写入落在 SSD。

`dmsetup status /dev/mapper/cachedev_2` 显示 target 为 `flashcache-syno`，累计
read hit percent 为 86，累计 uncached writes 与 disk writes 都约 16.95 亿次，
dirty writeback 计数为 0。这里只记录状态和累计计数，不把它当成本轮命中率，
也不据此断言缓存损坏或擅自改成 writeback。没有执行可能显示敏感映射信息的
`dmsetup table`，没有写入任何 flashcache proc/sysctl 文件。

## 3. 无合成负载时的块设备排队

第一窗口约 22:31:36–22:32:06，30.42 秒：

- dm-10、dm-5、md2 的 ioTimeMs 均约 30 秒。
- md2 完成约 235.2 MB（十进制）的写入，窗口结束仍有 1,283 个 in-flight 请求。
- 此窗口未启动诊断重放；观测到的是生产共享存储原有活动。

第二窗口约 22:33:25–22:33:55，30.03 秒，已补齐实际 SATA 设备计数：

| 指标 | sata2 | md2 |
| --- | ---: | ---: |
| writesCompleted 增量 | 8,504 | 8,447 |
| 写入 sectors512 增量 | 315,398 | 290,360 |
| ioTimeMs 增量 | 29,738 ms | 29,915 ms |
| in-flight 起点 → 终点 | 135 → 4 | 617 → 20 |

sata2 的计数折算为：窗口内写入约 154.00 MiB、约 5.13 MiB/s，I/O 忙碌时间约
占 99.02%；writeTimeMs / writesCompleted 约 132.24 ms/次。md2 的
weightedIoTimeMs / windowMs 约为 65.06。

这些是块层累计计数的窗口差分，不是请求级 trace、介质服务时间或 p95。跨窗口
请求会影响差分解释，多个 dm/md 层不能相加成物理写入量。队列在第二窗口明显
下降，不能将第一个窗口末端的 1,283 扩张成“NAS 一直有 1,283 个请求堵塞”。

与上一轮独立进程的 Btrfs ordered-range/事务等待结合，证据支持：**共享卷存在
真实写入排队，不应继续把所有尾延迟都当成 EasyEmail JavaScript 编码问题。**
但两个窗口不同时，尚未证明每个历史慢 save 都由某个具体 writer 引起。

## 4. writer 与日志归属的边界

第一窗口读取进程 I/O 计数，dockerd 的 write_bytes 增量约 30.36 MB，另有
postgres、内核 worker 等写入。计数不能说明具体文件系统或写入目标，退出进程
未被完整归属。原采集器的 group 字段仅按 cgroup 字符串启发分类，可能把主机
Docker 守护进程误分为 other_docker；本结论不采用它作为容器归属证据。

第二窗口只比较 28 个运行容器的 LogPath 文件元数据，没有读取日志内容：

- EasyEmail 使用 json-file，`max-size=20m`、`max-file=5`；该窗口增长 0 bytes。
- daemon 默认 driver 为 `db`，多数其他容器使用 db。
- 稳定文件的可见大小合计增长 12,288 bytes，没有检测到轮转或截断。

文件大小不增长不等于没有页内更新或其他日志 I/O，且进程 I/O 与日志大小来自
不同窗口；所以不能认定 dockerd 的全部写入来自日志，也不能凭此认定其他容器
没有贡献。没有停止、降级、修改其他项目的日志、数据库或任务调度。

## 5. RAID 状态须单独解释

本轮读取的 md2、md4、md5 均 degraded 0、sync_action idle，未观察到正在进行的
数据阵列重建。md2 为 `[1/1] [U]`；这表示当前配置只有一个成员，不意味着双盘
冗余。没有据此修改阵列。

系统分区 md0/md1 显示 `[4/2] [U_U_]`，sysfs degraded 为 2；是否属于既有部署
布局需要通过 DSM 存储管理器核对。不能无依据地称其正常，也不能把它当作已证的
EasyEmail 尾延迟原因。没有执行 repair、rebuild、resync 或任何阵列写操作。

## 6. 工程决策与生产复核

本轮不新增绕开原子替换的产品路径，不迁移生产数据、不改挂载/调度器/缓存策略，
也不凭短窗口调大线程池或容器内存。已有的少写盘和未变化编码复用候选继续保留，
没有扩大待批准的 16 文件发信/诊断发布范围。

若要真正改变共享卷竞争，需要单独确定允许调整的其他服务负载、日志后端、存储
落点或 NAS 缓存方案；这些都不是只改 EasyEmail 编码循环就能安全完成的事。
缺少同一慢 save 时间窗内的逐文件/块 I/O 归属，仍不能给某个其他容器定责。

22:35:58 复核：生产 ID、镜像和启动时间与本轮开始相同；healthy、restart 0、
OOM false，authenticated readiness 通过。5,000 sessions / 2,914 messages，
9 个 Cloudflare 与 Temporam 均 active，`metadata.errorClass` 均为空，binding
opt-in 0。主维护更新到 22:32:21.400，回滚目录仍在。

证据根：`C:/Users/Public/nas_home/AI/GameEditor/linshi/easyemail-ops-20261025/round20`。
关键文件：`nas-storage-readback.json`、`contention-readback.json`、`cache-status.json`、
`production-readback.json`、`source-audit.json`、`evidence-summary.json`。
