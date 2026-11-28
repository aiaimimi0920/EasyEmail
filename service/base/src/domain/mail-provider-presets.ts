export type MailProviderCategory = "personal" | "community" | "enterprise" | "agent" | "custom";
export type MailProviderAuthKind = "oauth2" | "app_password" | "auth_code" | "password" | "rest_browser_poll" | "local_webview_session";
export type MailTransportSecurityMode = "tls" | "starttls";

export interface MailProviderPreset {
  id: string;
  name: string;
  category: MailProviderCategory;
  subtitle: string;
  badgeText: string;
  authKind: MailProviderAuthKind;
  supportsAppPassword: boolean;
  stripSecretWhitespace: boolean;
  guideTitle: string;
  guideSummary: string;
  steps: readonly string[];
  domains: readonly string[];
  defaultImapHost: string;
  defaultImapPort: 993 | 143;
  defaultImapSecurity: MailTransportSecurityMode;
  defaultSmtpHost: string;
  defaultSmtpPort: 465 | 587;
  defaultSmtpSecurity: MailTransportSecurityMode;
  requiresImapId: boolean;
  autoAppendsSent: boolean;
  detectedVia?: string;
  note?: string;
}

export interface MailMxRecordInput {
  exchange: string;
  priority: number;
}

export type MailProbeStage = "dns" | "tls" | "imap" | "smtp";

export interface MailProbeStageReport {
  stage: MailProbeStage;
  label: string;
  ok: boolean;
  durationMs: number;
  detail: string;
  suggestion?: string;
}

export interface MailFourStageProbeReport {
  ok: boolean;
  summary: string;
  providerId?: string;
  discoveredFolders?: number;
  steps: MailProbeStageReport[];
}

const PRESETS: readonly MailProviderPreset[] = [
  {
    id: "gmail", name: "Gmail", category: "personal",
    subtitle: "支持 Google OAuth 2.0 或 16 位应用专用密码", badgeText: "OAuth / 应用密码",
    authKind: "oauth2", supportsAppPassword: true, stripSecretWhitespace: true,
    guideTitle: "连接 Google Gmail",
    guideSummary: "推荐使用 Google OAuth 2.0 授权，或在开启两步验证后生成 16 位应用专用密码。",
    steps: [
      "前往 Google 账号「安全性 → 两步验证 → 应用专用密码」",
      "生成 16 位应用专用密码（复制带空格格式即可，系统自动去除空格）",
      "确认 Gmail 网页端已启用 IMAP 访问",
    ],
    domains: ["gmail.com", "googlemail.com"],
    defaultImapHost: "imap.gmail.com", defaultImapPort: 993, defaultImapSecurity: "tls",
    defaultSmtpHost: "smtp.gmail.com", defaultSmtpPort: 465, defaultSmtpSecurity: "tls",
    requiresImapId: false, autoAppendsSent: true,
  },
  {
    id: "outlook", name: "Outlook / Microsoft 365", category: "personal",
    subtitle: "支持 Outlook、Hotmail、Live 与 Microsoft 365", badgeText: "OAuth / 专用密码",
    authKind: "oauth2", supportsAppPassword: true, stripSecretWhitespace: false,
    guideTitle: "连接 Outlook / Microsoft 365",
    guideSummary: "支持官方 OAuth 2.0 授权或微软账户安全中心生成的应用密码。",
    steps: [
      "确认微软邮箱已开启 IMAP 与认证 SMTP 权限",
      "使用现代 OAuth 授权或两步验证下的应用密码登录",
      "发件默认采用 587 STARTTLS 安全通道",
    ],
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com", "office365.com"],
    defaultImapHost: "outlook.office365.com", defaultImapPort: 993, defaultImapSecurity: "tls",
    defaultSmtpHost: "smtp.office365.com", defaultSmtpPort: 587, defaultSmtpSecurity: "starttls",
    requiresImapId: false, autoAppendsSent: true,
  },
  {
    id: "qq", name: "QQ 邮箱 / Foxmail", category: "personal",
    subtitle: "支持 @qq.com、@foxmail.com 与 VIP 邮箱", badgeText: "16 位授权码",
    authKind: "auth_code", supportsAppPassword: true, stripSecretWhitespace: true,
    guideTitle: "连接腾讯 QQ 邮箱",
    guideSummary: "须在 QQ 邮箱网页版开启 IMAP/SMTP 服务并生成 16 位客户端授权码。",
    steps: [
      "登录 mail.qq.com 进入「设置 → 账户」",
      "开启「IMAP/SMTP 服务」并完成密保校验",
      "复制 16 位授权码填入密码栏（切勿填写 QQ 登录密码）",
    ],
    domains: ["qq.com", "foxmail.com", "vip.qq.com"],
    defaultImapHost: "imap.qq.com", defaultImapPort: 993, defaultImapSecurity: "tls",
    defaultSmtpHost: "smtp.qq.com", defaultSmtpPort: 465, defaultSmtpSecurity: "tls",
    requiresImapId: false, autoAppendsSent: true,
  },
  {
    id: "netease", name: "网易邮箱 (163 / 126 / yeah)", category: "personal",
    subtitle: "内置 RFC 2971 ID 握手，自动规避 Unsafe Login 拦截", badgeText: "客户端授权码",
    authKind: "auth_code", supportsAppPassword: true, stripSecretWhitespace: false,
    guideTitle: "连接网易个人邮箱（163 / 126 / yeah.net）",
    guideSummary: "连接成功后自动发送 RFC 2971 客户端身份标识，消除 Unsafe Login 报错。",
    steps: [
      "登录网易邮箱网页版进入「设置 → POP3/SMTP/IMAP」",
      "开启「IMAP/SMTP 服务」",
      "新增并复制客户端授权密码填入下方",
    ],
    domains: ["163.com", "126.com", "yeah.net", "vip.163.com", "vip.126.com", "188.com"],
    defaultImapHost: "imap.163.com", defaultImapPort: 993, defaultImapSecurity: "tls",
    defaultSmtpHost: "smtp.163.com", defaultSmtpPort: 465, defaultSmtpSecurity: "tls",
    requiresImapId: true, autoAppendsSent: false,
    note: "已内置 RFC 2971 IMAP ID 握手兼容策略",
  },
  {
    id: "linuxdo", name: "Linux.do 社区邮箱", category: "community",
    subtitle: "LINUX DO 社区专属邮局 (@linux.do)", badgeText: "社区专用密码",
    authKind: "app_password", supportsAppPassword: true, stripSecretWhitespace: false,
    guideTitle: "连接 Linux.do 社区邮箱",
    guideSummary: "默认预填 mail.linux.do:993 与 smtp.linux.do:465，支持四阶段实时测连。",
    steps: [
      "获取您的 @linux.do 邮箱地址与客户端应用专用密码",
      "核对 IMAP (mail.linux.do:993) 与 SMTP (smtp.linux.do:465) 主机配置",
      "运行四步握手诊断确认收发通道就绪",
    ],
    domains: ["linux.do"],
    defaultImapHost: "mail.linux.do", defaultImapPort: 993, defaultImapSecurity: "tls",
    defaultSmtpHost: "smtp.linux.do", defaultSmtpPort: 465, defaultSmtpSecurity: "tls",
    requiresImapId: false, autoAppendsSent: false,
  },
  {
    id: "icloud", name: "Apple iCloud 邮件", category: "personal",
    subtitle: "支持 @icloud.com / @me.com / @mac.com", badgeText: "应用专用密码",
    authKind: "app_password", supportsAppPassword: true, stripSecretWhitespace: false,
    guideTitle: "连接 Apple iCloud 邮件",
    guideSummary: "须使用 Apple 账户中心生成的 xxxx-xxxx-xxxx-xxxx 应用专用密码。",
    steps: [
      "访问 account.apple.com 登录 Apple 账户",
      "在「登录和安全 → App 专用密码」中创建邮件专用密码",
      "使用完整 @icloud.com 邮箱地址与该专用密码连接",
    ],
    domains: ["icloud.com", "me.com", "mac.com"],
    defaultImapHost: "imap.mail.me.com", defaultImapPort: 993, defaultImapSecurity: "tls",
    defaultSmtpHost: "smtp.mail.me.com", defaultSmtpPort: 587, defaultSmtpSecurity: "starttls",
    requiresImapId: false, autoAppendsSent: false,
  },
  {
    id: "yahoo", name: "Yahoo Mail", category: "personal",
    subtitle: "支持 @yahoo.com 及区域域名", badgeText: "应用密码",
    authKind: "app_password", supportsAppPassword: true, stripSecretWhitespace: true,
    guideTitle: "连接 Yahoo Mail",
    guideSummary: "在 Yahoo Account Security 页面生成 16 位第三方应用密码。",
    steps: [
      "打开 Yahoo Account Security 页面",
      "点击「Generate app password」生成应用密码",
      "填写完整 Yahoo 邮箱地址与应用密码",
    ],
    domains: ["yahoo.com", "yahoo.co.jp", "yahoo.co.uk", "ymail.com"],
    defaultImapHost: "imap.mail.yahoo.com", defaultImapPort: 993, defaultImapSecurity: "tls",
    defaultSmtpHost: "smtp.mail.yahoo.com", defaultSmtpPort: 465, defaultSmtpSecurity: "tls",
    requiresImapId: false, autoAppendsSent: true,
  },
  {
    id: "yandex", name: "Yandex Mail", category: "personal",
    subtitle: "支持 @yandex.com / @yandex.ru", badgeText: "应用密码",
    authKind: "app_password", supportsAppPassword: true, stripSecretWhitespace: false,
    guideTitle: "连接 Yandex Mail",
    guideSummary: "须在 Yandex Mail 设置中勾选启用 IMAP 并生成邮件应用密码。",
    steps: [
      "在 Yandex Mail「Email clients」设置中启用 IMAP",
      "前往 Yandex ID「App passwords」生成邮件专用密码",
      "填入完整邮箱地址与专用密码",
    ],
    domains: ["yandex.com", "yandex.ru", "ya.ru"],
    defaultImapHost: "imap.yandex.com", defaultImapPort: 993, defaultImapSecurity: "tls",
    defaultSmtpHost: "smtp.yandex.com", defaultSmtpPort: 465, defaultSmtpSecurity: "tls",
    requiresImapId: false, autoAppendsSent: false,
  },
  {
    id: "naver", name: "Naver Mail", category: "personal",
    subtitle: "韩国 Naver 邮箱 (@naver.com) · 完整 EUC-KR 支持", badgeText: "应用密码",
    authKind: "app_password", supportsAppPassword: true, stripSecretWhitespace: false,
    guideTitle: "连接韩国 Naver Mail (@naver.com)",
    guideSummary: "内置 imap.naver.com:993 与 smtp.naver.com:465 安全预设。",
    steps: [
      "登录 mail.naver.com 在「环境设置 → POP3/IMAP 设置」中启用 IMAP/SMTP",
      "若开启两步验证，请在账户安全中心生成应用程序密码",
      "填入完整 @naver.com 地址与密码",
    ],
    domains: ["naver.com"],
    defaultImapHost: "imap.naver.com", defaultImapPort: 993, defaultImapSecurity: "tls",
    defaultSmtpHost: "smtp.naver.com", defaultSmtpPort: 465, defaultSmtpSecurity: "tls",
    requiresImapId: false, autoAppendsSent: false,
  },
  {
    id: "tencent_exmail", name: "腾讯企业邮", category: "enterprise",
    subtitle: "企业微信邮箱 · 支持自定义域名 MX 自动识别", badgeText: "客户端专用密码",
    authKind: "app_password", supportsAppPassword: true, stripSecretWhitespace: true,
    guideTitle: "连接腾讯企业邮（企业微信邮箱）",
    guideSummary: "支持自定义企业域名 MX 识别，须使用客户端专用密码登录。",
    steps: [
      "登录企业微信或 exmail.qq.com 确认已启用 IMAP/SMTP",
      "在「设置 → 邮箱绑定 / 安全登录」生成客户端专用密码",
      "输入完整企业邮箱与专用密码完成连接校验",
    ],
    domains: ["exmail.qq.com"],
    defaultImapHost: "imap.exmail.qq.com", defaultImapPort: 993, defaultImapSecurity: "tls",
    defaultSmtpHost: "smtp.exmail.qq.com", defaultSmtpPort: 465, defaultSmtpSecurity: "tls",
    requiresImapId: false, autoAppendsSent: true,
  },
  {
    id: "aliyun_exmail", name: "阿里企业邮", category: "enterprise",
    subtitle: "阿里云企业邮箱 · 支持自定义域名 MX 识别", badgeText: "三方安全密码",
    authKind: "app_password", supportsAppPassword: true, stripSecretWhitespace: false,
    guideTitle: "连接阿里云企业邮箱",
    guideSummary: "支持自定义企业域名 MX 自动识别，须开启三方客户端安全密码。",
    steps: [
      "登录阿里云企业邮箱网页端进入「设置 → 账户与安全」",
      "开启 POP3/IMAP 收发并生成「三方客户端安全密码」",
      "输入完整企业邮箱地址与安全密码",
    ],
    domains: ["qiye.aliyun.com", "aliyun.com"],
    defaultImapHost: "imap.qiye.aliyun.com", defaultImapPort: 993, defaultImapSecurity: "tls",
    defaultSmtpHost: "smtp.qiye.aliyun.com", defaultSmtpPort: 465, defaultSmtpSecurity: "tls",
    requiresImapId: false, autoAppendsSent: false,
  },
  {
    id: "netease_exmail", name: "网易灵犀企业邮", category: "enterprise",
    subtitle: "自动区分华东/华北节点 · 内置 RFC 2971 ID 握手", badgeText: "客户端授权码",
    authKind: "auth_code", supportsAppPassword: true, stripSecretWhitespace: false,
    guideTitle: "连接网易企业邮箱",
    guideSummary: "按 MX 自动区分华东 (imaphz) 与华北节点，并自动发送 RFC 2971 IMAP ID。",
    steps: [
      "登录网易企业邮箱网页端进入「设置 → 客户端设置」",
      "开启 IMAP/SMTP 服务并生成客户端授权密码",
      "输入企业邮箱地址后自动匹配区域服务器",
    ],
    domains: ["qiye.163.com"],
    defaultImapHost: "imaphz.qiye.163.com", defaultImapPort: 993, defaultImapSecurity: "tls",
    defaultSmtpHost: "smtphz.qiye.163.com", defaultSmtpPort: 465, defaultSmtpSecurity: "tls",
    requiresImapId: true, autoAppendsSent: false,
  },
  {
    id: "feishu", name: "飞书 / Lark 企业邮", category: "enterprise",
    subtitle: "自动区分飞书国内版与国际版 Lark 节点", badgeText: "第三方专用密码",
    authKind: "app_password", supportsAppPassword: true, stripSecretWhitespace: false,
    guideTitle: "连接飞书 / Lark 企业邮箱",
    guideSummary: "支持飞书 (imap.feishu.cn) 与 Lark (imap.larksuite.com) MX 自动识别。",
    steps: [
      "确认企业管理员已开启飞书邮箱第三方客户端 IMAP/SMTP 权限",
      "在飞书邮箱「设置 → 第三方客户端登录」生成专用密码",
      "输入完整企业邮箱与专用密码连接",
    ],
    domains: ["feishu.cn", "larksuite.com"],
    defaultImapHost: "imap.feishu.cn", defaultImapPort: 993, defaultImapSecurity: "tls",
    defaultSmtpHost: "smtp.feishu.cn", defaultSmtpPort: 465, defaultSmtpSecurity: "tls",
    requiresImapId: false, autoAppendsSent: false,
  },
  {
    id: "mail263", name: "263 企业邮", category: "enterprise",
    subtitle: "263 企业邮箱 · SSL/TLS 加密连接", badgeText: "客户端安全密码",
    authKind: "app_password", supportsAppPassword: true, stripSecretWhitespace: false,
    guideTitle: "连接 263 企业邮箱",
    guideSummary: "默认采用 imap.263.net:993 与 smtp.263.net:465 安全连接。",
    steps: [
      "确认 263 企业邮箱网页端已开启 IMAP/SMTP 客户端权限",
      "在账户安全设置中生成客户端专用密码",
      "输入完整企业邮箱与专用密码",
    ],
    domains: ["263.net", "263xmail.com"],
    defaultImapHost: "imap.263.net", defaultImapPort: 993, defaultImapSecurity: "tls",
    defaultSmtpHost: "smtp.263.net", defaultSmtpPort: 465, defaultSmtpSecurity: "tls",
    requiresImapId: false, autoAppendsSent: false,
  },
  {
    id: "zoho_exmail", name: "Zoho Workplace 企业邮", category: "enterprise",
    subtitle: "按 MX 自动匹配中国区 / 国际区 / 欧洲区节点", badgeText: "应用专用密码",
    authKind: "app_password", supportsAppPassword: true, stripSecretWhitespace: false,
    guideTitle: "连接 Zoho Workplace 企业邮箱",
    guideSummary: "支持 zoho.com.cn、zoho.com 与 zoho.eu 区域服务器自动识别。",
    steps: [
      "在 Zoho Mail「设置 → 邮件账户 → IMAP 访问」勾选启用 IMAP",
      "在 Zoho 账户安全中心生成应用专用密码",
      "输入企业邮箱地址与专用密码连接",
    ],
    domains: ["zoho.com.cn", "zoho.com", "zoho.eu"],
    defaultImapHost: "imappro.zoho.com.cn", defaultImapPort: 993, defaultImapSecurity: "tls",
    defaultSmtpHost: "smtppro.zoho.com.cn", defaultSmtpPort: 465, defaultSmtpSecurity: "tls",
    requiresImapId: false, autoAppendsSent: false,
  },
  {
    id: "workbuddy_agent", name: "腾讯 WorkBuddy Agent 邮箱", category: "agent",
    subtitle: "零 CLI 依赖 · 原生 HTTPS REST 轮询授权与配额感知", badgeText: "浏览器轮询授权",
    authKind: "rest_browser_poll", supportsAppPassword: false, stripSecretWhitespace: false,
    guideTitle: "连接腾讯 WorkBuddy Agent 邮箱",
    guideSummary: "通过浏览器完成官方授权轮询，独立于常规 SMTP 发件队列运行。",
    steps: [
      "点击发起授权并在浏览器打开官方验证链接",
      "完成登录后系统自动轮询绑定智能体邮箱别名与每日配额",
      "仅在独立 Agent 命名空间内读写邮件与两步确认删除",
    ],
    domains: [],
    defaultImapHost: "", defaultImapPort: 993, defaultImapSecurity: "tls",
    defaultSmtpHost: "", defaultSmtpPort: 465, defaultSmtpSecurity: "tls",
    requiresImapId: false, autoAppendsSent: true,
  },
  {
    id: "muse_agent", name: "Meta Muse Mail (@muse.ai)", category: "agent",
    subtitle: "仅限本地核心/桌面 · Noise XX + Protobuf WSS 纯内存只读", badgeText: "本机内存只读",
    authKind: "local_webview_session", supportsAppPassword: false, stripSecretWhitespace: false,
    guideTitle: "连接 Meta Muse Mail (@muse.ai)",
    guideSummary: "通过官方会话换取瞬时网关凭证建立加密只读通道，断开或退出即刻销毁。",
    steps: [
      "在本地桌面环境完成 @muse.ai 官方会话验证",
      "经 Noise XX 加密网关只读浏览会话列表与正文",
      "不落盘数据库、不混入统一收件箱、AI 或发件队列",
    ],
    domains: ["muse.ai"],
    defaultImapHost: "", defaultImapPort: 993, defaultImapSecurity: "tls",
    defaultSmtpHost: "", defaultSmtpPort: 465, defaultSmtpSecurity: "tls",
    requiresImapId: false, autoAppendsSent: false,
  },
  {
    id: "imap_custom", name: "通用 IMAP / SMTP 邮局", category: "custom",
    subtitle: "兼容 Mailcow、Poste.io、Stalwart、Postfix/Dovecot 等标准邮局", badgeText: "标准协议",
    authKind: "password", supportsAppPassword: true, stripSecretWhitespace: false,
    guideTitle: "手动配置通用 IMAP / SMTP",
    guideSummary: "自定义 IMAP 与 SMTP 主机、端口与加密模式，支持 MX 自动推断。",
    steps: [
      "填写完整邮箱地址（可点击 MX 识别自动预填主机）",
      "核对 IMAP (993 TLS / 143 STARTTLS) 与 SMTP (465 TLS / 587 STARTTLS)",
      "运行四步连接诊断验证收发认证",
    ],
    domains: [],
    defaultImapHost: "", defaultImapPort: 993, defaultImapSecurity: "tls",
    defaultSmtpHost: "", defaultSmtpPort: 465, defaultSmtpSecurity: "tls",
    requiresImapId: false, autoAppendsSent: false,
  },
];

export function listMailProviderPresets(includeLocalOnly = true): MailProviderPreset[] {
  return PRESETS.filter((preset) => includeLocalOnly || preset.id !== "muse_agent").map((preset) => ({ ...preset }));
}

export function getMailProviderPresetById(id: string): MailProviderPreset | undefined {
  const normalized = id.trim().toLowerCase();
  const found = PRESETS.find((preset) => preset.id === normalized);
  return found ? { ...found } : undefined;
}

function hasHostSuffix(host: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function customizeNeteaseDomain(preset: MailProviderPreset, domain: string): MailProviderPreset {
  if (domain === "126.com" || domain === "vip.126.com") {
    return { ...preset, defaultImapHost: `imap.${domain}`, defaultSmtpHost: `smtp.${domain}` };
  }
  if (domain === "yeah.net") {
    return { ...preset, defaultImapHost: "imap.yeah.net", defaultSmtpHost: "smtp.yeah.net" };
  }
  if (domain === "188.com" || domain === "vip.163.com") {
    return { ...preset, defaultImapHost: `imap.${domain}`, defaultSmtpHost: `smtp.${domain}` };
  }
  return preset;
}

export function matchProviderPresetByMxHost(rawExchange: string): MailProviderPreset | undefined {
  const mx = rawExchange.trim().toLowerCase().replace(/\.+$/, "");
  if (!mx) return undefined;
  const withVia = (id: string, overrides?: Partial<MailProviderPreset>): MailProviderPreset | undefined => {
    const base = getMailProviderPresetById(id);
    return base ? { ...base, ...overrides, detectedVia: mx } : undefined;
  };
  if (hasHostSuffix(mx, ["exmail.qq.com", "mxbiz1.qq.com", "mxbiz2.qq.com"])) return withVia("tencent_exmail");
  if (hasHostSuffix(mx, ["qiye.aliyun.com", "mxhichina.com"])) return withVia("aliyun_exmail");
  if (hasHostSuffix(mx, ["mxmail.netease.com", "qiye.163.com"])) {
    const north = !mx.includes("hzmx");
    return withVia("netease_exmail", north
      ? { defaultImapHost: "imap.qiye.163.com", defaultSmtpHost: "smtp.qiye.163.com" }
      : undefined);
  }
  if (hasHostSuffix(mx, ["feishu.cn"])) return withVia("feishu");
  if (hasHostSuffix(mx, ["larksuite.com"])) {
    return withVia("feishu", { defaultImapHost: "imap.larksuite.com", defaultSmtpHost: "smtp.larksuite.com" });
  }
  if (hasHostSuffix(mx, ["263xmail.com", "263.net"])) return withVia("mail263");
  if (hasHostSuffix(mx, ["zoho.com.cn"])) return withVia("zoho_exmail");
  if (hasHostSuffix(mx, ["zoho.eu"])) {
    return withVia("zoho_exmail", { defaultImapHost: "imappro.zoho.eu", defaultSmtpHost: "smtppro.zoho.eu" });
  }
  if (hasHostSuffix(mx, ["zoho.com"])) {
    return withVia("zoho_exmail", { defaultImapHost: "imappro.zoho.com", defaultSmtpHost: "smtppro.zoho.com" });
  }
  if (hasHostSuffix(mx, ["mail.protection.outlook.com"])) return withVia("outlook");
  if (hasHostSuffix(mx, ["google.com", "googlemail.com"])) return withVia("gmail");
  if (hasHostSuffix(mx, ["linux.do"])) return withVia("linuxdo");
  return undefined;
}

export function detectMailProviderPreset(
  emailOrDomain: string,
  mxRecords: readonly MailMxRecordInput[] = [],
): MailProviderPreset | undefined {
  const cleaned = emailOrDomain.trim().toLowerCase();
  const atIndex = cleaned.lastIndexOf("@");
  const domain = (atIndex >= 0 ? cleaned.slice(atIndex + 1) : cleaned).replace(/\.+$/, "");
  if (domain) {
    for (const preset of PRESETS) {
      if (preset.id === "muse_agent") continue;
      if (preset.domains.includes(domain)) {
        const matched = preset.id === "netease" ? customizeNeteaseDomain(preset, domain) : { ...preset };
        if (domain === "larksuite.com" && matched.id === "feishu") {
          matched.defaultImapHost = "imap.larksuite.com";
          matched.defaultSmtpHost = "smtp.larksuite.com";
        }
        if (domain === "zoho.com" && matched.id === "zoho_exmail") {
          matched.defaultImapHost = "imappro.zoho.com";
          matched.defaultSmtpHost = "smtppro.zoho.com";
        }
        if (domain === "zoho.eu" && matched.id === "zoho_exmail") {
          matched.defaultImapHost = "imappro.zoho.eu";
          matched.defaultSmtpHost = "smtppro.zoho.eu";
        }
        return { ...matched, detectedVia: `domain:${domain}` };
      }
    }
  }
  const sortedMx = [...mxRecords]
    .filter((entry) => entry && typeof entry.exchange === "string" && entry.exchange.trim() !== "")
    .sort((left, right) => left.priority - right.priority);
  for (const record of sortedMx) {
    const matched = matchProviderPresetByMxHost(record.exchange);
    if (matched) return matched;
  }
  return undefined;
}

export function shouldSendRfc2971ImapId(imapHost: string, advertisedCapabilities: readonly string[] = []): boolean {
  const host = imapHost.trim().toLowerCase();
  if (advertisedCapabilities.some((cap) => cap.trim().toUpperCase() === "ID")) return true;
  return hasHostSuffix(host, ["163.com", "126.com", "yeah.net", "188.com", "netease.com"]);
}

export function buildRfc2971ImapIdCommandArgs(clientName = "EasyEmail", version = "1.0.0"): string {
  const safe = (value: string) => value.replace(/["\\\r\n\x00]/g, "").slice(0, 64) || "EasyEmail";
  return `("name" "${safe(clientName)}" "version" "${safe(version)}" "vendor" "${safe(clientName)} Client" "support-email" "support@easyemail.local")`;
}

export function normalizeProviderAppSecret(providerIdOrEmail: string, rawSecret: string): string {
  const preset = getMailProviderPresetById(providerIdOrEmail) ?? detectMailProviderPreset(providerIdOrEmail);
  if (!preset || !preset.stripSecretWhitespace) return rawSecret;
  const compact = rawSecret.replace(/\s+/g, "");
  return /^[A-Za-z0-9]{16}$/.test(compact) ? compact : rawSecret;
}

export function buildMailProbeAdvice(stage: MailProbeStage, providerId?: string): string {
  const id = providerId?.trim().toLowerCase() ?? "";
  if (stage === "dns") {
    return "无法连接服务器主机或端口：请核对主机名拼写、防火墙策略及端口（IMAP SSL 为 993 / STARTTLS 为 143；SMTP SSL 为 465 / STARTTLS 为 587）。";
  }
  if (stage === "tls") {
    return "TLS 安全握手未通过：请确认端口与加密方式匹配（993/465 对应直接 TLS，143/587 对应 STARTTLS），且服务器证书有效。";
  }
  if (stage === "smtp") {
    return "收件通道可用但发件 SMTP 认证失败：请检查发件主机端口（465 TLS 或 587 STARTTLS）及网页端是否已启用 SMTP 发信权限。";
  }
  if (id === "qq" || id === "netease" || id === "netease_exmail") {
    return "IMAP 认证被拒绝：请确认已在邮箱网页端开启 IMAP/SMTP 服务，并填写客户端授权码而非网页登录密码。";
  }
  if (id === "icloud") {
    return "IMAP 认证被拒绝：Apple iCloud 必须使用 account.apple.com 生成的 xxxx-xxxx-xxxx-xxxx 应用专用密码。";
  }
  if (id === "gmail") {
    return "IMAP 认证被拒绝：请使用 Google OAuth 授权，或填写两步验证下生成的 16 位应用专用密码。";
  }
  if (id === "linuxdo") {
    return "IMAP 认证被拒绝：请核对完整 @linux.do 邮箱地址与社区邮箱专用密码。";
  }
  return "IMAP 认证未通过：请核对完整邮箱用户名与应用专用密码/授权码，并确认服务端已开启 IMAP 访问。";
}
