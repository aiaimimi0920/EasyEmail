# Cloudflare 迁移本地整体验证

## 测试入口

Windows 的 npm script 经过 shell 执行。旧主测试命令长 11741 个字符，在进入 Node 前就会报 `The command line is too long.`，不能把这一失败当作业务测试已执行。

五个 npm 入口现在调用 `service/cloudflare/scripts/run-tests.mjs`。显式测试清单位于同目录的 `test-groups.json`，保留原有分组和文件顺序；Node 通过无 shell 的子进程串行执行测试，不缩减测试集合或改用替代运行时。

- `npm test`：runtime，含新增的测试入口回归。
- `npm run test:web`：真实隔离 Chrome 的网页测试。
- `npm run test:upstream`：完整自营 Email Worker 集成。
- `npm run test:portability`：无 Node 全局的核心可移植性；保留 VM Modules 参数。
- `npm run test:release`：发布候选的定向回归，与 runtime/Web 中的对应测试有意重叠。

runtime、web、upstream、portability 四组覆盖完整测试清单；不需要再重复运行 release 才能补齐文件。新增测试必须显式归组。启动前会拒绝遗漏文件、组内重复、失效路径、目录穿越及未知分组；不同组之间允许有意重叠。

可只读核对分组，不启动测试：

```powershell
rtk proxy node scripts/run-tests.mjs runtime --list
```

## 隔离输出与运行

从 `C:\Users\Public\nas_home\EasyEmail\service\cloudflare` 执行。测试要求显式设置绝对的 `EASYEMAIL_TEST_ROOT`；Windows 下应使用 linshi 中较短的新目录，避免 workerd SQLite 路径超过限制。

```powershell
$root = Join-Path 'C:\Users\Public\nas_home\AI\GameEditor\linshi' ('eet-' + (Get-Date -Format 'MMddHHmmss'))
New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
$env:EASYEMAIL_TEST_ROOT = $root
$env:TEMP = $root
$env:TMP = $root
$env:WRANGLER_SEND_METRICS = 'false'
rtk proxy npm test
rtk proxy npm run test:web
rtk proxy npm run test:upstream
rtk proxy npm run test:portability
```

同时运行 checker 单测、ratchet、TypeScript 和生产构建；构建输出也显式指向 linshi。检查每条命令的实际退出码，不以启动成功、TAP 中的部分通过或清单完整代替整组成功。

## 证据与授权边界

历史迁移测试必须先显式迁移到其标题指定的版本，并在该版本重复调用迁移，严格比较原表定义和全部旧行。不能使用无版本上限的 `migrate()` 来证明某一历史迁移没有改表，因为后续合法迁移可能新增字段。

Agent 历史迁移测试通过该边界后，再使用 `migration-preservation.mjs` 升级到当前全部迁移并重复调用，按原字段投影检查全部旧行和顺序保全，然后验证当前 API、旧幂等键、凭据、R2 内容与跨所有者约束。新增字段不应触发历史表定义误报，但旧字段改值、丢行、增加意外旧表行或顺序变化仍会失败。

每次整体验证应保存源码基线、精确命令、UTF-8 日志、退出码、测试总计、原目录保全和相关进程退出检查。源码中途变更会使原回执失效，必须按实际影响重新验证。

主机重启造成的进程异常退出必须与业务断言失败分开记录。先确认旧 owner 已终止并核对源码哈希，保留原失败回执，再用新证据目录补测被中断或未启动的文件；不能把部分 TAP 通过数或跨轮补测汇总表述为一次全量运行成功。

这些测试只证明对应本地运行时和模拟上游场景；不证明真实供应商可用性、真实 Google 授权、公网邮件投递、云端容量或成本。

测试入口修复不会创建或修改 Cloudflare 资源，不运行远端迁移，不设置生产密钥、不发布应用、不改域名/MX，也不提交或合并迁移分支。真实云端部署与业务验收仍需分别授权。
