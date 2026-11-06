# EasyEmail SBA 适配器

本目录属于 `migration/cloudflare-web` 的新产品，不属于旧 NAS/桌面项目。
当前是应用接入的实现中间态，**不能发布为已完成的一键部署版本**。
平台合同通过、产物能运行和 SpringBok 真实部署成功是三个独立结论。

## 当前入口与边界

- `springbok.ps1` → `application.py`：先严格核请求、源码 SHA、origin 与干净工作树，再分流动作，原子写安全回执。
- `configuration.py`：公开配置、精确资源清单及既有发布描述；`routing=null` 不占用邮件身份。
- `build_environment.py`：本地 Git 校验和所有构建子进程均不继承业务秘密；隔离 HOME、缓存和配置。它不是恶意依赖的执行沙箱。
- `release.py`：在源码树外创建兄弟 `EasyEmail`/`NeuroDesign`，固定设计库提交、npm/pnpm 版本和冻结安装，然后复用现有双 Worker 发布准备链及 dry-run。它没有发布或资源创建模式。
- `prepare.mjs`/`release-stamp.mjs`：用真实运行时解析器核供应商配置，保留封存基础候选，生成自包含 Worker 入口、公开版本证明和带外摘要校验的发布文件清单。
- `public_verify.py`：不读取凭据，仅 GET 两个版本证明、两个健康入口、匿名 API 和 Web 资源；核 SHA/version/配置摘要及资源字节。不能替代私有数据、管理员或真实收发信验收。
- `initial_deploy.py`：首次部署编排；隔离模式复核同账号 workers.dev，正式模式先核声明的空闲 HTTP 域名和可选的中性收信路由。两模式均核两 D1 的真实 ID/空态和两 R2 的私有空态；原生 Wrangler 应用自营 schema 和 59 项迁移，再核完整迁移名与数据库完整性。
- `production_domains.py`：完整读取所属账号的 active Zones，以最长域名后缀选择真实 Zone，并在每个 Worker 发布前复查精确 hostname 的 DNS/custom-domain 空态。拒绝接管现有域名；custom-domain 列表必须以总数证明完整。
- `email_routing.py`：仅接受已启用且 ready 的根收信域；声明的 catch-all 必须是 API 管理、disabled/drop 的中性规则。公开验真通过后才复查快照并单次绑定到自营 Worker，核写响应和独立 GET。不启用 Email Routing、不改共享 MX/DNS；`routing=null` 严格不写邮件路由。
- `deployment_secrets.py`/`deployment_process.py`：稳定实例密钥派生、角色级秘密映射和发布前封存复核；构建不取部署秘密，只有发布命令取得 Cloudflare token 与当前 Worker 的临时 JSON 秘密文件，不把业务秘密放进命令参数。
- `private_files.py`：临时秘密目录先限制并读回权限；Windows 只允许当前用户 SID 与 SYSTEM，POSIX 目录 0700 / 文件 0600。`published_settings.py` 独立读回实际 bindings、vars、cron、workers.dev/preview 和 custom-domain 状态，不只信任 CLI 退出码。
- `initial_bootstrap.py`：复用真实自营初始化及平台注册/登录处理器，授予管理员、核自营供应商认证并注销验收会话；没有另写密码散列算法。
- `bootstrap_repair.py` / `bootstrap_pristine.py`：1.0.1 的可选独立 repair 仅处理 1.0.0 隔离实例的 `EASYEMAIL_CLOUD_REQUEST_FAILED`。先核原公开版本、原资源/秘密、schema/59 迁移、无历史自增业务使用、全部业务表空态和两个 R2 全空；四张迁移预置状态表必须逐字段保持源码初值，不能只比较行数。保留 schema/迁移及预置行证明后，仅发布新 Worker 并执行原生 bootstrap，不重建资源、不重新应用 schema、不重放父 deploy。发布后再次复核空态；任何写后不确定均为 unknown，无自动重试。跨请求核对不是全局原子快照，独立外部写入者仍需停止。
- `cloud_transport.py`：有界 HTTPS、禁止重定向与继承代理、写前私有记录；应用不重放已尝试的写步骤。写后失败或不确定结果为 `unknown`，不能笼统报 `failed`。JSON、公开验真及 ObjectStore 二进制 GET/PUT 均显式标识 `EasyEmail-SBA/1.0`，不伪装浏览器或修改边缘安全策略。
  实查 Worker 自定义域名列表 GET 的成功响应允许显式 `errors:null`；仅这个准确读取端点接受该形式，不接受缺失字段，不放宽其他接口或写请求，也不跳过域名清单完整性检查。
- `object-control.mjs`：仅封存后的聚合 Worker 提供独立秘密认证的 R2 控制入口；匿名或错误密钥为 opaque 404。允许有界列表、读取和带 SHA-256 的条件创建，不提供删除或覆盖。
- `snapshot_lifecycle.py` / `snapshot_bundle.py` / `archive-crypto.mjs`：两 D1 导出、两业务桶字节与原生元数据进入同一 AES-256-GCM 归档；以独立用途的派生密钥和快照 ID 认证。归档写入私有 OUTBOX 的 `_easyemail-sba/backups/`，独立下载、解密、重建 SQLite 并验证后才返回备份成功；不上传明文 SQL、邮件对象、密钥或私有回执为 CI artifact。
- `snapshot_links.py`：核对 ready 发件附件、未清除的普通/Agent 收件对象的大小与哈希；恢复到空目标后只改附件的 R2 version/etag，核其他单元格与 schema 未变。该恢复准备路径不会覆盖既有云数据库。
- `update_deploy.py`：核原版本、实际资源/HTTP 域名/邮件目标归属和秘密认证；持久备份完成后才应用平台迁移、发布自营 Worker、调用原生邮件迁移并发布聚合 Worker。再核实际 settings、迁移/完整性、旧业务行和分配器不倒退、业务对象身份/字节，最后使用既有管理员登录与 self-provider 探测。不会重注册、重置密码、重新授予管理员或修改既有邮件路由。
- `preview-release.mjs` / `preview-network.mjs`：仅预升级编译产物使用出网限制；聚合层只允许 HTTPS 访问指定测试自营 Worker，自营副本不允许 HTTP 出网，重定向不跟随，原始 socket/WebSocket 被阻断，Node 原生网络模块导入在构建时拒绝。预升级入口拒收原生 email 事件、不执行 scheduled。普通 deploy/update 的处理器保持原语义。它约束当前受信源码中的网络调用，不是运行任意恶意源码的安全沙箱。
- `preview_credentials.py` / `preview-vault.mjs` / `preview_data.py`：预升级 SQL 准备使用原程序的 vault、Hono JWT 和供应商配置解析器；重新签署自营邮箱 token，保留地址/代际/过期时间但不把源 JWT/site/admin 密钥部署给副本。旧 vault 读密钥为保留既有凭据和幂等摘要可读性而保留在副本私有 keyring，新写使用独立 active key；这不是脱敏副本。副本撤销源 session/API key、改接自营副本、禁用外部供应商并清除其存储的供应商级秘密；其他密码、邮件和业务行不变。
- `d1_restore.py`：双库恢复 SQL 先创建全部业务表及外键所需的约束索引，再导入数据/分配器，最后创建视图与触发器。保留 NUL/Unicode 文本、BLOB、精确 REAL 和自增高水位，避免 Python iterdump 的建表顺序及 NUL 截断问题；生成后以完整 typed witness 重新核验。没有创建或覆盖真实云数据库。
- `preview_deploy.py` / `preview_copy.py`：预升级动作先核源版本/真实绑定和空目标，创建可独立恢复的持久备份，再发布封存的隔离副本、恢复两库两桶、重绑附件身份并重签自营凭据，最后执行候选迁移、保数据和既有管理员验收。SpringBok 继承的源公开配置仍进入配置摘要，但外部供应商、发信、IMAP/SMTP 只在副本运行配置中清空，不篡改平台请求或源配置。
  1.0.3 将凭据重签的 Node 入口明确绑定到 `prepare_release` 已固定源码并安装依赖的构建检出，不依赖执行器原始检出的 `node_modules`。秘密仍只走私有 stdin，子进程不继承业务环境或 `NODE_OPTIONS`。回归同时覆盖无依赖的干净执行器检出和构建入口的编排传递；不改变凭据算法或失败后不重放语义。
- `preview_source.py` / `preview_provenance.py`：源 settings/资源归属前后核对，使用独立的 `sourcefinal` export 阶段验证源两库和业务对象；成功结果的完整身份、checks、lifecycle 及来源清单以独立密钥认证，条件写入目标私有 OUTBOX，并独立读回。清理必须认证该记录及平台批准的完整结果摘要，不能凭资源名称授权删除。
- `preview_repair.py` / `preview_repair_state.py`：1.0.4 的 `complete-preview-credentials` 仅修复 1.0.2 的准确凭据错误及 1.0.0 隔离来源。须由兼容平台显式继承原 preview context，唯一认证备份、原目标版本/绑定、双库无业务 schema、目标双桶与归档逐对象元数据/字节完全相符才继续。只读复用已恢复对象并重绑原生版本，不重新 PUT/DELETE 业务对象、不创建资源、不重放父任务。SQL/凭据离线准备且源精确比对通过后才发布隔离候选并导入空库，完成迁移/保数据/管理员验收及源最终精确比对；成功 provenance 同时绑定原实例和新 repair 回执。任何写后不确定仍为 unknown。
  1.0.5 还接受 1.0.4 的准确 `EASYEMAIL_SOURCE_DATABASE_CHANGED`，要求平台认证继承原 1.0.2 候选与实例的 `previewBaseline`；不把失败修复版本当成已发布目标。目标仍恢复同一份原认证备份，源保护改为本次 target 写前取得完整双库/对象 witness、完成后 exact 比对，不排除限流/会话/任何业务表，不重采样替换原备份。provenance 的实例始终是原副本，而不是上一 repair task；当前候选仍需真实独立恢复验收。
- `preview_cleanup.py` / `cleanup_references.py` / `cleanup_resources.py` / `cleanup_buckets.py`：仅清理成功 preview 的准确八项资源；先核目标状态、外部 Worker/Pages/邮件/域名引用、D1/R2 创建身份及私有桶清单，条件写入持久一次性消费记录，再停两个入口、删两个 Worker、复查共享引用，最后删除两库两桶。所有删除均独立读回不存在；不提供普通正式实例删除入口。

| SBA 动作 | 当前应用行为 |
| --- | --- |
| verify | 已实现无部署凭据的公开版本验真；需先有本适配器发布的版本证明 |
| deploy（隔离） | 1.0.0 的真实 SpringBok 部署、独立 verify 和基础 Web/API 业务验收已通过；后续候选不因此取得 deploy 成功证明 |
| deploy（正式 custom domain） | 已接通应用源码；要求空闲域名、新空数据资源，以及可选的明确中性邮件目标；尚未通过真实 SpringBok 正式部署验收 |
| update | 已接通同实例持久备份、原生迁移/发布、保数据和既有身份验收；仍待 SpringBok 云升级验收 |
| preview | 1.0.2 首次真实云任务在凭据重签阶段返回 unknown，持久备份已独立下载恢复核对；1.0.3 修正构建入口，整体云验收仍未通过，不重放原任务 |
| destroy-preview | 已接通认证来源、持久一次性消费、先停入口、精确有界删除和独立不存在读回；会执行真实云写，尚未通过 SpringBok 云清理验收 |
| repair / complete-empty-bootstrap | 1.0.1 独立云 repair 与 verify 已通过；不支持已有业务数据或正式实例 |
| repair / complete-preview-credentials | 窄范围独立修复已通过本地原生双 Worker/D1/R2 恢复、认证清理回归；仍待兼容平台发布、固定 SHA CI 与原失败副本的真实云修复验收 |

平台可能在调用应用前准备资源，因此不能把拒绝尚未实现的动作理解成整个平台一定没有写入。两类 deploy 均不是 dry-run。完整生命周期实现并验收前，不应将此中间版本登记为可用发布。

隔离 origin 必须是一对同账号、同前缀的 workers.dev 地址，名字只接受既有
`easyemail-migration-` 或平台生成的 `test-<12hex>-` 前缀；全部六个资源匹配同一前缀。
邮箱后缀必须 `.test`，邮件路由、原生发信、外部供应商、IMAP/SMTP 与 cron 均关闭。
正式 custom domain 不由这一隔离模式默默开启或接管。正式模式读回封存配置中精确的 cron、发信接收者白名单、HTTP 域名和禁用的 workers.dev/preview。写后异常为 `unknown`；若仍有声明的收信目标未绑定，即使仅公开验真失败也为 `unknown`，不能将不完整部署记作 `deployed-unverified`。

## 业务秘密输入

全部来自平台保险库的同名环境变量，不从公开配置读取；每项仍受平台 512 UTF-8 字节、单行限制。

- `EE_MASTER_KEY`：64 位小写 hex。按账号和两库 UUID 派生独立用途的凭据；更新时必须保留，否则既有加密邮箱凭据不能解密。普通更新不提供隐式轮换。
- `EE_REGISTRATION_TOKEN`：32–256 字符的邀请口令。
- `EE_ADMIN_PASSWORD`：15–128 字符，沿用真实平台注册密码规则；它不是自营邮箱 Worker 的管理员接口密钥。
- `EE_PROVIDER_SECRETS`：与公开配置中非匿名外部供应商 ID 精确匹配的 JSON 对象；隔离部署必须为 `{}`。保留的 `self` 凭据由适配器派生，不能覆盖。

当前未声明 Google OAuth client secrets，配置请求相关 OAuth endpoint 时明确拒绝，不部署为半配置状态。秘密文件和完整构建目录不得作为公共 CI artifact 上传；公开结果仅含固定身份、安全错误码和检查项。

## 数据备份的准确边界

备份使用原生 D1 export，不将账号 token 转发到短期下载 URL。单库 SQL 上限 64 MiB、业务对象总量上限 128 MiB、完整加密归档上限 256 MiB；实际可传输容量还受部署账号的 HTTP 请求限制约束，超出时明确失败，不拆包后冒充完整成功。只排除 OUTBOX 的适配器保留命名空间，INBOX 同名对象仍作为业务数据保存。现有业务附件清理器只列举 `outbox/v1/`，不清除此归档前缀；归档保留与删除以后应由明确的应用生命周期操作承担，不擅自新增云资源。

导出与下载前后核业务清单，并重新导出两库作精确 typed-multiset 比对；观察到并发变化就拒绝快照。这里**没有业务写冻结或跨 D1/R2 原子事务**，不能将这些检查描述为全局原子快照。恢复只允许空对象目标，逐个条件创建并独立读回，再生成附件引用重绑定 SQL。preview 已接入原生云导入命令，但实际 Cloudflare export/传输/恢复尚未云验；不能将本地 Miniflare 验收表述为云恢复已成功。

独立 preview repair 是不同的受控路径：目标两库仍必须完全无业务 schema，但双桶必须恰好已有该唯一认证归档的全部业务对象且无私有记录；只读复用，不放宽普通 preview 的空对象目标要求。写前使用 `sourcecheck`、完成后使用 `sourcefinal` 导出分别证明源精确未变，不能冻结业务或隐式选择新快照；源已变、归档歧义或任何目标漂移均拒绝。

update 已接线，但不使用恢复导入覆盖运行实例。备份失败不继续迁移；写入后任何迁移、读回、数据保全或私有验收的不确定结果均为 unknown，不自动重放或回滚覆盖新数据。只有数据保全和私有验收都通过、仅最终公开验真失败时，才返回带 backup-created/data-preserved 的 deployed-unverified。归档私有元数据保留来源 task/SHA/version，便于从持久备份定位恢复输入；不依赖随 runner 消失的本地配置文件。

保数据比对仅排除自营 settings 中已独立核对的 db_version 元数据行，不排除其他设置、密码、邮箱或邮件。AUTOINCREMENT 的实时分配器必须被导出完整保留，升级后可前进但不得倒退；不能仅以幸存行的最大 ID 推测分配器。当前升级预检要求既有 bindings/运行配置符合候选的同配置契约，不隐式接受绑定或配置结构的跨版本变更。

本地运行测试覆盖两真实 R2 桶的加密持久化、独立恢复证明、原生目标 D1 导入准备好的测试 SQL，以及实际附件读取。该测试的 D1 export 输入为明确的本地 SQL 夹具，不冒充真实 Cloudflare export；另有原生 export HTTP 状态/bookmark/下载鉴权合同测试与当前两库 schema 的 SQLite 重建测试。Miniflare 对显式 Standard 存储等级仍读回空字段，测试仅补这个已知字段，尚未验证云端存储等级保留或 InfrequentAccess 行为。

## 本地检查

在仓库根设置源码树外的产物目录，并按仓库约定安装两个 Worker 与固定 Neuro UI 的依赖后：

```powershell
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:EASYEMAIL_TEST_ROOT = 'C:/Users/Public/nas_home/AI/GameEditor/linshi/easyemail-sba-tests'
New-Item -ItemType Directory -Force -Path $env:EASYEMAIL_TEST_ROOT | Out-Null
python -m unittest discover -s .sba/tests -p 'test_*.py' -v
node --test --test-concurrency=1 .sba/tests/release-stamp.test.mjs .sba/tests/release-runtime.test.mjs .sba/tests/archive-crypto.test.mjs .sba/tests/object-control.test.mjs .sba/tests/preview-network.test.mjs .sba/tests/preview-runtime.test.mjs .sba/tests/preview-vault.test.mjs .sba/tests/preview-copy.test.mjs .sba/tests/preview-lifecycle.test.mjs
node --test scripts/tests/effective-code-lines.test.mjs
node scripts/effective-code-lines.mjs --mode ratchet
git diff --check
```

`release.py --request <request.json> --output <全新绝对目录>` 仅能针对干净、已固定 SHA 的 checkout
准备候选，不接受在源工作树内生成输出。调试时不要绕过干净源码校验，把 dirty 构建说成可部署的固定版本。
新增独立 CI 只跑本地合同和打包运行测试，不配置 Cloudflare 凭据，不进行云写。

preview 编排的本地原生演练使用实际打包源/目标双 Worker、空目标 D1 和有业务内容的双 R2，覆盖加密持久备份、恢复、附件读取、既有管理员、自营凭据和源双库未变。随后通过真实 provenance/控制入口执行 cleanup，一次删除目标两桶的原生对象，核目标为空、源 SQL 和源对象身份未变。云 metadata/publish/import/资源 DELETE 使用明确替身，同源码/同 schema 演练不代表不同 SHA 的云发布或真实云资源删除；入口的干净 checkout/不同 SHA/版本边界另由合同检查负责。

destroy-preview 只允许成功且未消费的 preview 来源记录。消费记录为目标私有 OUTBOX 的 `_easyemail-sba/cleanup/<previewTaskId>.json`；跨新任务/新 runner 仍拒绝已尝试清理，写后失败为 unknown，不自动重放、追加清空或恢复入口。每桶单次最多 1000 对象、keys JSON 最多 256 KiB；分页未结束、公开/锁/通知、来源漂移或未知历史 Pages Functions 绑定都拒绝。独立 S3/DNS/路由写入者仍须事先停止；跨请求检查不是 Cloudflare 事务，也不阻止账号外部并发变更。

账号邮件引用扫描要求独立的 `Email Routing Account Rules Read`，Zone 级 `Email Routing Rules Read/Write` 不替代它。权限不足或列表不完整时拒绝清理，不将 403/404 视作空列表。普通正式实例及旧手动实例的实际删除仍必须先列准确清单和数据影响，再获用户明确批准。

下一步和清理批准边界见 [应用接入进度](../docs/cloudflare-springbok.md)。
