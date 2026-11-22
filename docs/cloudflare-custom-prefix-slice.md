# 自定义邮箱前缀切片

本切片在迁移分支增加受约束的自定义创建，不发布上游或聚合服务，不改变旧随机创建路径。
Web 与开放 API 使用同一个创建处理器、权限、配额、幂等记录和 unknown 恢复规则。

## 聚合 API 与网页

- `GET /api/v1/providers/:id/custom-prefix`：需要 `mailboxes:read`，真实认证预检后返回
  `{customPrefix:{enabled,minLength,maxLength,domains}}`，不返回供应商凭据。
- catalog 的 Cloudflare `capabilities.customPrefix` 为 `preflight-required`，不是已验证可用；Temporam 为 `false`。
- `POST /api/v1/mailboxes`：仍需要 `mailboxes:write` 与 `Idempotency-Key`。
  手动请求可增加 `prefix`：`{providerId,domain,prefix}`；自动请求为 `{selection:"automatic",prefix,domain?}`。
- 前缀只允许 1–30 位小写 ASCII 字母和数字，不 trim、不转小写、不清洗为另一个名称。
  真实上游的最小/最大长度、名称检查正则、黑名单和默认用户域名继续约束创建。
- 自动模式仅考虑支持该合同的 Cloudflare；最多 3 个候选、8 秒总预算、每候选 2.5 秒只读预检。
  预检可跳过不兼容候选，预约后只向选定供应商写一次，不失败换地址或换供应商。
- Web 增加命名方式、前缀输入、真实手动能力查询与可用域名；不支持或关闭时禁用创建。
  unknown 保留精确地址，刷新后从创建历史恢复，只读核对已有记录。

旧随机请求的 hash 序列化完全不变，新前缀参与新 hash；旧的 pending、unknown、complete guard
不改名、不补发、不退配额。全局地址唯一 guard 保留，即使平台访问已释放也不允许另一用户认领。
同地址多用户/多键预约由 D1 INSERT 条件原子拒绝，返回通用 `409 mailbox_address_unavailable`，不泄露所有者。
上游已存在但平台未记录的地址不会返回已有 JWT；若上游拒绝或创建后响应丢失，仍保守记录 unknown。

## 自营上游新合同

- `GET /admin/custom_address_capability`：版本标识 `easyemail-custom-address-v1`。
- `POST /admin/custom_address`：仅接受 `application/json` 的 `{name,domain}`；真实流上限 8 KiB。
  成功为 HTTP 201，返回生产 `newAddress` 创建的 `address`、`address_id`、`jwt`，以及既有可选密码。
- 两个 handler 都再次要求已配置且匹配的 `x-admin-auth`；管理员绕过开关和角色 token 单独使用均不授权。
  既有全站密码等外围中间件继续适用。密钥只留在后端，不下发到网页。
- 固定不加系统前缀、不随机子域、不接受内部 flags，不使用旧 admin 接口绕过用户规则。
- 遵守 `ENABLE_USER_CREATE_EMAIL` 和 `DISABLE_CUSTOM_ADDRESS_NAME`，关闭时拒绝，不随机回退。
  这是可信聚合服务代理：平台负责登录用户、配额、限流；不伪装上游用户登录，不复用匿名接口的 Turnstile、匿名开关、用户角色域名及用户邮箱数量门禁。
- 精确域名仅限 `DOMAINS` 与非空 `DEFAULT_DOMAINS` 的交集；默认域名为空则使用 `DOMAINS`。
  本版只支持具体域名，不扩展 wildcard 模板或任意子域匹配；配置包含模板时 fail closed，不声称兼容所有旧域名配置。
- 名称清洗后必须仍与输入一致。无效正则、非法长度配置、畸形黑名单或 D1 读取失败均失败关闭。
  这条严格路径不改变旧 public/admin 接口的容错行为。

## 兼容、回退和验收边界

不增加数据库迁移。旧随机创建继续工作；旧上游没有新 capability 接口时自定义创建明确失败，
不向 `/admin/new_address` 发送新用户前缀。回退聚合代码不删除新创建记录和资源；回退上游后，
已有邮箱读取仍按既有 API，只有新的自定义创建能力不可用。
缺失 capability 路径的 404 映射为能力不支持，不进入全局分配冷却，也不影响显式随机创建。

本地测试执行生产 policy、handler、`newAddress`、D1 INSERT 和 Hono HS256 JWT；外层服务与配置隔离仍是测试夹具。
回归覆盖名称与域名限制、强制管理员鉴权、畸形存储、请求边界、原子地址预约、旧 hash、unknown 重启、有限自动选择和 Chrome 操作。
这些证据不代表完整上游 Worker 所有路由构建、真实供应商创建、实际邮件投递或生产发布已通过。
完整用户管理、普通邮箱、完整工作台、可靠队列和 Agent 模块仍在整体迁移目标内，不能以本切片替代整体验收。
