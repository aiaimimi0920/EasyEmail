# Cloudflare EasyEmail 迁移边界

这里是新聚合服务的迁移入口，包含可本地运行的 Workers、D1 身份模型和 React 网页。
最新临时邮箱 W15a 见[有效凭据恢复访问](../../docs/cloudflare-mailbox-access-recovery-slice.md)：自营活体身份合同、聚合导入／恢复与 Web/API 原键回执；不按地址认领、不自动启用、同步或发信。新增0059，真实云端验收和发布仍未完成。
最新网页 W14d3 见[普通邮箱移动／永久删除网页](../../docs/cloudflare-normal-mutation-web-slice.md)：共享详情接入显式目标、分别确认、跨导航原键和 pending/unknown 只读恢复，不自动同步或重试。后端 W14d2 见[持久回执与物理锁](../../docs/cloudflare-normal-mutation-operations-slice.md)；无新迁移，缓存身份不搬移，真实互操作和发布仍未完成。
此前 W14c3 见[普通邮箱多目录远端标记](../../docs/cloudflare-normal-folder-flags-slice.md)：非 INBOX 显式服务器已读／星标、精确目录来源 fence 与永久原键恢复；新增0057，旧 INBOX URL 和 hash 不变。回复见 W14c2、平台整理见 W14c1、聚合读取见 W14b3，远端移动／删除及真实生产验收仍未完成。
此前[普通邮箱显式服务器已读与星标](../../docs/cloudflare-normal-remote-flags-slice.md)的独立权限、0053 guard、原键回执及平台本地状态保持不变。
当前已推进到 W9 持久发送队列/定时/取消，包含 W1 云端草稿、W2 标签整理、W3 文件夹、W4 联系人、W5 会话、W6 订阅、W7 多收件人/CC/BCC、W8 私有发送附件，并完成 M3n 完整自营上游本地集成；不是完整邮箱聚合产品，没有生产部署或真实邮件投递验收。
W10a 新增普通邮箱私有账号、加密只写凭据与原生只读 IMAP 连接检查。收件同步、正文、聚合和 SMTP 尚未因此接通。
W10b 增加内部 UID epoch/有界批次读取与 RFC822 字节/MIME 映射。
W10c 继续增加私有 D1/R2 收件存储、租约/版本保护及原子检查点；没有公开普通同步、聚合阅读或下载，不以内部持久化代替完整收件业务验收。
W10d 已接通普通邮箱的显式同步/原请求核对、当前来源缓存分页与正文、原文/附件下载及网页；统一聚合、普通邮件整理与发送、长期保留维护和真实收件验收仍未完成。
W10e继续接通带来源的聚合收件箱、普通正文搜索与缓存提码，保持旧API/Key范围；普通整理、会话/订阅、授权发送、长期维护和真实平台验收仍待完成。
W10f接通独立普通平台状态、已读/星标/归档/回收站、同账号批量API、原键回执及Web共同筛选，不修改远端IMAP；普通标签/文件夹、混合批量、永久清除及后续完整功能继续迁移。
W10g接通普通邮件私有标签/自定义文件夹、分类原子关联与唯一位置、共同筛选及共享Web组件；混合批量网页、会话/订阅/发送、安全保留维护和真实平台验收仍待完成。
W10h接通聚合页普通/临时来源批量选择、普通多账号串行分组、部分结果和未知原键核对/重试；没有跨组事务或新数据库迁移，普通会话/订阅/发送及真实平台验收继续迁移。
W10i补齐普通邮箱独立账号页的多选和批量整理、最近一页替换、50封上限、共享原键恢复和迟到分页保护；不新增后端接口或迁移，不写入远端IMAP。
W10j接通普通邮箱缓存会话、共享头证据图、原子索引及旧缓存有界补齐，聚合Web支持全部/普通来源会话与来源限定详情；只新增派生索引，不自动同步、已读或发信。
W10k接通普通订阅识别、完整组/成员、epoch隔离隐藏偏好、原键回执及全部/普通/临时来源网页；退订仅显式复制/确认打开，不执行服务端退订。

目标功能和阶段分别见：

- [功能确认清单](../../docs/cloudflare-feature-scope.md)
- [分支迁移计划](../../docs/cloudflare-migration.md)
- [双服务发布候选、无密钥目标描述、完整性校验及发布门禁](../../docs/cloudflare-release-slice.md)
- [当前供应商覆盖及许可边界](../../docs/cloudflare-provider-coverage.md)
- [远端随机地址、未知结果与请求键风险确认基础](../../docs/cloudflare-remote-allocation-slice.md)
- [215.im 授权临时 Token、实际期限及持久 inbox 游标](../../docs/cloudflare-im215-slice.md)
- [身份、权限与 API 边界](../../docs/cloudflare-identity.md)
- [供应商、收件与提取切片](../../docs/cloudflare-mail-slice.md)
- [邮箱整理、跨邮箱搜索与升级边界](../../docs/cloudflare-workspace-slice.md)
- [写信、回复、幂等与发送状态](../../docs/cloudflare-send-slice.md)
- [安全 HTML、附件摘要、下载与升级兼容](../../docs/cloudflare-content-slice.md)
- [平台停用、释放、回收站、清除与并发边界](../../docs/cloudflare-lifecycle-slice.md)
- [管理员隔离、供应商配置、只写凭据与显式探测](../../docs/cloudflare-admin-slice.md)
- [平台期限、保留预览、原子批次与幂等维护](../../docs/cloudflare-retention-slice.md)
- [自动分配、有限预检、供应商冷却与观测顺序](../../docs/cloudflare-allocation-slice.md)
- [创建历史、刷新恢复、显式风险确认与晚成功](../../docs/cloudflare-creation-slice.md)
- [单次新结果检查、固定条件、有界等待与停止](../../docs/cloudflare-extraction-slice.md)
- [条件远端删除、源资源代次、独立权限与未知结果核对](../../docs/cloudflare-remote-delete-slice.md)
- [邮箱代际删除、聚合预约、互斥与凭据释放边界](../../docs/cloudflare-mailbox-delete-slice.md)
- [生产创建函数的名称长度合同、随机性与旧 guard 兼容](../../docs/cloudflare-creation-compatibility.md)
- [精确自定义前缀、严格上游代理、能力预检与原子地址预约](../../docs/cloudflare-custom-prefix-slice.md)
- [用户管理、原子凭据撤销、自行改密码和升级 fence](../../docs/cloudflare-account-slice.md)
- [完整自营 Worker、原生收信入口与双 Worker 本地链路](../../docs/cloudflare-upstream-slice.md)
- [云端草稿、私有标签、文件夹与联系人](../../docs/cloudflare-feature-scope.md#6-当前迁移覆盖不是整体验收)
- [同邮箱会话、头证据/主题降级、位置范围、旧缓存补齐和回退](../../docs/cloudflare-conversations-slice.md)
- [订阅识别、私有隐藏偏好、显式退订地址和原请求核对](../../docs/cloudflare-subscriptions-slice.md)
- [To/CC/BCC、收件人数预算、旧 hash 兼容与私有内容清理](../../docs/cloudflare-recipients-slice.md)
- [真实二进制上传、私有 R2 资源、草稿引用、一次发送与补偿清理](../../docs/cloudflare-outbox-slice.md)
- [持久发送意图、定时、取消、准备重试、原发送 guard 与回退](../../docs/cloudflare-queue-slice.md)
- [普通邮箱账号、凭据、服务器白名单与只读 IMAP 连接检查](../../docs/cloudflare-normal-account-slice.md)
- [普通邮箱 UID epoch、字节读取与 MIME 基础及后续接线边界](../../docs/cloudflare-normal-read-slice.md)
- [普通邮箱私有收件存储、原子游标、受控对象与升级回退](../../docs/cloudflare-normal-storage-slice.md)
- [普通邮箱公开同步、私有阅读、下载与网页入口](../../docs/cloudflare-normal-inbox-slice.md)
- [普通来源聚合、正文搜索投影、有界旧索引补齐与缓存提取](../../docs/cloudflare-normal-unified-slice.md)
- [普通邮件平台状态、可恢复回收站、原键核对与共同筛选](../../docs/cloudflare-normal-organization-slice.md)
- [普通邮件共享标签、自定义文件夹、分类权限与升级回退](../../docs/cloudflare-normal-taxonomy-slice.md)
- [混合来源批量网页、逐组结果与安全恢复](../../docs/cloudflare-mixed-organization-slice.md)
- [普通邮箱独立页批量、当前账号选择与分页读取保护](../../docs/cloudflare-normal-batch-slice.md)
- [普通邮箱会话、来源隔离、原子索引与兼容回退](../../docs/cloudflare-normal-conversations-slice.md)
- [普通邮箱订阅、私有隐藏偏好、原键核对与安全退订地址](../../docs/cloudflare-normal-subscriptions-slice.md)

## 本地运行

Node 最低版本为 22.13.0。在本目录安装已锁定的开发依赖：

```powershell
rtk proxy npm ci --ignore-scripts
rtk proxy npm run build
```

`dist` 是忽略的构建产物。默认配置只指向本地 D1，`remote = false`，
数据库 ID 是占位符，`workers_dev = false`；不能用它直接发布生产。
需要允许本地注册时，将 `.dev.vars.example` 复制为忽略的 `.dev.vars`，
自行生成至少 32 个字符的随机 `REGISTRATION_TOKEN`。不设置则关闭注册。
禁止把生产凭据放入示例、测试、构建文件或 Git。

从本目录初始化隔离数据库并启动，始终保留 `--local`：

```powershell
$state = 'C:\Users\Public\nas_home\AI\GameEditor\linshi\easyemail-cloudflare-dev'
rtk proxy npx wrangler d1 migrations apply DB --local --persist-to $state
rtk proxy npm run dev -- --persist-to $state
```

浏览器打开 `http://localhost:8787`，保持与 `APP_ORIGIN` 完全一致。
Cookie 始终使用 Secure；本地 loopback 可用，不能为普通 HTTP 域名关闭安全属性。
开发服务自行按 Ctrl+C 退出；不会自动运行旧桌面、Node 后端或 NAS。

## 验证

测试使用独立随机目录、合成用户、邮箱及 loopback HTTP 供应商夹具，不读取生产配置。
必须明确测试产物根目录，Chrome 测试使用全新的临时 profile，不接管现有浏览器：

```powershell
$env:EASYEMAIL_TEST_ROOT = 'C:\Users\Public\nas_home\AI\GameEditor\linshi\easyemail-cloudflare-tests'
New-Item -ItemType Directory -Force -Path $env:EASYEMAIL_TEST_ROOT | Out-Null
$env:TEMP = $env:EASYEMAIL_TEST_ROOT
$env:TMP = $env:EASYEMAIL_TEST_ROOT
$env:WRANGLER_SEND_METRICS = 'false'
rtk proxy npm run typecheck
rtk proxy npm test
rtk proxy npm run test:web
```

`test:web` 默认使用已安装的 Chrome，可用 `EASYEMAIL_CHROME_PATH` 指定可执行文件。
不自动下载浏览器；测试结束关闭自己创建的实例，保留数据库与截图证据。
测试通过不代表真实供应商或生产环境通过，也未运行完整旧桌面测试集。

开发工具链精确锁定 Wrangler `4.154.0` 与其配套 Miniflare `5.20261023.1-beta`、
workerd `1.20261023.1`；Miniflare 的 v4 配置经官方转换器映射到 v5。
显式设置统一持久化路径，并实际重启验证，不依赖被新版本忽略的 `d1Persist`。
上述工具链升级仅针对聚合包；完整自营上游的独立依赖、严格构建与 `test:upstream` 安装步骤见完整上游切片文档，不修改原工作区依赖。

## 双服务发布候选（W13a）

`release:plan`、`release:prepare`、`release:verify` 只接受无密钥部署描述并准备/校验本地候选，没有发布模式。
候选包含完整自营 Email Worker、聚合 Worker/Web、独立资源接线、59 个聚合迁移及自营新实例 schema，不依赖 NAS 或旧根配置。
`deployment.example.json` 全部使用合成身份和域名，不代表已确认的 Cloudflare 资源；不要直接用示例进行真实发布。
产物应输出到 `linshi` 下尚不存在的新目录，失败保留现场，不覆盖已有候选。
独立验收运行 `npm run test:release`；它重新构建两个包，使用本地 workerd、D1/R2 和隔离 Chrome，不创建真实邮箱或投递公网邮件。
默认测试集也纳入后端候选检查和 Chrome 用例。完整命令、密钥名称、摘要锚定、审批和回退边界见[发布候选切片](../../docs/cloudflare-release-slice.md)。

## 共享核心可移植性

直接读取 `../base/src/domain/otp.ts`，不复制提码实现。
以 Node VM 提供的隔离 ES module 环境验证模块仅使用标准 Web 解码 API，
没有 Node 全局对象和运行时依赖。此验证不能替代 workerd 或 Cloudflare 真实运行验证。

从仓库根目录运行，不需要安装依赖：

```powershell
rtk proxy node --experimental-vm-modules --test service/cloudflare/tests/otp-portability.test.mjs
```

`stripTypeScriptTypes` 和 VM modules 可能打印实验性 API 警告。
测试数据为合成邮件，不使用真实收件、用户凭据或生产数据。

本地已接入自营邮箱管理员创建与 Temporam v3 随机地址分配，显式同步、邮件缓存及共享提码核心。
新自营邮箱随机名称采用 27 字符 base36 格式，保留 128 位随机性，匹配真实创建函数的 30 字符上限；Temporam 和已有地址/创建 guard 不变。
Web 还支持邮箱名称/备注/收藏、暂停平台同步、邮件已读/星标/归档及跨邮箱缓存筛选。
M3b 增加默认关闭的显式发送模式、收件允许策略、独立发送权限、基础写信/回复和持久化发送历史。
渠道接受不等于实际送达，unknown 不自动重试；本地夹具不代表真实发信验收。
M3c 增加默认纯文本、显式安全 HTML、独立附件下载权限与 SHA-256 字节核验；
自营旧接口没有摘要时仍仅显示 metadata，Temporam 不猜测附件下载合同。
M3d 增加停用/启用、释放平台访问和邮件回收站/恢复/缓存清除，独立删除 scope 不自动赋予旧 Key。
这些都是平台操作，不宣称远端邮箱或邮件已被删除；发送 guard、配额和去重 tombstone 保留。
M3e 增加仅会话管理员可用的 Web/API、版本化供应商/域名配置、加密凭据、显式认证探测及脱敏审计。
管理员默认空表，须由部署方核验用户 ID 后授权；API Key 不继承管理员权限。
M3f 增加默认关闭的平台保留策略、仅新邮箱期限、影响预览、确认执行、有限原子维护和幂等调度。
到期不等待 cron 才限制外部操作；缓存及发送内容清理仍保留去重与防重放记录，不删除上游资源。
M3g 增加显式自动选择、有限只读预检、持久化计数、分配冷却及 Web 状态；未知写入不换供应商重试。
这是 best-effort 均衡，不是严格轮询；旧记录元数据不猜测补全。
M3h 增加按用户隔离的创建历史、跨刷新核对与显式风险确认；原 guard 和配额仍保留，确认不取消或重放上游请求。
远端 unknown 对账/认领尚未实现，不能把解除页面等待说成已解决远端创建结果。
M3i 增加复用相同同步/提取规则的单页检查接口、固定条件及 60 秒/12 次上限网页等待；
停止、导航或退出不再发起后续检查，不访问认证链接，不启动持久化等待任务。
M3j 增加仅自营上游可用的条件远端邮件删除、独立 messages:remote-delete、持久化预约和只读结果核对；
ID 复用不误删新版本，unknown 不重发，平台缓存与远端删除分别确认。新增 0011，旧缓存不补认源身份。
M3k 增加独立 mailboxes:remote-delete、0012 持久回执、上游 capability 预检、同批预约停用和只读核对，Web 要求完整地址确认。
发送/邮件删除有未决结果时不能删邮箱；终态释放原代际凭据而不删除平台历史，KV/S3 等外部副本不在清理范围。
释放/到期清凭据不取消已派发请求，unknown 此后可能无法核对；不会额外保存凭据或自动重发。
M3l 增加手动/自动自定义前缀、真实能力与规则预检、全局原子地址预约和 Web 输入；未知结果保留原地址、不重写。
上游必须实现新的受约束创建合同；旧上游不可用时不回退旧 admin 路径，随机分配及旧 hash/guard 不变。
配置、权限、分页、不确定创建结果及尚未完成的能力以各切片文档为准。
M3m 增加用户搜索、停用/启用、全部凭据撤销、自行改密码、原子审计与 Web；重新启用不恢复旧凭据。
未来升级须先排空旧凭据签发实例再启用管理动作；没有账号恢复或全局在途业务取消。
不复用 `service/base` 的 Node HTTP server、文件快照或桌面凭据代理启动链。
## 云端草稿（W1）

写信页新增显式保存、云端草稿列表、跨设备打开、版本冲突核对及删除。
程序使用独立 `drafts:read`/`drafts:write`；草稿权限不含发送，旧 Key 不自动扩权。
应用新增 `0014_cloud_drafts.sql` 后再启用新运行时；不删除旧数据或发送 guard。
草稿发送以版本和内容 fence 与 outgoing 预留同事务提交，未知结果不允许换 Key 重发同一草稿。
完整合同、8 KiB 上限、删除墓碑、回退与未验收边界见 [云端草稿切片](../../docs/cloudflare-drafts-slice.md)。

## 私有标签与批量整理（W2）

聚合收件箱新增标签创建/编辑/删除、标签筛选、多选、当前页全选及有限批量整理；单封详情可打标。
新增 `labels:read`/`labels:write`，旧 Key 不自动扩权；批量回收站另需 `messages:delete`。
先应用 `0015_labels_organization.sql`。写入整批事务化，原 Key 重试只返回回执，不覆盖后续整理。
网页未知批次锁定原 Key/内容，工作台内切换视图仍可核对；不承诺浏览器刷新后自动恢复未决操作。
全部动作仅整理平台缓存，不操作上游邮件。合同、限额、升级回退和验收边界见 [标签切片](../../docs/cloudflare-labels-slice.md)。

## 自定义文件夹（W3）

新增层级管理、父级选择、文件夹筛选、单封和批量移动，独立 `folders:read`/`folders:write` 不扩权旧 Key。
删除文件夹将直属子级移根目录、直属邮件移默认收件箱，不删除邮件，回收站状态不变。
并发防环与目标活跃性在实际写入时判定；旧回执只回放，不重复移动。
先应用 `0016_folders.sql` 并排空旧整理写入实例，再启用新运行时；回退保留新表并暂停整理写入。
位置不等于上游文件夹。完整合同与验证边界见 [文件夹切片](../../docs/cloudflare-folders-slice.md)。

## 用户私有联系人（W4）

新增独立联系人页：搜索分页、新增/同邮箱 upsert、编辑及版本化删除，独立 `contacts:read`/`contacts:write` 不扩权旧 Key。
写信页可选择联系人，W7 可指定 To/CC/BCC 并替换或追加；不自动发送或绕过收件白名单，保存/发送未决和已提交草稿保持锁定。
联系人写入与持久回执同事务，同 Key 重放不覆盖后续版本；网页丢响应可用原 Key 核对，刷新后不承诺自动恢复。
先应用 `0017_contacts.sql`；旧本地表没有云端归属，不自动复制真实通讯录。回退保留新表、墓碑及回执并暂停联系人写入。
完整 API、隐私、升级及未验边界见 [联系人切片](../../docs/cloudflare-contacts-slice.md)。

## 缓存会话浏览（W5）

聚合收件箱保留默认逐封视图，新增同用户/邮箱会话切换、完整位置范围计数、成员分页和逐封详情/操作。
复用 `messages:read`，标签/文件夹筛选仍需相应 read scope；不自动已读、同步、回复或发送。
有引用头时支持晚父/桥接图归并，无 ID 证据才使用明确的主题降级；不是邮件真实性或投递证明。
先应用 `0018_conversations.sql` 并排空旧 sync/purge/retention writer。会话 GET 每次最多补齐 20 条旧缓存派生索引，
未完成返回 503，网页等待手动刷新；不影响原逐封读取的只读行为。回退保留新表与墓碑，不盲目恢复旧清理 writer。
完整 API、上游扩展、事务、隐私、清理与兼容边界见 [会话切片](../../docs/cloudflare-conversations-slice.md)。

## 缓存订阅邮件（W6）

独立订阅页提供同用户/邮箱的 List-ID 或发件人分组、搜索、完整位置计数、成员分页和逐封详情/回复。
新 `subscriptions:read`/`subscriptions:write` 不扩权旧 Key，读取还需 `messages:read`；隐藏只是平台偏好，不代替远端退订。
方法有界、前后端复核 URL，只有用户确认才打开外部地址，也可显式复制；不自动抓取或发送 one-click POST。
旧缓存没有头证据时保持未知，显式同步可补齐；首次显式正/负证据冻结，元数据不改变原 fingerprint。
先应用 `0019_subscriptions.sql` 并排空旧 sync/purge/retention writer。回退保留新表和回执，暂停不认识新侧表的清理写入。
完整 API、幂等、事务、隐私和未验边界见 [订阅切片](../../docs/cloudflare-subscriptions-slice.md)。

## 私有发送附件（W8）

新增 0021 和可选私有 `OUTBOX` R2 binding，默认配置不会创建真实资源，缺失时上传明确不可用。
单文件最多 2 MiB，每封最多 5 个、合计 3 MiB，固定 24 小时；未清理预约计入容量及上传限额。
新增 `attachments:write`，旧 Key 不扩权；草稿/发送仅提交 `{id,version}`，真实字节不放进 D1 或通用 JSON。
网页支持文件选择、原上传核对、跨设备草稿、不可用提示和引用移除；发送未知结果始终保留原 key，不自动重发。
升级须先迁移并排空旧发送/草稿/清理 writer；回退保留新列/表/对象，暂停不认识新格式的旧写入。
完整合同、故障补偿和验收边界见 [发送附件切片](../../docs/cloudflare-outbox-slice.md)。

## 持久发送队列（W9）

新增 0022、独立 `messages:schedule`、不可变意图、定时、预约前取消、有界准备重试及 Web/API。
已接受意图不依赖浏览器运行；Key 撤销不暗中撤销任务，账号/邮箱/供应商资格在真正预约前重新检查。
发送与立即路径复用原 guard 和单次外部派发；unknown 不重发，accepted 不等于 delivered。
每分钟 cron 仅处理最多 3 个任务；原每 15 分钟维护独立保留。先迁移并排空旧 writer，再启用队列。
完整合同、权限、期限、附件 pin、草稿消费、清理、升级/回退和未验边界见 [发送队列切片](../../docs/cloudflare-queue-slice.md)。
