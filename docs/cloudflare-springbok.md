# SpringBok 接入进度

## 目标与保留边界

先用 SpringBok 完成一次独立隔离部署和业务验收，确认一键部署可用；之后逐项确认准确资源、
数据影响与保留项，收到用户针对清单的明确“同意”后，清理 SpringBok 测试实例与旧手动实例，
再经 SpringBok 从零部署。不是只将旧实例纳管，也不把笼统方向确认当成任意删除批准。

最终入口仍为 `mail.aiaimimi.com`、`email-api.aiaimimi.com` 和 `xxx@aiaimimi.com`。
共享 Zone、MX、现有凭据及非 EasyEmail 服务不因实例清理被删除。
当前已获准确清单的重建授权；NAS 及未列资源仍不在清理范围。

## 2026-11-07 已发布双 Worker 的 HTML 边缘转换与验真候选（1.0.14）

`8cd1d69` 的完整 CI `42315800143` 首次通过。正常 owner 修复入口单次派发
`dc-c2e01514e3e24214a1b49095688c910c` / run `42316713412`，原 deploy 未重放。
artifact 摘要、请求、固定 SHA 和 executor 已认证，应用仍为 unknown /
`EASYEMAIL_PUBLIC_VERIFICATION_FAILED`；父部分空态、发布设置、管理员登录与自营供应商
认证四项 passed。两 Worker 和 HTTP 域已经发布，catch-all 尚未绑定；不能报收信已恢复。

独立无凭据 HTTP 证明两端 marker 与 JS/CSS 字节正确。首页原始 353 bytes，但公开 HTML
包含 Cloudflare Analytics beacon 和 JavaScript Detections 注入，因此原始哈希不一致。
已联网核对官方 Origin Cache Control、Web Analytics、JavaScript Detections 文档；不通过
关闭检测、修改共享 Zone/WAF 或忽略哈希来修复。请求侧 no-transform 的只读实验也未恢复
原始字节，保留结果，不将实验视为有效修正。该原因只解释此次公开验真失败，不能反推首次
1.0.12 Worker 发布的历史底层错误。

1.0.14 候选增加公开二进制原始首页证据，marker 仅允许根 asset 声明固定同源证据路径。
正常 HTML 与安全头不变，精确 HTML/JS/CSS 哈希、版本与配置摘要仍须匹配，并另核浏览入口。
独立 `complete-fresh-readiness` 认证已发布父双 Worker 可执行字节、原 marker、网络 JS/CSS
和重建封存首页，先持久化加密备份，再发布候选、证明数据未变、验证既有管理员和公开入口，
最后绑定收信。不重放父任务、不 bootstrap、不应用迁移或导入旧数据。候选及测试不等同于
固定提交 CI 或真实云端修复成功，仍须分别验收。
本地完整 Python 254 项、原生双 Worker/D1/R2 与签章/对象控制 15 项、检查器 19 项通过；
ratchet 扫描 2278 文件，三个超限档位均为 0，未运行 strict。首次原生验真夹具未读取新增
证据路径而失败；补上真实路径采集、二进制响应头及与普通首页字节等值断言后，15 项全部
通过，未改产品断言或超时。当前正式网页的既有管理员登录及 Neuro 工作台可真实访问，
但这不代表 catch-all 已绑定、正式应用回执成功或真实邮件已投递。

## 2026-11-07 父版本重建的浅层源码边界（1.0.13 后续候选）

修复候选 `46b321e` 已精确提交推送。核对真实 SpringBok 执行器后确认应用源码由
depth=1 pack 下发；因此不能依赖本地完整历史来取得待认证的 1.0.12 父版本。
仅独立部分发布修复的父版本重建启用固定公开仓库、TLS 校验和精确 SHA 的 depth=1 fetch，
随后仍以 detached checkout 与 HEAD 等值读回认证。当前候选及普通构建不增加 fetch，
父 SHA 缺失或抓取失败不改用分支头、不进入云写入。真实本地浅仓库已复现原失败路径；
完整 Python 243 项（含三项真实浅仓库回归）、检查器 19 项通过；ratchet 扫描 2274
文件，三个超限档位均为 0，未运行 strict。`46b321e` 的完整 CI 首次通过，但本节后续
修改仍须自身固定 SHA 的完整 CI；不代表真实云端 repair 已通过。

## 2026-11-07 正式首次派发与部分发布修复候选（1.0.13）

1.0.12 固定提交 `9b9c6cb` 的完整 CI `42308610594` 首次通过。SpringBok PR #138
正常合并为 `51c0690`，精确 PR/main 七项工作流首次通过后已发布最小控制面；独立下载
字节匹配封存 bundle，旧版本保留，全部 executor pins、绑定、秘密及安全设置保持。
修正仅放行完整 DNS 列表内同 hostname 的 MX/TXT，不删除邮件记录或允许覆盖地址记录。

经正常 owner 表单审阅正式两入口、根收件域、独立秘密和六个新资源后，单次派发
`dc-ef9bab3b48914c5faf1faebce861e206` / run `42311385978`。artifact 摘要、原请求、
固定源码及 executor 已认证；Actions success，但应用回执为 unknown /
`EASYEMAIL_WORKER_DEPLOY_FAILED`，仅新资源和数据库初始化两项检查通过，不称为部署成功。

独立 GET 和原生只读查询证明：email Worker 已上传，platform Worker 不存在；两个域名
均未绑定、catch-all 仍 disabled/drop；双库 schema/59 项迁移、预置行与空业务状态完整，
双桶为空且私有。原提交在短路径重新构建后，云端可执行模块 2722023 bytes 与 Wrangler
dry-run 字节完全相同，SHA256 为 `4cffc431e46b221e98142ae581d4cd2423c1ad90d4995804d01350e57a0f806b`。
源映射 sidecar 不属于该可执行字节证明。首次本地重建遇到 pnpm Windows 长路径错误，
保留失败目录，改用 linshi 下短路径后成功；没有调整云配置或门禁。

原进程丢弃了 CLI 输出，账号审计仅证实上传成功，当前域名 changeset 预览无冲突；未取得
历史底层失败响应，因此不归因为权限、DNS 或瞬时网络。1.0.13 候选新增独立
`complete-fresh-publication`，仅接受 1.0.12 deploy 的准确错误和上述完整部分空态：先重建
并核原 Worker 字节、绑定、空库/桶及未开放入口，再复核资源身份，才发布候选并 bootstrap，
公开验真通过后才绑定收信。不会重放父 deploy、重新初始化 schema、改资源或覆盖业务数据。
CLI 输出仅在受保护目录的临时文件中处理/释放，公开错误最多附唯一数字 Cloudflare code，
不公开原始文本或秘密。当前仍须完整本地验证、精确提交 CI 和真实独立修复验收。

候选完整 Python 240 项通过；写前第二次原模块字节复核补入后，相关修复 4 项再次通过。
实际打包双 Worker/D1/R2 的 bootstrap、公开字节、MIME、私有对象控制和保数据升级 5 项通过；
这五项不含新 partial-publication 云编排的真实云发布证明。检查器 19 项、ratchet 扫描
2273 文件且三个超限档位均为 0，未运行 strict。目标云部分空态的独立读取检查已通过，
不等同于新的 repair 已执行或正式网页/收信已经恢复。

## 2026-11-07 24 项清理独立核验与邮件 DNS 共存（1.0.12，历史）

1.0.11 固定提交 `a110881` 的完整 CI `42306602543` 首次通过，正常 SpringBok 表单已
显示可编辑的收件后缀，并填入正式两入口、`aiaimimi.com` 和独立秘密；尚未提交部署。
最后的旧正式组仅执行一次清理，原 journal 记录停用 catch-all、解除两旧域绑定及删除
两 Worker、两 D1、两 R2。脚本在末尾要求 DNS 完全为空的断言停止，未重放任何删除。

独立 GET-only 核验确认批准的四组 24 项资源全部不存在，旧两绑定均不存在、catch-all
处于 disabled/drop。`mail.aiaimimi.com` 的 3 条旧 MX 和 SPF TXT 与备份完整值一致，
原 Worker 管理的 AAAA 已移除；`email-api.aiaimimi.com` 没有 DNS 记录。全部 MX 保持。
只读结果另存 `email49-cleanup-preflight.json`，不把原失败脚本回执改写为成功。

该现场暴露应用前置检查把所有 DNS 非空都当作 HTTP 冲突。1.0.12 仅允许同一精确主机名
的 MX/TXT 与新 Worker Custom Domain 共存；A/AAAA/CNAME、其他类型、外部主机名、
不完整列表或已有 Worker 域绑定仍阻断。该检查只读，不移除邮件 DNS、不启用覆盖已有
地址记录；原 Zone 身份与收信路由 neutral-rule 检查保持。已联网核对 Cloudflare 官方
Custom Domains 文档，并用修正后的实际 `free_domains` / `prepare_routing` 对正式目标
做只读验真，通过后仍等待固定提交的完整 CI，才创建新正式实例。
新增共存回归先在旧实现失败，修正后完整 Python 228 项、检查器 19 项通过，无失败或
跳过；ratchet 扫描 2267 文件，三个超限档位均为 0，未运行 strict。

## 2026-11-07 正式重建前置与可编辑收件后缀（1.0.11，历史）

用户随后明确批准 `email38-next-cleanup-proposal.json` 的 24 项资源清单清理和从零部署。
原提案及其历史未批准状态保留，不回写历史。8 Worker、8 D1、8 R2 的备份已完成，108
文件的大小和哈希独立读回，8 份 D1 导出经 SQLite integrity/witness 核验；R2 共 4 对象、
267107 bytes。备份不等于导出 secret values、DO 数据或全局原子快照。

两组 SpringBok 管理实例和手动 `easyemail-migration` 已清理，共 18/24 资源。
SpringBok PR #137 合并为 `96465d1`，精确 PR/main 七项 CI 首次通过后仅发布控制面。
普通删除的 D1 验真改为原 UUID，新增 owner/Access/CSRF 保护的只读“核对删除结果”；
仅全部原资源不存在才由原 operation/digest 正常收尾，不重发 DELETE、不清锁或抹掉失败。
Windows executor 仍固定 `60c264d`，Linux/历史 pin 不变。
旧正式组 6 项及两入口、catch-all 尚未停用，MX 保持；正式重建和真实邮件验收尚未完成。

准备普通部署表单时确认 `mailDomain` 的非空模板隐藏了“收件后缀”，无法填写真实域。
1.0.11 只把该字段改为必填可编辑文本，默认 `example.test` 保持隔离语义；正式部署显式
填写 `aiaimimi.com`。原路由域必须精确匹配收件后缀、隔离环境禁真实路由/供应商的校验
不变，不硬编码正式收件域，不通过隐藏 API 绕过页面。秘密复用已准备的私有输入，不重置。
此声明修正待固定提交的完整 CI 和正常表单验收通过后，才停旧正式服务并从零部署。

本地先红后绿的 3 项回归覆盖字段可编辑、隔离默认与正式配置提交；完整 Python 225 项、
检查器 19 项通过，无失败或跳过。ratchet 扫描 2267 文件，三个超限档位均为 0，未运行
strict。验证和部署证据继续分别记录，不以本地配置解析或 CI 成功代替真实正式部署。

## 2026-11-07 已批准测试副本清理闭环（1.0.10，历史授权边界）

1.0.10 固定提交 `ae9dac2bfddf5e7c4ed7661aedf8af39c042d734` 的完整 CI
`42295802853` 首次通过后，经正常 owner UI 单次提交原副本的独立 cleanup repair，任务
`dc-8544d9157eae49c28f018985a9f4529a` / run `42297287931`。仍使用已发布的
`60c264d` Windows executor，不再更新平台或 pin。认证 artifact 的摘要、任务、请求摘要、
固定源码和 executor 匹配；应用结果为 succeeded，`cleanup-resume-claim-persisted`、
`preview-resources-removed`、`repair-completed` 三项检查全部通过。

SpringBok 正常服务页已显示原实例 `dc-06706d283af546a7b2cadd556e76e1cb` 为“已删除”，
删除按钮禁用，历史八次执行记录保留。没有再次派发删除、重放父任务或改写旧失败回执。
随后独立 GET-only 核验确认 `test-0c1ab5a774e8` 的 email/platform Worker、两个原 UUID
D1、inbox/outbox R2 均不存在；两个 Worker 的 subdomain 查询均为 HTTP 404，两个 D1
另由精确 UUID 的 404/7404 合同确认不存在。原副本的数据已随对应存储删除。

账号其他 Worker/D1/R2 身份、自定义域绑定、51 个 Zone 的 Worker routes/MX 与删除前
清单一致；原隔离源的原会话仍能读取同一草稿。该对照不等于对其他服务全部业务数据或
所有运行设置做完整快照验真，源鉴权 GET 也可能增加应用限流计数。

证据在私有调查目录的 `email38-run-42297287931.json`、
`email38-cleanup-independent-readback.json`、`email39-exact-absence-readback.json` 和
`email38-cleanup-deleted.png`。后两次独立验真没有显式远程写入，也没有重发删除。
本轮仅补记录和只读验真，没有变更运行源码或重新执行已通过的本地套件；前轮 Python
222 项、打包原生 31 项、检查器 19 项与 ratchet 结果仍对应上述固定提交。

本次授权只覆盖该测试副本。其他隔离实例、旧正式实例、正式域名/收信路由和本地备份均
保留；其余实例清理、SpringBok 正式从零部署及真实邮件收发验收尚未完成，不能由本次
cleanup repair 成功推定。`email38-next-cleanup-proposal.json` 仍是未获删除授权的提案。

## 2026-11-07 部分清理首次恢复现场与 D1 UUID 验真（1.0.10，历史候选记录）

SpringBok PR #136 的精确 head 与合并后 `60c264d` 七项 CI 均首次通过。兼容控制面和
同 SHA 的受保护固定 Windows executor 已发布；下载 Worker 字节匹配封存 bundle，旧
版本保留，Linux/历史 pins、绑定、秘密名称、DO namespace、域名和计划均保持。配置/脚本
备份不是 DO 数据导出，也未独立下载全部远程静态资产字节。

正常 owner UI 单次提交 1.0.9 / `f4ae608` 的独立 repair，任务
`dc-7eba57c83f9042009ded100ecadeae50` / run `42291336979`。认证 artifact 确认签名
claim 已持久化、email Worker 已删除；应用返回 unknown /
`EASYEMAIL_PREVIEW_CLEANUP_SHARED_OR_UNVERIFIED`，不冒充成功。随后只读确认两个 Worker
及对应入口均不存在，email D1 也不存在，platform D1 和两个 R2 仍在；其他资源身份、
域名、Zone routes/MX 保持。旧失败历史不重放、不清锁。

状态和执行路径将停止点定位到 email D1 DELETE 后的账号列表验真：该列表复用的严格
分页/计数校验会返回上述通用错误。未保留当次原始响应，不能断言具体是哪个元数据字段。
当前独立 UUID GET 实测为 HTTP 404、success=false、result=null、唯一错误 7404；当前
完整共享核验也通过。1.0.10 仅将 D1 不存在证明改为精确 UUID 读取，不依赖账号列表的
分页或聚合计数；只有完整匹配的 404/7404 认定不存在。合法 200 仍在时复用 0/1/2/4/8 秒
只读观察，DELETE 始终一次；权限、传输、畸形响应和其他 404 立即停止，不放宽共享检查。
后继必须认证原签名 journal，只处理剩余原身份，不重新创建 authority 或重删不存在项。
本地回归先在旧源码复现同一列表错误；修正后完整 Python 222 项、打包原生套件 31 项、
检查器 19 项通过，无失败或跳过，ratchet 扫描 2266 文件，三个超限档位全 0，未跑 strict。
首次全量因请求夹具版本未同步而失败，保留日志，更新夹具后完整重验通过，没有改生产
请求校验。真实 GET-only 也确认原 claim 签名、父请求摘要与剩余身份/引用，未写新 claim。
当前该修正尚待精确提交/CI/真实执行；其他实例清理和正式从零部署仍待准确清单批准。

## 2026-11-07 部分清理独立恢复实现（1.0.9，历史）

1.0.9 显式声明 `resumeCleanup: true`，只为已批准副本的已消费 authority 提供新独立
repair，不重放旧 destroy-preview。平台从完成且认证的父 run 派生原消费 task/permitAt、
原 baseline 和完整父结果；计划、原账号 lane 再核，不接受客户端替换。旧模板仍拒绝部分清理。

应用经 R2 管理 GET 读取原签名 provenance/消费记录，不重新打开 Worker。初次 anchor
依靠原受信执行在消费前通过的整体 state 校验，并要求现存 Worker 创建时间不晚于原
permitAt、精确 DB/R2 绑定、关闭入口、无 cron 或外部引用；两 D1/两 R2 创建身份须仍与
签名 proof 完全匹配。不声称在 platform Worker 已删除后还能重算原整体 settings digest。
后继固定同一 Worker 创建身份及 settings/schedules 摘要，桶对象仅接受原 metadata 清单子集。

签名 witness 和唯一 task/parent claim 写入待删 platform D1，独立读回后才删除剩余目标；
platform D1 最后删除。INSERT 响应丢失可从精确父行恢复，缺少 passed check 不代表没写入。
若只提交 CREATE 而无签名行，或 journal 丢失/损坏，明确停止，不自动重建日志或采样新
authority。最后 D1 回执丢失只在认证父其他七项均完成、八项全部独立不存在时只读收尾。

Cloudflare 名称型 DELETE 没有本实现可用的原子身份条件，仍依赖清理期间无人并发重建
这些已批准对象；跨系统时间也不构成绝对的密码学身份保证。不会把这些限制写成已消除。
当前仍是候选实现/本地验收，未发布控制面、executor 或执行新的云清理；其他实例、
正式域名/MX、原隔离源及备份保留。

## 2026-11-07 最新清理现场：独立恢复已执行，部分删除仍待完成

EasyEmail `1.0.7 / bf427b2` 精确 CI 通过；SpringBok PR #134 的精确 head 和合并后
`974d9ae` 七项 CI 均通过。已发布兼容控制面及同 SHA 的受保护固定 Windows executor，
独立下载 Worker 字节与封存 bundle 一致；旧版本保留，Linux/历史任务 pin、绑定、域名、
秘密名称、DO namespace 和计划保持。平台配置/脚本有备份，但不是 DO 数据导出或全部
远端静态资源字节备份。

仅对用户已批准的同一测试副本，从正常 owner UI 审阅原八项清单并单次提交新 repair
`dc-8870b316617b4e6eb3c03e47e50354a7` / run `42278766039`。artifact 的摘要、run、
executor 和 request 绑定均独立认证；工作流 success，但应用结果是 unknown /
`EASYEMAIL_PREVIEW_RESOURCE_CLEANUP_UNCONFIRMED`，不是清理成功。checks 仅有
`preview-authority-verified` 和 `preview-ingress-stopped`。

随后真实 GET-only reconciliation 确认：两 workers.dev/preview 入口均关闭，platform
Worker 已不存在；email Worker、原 UUID 的两 D1、两 R2 仍在，OUTBOX 有三个对象，
持久 cleanup authority 已消费。其他账号资源身份、custom domains、Zone routes、MX
与前置清单一致；原隔离源会话及原草稿仍可读取。没有重放任务、清锁、重新打开入口或
手工删除剩余资源。旧失败和新 unknown 回执全部保留。

代码阻碍是删除 Worker 后只做一次即时列表观察；真实 Worker 随后已经不存在。1.0.8
候选为该读回增加最多五次合法 GET、15 秒总等待的有界观察，DELETE 仍严格一次；失败、
权限错误或畸形/不完整列表不重试，也不会被当成不存在。该候选尚未部署，不支持绕过
已消费 authority。剩余清理需要独立的、可认证已消费授权及逐项部分状态的恢复合同；
当前只支持写前失败的 repair 必须继续拒绝它，不能直接重复调用 destroy-preview。

该读回回归先在旧源码准确复现同一错误，修复后完整 Python 211 项、检查器 19 项通过；
ratchet 扫描 2258 文件，三个超限档位均为零，未运行 strict。回归覆盖短暂陈旧列表只发
一次 DELETE、观察预算耗尽仍拒绝、权限/网络失败及畸形列表不重试。没有为该修复再次
执行云清理；不能把本地通过写成旧 unknown 已恢复。

证据为私有调查目录中的 `email34-run-42278766039.json`、
`email34-cleanup-live-status.json`、`email34-cleanup-partial-reconciliation.json`。
这轮仍未完成全量测试副本删除、其他实例清理、从零正式部署或真实邮件收发。

## 2026-11-07 源升级/verify 成功，首次清理写前失败及独立恢复实现

有数据隔离源的 update `dc-f6caa11c795b4e8caa0660bb31833eea` / run `42271067370`
已取得摘要认证的 succeeded，11 项检查全通过；独立 HTTP 11 项检查证实原会话、草稿、
附件原生身份/内容、邮箱凭据及密码保持，self-provider/关闭发信保持。随后 verify
`dc-bc2248b3890440db9146bd08dca02fc6` / run `42271749730` 另行 succeeded，5 项
检查通过。原资源复用、版本为 1.0.6；这不是从零重建正式服务。

用户仅明确批准删除 `test-0c1ab5a774e8`。经正常审阅单次提交 destroy-preview
`dc-d51c4bfe7dcf49238b0b46dbfc213079` / run `42272280483`，工作流 success，但独立
认证应用结果 failed / `EASYEMAIL_PREVIEW_CLEANUP_SHARED_OR_UNVERIFIED`，checks 为空。
只读追踪定位到 Pages 历史 Functions 部署缺少未设置的 r2_buckets 字段；列表和独立详情
均明确 uses_functions=true，只有另一独立 D1 绑定。不是发现真实共享，也不是分页遗漏。
两 Worker/入口、两 D1、两 R2 均保留，持久 cleanup authority 未消费。失败回执不重放。

1.0.7 候选按 Pages API 的可选映射语义处理省略字段，仍拒绝未知 Functions 标记、畸形
映射、不完整列表和真实共享；同步核验 Pages service/DO 对目标 Worker 的引用，不能仅
核存储。完整账号级共享检查已在真实 Cloudflare GET-only 通过。平台现有 failed-cleanup
没有合法继续入口，因此新增独立 cleanup repair 合同与受控 lane 接管；不清锁、不改旧
回执、不换资源、不发布业务 Worker。应用仍需以原版本/provenance、当前完整目标和未
消费 authority 重验，才进入原精确清理路径；unknown/部分删除仍禁止恢复。

当前为本地验证阶段，真实恢复尚未提交、清理尚未成功。候选必须精确提交/完整 CI、兼容
控制面和新固定 Windows executor 发布后，才可由正常 UI 审阅已批准的原八项清单并执行。
不扩大到其他实例、正式域名/MX、共享路由、凭据或本地备份。证据为 email33-*、email34-*。

候选完整 Python 208 项通过，随后新增 Pages service/DO 引用回归及受影响清理 20 项通过；
三个原生 D1/R2 生命周期通过，普通 preview 分支实际覆盖写前清理拒绝→新独立清理 repair，
原对象条件消费/有界删除、源库和对象不变。cloud metadata/资源 DELETE 为显式替身，
不是云删除成功证明。检查器 19 项、ratchet 扫描 2258 文件三个超限档位全 0，未跑 strict。
SpringBok 合同/workerd/共享文档 43 项、真实 Chrome/workerd 修复与删除语义及四页
Neuro 五宽度通过；正常固定 SHA CI/发布及真实清理仍待完成。

## 2026-11-07 原副本修复与真实业务验收通过

1.0.6 固定提交 `587b28c` 的完整 CI `42260874160` 通过后，经正常 owner UI 单次
发起独立 repair `dc-37e17e5a0da248219b7d8f07dd32c1da`，仍针对原副本
`test-0c1ab5a774e8`，不创建替代环境或重放任何 UNKNOWN 父任务。run `42265364514`
的 artifact 摘要、任务、固定源码和 executor 身份已独立认证，应用结果为 succeeded，
14 项检查全部通过：认证快照恢复、迁移、源完整当前状态未变、副作用隔离、保数据、
管理员和服务就绪等均取得云回执。页面已显示该原副本部署成功，父失败链仍保留。

随后真实 HTTP 的 13 项业务检查通过：两个固定发布/网页资产/健康/匿名拒绝；原密码
登录副本；原草稿及附件引用完整；恢复到 R2 后重绑原生版本的 60 字节附件可读且摘要
匹配；重签后的原邮箱凭据能在副本完成同步；self-provider 仅指向副本且发信关闭；
源会话在副本被拒绝，原实例仍可用原会话读取原草稿。原只读 API key 此时已到期，
没有将它的 401 冒充撤销证明；另由两库独立查询确认 key 行仅在副本有 revoked_at。
验收期间源鉴权 GET 可增加持久限流计数，发生在适配器 source-unchanged 证明结束后。

这证明原部分副本经独立 repair 后的完整恢复与业务路径，不宣称修正后从零开始的普通
preview 一次成功、真实 destroy-preview 或同实例 update 已完成。无真实发信、外部
供应商或正式域名/MX/routing 变更。证据为 `email31-run-42265364514.json`、
`email31-preview-business-receipt.json`，秘密、原生 SQL 和完整回执保存在私有目录。

继续通过 SpringBok 审阅隔离源的 1.0.0→1.0.6 update 时，平台把锁定原配置的
`routing: null` 渲染/提交成 `{}`，被后台正确拒绝；两次计划均未提交部署任务。
SpringBok 的一行 JSON 初值修正及真实浏览器 null/undefined 保真回归已通过本地检查，
PR #133 正常合并为 `4188b42`。完整精确 main 门禁、控制面发布和实际云升级须分别
记录，不能把浏览器合成 update 当成真实云成功；全部 executor pins 保持。

精确 PR 七工作流均首次通过；main 的六个源码/安全/浏览器工作流首次通过，文档 build
首次通过而 Pages publish 在 `deployment_queued` 后失败。保留原日志后仅重试失败 publish
一次并成功；另核 GitHub 为复用 build 复制的第二次元数据与原开始/完成时间、steps 完全
相同，没有把它误算为又跑了一次构建。main 七门禁最终均成功，未延长或修改任何门禁。
随后已备份配置/旧版本并发布最小控制面 `6bc0420f-12ad-4d11-857a-09d2204047f9`；
独立下载字节匹配封存 bundle，所有 pins/绑定/域名/安全设置保持。备份不包含 DO 数据
导出，且没有独立读回全部远程 asset 字节；不能称为完整平台数据备份。

线上正常 UI 已独立显示/提交 `routing: null` 并通过同实例计划校验，原资源与原秘密
复用。单次 update `dc-f6caa11c795b4e8caa0660bb31833eea` 已被受理，run `42271067370`
使用原 Windows executor `1cd69e5`。当前仅记录任务受理，不预报应用升级或业务验收成功。

## 2026-11-07 平台发布、真实导入停点与 1.0.6 候选（历史）

SpringBok PR #132 合并为 `1cd69e5`，准确 PR/main 七工作流均 success/attempt=1。
Windows 合成执行测试的阶段证据定位到 hosted 首次全局 cmdlet 自动发现/加载路径延迟；
仅在测试脚本从 `$PSHOME` 显式导入内置 Utility/Management 后，43 passed/1 skipped，
未更改产品执行器、断言或超时。精确 executor tag 已建立无绕过 update/delete 保护。
控制面已发布为 `4cfa43f2-1842-4e00-a561-b64db3bf8a17`，下载字节摘要匹配封存候选；
仅未来 Windows pin 改为 `1cd69e5`，Linux/历史任务 pins、域名、绑定及安全设置保持，旧版本保留。
配置备份不是 DO 数据导出，也不宣称独立读回所有远程 asset 字节。

EasyEmail 1.0.5 固定提交 `43f4cb3` 的完整 CI `42247551339` 通过后，经正常 owner UI
单次发起原副本的独立 repair `dc-8187a9eef3f1498aa0bd2b24de8f5485`。
run `42254255428` 的 workflow success，但经 artifact 摘要独立认证的应用结果为
`unknown / EASYEMAIL_SNAPSHOT_IMPORT_FAILED`，仅 `partial-preview-state-verified` 通过。
原失败和所有父 UNKNOWN 保留，没有重放、清锁、创建新环境或篡改成功回执。

只读原生 export 证明：目标 email 的全部 schema/typed rows/分配器精确等于认证备份，
platform 仍无业务 schema；两个公开发布标记均为 1.0.5/`43f4cb3`。源双库精确等于
上次当前源诊断，未读取源鉴权业务 API；这不补写失败任务缺失的 sourcefinal 成功检查。
原生 import poll 只返回 `Not currently importing anything.`，未取得云端历史原始错误。

已联网核对 D1 官方外键文档及 workers-sdk #5438 维护者说明：remote `--file` 使用
非单事务 `/import`，不能沿用 `/query` 或 batch 的跨语句 deferral 假设。
真实认证 platform SQL 在单事务成功，开启 FK 的逐条 autocommit 在第 228 条
`INSERT admin_audit` 报 `SQLITE_CONSTRAINT_FOREIGNKEY`，email 两种模式都成功。
因此已确认恢复器的可复现顺序缺陷，与目标部分状态吻合；不冒充取得了本次云原始错误。

1.0.6 在离线准备阶段按实际行依赖输出可逐条提交的 SQL，外键始终开启；循环依赖明确拒绝，
不关闭校验或覆盖数据。真实双库准备 SQL 经新 emitter 输出后，37/353 条独立提交均成功，
完整 typed witness 与认证输入相同。原生生命周期替身不再把导入包为一个 batch。
新 repair 仅支持准确 1.0.5 导入错误和上述部分状态，先独立 export 验证已完成 email、
核 platform 空态及父发布版本，写前复核后仅导入 platform；原副本 baseline 和对象不变。
本候选的完整本地验证、精确提交 CI 与真实 SpringBok 后续修复仍须分别记录，不能称为云验成功。
证据为 `linshi/easyemail-springbok-20261106/email29-*` 至 `email31-*`，SQL/会话只在私有目录。

本地最终完整 Python 203 项、相邻打包运行 27 项、三个 preview/凭据失败后修复/部分导入后
修复生命周期及检查器 19 项均通过，无失败或跳过。新流程保留失败父链、实际恢复后的 email、
原会话撤销、重签邮箱同步、附件读取、认证 provenance 与源双库不变；仅 platform 再导入。
首次新增流程暴露测试驱动的文本读入把 schema CRLF 改成 LF，导致精确 schema witness 拒绝；
已按真实 CLI 改为保留原始 UTF-8 字节，未放宽 witness。目标两次 export 另用 repaircheck/
repairready 的独立一次性 journal 阶段，不与源 sourcecheck/sourcefinal 冲突，回归保留重复拒绝。
ratchet 扫描 2256 文件，三个超限档位均 0；未运行 strict。上述仍是本地原生业务数据演练，
cloud metadata/export/publish/资源删除仍为显式替身，不是 Cloudflare 真实导入/删除成功证明。

## 2026-11-06 真实部署、独立验真及业务验收

候选 `0d75771` 的 CI `42220468467` 通过，SpringBok PR #130 正常合并为 `d396528`，
精确 PR/main 的七工作流均通过后已发布最小生命周期固定 SHA 入口。Windows executor
仍为 `0750b9f`，Linux pin、现有实例、全部绑定与安全配置保持。随后正常 owner UI 单次
派发独立 repair `dc-805b623cbbe64beb8076b811cbcf6c1d`，run `42222614873` 成功，
13 项真实回执检查均通过；原实例现在为 1.0.1，原父 UNKNOWN 历史未改写或重放。
独立 verify run `42224017835` 的五项检查通过。两个回执的 artifact 摘要、任务、固定源码和
executor 均已独立核对。云端自营版本为 v0.0.9，管理员与自营认证已建立，59 项迁移保留。

账号 lane 正常释放后，经正常 UI 继续原第二任务 `dc-36f4d06288bd43c4a1dc810f6c98d583`，
没有清锁、重复初始提交或新建第三套环境。run `42224714673` 在原固定 `072bb38` / 1.0.0
成功，11 项部署检查均通过；独立 verify `42226132821` 另行通过。上述任务的完整回执和
artifact 摘要已独立核对，不能只用 GitHub job success 代替应用成功。

第二实例的真实 HTTP 业务验收通过：管理员会话、只有自营测试域且关闭发信、跨 Worker
分配与同请求键幂等、既有加密凭据解密后的空邮箱同步、60 字节真实 R2 附件上传下载摘要、
带附件草稿和修订冲突、API key 读权限/写拒绝、Origin CSRF 拒绝，以及第二用户无法读取
第一用户的邮箱/草稿/附件。网页正常登录并读取同一份已存草稿和附件。验收数据保留用于
后续保数据生命周期；没有真实邮件、外部供应商或正式域名/MX/routing 变更。

本地公开验真前置曾两次遇到有界读取失败，发生于业务写前；保留失败证据。后续单次直接
HTTP 诊断及完整业务验收通过，未确认这两次瞬时读取的底层原因，不据此增加重试或修改
生产超时。证据为 `linshi/easyemail-springbok-20261106/email23-*`；秘密与会话仅在私有目录。

预升级提交前的只读 A/B 复现另一个确定遗漏：ObjectStore 的二进制 GET/PUT 未显式标识
部署客户端，同一真实附件默认身份 403 / Error 1010，已有 `EasyEmail-SBA/1.0` 身份 200，
摘要匹配。1.0.2 窄修仅使该对象传输沿用已有身份，保持鉴权、元数据/字节校验、条件创建、
写前记录和不重试；先补回归，旧源码准确两项失败。未提交的预升级弹窗已关闭，无副本创建。
修复后完整 Python 177 项、对象备份/恢复与完整 preview→cleanup 原生运行 6 项、检查器
19 项通过，0 failed/skip；ratchet 扫描 2250 文件，三个超限档位均 0，未运行 strict。
当前源码 ObjectStore 对真实 60 字节附件的只读下载/摘要核对也通过，无业务写入。该候选
仍须固定提交 CI 和真实预升级验收，不能写成云备份/升级已完成。

## 2026-11-06 首次有数据预升级与构建检出修正

1.0.2 固定提交 `fc42b58` 的精确 CI `42228149702` 成功后，通过正常 owner UI 单次
发起预升级 `dc-06706d283af546a7b2cadd556e76e1cb`，目标为 `test-0c1ab5a774e8`。
run `42228880662` 的 workflow 成功，但经 artifact 摘要独立核对的应用回执为
`unknown / EASYEMAIL_PREVIEW_CREDENTIAL_FAILED`，不能把 GitHub success 称为预升级成功。
平台显示结果未确认，删除测试环境不可用；原任务未重放、未清锁，也未新建替代环境。

只读核对证实原实例仍可用原会话读取原草稿；私有 OUTBOX 的 133292 字节持久加密归档
已独立下载、核 SHA256、认证解密，重建并验证原生 D1 SQL/schema/typed rows 及业务对象
引用。两份 SQL 分别为 5024 和 97516 字节，归档含一个 60 字节真实附件。失败目标的
两个 D1 尚无业务 schema，OUTBOX 已有恢复的同摘要附件，尚无成功 provenance；不能
据此声称目标数据库恢复、源最终精确比对或副本业务验收已通过。该次核对无远程写入。

根因在干净源码检出中复现：执行器原始检出没有 npm 依赖，而 `prepare_release` 将依赖
安装在独立固定源码构建检出；旧重签入口从前者启动，导入 `esbuild` 即失败。1.0.3 窄修
只把应用 crypto 入口传到已构建检出，仍使用真实 vault/Hono JWT/配置解析器，stdin
私有传递秘密、环境白名单及失败后不重放不变。新增干净检出回归在旧源码准确两项错误；
修正后完整 Python 179 项、实际打包双 Worker 的凭据/副本/preview→cleanup 原生回归
5 项、有效行检查器 19 项通过，0 failed/skip。ratchet 扫描 2251 文件，三个超限档位
均 0，未运行 strict。固定提交 CI 和真实修复/生命周期重验仍待完成。

当前不支持对这个未完成 preview 直接执行成功副本的 destroy-preview；缺少的来源证明
不能伪造。后续须走独立、保留父 UNKNOWN 历史的受控恢复/清理路径；任何永久删除仍须
明确清单批准，不能放宽空目标、条件创建、来源认证或一次性执行检查来跳过失败。
证据为 `linshi/easyemail-springbok-20261106/email24-*`，归档与恢复 SQL 仅保存在私有目录。

## 2026-11-06 原失败副本的独立修复候选

1.0.3 固定提交 `6a7a581` 的完整 CI `42233377228` 已通过；未重放原 preview。
本轮 1.0.4 增加窄范围 `complete-preview-credentials`，不创建或删除资源、不重新恢复
对象，也不清锁。SpringBok 显式 `fromActions:["preview"]` 合同从认证父证据继承原副本
上下文；新独立 repair 沿用原 instance，原 UNKNOWN 保留，不能由客户端更换来源或目标。

应用只接受原 1.0.2 凭据错误、1.0.0 隔离来源和 routing=null；唯一匹配的持久认证归档、
目标原版本/绑定、双库无业务 schema、双桶与归档完全相符均须通过。已有对象只读校验
并重绑实际版本，SQL/凭据离线准备完成且源精确未变才发布隔离候选、导入空库和迁移。
完成后再核源精确未变、目标保数据及管理员/self-provider，认证 provenance 绑定原副本
instanceId 与新 repair task/resultDigest；后续清理仍需明确批准，不用成功回执伪造删除授权。

本地完整 Python 193 项通过；实际打包双 Worker/D1/R2 的普通 preview→cleanup 与
凭据失败部分副本→独立 repair→cleanup 两个流程通过，额外十项凭据/副本/网络原生回归
通过。新流程实际验证旧公开版本、完整加密归档重新认证、空库原生导入、保留附件且不
重写业务对象、原会话撤销、新管理员登录与旧邮箱凭据继续同步，源双库/桶保持不变。
Cloudflare 元数据/export/发布/删除仍是明确本地替身，不冒充真实云修复或跨提交迁移。
检查器 19 项通过；ratchet 扫描 2256 文件，三个超限档位均 0，未运行 strict。

SpringBok 合同/workerd/共享文档与安全检查 57 项、新 repair 及相邻真实浏览器回归通过，
共享 AI/Pages 参考和 CI 执行清单已同步。该新字段需要发布兼容控制面及新的固定 Windows
executor；Linux pin 与旧任务 pins 不变。两仓库仍待本轮精确提交 CI、平台发布和对原失败
target 的真实独立修复，不以本地检查代替上述门禁。证据在 `email25-*`，不包含公开凭据。

## 2026-11-06 真实独立修复的源时间点诊断与 1.0.5 候选

1.0.4 固定提交 `8dec025` CI `42239985123` 通过；SpringBok PR #131 正常合并为
`acd8e53`，精确 PR/main 七工作流通过后已发布兼容控制面和新固定 Windows executor，
Linux 及历史任务 pins 保持。正常 owner UI 单次发起 repair `dc-7799f4ea94f941b095f240a0be1c61d7`，
run `42242103950` 的 workflow 成功，但独立核对 artifact 摘要的应用回执准确为
`unknown / EASYEMAIL_SOURCE_DATABASE_CHANGED`，checks 为空，不记作修复成功。

随后原生 D1 export 与原认证归档逐表/schema/typed-row/分配器核对：自营库完全相同；
聚合库仅 auth_rate_limits 新增一行，其余全部相同。新增桶的 SHA256 与原用户在
2026-11-06 22:13:09 的 api-user 分钟桶一致，attempts=1，吻合此前读取原草稿的核对时间。
该带会话 GET 在 worker.ts 的统一限流层产生持久计数，所以此前报告的“无远程写入”
仅就未主动调用业务写方法而言，不是数据库零变化证明。本次诊断不再读取源鉴权业务 API。
源业务对象原生元数据与字节保持；目标两个 D1 仍无业务 schema，两个公开发布标记均为
原 1.0.2/fc42b58，部署记录早于本次 repair；目标仍只有原 60 字节附件且无 provenance。
诊断没有修改业务数据，native export 是独立只读导出请求；不是重放失败任务。

1.0.5 将“恢复时间点”与“操作源保护”分开：目标只用原持久认证备份，不新取快照冒充；
本次 target 写前保存当前源完整双库与对象 witness，完成后原样 exact 比对，不排除任何表。
只新增对原 1.0.4 准确错误的独立后续修复，要求兼容 SpringBok 从认证父请求继承原
preview、原候选版本与 instanceId 的 previewBaseline；目标仍须原 1.0.2/双空业务库/原
对象完整匹配。成功 provenance 保持原副本实例，父链各 UNKNOWN 和不重放语义保留。
当前源码候选的本地验证、精确 CI、平台兼容发布和真正云恢复仍须分别完成；永久清理及
正式域名/MX 不在此次修复动作内。证据为 `linshi/easyemail-springbok-20261106/email26-*`。

本地最终完整 Python 197 项通过；普通 preview→认证清理和“部分副本/备份后真实鉴权
GET 改变限流→独立后续 repair→认证清理”两个原生双 Worker/D1/R2 流程通过，覆盖新
候选发布、旧快照恢复、源当前完整状态保持、原会话撤销、附件读取和原邮箱凭据同步。
云元数据/export/发布/删除仍是明确测试替身，不是云恢复成功。有效行检查器 19 项通过，
ratchet 扫描 2256 文件，三个超限档位均 0；未运行 strict。对应平台 36 项合同/workerd/
共享文档检查及真实浏览器连续两次失败、显式双动作允许、单次派发、原实例清理审阅通过；
示例（含 EasyEmail）与十页文档构建通过。精确提交 CI、兼容平台发布及云恢复尚未完成。

## 2026-11-06 独立修复准备与账号执行 lane（历史停点）

显式部署客户端修复已提交为 `072bb38` 并推送迁移分支，精确 CI run `42201795310`
全部通过。随后经正常 owner UI 单次提交第二个隔离任务
`dc-36f4d06288bd43c4a1dc810f6c98d583`，环境 `easyemail-migration-sb-3a8e7e8e-r2`。
该任务停在 preparation-unconfirmed，尚无 GitHub run，真实只读核对六个新资源均不存在。
平台按 Cloudflare 账号持有唯一 deployment lane，原 UNKNOWN 未完成，独立环境也不能绕过；
没有清锁、重复初始提交或创建第三套环境，也没有把无资源创建误报为成功部署。

当前候选升级适配器为 1.0.1，提供独立 `complete-empty-bootstrap` repair。只接受旧
1.0.0 隔离实例的准确错误，复用原资源与原密钥；原版本/配置、schema/59 项迁移、
业务表空态、四张迁移预置表逐字段初值、无业务自增高水位和两个 R2 全空都须通过。
先保留只读证明，再发布双 Worker，重新核空态后走原生 bootstrap；不重做 schema/
迁移、不重放父部署、不重注册已有用户。成功才返回 repair-completed、data-preserved、
unchanged-resources-verified 和 service-ready；这里的数据保全范围是空业务实例的 schema/
迁移/预置行，不是有数据实例的通用恢复，也不是跨库/桶原子快照。

新门禁对原云实例的只读实测通过：43/429 个 schema 对象、原发布的五项公开证据及
资源身份前后不变，无业务写入。D1 原生运行暴露并定位内部 `_cf_METADATA` 访问限制、
复合 SELECT 项数与结果列数限制；只排除两个准确 D1 内部表，采用每批最多 32 列的
独立计数，并补受限 SQLite 回归，不泛化忽略 `_cf_*` 或跳过业务表。
本地完整 Python 176 项、SBA JavaScript 28 项（含真实打包双 Worker 的五项）和检查器
19 项全部通过，无失败或跳过；包括 bootstrap 前后空态门禁、原生注册/登录/self-provider、
MIME 聚合与后续保数据升级。ratchet 扫描 2250 文件，三个超限档位均 0，未运行 strict。
固定提交 CI、SpringBok 生命周期固定 SHA 入口发布和真正云 repair 仍须依次完成，
尚未宣称云修复成功。
证据在 `linshi/easyemail-springbok-20261106/email20-*` 至 `email22-*`。

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
的五文件修复随后已提交推送并通过 CI（见上节）；原云实例尚未发布该修复。
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

## 生命周期余项，不能称为正式一键部署全部可用

数据生命周期底座已补齐到本地可运行的加密备份与恢复准备闭环：双 D1 SQL、双 R2 业务字节/原生元数据、来源清单和内容证明进入同一认证加密归档，持久写入已有私有 OUTBOX，再独立下载解密核验；恢复到空对象目标，修正附件 version/etag，并核其他数据未变。普通/Agent 收件对象与发件附件均有跨库/桶引用检查。密钥从现有实例 master 按独立用途派生，不部署给 Worker，也不进入参数或公开 CI artifact。

update 已接入原版本/资源/HTTP与邮件目标归属、持久备份、原生迁移/双 Worker 发布、数据保全及既有管理员/self-provider 验收。数据保全仅排除已独立验真的自营 db_version 元数据行，其他业务设置、密码、邮箱和邮件必须保留；实时 AUTOINCREMENT 分配器须完整导出且升级后不倒退。写后不确定为 unknown，不自动重放或恢复覆盖新数据。原生本地双 Worker/D1/R2 演练覆盖同 schema 迁移/重启、密码与原邮件保留、既有会话附件下载和旧邮箱凭据解密后继续同步；其云端导出 API 和发布 CLI 使用明确的本地替身，不冒充云端跨版本升级。

2026-11-06 的 update 本地验收为 105 项 Python、17 项 SBA JavaScript 和 19 项有效行检查器测试通过，均无失败或跳过。ratchet 扫描 2211 文件，三个超限档位均为 0；未运行 strict。actionlint、UTF-8 无 BOM、scoped Gitleaks 和已跟踪/新增文件空白检查通过。原生运行回归使用实际打包 Worker、本地 D1/R2 及真实密码验证/邮箱凭据解密路径；不是 SpringBok 云任务、原生云 export 或跨版本云发布的成功证明。

preview 和 destroy-preview 均已接线，仍待真实 SpringBok 云生命周期验收。前后导出/清单比对只拒绝观察到的漂移，没有业务写冻结或跨资源原子快照；完整归档有容量上限，详见 SBA 说明。

预升级准备底座已增加产物级网络隔离及 SQL/凭据准备：聚合副本仅能请求指定测试自营副本，自营副本无 HTTP 出网；拒绝重定向、原始 socket/WebSocket，构建时拒绝 Node 原生网络模块，副本不处理原生收信或 scheduled 事件。旧 vault 读密钥作为副本私有秘密保留以支持旧密文和幂等摘要，新写使用独立 key；自营邮箱 JWT 在离线准备时重新签署，不部署源 JWT/site/admin 密钥。副本撤销源 session/API key、改接自营测试端点，禁用外部供应商并清除存储的供应商级秘密；不是脱敏副本，也不是执行恶意代码的安全沙箱。

本地实际打包源/目标双 Worker 与空目标 D1 演练已验证：原密码和邮件可读、旧会话和源邮箱 JWT 被拒、重新签署的旧邮箱凭据可在副本继续同步、源双库 SQL 前后不变。演练发现并修正恢复 SQL 的建表/约束索引顺序，且以完整 typed witness 验证 NUL/Unicode、BLOB、精确 REAL、自增高水位不变。

preview 应用编排现已串通源版本/绑定核验、空目标复核、持久加密备份、隔离发布、两库两桶恢复、候选迁移、业务保全、源最终精确比对及私有来源记录。新增整链本地原生演练验证有内容的双桶恢复、附件实际读取、自营同步和来源记录绑定完整 SpringBok 结果摘要；使用明确的本地 SQL export、云 metadata/CLI 替身和同源码同 schema 迁移，不宣称已做不同 SHA 的真实 Cloudflare 预升级。SpringBok 继承的公开供应商/发信配置只在副本运行配置中清空，源与平台请求不改；源 SQL/业务字节未变检查不包含适配器主动新增的私有备份对象。

该阶段本地完整回归为 123 项 Python、28 项 SBA JavaScript 和 19 项检查器测试通过，0 failed/skip；ratchet 扫描 2233 文件，三个超限档位均 0，未运行 strict。另已用当前 SpringBok 的真实结果校验器与摘要实现核对副本回执和私有来源记录；这是本地输出合同验证，不是云任务成功证明。

1. 隔离 deploy 与基础业务已通过真实 SpringBok 云验收；正式 custom-domain/邮件路由仍待云验。
2. update 的真实 SpringBok 云升级验收；preview 的源快照、两库两桶副本、副作用隔离及源未变化核对。
3. destroy-preview 的真实云来源/资源核对、先停入口再清数据、逐项不存在读回及不重放验收。
4. 核对 SpringBok 保存连接使用的 token 与已验证凭据一致；账号级邮件列表权限的实测结果见下文。
5. 平台更新与第一次真实隔离部署已完成；仍待生命周期验收、明确清单删除批准及从零正式部署。

应用动作均已实现源码入口及本地回归；隔离 deploy/verify/repair 已云验，其他生命周期仍待云验。
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
