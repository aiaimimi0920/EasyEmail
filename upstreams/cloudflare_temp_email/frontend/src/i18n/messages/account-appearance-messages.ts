export const ACCOUNT_APPEARANCE_MESSAGES = {
  "views.common.Appearance": {
    "autoRefreshInterval": {
      "en": "Auto Refresh Interval(Sec)",
      "zh": "自动刷新间隔(秒)"
    },
    "bottom": {
      "en": "bottom",
      "zh": "底部"
    },
    "globalTabplacement": {
      "en": "Global Tab Placement",
      "zh": "全局选项卡位置"
    },
    "left": {
      "en": "left",
      "zh": "左侧"
    },
    "mailboxSplitSize": {
      "en": "Mailbox Split Size",
      "zh": "邮箱界面分栏大小"
    },
    "preferShowTextMail": {
      "en": "Display text Mail by default",
      "zh": "默认以文本显示邮件"
    },
    "right": {
      "en": "right",
      "zh": "右侧"
    },
    "top": {
      "en": "top",
      "zh": "顶部"
    },
    "useIframeShowMail": {
      "en": "Use iframe Show HTML Mail",
      "zh": "使用iframe显示HTML邮件"
    },
    "useSideMargin": {
      "en": "Turn on the side margins on the left and right sides of the page",
      "zh": "开启页面左右两侧侧边距"
    },
    "useSimpleIndex": {
      "en": "Use Simple Index",
      "zh": "使用极简主页"
    },
    "useUTCDate": {
      "en": "Use UTC Date",
      "zh": "使用 UTC 时间"
    }
  },
  "views.admin.AccountSettings": {
    "actions": {
      "en": "Actions",
      "zh": "操作"
    },
    "add": {
      "en": "Add",
      "zh": "添加"
    },
    "address_block_list": {
      "en": "Address Block Keywords for Users(Admin can skip)",
      "zh": "邮件地址屏蔽关键词(管理员可跳过检查)"
    },
    "address_block_list_placeholder": {
      "en": "Please enter the keywords you want to block",
      "zh": "请输入您想要屏蔽的关键词"
    },
    "block_receive_unknow_address_email": {
      "en": "Block receive unknow address email",
      "zh": "禁止接收未知地址邮件"
    },
    "cancel": {
      "en": "Cancel",
      "zh": "取消"
    },
    "config": {
      "en": "Config",
      "zh": "配置"
    },
    "create_address_subdomain_match": {
      "en": "Allow Subdomain Suffix Match When Creating Address",
      "zh": "创建邮箱时允许子域名后缀匹配"
    },
    "create_address_subdomain_match_env_locked": {
      "en": "Worker env ENABLE_CREATE_ADDRESS_SUBDOMAIN_MATCH is currently false. The saved admin switch can be modified, but it will not take effect until env is enabled or removed.",
      "zh": "当前 Worker 环境变量 ENABLE_CREATE_ADDRESS_SUBDOMAIN_MATCH 为 false。后台开关仍可保存，但在 env 打开或移除前不会生效。"
    },
    "create_address_subdomain_match_follow_env": {
      "en": "Follow Environment Variable",
      "zh": "跟随环境变量"
    },
    "create_address_subdomain_match_follow_env_note": {
      "en": "Choosing \"Follow Environment Variable\" clears the admin override and returns to the unset state. The effective result is still controlled by the Worker env and the precedence rules.",
      "zh": "选择“跟随环境变量”会清空后台覆盖，恢复为未设置状态；最终是否开启仍由 Worker env 和优先级规则决定。"
    },
    "create_address_subdomain_match_force_disable": {
      "en": "Force Disable",
      "zh": "强制关闭"
    },
    "create_address_subdomain_match_force_enable": {
      "en": "Force Enable",
      "zh": "强制开启"
    },
    "create_address_subdomain_match_note": {
      "en": "This is different from RANDOM_SUBDOMAIN_DOMAINS: this switch allows API callers to specify custom subdomains directly, while random subdomain only auto-generates one during creation.",
      "zh": "这与 RANDOM_SUBDOMAIN_DOMAINS 不同：这里允许 API 调用方直接指定自定义子域名；随机子域名功能只是在创建时自动补一个随机子域名。"
    },
    "create_address_subdomain_match_tip": {
      "en": "Only affects /api/new_address and /admin/new_address domain validation. Example: when enabled, foo.example.com can match configured base domain example.com.",
      "zh": "仅影响 /api/new_address 和 /admin/new_address 的域名校验。例如开启后，foo.example.com 可以匹配已配置的基础域名 example.com。"
    },
    "delete_rule": {
      "en": "Delete",
      "zh": "删除"
    },
    "delete_rule_confirm": {
      "en": "Are you sure you want to delete this rule?",
      "zh": "确定要删除这条规则吗？"
    },
    "delete_success": {
      "en": "Delete Success",
      "zh": "删除成功"
    },
    "domain_list": {
      "en": "Domain List (Optional)",
      "zh": "域名列表（可选）"
    },
    "email_forwarding_config": {
      "en": "Email Forwarding Configuration",
      "zh": "邮件转发配置"
    },
    "forward_address": {
      "en": "Forward Address",
      "zh": "转发地址"
    },
    "forward_address_required": {
      "en": "Forward address is required",
      "zh": "转发地址不能为空"
    },
    "forward_placeholder": {
      "en": "forward@example.com",
      "zh": "forward@example.com"
    },
    "forwarding_rule_warning": {
      "en": "Each rule will run independently. Forward address needs to be a verified address.",
      "zh": "每条规则独立运行，转发地址需要为已验证的地址。"
    },
    "fromBlockList": {
      "en": "Block Keywords for receive email",
      "zh": "接收邮件地址屏蔽关键词"
    },
    "manualInputPrompt": {
      "en": "Type and press Enter to add",
      "zh": "输入后按回车键添加"
    },
    "match_all": {
      "en": "All",
      "zh": "全部"
    },
    "match_any": {
      "en": "Any",
      "zh": "任一"
    },
    "noLimitSendAddressList": {
      "en": "No Balance Limit Send Address List",
      "zh": "无余额限制发送地址列表"
    },
    "regex_invalid": {
      "en": "Invalid regex pattern",
      "zh": "无效的正则表达式"
    },
    "regex_too_long": {
      "en": "Regex pattern too long (max 200 characters)",
      "zh": "正则表达式过长（最大200字符）"
    },
    "rule_index": {
      "en": "Rule",
      "zh": "规则"
    },
    "save": {
      "en": "Save",
      "zh": "保存"
    },
    "select_domain": {
      "en": "Select Domain",
      "zh": "选择域名"
    },
    "send_address_block_list": {
      "en": "Address Block Keywords for send email",
      "zh": "发送邮件地址屏蔽关键词"
    },
    "send_mail_daily_limit": {
      "en": "Daily Limit",
      "zh": "每日额度"
    },
    "send_mail_daily_limit_invalid": {
      "en": "Daily limit must be an integer greater than or equal to -1",
      "zh": "每日额度必须是大于等于 -1 的整数"
    },
    "send_mail_limit": {
      "en": "Send Mail Limit",
      "zh": "发信额度"
    },
    "send_mail_limit_tip": {
      "en": "This applies to all send channels. Use -1 for unlimited and 0 to block sending.",
      "zh": "对全部发信渠道生效。-1 表示无限，0 表示禁止发送。"
    },
    "send_mail_monthly_limit": {
      "en": "Monthly Limit",
      "zh": "每月额度"
    },
    "send_mail_monthly_limit_invalid": {
      "en": "Monthly limit must be an integer greater than or equal to -1",
      "zh": "每月额度必须是大于等于 -1 的整数"
    },
    "source_match_mode": {
      "en": "Match Mode",
      "zh": "匹配模式"
    },
    "source_patterns": {
      "en": "Source Address Regex (Optional)",
      "zh": "来源地址正则（可选）"
    },
    "source_patterns_placeholder": {
      "en": "e.g. gmail.com",
      "zh": "例如: gmail.com"
    },
    "source_patterns_tip": {
      "en": "Domain list filters by recipient address, source regex filters by sender address. Both conditions must match for forwarding (AND logic). Leave either empty to skip that filter.",
      "zh": "域名列表按收件地址过滤，来源正则按发件地址过滤，两者均为可选。同时配置时需同时满足（AND 逻辑），留空则跳过该条件。"
    },
    "successTip": {
      "en": "Save Success",
      "zh": "保存成功"
    },
    "tip": {
      "en": "You can manually input the following multiple select input and enter",
      "zh": "您可以手动输入以下多选输入框, 回车增加"
    },
    "verified_address_list": {
      "en": "Verified Address List(Can send email by cf internal api)",
      "zh": "已验证地址列表(可通过 cf 内部 api 发送邮件)"
    }
  },
  "views.admin.Mails": {
    "addressQueryTip": {
      "en": "Leave blank to query all addresses",
      "zh": "留空查询所有地址"
    },
    "query": {
      "en": "Query",
      "zh": "查询"
    }
  },
} as const;

