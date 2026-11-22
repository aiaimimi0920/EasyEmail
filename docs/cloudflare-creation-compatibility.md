# 自营邮箱创建合同兼容修复

本修复在 `C:\Users\Public\nas_home\EasyEmail` 的迁移分支进行，只使用本地 workerd/D1 和合成配置。
没有访问或创建真实供应商邮箱，也没有使用生产凭据或发布到 Cloudflare。

## 根因与复现

聚合端此前生成 `ee` 加 32 个十六进制字符，即 34 字符的随机名称。
上游管理员创建入口调用真实 `common-address.ts::newAddress`，设置 `checkLengthByConfig:false`；
该模式仍有固定 30 字符上限，并不是不检查长度。纯字母数字不会被名称过滤缩短，因此创建被拒绝。
原合成 admin 创建夹具直接 INSERT，没有执行名称规则，未能暴露此不匹配。

先增强本地夹具，使其执行生产 `newAddress`、生产域名/名称校验、真实 D1 INSERT 与 Hono HS256 JWT。
实际记录到聚合创建返回 202/unknown 而非预期 201，直接调用上游函数则 31 字符拒绝、30 字符可创建。
这证明本地代码合同不兼容，不是声称已经在现网复现了该错误。

## 最小修改与兼容

仅调整新 Cloudflare 随机名称的编码：取相同的 128 随机位，完整转换为 25 位补零的小写 base36，
加上 `ee` 后共 27 字符，满足默认名称过滤和 30 字符上限。不截去随机位，不改变密钥或 JWT 编码。
Temporam 继续使用原 34 字符名称格式，不扩大到自定义地址、未知资源认领或多供应商重试。

已有完整邮箱、pending/unknown 创建 guard、幂等键、配额和返回地址不重写。
旧 34 字符记录即使本来失败，仍按原键重放原结果，不自动改短重试、不退款或清除 guard。
测试覆盖 pending、unknown、complete 旧格式记录在重启后的原样读取。

## 验证范围

- 创建夹具保留真实生产名称/域名规则、地址写入和 JWT 签发；重复地址不会签发已有地址的凭据。
- fixture 的 HTTP admin wrapper、配置读取、翻译和未启用的密码功能仍为隔离边界。
- 没有执行完整上游 admin middleware、真实站点配置、密码、随机子域名或所有生产 Worker 入口。
- 新测试加入标准 `npm test`；创建、自动分配、历史、代际鉴权、删除及相关 Chrome 流程独立回归。
- `creation-compatibility-red-recorded/runtime.log` 保留 red；当前通过范围以 `creation-compatibility-final/verification.json` 为准。

M3k 聚合切片的完整 205 项后端、21 项浏览器收据属于此前源码快照，不当作本修复后的完整重跑。
本修复收据明确列出实际重跑范围；回退代码不自动清除原数据，生产发布和真实邮箱验收仍需独立授权。
