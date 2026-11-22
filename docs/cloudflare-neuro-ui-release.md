# Neuro UI：选择性提交与生产发布

## 已发布范围

用户确认主题化完成后提交、部署。本轮只提交 Web 工作台、NeuroDesign 标准控件、确认交互、相应测试与构建输入保护；未将已有供应商修复或生产配置混入 UI 提交。

- 开发目录：`C:/Users/Public/nas_home/EasyEmail`。
- 分支：`migration/cloudflare-web`，未合并 `main`。
- UI 源码提交：`b8d60dd7e18290a4fd84110f1d368b00565cd6b3`，165 个文件，已推送并核对远端 SHA。
- 网页和统一 API：[mail.aiaimimi.com](https://mail.aiaimimi.com)。
- Worker：`easyemail-production-platform`，新版本承接 100% 流量。
- 切流时间：`2026-11-05T15:56:08.432Z`；部署后核对于北京时间 2026-11-06 完成。
- 新版本：`ecf84862-6206-49ad-b02e-49e209e81733`。
- Deployment：`6a6dc0a2-5ec7-4a1e-97a2-c2792a002049`。
- 回滚版本：`89806202-f4d8-41c2-804c-d1c32d6549f9`，保留未删除。

`@neuro/ui` 标准包、深色 Provider、按钮／输入／选择／复选／面板／提示／导航，以及 40 处确认交互均已上线。
上传协议需要的原生文件 input 有意保留。富文本编辑器、所有独立详情统一分栏及旧桌面特有能力不是本轮主题化承诺，不标为完成。

## 最小发布与回滚边界

当前工作区还保留其他阶段未提交的后端修复。为避免从较早 Git 基线重建并回退线上修复，本次没有上传本地重新构建的 Worker JS，也没有重新部署自营 Email Worker。

发布前保存了当前部署、版本、bindings、运行设置、cron、custom domains、workers.dev 设置、Worker 模块及旧静态资源；先上传新版本并核对，再显式切流。
新版本使用 UI 提交导出的源码构建的三个 Web 文件，以及从实际线上读取的原 Worker 模块。

- 实际执行的 `worker.mjs` 部署前后字节相同，SHA256 为 `4e9d8d44f7134bc4186b8a1eb8589c58dabe2532472bdc7b5a8dd62a0696f4cd`。
- bindings、业务配置、compatibility、资产路由、Worker 运行设置、cron、域名及自营 Email Worker 部署均保持原值；仅版本发布注释更新。
- 密钥通过原 bindings 继承，没有读取或覆盖线上 secret 明文。
- 没有应用 D1 migration，没有修改 DNS/MX、收信路由、供应商配置、发信权限或 NAS。
- 回滚可将上述旧版本重新设为 100%；本次没有执行回滚演练，亦不以此新增一次生产切换。

## 验证

### 本地候选

从暂存区导出提交内容重建前端，HTML、JavaScript、CSS 与此前本地验收产物逐字节一致，没有将未提交的后端文件编入本轮候选。

| 文件 | SHA256 |
| --- | --- |
| `/index.html` | `0f1a6cd184d673e3020701c3320a4eb9bf0d3caff51eb217d97d210c365dc776` |
| `/assets/app.js` | `364b01095b01506848a258a78ed04a24d030faffe443a46213437f444fc8d573` |
| `/assets/app.css` | `bfddf48502cd61e3dbd559da125bc42d15c71a50c4672effdb6d6913efa2906e` |

复用此前未变化源码的验收：基础控件 Web 182 项通过；确认阶段完整 Web 184 项中 183 通过、1 项为旧 dialog 夹具遗漏，修正该夹具后相关 4 项通过，运行代码未再变化。发布相关 23 项、最终类型检查和构建已通过。不是最终源码重新从头执行一次完整 Web 组的声明。

提交前重新执行 checker 单测 19 项，ratchet 和 strict 均扫描 2147 个文件，零违规、无有效行基线债务；暂存差异检查通过。仅清除了新纳入跟踪的历史桌面 token 文件末尾空行，不影响运行行为。

### 线上浏览器与运行

Chrome 使用独立临时上下文及既有验收账号，通过真实页面完成：

- 登录、导航折叠／展开、跳到工作区及退出。
- 真实缓存邮件桌面列表／阅读分栏、Neuro 标准主题与信号黄检查。
- 输入仅本地草稿、打开标准确认框、Escape 取消且草稿不丢失、跨页返回仍保留草稿。
- API Key 页面入口可用；未创建或撤销实际 Key。
- 390px 窄屏无页面横向溢出；列表／阅读切换和返回焦点正常。
- 48 个 API 响应无 HTTP 5xx，零 JavaScript `pageerror`。除登录／退出外无业务写请求，未发送邮件、同步供应商或保存云端草稿。
- `/healthz` 返回 HTTP 200、`status: alive`。
- 约 100 秒 tail 捕获 22 个事件，包括 2 次 cron，均无异常；CLI stderr 仅提示使用现有代理环境。

公网 JavaScript／CSS 哈希与候选完全一致。HTML 含 Cloudflare 既有 challenge-platform 动态注入；仅剥离已识别的单个注入脚本后，HTML 其余字节与候选一致，没有为哈希比较关闭安全设置。
Cloudflare content API 的 source map 读取曾表现为省略 `sourcesRoot:null`；归一化该非标准空字段后，源码、名称和映射完全相同，最终读取的原始哈希亦与备份一致。

首个版本上传因带入只读 `workers/triggered_by` 注释返回明确 HTTP 400，未创建可用版本或切流。核对线上部署与 latest 未变后，改为仅发送文档允许的注释并完成发布；保留首次失败及恢复证据。

## 证据与未扩大范围

发布证据目录：`C:/Users/Public/nas_home/AI/GameEditor/linshi/ee-neuro-publish-20261105-01`。
以 `candidate-artifacts.json`、`upload-verification.json`、`promotion-verification.json`、`web-smoke.json`、`production-tail.json` 和 `postflight.json` 为入口。
截图为 `production-neuro-desktop.png`、`production-neuro-confirm.png`、`production-neuro-mobile.png`；内容来自既有受控投递验收邮件，不是本轮新发信。

没有以主题化发布替代普通 IMAP/SMTP、Google OAuth、Agent 公网互操作或其他供应商的独立业务验收。其余工作区改动原样保留，未合并主干、删除旧实例或清理生产数据。
