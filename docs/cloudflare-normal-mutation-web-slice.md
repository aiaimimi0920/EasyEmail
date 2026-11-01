# 普通邮箱远端移动／永久删除网页（W14d3）

在 `migration/cloudflare-web` 独立工作区，将 [W14d2 后端](cloudflare-normal-mutation-operations-slice.md) 接入普通邮件共享详情。独立账号、服务器目录、聚合、会话与订阅入口使用同一组件；不改现行 NAS 或 Cloudflare 资源。

## 操作与数据边界

- 移动前显式读取同账号当前服务器目录，只显示可选择且不同于来源的目标。不会自动发现目录、同步或连接 IMAP。
- 选择目标后，只读检查其有效缓存 epoch；未同步目标须先到服务器文件夹显式同步。目标 INBOX 读取 canonical 缓存，但写入 body 保留 catalog folder id。
- 移动和永久删除分别确认。移动确认显示来源与目标；永久删除明确不可撤销，不是平台回收站操作。更换目标、源账号版本或 epoch 后不沿用确认。
- POST 仍使用独立 `mail-accounts:remote-move` 或 `mail-accounts:remote-delete` 权限。网页新增两项最小权限 Key 预设，不混入同步、配置、发信或另一种远端写入权限。
- 成功保留源缓存及平台状态，不将源 UID 搬到目标。目标邮件必须另行显式同步，不能把源移除事实展示为目标缓存已更新。

## 持有请求与只读恢复

会话级 Provider 保存原 key、body、来源、目标及消息身份，导航、关闭详情和切换目录不会重新生成请求。请求发送后没有“重试执行”按钮，也不会自动 POST。

回执严格校验账号、邮件、源 folder、key、revision、epoch、UID、action、目标 folder/epoch，以及状态、阶段、映射和时间字段。错回执、网络失败、存储不确定或未知错误不释放原请求。只有精确的预约前拒绝，或明确未派发的 failed 回执，才允许新的显式操作。

pending/unknown 保留原请求，仅允许 GET 原 key。unknown 不支持确认风险后另起请求；同一源的 confirmed 也不能重复操作。未决请求持有期间，网页保守锁住其他移动／删除及共享详情中的服务器标记；平台缓存仍可阅读。只读记录和目标查询使用 AbortController 及来源身份检查，避免换页后的迟到结果解锁新来源。

不向 localStorage/sessionStorage 保存邮件或操作。整页刷新／退出会话会丢失内存中的 held 对象；再次打开对应缓存邮件时，通过后端 latest 只读恢复持久事实，不自动 POST。若 POST 未确认且后端也未能保存记录，网页不能凭空恢复一条不存在的回执；后端物理锁及预约／派发边界不因此放宽。

## 验证与回退

新增回执／适配器测试及 Chrome 纵向场景，覆盖不同来源路径、明确风险确认、原键丢回执恢复、错误回执、pending/unknown、导航、目标未同步、目标 epoch 变化、迟到目标读取、共享详情、最小权限及窄屏。测试进入真实本地 Worker/D1/R2；IMAP 对端和用户均为合成夹具，不是真实邮箱互操作。

最终结果以 `linshi/easyemail-cloudflare-migration-20261028/normal-mutation-web-final/verification.json` 的实际 status、源码哈希及 fresh 测试清单为准；前期失败与局部通过不替代该收据。新增脚本进入默认 `test`／`test:web`，无新依赖或数据库迁移，仍为 58 项迁移。

回退只需恢复本阶段网页接线，不删除 W14d2 的 schema、回执或物理锁。没有提交、推送、合并或部署；真实 IMAP/TLS/OAuth、Cloudflare 资源/MX/公网投递、成本及正式发布／主干合并仍待后续独立验收，整体迁移未完成。
