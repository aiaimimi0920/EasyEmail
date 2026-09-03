export const ADMIN_OPERATIONS_MESSAGES = {
  "views.index.LocalAddress": {
    "actions": {
      "en": "Actions",
      "zh": "操作"
    },
    "address": {
      "en": "Address",
      "zh": "地址"
    },
    "bindAddressSuccess": {
      "en": "Bind Address Success",
      "zh": "绑定地址成功"
    },
    "changeMailAddress": {
      "en": "Change Mail Address",
      "zh": "切换邮箱地址"
    },
    "create_or_bind": {
      "en": "Create or Bind",
      "zh": "创建或绑定"
    },
    "success": {
      "en": "success",
      "zh": "成功"
    },
    "tip": {
      "en": "These addresses are stored in your browser, maybe loss if you clear the browser cache.",
      "zh": "这些地址存储在您的浏览器中，如果您清除浏览器缓存，可能会丢失。"
    },
    "unbindMailAddress": {
      "en": "Unbind Mail Address credential",
      "zh": "解绑邮箱地址"
    }
  },
  "views.admin.DatabaseManager": {
    "code_db_version": {
      "en": "Code Needed DB Version",
      "zh": "需要的数据库版本"
    },
    "current_db_version": {
      "en": "Current DB Version",
      "zh": "当前数据库版本"
    },
    "init": {
      "en": "Initialize Database",
      "zh": "初始化数据库"
    },
    "initializationSuccess": {
      "en": "Database initialized successfully",
      "zh": "数据库初始化成功"
    },
    "migration": {
      "en": "Migrate Database",
      "zh": "升级数据库 Schema"
    },
    "migrationSuccess": {
      "en": "Database migrated successfully",
      "zh": "数据库升级成功"
    },
    "need_initialization_tip": {
      "en": "Database initialization is required. Please initialize the database.",
      "zh": "需要初始化数据库，请初始化数据库"
    },
    "need_migration_tip": {
      "en": "Database migration is required. Please migrate the database.",
      "zh": "需要迁移数据库，请迁移数据库"
    }
  },
  "views.admin.IpBlacklistSettings": {
    "asn_blacklist": {
      "en": "ASN Organization Blacklist",
      "zh": "ASN 组织（运营商）黑名单"
    },
    "asn_blacklist_placeholder": {
      "en": "Enter ASN organization (e.g., Google, Amazon)",
      "zh": "输入 ASN 组织名称（例如：Google, Amazon）"
    },
    "daily_request_limit": {
      "en": "Daily Request Limit",
      "zh": "每日请求次数上限"
    },
    "daily_request_limit_placeholder": {
      "en": "Enter limit (e.g., 1000)",
      "zh": "输入限制次数（例如：1000）"
    },
    "enable_daily_limit": {
      "en": "Enable Daily Request Limit",
      "zh": "启用每日请求限流"
    },
    "enable_daily_limit_tip": {
      "en": "Limit the number of API requests per IP address per day",
      "zh": "限制每个 IP 地址每天的 API 请求次数"
    },
    "enable_ip_blacklist": {
      "en": "Enable IP Blacklist",
      "zh": "启用 IP 黑名单"
    },
    "enable_ip_whitelist": {
      "en": "Enable IP Whitelist (Strict)",
      "zh": "启用 IP 白名单（严格模式）"
    },
    "enable_tip": {
      "en": "Block IPs matching blacklist patterns from accessing rate-limited APIs",
      "zh": "阻止匹配黑名单的 IP 访问限流 API"
    },
    "enable_whitelist_tip": {
      "en": "Strict mode: ONLY IPs matching the whitelist can access rate-limited APIs. All other IPs will be denied.",
      "zh": "严格模式：仅允许匹配白名单的 IP 访问限流 API，其他所有 IP 将被拒绝"
    },
    "fingerprint_blacklist": {
      "en": "Browser Fingerprint Blacklist",
      "zh": "浏览器指纹黑名单"
    },
    "fingerprint_blacklist_placeholder": {
      "en": "Enter fingerprint ID (e.g., a1b2c3d4e5f6g7h8)",
      "zh": "输入指纹 ID（例如：a1b2c3d4e5f6g7h8）"
    },
    "ip_blacklist": {
      "en": "IP Blacklist Patterns",
      "zh": "IP 黑名单匹配模式"
    },
    "ip_blacklist_placeholder": {
      "en": "Enter pattern (e.g., 192.168.1 or ^10\\.0\\.0\\.5$)",
      "zh": "输入匹配模式（例如：192.168.1 或 ^10\\.0\\.0\\.5$）"
    },
    "ip_whitelist": {
      "en": "IP Whitelist Patterns",
      "zh": "IP 白名单匹配模式"
    },
    "ip_whitelist_placeholder": {
      "en": "Exact IP (e.g., 1.2.3.4) or anchored regex (e.g., ^192\\.168\\.1\\.\\d+$)",
      "zh": "精确 IP(如 1.2.3.4)或锚定正则(如 ^192\\.168\\.1\\.\\d+$)"
    },
    "manualInputPrompt": {
      "en": "Type pattern and press Enter to add",
      "zh": "输入匹配模式后按回车键添加"
    },
    "save": {
      "en": "Save",
      "zh": "保存"
    },
    "successTip": {
      "en": "Save Success",
      "zh": "保存成功"
    },
    "tip_asn": {
      "en": "ASN Organization: Block by ISP/provider. Case-insensitive text matching or regex.",
      "zh": "ASN 组织：根据运营商/ISP 拉黑。支持不区分大小写的文本匹配或正则表达式。"
    },
    "tip_daily_limit": {
      "en": "Daily Limit: Restrict the maximum number of requests per IP address per day (1-1000000).",
      "zh": "每日限流：限制单个 IP 地址每天最多请求次数（1-1000000）。"
    },
    "tip_fingerprint": {
      "en": "Browser Fingerprint: Block by browser fingerprint. Supports exact matching or regex patterns.",
      "zh": "浏览器指纹：根据浏览器指纹拉黑。支持完全匹配或正则表达式。"
    },
    "tip_ip": {
      "en": "IP Blacklist: Supports text matching (e.g., \"192.168.1\") or regex (e.g., \"^10\\.0\\.0\\.5$\").",
      "zh": "IP 黑名单：支持文本匹配（如 \"192.168.1\"）或正则表达式（如 \"^10\\.0\\.0\\.5$\"）。"
    },
    "tip_scope": {
      "en": "Applies to: Create Address, Send Mail, External Send Mail API, User Registration, Verify Code",
      "zh": "作用范围：创建邮箱地址、发送邮件、外部发送邮件 API、用户注册、验证码验证"
    },
    "tip_whitelist": {
      "en": "IP Whitelist: Strict allowlist — plain entries must be EXACT IP matches (no substring). Use anchored regex (^...$) for ranges. Whitelisted IPs skip blacklist checks.",
      "zh": "IP 白名单: 严格放行名单——纯文本必须是精确 IP(不支持子串匹配), 批量放行请用锚定正则 ^...$. 命中白名单的 IP 将跳过黑名单检查."
    },
    "title": {
      "en": "IP Blacklist Settings",
      "zh": "IP 黑名单设置"
    },
    "whitelist_empty_warning": {
      "en": "IP whitelist is enabled but the list is empty. This is ignored by the server to prevent lockout. Please add at least one entry before enabling.",
      "zh": "IP 白名单已启用但列表为空，服务端将忽略该开关以防止锁死。请先添加至少一条白名单条目再启用。"
    }
  },
  "views.admin.UserAddressManagement": {
    "mail_count": {
      "en": "Mail Count",
      "zh": "邮件数量"
    },
    "name": {
      "en": "Name",
      "zh": "名称"
    },
    "send_count": {
      "en": "Send Count",
      "zh": "发送数量"
    },
    "success": {
      "en": "success",
      "zh": "成功"
    }
  },
  "views.admin.UserManagement": {
    "actions": {
      "en": "Actions",
      "zh": "操作"
    },
    "address_count": {
      "en": "Address Count",
      "zh": "地址数量"
    },
    "changeRole": {
      "en": "Change Role",
      "zh": "更改角色"
    },
    "createUser": {
      "en": "Create User",
      "zh": "创建用户"
    },
    "created_at": {
      "en": "Created At",
      "zh": "创建时间"
    },
    "delete": {
      "en": "Delete",
      "zh": "删除"
    },
    "deleteUser": {
      "en": "Delete User",
      "zh": "删除用户"
    },
    "deleteUserTip": {
      "en": "Are you sure you want to delete this user?",
      "zh": "确定要删除此用户吗？"
    },
    "domains": {
      "en": "Domains",
      "zh": "域名"
    },
    "email": {
      "en": "Email",
      "zh": "邮箱"
    },
    "itemCount": {
      "en": "itemCount",
      "zh": "总数"
    },
    "password": {
      "en": "Password",
      "zh": "密码"
    },
    "pleaseInput": {
      "en": "Please input complete information",
      "zh": "请输入完整信息"
    },
    "prefix": {
      "en": "Prefix",
      "zh": "前缀"
    },
    "query": {
      "en": "Query",
      "zh": "查询"
    },
    "resetPassword": {
      "en": "Reset Password",
      "zh": "重置密码"
    },
    "role": {
      "en": "Role",
      "zh": "角色"
    },
    "roleDonotExist": {
      "en": "Current Role does not exist",
      "zh": "当前角色不存在"
    },
    "success": {
      "en": "Success",
      "zh": "成功"
    },
    "userAddressManagement": {
      "en": "Address Management",
      "zh": "地址管理"
    },
    "user_email": {
      "en": "User Email",
      "zh": "用户邮箱"
    }
  },
  "views.admin.Telegram": {
    "enable": {
      "en": "Enable",
      "zh": "启用"
    },
    "enableGlobalMailPush": {
      "en": "Enable Global Mail Push(Manually input telegram Chat ID)",
      "zh": "启用全局邮件推送(手动输入邮箱管理员的 telegram Chat ID, 回车增加)"
    },
    "enableTelegramAllowList": {
      "en": "Enable Telegram Allow List(Manually input Chat ID)",
      "zh": "启用 Telegram 白名单(手动输入 Chat ID, 回车增加)"
    },
    "globalMailPushList": {
      "en": "Global Mail Push Chat ID List",
      "zh": "全局邮件推送 Chat ID 列表"
    },
    "globalMailPushListTip": {
      "en": "Support chat_id of private chat/group/channel. You can send a message to your bot, then visit this link to see chat_id, https://api.telegram.org/bot<Replace with your BOT TOKEN>/getUpdates",
      "zh": "支持对话/群组/频道的 Chat ID, 您可以发送一条消息给您的机器人，然后访问此链接来查看 chat_id, https://api.telegram.org/bot<这里替换成您的 BOT TOKEN>/getUpdates"
    },
    "init": {
      "en": "Init",
      "zh": "初始化"
    },
    "manualInputPrompt": {
      "en": "Type and press Enter to add",
      "zh": "输入后按回车键添加"
    },
    "miniAppUrl": {
      "en": "Telegram Mini App URL",
      "zh": "电报小程序 URL(请输入你部署的电报小程序网页地址)"
    },
    "save": {
      "en": "Save",
      "zh": "保存"
    },
    "status": {
      "en": "Check Status",
      "zh": "查看状态"
    },
    "successTip": {
      "en": "Success",
      "zh": "成功"
    },
    "telegramAllowList": {
      "en": "Telegram Allow List(Manually input telegram Chat ID)",
      "zh": "Telegram 白名单(手动输入 Chat ID, 回车增加)"
    }
  },
  "views.admin.CreateAccount": {
    "address": {
      "en": "Address",
      "zh": "地址"
    },
    "addressCredential": {
      "en": "Mail Address Credential",
      "zh": "邮箱地址凭证"
    },
    "addressCredentialTip": {
      "en": "Please copy the Mail Address Credential and you can use it to login to your email account.",
      "zh": "请复制邮箱地址凭证，你可以使用它登录你的邮箱。"
    },
    "addressPassword": {
      "en": "Address Password",
      "zh": "地址密码"
    },
    "creatNewEmail": {
      "en": "Create New Email",
      "zh": "创建新邮箱"
    },
    "enablePrefix": {
      "en": "If enable Prefix",
      "zh": "是否启用前缀"
    },
    "enableRandomSubdomain": {
      "en": "Use Random Subdomain",
      "zh": "启用随机子域名"
    },
    "fillInAllFields": {
      "en": "Please fill in all fields",
      "zh": "请填写完整信息"
    },
    "linkWithAddressCredential": {
      "en": "Open to auto login email link",
      "zh": "打开即可自动登录邮箱的链接"
    },
    "randomSubdomainTip": {
      "en": "When enabled, the created address will use a random subdomain. Subdomain addresses are recommended for receiving only.",
      "zh": "启用后，创建出来的地址会自动挂在随机子域名下。子域名地址更建议仅用于收件。"
    },
    "successTip": {
      "en": "Success Created",
      "zh": "创建成功"
    }
  },
  "views.admin.UserSettings": {
    "emailCheckRegex": {
      "en": "Email Check Regex (e.g. ^[^.]+{'@'}.+$ to disallow dots before {'@'})",
      "zh": "邮箱正则校验 (例如 ^[^.]+{'@'}.+$ 禁止{'@'}前面有.)"
    },
    "enable": {
      "en": "Enable",
      "zh": "启用"
    },
    "enableEmailCheckRegex": {
      "en": "Enable Email Check Regex",
      "zh": "启用邮箱正则校验"
    },
    "enableMailAllowList": {
      "en": "Enable Mail Address Allow List(Manually enterable)",
      "zh": "启用邮件地址白名单(可手动输入, 回车增加)"
    },
    "enableMailVerify": {
      "en": "Enable Mail Verify (Send address must be an address in the system with a balance and can send mail normally)",
      "zh": "启用邮件验证(发送地址必须是系统中能有余额且能正常发送邮件的地址)"
    },
    "enableUserRegister": {
      "en": "Allow User Register",
      "zh": "允许用户注册"
    },
    "mailAllowList": {
      "en": "Mail Address Allow List",
      "zh": "邮件地址白名单"
    },
    "manualInputPrompt": {
      "en": "Type and press Enter to add",
      "zh": "输入后按回车键添加"
    },
    "maxAddressCount": {
      "en": "Maximum number of email addresses that can be binded (0 = Unlimited)",
      "zh": "可绑定最大邮箱地址数量（0 为不限制）"
    },
    "save": {
      "en": "Save",
      "zh": "保存"
    },
    "successTip": {
      "en": "Save Success",
      "zh": "保存成功"
    },
    "verifyMailSender": {
      "en": "Verify Mail Sender",
      "zh": "验证邮件发送地址"
    }
  },
  "views.admin.RoleAddressConfig": {
    "maxAddressCount": {
      "en": "Max Address Count (0 = Unlimited)",
      "zh": "最大地址数量（0 为不限制）"
    },
    "noRolesAvailable": {
      "en": "No roles available in system config",
      "zh": "系统配置中没有可用的角色"
    },
    "notConfigured": {
      "en": "Not Configured (Use Global Settings)",
      "zh": "未配置（使用全局设置）"
    },
    "role": {
      "en": "Role",
      "zh": "角色"
    },
    "roleConfigDesc": {
      "en": "Configure maximum address count for each user role. Role-based limits take priority over global settings. Set 0 for unlimited.",
      "zh": "为每个用户角色配置最大地址数量。角色配置优先于全局设置。设置为 0 表示不限制。"
    },
    "save": {
      "en": "Save",
      "zh": "保存"
    },
    "successTip": {
      "en": "Success",
      "zh": "成功"
    }
  },
} as const;

