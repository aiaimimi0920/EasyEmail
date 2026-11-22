# 普通邮箱多目录显式远端标记（W14c3）

在 W14c2 多目录回复之上，把现有单 UID 的 `\Seen` / `\Flagged` 写入接到非 INBOX 目录。
仍区分平台已读／星标与服务器标记；阅读、刷新、导航、整页重载都不自动写远端。
本切片不包含 MOVE、COPY、EXPUNGE、远端删除、批量 flags 或 Agent 远端写；整体迁移与生产验收尚未完成。

## API 与精确来源

```text
POST /api/v1/normal-accounts/:accountId/server-folders/:folderId/messages/:messageId/remote-flags
GET  /api/v1/normal-accounts/:accountId/server-folders/:folderId/messages/:messageId/remote-flags
GET  /api/v1/normal-accounts/:accountId/server-folders/:folderId/remote-flag-operations/:requestKey
```

权限、Origin、正文白名单与[原远端标记合同](cloudflare-normal-remote-flags-slice.md)相同。
正文不增加字段，仍只允许 expectedRevision、epochId、flag、value、acknowledgedUnknownId；UID、wireName 和服务器地址均由服务端解析。
旧账号级 URL 仅接受 INBOX；目录路由不接受 INBOX 别名。Web 的 INBOX 别名继续使用旧路径，避免第二个写入命名空间。
旧 hash 保持 `JSON.stringify([accountId,messageId,input])`；目录 hash 使用独立版本标记并包含精确 folderId。

预约、最终派发与成功缓存投影复用同一目标 fence：账号 enabled／revision、owner active、source、epoch、generation、消息及 batch 的目录归属、当前 catalog source／wireName／selectable、UID／UIDVALIDITY 与发布 watermark。
预约另外复核发起凭据；派发保留当前凭据及 OAuth 授权 fence、30 秒准备窗口与最新操作序号。
平台回收站状态不被擅自解释为远端删除，也不改变原 flags 权限语义。

## 扩展 schema 与永久恢复

0057 仅向 normal_remote_flag_operations 追加 server_folder_id、server_wire_name、catalog_source 三列。
三列必须全 NULL（旧 INBOX）或全非 NULL；目录 ID/source 为 64 位小写十六进制，wireName 非空且不能是 INBOX。
不重写旧 guard、sequence、请求 hash、缓存内容或检查点，不新增重复索引；聚合迁移总数变为 57。
目录写在 0057 安装前明确拒绝；0053-only 旧 INBOX 读写保持兼容，schema 能力不跨请求全局缓存。

相同 user/key/body 仍永久只回放，先于当前目录、内容、endpoint、socket 或 OAuth 刷新查询。
历史 operation GET 按 owner、account、持久 folderId 校验，不依赖目录或内容仍存在；旧 URL 和其他目录不能读取该回执。
INSERT 丢回执仅只读核对，不能重获执行权；pending／unknown 与显式风险确认沿用原机制。
远端 STORE 已确认后即使目录失效，仍记录历史 confirmed，但不把旧观察覆盖到当前缓存或较新操作。

## 协议与 Web

可信 wireName 与命令白名单分开传递；先做 canonical modified UTF-7 校验，再进行 quoted-string 转义，且在打开 socket 前拒绝非法名称。
旧 `SELECT INBOX` 字节合同保留；其他目录只 SELECT 解析出的精确 wireName，不使用显示名或客户端命令片段。
保留 READ-WRITE、PERMANENTFLAGS、稳定 UID、精确 FETCH／唯一 STORE／读回确认，以及绝对 deadline 和无自动重连／重试。

独立目录、聚合、会话和订阅详情共用同一远端动作及稳定 provider。
原请求的 folderId 与 key/body 一起 held；跨导航仍从原目录路径核对或显式重送，不从当前页面重新推导目录。
latest 与原键回执都校验精确目录身份；错目录、网络错误和伪成功不能解锁或更换 key。
目录详情接入远端 revision，在完成或核对后只读刷新当前详情缓存；没有第二套 composer 或远端状态模型。

## 验证与发布边界

新增测试入口为 `normal-folder-flags-{protocol,runtime,boundaries,races,migration,web}.test.mjs`；旧 flags、目录读取／整理／回复与共享详情回归保留。
采用真实本地 Worker/D1/R2 与生产协议代码，只在测试构建替换合成 socket 和注入数据库 gate／丢回执。
覆盖相同 UID 的多目录隔离、转义和注入拒绝、逐项来源变更、预约期间撤销、晚完成、永久恢复、旧 schema、全 NULL 约束及浏览器错目录回执／导航／刷新。
最终结果以 linshi 中 `normal-folder-flags-final/verification.json` 和对应源码哈希为准；预检失败不冒充最终通过。

本轮不读取真实密钥、不连接真实邮箱、不发布 Cloudflare 或修改 NAS，不代表公网 IMAP/TLS/OAuth 互操作已完成。
未来授权发布应先备份并追加 0057，再更新 Worker/Web；回滚代码时保留新增列和全部永久 guard，不回退 schema 或删除回执。
