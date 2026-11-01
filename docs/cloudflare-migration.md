# Cloudflare Web 分支迁移计划

当前网页补齐：见[单邮箱缓存邮件搜索](cloudflare-mailbox-search.md)。复用既有单邮箱与聚合查询，补齐关键词、发件人、时间及清除入口，保留显式同步与原分页合同；无新 schema、依赖或部署。本地结果以独立候选的验证收据为准。

当前运行可靠性修复：见[维护 cron 失败隔离](cloudflare-scheduled-maintenance.md)。八项既有维护保序、逐项捕获异常，全部尝试后仍报告失败；不新增调度、远端迁移或部署。
剩余供应商已独立核查，见[合同审计](cloudflare-remaining-providers.md)；不能将缺少协议/许可的适配器直接从旧 SDK 搬入，也不取消后续迁移目标。

最新临时邮箱业务切片：见[凭据证明的访问恢复（W15a）](cloudflare-mailbox-access-recovery-slice.md)，自营只读活体身份合同、聚合私有导入／恢复、永久地址 guard、Web/API 原键与丢响应核对。追加0059，共59项迁移；不按地址认领、不复活过期／删除、不自动启用、同步或发信。本地收据独立验证，未发布且整体目标继续。

当前网页进展：见[移动／永久删除网页（W14d3）](cloudflare-normal-mutation-web-slice.md)。共享详情接入显式目标、独立风险确认、严格回执、跨导航原请求保留及 pending/unknown 只读核对；不自动同步或重试。无新 schema／依赖，真实互操作及发布仍待完成。

当前远端移动／删除进展：见[持久回执与互斥后端（W14d2）](cloudflare-normal-mutation-operations-slice.md)。已接通精确来源 API、独立权限、永久物理目标锁、每阶段 fence 及原键只读恢复；协议基础见 [W14d1](cloudflare-normal-mutation-protocol-slice.md)。
数据库追加0058，共58项；不改源缓存或游标。该后端阶段不包含网页验收，网页由 W14d3 独立验证；不代表真实互操作或生产迁移已完成。

最新普通邮箱业务切片：见[多目录远端标记（W14c3）](cloudflare-normal-folder-flags-slice.md)，接通非 INBOX 显式服务器已读／星标、精确目录来源 fence 与永久恢复；[回复（W14c2）](cloudflare-normal-folder-reply-slice.md)、[平台整理（W14c1）](cloudflare-normal-folder-organization-slice.md)及[聚合读取（W14b3）](cloudflare-normal-folder-projection-slice.md)保持兼容。
数据库追加0057，共57项；保留旧 INBOX hash、共享原键及目录历史回执。远端移动／删除、真实互操作及发布尚未完成。
此前[显式服务器已读与星标（W14a）](cloudflare-normal-remote-flags-slice.md)的单 UID 写、0053 guard 和平台状态语义保持不变，整体迁移继续推进。

最新发布准备：见 [双服务发布候选（W13a）](cloudflare-release-slice.md)，无密钥目标描述、完整双 Worker 打包、摘要校验与重定位本地运行。
仅准备候选，不创建云资源、不设置密钥、不发布；实际本地结果以该切片独立收据为准，真实资源和公网投递仍须独立授权验收。

最新创建基础：见 [远端随机地址分配（W12f1）](cloudflare-remote-allocation-slice.md)，先预约再绑定真实地址、未知地址不虚构、请求键风险确认和原键只读核对。
本切片不是 M2U/ETempMail 适配器；仍需精确供应商协议核查，本地结果以本切片独立收据为准，不代表真实创建、投递、发布或整体迁移完成。

最新供应商切片：见 [215.im 授权临时邮箱（W12e）](cloudflare-im215-slice.md)，精确单次创建、独立邮箱 Token、真实到期时间和 inbox ID 游标；公开域名不伪报 Key 有效，无新 schema 或依赖，本地结果以独立收据为准。
此前 [GuerrillaMail 公共会话（W12d）](cloudflare-guerrillamail-slice.md) 已接通显式公共模式、精确随机地址绑定、加密 Token 轮换检查点和较小 ID 持久续页；不会因会话失效静默换地址，不用初始化写入伪装只读探测，无新增 schema。
此前 [DuckMail 临时账户（W12c）](cloudflare-duckmail-slice.md) 已接通独立邮箱 Token、24 小时上游期限、显式匿名/Key 模式和数字分页；只有匿名模式可探测公共接口，不伪报 Key 有效。
完整供应商进度见 [迁移覆盖表](cloudflare-provider-coverage.md)，TempMail.lol 的聚合许可和消费式读取语义尚待澄清；不取消后续目标。
此前 [GPTMail 授权接入（W12b）](cloudflare-gptmail-slice.md) 已接通显式域名/凭据、本地随机地址、有界列表摘要续批及 Web/API；公共统计不能充当凭据探测。
此前 [MoEmail 授权实例（W12a）](cloudflare-moemail-slice.md) 已接通随机分配与持久 cursor；0052 只扩展续页存储，保留原数字分页。
Mail.tm 因官方禁止代理条款暂停接入，实验已保留且正式源码恢复；本地结果以独立收据为准，真实实例/投递、云端发布和整体迁移仍未完成。

最新授权切片：见 [Agent Google OAuth（W11j）](cloudflare-agent-google-oauth-slice.md)，共用授权/刷新状态机、独立凭据域、网页回调及 Agent 收件/任务/跟进发信接入。
SMTP 与自动收件仍须独立启用/重新绑定；本地验收以该阶段独立收据的实际 status 为准，不代表真实 Google 登录、公网投递、发布或整体迁移完成。

最新自动收件切片：见 [Agent 持久授权自动收件（W11i2）](cloudflare-agent-auto-inbox-slice.md)，默认关闭、独立授权/权限、版本绑定、共享容量与 claim、有限 cron、退避、原键恢复及 Web/API。
本地验收以该阶段独立收据的实际 status 为准；当时尚未包含 Agent OAuth。真实供应商/公网投递、Cloudflare 部署和整体生产迁移仍未完成。下列旧阶段的未完成说明为历史范围，不覆盖本阶段进展。

自动收件前置切片：见 [Agent 持续容量（W11i1）](cloudflare-agent-capacity-slice.md)，移除终身请求门槛、成功空批次不占内容额度、live 部分索引及网页首次 429 解锁。
不删除旧回执，不改变未确认内容释放或未知原键规则；历史元数据仍增长，整体迁移仍未完成。

最新同线程网页切片：见 [follow-up 网页（W11h3b）](cloudflare-agent-followups-web-slice.md)，两类真实 root 的显式回复、多封记录、独立取消、父级未知原键核对与最小权限 Key 预设。
网页验收以本切片独立新收据为准；后台自动收件、Agent OAuth、真实云端投递和整体生产迁移仍未完成。

最新同线程切片：见 [多消息 follow-up 后端（W11h3a）](cloudflare-agent-followups-slice.md)，两类真实 root、多次显式发送 API、持久队列、安全 MIME 父链、共享额度与事务内回信归属。
该后端阶段的收据不包含网页验收，网页接入由 W11h3b 单独验证；后台自动收件、Agent OAuth、真实云端投递和整体生产迁移仍未完成。

最新纯入站切片：见 [Agent 入站线程（W11h2）](cloudflare-agent-inbound-slice.md)，真实收件账号/种子消息建档、独立消息归属、旧 review writer 兼容、统一 typed-union 线程工作台及完整原键/CAS 操作。
不伪造发送任务、不复制邮件内容、不改变投递事实；同线程 follow-up、自动收件、Agent OAuth 和整体生产迁移仍未完成。本地验收以该切片独立验证收据为准。

最新任务线程切片：见 [人工生命周期（W11h1）](cloudflare-agent-threads-slice.md)，独立列表/详情/筛选、人工完成/归档/恢复、独立权限/CAS/原键回执与 Web/API。
人工状态不改写发送投影，归档不取消派发；纯入站线程、同线程 follow-up、自动收件、Agent OAuth 及整体生产迁移仍未完成。

最新 Agent 人工处理切片：见 [来信人工处理（W11g）](cloudflare-agent-review-slice.md)，待关注队列、忽略/重新关注、人工关联/重新关联已有任务及独立权限/CAS/原键回执；
不覆盖原邮件头证据、不触发发信，不包含新入站线程或完整 follow-up，整体迁移仍未完成。

最新 Agent 默认账号切片：见 [服务默认邮箱（W11f）](cloudflare-agent-senders-slice.md)，同用户默认配置、CAS/原键、网页显式选用及任务来源冻结；
不默认创建或发送任务，后台自动收件、新入站线程/完整线程与 OAuth 仍待迁移，整体目标未完成。

最新 Agent 收件切片：见 [显式收件与头部回信关联（W11e）](cloudflare-agent-inbox-slice.md)，私有 IMAP/R2、原键回执、事务内关联、回收及 Web/API；
关联不是身份认证或投递完成。后台自动收信、新入站线程/完整线程生命周期和 Agent OAuth 仍待迁移；本地验证以独立收据实际状态为准，不代表真实投递或整体迁移完成。

Agent 任务基础：[任务邮件与持久发送（W11d）](cloudflare-agent-tasks-slice.md)。任务提交是持久发送意图，撤销创建 Key 不取消既有任务；unknown 不重发。

Agent SMTP 配置基础：见 [独立 SMTP 配置（W11c）](cloudflare-agent-smtp-slice.md)，配置保存本身不连接或发信。

Agent 账号基础：见 [独立邮箱账号（W11b）](cloudflare-agent-accounts-slice.md)，独立存储/权限、加密配置、只读 IMAP 测试与 Web/API。

Agent 目录切片：见 [远程服务目录（W11a）](cloudflare-agent-services-slice.md)，已接入独立 Web/API、私有目录和事务回执；
不包含 Agent 账号、任务发信或回信关联，整体目标仍未完成，本地验证以本轮独立收据实际状态为准。

最新普通邮箱授权切片：见 [Google OAuth 纵向链路（W10u）](cloudflare-google-oauth-slice.md)。它补齐网页发起/回调、凭据保存与刷新及收发接入；
本地验证以独立收据为准，不代表 Google 真实授权、Google 端权限撤销、生产部署或整体迁移完成。

## 1. 授权与隔离

用户已确认功能范围，并要求在独立分支和目录实际迁移，可用后再合并主干。
本次授权不包括发布到生产、切换域名、停用 NAS、删除旧源码或清理数据。

- 原工作区：`C:\Users\Public\nas_home\AI\GameEditor\EasyEmail`
- 原分支：`main`
- 分支起点：`7779b078101ea2c807d7cf26280d5cedc222f32f`
- 迁移分支：`migration/cloudflare-web`
- 迁移工作区：`C:\Users\Public\nas_home\EasyEmail`
- 实现方式：原仓库的 linked Git worktree，共用 Git 历史，源码目录相互独立。

起点包含原目录当时的 1,291 个已跟踪文件，以及 102 个尚未跟踪的源码或文档。
109 个已跟踪文件的本地改动按原始字节补入，1,393 个文件均核对 SHA-256。
498 个未跟踪的生成文件不复制；忽略的本地密钥配置、依赖和运行数据不复制。

源码哈希和 Git 状态收据位于：
`C:\Users\Public\nas_home\AI\GameEditor\linshi\easyemail-cloudflare-migration-20261028\workspace-baseline.json`。
它是源码起点记录，不是生产数据库备份，也不包含对迁移成果的发布批准。

原有未提交修改在新 worktree 中仍是未提交修改，不会自动变成分支提交。
没有自动 commit、push、merge、stash、reset、clean 或 prune。
将来提交时须区分继承的起点改动与新迁移改动，不能盲目提交整棵工作树。

## 2. 目标与复用边界

```text
用户浏览器 ───────┐
                  ├─ Cloudflare EasyEmail：统一业务、权限、API、Web
程序 API 调用 ────┘                  │
                            ┌────────┼────────┐
                            ▼        ▼        ▼
                     Cloudflare   Temporam   其他供应商
                        Email
```

- 自营邮箱复用 `upstreams/cloudflare_temp_email`。
- 聚合规则、提码、供应商能力和领域模型优先复用 `service/base`，不另造第二套算法。
- Web 优先迁移现有 React 界面、状态及展示组件，替换 Tauri、OS 与本地进程依赖。
- Node HTTP server、文件持久化、子进程、Windows 凭据库、常驻循环不直接搬入 Worker。
- 先分离平台 I/O 与业务规则，再评估是否需要移动目录；不为新目录批量复制业务实现。
- `product-contract.json` 暂保留为旧路径兼容契约；新目标以本计划及功能清单为准。

拟采用 Workers 承载业务/API 与网页资源、持久化存储承载用户数据。
数据库、对象存储及后台调度按实际读写和生命周期选型，不预先引入所有平台组件。
M1 已加入独立 Worker、D1 身份持久化及 React 账号页面；
它是本地迁移基础，不代表完整邮箱聚合应用已实现。

## 3. 读写、所有权与兼容窗口

| 数据/动作 | 权威读写方 | 约束 |
| --- | --- | --- |
| 自营邮箱、原始邮件和附件 | Cloudflare Email | 聚合层保存引用或明确的缓存，不隐式形成第二份可变权威数据 |
| 第三方邮箱和远端状态 | 对应供应商 | 聚合平台操作受上游能力和有效期约束 |
| 用户、会话、API Key、资源归属 | Cloudflare EasyEmail | 所有读写按身份校验；不能把公开地址当作访问凭据 |
| 收藏、标签和平台内整理 | Cloudflare EasyEmail | 平台标记与远端变更分别表达 |
| 供应商凭据与用户邮箱凭据 | 后端受控凭据层 | 不向前端、日志或版本库返回原始密钥；平台与用户凭据隔离 |
| 邮件同步与提码 | 聚合业务核心 | 去重、增量、新鲜度、时间及收件人条件可追踪 |
| 发送队列与结果 | 聚合业务核心及授权渠道 | 持久化状态、幂等、明确的模糊失败处理，不能默认重复发送 |
| 现行 NAS 数据和配置 | 现行 NAS 服务 | 开发阶段不接管写入，不执行新旧双写 |

兼容窗口内，旧服务独立运行，新服务使用隔离的测试资源。
新 Web 不依赖浏览器直连供应商，也不依赖旧 NAS 代理才能成立。
旧 API 的兼容范围在资源模型形成后逐项确定，不能开放一个无权限的旧接口透传。

## 4. 实施阶段与可观察验收

### M0：隔离与核心可移植性

- 建立分支、worktree、源码起点及原目录保留证明。
- 固定功能清单、权威写入方、兼容及回退边界。
- 第一个切片仅消除提码模块对全局 `Buffer` 的依赖。
- 在没有 `Buffer`、`process`、`require` 且禁止运行时导入的隔离环境中验证原模块。
- 验证中英文、quoted-printable、HTML、软换行及失败输入，不复制提码算法。
- 这不是 workerd 验收，也不是完整 Worker、Web 或真实邮件验收。

### M1：身份与持久化基础

- 确定并实现真实登录、会话、API Key、邮箱归属及权限作用域。
- 明确数据库表、唯一约束、索引、存储版本和凭据保管边界。
- 用两个不同用户验证资源隔离、撤销、分页及错误语义。
- 在本地 Workers 运行时验证，不以 Node 沙箱通过代替平台运行证据。

### M2：首条收件与提码纵向链路

- Web 与开放 API 共用业务逻辑。
- 自营供应商、Temporam 接入：创建邮箱、读取邮件、查看详情、查询新验证码。
- 持久化与重启恢复、增量同步、上游失败及过期状态验证。
- 真实邮件验收使用专用标记与测试邮箱，不重放历史一次性发送。
- 后续供应商按同一能力模型逐项接入，不假定现有所有适配器都已兼容。
- 本地实现、配置与未验收边界见 [收件与提取切片](cloudflare-mail-slice.md)；真实供应商和真实投递仍须独立验收。

### M3：第一阶段可用候选

- 完成基础整理、支持渠道的写信/回复、发送状态及必要管理后台。
- 验证用户浏览器与独立程序均可使用，不需要桌面、Userscript 或 NAS。
- 完成原始邮件与附件的安全展示、限流、日志脱敏和数据保留校验。
- 按确认范围列出每项 passed/failed/blocked/unverified，获得用户人工验收。
- M3a 的邮箱整理、跨邮箱缓存收件箱及搜索见 [整理切片](cloudflare-workspace-slice.md)；它不代表基础发信或整个 M3 已完成。
- M3b 的纯文本写信、回复和发送状态见 [发送切片](cloudflare-send-slice.md)；它不代表真实投递或整个 M3 已完成。
- M3c 的安全 HTML 与可核验下载见 [正文与附件切片](cloudflare-content-slice.md)；它不代表自营上游已发布或真实附件验收完成。
- M3d 的平台停用/释放与缓存回收站见 [生命周期切片](cloudflare-lifecycle-slice.md)；不包含远端删除。
- M3e 的供应商管理、凭据及显式探测见 [管理切片](cloudflare-admin-slice.md)；不代表完整用户/配额编辑。
- M3f 的默认关闭平台到期、保留预览与原子批次见 [保留切片](cloudflare-retention-slice.md)；不是远端删除或生产保留策略验收。
- M3g 的显式自动选择、有限预检及分配冷却见 [分配切片](cloudflare-allocation-slice.md)；不包含未知创建恢复工作台或完整后台调度。
- M3h 的创建历史、跨刷新核对及显式风险确认见 [创建历史切片](cloudflare-creation-slice.md)；不代表远端未知资源已被恢复或取消。
- M3i 的有界新验证码/链接等待、共享单次检查及停止语义见 [提取等待切片](cloudflare-extraction-slice.md)；不是持久化后台任务或真实邮件验收。
- M3j 的自营版本条件删除、独立权限、持久化预约及只读核对见 [远端删除切片](cloudflare-remote-delete-slice.md)；不含远端邮箱删除或真实供应商删除验收。
- M3k 已接通自营地址代际条件删除、D1 原子回执、API 代际访问及旧清理 batch 保护，聚合新增独立权限、持久预约、外部操作互斥和 Web 确认/核对；[当前边界](cloudflare-mailbox-delete-slice.md)不包含真实供应商验收或外部 KV/S3 清理。
- M3l 增加[精确自定义前缀](cloudflare-custom-prefix-slice.md)、严格管理员代理合同、能力预检及网页；原随机创建及幂等 hash 不变，不回退旧上游管理员创建，不包含生产升级或真实创建验收。
- M3m 增加[账号管理与账号安全](cloudflare-account-slice.md)、管理员用户搜索/停用/启用/凭据撤销、自行改密码和 Web；原子审计、凭据签发 fence，不包含账号恢复、角色授权或全部在途业务取消。
- M3n 增加[完整自营上游本地集成](cloudflare-upstream-slice.md)：真实 worker.ts 全量构建、原生 email/scheduled 接线、双 Worker MIME/提码/附件/条件删除回归；不是生产发布或公网真实邮件验收。

### 后续模块

W1 已接通[云端草稿](cloudflare-drafts-slice.md)的 API/Web、版本保护、跨设备恢复与发送预留关联。
W2 接入[私有标签与批量整理](cloudflare-labels-slice.md)的 API/Web、标签筛选、原子批次与持久化幂等回执。
W3 接入[自定义文件夹](cloudflare-folders-slice.md)的层级、并发防环、唯一位置、单封/批量移动、归档兼容与安全删除。
W4 接入[私有联系人](cloudflare-contacts-slice.md)的完整基础 CRUD/upsert、搜索分页、版本与持久回执、独立权限和写信单地址选择。
W5 接入[缓存会话浏览](cloudflare-conversations-slice.md)的有限头证据图、主题降级、位置范围、完整计数、分页和 Web 切换；浏览不自动写已读或发送。
W6 接入[缓存订阅邮件](cloudflare-subscriptions-slice.md)的有限头识别、同用户/邮箱分组、完整计数/分页、私有隐藏偏好与显式退订地址；不自动访问或宣称远端已退订。
W7 接入[多收件人/CC/BCC](cloudflare-recipients-slice.md)的 binding 发送、按实际收件人数预约、旧 hash 兼容、草稿与私有历史/清理；不支持的通道明确拒绝，不循环扇出。
W8 接入[私有发送附件](cloudflare-outbox-slice.md)的真实字节上传、R2/D1 生命周期、不可变引用、原上传核对、跨设备草稿及一次 binding 发送；不包含可靠上传/发送队列或公网投递验收。
W9 接入[持久发送队列](cloudflare-queue-slice.md)的不可变意图、定时、预约前取消、有界准备重试、原发送 guard 和 Web/API；不承诺准点或恰好一次送达。
W10a 接入[普通邮箱账号](cloudflare-normal-account-slice.md)的私有配置、加密凭据、原生 TLS/认证/EXAMINE 与 Web/API；收件同步、正文、聚合及 SMTP 仍继续迁移，不以连接成功代替业务验收。
W10b 增加[普通邮箱读取基础](cloudflare-normal-read-slice.md)的 UID epoch/窗口、BODY.PEEK 字节 literal、MIME 正文和附件摘要映射；普通来源持久化、聚合 Web/API 和实际收件验收仍未接通。
W10c 增加[普通邮箱私有收件存储](cloudflare-normal-storage-slice.md)的 D1 身份/回执、私有 R2 原文/内容、来源代际及事务内游标保护；不改旧全局地址约束，没有公开同步路由、聚合阅读或实际收件验收。
W10d 接通[普通邮箱同步与阅读网页](cloudflare-normal-inbox-slice.md)：原键回执核对、受独立来源权限保护的列表/正文/原文/附件、代际与晚到读取保护；统一聚合/整理/发送、长期保留与真实收件仍继续迁移。
W10e 接通[普通来源聚合与提取](cloudflare-normal-unified-slice.md)：显式来源权限、混合时间线/正文搜索、同事务D1投影、有界旧索引补齐和共享缓存提码；普通整理/会话/订阅/授权发送、长期维护和真实平台成本继续推进。
W10f 接通[普通邮件平台状态](cloudflare-normal-organization-slice.md)：已读/星标/归档/可恢复回收站、同账号有限批量、原键回执和Web共同筛选；普通标签/文件夹、混合批量、永久清除、会话/订阅/授权发送与维护仍继续迁移。
W10g 接通[普通邮件分类](cloudflare-normal-taxonomy-slice.md)：复用同用户标签/文件夹，独立普通关联、唯一位置与删除事务、共享组件和筛选；混合批量网页及普通会话/订阅/发送等后续功能仍继续迁移。
W10h 接通[混合批量网页](cloudflare-mixed-organization-slice.md)：来源限定选择、临时/普通多账号分组提交、部分结果、未知原键核对及未执行组显式继续/取消；只复用原API，不新增跨组事务、数据库迁移或远端写入。
W10i 接通[普通邮箱独立页批量](cloudflare-normal-batch-slice.md)：当前账号多选、最近一页替换、50封上限、共享原键恢复及分页读取代次保护；只接通Web，不新增后端接口或数据库迁移。
W10j 接通[普通邮箱缓存会话](cloudflare-normal-conversations-slice.md)：共享图算法、同事务索引、旧行有界补齐、来源/账号/epoch隔离及聚合Web；新增0029派生索引，不重写原文或收件身份，普通订阅/发送、安全清理及真实平台验收继续推进。
W10k 接通[普通邮箱订阅](cloudflare-normal-subscriptions-slice.md)：复用订阅识别/分组/CAS、同事务投影、旧缓存有界补齐、epoch隔离偏好和混合来源Web；新增0030派生表，不自动退订，普通发送、安全清理及真实平台验收继续推进。
W10l 接通[普通邮箱直接 SMTP 发信](cloudflare-normal-send-slice.md)：独立加密配置、465 TLS/AUTH PLAIN、持久发送 guard、共享收件人数配额与原键只读核对；新增0031，不等于真实投递验收，普通草稿/回复/附件/队列仍分阶段迁移。
W10m 接通[普通邮箱云端草稿](cloudflare-normal-drafts-slice.md)：共享CAS/墓碑/分页/Web状态，独立账号来源、版本重关联和与普通发送同事务的消费；新增0032，不扩大旧Key，普通回复/附件/队列、安全清理与真实平台验收继续推进。
W10n 接通[普通邮箱回复](cloudflare-normal-reply-slice.md)：从校验原文提取单一目标与服务器线程头、回复草稿来源及预约SQL fence，四种阅读入口复用唯一普通写信器；新增0033，保护未决发送和未保存配置，普通附件/队列、安全清理与真实平台验收继续推进。
W10o 接通[普通邮箱发送附件](cloudflare-normal-attachments-slice.md)：复用私有上传/不可变引用、普通草稿与SMTP multipart、预约资源fence及清理保护；新增0034扩展列，保持旧无附件hash/MIME，普通队列、安全清理与真实平台验收继续推进。
W10p 接通[普通邮箱排队与定时](cloudflare-normal-queue-slice.md)：独立账号任务表与真实冻结版本、共享状态机/入队用量/全局三候选预算、预约前取消和准备重试、原键GET核对与Web未决导航锁；新增0035，不等于真实投递或生产队列验收，安全清理及统一维护、STARTTLS/OAuth2与其他未迁移能力仍继续推进。
W10q 接通[普通收件缓存保留与对象回收](cloudflare-normal-retention-slice.md)：复用保留策略与管理页、内容 tombstone/generation、回复与同步 pin、持久 R2 删除意图和确认后额度释放、遗留 staged retirement；新增0036，保留原同步回执与 cursor。累计请求/批次元数据上限、真实容量/成本验收及其余协议能力仍未完成，不授权生产清理或直接降级旧 runtime。
W10r 处理[普通收件持续容量与写前准入](cloudflare-normal-capacity-slice.md)：以活跃批次/items/bytes 代替终身请求/批次数门槛，独立用户/平台分钟准入在永久记录写入前执行，旧键及不确定 INSERT 按原 guard 核对；新增0037三个 additive 索引。保留所有历史身份、回执、cursor 与对象 journal，未完成长期物理总容量/成本验收，不授权生产操作。
W10s 接通[普通邮箱强制 STARTTLS](cloudflare-normal-starttls-slice.md)：显式 IMAP143/SMTP587、升级后重新查询能力、单一 deadline/新 socket 清理所有权、累计字节预算、凭据重绑定及 Web/API 模式显示；保持旧993/465 hash 与发送 guard，不新增 schema。仅本地合成传输验收，真实 TLS/服务商认证、OAuth2、远端多文件夹/flags、Agent 与生产迁移仍未完成。
W10t 增加[普通邮箱显式 XOAUTH2 认证基础](cloudflare-normal-sasl-slice.md)：内部 typed authentication、IMAP SASL-IR/非 IR、SMTP 单次初始响应、错误 challenge 只空 ACK 且不降级/重发，以及 pending-read/write 晚到保护；保留旧 PLAIN、配置 hash、密文及发送语义，不新增 schema、公共 OAuth API 或 Web 功能。完整网页登录/code 交换/加密存储/刷新/撤销仍待迁移，不以合成协议通过或手填 token 冒充完成。
这不表示 M3 的真实供应商/公网投递验收已经完成。

联系人/会话/订阅扩展、可靠上传及生产队列验收，
以及普通邮箱和 Agent 邮件各自独立迁移、测试与验收。
不以这一阶段尚未完成为由取消用户已经确认保留的整体目标。

## 5. 数据迁移与回退

1. 开发先使用独立测试数据，不导入生产凭据或复制生产邮件作为普通夹具。
2. 后续需要导入时，先定义源读取方、目标写入方、版本及一致性验证，再申请执行窗口。
3. 使用 expand → migrate → verify → contract，不直接覆盖旧数据或删除源表。
4. 导入有检查点和稳定关联，重复执行不产生重复邮箱、邮件、队列或外部发送。
5. 以记录数、关联、内容哈希及业务抽样核验，不以健康检查代替数据正确性。
6. 在获得新的明确批准前，不做生产导入、双写、切流或旧系统退役。

当前回退方式是继续使用未改动的原目录和原部署，不合并迁移分支即可。
未来测试发布、数据迁移和切流各自需要独立回退点与验收收据。

## 6. 合并门槛

- 第一阶段功能及两种调用入口完成验收，无假成功、假加密或本地预览冒充实现。
- 相关回归与平台运行、构建、安全、数据隔离验证通过。
- 代码行数 checker tests、ratchet、相关测试与 scoped diff 检查通过。
- 报告 strict 结果和剩余债务，不把 ratchet 通过说成全仓 strict-clean。
- 合并前重新核对原工作区、当前主干和继承的未提交改动，审查冲突及兼容范围。
- 用户确认可用并明确同意合并后再执行；合并不自动授权生产发布。

## 7. 当前进展

- worktree 和源码起点已建立，原目录保留证明已生成。
- 第一项跨运行时回归：修改前 22 项中 7 项失败；替换解码 API 后 22 项通过。
- 迁移工作区已按用户要求由 `EasyEmail-Cloudflare` 改名为 `EasyEmail`，
  使用 `git worktree move`；改名时核对 1,399 个文件，历史起点收据不改写。
- M1 已实现独立 Worker、邀请注册、密码登录、持久化 Cookie 会话、只读 API Key、
  用户归属查询、分页、应用限流及过期清理；安全边界见 [身份切片](cloudflare-identity.md)。
- React 网页支持注册、登录、退出、Key 创建/撤销和邮箱元数据列表。
  这不是旧桌面完整功能迁移，也没有伪造创建邮箱、邮件内容或发信能力。
- 运行验收使用本地 workerd/D1、真实 HTTP 与独立 Chrome；
  验证原生 KDF、双用户隔离、撤销/过期、并发 Key 限额和重启持久化。
- 未做生产变更、数据导入、合并、提交或推送。生产 CPU、边缘防滥用及公开注册尚未验收。
- M2 已完成本地自营邮箱、Temporam 纵向链路与故障回归；真实供应商及真实投递仍未验收。
- M3a 已实现名称/备注/收藏、平台同步暂停、已读/星标/归档、跨邮箱查询及 Web 接入；
  `m3-final/verification.json` 是该阶段历史收据，不覆盖后续新源码。
- M3b 增加显式授权发送、独立 messages:send、原子幂等/配额、持久化发送历史及 Web 写信/回复；
  `m3b-final/verification.json` 是该阶段历史收据，不覆盖后续新源码。
- M3c 增加安全 HTML、独立 attachments:read、受限原始 MIME 读取、摘要核验和缓存版本兼容；
  `m3c-final/verification.json` 是历史阶段收据，不覆盖后续源码。
- M3d 增加停用/启用、清除平台凭据、回收站/恢复/缓存清除和独立删除权限，
  `m3d-final/verification.json` 是历史收据，不覆盖后续源码。
- M3e 增加管理员会话隔离、版本化供应商/域名配置、加密只写凭据、显式探测、只读配额及脱敏审计，
  当前阶段验证记录在 `m3e-final/verification.json`，不沿用旧阶段结果。
- M3f 增加新邮箱平台期限、版本化保留策略、影响预览、有限原子批次、幂等调度与管理 Web，
  本轮独立收据使用 `m3f-final/verification.json`，不沿用 M3e 结果。
- M3g 增加自动选择、分配计数与冷却、观测票据 fence 和 Web 接入，
  本轮独立收据使用 `m3g-final/verification.json`，历史收据不覆盖本轮源码。
- M3h 增加创建历史、只读核对、未决上下文恢复及显式风险确认后另起分配，
  本轮独立收据使用 `m3h-final/verification.json`，确认不重放或取消原请求。
- 下一大块仍包括远端生命周期合同、更多供应商与后台调度、完整后台和独立真实环境验收；不自动执行生产发布。
- M3i 增加固定时间/收件地址/条件的单页检查与有界网页等待，不新增 schema，
  本轮收据使用 `m3i-final/verification.json`，不会用历史 M3h 结果覆盖新源码。
- M3j 增加自营源资源代次、条件删除、独立远端 scope、未知结果核对和 Web 风险确认，新增 0011，
  独立收据使用 `m3j-final/verification.json`，旧阶段收据不覆盖本轮源码；没有生产删除、部署或合并。
- M3k 上游安全基础收据为 `m3k-security-verified/verification.json`；聚合切片独立使用 `m3k-aggregate-final/verification.json`，只以实际 passed 收据为验证结论。无条件 remoteMailboxDelete 仍为 false，新增 conditionalRemoteMailboxDelete 并严格预检上游能力；旧收据不覆盖新源码。
- 继续核对生产创建函数，发现原 34 字符随机名称超过上游 30 字符上限；[创建合同修复](cloudflare-creation-compatibility.md)使用保留 128 位随机性的 27 字符名称，旧 guard 原样保留。独立收据为 `creation-compatibility-final/verification.json`，不拿前一源码快照的完整回归冒充本轮重跑。
- M3m 的账号安全历史收据为 `account-management-final-r2/verification.json`；M3n 的完整上游与双 Worker 本地链路独立收据写入 `upstream-final-r2/verification.json`，仅以实际 status 为准，不把前一源码快照的绿灯覆盖到后续修改。
- M3n 额外复现并修复批量清理跨秒扩大选集的问题：四种地址清理在整个原子批次内共用一次 D1 截止时间。没有执行生产清理、数据迁移或切流。
- W1 云端草稿使用新增 0014、独立 drafts scope、CAS 与防复活墓碑；提交与 outgoing 预留原子关联，独立收据写入 `drafts-final/verification.json`，不覆盖历史收据，不进行生产变更。
- W2 使用新增 0015、独立 labels scope、标签 CAS/墓碑和批量事务；不改变旧游标指纹或旧 Key，独立收据写入 `labels-final/verification.json`，仅以实际 status 为准。
- W3 使用新增 0016、独立 folders scope、写入时祖先 fence 和平台唯一位置；旧整理 hash/回执兼容，须先应用迁移并排空旧位置写入方，独立收据写入 `folders-final/verification.json`，仅以实际 status 为准。
- W4 使用新增 0017、用户私有通讯录、独立 contacts scope、CAS/墓碑与事务内幂等回执；同 Key 重放不覆盖后续修改，旧表无用户归属不自动导入。独立收据写入 `contacts-final/verification.json`，仅以实际 status 为准，不沿用 W3 结果。
- W5 使用新增 0018、同用户/邮箱派生索引、晚父/桥接归并、旧缓存有界补齐和位置约束聚合分页。当前独立收据写入 `conversations-final-r2/verification.json`，仅以实际 status 为准；首次全量回归记录保留在 `conversations-final`，旧 W4 收据不覆盖新源码，没有生产切流或数据导入。
- W6 使用新增 0019 订阅侧表、偏好和回执；旧缓存不猜造订阅，元数据不改原 fingerprint，隐藏/恢复以 CAS 和持久幂等完成。独立收据写入 `subscriptions-final-r3/verification.json`，仅以实际 status 为准，W5 历史收据不覆盖新源码。首次全量 `subscriptions-final` 的 295/296 失败记录保留；只读失败数据库证明既有改密码测试跨分钟（2+4 次），测试改为确定性阈值准备，不改变生产限流。`-r2` 的测试产物路径触及 SQLite journal 的 Windows MAX_PATH，独立路径探针确认后缩短验证器子目录，不修改应用运行逻辑；没有执行远端退订或生产变更。
- W7 使用新增 0020，接入 To/CC/BCC、收件人数加权预算、旧 hash 兼容及草稿/私有记录清理。当前收据使用 `recipients-final-r2/verification.json`，仅以实际 status 为准。首次完整回归 `recipients-final` 的后端 308/310 和 Chrome 37/38（1 cancelled）失败现场保留；两份历史迁移测试显式校验新列默认值，并按旧 schema 播种历史发送 guard。旧收信测试隔离计时约 10 秒未复现超时，正式验证改为后端/Chrome 串行，原测试时限不变；不据此声称已确定首轮超时底层根因。完整双 Worker 测试使用合成 binding 捕获器，不是公网投递或收件端隐私验收。
- W8 使用新增 0021 和可选私有 OUTBOX binding，真实二进制及不可变引用不扩大 8 KiB JSON、不进入 D1；先持久终止再清理，发送预约和删除互斥，旧 key/hash 保留。当前独立收据为 `outbox-final/verification.json` 和 `outbox-platform-r2/verification.json`，仅以实际 status 为准。保留 `outbox-red`、`outbox-r1/r2`、`outbox-recovery-red` 和 `outbox-web-red` 失败现场，分别涵盖未实现入口、夹具 Origin、删除响应旧状态、异步下载错误映射及缺失网页入口；不以 W7 结果冒充本轮验证，没有生产资源创建或真实邮件发送。
