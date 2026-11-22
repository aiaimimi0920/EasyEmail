# Cloudflare Web：NeuroDesign 接入

## 当前开发方式

Web 通过 `@neuro/ui` 使用 NeuroDesign 的 React 标准控件与固定主题，不再消费旧桌面主题令牌。
独立设计仓库位于 `C:/Users/Public/nas_home/NeuroDesign`；声明层是其
`design-md/neuro/DESIGN.zh-CN.md`，应用集成遵循 `docs/INTEGRATION.md`。
Loom 是依赖安装、主题接线与控件消费方式的参考，不是 EasyEmail 的业务或页面模板。

实际工作树为 `C:/Users/Public/nas_home/EasyEmail`，分支 `migration/cloudflare-web`。
原 `AI/GameEditor/EasyEmail` 主干、NAS 和生产业务数据保持不变。
下文保留各本地阶段当时的验收边界；随后已选择性提交并发布前端资源，见 [Neuro UI 发布记录](cloudflare-neuro-ui-release.md)。

## 安装与同步

设计仓库和 EasyEmail 应并列检出在同一个父目录。设计仓库先按其说明准备依赖。
在 `service/cloudflare` 中使用 Node 22.13+、npm 11+：

```powershell
npx --yes npm@11 ci --ignore-scripts
npx --yes npm@11 run ui:sync
npm run typecheck
```

`package.json` 通过 `file:../../../NeuroDesign/packages/react/neuro-ui` 引用标准包；
`.npmrc` 固定 `install-links=true`，消费已构建副本，不链接设计仓库的 React。
`ui:sync` 只构建 neuro 标准库并同步分发文件，检查宿主 React / React DOM 唯一性及 Radix 上下文。
更新包清单、版本、导出或依赖元数据时必须通过 npm 更新 lockfile；不能只复制 dist。
依赖锁以外，本地 `file:` 包的实际安装产物也写入发布输入摘要，防止同版本文件变动漏过冻结检查。

应用入口加载 `@neuro/ui/styles.css`，由 `NeuroProvider mode="dark"` 提供主题。
成品 CSS / JavaScript 已包含所需控件，运行时不访问本机 NeuroDesign 目录，用户无需安装客户端。

## 本轮替换范围

- 原生按钮改为标准 `Button`，保留真实提交类型、事件、可用性和业务文案；长操作使用 `wrap`。
- 壳层使用 `NavigationItem` 和紧凑 `IconButton`；管理员入口、折叠、跳过导航与页面身份不变。
- 输入、多行输入和原生选择改为 `Input`、`Textarea`、`Select`，字段关联使用 `Field`。
- 复选框使用 `Checkbox`，保留 FormData、受控／非受控值和原生事件，不嵌套 label。
- 通用卡片、持久错误／状态和管理折叠区使用 `Panel`、`Notice`、`Disclosure`。
- 覆盖登录、邮箱、阅读／写信、联系人、订阅、普通邮箱、Agent、API Key、账号安全与管理页面。
- 原基础控件皮肤退出；应用 CSS 只负责邮件布局、滚动、响应式和领域内容。
- 阅读区遵循当前标准主题，不再保留旧版的大面积浅色反转皮肤；安全 HTML 仍在独立沙箱中保真展示。
- 现有产品图标保留，仅将其艺术资源使用的旧变量局部绑定到标准主题，不载入桌面 CSS 或运行时。
- 根 `AGENTS.md`、`README.md` 和贡献入口明确新方法；第一阶段工作台记录保留为历史，不改写当时验收。

## 保持不变与确认交互

供应商接入、API、权限、业务状态、草稿、上传、发送幂等与未知结果恢复不进入组件库。
缓存打开不自动同步、不标已读、不发信；HTML 隔离和附件权限不因换控件放宽。
直接 JSX 控件审计保留一个原生文件 input 例外：真实文件选择、重复选择清空及上传协议保持不变。

后续确认接入阶段已将 32 个文件中的 40 处 `window.confirm` 替换为标准 `ConfirmDialog`：

- `ConfirmationProvider` 只持有 EasyEmail 的 FIFO 请求队列；`useConfirmation` 将确认绑定到组件 owner 和显式业务身份／草稿。
- 取消、身份变化和卸载均返回 false；重复待确认请求被拒绝。一次双击不得同时批准队列中的两个不同意图。
- `useCloudDraft.canReplace`、`useAgentTasks.newTask` 及其上层调用逐层 await，不把 Promise 当 boolean。
- 写信请求 nonce、账号版本、未知请求 held／generation 和 busy ref 在确认后仍核对；原 key/body 的恢复路径不重建确认意图。
- 外部退订地址使用局部标准弹窗，在真实确认按钮回调中二次校验 URL 并打开，保留浏览器用户激活、`noopener,noreferrer` 和结果未验证状态。
- 弹窗焦点、Escape、取消和滚动锁交给标准库；业务队列和 Promise 不进入 NeuroDesign，也不新增基础控件皮肤。
- 现有浏览器测试改为实际 DOM 弹窗操作，保留取消无写入、风险正文和确认次数断言；持续观察型夹具在测试 teardown 显式收束任务与错误。

确认迁移不扩展发信、自动退订或删除权限，亦不撤销已提交的发送意图。

富文本写信、所有独立详情的统一分栏、旧桌面特有能力仍沿既有功能范围，不在本次 UI 依赖接入中扩展。

## 验证入口

测试只使用 loopback 夹具、独立状态目录与合成账号，不连接真实供应商或发送真实邮件：

```powershell
$env:EASYEMAIL_TEST_ROOT = 'C:/Users/Public/nas_home/AI/GameEditor/linshi/easyemail-neuro-tests'
New-Item -ItemType Directory -Force -Path $env:EASYEMAIL_TEST_ROOT | Out-Null
npm run typecheck
node scripts/run-tests.mjs web
node scripts/run-tests.mjs release
node scripts/build.mjs C:/Users/Public/nas_home/AI/GameEditor/linshi/easyemail-neuro-build
```

仓库根继续运行 checker 单测、ratchet、strict 和 `git diff --check`。
`neuro-ui-integration.test.mjs` 验证包／Provider 接入、基础控件无回退及旧样式退出；
业务浏览器组验证真实提交、风险确认、原键恢复、文件上传／下载、页面切换与移动端焦点。
`release-inputs.test.mjs` 额外验证同版本 UI 产物变动会改变摘要。

本轮日志与前置现场保存在 `AI/GameEditor/linshi/ee-neuro-ui-20261105`。
具体验证结果以该目录的最终 `verification.json` 为准；第一阶段文档的数字不代表本轮结果。

### 2026-11-05 基础控件阶段结果

- Web 组 87 个文件、182 项通过，零失败、取消或跳过。
- 全量运行期间最后仅将跳过导航入口收敛为标准 `ButtonLink` 并移除其重复皮肤；最终相关 6 项浏览器回归通过，包含实际颜色、跳转焦点、表单提交与邮件工作台。
- 双 Worker 发布组 23 项通过；最终 Web／Worker TypeScript 检查与本地构建通过。没有冻结或发布新的云端生产候选。
- checker 单元测试 19 项通过；最终 ratchet 与 strict 均扫描 2142 个文件，零违规，无剩余有效行基线债务。
- 对比 427 个原控件调用的业务属性、事件及提交类型，没有不匹配；范围外源码哈希不变。
- 这不是最终源码再次从头执行全量组的记录；最后的链接收敛由定向回归覆盖。截图来自合成账号，不是生产数据或真实投递证明。

### 2026-11-05 确认交互阶段结果

- 40 处原生确认已全部迁移：39 处通过 owner-scoped 异步确认，1 处退订地址通过局部标准弹窗保持浏览器用户激活；原 39 处风险参数逐项一致。
- 新增实际 Chrome 回归覆盖取消无写入、初焦／Escape／返回焦点、窄屏、单请求防重、FIFO、同文案连续请求、双击不批准下一意图、身份变化、owner／宿主卸载及旧写信 nonce 不覆盖新请求。
- 冻结运行代码后完整 Web 组执行 89 个文件、184 项：183 项通过，1 项失败。唯一失败是保留策略旧测试遗漏了原生 dialog 到 DOM 的转换，并非运行代码回退。
- 仅修正该测试夹具后，保留策略及普通邮箱保留相关 4 项全部通过；没有重跑其余未变化的 Web 用例，也不将本轮描述为最终源码一次全量全绿。
- 双 Worker 发布相关测试 23 项通过，最终 TypeScript 检查和本地 Web／Worker 构建通过；确认修复后没有再修改运行代码。
- checker 单测 19 项通过；ratchet 与 strict 扫描 2147 个文件，均零违规，无剩余有效行基线债务。
- 本轮 75 个文本文件相对前置现场变化，UTF-8 无 BOM；无文件丢失，范围外文件哈希保持不变。未提交、推送、合并或部署。
- 本轮证据目录为 `C:/Users/Public/nas_home/AI/GameEditor/linshi/ee-neuro-confirm-20261105`，最终结论、全量失败记录、补测、源码冻结审计与截图以其中的 `verification.json` 为入口。
