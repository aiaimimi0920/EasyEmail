# Cloudflare 自动分配与供应商冷却切片

本切片是 M3g 的本地实现合同，不代表真实供应商、真实投递或整个迁移完成。
原目录与现行部署继续独立运行，本轮不导入生产数据、不切流、不发布。

## 1. 创建请求与权限

`POST /api/v1/mailboxes` 继续接受原手动请求：

```json
{"providerId":"self","domain":"cf.example.test"}
```

新增显式自动选择，可省略域名或指定可用域名：

```json
{"selection":"automatic","domain":"temp.example.test"}
```

自动请求不接受 `providerId`、地址或 endpoint 等额外字段。M3g 本身仅随机命名，
后续 M3l 已增加可选 `prefix`，真实能力预检及精确创建边界见[自定义前缀切片](cloudflare-custom-prefix-slice.md)。
继续要求 `mailboxes:write`、当前用户归属、Cookie 写操作 Origin 校验、
有效 `Idempotency-Key`、请求限流及原子用户分配配额。
只读 API Key 不能创建邮箱，管理员身份也不代替普通资源的归属校验。

手动请求哈希仍使用旧的 `[providerId, domain]` 形式；自动请求使用独立对象形式。
已有幂等记录优先回放，不受当前供应商停用、凭据清除或分配冷却影响。
同键不同请求返回 `idempotency_conflict`，不会把旧记录用于新分配。

## 2. 选择、预检与唯一写入

1. 从启用、已声明配置凭据且域名条件匹配的实例中排除冷却实例。
2. 按持久化 `allocation_count` 较少优先，再按实例 ID 排序。
3. 自动选择最多对 3 个候选执行只读域名预检，网络总 deadline 为 8 秒，
   单候选为 2.5 秒；不承诺包含所有数据库及运行时开销的 HTTP 总时长。
4. 自营 Cloudflare 的域名来自部署配置，并非实时远端探测；
   Temporam 使用真实域名 GET 合同。域名结果继续受平台配置限制。
5. 预检失败可跳过该候选；获得创建 guard 后，只向选定供应商 dispatch 一次。
   创建有独立的 15 秒网络 signal，不复用已经消耗的预检 deadline。

创建 guard、所选供应商元数据及分配计数递增位于同一 D1 batch。
guard 同时校验供应商 revision、平台保留策略 revision 和当前冷却状态。
本地事务失败时不 dispatch 远端创建，也不将存储错误记作供应商故障。

计数从本功能启用后开始，包含已保留 guard 的未知结果，不追溯旧分配。
它是 best-effort 均衡，不是严格并发轮询；并发请求仍可能选择同一实例。
自动选择仅作用于新创建，绝不替换已有邮箱的地址、供应商或访问凭据。

## 3. 固定冷却与观测顺序

复用 `service/base/src/service/outcome-policy.ts` 的纯业务冷却规则，
不迁入 Node 后台循环或文件快照。

| 结构化供应商错误 | 冷却 |
| --- | ---: |
| `provider_rate_limited` | 45 分钟 |
| `provider_auth_failed` | 90 分钟 |
| `provider_timeout`、`provider_unavailable` | 15 分钟 |
| 非法响应、响应过大、收件人或域名不匹配 | 5 分钟 |

仅平台分配预检、创建及管理员显式探测可更新供应商分配观测。
单个邮箱 JWT 的同步失败、发送失败、用户参数错误及本地存储错误不污染全局冷却。
成功观测清除失败计数及冷却；失败观测不会缩短当前已有的冷却截止时间。
失败计数是已采纳的观测数，不承诺等于所有并发失败请求的总数。

每次操作先领取单调递增的 `operation_sequence` 票据；结果仅在配置 revision/hash
仍匹配、且票据新于 `observation_version` 时落库。配置切换推进版本，
旧成功不能清除较新失败，旧失败也不能覆盖较新成功。
较晚开始但较晚完成的探测，仍可覆盖先完成的较早创建结果。
管理员观测另受当前管理员授权的事务 fence 约束。

管理员可显式探测冷却中的实例；探测成功可恢复后续新分配，
不代表真实投递正常，也不会重试任何已有的 unknown 创建。
当前不是可编辑冷却策略、自动恢复探测器或持久化后台调度队列。

## 4. 不确定结果与页面

上游写入超时、非法响应或写后存储失败均保留 `pending/unknown` guard，
返回 `202` 与 `retrySafe:false`。再次使用原键只核对原结果，
不会更换供应商、重新创建或自动消费另一个邮箱。
并发同键请求中，较晚预检失败会再次查询已经获胜的 guard，再返回原结果。

Web 默认仍为手动选择，新增自动分配、可选域名及状态刷新。
普通导航保留未决请求的方式、内容和键；供应商全部停用后仍可核对原键。
`GET /providers` 提供 `allocationSelection` 与安全的 `allocation` 状态，
不返回 endpoint、密钥、配置 hash 或平台分配计数。
管理页可见分配冷却、脱敏错误及已采纳失败数，停用与未配置不会显示为可选。

M3g 本身不包含持久化历史。后续 M3h 已增加历史查询、刷新恢复和显式风险确认后另起分配，
详见 [创建历史切片](cloudflare-creation-slice.md)。确认不解决 unknown、不删除 guard，
也不是远端资源自动对账或认领；没有落库 guard 的原始页面请求仍不能跨刷新恢复。

## 5. 升级与回退边界

新增 `0009_allocation_selection.sql`，不修改 0001–0008。
旧创建记录新增的供应商元数据为 NULL，不猜测历史 unknown 的供应商。
升级保留用户、会话、邮箱、全部旧创建列、平台保留配置和维护记录。
重复迁移与重启不重建旧邮箱、不重放外部写入。

这是 expand-only schema，旧 Worker 可忽略新增列和表；
但旧 Worker 不会遵循新的冷却和计数规则，也不支持自动请求。
因此不能把新旧 Worker 混跑视为完整 M3g 语义保证。
revision=0 的环境 baseline 在旧新 Worker 重叠热改时，强顺序保证尚未验证；
baseline 配置变更须停写并避免重叠，不能仅凭 hash 声称任意环境热切换强一致。
D1 管理 override 的 revision 竞态则有针对性回归。

本地回退继续保留新增 schema，恢复旧版本及对应旧 Web；不执行 DROP。
现阶段最直接的产品回退仍是使用未改动的原目录和现行部署，不合并本分支。

## 6. 验证与未验边界

相关回归位于 `service/cloudflare/tests/allocation-*.test.mjs`，覆盖严格输入、
权限、域名筛选、计数/guard 原子性、唯一 dispatch、只读预检超时、重启回放、
冷却恢复、同键竞态、观测顺序、配置切换、旧 schema 保留以及独立 Chrome 页面。
新增用例已接入 `npm test` 与 `npm run test:web`，不是孤立的手工测试入口。

本轮完整结果以 `linshi/easyemail-cloudflare-migration-20261028/m3g-final/verification.json`
及 `closeout.json` 为准；历史 M3f 收据不覆盖本轮源码。
本地夹具使用合成数据，不证明真实供应商、真实邮件投递、边缘 CPU/配额、
大规模分配公平性或生产 D1 写入成本已经验收。
