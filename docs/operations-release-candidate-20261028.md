# EasyEmail 最小发布候选验证（2026-10-28）

最新进展：用户明确批准后，该冻结候选已于 2026-10-28 02:44 UTC 完成生产切换。
实际备份、镜像身份、数据核验及剩余边界见
[16 文件最小增量生产发布](operations-production-send-safety-20261028.md)。下文保留候选
准备阶段的历史事实，“尚未上线”只描述对应的核验时点。

本记录续接 [显式原生发信与 SDK 真实验收](operations-native-send-20261028.md)、
[发送安全修复](operations-send-safety-20261028.md) 与
[网络诊断](operations-network-20261028.md)。时间均为 UTC；21:33 UTC 对应北京时间
10 月 28 日 05:33。**候选验证不等于生产已经更新。**

## 1. 冻结范围

只包含以下 8 个运行模块及各自 source map，共 16 个文件：

```text
src/domain/cloudflare-send-policy
src/providers/http-policy
src/providers/cloudflare_temp_email/connector/client
src/providers/cloudflare_temp_email/connector/configuration
src/providers/cloudflare_temp_email/connector/send-binding
src/runtime/config
src/runtime/cloudflare-temp-email-config
src/service/provider-management
```

内容取自已经验证的 `round12/build`，不重新打包整棵 dirty 工作区。冻结归档：

```text
round13/send-safety-native-16files.tar
SHA256 f0875ddbf4b121c88b92344eec463ae16b9988f833076a9c3591b4740c7a8444
```

`round13/prepared-release-manifest.json` 记录逐文件摘要。当前生产仍为
`nas-snapshot-cow-20261026-003`，镜像 ID：

```text
sha256:ab3bb5f637d875e79b841d08486ff276b7cbb57d610c71daed935ebcb06513cb
```

不包含 [快照记录布局候选](operations-snapshot-records-20261028.md)，不包含其他
未提交改动，不修改实例发信模式、Worker 配置或路由语义。发布许可与专用发信实例
启用仍是独立边界，不能用先前其他范围的同意替代。

## 2. 精确 overlay 集成验证

2026-10-27 21:31:49–21:31:50，在 NAS 独立目录复制生产 `dist/src` 全部普通文件，
仅覆盖上述 16 文件，依赖链接指向原 `/app/node_modules`。生产 `dist/src` 共
416 文件，其中 JavaScript/maps 为 387 文件，另有 29 个资源文件；overlay 为
420 文件，因为白名单新增两个模块和两个 maps。该计数不代表整个镜像的文件数。

逐项 SHA256 对比确认变化未超出白名单，生产快照 store 字节不变，快照 codec/diff
新模块不存在，验证前后生产运行文件清单不变。独立 runtime 使用内存 registry、
随机 bearer、loopback 动态端口；persistence 与 maintenance 均关闭。

8 项实际通过：

1. YAML 配置到实例注册、HTTP 认证的完整连接。
2. 显式 binding 只调用原生发送 endpoint。
3. 原生接口拒绝后不切换发送后端。
4. 注册更新省略字段保留旧值，非法模式不修改实例。
5. Worker 模糊 HTTP 400 不触发管理员重发。
6. Worker socket 错误不触发管理员重发。
7. 明确认证拒绝仍保留既有管理员 delegation。
8. 网络恢复日志包含阶段与耗时，复用原 signal/deadline。

上游请求由严格 fake fetch 隔离：外网请求 0、真实邮件 0；不把这些 synthetic
测试当作新的投递验收。loopback 已关闭，独立进程退出，无 synthetic state 目录。

首次夹具只复制 JavaScript/maps，遗漏 `defaults/provider_types/duckmail.json`，
出现 `ERR_MODULE_NOT_FOUND`；这是诊断夹具遗漏，不是生产或候选代码缺陷。修正为
复制全部普通文件后通过，原失败目录与脚本保留，不覆写失败回执。

## 3. 真实配置兼容性与生产检查

21:33:11 的只读预检确认：

- 新旧 loader 对真实生产配置的解析结果逐字节 JSON 相等。
- 9 个既有 Cloudflare 实例的新旧 connector 配置解析结果相等。
- 现有 binding opt-in 数为 0；没有偷偷将普通实例切换原生发信。
- 带认证 readiness 通过；healthy、restart 0、OOM false。
- 5,000 sessions / 2,914 messages；Cloudflare 与 Temporam 全 active。
- 正确检查 `instance.metadata.errorClass`，均为空。
- 主维护最近更新为 21:32:21.158；21:22:12 后的有界日志无新 retry。
- overlay 进程 0；两个隔离目录及普通文件分别限制为 0700/0600。

没有新 retry 不能证明历史网络根因已解决，readiness 也不替代真实业务投递。
历史真实投递沿用 `round12` 的一次性验收，本轮不重放。

## 4. 证据与保留现场

证据根为 `C:/Users/Public/nas_home/AI/GameEditor/linshi/easyemail-ops-20261025`：

- `round15/exact-overlay-20261027T213154Z.json`：精确 overlay 成功回执。
- `round15/production-preflight-20261027T213315Z.json`：配置和生产状态只读预检。
- `round15/exact-overlay-20261027T213052Z.json`：首轮夹具失败回执。
- `round15/source-before/`：修正前诊断脚本。
- `round15/source-audit.json`、`round15/evidence-summary.json`：源码与证据摘要。

NAS 两个受限目录位于 `data/operator-send-overlay-20261028` 和
`data/operator-send-overlay-20261028-retry1`。保留诊断现场、生产数据、旧镜像、旧
回滚容器及 `operator/ops-20261026-snapshot-cow/rollback`；不执行 orphan cleanup，
不拿旧快照覆盖新邮件。本轮没有提交、推送或触发 Actions。

## 5. 不接管生产的候选镜像

21:37:30 已在 NAS 构建候选，关闭 pull、build network 为 none。构建上下文只含
16 个冻结运行文件与一个 Dockerfile，没有配置、凭据、邮件或其他工作区文件。

```text
easyemail/easy-email-service:nas-send-safety-native-20261028-candidate-001
sha256:d2ee8e3ecdbe0fed97e9efb2862fc4128f3c0560ead70c0bd732bba141c8f5d2
```

镜像保留生产基线的全部 RootFS layers，仅新增一层。Healthcheck、Entrypoint、Cmd、
Env、StopSignal、User、WorkingDir、ExposedPorts、Volumes、Labels、StopTimeout
逐项相等；没有修改生产容器、挂载、配置或重启次数。候选构建完成不代表已经上线。

第一轮镜像测试额外指定 UID 65534，因生产基线既有
`/app/dist/src/persistence/file-state-store.js` 为 root 所有、0600 而触发 `EACCES`，
尚未进入功能用例。此前检查到的是容器默认 exec 身份 UID 0，不能据此认定应用主进程
也是 root；后续生产发布通过宿主 `/proc` 确认 root entrypoint 使用 gosu 启动 UID 10001
的主 Node。首次隔离测试绕过了这一步所有权准备，不能把任意 UID 65534 的 EACCES
当作新增 16 文件的行为回归；本轮不扩大原文件权限、不宣称支持任意非 root UID。
DSM 还明确告警不支持 PIDs limit；重试不继续添加这个无效参数，也不报告它已生效。
失败日志、失败测试容器与诊断脚本均保留，后续测试沿用镜像既有用户。

21:40:29–21:40:44 重试完成，实际镜像内 8 项用例全部通过。核验范围包括全部
`/app/dist/src`、`/app/ops/scripts`、`/app/package.json` 和入口脚本，共 427 个
文件；比生产范围内的 423 个文件新增 4 个，摘要变化恰好为白名单 16 个文件。
生产上述文件在测试前后完全一致，候选快照 store 保留原字节，没有 codec/diff。

测试为 `--network none`、只读根文件系统、`--cap-drop ALL`、
`no-new-privileges`，仅 `/work` 使用 tmpfs；没有发布端口、没有生产挂载。
临时 runtime 只监听其独立网络命名空间的 loopback；persistence/maintenance 关闭，
上游全部 fake fetch。外网请求 0、真实发信 0，退出码 0，loopback 关闭，测试容器
已停止且 OOM false。两个已停止测试容器保留，未执行自动删除。

成功轮 stderr 的 792 字节为 Node SQLite 实验性提示两行，以及四条由受控拒绝、
非法模式、模糊发送失败、socket 失败用例预期产生的 HTTP failure 日志；不将它们
当作生产错误，也不隐去首轮 EACCES。没有使用这些测试宣称生产真实投递已升级。

21:41:21 最终只读复核：生产镜像与启动时间未变，healthy、restart 0、OOM false；
带认证 readiness 通过，仍为 5,000 sessions / 2,914 messages，9 个 Cloudflare 和
Temporam 均 active，`metadata.errorClass` 均空，binding opt-in 仍为 0。
主维护最近更新 21:37:21.159，21:22:12 后无新 retry；回滚目录仍存在。

本轮重新运行 checker 单元测试 19/19，ratchet 与 strict 均扫描 1,064 文件，
soft/mandatory/hard 均 0，没有 oversized baseline debt。产品源码未变化，未重复
运行 `round14` 已通过的 82 文件 / 434 项全量测试；其证据与当前源码摘要对应关系
单独核验，不冒充本轮新跑结果。

`round16` 保存 Dockerfile、candidate-image、candidate-verified、生产清单、两轮
测试回执、执行脚本、日志审阅、生产状态、line 报告与最终 evidence-summary。
NAS 构建现场在 `operator/ops-20261028-send-candidate`，目录 0700；日志和回执
0600。该候选仅准备完成，**没有更新 easyemail-sdk，也没有启用生产 binding 实例**。
