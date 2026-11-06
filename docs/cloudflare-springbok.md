# SpringBok 接入进度

## 目标与保留边界

先用 SpringBok 完成一次独立隔离部署和业务验收，确认一键部署可用；之后逐项确认准确资源、
数据影响与保留项，收到用户针对清单的明确“同意”后，清理 SpringBok 测试实例与旧手动实例，
再经 SpringBok 从零部署。不是只将旧实例纳管，也不把笼统方向确认当成任意删除批准。

最终入口仍为 `mail.aiaimimi.com`、`email-api.aiaimimi.com` 和 `xxx@aiaimimi.com`。
共享 Zone、MX、现有凭据及非 EasyEmail 服务不因实例清理被删除。
本阶段不修改现有正式服务、收信路由或 NAS，也不发真实邮件。

## 2026-11-06 首次 SpringBok 云部署与边缘拒绝

EasyEmail 固定提交 `ceb43ef` 的完整 CI 已通过。SpringBok PR #128 增加正常弹窗的
指定仓库/固定 SHA 入口；PR #129 只修复浏览器测试自有预连接的关服方式。精确 PR 和
合并 main `c393cfe` 的七工作流均通过后，控制面已发布并独立匹配下载的 Worker 字节，
全部绑定、现有实例、域名、cron 和两个 executor pins 保持；Windows pin 仍为 `0750b9f`。
旧控制面版本保留。配置备份不是 Durable Object 数据导出，也未逐字节回读全部线上资产。

通过正常 owner UI 单次提交 `easyemail-migration-sb-3a8e7e8e`，任务
`dc-7d2283274fc045bcabda310ea0bdd550`、GitHub run `42199525031`。流水线成功结束，
但应用回执为 `unknown / EASYEMAIL_CLOUD_REQUEST_FAILED`，不能称为一键部署成功。
资源空态、双库初始化和实际发布配置读回已通过；没有管理员或自营认证成功回执。
只读核对聚合库已有 59 项迁移、用户和管理员均为 0，自营版本记录尚未初始化。

真实 HTTP 原因已定位：Python 默认身份的健康请求被 Cloudflare 边缘以 HTTP403、
Error 1010、`browser_signature_banned` 拒绝。相同入口使用如实标识的
`User-Agent: EasyEmail-SBA/1.0` 返回 200；A/B 再核仍为默认身份 403、显式机器身份成功。
本地窄修仅给 JsonTransport 和 ReleaseReader 设置部署客户端身份，不伪装浏览器，
不更改云安全规则、TLS、鉴权、重定向、写前记录或不重试语义。新增身份回归旧源码准确
2 failed；修复后完整 Python 160 项和检查器 19 项通过，ratchet 扫描 2246 文件，三个
超限档位均 0，未运行 strict。现有云产物的两版本/配置摘要、Web 资源字节、健康与匿名
拒绝五项公开验真，以及带原凭据的自营版本 GET 均通过；这些是只读核对，不是补做初始化。

当前 unknown 任务不重放、不清锁、不手工续做 bootstrap。上述两客户端、两回归和本页
的五文件修复尚未提交推送，也未部署；新的固定 SHA 和隔离试验仍需批准并通过 CI。
现有测试资源与正式服务全部保留，未开始清理、域名/MX 切换或真实邮件验收。
证据在 `linshi/easyemail-springbok-20261106/email17-*` 与 `email18-*`。

## 已完成的应用基础

`.sba/` 使用 manifest v3、deployment v2，声明两 Worker、两 D1、两 R2、两个 HTTP origin，
以及可空且明确关联自营 Worker 的邮件路由目标。资源清单 key 与平台 target 顺序精确对应；
preview 源清单可包含只读邮件身份，但目标和 destroy-preview 清单不能包含邮件写身份。

构建固定 NeuroDesign 的公开提交，在独立兄弟目录构建标准 `@neuro/ui`，不复制设计源码，
不改写锁文件或 file 依赖路径。Git/npm/pnpm/Node 子进程不继承业务秘密；构建不调用部署。
新的发布入口保留原 Worker 的 fetch/email/scheduled 处理器，同时提供无秘密的固定版本声明。
基础发布候选原样保留，新发布文件清单具有单独摘要，不把其准备状态改写成已部署。

独立 verify 不需要任何部署秘密：检查两个固定版本、配置摘要、真实 Web 资源大小/摘要、
两个健康入口和匿名 API 拒绝。它不宣称远程测量了自营 Worker 的全部代码或私有数据库，
更不代替用户登录、权限、收信、同步与授权发信验收。

本地新增合同/入口/环境隔离回归，以及真实完整 Worker 打包运行测试；后者使用本地 D1/R2、
59 项迁移、合成 MIME 和阻断外网的转发夹具，不发送真实邮件。详细可复现命令和动作状态见
[SBA 入口说明](../.sba/README.md)。CI 只运行本地检查，正式 SpringBok 部署单独验收。

## 隔离首次部署路径

已接通隔离首次 deploy 的应用编排：远端资源身份/空态核对、
原生 Wrangler schema 与 59 项迁移、精确迁移清单/外键/quick_check、角色级秘密发布及实际
bindings/vars/禁用 cron/preview/custom-domain 状态读回、
自营版本初始化，以及复用实际注册、scrypt、管理员登录、授权接口和 self-provider probe。
不修改正式域名/MX/收信路由，不接入外部供应商或发送真实邮件。写前记录每步，写后失败为
unknown；完整初始化后公开验真失败为 deployed-unverified，不自动重复部署。

这些调用已用真实打包双 Worker 和本地 D1/R2 串通，其中 Python 使用测试专有 loopback
传输，真实 HTTPS URL、处理器、密钥格式和鉴权语义不变；这不是 Cloudflare 发布或 SpringBok
任务回执。新 CI 和平台控制面/执行器的最新发布进度见文末，不能以本地验收替代。

## 正式首次部署源码路径

已接入明确的 custom-domain 配置：完整读取所属账号 active Zones，以最长后缀选择真实 Zone，
核精确 HTTP hostname 的 DNS 和 Worker domain 均为空；每个 Worker 发布前再次复查。拒绝将
现有正式域名直接接管为新实例。发布后读回精确域名、cron、发信接收者白名单及禁用的
workers.dev/preview；域名列表必须由响应的计数证明完整，不能只相信第一页结果。

邮件目标仍显式可空。非空目标要求根收信域已启用且 ready、catch-all 为 API 管理的
disabled/drop 中性规则。管理员初始化和公开验真通过后，复查快照，再单次绑定自营 Worker，
核写响应与独立 GET；不修改共享 MX/DNS，不收养已存在的 own/foreign 路由。
公开验真失败而声明路由仍未绑定时返回 unknown，不称为完整部署的 deployed-unverified。

以上是源码和本地回归范围，不是正式云部署回执；当前 `mail.aiaimimi.com` 及既有收信路由未变。

## 尚未完成，不能称为一键部署可用

数据生命周期底座已补齐到本地可运行的加密备份与恢复准备闭环：双 D1 SQL、双 R2 业务字节/原生元数据、来源清单和内容证明进入同一认证加密归档，持久写入已有私有 OUTBOX，再独立下载解密核验；恢复到空对象目标，修正附件 version/etag，并核其他数据未变。普通/Agent 收件对象与发件附件均有跨库/桶引用检查。密钥从现有实例 master 按独立用途派生，不部署给 Worker，也不进入参数或公开 CI artifact。

update 已接入原版本/资源/HTTP与邮件目标归属、持久备份、原生迁移/双 Worker 发布、数据保全及既有管理员/self-provider 验收。数据保全仅排除已独立验真的自营 db_version 元数据行，其他业务设置、密码、邮箱和邮件必须保留；实时 AUTOINCREMENT 分配器须完整导出且升级后不倒退。写后不确定为 unknown，不自动重放或恢复覆盖新数据。原生本地双 Worker/D1/R2 演练覆盖同 schema 迁移/重启、密码与原邮件保留、既有会话附件下载和旧邮箱凭据解密后继续同步；其云端导出 API 和发布 CLI 使用明确的本地替身，不冒充云端跨版本升级。

2026-11-06 的 update 本地验收为 105 项 Python、17 项 SBA JavaScript 和 19 项有效行检查器测试通过，均无失败或跳过。ratchet 扫描 2211 文件，三个超限档位均为 0；未运行 strict。actionlint、UTF-8 无 BOM、scoped Gitleaks 和已跟踪/新增文件空白检查通过。原生运行回归使用实际打包 Worker、本地 D1/R2 及真实密码验证/邮箱凭据解密路径；不是 SpringBok 云任务、原生云 export 或跨版本云发布的成功证明。

preview 和 destroy-preview 均已接线，仍待真实 SpringBok 云生命周期验收。前后导出/清单比对只拒绝观察到的漂移，没有业务写冻结或跨资源原子快照；完整归档有容量上限，详见 SBA 说明。

预升级准备底座已增加产物级网络隔离及 SQL/凭据准备：聚合副本仅能请求指定测试自营副本，自营副本无 HTTP 出网；拒绝重定向、原始 socket/WebSocket，构建时拒绝 Node 原生网络模块，副本不处理原生收信或 scheduled 事件。旧 vault 读密钥作为副本私有秘密保留以支持旧密文和幂等摘要，新写使用独立 key；自营邮箱 JWT 在离线准备时重新签署，不部署源 JWT/site/admin 密钥。副本撤销源 session/API key、改接自营测试端点，禁用外部供应商并清除存储的供应商级秘密；不是脱敏副本，也不是执行恶意代码的安全沙箱。

本地实际打包源/目标双 Worker 与空目标 D1 演练已验证：原密码和邮件可读、旧会话和源邮箱 JWT 被拒、重新签署的旧邮箱凭据可在副本继续同步、源双库 SQL 前后不变。演练发现并修正恢复 SQL 的建表/约束索引顺序，且以完整 typed witness 验证 NUL/Unicode、BLOB、精确 REAL、自增高水位不变。

preview 应用编排现已串通源版本/绑定核验、空目标复核、持久加密备份、隔离发布、两库两桶恢复、候选迁移、业务保全、源最终精确比对及私有来源记录。新增整链本地原生演练验证有内容的双桶恢复、附件实际读取、自营同步和来源记录绑定完整 SpringBok 结果摘要；使用明确的本地 SQL export、云 metadata/CLI 替身和同源码同 schema 迁移，不宣称已做不同 SHA 的真实 Cloudflare 预升级。SpringBok 继承的公开供应商/发信配置只在副本运行配置中清空，源与平台请求不改；源 SQL/业务字节未变检查不包含适配器主动新增的私有备份对象。

该阶段本地完整回归为 123 项 Python、28 项 SBA JavaScript 和 19 项检查器测试通过，0 failed/skip；ratchet 扫描 2233 文件，三个超限档位均 0，未运行 strict。另已用当前 SpringBok 的真实结果校验器与摘要实现核对副本回执和私有来源记录；这是本地输出合同验证，不是云任务成功证明。

1. 隔离 deploy 的真实 SpringBok 云验收，以及正式 deploy 的真实 custom-domain/邮件路由云验收。
2. update 的真实 SpringBok 云升级验收；preview 的源快照、两库两桶副本、副作用隔离及源未变化核对。
3. destroy-preview 的真实云来源/资源核对、先停入口再清数据、逐项不存在读回及不重放验收。
4. 核对 SpringBok 保存连接使用的 token 与已验证凭据一致；账号级邮件列表权限的实测结果见下文。
5. 必要的平台控制面/执行器发布、第一次真实隔离部署、明确清单删除批准及从零正式部署。

五个应用动作均已实现源码入口及本地回归，但尚未通过真实 SpringBok 云生命周期验收。
preview、destroy-preview、update、隔离与正式 deploy 均具备真实云写能力，不应误作只读试跑；
本地构建及运行成功，不等于已通过 SpringBok 完成云部署。

## destroy-preview 本地清理闭环

清理严格绑定目标私有 OUTBOX 的认证 provenance、平台批准的完整结果摘要及八项资源清单。
先核目标真实状态、外部 Worker/Pages/账号邮件规则/HTTP 域名与 Zone route 引用、D1/R2 创建身份，
再条件写入持久一次性消费记录；之后停两个 workers.dev/preview 入口、删两个 Worker、复查共享引用，
最后删除两库及两桶。每项删除独立确认不存在；单桶对象只允许一批最多 1000 项，晚到对象、
部分删除、丢响应或读回不确定即停止并返回 unknown，不自动重放、追加清空或恢复入口。
新任务/新 runner 也不能绕过持久消费记录。普通正式实例不走这个入口。

原生本地演练接上完整 preview→cleanup：真实打包副本的 R2 控制入口认证/条件创建消费记录，
经原生 R2 删除目标双桶对象，独立确认空桶；源双库 SQL 和源桶对象身份未变。
云 metadata 与 Worker/D1/R2 资源 DELETE 为明确替身，不称为真实云删除已验。
独立 S3/DNS/路由写入者仍须事先停止，跨请求核对不是云原子事务。

本阶段完整 Python 回归 156 项、SBA JavaScript 28 项、相关 Cloudflare/Temporam/附件回归
25 项、有效行检查器 19 项通过，无失败或跳过；前后端 typecheck 通过。最终原生清理回执还
通过当前 SpringBok 的真实请求/结果校验器与摘要实现核对；其中候选版本号为明确的本地夹具投影，
不是云任务或跨 SHA 发布证据。源码冻结/静态检查和真实部署状态仍须分别核对。

## 账号级邮件列表权限已实测定位

Cloudflare 将 `Email Routing Account Rules Read` 作为独立账号级权限，不能由 Zone 级
`Email Routing Rules Read/Write` 替代。2026-11-06 在明确批准后，仅给既有 token 增加该只读权限，
不创建/轮换 token，也不改变其他策略；独立读回确认 token 身份、active 状态及其他权限语义未变。
同一 token 的账号规则列表由 HTTP403/code10000 变为 HTTP200，完整读取 47 项、无重复 ID。
这确认了此前 403 的缺权原因，不再将其归为未知 account-owned token 兼容性问题。
首次更新响应不确定后仅做只读核对，未重发写入。没有 Worker、邮件路由、MX 或业务数据写入；
这项凭据库验证仍不冒充 SpringBok 已保存连接的实际任务验收。

## 发布前只读核对

当前 SpringBok 远程 main 与本地源码同为 `0750b9f`，重新读取其精确 head 的七个工作流，
均为 completed/success。在线控制面仍是旧版本；已保存活动部署/版本、settings、域名、
subdomain、schedules 和可下载代码，并核备份前后活动部署与配置未漂移。备份不含秘密值，
也不是 Durable Object 业务数据导出，不能据此宣称完成了完整平台数据备份。

按已备份的真实变量、域名和既有 DO class 绑定准备 `0750b9f` 控制面本地 dry-run，通过原生
Wrangler 构建；候选仅改变 Windows executor pin，保留 Linux pin 与现有其他变量，不读取秘密值。
用户已批准候选发布，但仍须等待 EasyEmail 精确提交的 CI 通过；不是已上线回执。
新固定 executor tag 的最新保护状态见下文，不能用旧 tag 冒充新代码。

实查发现 Worker 自定义域名列表成功响应为 `errors:null`；适配器原先严格要求空数组，会阻断
真实域名检查。已补先失败后通过的回归，只兼容该 GET 端点的显式 null，不接受缺字段或真实错误，
不放宽其他端点和写请求。直接运行当前 CloudApi/listed_domains 对两个正式 HTTP 域名以及空列表
的只读核对通过，总数/当前页完整性仍检查。完整 Python 回归已更新至 156 项，未为该问题更改业务或 Worker 代码。

## 首次 CI 的 Windows ACL 阻塞与窄修

124 文件迁移成果已提交推送到 `migration/cloudflare-web`，提交为 `44d315d`，未合并旧 main。
其首个 Cloudflare SBA Local Contract 运行 `42135530875` 在 20 分钟上限被取消；日志还记录
一次私有目录 PowerShell 调用超过 30 秒，不能视作 CI 通过。相同 Python 套件在本机不到一分钟，
而 hosted Windows 多次 ACL 调用耗时约 24 秒。取消时仍在 Python 测试，未到打包运行门禁。

修复仅针对私有目录的 Windows ACL 适配层：使用 .NET 构造、设置和独立读回权限，关闭该
短脚本的模块自动加载，不再发现或加载 shell ACL cmdlet。仍只允许当前用户 SID 与 SYSTEM、
禁止继承，保留设置后规则读回、30 秒有界等待和失败关闭；没有增加业务权限或延长 CI 超时。
新增回归在旧实现准确失败，原生目录与秘密文件权限用例在新实现通过；完整 Python 157 项
本地通过。新的精确提交 CI 和真实 SpringBok 隔离部署仍须分别验收，不用本机通过替代它们。

SpringBok 固定 Windows executor `0750b9f` 的准确 tag 已建立更新/删除保护且无绕过者，
既有 14 条规则未改。控制面已重新备份并核活动版本/配置稳定，尚未实际发布；Linux pin 保持。
正常 owner 浏览器会话和已有 Cloudflare 连接已确认有效，未扩大或续期过期机器委托。
