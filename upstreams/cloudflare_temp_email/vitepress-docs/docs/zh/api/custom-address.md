# 可信服务的精确自定义地址

迁移分支新增两个受约束的接口，不替换旧 `/admin/new_address`。此处描述代码合同，不表示现网已经升级。

## 认证与能力

`GET /admin/custom_address_capability` 必须提供匹配 `ADMIN_PASSWORDS` 的 `x-admin-auth`，
以及实例要求的可选全站 `x-custom-auth`。即使管理员免密开关开启或持有管理员角色 token，handler 仍要求真实管理员密钥。
响应禁止缓存：

```json
{"contract":"easyemail-custom-address-v1","enabled":true,"minLength":1,"maxLength":30,"domains":["mail.example.com"]}
```

关闭 `ENABLE_USER_CREATE_EMAIL` 或开启 `DISABLE_CUSTOM_ADDRESS_NAME` 时 `enabled=false`。
配置或黑名单存储不可用时返回脱敏的 503，不发布放宽后的能力。

## 创建

`POST /admin/custom_address`，`Content-Type: application/json`，真实请求体最多 8 KiB：

```json
{"name":"chosen123","domain":"mail.example.com"}
```

仅允许这两个字段；名称须为小写 ASCII 字母数字、1–30 位，且满足真实最小/最大长度、
`ADDRESS_REGEX` 清洗前后相同、`ADDRESS_CHECK_REGEX` 及名称黑名单约束。不 trim、不转小写，
不加 `PREFIX`、角色前缀或随机子域。域名只允许具体 `DOMAINS` 与有效 `DEFAULT_DOMAINS` 的交集，
默认列表为空时用 `DOMAINS`；本合同不扩展 wildcard 模板或子域匹配。

成功 HTTP 201，返回生产创建器签发的 `address`、`address_id`、`jwt` 及可选密码。
地址已存在时不返回其凭据。无效输入返回 400，认证失败 401，能力关闭 403，超限 413，媒体类型错误 415；
配置/存储异常返回 503。创建之后也可能丢失响应或签名失败，调用方必须保存原地址/幂等记录，不能盲目重试或换地址。

这是可信服务代理，不是匿名用户创建接口：聚合方负责登录、用户配额和限流；
不复用匿名开关、Turnstile、上游用户角色和上游用户邮箱数量规则。既有全站访问中间件仍适用。
旧版本缺少能力接口时调用方应拒绝自定义创建，不回退到旧管理员创建来绕过规则。
