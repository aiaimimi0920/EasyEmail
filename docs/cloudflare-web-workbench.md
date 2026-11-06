# Web 工作台 UI 迁移：第一阶段

> 本文保留第一阶段的实现和当时验收记录。当前 Web 的标准主题与控件已切换为 NeuroDesign 的 `@neuro/ui`，
> 见 [当前接入方式](cloudflare-neuro-ui.md)。下文的桌面令牌复用、浅色阅读面和“无新增运行时依赖”
> 仅描述第一阶段，不再作为后续 UI 开发指令；历史验收结果不能替代新接入版本的验证。

## 范围与发布状态

本切片在 `migration/cloudflare-web` 分支完成本地工作台迁移，不发布到 Cloudflare，
不修改域名、数据库、供应商配置或真实发信权限。
正式部署与真实邮件验收的历史记录见 [正式部署说明](cloudflare-production.md)；
不能把已部署的基础网页与本切片尚未发布的新界面混为一谈。

本阶段复用原本地 EasyEmail 的设计基础，而不是把桌面运行时搬入浏览器：

- 共用 `apps/desktop/src/styles/mail-theme-tokens.css`，原桌面全局样式改为导入该令牌。
- 复用 `apps/desktop/src/components/AppIcons.tsx` 中的应用图标和导航图标。
- Web 使用自己的工作台壳层、视图状态和 Cloudflare API，不导入 Tauri、桌面 controller 或本地 Node 服务。
- 构建器显式解析聚合包的 React，发布输入摘要覆盖两个跨目录共用文件。
  线上运行仅需要已打包的 Web 资产，不要求安装桌面包。

## 已迁入的界面

- 深色壳层、分组侧边导航、折叠导航、用户区和当前页面标题。
- 邮箱导航、独立滚动的邮件列表与浅色阅读面；聚合逐封结果复用同一布局。
- 当前邮件、未读状态和当前邮箱的可辨选中状态。
- 单邮箱高级搜索的显式展开与收起；收起不清空已输入的筛选条件。
- 写信编辑区与草稿、发送记录、发送队列旁栏。
- 独立 API Key 入口；不再把凭据操作表单附在每一个业务页面底部。
- 登录页及现有设置、联系人、普通邮箱、Agent 和管理模块的共用主题。
- 窄屏列表／阅读切换、返回焦点恢复、跳过导航入口和无横向页面溢出的布局。
- 未选中某封邮件时仍可操作邮箱级提码；未复制第二套提码状态或等待循环。

## 保持不变的业务边界

保留原 Web 业务组件、权限上下文和 API。换页不卸载写信草稿或原请求恢复状态；
退出／换用户仍清除账号上下文。API Key 只有用户显式创建时才产生，单次明文展示和撤销规则不变。

打开缓存邮件不会自动同步供应商、标为已读或发信。HTML 仍需显式选择并经过隔离处理，
附件下载仍校验权限和来源。平台状态与远端操作继续分离，发送 unknown 的原键处理规则不变。
用户选择的标签颜色保留原有数据语义，不因全局主题统一而变成另一种颜色。

本阶段没有新增接口、数据库迁移、后台任务或运行时依赖。
原桌面令牌内容及提取后编译得到的全局 CSS 已做等价比较；这不是旧桌面整包的运行验收。

## 本地验收入口

在 `service/cloudflare` 中执行，测试仅使用 loopback 夹具与独立合成账号：

```powershell
$env:EASYEMAIL_TEST_ROOT = 'C:/Users/Public/nas_home/AI/GameEditor/linshi/easyemail-workbench-tests'
New-Item -ItemType Directory -Force -Path $env:EASYEMAIL_TEST_ROOT | Out-Null
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p web/tsconfig.json
node scripts/run-tests.mjs web
node --test --test-concurrency=1 tests/release-inputs.test.mjs tests/release-artifacts.test.mjs tests/release-runtime.test.mjs tests/deployment-config.test.mjs tests/deployment-production.test.mjs
```

`tests/workbench-web.test.mjs` 覆盖多用户隔离、默认凭据区隐藏、桌面分栏、缓存读取／提码、
不自动标已读、换页保留草稿、移动端提码及返回焦点。完整 Web 组继续验证原有业务流程。
发布包测试检查双 Worker 候选的可搬移性，不执行云端发布。
仓库根目录仍须运行有效行 checker 的单元测试、ratchet 以及差异检查。

2026-11-05 本地验收记录：Web 组共 86 个文件、178 个用例，首轮 173 通过、5 失败；
失败项通过入口适配、滚动命中时序修正或恢复原有设置联锁后，均已定向复验关闭，
不是一次从头运行全绿的记录。首轮启动后的唯一运行源码增量是恢复邮箱设置的 disabled 联锁，
其最终相关 5 个用例通过。安全 HTML 后的二进制下载继续使用真实点击、下载事件与字节比较，
Edge 连续 3 次通过；未使用强制点击或模拟下载绕过验收。
发布输入／候选／运行时／部署描述另有 20 项通过；Web 与 Worker TypeScript 及最终构建通过。
有效行 checker 单元测试 19 项通过，ratchet 与 strict 均扫描 2139 个文件、零违规。
本地截图使用明确的合成账号和 `.test` 邮箱，不是生产邮箱内容或真实投递证明。

## 尚未迁入或尚未验收

- 写信仍使用当前真实可发送的纯文本契约，尚未实现桌面式富文本编辑器。
- 邮箱设置、供应商分配、普通邮箱和 Agent 等复杂表单已接入共用主题，
  但不是原桌面全部交互和信息架构的最终迁移版。
- 会话、订阅、普通邮箱目录等独立详情保留现有流程，尚未全部统一成同一分栏工作台。
- 旧桌面里的本地暂存附件、加密预览等能力不因视觉迁移而被标为云端已实现。
- 本地夹具验收不能代替新界面在真实线上账号与浏览器中的发布后验收。

本阶段的回退边界是 Web 组件／样式、共享令牌的提取和构建输入登记，
不需要数据回退；任何实际发布仍应单独准备冻结候选并执行既定发布门禁。
