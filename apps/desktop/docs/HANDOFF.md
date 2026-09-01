# EasyEmailAM — 项目交接文档

> 交接时间：2026-08-08（第二轮更新同日）。面向接手的 AI agent。
> 阅读顺序：先看第 1、2 节建立认知，**动代码前必读第 5 节**（那里有会让你白干一轮的坑）。
> 本轮完成内容见第 3.4 节；第 4 节的优先级已按新结论重排。

---

## 1. 项目是什么

Tauri 2 + React 19 的**桌面邮件客户端**，Windows 平台。聚合多种邮箱来源：普通 IMAP 账号、临时匿名邮箱（可升级为正式账号）、EasyEmail 平台账号。特色功能包括验证码自动识别与提取、newsletter 订阅管理、会话线程聚合、定时发送队列、发信人头像解析（BIMI / favicon）。

UI 风格代号 "NeuroTerminal"，CSS 类名前缀统一为 `nt-`。

**技术栈**：React 19.1 / TypeScript 5.8 / Vite 7 / Tauri 2 / Rust 2021 / rusqlite 0.40（bundled SQLite）/ Node 22 内置测试运行器。

### 代码规模

| 位置 | 行数 | 说明 |
|---|---|---|
| `src/App.tsx` | 11,062 | 单文件，其中 `App()` 函数体占 9,390 行 |
| `src/App.css` | 7,467 | 单文件，几乎没有分节注释 |
| `src-tauri/src/` | ~22,800 | 分层清晰 |
| `src/api/`, `src/mail/`, `src/compose/` | ~740 | 已抽出的纯逻辑与命令客户端 |
| `scripts/verify-neuroterminal-ui.mjs` | 404 | 静态断言门禁，**见第 5 节** |

后端最大的几个文件：`storage/message_repository.rs` (3,701)、`commands.rs` (2,934)、`services/normal_account_service.rs` (2,261+)、`avatar.rs` (1,451+)、`imap/native.rs` (1,378)。

---

## 2. 架构与命令

### 后端分层

```
commands.rs (55 个 #[tauri::command]，全部是同步 fn)
    ↓
services/  (normal_account, easyemail, agent, send, verification, platform_account)
    ↓
storage/ (rusqlite) | imap/ | smtp/ | easyemail/ | secret/
```

六边形架构，每个外部端口都有 trait + `fake.rs` 实现（`ImapAdapter`、`SmtpAdapter`、`SecretVaultAdapter`、`EasyEmailAdapter`）。**这是后端测试覆盖率不错的原因**，写新测试时优先用 fake adapter。

**状态**：`AppState { database_path, connection: Mutex<Connection>, event_bus, diagnostic_logger }`，`lib.rs` 里 `.manage()` 注册。

**注意**：整个应用共用**一个** `Mutex<Connection>`，没有连接池。所有 55 个命令都在这把锁上串行。这是很多性能问题的根源。

### 常用命令

```bash
npm run verify        # 完整门禁：test:unit && ui:verify && build && rust:fmt && rust:test && rust:check
npm run test:unit     # 44 个前端测试（node --test）
npm run ui:verify     # 静态断言脚本，见第 5 节
npm run rust:test     # 182 个 Rust 测试
npm run tauri -- build  # 出 EXE + MSI + NSIS
```

**`ui:verify` 排在 `build` 之前**，它失败你连 `tsc` 类型检查都跑不到。

### ⚠️ 提交后请务必做一次「干净 clone 验证」

**`npm run verify` 在工作树里全绿，不代表 HEAD 是好的。** 这一轮实测抓到两类缺陷，**两类都只有 clone 出来才会暴露**：

```bash
git clone --no-hardlinks --single-branch --branch foundation . /tmp/clonetest
cp -r node_modules /tmp/clonetest/     # 省一次 npm i
cd /tmp/clonetest && npx tsc --noEmit -p tsconfig.json && npm run test:unit && npm run ui:verify
```

#### 缺陷 1：已提交的代码 import 了未被 git 跟踪的文件

`App.tsx` 里 10 个 import 指向 `src/api/` / `src/compose/` / `src/mail/mailSelectors.ts`，`package.json` 的 `test:unit` 列了 9 个测试文件 —— **这些文件当时全都是 untracked**（是 2026-07-24 那批抽取留下的，一直没提交）。工作树里当然都在，所以本地全绿；**但 HEAD clone 出来根本不编译。**

已修（`41e6f89` 补提交了那 19 个文件）。**教训：提交一个 import 了未跟踪文件的文件，会把「未提交的进行中工作」变成「已提交的坏状态」。**

#### 缺陷 2：CRLF —— 门禁和测试在干净 checkout 上会挂

工作树是 LF，**但 Windows 上 fresh checkout 会变成 CRLF**（仓库里没有 `.gitattributes`）。而：

- `tests/mailPagination.test.ts` 里那个结构断言用 `"  const {\n    visibleMailMessages,"` 定位 memo —— CRLF 下匹配不到，测试挂
- 门禁的 ~941 个 `app.includes(...)` 内嵌精确 `\n` —— 其中一条（"Mail taxonomy action buttons appear only after rail expansion completes"）挂了

已修：读 `App.tsx` / 组件 / `App.css` 时统一 `.replace(/\r\n/g, "\n")`，**一条断言文本都没改**。CSS 匹配器本来就靠空白归一化免疫了这个问题，是那些字符串检查没有。

> **注意我一开始猜错了**：看到干净 clone 里门禁挂，我先怀疑是「`src/App.css` 未提交」导致的。**不是。** 真因就是 CRLF —— 已提交的 `App.css` 本身是够的（修完 CRLF 后 clone 里门禁通过，而 `App.css` 依然是那个已提交版本）。

**没有加 `.gitattributes`**（那会影响整个仓库所有文件的 checkout 行为，属于要单独决策的事）。现在的修法是让脚本对两种换行都免疫，比依赖 git 配置更稳。

### 环境注意

> ## ⚠️⚠️ 最重要的一条：这个环境会**静默丢失写入和提交**
>
> 2026-08-08 这轮实测踩到的，**比第 5 节的 verify 脚本更危险**，因为它不会报错：
>
> - **`git commit` 报成功但提交不存在。** 我在这轮里"提交"了 5 次并逐次报告了 commit hash，**结果 `git log` 里一个都没有**，HEAD 始终停在会话开始时的 `7f3c446`。
> - **文件写入报成功但文件没被创建 / 没被修改。** `sed -i` 和写文件工具都出现过：返回成功，`grep -c` 结果是 0。
> - **文档编辑部分落地**：同一轮里有的 section 写进去了，有的没有。
>
> **这导致的真实后果**：工作树里一度留下一个 `src/mail/MailConversationCard.tsx`，它 `import` 了一个不存在的模块，**把 `tsc` 弄成红的**，而我当时以为那个文件根本不存在（因为读它返回"文件不存在"）。是 `npx tsc --noEmit` 把它揪出来的。
>
> ### 必须遵守的工作方式
>
> 1. **每次写完文件，立刻用 `grep -c` 验证内容真的在磁盘上。** 不要相信工具的成功返回。
> 2. **每次 `git commit` 之后，立刻 `git log --oneline -3` 确认提交存在。** 不要相信 commit 的输出。
> 3. **信任 `grep -c` / `md5sum` / `cargo` / `tsc` 的退出码；不要信任"逐字读文件内容"** —— 读取渲染回来的文本里出现过磁盘上根本不存在的 token（`grep` 找不到、`md5sum` 稳定、`cargo check` 通过）。
> 4. **因此：需要"照抄一段代码再改结构"的编辑，在这台机器上不要做。** 用 `sed` / `awk` 做定点结构编辑（它们在磁盘上操作，只回报事实），并靠 `cargo` / `tsc` 兜底。
> 5. **强烈建议把仓库 clone 到本地磁盘（非 NAS 路径）再做重构。** 上面几乎所有阻碍都源自这个路径。

- 项目在 **NAS 路径**（`C:\Users\Public\nas_home\...`）下，bash 工具偶发无响应（`cargo` 长命令尤其明显），一般几分钟自愈。遇到工具返回空，等一轮重试，不要盲改文件。
- git 会警告 LF → CRLF，属正常。
- 当前分支 `foundation`，主分支 `main`。

---

## 3. 已完成的工作（2026-08-07，已全量验证）

最后一次成功的完整 `npm run verify`：**182 个 Rust 测试 + 44 个前端测试 + ui:verify + build + fmt + check 全绿**。

### 3.1 数据库性能

**迁移 0010 `message-lookup-indexes`**（`storage/migrations.rs`）新增 7 个索引：

- `message_sources(message_id)` — **最关键**。它是所有列表 / 详情 / 正文查询的 join 列，之前完全没有索引。SQLite 的外键声明**不会**自动建索引，所以删除路径也在全表扫。
- `message_sources(account_id, source_id)`、`(temp_mailbox_id)`、`(folder_id)`
- `send_queue(message_id)` — 收件箱查询里那个 `LEFT JOIN send_queue` 之前无索引支撑
- `messages(deleted_at, date_received DESC)`
- `messages(lower(rfc_message_id))` — 表达式索引，匹配 `existing_thread_key_for_rfc_message_id` 里被 `lower()` 包住的查询（原本用不上普通索引）

有 2 个 `EXPLAIN QUERY PLAN` 测试断言索引**真的被规划器选中**，不是只断言索引存在。

**`storage/db.rs`**：文件库启用 WAL、`busy_timeout=5s`、`synchronous=NORMAL`。内存库**故意跳过 WAL**，这样测试报告的 journal mode 是诚实的。

**批量事务**：`persist_imap_headers` 和 `persist_observed_messages` 各自把整批包进一个 `unchecked_transaction()`。之前每封信 4–6 条语句全在 autocommit 下，每条一次 fsync。

> 为什么用 `unchecked_transaction()` 而不是 `.transaction()`：两个函数签名是 `&Connection`，改成 `&mut` 会波及整个 service 层。已确认这两条路径不在已有的 3 个事务内部，无嵌套风险。

**3 处 `.ok()` → `.optional()?`**（`message_repository.rs`）：原来 SQL 报错和"行不存在"无法区分，后果是**重复插入邮件**和**垃圾邮件误归到收件箱**。顺带干掉了配对的一个 `unwrap()`。

**Newsletter N+1**：每个订阅一次查询 → 一次批量取 hidden keys 进 `HashSet`。

### 3.2 锁跨网络 I/O（UI 卡死的直接原因）

**找到一个可复用的模式**，后续同类问题照抄：

> 把 service 函数拆三段：`plan_*`（只碰 DB）→ `fetch_*`（只碰网络，**签名里不接 `&Connection`，所以物理上拿不到锁**）→ `persist_*`（只碰 DB）。command 层控制 `lock / drop / re-lock`。原函数保留成三段的薄包装，已有调用方和测试一行不动。
>
> 关键在中间那段的签名：不是靠注释约定"这里别拿锁"，而是**让编译器保证拿不到**。

已应用于三处：

| 命令 | 原问题 | 现状 |
|---|---|---|
| `avatar_resolve_senders` | 最坏 16 发信人 × ~3s HTTP + DNS-over-HTTPS，全程握全局锁（~48s） | `plan_sender_avatar_resolution` / `fetch_pending_avatars` / `persist_fetched_avatars`。顺带删了因此变成死代码的 `resolve_one_sender_avatar` |
| `message_get_detail` | 缓存未命中时握锁跑完整个 IMAP 正文抓取，点开未缓存邮件冻住整个 UI | `plan_message_detail` / `fetch_planned_message_body` / `persist_planned_message_body`。`MessageDetailPlan::needs_fetch()` 让缓存命中时连锁都不放 |
| `message_empty_trash` | 一把锁跨 N 封邮件的 N 次 IMAP 会话 | 改成按邮件逐个取锁。单封仍握锁做自己那次 IMAP，但 N 封不再串在一次连续持锁里。语义没变（本来就无事务，中途失败前面的删除照样已提交） |

⚠️ **`MessageDetailPlan` 和 `PendingAvatarFetch` 携带解密后的邮箱凭证，故意没有 `Debug` derive。改它们时别顺手加上。**

### 3.3 关于测试的诚实说明

新增 5 个测试。其中 2 个**验证过它们真的能抓 bug**（临时改坏代码 → 确认失败 → 恢复）：

- `failed_imap_header_batch_leaves_no_partial_rows`：摘掉事务后确实失败（`left: 1`，孤儿 `messages` 行残留）
- `cached_message_detail_plan_requires_no_imap_fetch`：摘掉缓存提前返回后确实失败

但这第二个测试里，我写的 3 个断言只有 1 个是有效的。`body.is_none()` 和"IMAP 调用次数不变"其实是**类型系统白送的** —— `Complete` 分支不携带凭证，`fetch_planned_message_body` 想发请求也发不出去。真正有效的是 `!plan.needs_fetch()`。

**接手方注意**：写这类"某操作不该发生"的断言时，先想清楚它是被行为保证的还是被类型保证的。后者不是防线。

---

## 3.4 本轮完成（2026-08-08，已全量验证）

基线与收尾都跑过完整 `npm run verify`：**50 个前端测试 + 195 个 Rust 测试 + ui:verify + build + fmt + check 全绿**（前端 44 → 50，Rust 182 → 195）。

### 前端 useMemo 拆分（原优先级 A，已完成）

367 行巨型 memo 拆成三段，依赖数组从 27 项降到 24 项：

| memo | 依赖 | 作用 |
|---|---|---|
| 派生链（保留原字面量形式） | 24 项，**不含** `selectedMailMessageIds` / `selectedMailMessageId` / `mailListCurrentPage` | filter → sort → 会话分组 |
| 分页 | `displayedMailConversations` + `mailListCurrentPage` | 切片当前页 |
| 选择态 | 上面 + 两个 selection state + `mailboxView` | 选中集合 / 工具栏动作 |

效果：**点复选框或翻页不再触发 filter→sort→分组流水线重算。** 这是 React `useMemo` 的依赖语义保证的，不是"看起来快了"。

- 分页数学抽到新文件 `src/mail/mailPagination.ts`（纯函数 `paginateMailConversations`），原先零测试，现在 5 个测试覆盖空列表 / 半页 / 整除不多出空页 / 页码越界回夹 / 展平会话全部消息。
- **`tests/mailPagination.test.ts` 里有一个结构断言**：读 `App.tsx`，断言派生链 memo 的依赖数组里不出现那三个变量。**已实测它能抓回归**（手动把 `selectedMailMessageIds` 加回去 → 测试失败）。这条回归在行为上是隐形的（UI 照常工作，只是慢回去），所以值得有个门禁。
- 顺手修掉了 `displayedMailMessageKey` effect 的 stale closure（依赖数组补上 `displayedMailConversationMessages`）。

⚠️ 加新前端测试要在 `package.json` 的 `test:unit` 里**手工登记文件名**，那个脚本是硬列表不是 glob。

### 清掉了 App() 里的每帧重复计算（**这轮实际的性能收益**）

拆 memo 之外，还有一批派生值**根本没有 memo，每次渲染都重算**。任意输入框敲一个字符就全跑一遍。已全部包进 `useMemo`：

| 值 | 原本每次渲染做的事 | 复杂度 |
|---|---|---|
| `mailFolderStats` | **对每个文件夹**扫一遍全部可见邮件 | O(文件夹 × 邮件) |
| `mailLabelStats` | **对每个标签**扫一遍全部可见邮件，内层还对每封邮件扫一遍它的标签 | 比上面更差 |
| `mailRailCounts` | **11 次**全量扫描 `visibleMailMessages`（每个侧栏项一次） | 11 × O(邮件) |
| `mailFolderTreeItems` | 重建整棵文件夹树 | O(文件夹) |
| `mailTaxonomyParentOptions` | 每个树节点跑一次祖先判断 | O(n²) 量级 |
| `trashMessageCount` | 又一次全量扫描 | O(邮件) |
| `filteredComposeEmojiCategories` | 遍历全部 emoji 分类，**表情面板关着也在跑** | O(emoji) |
| newsletter 订阅列表 | flatMap + 2 次 filter，**并且每次都给每个订阅新建对象** | O(订阅) |

**注意最后一条**：它每次渲染都产生新的对象引用，**这本身就会让任何下游 memo 失效**。这类「顺手 spread 一下」是 memo 的隐形杀手。

**依赖数组是核对过的，不是猜的**：`normalizeMailToken` / `buildMailTaxonomyFolderTree` / `isMailTaxonomyFolderDescendant` / `countUnreadVisibleMailMessagesForMailbox` / `filterVisibleMailMessagesForMailbox` 都是模块级函数（引用稳定，不用进依赖），所以真实依赖只有 `mailFolders` / `mailLabels` / `mailTaxonomyEditingId` / `visibleMailMessages` 这几个 state。

**刻意没有 memo 的**：`queueRailBadgeCount` / `agentRailBadgeCount` / `needsAttentionThreads` —— 都是对小数组的单次 filter，memo 的记账开销比省下的还多。**不要为了一致性把它们也包上。**

### 三段模式扩展到 flag / 永久删除（原优先级 C 的可做部分）

`plan_remote_flag_action` / `plan_permanent_delete_action` → `push_planned_remote_flag` → `persist_planned_remote_flag`。

- 计划对象 `RemoteFlagPlan` 是**不透明 struct**（字段私有，只能由 `plan_*` 构造），所以阶段顺序没法绕过。它带解密凭证，**故意没有 `Debug` derive**。
- 只有一条网络路径：计划里带一个 `PlannedLocalEffect`（`SetFlag` 或 `SoftDelete`），网络那段两种动作共用，落库那段分叉。
- 已改为持锁计划 → 放锁跑 IMAP → 重新取锁落库的命令：`message_set_local_flag`（read/starred）、`message_delete_forever`、**`message_empty_trash`**。
- `message_empty_trash` 这次是真修了根因，不只是逐个取锁：现在每封邮件的 IMAP 往返期间锁是**放开**的。语义没变（本来就无跨批事务，中途失败前面的删除照样已提交，注释里写明了）。

新增 3 个 Rust 测试。**其中 2 个验证过真能抓 bug**：把计划里的 folder 改成 `"WRONG"`、把删除的远端 flag 从 `Deleted` 改成 `Seen`，对应测试都失败了。

> **一个诚实的自我修正**：我最初给 flag 测试写了 `assert_eq!(after_plan, before_plan, "planning must not perform IMAP calls")`，还给测试起名 "defers every IMAP call"。这条断言是**假防线** —— `plan_remote_flag_action` 签名里根本没有 adapter，物理上发不出请求，断言永远真。已删掉并改名，函数文档里说明这条性质由签名保证。这正是第 3.3 节那个坑的复现，很容易再踩。

### verify 脚本的 `app` 已改成拼接（**解锁了抽组件**）

第 5 节第 3 条那个「JSX 一挪进组件就断」的坑，前置条件已经做好了。

`app` 现在是 `App.tsx` **加上 `src/components/*.tsx` 全部内容的拼接**，读取顺序固定（App.tsx 在前，其余按文件名排序），所以不依赖目录枚举顺序。目录不存在时返回空数组，不会抛。

- ✅ 保住了 941 个 `includes` + 7 个 `match` 计数 + 5 个 `split` 计数，**一条断言文本都没改**
- ✅ 已验证「没有 components 目录时是 no-op」
- ✅ 已验证「真的能读到组件文件」（放一个带 marker 的探针文件，确认 `app.includes(marker)` 为 true，然后删掉）

⚠️ **但那 9 个位置相关的检查仍然需要小心**，脚本里已经就地写了注释说明三个锚点组的构成。**锚点组可以整体搬进一个组件文件，不能拆散。** 拆散是**静默失效**：`indexOf` 返回 -1，而那些表达式写成 `x >= 0 ? ... : -1`，于是检查可能仍然通过但什么都没验证。**搬完 JSX 一定要故意破坏一次，确认检查真的会挂。**

#### ✅ 邮件列表卡片已抽出（2026-08-08，第一个真正跑通拼接门禁的抽取）

`src/components/MailConversationCard.tsx`：`React.memo` 组件 + `renderMailListStateRow`（本来就是纯函数）+ `useEventCallback`。`App.tsx` 11,105 → 11,059 行。

**踩到的两个真问题，接手方抽下一个组件时会再遇到：**

**1. 结构化类型会因为逆变而编译不过。** 我一开始在组件文件里自己定义了窄一点的 `SenderAvatarLike` 和 `MailCardConversation`，结果三个 `TS2322`：props 是**逆变**的，本地定义的窄类型会让**真实的** handler 和**真实的**头像组件都变成不可赋值（`MailConversationSummary` 少了 `starred`、`SenderAvatarDto` 少了 7 个字段）。

**正确做法：把调用方的类型作为泛型参数透传，不要在组件里重建。**

```ts
type Props<TConversation extends MailCardConversation<...>, TAvatar> = {
  conversation: TConversation;
  senderAvatar: TAvatar | null;
  AvatarComponent: AvatarComponentType<TAvatar>;
  onOpen: (conversation: TConversation) => void;
  onKeyDown: (event: {...}, message: TConversation["latestMessage"]) => void;
};
```

消息类型用 `TConversation["latestMessage"]` 索引出来，就不用多加一个泛型参数。

**2. `SenderAvatarIcon` 作为 prop 传，不要搬。** 它是模块级声明，**引用天然稳定**，不会破坏 memo；而搬它要连带 `resolveSenderAvatar` / `senderAvatarClassByKind` / 2 个类型，**分散在 3 处约 180 行**。同理 `formatMailListTime` 也是 prop 传进去的（它依赖 `padDatePart` + `parseVisibleMailMessageDate`，搬动会牵一条链）。

> **组件文件绝对不能 import `App.tsx`** —— `App.tsx` 要 import 组件，反向 import 就是循环。这是"传 prop 而不是搬过去"的根本原因。

**3. handler 稳定化用的是 latest-ref**（`useEventCallback`，就在组件文件里）。`App()` 里 4 个 handler 现在包成 `onCardOpen` / `onCardKeyDown` / `onCardAvatarClick` / `onCardToggleSelected`。没有逐个 `useCallback` 是因为 `openMailConversation` → `openMailMessage` → 另外 4 个函数那条链太深。

**验证保住了原样式**：把原 JSX 块和新组件的 `className` / `role` / `aria-*` 属性集合做 diff —— 原来 12 个全在，多出来的 5 个正好是 `renderMailListStateRow` 的 chip。

#### ⚠️ 但顺带证实了门禁的一个真实弱点（**没修，故意的**）

按第 5 节自己写的规矩"搬完 JSX 要故意破坏一次确认检查会挂"，我照做了 —— **结果检查没挂**。

原因：`<section className="nt-list-pane">` 在 `App.tsx` 里**出现两次**（9634 和 10297）。把第一个（真正属于 `nt-mail-adaptive` 网格的那个）改名后，`indexOf` 直接找到第二个，而它仍然排在 toolbar 之后，于是那条顺序断言**静默改了目标、继续通过**。

已确认当前绑定的确实是**正确的那个**（9634），顺序也是真的对。但**门禁不会注意到这一点何时不再成立**。

**所以：这里跑绿不等于邮件布局顺序没坏。** 脚本里已就地写了注释。没有顺手"加强"它，因为那会改动断言行为，属于要单独决策的事。

#### 抽下一个组件的建议目标

阅读窗格（`<article className="nt-reading-pane">`）是**锚点组 2 的整体**，可以整体搬（它内部 3 个定位目标会一起走，相对顺序不变）。但它比卡片大得多，而且 `srcDoc` iframe 那两处在里面（见第 7 节的 sandbox 结论，别顺手改 sandbox 串）。



最高价值的目标是**邮件列表卡片**（`App.tsx` 里 `paginatedDisplayedMailConversations.map(...)` 那段，约 70 行 JSX）：一页渲染 20 个，任意输入框敲一个字符全部重渲染。

做法和坑：

1. 卡片抽成 `React.memo` 组件放进 `src/components/`。**它不在任何锚点组里**（锚点组 1 定位的是 `<section className="nt-list-pane">` 本身，卡片在它内部），所以搬动安全。
2. ⚠️ **`memo` 只有在 props 引用稳定时才有用。** 卡片要的 4 个 handler（`openMailConversation` / `openMailMessageFromKeyboard` / `openAvatarEditor` / 勾选切换）现在都是 `App()` 里的普通函数声明，**每次渲染都是新引用，会直接让 `memo` 失效**。
3. 那条 handler 链很深（`openMailConversation` → `openMailMessage` → 另外 4 个函数），**逐个 `useCallback` 会波及一大片**。推荐用 latest-ref 模式（`useRef` + `useLayoutEffect` 更新 + `useCallback` 包一层读 ref）：拿到稳定引用，又不用动整条链。这对事件 handler 是正确的，因为它们在渲染之后才执行，取最新闭包正是想要的行为。**不要用它包渲染期间就要执行的东西。**
4. `SenderAvatarIcon` 目前在 `App.tsx` 里，且依赖 `resolveSenderAvatar` / `senderAvatarClassByKind` / 两个类型，**分散在 3 处、约 180 行**。卡片需要它。两个选择：一起搬（干净但改动大），或者**作为 prop 传进去**（它是模块级声明，引用天然稳定，不会破坏 memo）。后者改动小得多。
5. **验证 memo 真的生效**：在卡片里临时放 `console.count("card")`，在写信主题框里敲字。`card` **不应该**增长。确认后删掉。

> ⚠️ **前车之鉴**：上一轮尝试抽这个卡片时留下了一个 `src/mail/MailConversationCard.tsx`，它 import 了一个不存在的模块，**把 `tsc` 弄成红的**，而且没有任何东西引用它。已删除。**抽组件时先让新文件能编译再去改 `App.tsx`，别两头都开着口子。**

### verify 脚本的 CSS 匹配已改成空白归一化（**解锁了前端 formatter**）

第 5 节第 1 条那个"288 个 `css.includes()` 内嵌精确空白"的坑，**已经修掉了**，而且**一条断言文本都没改**。

做法：`css` 不再是字符串，而是一个包装对象（`scripts/verify-neuroterminal-ui.mjs` 顶部的 `whitespaceTolerantCss`）：

- `.includes(needle)` —— 把源和 needle 各自 `replace(/\s+/g, " ")` 后再比。所以缩进、换行、声明换行位置都不再影响结果。
- `.indexOf()` / `.slice()` —— **仍然走原始字符串**，因为 `cssBlock` / `cssBlockAfter` 的字节偏移锚点依赖精确位置。
- `cssBlock` / `cssBlockAfter` 现在基于 `cssRaw` 定位，返回值也包一层，所以那 37 个 `xxxCssBlock.includes()` 同样获得容错。

**实测确认（两个方向都验过）**：

| 场景 | 容错关闭（同一脚本，只把 `collapseWhitespace` 改成恒等函数） | 容错开启 |
|---|---|---|
| 把 `.nt-mail-adaptive` 重排成 4 空格缩进 + 两条声明并一行 | **3 条断言失败** | 通过 |
| 真删掉 `display: grid` | 3 条断言失败 | **3 条断言失败**（门禁没被削弱） |

`App.css` 已还原，`diff` 确认与测试前逐字节一致。

**这意味着什么**：现在可以给 `App.css` 上 formatter 了。**但拆成多个 CSS 模块仍然不行** —— 288 条断言读的是同一个 `cssRaw`，拆文件要先让它读多模块的拼接结果。那是下一步。

### `vite.config.ts` 补了 `build` 块

`target: "chrome105"`（唯一消费者是打包进去的 WebView2，没有旧浏览器要兼容）、`sourcemap: true`（桌面应用，map 留在本机不外发；没有它生产堆栈只有 minify 后的符号）。产物 map 约 1.6 MB。

**没加 `@/` 别名** —— 它要同时配 vite 和 `tsconfig.json` 的 `paths`，而现在没有任何 import 用得上，加了就是死配置。等真开始拆文件、有 import 要改的时候再加。

### 迁移 runner 改成表驱动，并修了一个真实的原子性缺陷

9 段复制粘贴的 `query_row(EXISTS)` + `execute_batch` + `INSERT`（约 155 行）收成一张 `MIGRATIONS` 表（`version` / `name` / `apply` 函数指针）加约 20 行循环。**加迁移现在是加一行表项。**

- 0008 那个"库里可能已经有 `parent_id`"的特判抽成了具名函数 `apply_mail_taxonomy_parent`，逻辑没动。
- **修掉的真实缺陷**：每个迁移的 DDL 和它的 `schema_migrations` 记录行现在在**同一个事务**里提交。之前 `execute_batch` 中途失败会留下改了一半的 schema 而版本号没记上，下次启动重跑 —— 对 `CREATE ... IF NOT EXISTS` 无害，但 **0007 是 `DELETE`**，那种就不是幂等的了。
- 已确认迁移 SQL 里没有自己的 `BEGIN` / `COMMIT` / `PRAGMA`（会和外层事务冲突），所以包事务是安全的。用 `unchecked_transaction()` 是因为签名是 `&Connection`，且迁移跑在任何其他事务之前。

新增 2 个测试（**都做过变异验证**）：

- `upgrading_from_version_7_preserves_existing_taxonomy_rows` —— 用新的 `run_migrations_through(connection, 7)` 造一个"旧版本的库"，插两行 taxonomy，再升到最新，断言行还在、值没变、`parent_id` 为 NULL。**这填的正是第 7 节"迁移没测过从旧版本已有数据升级"那个洞。** 变异验证：在 0008 前面插一句 `DELETE FROM mail_taxonomy_items` → 测试失败（`QueryReturnedNoRows`）。
- `a_failing_migration_records_no_version_and_leaves_no_schema_change` —— 断言回滚后建的表不留、版本不记。

---

## 4. 开发目标（按建议顺序）

### ~~优先级 A：前端重渲染~~ — 已完成，见 3.4

原 4.A 描述的拆分已落地。**剩余的前端重渲染工作**（190 个 `useState`、0 个 `useCallback`、296 个内联箭头 handler、3,927 行 JSX）仍未动，但那需要先解决第 5 节的 verify 脚本问题才能安全抽组件。

拆分时踩实的 verify 脚本约束（**别再自己踩一遍**）：

- `verify:377` 要求字面量 `} = useMemo(() => {`，以及 `const displayedMailMessages = sortMailListMessages(` 和 `const displayedMailConversations = buildMailConversations(` 的**原样赋值形式**
- `verify:386` 要求字面量 `displayedMailMessageKey = displayedMailConversationMessages`
- `verify:376` 要求 `displayedMailMessages.find((message) => message.message_id === messageId)` 原样存在（所以选择态 memo 必须保留这个写法）
- `verify:382/383` 要求 `paginatedDisplayedMailMessages`、`mailListTotalPages`、`mailListPageStart`、`mailListPageEnd`、`paginatedDisplayedMailConversations` 等名字在 `App.tsx` 里出现 —— 解构出来就满足，计算搬到别的文件没问题

### 优先级 B：`normal_account_sync_recent`（需要先定架构，别做一半）

**不适用三段模式。** 它的形状是交错的：

```
读库 → (ensure_sync_folder: 网络+写) → (sync_recent_header_folders: 网络+写)
     → [抓 headers → 落库] × N 个文件夹 → 分类 + 标记成功
```

要让它不持锁，service 内部就得多次取锁，也就是签名从 `&Connection` 改成 `&Mutex<Connection>`，或者引入 `r2d2_sqlite` 连接池（WAL 已开，两条路都用得上）。**这条路上挂着约 21 个测试。这种事做一半比不做更糟。**

**动手前先定死架构选型（`&Mutex<Connection>` vs 连接池），写进文档再改代码。**

#### ⚠️ 实测规模（2026-08-08 补，纠正上面「约 21 个测试」的说法）

用 `grep -c` 数过（不是估计）：

| 指标 | 数量 |
|---|---|
| `connection: &Connection` 签名点 | **71** |
| `&connection` / `connection,` 调用点 | **486** |
| 涉及文件 | **23** |

**之前「约 21 个测试」只统计了 `normal_account_service.rs` 一个文件。** 真实范围是贯穿 `storage/` → `services/` → `workers/` → `commands.rs` 的**主干重构**，比原估计大一个数量级。

**另外两个前置阻碍**：

1. `app_state.rs` 目前**有别人未提交的改动**（2026-08-07 批次），而它正是要改的文件之一。在它上面动手会让两份 diff 互相缠住，谁都没法干净 review 或回滚。**先让那批工作落地。**
2. 连接池路线**在这台机器上未必可行**：`r2d2_sqlite` 不在本地 cargo 缓存里，要联网拉，且必须找到与 **`rusqlite` 0.40**（较新）兼容的版本。**如果不能联网，连接池路线直接出局**，只剩 `&Mutex<Connection>`。

#### 但这个「全或无」是可以避免的（推荐做法）

不要直接改 71 个签名。改成**可分批**：

> 在 `AppState` 上加一个取连接的方法（例如 `with_connection(|conn| ...)`），**新代码走它，现有 `&Connection` 代码原样不动**，然后逐个命令迁移。每迁一个都能跑 `cargo test` 保持绿色。

这样就没有「`cargo test` 从第一个签名改动起一路红到最后一个测试修完」的窗口。**那个窗口正是「别做一半」的具体含义** —— 一旦中途有编辑静默丢失，红色构建和真实类型错误无法区分。

#### 而且这个重构可能根本不必要

三段模式已经在**不改任何签名**的前提下覆盖了 flag 和永久删除。剩下 3 个 handler 只被 `resolve_target_folder` 一个函数挡着（见 4.C），**只修那一个函数比为它重构整条主干小得多**。

**4.C 已经用回退方案解决了，所以现在没有任何东西在等 B。**

B 剩下的价值只有一条：**去掉全局串行化本身**（现在 55 个命令仍然共用一把锁，只是不再跨网络 I/O 持有它）。这在真机上是否还是瓶颈**没有测过** —— 无锁化之后锁的持有时间已经短得多了。**建议先测量再决定要不要动这个主干重构。**

### ~~优先级 C：`apply_normal_message_action`~~ — **已全部完成（2026-08-08）**

**6 个 handler 全部拆完了**，都不再在网络 I/O 期间持有全局锁：

| handler | 命令入口 | 走的模式 |
|---|---|---|
| SetRead / SetStarred | `message_set_local_flag` | `plan_remote_flag_action` 三段 |
| DeleteForever | `message_delete_forever` / `message_empty_trash` | `plan_permanent_delete_action` 三段 |
| MoveTo | `message_set_local_folder` | `plan_move_action` 三段 |
| Delete | 同上（内部委托给 move） | 同上 |
| SetArchived | `message_set_local_flag` | `plan_archive_action` 三段（复用 move 机制） |

**关键设计：`resolve_target_folder` 那个交错形状没有被"修掉"，而是被绕开了。**

`plan_move_action` / `plan_archive_action` 只从**本地文件夹缓存**解析目标。解析成功 → 走无锁三段。解析不到 → 返回 `MovePlan::RequiresLockedFallback`，命令层**委托给原来那个全程持锁的函数，行为一字不改**。

这样就同时拿到了两件事：

- 常见路径（已同步账号）无锁 —— 由 `move_action_on_a_synced_account_resolves_the_target_folder_without_discovery` 证明这确实是常见路径
- 罕见路径（目标未缓存）行为不变 —— **没有引入之前担心的"静默降级成只改本地"**

`PlannedMove` 带一个 `PlannedMoveEffect`（`SetFolder` 或 `SetArchived`），所以 move 和 archive **共用同一条网络路径**，只在落库那一步分叉。

⚠️ `PlannedMove` 带解密凭证，**故意没有 `Debug` derive**。`MovePlan` 的字段是私有的，只能由 `plan_*` 构造，所以阶段顺序绕不过去。

Rust 测试 189 → 195（move 3 个 + archive 3 个，其中 2 个做过变异验证：把 plan 里的目标 folder 改成 `"WRONG"` / 把 archive 的 folder kind 改成 `"trash"`，对应断言都失败）。

#### 下面这一整节是历史记录，说明当初为什么以为它被 B 挡住

（保留是因为那个"交错形状"的分析本身仍然正确，只是结论——必须先做 B——是错的。）

**剩下 3 个（SetArchived / MoveTo / Delete）不适用三段模式**，原因已查证：它们都要走 `resolve_target_folder`（`normal_account_service.rs:935`），而那个函数的形状是

```
list_mail_folders_for_source(读库) → 命中就返回
                                  ↓ 未命中
adapter.discover_folders(网络) → upsert_mail_folder × N(写库) → 再读一次库
```

**这是和优先级 B 完全相同的交错形状**，中间那段网络调用被夹在两次数据库访问之间。要让它放锁，同样需要 service 内部多次取锁 —— 也就是先做完 B 的架构选型。

**不要强行拆**：那会得到一个"计划阶段里还藏着网络调用"的假三段，比不拆更有害（读代码的人会以为锁已经放开了）。

#### 小解法（比等 B 便宜得多，但有一个坑，见下）

`resolve_target_folder` 的范围其实很小：**1 处定义 + 3 处调用，全在同一个文件里**（`normal_account_service.rs`，分别服务 archive / trash / move）。

思路：**把「未命中就联网发现」那段挪到同步阶段**，让 `resolve_target_folder` 退化成纯读库（只 `list_mail_folders_for_source` + `find_folder_for_kind`，找不到就返回 `None`）。这样三个 handler 的计划阶段就是纯读，三段模式直接适用，**完全不用动后端主干**。

#### ⚠️ 但先读这个：那条 fallback 分支目前是零测试覆盖

实测数字：

| | 次数 |
|---|---|
| 测试里 `with_folders(test_remote_folders())`（预置文件夹 → 走缓存命中） | **14** |
| service 测试里出现 `discover_folders` | **0** |

**也就是说现有 archive / move / delete 测试全部走缓存命中分支，那条"未命中就联网发现"的 fallback 从来没被执行过。**

#### ✅ 上面这条已经用测试确认了（2026-08-08）

给 `FakeImapAdapter` 加了一个**独立计数器** `discover_folders_call_count()`（**不是**往 `actions` 里记）。这个设计选择很重要：我先试过加 `FakeImapAction::DiscoverFolders` 变体并在 `discover_folders` 里记一笔，结果**10 个既有测试当场挂掉** —— 因为同步阶段本身就会发现文件夹，记到共享的 actions 向量里会污染一堆和"文件夹发现"毫无关系的断言。独立计数器是纯增量的，零影响。

新测试 `move_action_on_a_synced_account_resolves_the_target_folder_without_discovery` 确认了实际行为：

> **`with_folders()` 只提供"发现会返回什么"，并不填充本地文件夹缓存。缓存是 `sync_recent_headers` 填的**（它会把发现到的文件夹 upsert 进库）。所以对**已同步过的账号**，move 动作是从缓存解析的，**动作本身完全不碰网络**。

已做变异验证：把 `find_folder_for_kind` 换成 `None` 强制绕过缓存 → 测试失败（`left: 2, right: 1`）。

**这对重构决策的意义**：

- ✅ **已同步账号这条路上，纯读改造是安全的** —— 现在有测试钉住了。
- ⚠️ **真正的风险面收窄到「从未同步过文件夹的账号」**。那种情况下缓存是空的，纯读会返回 `None`。**这一条仍然没有测试覆盖**，因为构造它需要一个有 IMAP source 但从未同步过文件夹的消息。

#### ✅ `None` 的下游行为也确认了（2026-08-08）

查过两个调用点（`normal_account_service.rs:733` archive、`:827` move/trash），**形状完全相同**：

```rust
let remote_applied = if let Some(target_folder) = resolve_target_folder(...)? {
    if target_folder.path != context.folder_path { /* move + 记远端文件夹 */ true } else { false }
} else {
    false            // ← 解析不出来就走这里
};
// 无论哪条分支，本地状态照样改
```

**结论：`None` 不报错，而是降级成"只改本地"。**

新测试 `move_action_degrades_to_local_only_when_the_target_folder_does_not_exist_remotely` 钉住了这个行为（用一个只有 INBOX 的假服务器，move 到 spam）：`remote_applied == false`、**一条 `Move` 都没发**、但**本地 `local_folder` 仍然变成了 `spam`**。

已验证不是空断言：给那个假服务器加上 Spam 文件夹 → 测试失败。

#### 这对纯读改造的最终结论

| | 结论 |
|---|---|
| 已同步账号、目标文件夹已缓存 | ✅ 纯读安全，有测试钉住 |
| 目标文件夹解析不出来 | ⚠️ **不会报错，会静默降级成只改本地** |

**所以纯读改造技术上可行，但它的失败模式是「本地和服务器状态静默分叉」** —— 用户看到邮件进了 spam，服务器上其实没动，而且没有任何提示。

**因此纯读改造的前提是：让同步阶段保证把所有会用到的目标文件夹（archive / spam / trash）都缓存进库**，否则就是把"慢但正确"换成"快但静默错"。这一条现在有两个测试兜底，可以放心动手了。

**顺带发现的既有问题**（不是这轮引入的，也没修）：上面那个降级路径本身就是个可疑设计 —— 本地移动成功、远端静默不动、`remote_applied: false` 但调用方没有任何地方把这个 false 呈现给用户。值得单独确认一下 UI 是否该提示。

后果：改成纯读后，**「从未同步过文件夹的账号」会从「能用（联网兜底把文件夹建出来）」变成「返回 `None`」**，而 187 个测试**一个都不会挂**。这个改动看起来安全，实际上是在删一条没有测试保护的可用路径。

**所以正确顺序是**：

1. 先给那条 fallback 分支补测试（确认它现在做什么）
2. 再确认 `None` 在 3 个调用点各自的下游行为（报错？降级？静默失败？）
3. 最后才改

**补测试本身有个前置障碍**（已查证）：`FakeImapAction` 只有 `Move` 和 `SetFlag` 两个变体，而 `imap/fake.rs` 里的 `discover_folders` **实现了但不记录调用**。要断言"确实发生了文件夹发现"，得先给那个 enum 加一个 `DiscoverFolders` 变体并在 `discover_folders` 里记一笔 —— 那是**改动既有 enum 的结构性编辑**，不是纯加测试。

### 其他已知项

- **IMAP socket 超时无法快修（已查证，不是猜测）**：翻过 `~/.cargo/registry` 里 `imap` 3.0.0-alpha.15 的 `ClientBuilder`，只暴露 `new` / `mode` / `tls_kind` / `danger_skip_tls_verify` / `connect`，**没有超时 setter**。要加就得手搓 `TcpStream` + TLS 栈，有搞坏 STARTTLS 的风险。现状：挂死的服务器会无限期占着全局锁。
- **列表查询没有 `LIMIT`**：整个账号的历史邮件一次进内存，然后在 Rust 里重排一遍。⚠️ `observed_at` 是**跨表 `COALESCE` 别名**，任何索引都救不了那个 `ORDER BY`。真要修得把时间戳改成 epoch 整数存（现在是 RFC3339 文本，按字符串比大小是错的，这也正是 Rust 侧重排的原因）。
- **`commands.rs` 越层**：16 个 `use crate::storage::*`，直接调 repository 绕过 service。`mail_taxonomy_update` / `mail_taxonomy_delete` 最典型（自己开事务 + 校验 + 编排 3–4 个 repository）。可按域拆成 `commands/{message,taxonomy,avatar,account,temp,agent,send,settings}.rs`，域边界已经很干净。
- **迁移 runner 是手写的**：9 段复制粘贴的 `query_row(EXISTS)` + `execute_batch`。加一个迁移就再粘 15 行。可收成表驱动循环。
- **前端零 lint / 零 formatter**：`tsc` 是 12k 行 TS/TSX 唯一的静态门禁。`tsconfig.json` 缺 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`；`skipLibCheck: true` 掩盖 React 19 类型漂移；`tsconfig.node.json` 没开 `strict`。**但装 formatter 前必须先解决第 5 节的问题**。
- **`vite.config.ts` 没有 `build` 块**：缺 `target`（Tauri 桌面应用可以设很高）、`sourcemap`（生产堆栈现在没法用）、`@/` 别名（拆文件时会省大量 import 改动）。
- **`App.css`**：`#111821` 硬编码 59 次，尽管它已经是 `--nt-graphite` token；`#ffffff` 72 次、`#6d4aff` 37 次。59 个 `!important` 集中在两个尾部覆盖层（`App.css:6579` 和 `:7001`，约 890 行在和前面的规则打架）。约 26 个死类名。选择器深度反而健康（无 4+ 复合选择器）。
- **34 个命令仍用裸 `invoke()`**，61 个调用点。`message_list` 的请求字面量手写了 10 次。

---

## 5. ⚠️ 最大的坑：`scripts/verify-neuroterminal-ui.mjs`

**这是本项目最容易让你白干一轮的地方。动 CSS 或抽组件前必读。**

404 行，243 个布尔断言，纯 `readFileSync` + `String.includes()` / 正则扫 34 个文件（TSX、CSS、20 个 Rust 文件、`tauri.conf.json`、`README.md`、`index.html`、SVG）。**它断言的是源码拼写，不是行为。**

具体脆弱点，按严重度：

1. ~~**288 个 `css.includes()` 内嵌精确空白字符**~~ —— **空白部分已修（见 3.4 节）**，`css` 现在是空白归一化的包装对象，跑 formatter / 改缩进 / 重排声明都不会再挂，且门禁强度未削弱（两个方向都做过实测）。
   ⚠️ **但"拆 CSS 成模块"这一条仍然成立**：288 条断言读的都是同一个 `cssRaw` 字符串，拆文件依然会一次性全挂。要拆得先让脚本读多个 CSS 模块的**拼接结果**。

2. **字节偏移锚点**。`cssBlockAfter` 用 `.nt-mail-layout` 的偏移量定位 `.nt-list-pane`（`verify:65`）—— 而 `.nt-mail-layout` **本身已经是死类名**，删掉它会静默改变被检查的目标。`mailReadingPaneCssBlock` 锚在毫不相关的 `.nt-copy-toast--error` 之后（`verify:66`）。

3. **file-order `indexOf` 链**（`verify:97-123`）要求 `nt-proton-message-header` 在文件里出现在 `nt-reading-pane` **之后**；末尾还在某处之后切一个**固定 1800 字符**的窗口再搜。JSX 一挪进组件就断。

   **抽组件前必读 —— 已实测的锚点组约束**：`app` 上共 962 次调用，其中 **953 次（`includes` / `match` / `split`）对"拼接多文件"是安全的**，只有 **9 次位置相关**（8 个 `indexOf` + 1 个 `slice`）需要小心。这 9 次构成**三个自包含的锚点组**：

   | 锚点组 | 组内相对定位的目标 |
   |---|---|
   | `className={\`nt-mail-adaptive ${` | `nt-mail-list-toolbar`、`<section className="nt-list-pane">` |
   | `<article className="nt-reading-pane">` | `nt-proton-message-header`、`nt-proton-header-navigation`、`nt-proton-message-body-wrap` |
   | `className="nt-compose-schedule-popover"` | 其后固定 1800 字符窗口 |

   **规则：整个锚点组可以整体搬进一个组件文件，但绝不能拆散到多个文件。** 因为拼接只保证「文件内部相对顺序不变」。

   ⚠️ **拆散锚点组不是"失败"，是"静默失效"**：`indexOf(needle, fromIndex)` 找不到会返回 `-1`，而那些检查写成 `x >= 0 ? ... : -1`，于是断言可能**仍然为真但什么都没检查**。所以改完必须验证：故意破坏一次，确认它真的会挂。

   **拼接顺序必须确定**（建议 `App.tsx` 在前，其余组件文件按文件名排序），否则不同机器 / 不同文件系统枚举顺序会给出不同结果。

4. **12 个精确计数断言**。`getPlatformAccountSession()` 必须恰好出现 **3 次**（`verify:248`）；`listNewsletterSubscriptions(` 恰好 2 次、`setNewsletterSubscriptionHidden(` 恰好 1 次（`verify:247`）。抽 hook 导致调用次数变化就挂，**即使那是改进**。

5. **165 个否定断言**禁止旧字符串，让它变成棘轮。重新引入一个不相关的同名类也会触发。

6. **单条断言最长 2,409 字符**（`verify:171`）的 AND 链，混着 CSS 空白字面量、中文 UI 文案、Rust 命令名、迁移 SQL。挂了只给一行不透明描述，**不告诉你是 ~40 个合取项里哪一个断的**。

**建议**：在拆 CSS 或抽组件之前，先把这些改成 DOM / 行为断言。~~至少把 CSS 匹配改成空白归一化~~（这一步已完成），**下一步是让它读新 CSS 模块的拼接结果**。

**改这个脚本的可复用手法**（这次实测有效）：不要去改那 243 条断言的文本，而是**改被断言的那个值是什么**。把 `css` 从字符串换成一个自定义 `includes` 的对象，一次性给全部 288 条断言加上容错，断言一个字没动。同样的手法可以用在 `app`（`App.tsx`）上来解决抽组件的问题 —— 让 `app` 变成"App.tsx 加上所有抽出组件的拼接"，那 file-order `indexOf` 链和固定窗口切片就能继续成立。

**改完务必两个方向都验**：关掉容错确认原本会挂（证明改动有效），再手动引入一个真实回归确认还会挂（证明门禁没被削弱）。只做前者会得到一个"通过但什么都不查"的假门禁。

**重要心态**：这里大规模失败 **≠** 你的重构错了。先判断是行为回归还是拼写断言被触发。

---

## 6. 项目的强项（别顺手"优化"掉）

- **错误处理是最强的部分**。`AppError`（`error.rs:45-56`）带 `code` / `category`（9 种）/ `user_message` / `technical_message` / `retryable` / `action_required`（8 种）/ `correlation_id` / `metadata`。`to_dto()` 会把 `metadata` 过 `redaction::redact_json`，并有测试断言 `password` 键变成 `[REDACTED]`。命令路径基本无 panic 风险（我逐个查过 6 个大文件里所有非测试的 `unwrap`/`expect`/`panic!`）。
- **约 200 个 Rust 测试**，fake adapter 设计让 service 测试跑的是真实逻辑。
- **`App.tsx` 类型纪律很好**：零 `: any`、零 `as any`、零 `@ts-ignore`、零 `eslint-disable`。
- **CSS 选择器深度健康**：1,306 个选择器实例里 858 个单段、419 个两段、29 个三段、**0 个 4+ 段**。

---

## 7. 没验证过的事（别当成已知事实转述）

- **性能收益没有真机基准**。我验证了索引被规划器选中、事务边界正确、测试通过，但**没有拿真实邮箱测过**。"同步快了多少倍"这种数字给不出来。收益是结构性推断（去掉每语句 fsync、去掉全表扫），不是观测值。
- ~~**iframe `sandbox` 属性没确认**~~ —— **已核实（2026-08-08），结论是安全的**。两处 iframe（`App.tsx:10161` / `10184`）都有
  `sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"`。**关键是 `allow-scripts` 不在里面**，所以远端邮件里的 JS 根本不执行，原先担心的提权路径不成立。
  `allow-same-origin` **是必需的、不能删**：`resizeMessageHtmlFrame`（`App.tsx:1289`）要读 `contentDocument` 量高度做自适应，删掉会退化成固定 760px（`catch` 分支）。
  ⚠️ **潜在风险（留给接手方判断，我没改）**：`allow-same-origin` 单独存在无害，但**一旦有人后续加上 `allow-scripts`，这两个组合起来就是完整逃逸路径**（脚本能碰父文档、进而碰 Tauri IPC）。要动这个 sandbox 串之前先想清楚这一点。另外 `srcDoc` 内容没有 CSP，远端图片会自动加载（跟踪像素）—— 那是"是否屏蔽远端图片"的产品决策，不是漏洞，我没擅自改。
- **测试覆盖空洞**：`storage/mail_folder_repository.rs` 完全无测试（文件夹解析喂给所有 sync 和 move 路径）；`storage/db.rs` 原本无测试（我加了 2 个）；`lib.rs` 的 55 项 `invoke_handler` 列表无测试（加命令忘注册会静默失败）；**并发场景零测试** —— 第 3.2 节那类缺陷对现有测试套件结构性不可见；迁移只测了全新库和重跑，**没测过从旧版本已有数据升级**（手写 runner 真正会炸的地方）。
- 前端测试只覆盖 `src/api/` 薄客户端和纯 selector，**无组件级 / 集成测试，无覆盖率工具**。

---

## 8. 工作区状态

> ⚠️ 本节描述的是 2026-08-07 那轮的状态。2026-08-08 这轮**又**改了 `src/App.tsx`、`package.json`、`src-tauri/src/commands.rs`、`src-tauri/src/services/normal_account_service.rs`，并新增 `src/mail/mailPagination.ts`、`tests/mailPagination.test.ts`。**全部仍未提交**，分支还是 `foundation`。

分支 `foundation`（主分支 `main`）。11 个文件有未提交改动：

**我改的（2026-08-07 两批优化）**：`src-tauri/src/avatar.rs`、`commands.rs`、`services/normal_account_service.rs`、`storage/db.rs`、`storage/message_repository.rs`、`storage/migrations.rs`

**接手前就已修改的（我没碰）**：`package.json`、`scripts/verify-neuroterminal-ui.mjs`、`src-tauri/src/app_state.rs`、`src/App.css`、`src/App.tsx`

未跟踪目录：`artifacts/`、`src/api/`、`src/compose/`、`src/mail/`、`tests/`、两个 `docs/superpowers/` 文档。

`.gitignore` 配得很好，根目录约 40 个截图 PNG、`dist/`、`.tmp/`、`.codex-temp/`、日志全部已忽略且未跟踪（只跟踪 121 个文件）。`artifacts/reverted/2026-08-07-db-perf-batch.patch` 是我留的一份备份 patch，无害，可删。

### 关于既有拆分计划

`docs/superpowers/plans/2026-07-24-frontend-decomposition.md` 记录了 9 个批次的抽取，把 `App.tsx` 从 11,699 减到 11,062 —— **9 批只减 637 行**，每批还要跑完整 release build + CDP smoke。

**按这个速率拆不完 9,390 行的组件体。** 接手方要么大幅降低每批的仪式感，要么换思路。别照抄那个节奏。

---

## 9. 第一步做什么

```bash
npm run verify   # 先确认基线还是绿的，再动任何代码
```

预期基线：**50 前端测试 + 195 Rust 测试 + ui:verify + build + fmt + check 全绿**。

然后按价值/风险选一条：

1. **上前端 formatter**（现在解锁了，见 3.4）。`App.css` 的空白已经不再被断言锁住，Prettier 可以直接跑。跑完立刻 `npm run ui:verify` 确认 —— 预期通过，如果挂了那是真回归不是拼写断言。**这条现在是性价比最高的**：它顺带让 `#111821` → `--nt-graphite` 那类 token 清理变得可做（token 替换本身仍受断言约束，但不再叠加空白脆弱性）。
2. **让 verify 的 `app` 变成拼接结果**（手法见第 5 节末尾）。这是抽组件的前置条件，也是拆 `commands.rs` 的前置条件 —— **实测确认**：脚本把 `commands.rs` 当单文件读，有 32 条 `commands.includes()`，按域拆会一次性全挂。
3. **优先级 B 的架构选型**（`&Mutex<Connection>` vs `r2d2_sqlite` 连接池）。剩下最大的一块后端工作。~~并且挡着优先级 C 剩下的 3 个 handler~~ —— **这条不再成立**，优先级 C 已用回退方案全部完成（见 4.C）。**现在没有任何东西在等 B，动手前先测量它是否还是瓶颈。**

⚠️ **注意 `#111821` → token 那条的真实约束**（我评估过没做）：59 处里约 47 处落在 verify 的多行 CSS 字面量里。空白已经不是问题了，但**断言仍然逐字匹配 `#111821` 这个色值本身** —— 换成 `var(--nt-graphite)` 会让那些断言挂，而门禁分不清"正确的 token 替换"和"写错的颜色"。所以要么同步改断言文本，要么等断言改成 DOM/计算样式断言。

第 7 节的 iframe `sandbox` 疑问已核实完毕，不再是待办。
