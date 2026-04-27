// ==UserScript==
// @name         EasyEmail Browser Runtime
// @namespace    local.easyemail.runtime
// @version      1.5.2
// @description  JS easyproxy runtime in browser: quick mailbox + OTP helper with local provider runtime.
// @match        *://*/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_PREFIX = 'easyemail.runtime.';
  const LOCAL_SECRET_PREFIX = '__LOCAL_SECRET_';
  const IMPORT_CODE_PREFIX = 'easyemail-import-v1.';
  const IMPORT_SYNC_INTERVAL_MS_DEFAULT = 2 * 60 * 60 * 1000;
  const IMPORT_STATE_STORAGE_KEY = 'importState';
  const IMPORT_PROMPT_STATE_STORAGE_KEY = 'importPromptState';
  const IMPORT_MANAGED_SETTING_KEYS = Object.freeze([
    'cloudflare_baseUrl',
    'cloudflare_customAuth',
    'cloudflare_adminAuth',
    'cloudflare_preferredDomain',
    'moemail_baseUrl',
    'moemail_apiKey',
    'moemail_expiryTimeMs',
    'gptmail_baseUrl',
    'gptmail_apiKey',
    'im215_baseUrl',
    'im215_apiKey',
  ]);
  const DEFAULTS = {
    locale: 'zh-CN',
    providerMode: 'auto',
    explicitProviderKey: 'cloudflare_temp_email',
    configProviderKey: 'cloudflare_temp_email',
    manualQueryEmail: '',
    selectedProvidersCsv: 'cloudflare_temp_email,mailtm,duckmail,guerrillamail,tempmail-lol,etempmail,tmailor,moemail,m2u,gptmail,im215',
    pollSeconds: '3',
    timeoutSeconds: '180',
    fromContains: '',
    newestFirst: 'true',
    autoFillEmailOnOpen: 'false',
    autoFillCodeOnRead: 'false',
    forceFillNonEmpty: 'false',
    highlightTargets: 'false',
    cloudflare_enabled: 'true',
    cloudflare_baseUrl: 'https://mail.aiaimimi.com',
    cloudflare_customAuth: '__LOCAL_SECRET_CLOUDFLARE_CUSTOM_AUTH__',
    cloudflare_adminAuth: '__LOCAL_SECRET_CLOUDFLARE_ADMIN_AUTH__',
    cloudflare_preferredDomain: '',
    mailtm_enabled: 'true',
    mailtm_baseUrl: 'https://api.mail.tm',
    mailtm_preferredDomain: '',
    duckmail_enabled: 'true',
    duckmail_baseUrl: 'https://api.duckmail.sbs',
    duckmail_preferredDomain: '',
    tempmailLol_enabled: 'true',
    tempmailLol_baseUrl: 'https://api.tempmail.lol/v2',
    etempmail_enabled: 'true',
    etempmail_baseUrl: 'https://etempmail.com',
    etempmail_preferredDomain: '',
    guerrillamail_enabled: 'true',
    guerrillamail_apiBase: 'https://api.guerrillamail.com/ajax.php',
    guerrillamail_preferredDomain: '',
    moemail_enabled: 'true',
    moemail_baseUrl: 'https://sall.cc',
    moemail_apiKey: '__LOCAL_SECRET_MOEMAIL_API_KEY__',
    moemail_preferredDomain: '',
    moemail_expiryTimeMs: '3600000',
    m2u_enabled: 'true',
    m2u_baseUrl: 'https://api.m2u.io',
    m2u_preferredDomain: 'edu.kg',
    gptmail_enabled: 'false',
    gptmail_baseUrl: 'https://mail.chatgpt.org.uk',
    gptmail_apiKey: 'gpt-test',
    gptmail_prefix: '',
    tmailor_enabled: 'true',
    tmailor_baseUrl: 'https://tmailor.com',
    tmailor_accessToken: '',
    im215_enabled: 'false',
    im215_baseUrl: 'https://maliapi.215.im/v1',
    im215_apiKey: '__LOCAL_SECRET_IM215_API_KEY__',
    im215_preferredDomain: '',
  };

  const PROVIDER_META = {
    cloudflare_temp_email: { zh: 'Cloudflare 临时邮箱', en: 'Cloudflare Temp Email' },
    mailtm: { zh: 'Mail.tm', en: 'Mail.tm' },
    duckmail: { zh: 'DuckMail', en: 'DuckMail' },
    guerrillamail: { zh: 'GuerrillaMail', en: 'GuerrillaMail' },
    'tempmail-lol': { zh: 'Tempmail.lol', en: 'Tempmail.lol' },
    etempmail: { zh: 'eTempMail', en: 'eTempMail' },
    moemail: { zh: 'MoEmail', en: 'MoEmail' },
    m2u: { zh: 'MailToYou', en: 'MailToYou' },
    gptmail: { zh: 'GPT Mail', en: 'GPT Mail' },
    tmailor: { zh: 'Tmailor', en: 'Tmailor' },
    im215: { zh: '215.im', en: '215.im' },
  };

  const CLOUDFLARE_DOMAIN_LIBRARY = Object.freeze({
    exactDomains: Object.freeze([
      'aiaimimi.com',
      'mail.aiaimimi.com',
    ]),
    randomSubdomainRoots: Object.freeze([
      'aiaiai.cc.cd',
      'aiaiai.us.ci',
      'aiaimimi.cc.cd',
      'aiaimimi.us.ci',
      'aimiaimi.cc.cd',
      'aimiaimi.us.ci',
      'artai.cc.cd',
      'artai.us.ci',
      'artcore.cc.cd',
      'arth.cc.cd',
      'arthook.cc.cd',
      'arth.us.ci',
      'artllm.cc.cd',
      'artllm.us.ci',
      'artn.cc.cd',
      'artnexus.cc.cd',
      'artnexus.us.ci',
      'artn.us.ci',
      'bigloom.us.ci',
      'happygame.us.ci',
      'jaker.us.ci',
      'loomart.cc.cd',
      'loomart.us.ci',
      'loom.cc.cd',
      'loomloom.us.ci',
      'miaimiai.cc.cd',
      'mimiaiai.cc.cd',
      'mimiaiai.us.ci',
      'mimimi.cc.cd',
      'neuro.cc.cd',
      'neurocore.cc.cd',
      'neurocore.us.ci',
      'neurollm.cc.cd',
      'neurollm.us.ci',
      'neuroloom.cc.cd',
      'neuroloom.us.ci',
      'smartloom.us.ci',
      'slime.indevs.in',
      'aiaimimi0920.indevs.in',
    ]),
  });

  const I18N = {
    'zh-CN': {
      title: '设置',
      subtitle: '',
      ready: '已就绪。点击右侧按钮，先获得邮箱，再获得验证码。',
      panel: '面板', detect: '检测', email: '邮箱', otp: '验证码', fill: '填充', stop: '停止',
      locale: '语言', auto: '自动', explicit: '指定', mode: '运行模式', strategy: '自动策略', provider: '指定服务商', configProvider: '配置服务商',
      providerPool: '自动模式候选服务商（取消勾选即剔除）', poll: '轮询间隔（秒）', timeout: '超时秒数', filter: '发件人过滤（包含）', newest: '按最新优先',
      autoFillEmail: '开邮箱后自动填邮箱', autoFillCode: '读到验证码后自动填码', overwrite: '允许覆盖已有内容', highlight: '高亮检测字段',
      current: '当前邮箱', currentEmail: '邮箱地址', currentProvider: '当前服务商', currentCode: '当前验证码', currentOpened: '打开时间',
      copyEmail: '复制邮箱', copyCode: '复制验证码', fillEmail: '填邮箱', fillCode: '填验证码',
      open: '获得邮箱', openFill: '开并填邮箱', readOnce: '读取一次', pollCode: '获得验证码', pollFill: '轮询并填码', loadMessages: '加载邮件',
      settings: '高级设置', history: '邮箱历史', messages: '原始邮件', logs: '日志', emptyHistory: '暂无邮箱历史。', emptyMessages: '暂无邮件。',
      enabled: '启用', url: '接口地址', auth: '鉴权密钥', adminAuth: '管理查询密钥（可选）', domain: '优先域名', apiKey: 'API Key', apiKeys: 'API Key（支持逗号分隔）', expiry: '邮箱有效期（毫秒）', prefix: '邮箱前缀（可选）',
      detected: '字段检测', detectedEmail: '邮箱字段', detectedCode: '验证码字段', notFound: '未找到',
      manualLookup: '手动邮箱查询', manualEmail: '邮箱地址', manualGuess: '查询能力', manualPoll: '查询轮询邮件', manualGuessUnknown: '尚未识别', manualGuessHistory: '历史会话，可直接查询', manualGuessSupported: '支持纯地址查询', manualGuessUnsupported: '不支持纯地址查询',
      widgetFillEmail: '填邮箱', widgetOpenFill: '开并填', widgetFillCode: '填验证码', widgetPoll: '轮询 OTP',
      use: '设为当前', historyRead: '读取', historyPoll: '轮询', historyMessages: '邮件', historyFill: '填邮箱',
      rawText: '文本正文', rawHtml: 'HTML 正文', rawLinks: '操作链接', openLink: '打开', copyLink: '复制链接', rawCandidates: '候选验证码', rawSource: '提取来源', none: '无', configured: '已配置', unconfigured: '未配置', disabled: '停用', minimize: '收起', expand: '展开',
      logSaved: '配置已保存。', logNoMailbox: '当前没有活动邮箱。', logNoEmailField: '当前页面没有检测到可写的邮箱输入框。', logNoCodeField: '当前页面没有检测到可写的验证码输入框。',
      logNoCode: '当前没有可填入的验证码。', logEmailFilled: '已把邮箱填入页面：{target}', logCodeFilled: '已把验证码填入页面：{target}', logCodeGroupFilled: '已把验证码拆分填入 {count} 个格子。', logDetect: '已刷新字段检测。', logOpen: '邮箱已打开：{email}（{provider}）', logTryProvider: '尝试服务商：{provider}',
      logProviderFailed: '服务商失败：{provider} -> {detail}', logProviderCooling: '服务商 {provider} 仍在冷却中，还需约 {seconds} 秒。', logRead: '已读到验证码：{code}', logReadNone: '当前尚未读到验证码。', logMessages: '已加载 {count} 封邮件。',
      logSleep: '未读到验证码，{seconds} 秒后继续轮询。', logPollStopped: '轮询已停止。', logCopyEmail: '已复制邮箱。', logCopyCode: '已复制验证码。', logCopyLink: '已复制链接。', logPollTimeout: '轮询超时：{provider} 在 {seconds} 秒内未读到符合条件的验证码。', logReadHistoricalOnly: '检测到的验证码邮件早于本次开邮箱时间，已忽略历史验证码。',
      logHistorySelected: '已切换到历史邮箱：{email}', logNoProvider: '没有可用的服务商，请先启用并配置至少一家 provider。', logMailboxNotFound: '未找到对应的邮箱历史记录。', logManualGuess: '已识别邮箱 {email} 的服务商为 {provider}。', logManualUnsupported: '{provider} 暂不支持仅凭邮箱地址手动查询，请先通过脚本获得该邮箱。', logManualUnknown: '无法识别邮箱 {email} 对应的服务商。', logManualPolling: '开始手动轮询邮箱：{email}（{provider}）',
    },
    'en-US': {
      title: 'Settings', subtitle: '', ready: 'Ready. Use the side buttons: get email first, then get code.',
      panel: 'Panel', detect: 'Detect', email: 'Email', otp: 'OTP', fill: 'Fill', stop: 'Stop',
      locale: 'Language', auto: 'Auto', explicit: 'Specified', mode: 'Mode', strategy: 'Strategy', provider: 'Provider', configProvider: 'Provider config', providerPool: 'Auto candidate providers (uncheck to exclude)', poll: 'Poll interval (s)', timeout: 'Timeout (s)', filter: 'Sender filter', newest: 'Newest first',
      autoFillEmail: 'Auto fill email after open', autoFillCode: 'Auto fill OTP after read', overwrite: 'Allow overwrite', highlight: 'Highlight fields',
      current: 'Current Mailbox', currentEmail: 'Email', currentProvider: 'Provider', currentCode: 'Current OTP', currentOpened: 'Opened At',
      copyEmail: 'Copy Email', copyCode: 'Copy Code', fillEmail: 'Fill Email', fillCode: 'Fill Code',
      open: 'Get Email', openFill: 'Open + Fill', readOnce: 'Read Once', pollCode: 'Get Code', pollFill: 'Poll + Fill', loadMessages: 'Load Messages',
      settings: 'Advanced Settings', history: 'Mailbox History', messages: 'Raw Mail', logs: 'Logs', emptyHistory: 'No mailbox history yet.', emptyMessages: 'No messages.',
      enabled: 'Enabled', url: 'Base URL', auth: 'Auth Secret', adminAuth: 'Admin Lookup Secret (optional)', domain: 'Preferred Domain', apiKey: 'API Key', apiKeys: 'API Keys (comma separated)', expiry: 'Expiry (ms)', prefix: 'Mailbox Prefix (optional)',
      detected: 'Detected Fields', detectedEmail: 'Email Field', detectedCode: 'OTP Field', notFound: 'Not found',
      manualLookup: 'Manual mailbox lookup', manualEmail: 'Email address', manualGuess: 'Lookup capability', manualPoll: 'Lookup and poll', manualGuessUnknown: 'Unknown', manualGuessHistory: 'History session, ready to query', manualGuessSupported: 'Direct email-only lookup supported', manualGuessUnsupported: 'Direct email-only lookup unsupported',
      widgetFillEmail: 'Fill Email', widgetOpenFill: 'Open + Fill', widgetFillCode: 'Fill Code', widgetPoll: 'Poll OTP',
      use: 'Use', historyRead: 'Read', historyPoll: 'Poll', historyMessages: 'Messages', historyFill: 'Fill Email',
      rawText: 'Text Body', rawHtml: 'HTML Body', rawLinks: 'Action Links', openLink: 'Open', copyLink: 'Copy Link', rawCandidates: 'OTP Candidates', rawSource: 'Source', none: 'None', configured: 'Configured', unconfigured: 'Unconfigured', disabled: 'Disabled', minimize: 'Minimize', expand: 'Expand',
      logSaved: 'Settings saved.', logNoMailbox: 'No active mailbox.', logNoEmailField: 'No writable email field found.', logNoCodeField: 'No writable OTP field found.', logNoCode: 'No OTP available yet.', logEmailFilled: 'Filled email field: {target}', logCodeFilled: 'Filled OTP field: {target}', logCodeGroupFilled: 'Filled OTP across {count} segmented fields.', logDetect: 'Field detection refreshed.',
      logOpen: 'Mailbox opened: {email} ({provider})', logTryProvider: 'Trying provider: {provider}', logProviderFailed: 'Provider failed: {provider} -> {detail}', logProviderCooling: 'Provider {provider} is cooling down for about {seconds}s more.', logRead: 'OTP received: {code}', logReadNone: 'No OTP extracted yet.', logMessages: 'Loaded {count} messages.',
      logSleep: 'No OTP yet, retrying in {seconds}s.', logPollStopped: 'Polling stopped.', logCopyEmail: 'Email copied.', logCopyCode: 'OTP copied.', logCopyLink: 'Link copied.', logPollTimeout: 'Polling timed out: {provider} did not yield a matching OTP within {seconds}s.', logReadHistoricalOnly: 'A code was found only in mail that predates this mailbox opening, so historical OTPs were ignored.', logHistorySelected: 'Selected mailbox: {email}', logNoProvider: 'No available providers. Configure at least one provider.', logMailboxNotFound: 'Mailbox history entry not found.', logManualGuess: 'Detected provider for {email}: {provider}.', logManualUnsupported: '{provider} does not support manual lookup by email only. Open this mailbox with the script first.', logManualUnknown: 'Unable to detect the provider for {email}.', logManualPolling: 'Manual polling started for {email} ({provider}).',
    },
  };

  let globalListenersBound = false;
  let importSyncTimer = 0;

  const state = {
    busy: false,
    polling: false,
    stopRequested: false,
    currentMailboxId: '',
    mailboxHistory: [],
    providerStats: {},
    currentMessages: [],
    currentMessageId: '',
    historyDetailMode: 'code',
    providerDomainCache: {},
    lastCode: '',
    logs: [],
    detectedTargets: { email: null, code: [], kind: 'single' },
  };

  const miniChipTimers = { email: 0, code: 0 };

  function sk(key) { return `${STORAGE_PREFIX}${key}`; }
  function loadSetting(key) { try { const value = GM_getValue(sk(key), DEFAULTS[key]); return value === undefined ? DEFAULTS[key] : value; } catch { return DEFAULTS[key]; } }
  function saveSetting(key, value) { GM_setValue(sk(key), value); }
  function loadScopedValue(key, fallback = '') { try { const value = GM_getValue(sk(key), fallback); return value === undefined ? fallback : value; } catch { return fallback; } }
  function saveScopedValue(key, value) { GM_setValue(sk(key), value); }
  function isLocalSecretPlaceholder(value) { return String(value || '').startsWith(LOCAL_SECRET_PREFIX) && String(value || '').endsWith('__'); }
  function seedMissingSettings() {
    const legacyDefaultProviderPool = 'cloudflare_temp_email,mailtm,duckmail,guerrillamail,tempmail-lol,etempmail,tmailor,moemail,gptmail,im215';
    const secretKeys = ['cloudflare_customAuth', 'cloudflare_adminAuth', 'moemail_apiKey', 'gptmail_apiKey', 'im215_apiKey'];
    secretKeys.forEach((key) => {
      const seeded = String(DEFAULTS[key] || '').trim();
      if (!seeded || isLocalSecretPlaceholder(seeded)) return;
      const current = String(loadSetting(key) || '').trim();
      if (current !== seeded) saveSetting(key, seeded);
    });
    const selectedProviders = String(loadSetting('selectedProvidersCsv') || '').trim();
    if (!selectedProviders || selectedProviders === legacyDefaultProviderPool) {
      saveSetting('selectedProvidersCsv', DEFAULTS.selectedProvidersCsv);
    }
  }
  async function copyText(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text, 'text');
        return true;
      }
    } catch {}
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', 'readonly');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      textarea.style.pointerEvents = 'none';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      return ok;
    } catch {
      return false;
    }
  }
  function loadJson(key, fallback) { const raw = GM_getValue(sk(key), ''); if (!raw || typeof raw !== 'string') return fallback; try { return JSON.parse(raw); } catch { return fallback; } }
  function saveJson(key, value) { GM_setValue(sk(key), JSON.stringify(value)); }
  function loadImportState() { return loadJson(IMPORT_STATE_STORAGE_KEY, {}); }
  function saveImportState(value) { saveJson(IMPORT_STATE_STORAGE_KEY, value || {}); }
  function loadImportPromptState() { return loadJson(IMPORT_PROMPT_STATE_STORAGE_KEY, {}); }
  function saveImportPromptState(value) { saveJson(IMPORT_PROMPT_STATE_STORAGE_KEY, value || {}); }
  function currentLocale() { const requested = String(loadSetting('locale') || DEFAULTS.locale); return I18N[requested] ? requested : 'zh-CN'; }
  function bundle() { return I18N[currentLocale()] || I18N['zh-CN']; }
  function interpolate(text, vars) { return String(text).replace(/\{([^}]+)\}/g, (_, name) => vars && vars[name] !== undefined ? String(vars[name]) : ''); }
  function t(key, vars) { const value = bundle()[key] || I18N['zh-CN'][key] || key; return vars ? interpolate(value, vars) : value; }
  function providerLabel(key) { const meta = PROVIDER_META[key]; return !meta ? key : (currentLocale() === 'zh-CN' ? meta.zh : meta.en); }
  function randomHex(length) { const bytes = new Uint8Array(Math.ceil(length / 2)); crypto.getRandomValues(bytes); return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, length); }
  function randomString(length) { const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'; let out = ''; while (out.length < length) { const bytes = new Uint8Array(length); crypto.getRandomValues(bytes); for (const b of bytes) { out += alphabet[b % alphabet.length]; if (out.length >= length) break; } } return out.slice(0, length); }
  function nowStamp() { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; }
  function normalizeUrl(value) { return String(value || '').trim().replace(/\/$/, ''); }
  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function asJson(text, fallback = {}) { try { return JSON.parse(text); } catch { return fallback; } }
  function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function normalizeText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
  function normalizeEmailAddress(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : '';
  }
  function getEmailDomain(email) {
    const normalized = normalizeEmailAddress(email);
    return normalized ? normalized.split('@')[1] || '' : '';
  }
  function splitConfiguredKeys(value) {
    return String(value || '')
      .split(/[\s,;\r\n]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  function readValueString(value) { if (typeof value === 'string') { const normalized = value.trim(); return normalized || undefined; } if (typeof value === 'number' && Number.isFinite(value)) return String(value); if (Array.isArray(value)) { const joined = value.map((item) => String(item)).join('\n').trim(); return joined || undefined; } return undefined; }
  function readValueRecord(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function readValueRecordList(value) { return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : []; }
  function readSenderValue(value) { if (typeof value === 'string') return normalizeText(value) || undefined; if (value && typeof value === 'object' && !Array.isArray(value)) { const record = value; return readValueString(record.address) || readValueString(record.email) || readValueString(record.name) || readValueString(record.username) || readValueString(record.mail); } return undefined; }
  function readBool(key) { return String(loadSetting(key)) === 'true'; }
  function readImportSyncEnabled() {
    const stateRecord = loadImportState();
    if (typeof stateRecord.syncEnabled === 'boolean') return stateRecord.syncEnabled;
    return true;
  }
  function currentImportCode() {
    const stateRecord = loadImportState();
    return String(stateRecord.importCode || '').trim();
  }
  function hasAnyStoredUserSettings() {
    return Object.keys(DEFAULTS).some((key) => loadScopedValue(key, undefined) !== undefined);
  }
  function refreshRuntimeUi() {
    createPanel();
    createMiniBar();
    updateMiniBarVisibility();
    attachEvents();
  }
  function rebuildUi() { refreshRuntimeUi(); }
  function setStatus(text, tone = 'neutral') { const node = document.getElementById('eep-status'); if (node) { node.dataset.tone = tone; node.textContent = text; } const mini = document.getElementById('eep-mini-status'); if (mini) mini.textContent = text; }
  function logLine(text, level = 'info') { const message = `[${nowStamp()}] ${text}`; state.logs = [message, ...(Array.isArray(state.logs) ? state.logs : [])].slice(0, 200); const node = document.getElementById('eep-log'); if (node) node.textContent = state.logs.join('\n'); if (level === 'error') setStatus(text, 'error'); }
  function setJsonOutput(value) { const node = document.getElementById('eep-json'); if (node) node.textContent = JSON.stringify(value ?? {}, null, 2); }
  function getSettings() { const out = {}; Object.keys(DEFAULTS).forEach((key) => { out[key] = loadSetting(key); }); return out; }
  function currentMailbox() { return state.currentMailboxId ? state.mailboxHistory.find((item) => item.id === state.currentMailboxId) || null : null; }
  function saveMailboxHistory() { saveJson('mailboxHistory', state.mailboxHistory); saveSetting('currentMailboxId', state.currentMailboxId || ''); renderMailboxSummary(); renderMailboxHistory(); updateMiniSummary(); }
  function upsertMailbox(entry) { const idx = state.mailboxHistory.findIndex((item) => item.id === entry.id); if (idx >= 0) state.mailboxHistory.splice(idx, 1, entry); else state.mailboxHistory.unshift(entry); state.mailboxHistory = state.mailboxHistory.slice(0, 30); state.currentMailboxId = entry.id; saveMailboxHistory(); }
  function providerStat(providerKey) {
    if (!state.providerStats[providerKey] || typeof state.providerStats[providerKey] !== 'object') state.providerStats[providerKey] = {};
    const stat = state.providerStats[providerKey];
    stat.failures = Number(stat.failures || 0);
    stat.openFailures = Number(stat.openFailures || 0);
    stat.readFailures = Number(stat.readFailures || 0);
    stat.deliveryFailures = Number(stat.deliveryFailures || 0);
    stat.consecutiveFailures = Number(stat.consecutiveFailures || 0);
    stat.cooldownUntil = Number(stat.cooldownUntil || 0);
    stat.lastError = String(stat.lastError || '');
    stat.lastErrorKind = String(stat.lastErrorKind || '');
    stat.cooldownReason = String(stat.cooldownReason || '');
    stat.cooldownScope = String(stat.cooldownScope || '');
    stat.lastFailureAt = Number(stat.lastFailureAt || 0);
    stat.lastSuccessAt = Number(stat.lastSuccessAt || 0);
    stat.openSuccesses = Number(stat.openSuccesses || 0);
    stat.readSuccesses = Number(stat.readSuccesses || 0);
    stat.lastOpenAt = Number(stat.lastOpenAt || 0);
    stat.lastReadAt = Number(stat.lastReadAt || 0);
    return stat;
  }
  function saveProviderStats() { saveJson('providerStats', state.providerStats); }
  function refreshProviderStatusDisplays() {
    const settings = getSettings();
    renderSelectedProviders(settings);
    const root = document.getElementById('eep-provider-settings');
    if (root) root.innerHTML = renderProviderConfigForm(currentConfigProviderKey(settings), settings);
  }
  function isKeylessProvider(providerKey) { return ['cloudflare_temp_email', 'mailtm', 'duckmail', 'guerrillamail', 'tempmail-lol', 'etempmail', 'tmailor', 'm2u'].includes(String(providerKey || '')); }
  function nextUtcResetAt(nowMs = Date.now()) {
    const now = new Date(nowMs);
    const next = new Date(nowMs);
    next.setUTCMinutes(0, 0, 0);
    const windows = [0, 6, 12, 18];
    for (const hour of windows) {
      if (hour > now.getUTCHours()) {
        next.setUTCHours(hour, 0, 0, 0);
        return next.getTime();
      }
    }
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(0, 0, 0, 0);
    return next.getTime();
  }
  function formatCooldownUntil(epochMs) {
    const value = Number(epochMs || 0);
    if (!value) return t('none');
    try {
      return new Date(value).toLocaleString(currentLocale() === 'zh-CN' ? 'zh-CN' : 'en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
    } catch {
      return new Date(value).toISOString();
    }
  }
  function providerCoolingReasonText(providerKey) {
    const stat = providerStat(providerKey);
    const kind = String(stat.lastErrorKind || '').trim();
    if (kind === 'capacity') return currentLocale() === 'zh-CN' ? '额度或配额耗尽' : 'quota or capacity exhausted';
    if (kind === 'auth') return currentLocale() === 'zh-CN' ? '鉴权异常' : 'authentication error';
    if (kind === 'delivery') return currentLocale() === 'zh-CN' ? '投递异常' : 'delivery failure';
    if (kind === 'transient') return currentLocale() === 'zh-CN' ? '临时错误' : 'transient error';
    return stat.lastError ? stat.lastError : (currentLocale() === 'zh-CN' ? '未知原因' : 'unknown reason');
  }
  function providerCoolingSummary(providerKey) {
    const stat = providerStat(providerKey);
    if (!providerCooling(providerKey)) {
      return currentLocale() === 'zh-CN' ? '可用' : 'available';
    }
    return `${currentLocale() === 'zh-CN' ? '冷却中' : 'cooling'} · ${providerCoolingReasonText(providerKey)} · ${formatCooldownUntil(stat.cooldownUntil)}`;
  }
  function classifyErrorKind(error) {
    const message = String(error && error.message ? error.message : error || '').toLowerCase();
    if (/401|403|forbidden|unauthorized|api key|auth|permission|invalid token|missing key/.test(message)) return 'auth';
    if (/429|rate limit|rate_limited|daily_limit_exceeded|quota|too many requests|openapi access|insufficient balance|capacity/.test(message)) return 'capacity';
    if (/mailbox delivery|delivery timeout|no matching otp|no otp extracted within/.test(message)) return 'delivery';
    if (/timeout|timed out|network|gateway|econnreset|fetch failed|5\d\d/.test(message)) return 'transient';
    return 'provider';
  }
  function providerCooldownDuration(providerKey, kind, phase) {
    const isIm215 = providerKey === 'im215';
    if ((providerKey === 'duckmail' || providerKey === 'tempmail-lol') && kind === 'capacity') return Math.max(1000, nextUtcResetAt(Date.now()) - Date.now());
    if (kind === 'auth') return 15 * 60 * 1000;
    if (kind === 'capacity') return isIm215 ? 15 * 60 * 1000 : 6 * 60 * 1000;
    if (kind === 'delivery') return phase === 'poll-timeout' ? 4 * 60 * 1000 : 2 * 60 * 1000;
    if (kind === 'transient') return isIm215 ? 90 * 1000 : 45 * 1000;
    return phase === 'read' ? 75 * 1000 : 90 * 1000;
  }
  function recordProviderFailure(providerKey, error, phase = 'open') {
    const stat = providerStat(providerKey);
    const now = Date.now();
    const kind = classifyErrorKind(error);
    stat.failures += 1;
    stat.consecutiveFailures += 1;
    if (phase === 'open') stat.openFailures += 1;
    if (phase === 'read') stat.readFailures += 1;
    if (kind === 'delivery' || phase === 'poll-timeout') stat.deliveryFailures += 1;
    stat.lastError = String(error && error.message ? error.message : error || '');
    stat.lastErrorKind = kind;
    stat.cooldownReason = '';
    stat.cooldownScope = '';
    stat.lastFailureAt = now;
    stat.cooldownUntil = 0;
    saveProviderStats();
    refreshProviderStatusDisplays();
  }
  function recordProviderSuccess(providerKey, phase = 'open') {
    const stat = providerStat(providerKey);
    const now = Date.now();
    stat.failures = Math.max(0, stat.failures - 1);
    stat.consecutiveFailures = 0;
    stat.cooldownUntil = 0;
    stat.lastError = '';
    stat.lastErrorKind = '';
    stat.cooldownReason = '';
    stat.cooldownScope = '';
    stat.lastSuccessAt = now;
    if (phase === 'open') {
      stat.openSuccesses += 1;
      stat.lastOpenAt = now;
      stat.openFailures = Math.max(0, stat.openFailures - 1);
    }
    if (phase === 'read') {
      stat.readSuccesses += 1;
      stat.lastReadAt = now;
      stat.readFailures = Math.max(0, stat.readFailures - 1);
      stat.deliveryFailures = Math.max(0, stat.deliveryFailures - 1);
    }
    saveProviderStats();
    refreshProviderStatusDisplays();
  }
  function providerCooling(providerKey) { void providerKey; return false; }
  function providerCooldownRemainingMs(providerKey) { void providerKey; return 0; }
  function getCachedProviderDomains(providerKey) {
    const record = state.providerDomainCache && state.providerDomainCache[providerKey];
    if (!record || !Array.isArray(record.domains)) return [];
    return record.domains.filter(Boolean);
  }
  function getCachedProviderRootDomains(providerKey) {
    const record = state.providerDomainCache && state.providerDomainCache[providerKey];
    if (!record || !Array.isArray(record.rootDomains)) return [];
    return record.rootDomains.filter(Boolean);
  }
  function setCachedProviderDomains(providerKey, domains, rootDomains) {
    state.providerDomainCache[providerKey] = {
      loadedAt: Date.now(),
      domains: [...new Set((domains || []).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))],
      rootDomains: [...new Set((rootDomains || []).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))],
    };
  }
  function normalizeDomainEntries(entries) {
    return [...new Set((entries || []).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))];
  }
  function splitDomainEntries(entries) {
    const exactDomains = [];
    const rootDomains = [];
    for (const entry of normalizeDomainEntries(entries)) {
      if (entry.startsWith('*.')) rootDomains.push(entry.slice(2));
      else exactDomains.push(entry);
    }
    return { exactDomains, rootDomains };
  }
  function domainMatchesRoot(domain, rootDomain) {
    const normalizedDomain = String(domain || '').trim().toLowerCase();
    const normalizedRoot = String(rootDomain || '').trim().toLowerCase();
    if (!normalizedDomain || !normalizedRoot) return false;
    return normalizedDomain === normalizedRoot || normalizedDomain.endsWith(`.${normalizedRoot}`);
  }
  function domainMatchesLibrary(domain, exactDomains, rootDomains) {
    const normalizedDomain = String(domain || '').trim().toLowerCase();
    if (!normalizedDomain) return false;
    const exactSet = new Set(normalizeDomainEntries(exactDomains));
    if (exactSet.has(normalizedDomain)) return true;
    return normalizeDomainEntries(rootDomains).some((rootDomain) => domainMatchesRoot(normalizedDomain, rootDomain));
  }

  function requestAbsolute(method, url, headers, body, expectJson = true) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: headers || {},
        data: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
        timeout: 30000,
        onload: (resp) => resolve({
          status: resp.status || 0,
          text: resp.responseText || '',
          data: expectJson ? asJson(resp.responseText || '', resp.responseText || '') : (resp.responseText || ''),
          headers: resp.responseHeaders || '',
        }),
        onerror: () => reject(new Error(`Network error: ${url}`)),
        ontimeout: () => reject(new Error(`Timeout: ${url}`)),
      });
    });
  }
  function requestJsonAbsolute(method, url, headers, body) { return requestAbsolute(method, url, headers, body, true); }
  function requestTextAbsolute(method, url, headers, body) { return requestAbsolute(method, url, headers, body, false); }
  function encodeUtf8(value) { return new TextEncoder().encode(String(value)); }
  function bytesToHex(bytes) { return Array.from(bytes).map((value) => value.toString(16).padStart(2, '0')).join(''); }
  function base64UrlToText(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '==='.slice((normalized.length + 3) % 4);
    return decodeURIComponent(Array.prototype.map.call(atob(padded), (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''));
  }
  function parseImportCodePayload(importCode) {
    const text = String(importCode || '').trim();
    if (!text.startsWith(IMPORT_CODE_PREFIX)) throw new Error('Unsupported EasyEmail import code format.');
    const payload = asJson(base64UrlToText(text.slice(IMPORT_CODE_PREFIX.length)), null);
    if (!payload || payload.kind !== 'easyemail-import-code') throw new Error('Invalid EasyEmail import code payload.');
    return payload;
  }
  function encodeRfc3986(value) { return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`); }
  function toAmzDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hour = String(date.getUTCHours()).padStart(2, '0');
    const minute = String(date.getUTCMinutes()).padStart(2, '0');
    const second = String(date.getUTCSeconds()).padStart(2, '0');
    return `${year}${month}${day}T${hour}${minute}${second}Z`;
  }
  function toDateStamp(value) { return toAmzDate(value).slice(0, 8); }
  async function sha256Hex(value) {
    const bytes = value instanceof Uint8Array ? value : encodeUtf8(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return bytesToHex(new Uint8Array(digest));
  }
  async function hmacSha256(keyBytes, value) {
    const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, encodeUtf8(value));
    return new Uint8Array(signature);
  }
  async function deriveAwsV4SigningKey(secretAccessKey, dateStamp, region, service) {
    const kDate = await hmacSha256(encodeUtf8(`AWS4${secretAccessKey}`), dateStamp);
    const kRegion = await hmacSha256(kDate, region);
    const kService = await hmacSha256(kRegion, service);
    return hmacSha256(kService, 'aws4_request');
  }
  function buildR2ObjectUrl(importPayload, objectKey) {
    const baseUrl = normalizeUrl(importPayload.endpoint || `https://${importPayload.accountId}.r2.cloudflarestorage.com`);
    const encodedKey = String(objectKey || '').split('/').map((segment) => encodeRfc3986(segment)).join('/');
    return `${baseUrl}/${encodeRfc3986(importPayload.bucket)}/${encodedKey}`;
  }
  async function fetchR2ObjectText(importPayload, objectKey) {
    const requestUrl = buildR2ObjectUrl(importPayload, objectKey);
    const url = new URL(requestUrl);
    const host = url.host;
    const now = new Date();
    const amzDate = toAmzDate(now);
    const dateStamp = toDateStamp(now);
    const payloadHash = await sha256Hex('');
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = `GET\n${url.pathname}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;
    const signingKey = await deriveAwsV4SigningKey(String(importPayload.secretAccessKey || '').trim(), dateStamp, 'auto', 's3');
    const signature = bytesToHex(await hmacSha256(signingKey, stringToSign));
    const authorization = `AWS4-HMAC-SHA256 Credential=${String(importPayload.accessKeyId || '').trim()}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const response = await requestTextAbsolute('GET', requestUrl, {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      authorization,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`R2 request failed (${response.status}) for ${objectKey}`);
    }
    return String(response.text || '');
  }
  async function fetchImportManifest(importPayload) {
    const manifestObjectKey = String(importPayload.manifestObjectKey || '').trim();
    if (!manifestObjectKey) throw new Error('Import code is missing manifestObjectKey.');
    const manifestText = await fetchR2ObjectText(importPayload, manifestObjectKey);
    const manifest = asJson(manifestText, null);
    if (!manifest || typeof manifest !== 'object') throw new Error('Failed to parse EasyEmail distribution manifest.');
    return manifest;
  }
  async function fetchUserscriptSettingsFromManifest(importPayload, manifest) {
    const userscriptBlock = readValueRecord(manifest && manifest.userscript);
    const settingsEntry = readValueRecord(userscriptBlock.settings);
    const objectKey = readValueString(settingsEntry.objectKey);
    if (!objectKey) throw new Error('Distribution manifest does not contain userscript settings objectKey.');
    const settingsText = await fetchR2ObjectText(importPayload, objectKey);
    if (readValueString(settingsEntry.sha256)) {
      const actualSha256 = await sha256Hex(settingsText);
      if (actualSha256 !== readValueString(settingsEntry.sha256)) {
        throw new Error(`Userscript settings sha256 mismatch for ${objectKey}.`);
      }
    }
    const payload = asJson(settingsText, null);
    if (!payload || payload.kind !== 'easyemail-userscript-settings') throw new Error('Downloaded userscript settings payload is invalid.');
    return {
      payload,
      fingerprint: readValueString(userscriptBlock.fingerprint) || readValueString(settingsEntry.md5) || readValueString(settingsEntry.sha256) || objectKey,
    };
  }
  function normalizeImportSyncIntervalMs(payload, existingState) {
    const candidateSeconds = Number(payload && payload.syncIntervalSeconds || existingState && existingState.syncIntervalSeconds || 7200);
    return Math.max(300, Number.isFinite(candidateSeconds) ? candidateSeconds : 7200) * 1000;
  }
  function persistImportedUserscriptSettings(importCode, importPayload, manifest, settingsPayload, fingerprint, options = {}) {
    const settingsRecord = readValueRecord(settingsPayload && settingsPayload.settings);
    Object.entries(settingsRecord).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      saveSetting(key, String(value));
    });
    const previousState = loadImportState();
    const syncEnabled = options.syncEnabled === undefined ? (typeof previousState.syncEnabled === 'boolean' ? previousState.syncEnabled : Boolean(importPayload.syncEnabled !== false)) : Boolean(options.syncEnabled);
    const syncIntervalMs = normalizeImportSyncIntervalMs(importPayload, previousState);
    saveImportState({
      importCode,
      syncEnabled,
      syncIntervalSeconds: Math.floor(syncIntervalMs / 1000),
      lastSyncedAtMs: Date.now(),
      userscriptFingerprint: fingerprint,
      manifestObjectKey: String(importPayload.manifestObjectKey || ''),
      bucket: String(importPayload.bucket || ''),
      endpoint: String(importPayload.endpoint || ''),
      releaseVersion: readValueString(manifest && manifest.releaseVersion) || readValueString(importPayload.releaseVersion),
    });
    state.providerDomainCache = {};
  }
  async function importUserscriptSettings(importCode, options = {}) {
    const payload = parseImportCodePayload(importCode);
    const manifest = await fetchImportManifest(payload);
    const settingsBundle = await fetchUserscriptSettingsFromManifest(payload, manifest);
    persistImportedUserscriptSettings(importCode, payload, manifest, settingsBundle.payload, settingsBundle.fingerprint, options);
    return {
      importCode,
      payload,
      manifest,
      userscriptFingerprint: settingsBundle.fingerprint,
      settingsCount: Object.keys(readValueRecord(settingsBundle.payload.settings)).length,
    };
  }
  async function maybeSyncImportedUserscriptSettings(reason = 'sync') {
    const importState = loadImportState();
    const importCode = String(importState.importCode || '').trim();
    if (!importCode || importState.syncEnabled === false) return null;
    const intervalMs = normalizeImportSyncIntervalMs(importState, importState);
    const lastSyncedAtMs = Number(importState.lastSyncedAtMs || 0);
    if (reason !== 'force' && lastSyncedAtMs && (Date.now() - lastSyncedAtMs) < intervalMs) return null;
    const payload = parseImportCodePayload(importCode);
    const manifest = await fetchImportManifest(payload);
    const settingsBundle = await fetchUserscriptSettingsFromManifest(payload, manifest);
    if (reason !== 'force' && String(importState.userscriptFingerprint || '') === String(settingsBundle.fingerprint || '')) {
      saveImportState({ ...importState, lastSyncedAtMs: Date.now() });
      return { updated: false, userscriptFingerprint: settingsBundle.fingerprint };
    }
    persistImportedUserscriptSettings(importCode, payload, manifest, settingsBundle.payload, settingsBundle.fingerprint, { syncEnabled: importState.syncEnabled });
    return { updated: true, userscriptFingerprint: settingsBundle.fingerprint };
  }
  function scheduleImportSyncIfNeeded() {
    if (importSyncTimer) {
      clearInterval(importSyncTimer);
      importSyncTimer = 0;
    }
    const importState = loadImportState();
    if (!String(importState.importCode || '').trim() || importState.syncEnabled === false) return;
    const intervalMs = normalizeImportSyncIntervalMs(importState, importState);
    importSyncTimer = setInterval(() => {
      maybeSyncImportedUserscriptSettings('interval').then((result) => {
        if (result && result.updated) {
          refreshRuntimeUi();
          logLine(currentLocale() === 'zh-CN' ? '已从远程同步最新导入配置。' : 'Imported settings synced from remote.');
        }
      }).catch((error) => logLine(String(error && error.message ? error.message : error || 'Import sync failed.'), 'error'));
    }, intervalMs);
  }
  function readImportCodeFromLocation() {
    try {
      const url = new URL(location.href);
      return String(
        url.searchParams.get('easyemail_import_code')
        || url.searchParams.get('easyemailImportCode')
        || url.hash.replace(/^#?easyemail_import_code=/, '')
      ).trim();
    } catch {
      return '';
    }
  }
  async function promptForImportCode(messageText) {
    const entered = window.prompt(messageText, currentImportCode() || '');
    return String(entered || '').trim();
  }
  async function promptAndImportUserscriptSettings() {
    const importCode = await promptForImportCode(currentLocale() === 'zh-CN'
      ? '请输入 EasyEmail 导入码。'
      : 'Enter your EasyEmail import code.');
    if (!importCode) return null;
    const result = await importUserscriptSettings(importCode, {});
    saveImportPromptState({});
    scheduleImportSyncIfNeeded();
    refreshRuntimeUi();
    return result;
  }
  function clearImportedUserscriptBinding() {
    saveImportState({});
    saveImportPromptState({});
    scheduleImportSyncIfNeeded();
  }
  function extractResponseSetCookie(rawHeaders) {
    const text = String(rawHeaders || '');
    const matches = [...text.matchAll(/^set-cookie:\s*(.+)$/gim)].map((match) => String(match[1] || '').trim()).filter(Boolean);
    return matches.length ? matches : [];
  }
  function parseSetCookieHeader(rawSetCookie) {
    return String(rawSetCookie || '')
      .split(/,(?=\s*[A-Za-z0-9_\-]+=)/)
      .map((entry) => String(entry || '').split(';', 1)[0].trim())
      .filter(Boolean)
      .join('; ');
  }
  function extractCookieHeader(rawHeaders) {
    const cookies = extractResponseSetCookie(rawHeaders).map((entry) => parseSetCookieHeader(entry)).filter(Boolean);
    if (!cookies.length) return '';
    const pairs = new Map();
    cookies.join('; ').split(/;\s*/).forEach((entry) => {
      const parts = String(entry || '').split('=');
      const key = parts.shift();
      if (!key) return;
      pairs.set(key.trim(), `${key.trim()}=${parts.join('=').trim()}`);
    });
    return [...pairs.values()].join('; ');
  }

  function buildStatusError(providerName, phase, status, body) {
    const record = readValueRecord(body);
    const detail = readValueString(record.message) || readValueString(record.error) || readValueString(record.detail) || (typeof body === 'string' ? body.trim() : undefined);
    return new Error(`${providerName} ${phase} failed: HTTP ${status}${detail ? `. ${detail}` : ''}`);
  }
  function extractDomainsFromBody(body) {
    const roots = [body, readValueRecord(body).data, readValueRecord(body).result];
    for (const root of roots) {
      const csvField = readValueString(root && root.emailDomains) || readValueString(root && root.email_domains);
      if (csvField) {
        const domains = csvField.split(/[\s,;]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
        if (domains.length) return [...new Set(domains)];
      }
      const rows = [].concat(readValueRecordList(root && root.domains), readValueRecordList(root && root.items), readValueRecordList(root && root.list), Array.isArray(root) ? root : []);
      const domains = rows.map((item) => readValueString(item.domain) || readValueString(item.name) || readValueString(item.address)).filter(Boolean);
      if (domains.length) return [...new Set(domains.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
    }
    return [];
  }
  function readBodyErrorCode(body) {
    return readValueString(readValueRecord(body).error) || readValueString(readValueRecord(body).code) || '';
  }
  function readBodyErrorReason(body) {
    const record = readValueRecord(body);
    return readValueString(record.reason) || readValueString(record.message) || readValueString(record.detail) || '';
  }
  function buildBodyError(providerName, phase, body) {
    const errorCode = readBodyErrorCode(body) || 'unknown_error';
    const reason = readBodyErrorReason(body);
    return new Error(`${providerName} ${phase} failed: ${errorCode}${reason ? `. ${reason}` : ''}`);
  }
  function extractIm215Address(body) {
    const roots = [body, readValueRecord(body).data, readValueRecord(body).result, readValueRecord(body).account, readValueRecord(body).mailbox];
    for (const root of roots) {
      const address = readValueString(root && root.address) || readValueString(root && root.email) || readValueString(root && root.mail) || readValueString(root && root.username);
      if (address && address.includes('@')) return { address: address.trim().toLowerCase(), mailboxId: readValueString(root.id) || readValueString(root.mailboxId) || readValueString(root.accountId), domain: readValueString(root.domain) || address.split('@')[1] || '', tempToken: readValueString(root.tempToken) || readValueString(root.token) };
    }
    return undefined;
  }
  function extractIm215MessageList(body) {
    const roots = [body, readValueRecord(body).data, readValueRecord(body).result];
    for (const root of roots) {
      const rows = [].concat(readValueRecordList(root && root.messages), readValueRecordList(root && root.items), readValueRecordList(root && root.list), Array.isArray(root) ? root : []);
      if (rows.length) return rows;
    }
    return [];
  }
  function readIm215MessageId(record) { return readValueString(record.id) || readValueString(record.messageId) || readValueString(record.mailId); }
  function readIm215MessageSender(record) { return readSenderValue(record.from) || readSenderValue(record.sender) || readValueString(record.fromAddress) || readValueString(record.senderAddress); }
  function readIm215MessageSubject(record) { return readValueString(record.subject) || readValueString(record.title); }
  function readIm215MessageText(record) { return readValueString(record.text) || readValueString(record.textBody) || readValueString(record.body) || readValueString(record.content) || readValueString(record.preview) || readValueString(record.snippet) || readValueString(record.raw) || readValueString(record.rawText); }
  function readIm215MessageHtml(record) { return readValueString(record.html) || readValueString(record.htmlBody) || readValueString(record.htmlContent) || readValueString(record.rawHtml); }
  function readIm215ObservedAt(record) { return readValueString(record.receivedAt) || readValueString(record.createdAt) || readValueString(record.updatedAt) || readValueString(record.timestamp); }
  function unwrapIm215MessageRecord(body) {
    const root = readValueRecord(body);
    const nested = [readValueRecord(root.data), readValueRecord(root.result), readValueRecord(root.message)].find((item) => Object.keys(item).length);
    return Object.keys(nested || {}).length ? nested : root;
  }
  async function im215Request(cfg, method, path, options = {}) {
    const url = new URL(path.replace(/^\//, ''), normalizeUrl(cfg.baseUrl).endsWith('/') ? normalizeUrl(cfg.baseUrl) : `${normalizeUrl(cfg.baseUrl)}/`);
    Object.entries(options.query || {}).forEach(([key, value]) => { if (value !== undefined && value !== null && String(value) !== '') url.searchParams.set(key, String(value)); });
    const apiKey = String(cfg.apiKey || '').trim();
    const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
    if (apiKey) {
      if (/^AC-/i.test(apiKey)) headers['X-API-Key'] = apiKey;
      else headers.Authorization = `Bearer ${apiKey}`;
    }
    return requestJsonAbsolute(method, url.toString(), headers, options.body);
  }
  async function im215GetDomains(cfg) {
    const result = await im215Request(cfg, 'GET', '/domains');
    if (result.status !== 200) throw buildStatusError('215.im', 'domains', result.status, result.data);
    const domains = extractDomainsFromBody(result.data);
    if (!domains.length) throw new Error('215.im returned no available domains.');
    setCachedProviderDomains('im215', domains);
    return domains;
  }
  async function im215OpenMailbox(cfg) {
    const domains = await im215GetDomains(cfg);
    const preferred = String(cfg.preferredDomain || '').trim().toLowerCase();
    const domain = preferred && domains.includes(preferred) ? preferred : domains[0];
    if (!domain) throw new Error('215.im has no available domains.');
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const localPart = `${createLocalPart('i215')}-${randomString(4)}`.slice(0, 48);
      const address = `${localPart}@${domain}`;
      for (const payload of [{ prefix: localPart, domain }, { address }]) {
        const result = await im215Request(cfg, 'POST', '/accounts', { body: payload });
        if (result.status === 200 || result.status === 201) {
          const mailbox = extractIm215Address(result.data) || { address, domain };
          return { email: mailbox.address, mailboxData: mailbox, metadata: { selectedDomain: mailbox.domain || domain } };
        }
        if ([400, 409, 422].includes(result.status)) continue;
        throw buildStatusError('215.im', 'open', result.status, result.data);
      }
    }
    throw new Error('215.im mailbox creation exhausted retries.');
  }
  async function im215ListMessages(cfg, mailbox) {
    const result = await im215Request(cfg, 'GET', '/messages', { query: { address: mailbox.mailboxData.address } });
    if (result.status === 404) return [];
    if (result.status !== 200) throw buildStatusError('215.im', 'list', result.status, result.data);
    const rows = extractIm215MessageList(result.data);
    const messages = [];
    for (const row of rows) {
      const record = readValueRecord(row);
      const messageId = readIm215MessageId(record);
      const summary = normalizeObservedMessage({ id: `im215:${messageId || randomHex(6)}`, sender: readIm215MessageSender(record) || '', subject: readIm215MessageSubject(record) || '', textBody: readIm215MessageText(record) || '', htmlBody: readIm215MessageHtml(record) || '', observedAt: readIm215ObservedAt(record) || new Date().toISOString() });
      if (summary && summary.extractedCode) { messages.push(summary); continue; }
      if (!messageId) { if (summary) messages.push(summary); continue; }
      const detail = await im215Request(cfg, 'GET', `/messages/${encodeURIComponent(messageId)}`, { query: { address: mailbox.mailboxData.address } });
      if (detail.status !== 200 && detail.status !== 404) throw buildStatusError('215.im', 'detail', detail.status, detail.data);
      const info = detail.status === 200 ? unwrapIm215MessageRecord(detail.data) : record;
      messages.push(normalizeObservedMessage({ id: `im215:${messageId}`, sender: readIm215MessageSender(info) || readIm215MessageSender(record) || '', subject: readIm215MessageSubject(info) || readIm215MessageSubject(record) || '', textBody: readIm215MessageText(info) || readIm215MessageText(record) || '', htmlBody: readIm215MessageHtml(info) || readIm215MessageHtml(record) || '', observedAt: readIm215ObservedAt(info) || readIm215ObservedAt(record) || new Date().toISOString() }));
    }
    return messages.filter(Boolean);
  }

  function decodeBytesToText(bytes, preferredCharset) { const list = []; const normalized = String(preferredCharset || '').trim().toLowerCase(); if (normalized) list.push(normalized); if (!list.includes('utf-8')) list.push('utf-8'); if (!list.includes('windows-1252')) list.push('windows-1252'); for (const name of list) { try { return new TextDecoder(name, { fatal: false }).decode(bytes); } catch {} } return Array.from(bytes).map((byte) => String.fromCharCode(byte)).join(''); }
  function base64ToBytes(value) { const normalized = String(value || '').replace(/\s+/g, ''); if (!normalized) return new Uint8Array(); try { const binary = atob(normalized); const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i); return bytes; } catch { return new Uint8Array(); } }
  function extractCharset(contentType) { const match = String(contentType || '').match(/charset="?([^";]+)"?/i); return match ? match[1].trim() : 'utf-8'; }
  function decodeQuotedPrintable(value, preferredCharset) { const input = String(value || '').replace(/=\r?\n/g, ''); const bytes = []; for (let i = 0; i < input.length; i += 1) { const current = input[i]; const hex = input.slice(i + 1, i + 3); if (current === '=' && /^[0-9a-fA-F]{2}$/.test(hex)) { bytes.push(Number.parseInt(hex, 16)); i += 2; continue; } bytes.push(input.charCodeAt(i) & 0xff); } return decodeBytesToText(new Uint8Array(bytes), preferredCharset); }
  function decodeBase64Text(value, preferredCharset) { const bytes = base64ToBytes(value); return bytes.length ? decodeBytesToText(bytes, preferredCharset) : String(value || ''); }
  function decodeMimeWords(value) { return String(value || '').replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_, charset, encoding, encodedText) => String(encoding).toUpperCase() === 'B' ? decodeBase64Text(encodedText, charset) : decodeQuotedPrintable(String(encodedText).replace(/_/g, ' '), charset)); }
  function splitRawMessage(raw) { const text = String(raw || ''); const match = text.match(/\r?\n\r?\n/); if (!match || match.index === undefined) return { headerText: '', bodyText: text }; return { headerText: text.slice(0, match.index), bodyText: text.slice(match.index + match[0].length) }; }
  function parseHeaderBlock(headerText) { const headers = {}; const unfolded = String(headerText || '').replace(/\r?\n[ \t]+/g, ' '); unfolded.split(/\r?\n/).forEach((line) => { const idx = line.indexOf(':'); if (idx <= 0) return; const key = line.slice(0, idx).trim().toLowerCase(); const value = line.slice(idx + 1).trim(); if (!key) return; headers[key] = headers[key] ? `${headers[key]}, ${value}` : value; }); return headers; }
  function getMultipartBoundary(contentType) { const match = String(contentType || '').match(/boundary="?([^";]+)"?/i); return match ? match[1].trim() : ''; }
  function splitMultipartBody(bodyText, boundary) { const marker = `--${boundary}`; return String(bodyText || '').split(marker).slice(1).map((part) => part.replace(/^\r?\n/, '').replace(/\r?\n--$/, '').trim()).filter((part) => part && part !== '--'); }
  function normalizeReadableText(value) {
    const normalized = String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u2000-\u200F\u2060\uFEFF\u00AD]/g, '')
      .replace(/\r\n?/g, '\n');
    if (!normalized.trim()) return '';
    const out = [];
    let previousBlank = false;
    normalized.split('\n').forEach((line) => {
      const compact = line.replace(/\s+/g, ' ').trim();
      if (!compact) {
        if (out.length && !previousBlank) out.push('');
        previousBlank = true;
        return;
      }
      out.push(compact);
      previousBlank = false;
    });
    return out.join('\n').trim();
  }
  function htmlLooksLikeMarkup(value) { return /<\s*\/?\s*[a-z][^>]*>/i.test(String(value || '')); }
  function normalizeComparableText(value) { return normalizeReadableText(decodeHtmlEntities(String(value || ''))).toLowerCase().replace(/\s+/g, ''); }
  function textsSubstantiallyOverlap(left, right) {
    const leftComparable = normalizeComparableText(left);
    const rightComparable = normalizeComparableText(right);
    if (!leftComparable || !rightComparable) return false;
    if (leftComparable === rightComparable) return true;
    const shorter = leftComparable.length <= rightComparable.length ? leftComparable : rightComparable;
    const longer = shorter === leftComparable ? rightComparable : leftComparable;
    return shorter.length >= 32 && longer.includes(shorter) && (shorter.length / longer.length) >= 0.68;
  }
  function pickMoreCompleteText(left, right) {
    const leftText = normalizeReadableText(left);
    const rightText = normalizeReadableText(right);
    if (!leftText) return rightText;
    if (!rightText) return leftText;
    if (rightText.length !== leftText.length) return rightText.length > leftText.length ? rightText : leftText;
    const leftLineCount = leftText.split('\n').length;
    const rightLineCount = rightText.split('\n').length;
    return rightLineCount > leftLineCount ? rightText : leftText;
  }
  function mergeReadableTexts(items) {
    const merged = [];
    for (const item of items || []) {
      const text = normalizeReadableText(item);
      if (!text) continue;
      const existingIndex = merged.findIndex((entry) => textsSubstantiallyOverlap(entry, text));
      if (existingIndex >= 0) {
        merged[existingIndex] = pickMoreCompleteText(merged[existingIndex], text);
        continue;
      }
      merged.push(text);
    }
    return merged;
  }
  function pushHtmlTextChunk(chunks, value) {
    const text = String(value || '');
    if (!text) return;
    chunks.push(text);
  }
  function pushHtmlBoundary(chunks, marker = '\n') {
    if (!chunks.length) return;
    const last = String(chunks[chunks.length - 1] || '');
    if (last.endsWith(marker) || last.endsWith('\n\n')) return;
    chunks.push(marker);
  }
  function hasVisibleHtmlStyle(node) {
    const style = String(node && node.getAttribute ? node.getAttribute('style') || '' : '').replace(/\s+/g, '').toLowerCase();
    return !/(display:none|visibility:hidden|opacity:0|max-height:0|max-width:0|font-size:0|line-height:0)/.test(style);
  }
  function extractHtmlTextChunks(node, chunks) {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      pushHtmlTextChunk(chunks, node.nodeValue || '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = String(node.tagName || '').toLowerCase();
    if (!tag || /^(script|style|noscript|svg|img|meta|link|title)$/i.test(tag)) return;
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' || node.getAttribute('data-skip-in-text') === 'true' || !hasVisibleHtmlStyle(node)) return;
    if (tag === 'br' || tag === 'hr') {
      pushHtmlBoundary(chunks, '\n');
      return;
    }
    const startsBlock = /^(address|article|aside|blockquote|div|dl|dt|dd|fieldset|figcaption|figure|footer|form|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tbody|thead|tfoot|tr|ul)$/i.test(tag);
    if (startsBlock) pushHtmlBoundary(chunks, '\n');
    if (tag === 'li') pushHtmlTextChunk(chunks, '- ');
    if (tag === 'td' || tag === 'th') {
      const previous = node.previousElementSibling;
      if (previous && /^(td|th)$/i.test(String(previous.tagName || '').toLowerCase())) pushHtmlTextChunk(chunks, ' | ');
    }
    Array.from(node.childNodes || []).forEach((child) => extractHtmlTextChunks(child, chunks));
    if (/^(p|div|section|article|header|footer|li|tr|table|tbody|thead|tfoot|h[1-6]|blockquote|pre|ul|ol)$/i.test(tag)) pushHtmlBoundary(chunks, '\n');
  }
  function htmlToText(value) {
    const html = String(value || '').trim();
    if (!html) return '';
    const markup = html
      .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(?:p|div|section|article|header|footer|li|tr|table|h[1-6]|blockquote|pre|ul|ol)>/gi, '\n');
    try {
      const doc = new DOMParser().parseFromString(markup, 'text/html');
      if (doc.body) {
        const chunks = [];
        Array.from(doc.body.childNodes || []).forEach((node) => extractHtmlTextChunks(node, chunks));
        const combined = normalizeReadableText(chunks.join(''));
        if (combined) return combined;
      }
      return normalizeReadableText(doc.body ? (doc.body.innerText || doc.body.textContent || markup) : markup);
    } catch {
      const temp = document.createElement('div');
      temp.innerHTML = markup;
      return normalizeReadableText(temp.innerText || temp.textContent || markup);
    }
  }
  function decodeTransferEncodedBody(bodyText, encoding, preferredCharset) { const mode = String(encoding || '').trim().toLowerCase(); if (mode.includes('quoted-printable')) return decodeQuotedPrintable(bodyText, preferredCharset); if (mode.includes('base64')) return decodeBase64Text(bodyText, preferredCharset); return String(bodyText || ''); }
  function dedupeTexts(items) { const out = []; const seen = new Set(); for (const item of items || []) { const text = String(item || '').trim(); if (!text || seen.has(text)) continue; seen.add(text); out.push(text); } return out; }
  function mergeParsedMailParts(target, incoming) {
    if (!incoming) return target;
    target.textParts.push(...(incoming.textParts || []));
    target.htmlParts.push(...(incoming.htmlParts || []));
    return target;
  }
  function finalizeParsedMailParts(parts) {
    return {
      textParts: dedupeTexts((parts.textParts || []).map((item) => normalizeReadableText(item)).filter(Boolean)),
      htmlParts: dedupeTexts((parts.htmlParts || []).map((item) => String(item || '').trim()).filter(Boolean))
    };
  }
  function collectRawMailParts(sectionText, depth) {
    if (depth > 4) return { textParts: [], htmlParts: [] };
    const { headerText, bodyText } = splitRawMessage(sectionText);
    const headers = parseHeaderBlock(headerText);
    const contentType = String(headers['content-type'] || 'text/plain');
    const boundary = getMultipartBoundary(contentType);
    if (boundary && /multipart\//i.test(contentType)) {
      return finalizeParsedMailParts(splitMultipartBody(bodyText, boundary).reduce((acc, part) => mergeParsedMailParts(acc, collectRawMailParts(part, depth + 1)), { textParts: [], htmlParts: [] }));
    }
    const charset = extractCharset(contentType);
    const decoded = decodeTransferEncodedBody(bodyText, headers['content-transfer-encoding'], charset);
    const trimmed = String(decoded || '').trim();
    if (!trimmed) return { textParts: [], htmlParts: [] };
    const textParts = [];
    const htmlParts = [];
    if (/text\/html/i.test(contentType)) {
      htmlParts.push(trimmed);
    } else if (/text\/plain/i.test(contentType) || !/^[a-z]+\/[a-z0-9.+-]+/i.test(contentType)) {
      const text = normalizeReadableText(trimmed);
      if (text) textParts.push(text);
    } else if (/<(?:!doctype|html|body|div|p|table|tr|td|a)\b/i.test(trimmed)) {
      htmlParts.push(trimmed);
    }
    return finalizeParsedMailParts({ textParts, htmlParts });
  }
  function collectRawMailTexts(sectionText, depth) {
    const parts = collectRawMailParts(sectionText, depth);
    return mergeReadableTexts([...(parts.textParts || []), ...((parts.htmlParts || []).map((html) => htmlToText(html)).filter(Boolean))]);
  }
  function parseRawMail(raw) {
    const source = String(raw || '');
    const { headerText, bodyText } = splitRawMessage(source);
    const headers = parseHeaderBlock(headerText);
    const subject = normalizeText(decodeMimeWords(headers.subject || ''));
    const from = normalizeText(decodeMimeWords(headers.from || ''));
    const date = normalizeText(decodeMimeWords(headers.date || ''));
    const parts = collectRawMailParts(source, 0);
    const textParts = [...(parts.textParts || [])];
    const htmlParts = dedupeTexts(parts.htmlParts || []);
    if (!(textParts.length || htmlParts.length) && bodyText) {
      const fallbackSource = String(bodyText || '').trim();
      if (htmlLooksLikeMarkup(fallbackSource)) {
        htmlParts.push(fallbackSource);
        const derivedText = htmlToText(fallbackSource);
        if (derivedText) textParts.push(derivedText);
      } else {
        const fallbackText = normalizeReadableText(fallbackSource);
        if (fallbackText) textParts.push(fallbackText);
      }
    }
    const derivedHtmlTexts = htmlParts.map((html) => htmlToText(html)).filter(Boolean);
    const finalTexts = mergeReadableTexts([...textParts, ...derivedHtmlTexts]);
    const finalHtml = htmlParts.join('\n\n');
    return { subject, from, date, textBody: finalTexts.join('\n\n'), htmlBody: finalHtml, texts: finalTexts };
  }
  function decodeHtmlEntities(value) {
    const source = String(value || '');
    if (!source) return '';
    try {
      const textarea = document.createElement('textarea');
      textarea.innerHTML = source;
      return textarea.value;
    } catch {
      return source.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&#x27;/gi, '\'');
    }
  }
  function cleanCandidateUrl(value) { return String(value || '').trim().replace(/^[<(]+/, '').replace(/[>)\].,;!?]+$/, ''); }
  function sanitizeActionUrl(value) {
    const raw = decodeHtmlEntities(String(value || '')).replace(/[\u0000-\u001F\s]+/g, '').trim();
    const cleaned = cleanCandidateUrl(raw);
    if (!cleaned) return '';
    if (/^mailto:/i.test(cleaned)) return cleaned;
    try {
      const parsed = new URL(cleaned, location.href);
      return /^(https?:)$/i.test(parsed.protocol) ? parsed.toString() : '';
    } catch {
      return '';
    }
  }
  function extractTextUrls(value) {
    const source = String(value || '');
    if (!source) return [];
    const urls = [];
    [/\bhttps?:\/\/[^\s<>"']+/gi, /\bmailto:[^\s<>"']+/gi].forEach((pattern) => {
      for (const match of source.matchAll(pattern)) {
        const url = sanitizeActionUrl(match[0]);
        if (url) urls.push(url);
      }
    });
    return urls;
  }
  function summarizeActionLabel(url, label) {
    const normalizedLabel = normalizeReadableText(decodeHtmlEntities(label || ''));
    if (normalizedLabel && normalizedLabel.length <= 96 && !/^https?:\/\//i.test(normalizedLabel)) return normalizedLabel;
    try {
      const parsed = new URL(url);
      const tail = `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`.replace(/\/$/, '');
      return tail || url;
    } catch {
      return url;
    }
  }
  const ACTION_LINK_RE = /(?:verify|verification|activate|activation|confirm|complete|continue|action-code|magic|sign[\s-]*in|login|reset|approve|appeal|unlock|join|access)/i;
  const NOISY_LINK_RE = /(?:twitter\.com|linkedin\.com|youtube\.com|instagram\.com|unsubscribe|public\/images|logo-primary|email\.mg\.|pixel|tracking)/i;
  function linkPriority(link) {
    const haystack = `${String(link.url || '')}\n${String(link.label || '')}`;
    let score = 0;
    if (ACTION_LINK_RE.test(haystack)) score += 60;
    if (/replit\.com\/action-code/i.test(link.url || '')) score += 120;
    if (/docs\./i.test(link.url || '')) score += 12;
    if (/^mailto:/i.test(link.url || '')) score += 10;
    if (NOISY_LINK_RE.test(link.url || '')) score -= 120;
    if (/https?:\/\/[^/]+\/?$/i.test(link.url || '')) score -= 60;
    if (link.label && link.label !== link.url) score += 4;
    return score;
  }
  function extractLinksFromHtml(html) {
    const source = String(html || '');
    if (!source.trim()) return [];
    const links = [];
    const seen = new Set();
    const push = (href, label) => {
      const url = sanitizeActionUrl(href);
      if (!url || seen.has(url)) return;
      seen.add(url);
      links.push({ url, label: summarizeActionLabel(url, label) });
    };
    if (typeof DOMParser !== 'undefined') {
      try {
        const doc = new DOMParser().parseFromString(source, 'text/html');
        Array.from(doc.querySelectorAll('a[href]')).forEach((node) => push(node.getAttribute('href') || '', node.textContent || ''));
      } catch {}
    }
    for (const match of source.matchAll(/<a\b[^>]*href=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
      push(match[1] || match[2] || match[3] || '', htmlToText(match[4] || ''));
    }
    return links;
  }
  function extractMessageLinks(message) {
    const seen = new Set();
    const links = [];
    const push = (url, label) => {
      const normalizedUrl = sanitizeActionUrl(url);
      if (!normalizedUrl || seen.has(normalizedUrl)) return;
      seen.add(normalizedUrl);
      links.push({ url: normalizedUrl, label: summarizeActionLabel(normalizedUrl, label) });
    };
    extractLinksFromHtml(message && message.htmlBody).forEach((link) => push(link.url, link.label));
    extractTextUrls(message && message.textBody).forEach((url) => push(url, url));
    extractTextUrls(message && message.subject).forEach((url) => push(url, url));
    return links
      .map((link) => ({ ...link, priority: linkPriority(link) }))
      .filter((link) => link.priority > -40)
      .sort((a, b) => b.priority - a.priority || a.url.length - b.url.length)
      .slice(0, 8)
      .map(({ priority, ...link }) => link);
  }

  const NUMERIC_CODE_RE = /(?<![A-Za-z0-9])(\d{4,10})(?![A-Za-z0-9])/g;
  const ALPHANUMERIC_CODE_RE = /(?<![A-Za-z0-9])([A-Za-z0-9]{5,18})(?![A-Za-z0-9])/g;
  const GROUPED_CODE_RE = /(?<![A-Za-z0-9])([A-Za-z0-9]{2,8}(?:-[A-Za-z0-9]{2,8}){1,3})(?![A-Za-z0-9])/g;
  const CONTEXT_RE = /(?:verification\s*code|verify\s*code|security\s*code|one[-\s]*time\s*(?:pass)?code|login\s*code|sign[\s-]*in\s*code|confirmation\s*code|email\s*code|otp|passcode|验证码|校验码|动态码|动态密码|口令|代码为|代码是|code\s*(?:is|:))/i;
  const VALIDITY_HINT_RE = /(?:expire|expired|expires|valid|validity|minute|minutes|min|mins|second|seconds|sec|secs|分钟|秒|有效期)/i;
  const NEGATIVE_RE = /(?:order|invoice|tracking|parcel|shipment|ticket|reference|ref\b|phone|mobile|zip|postal|amount|price|total|订单|金额|价格|快递|包裹|物流|手机号|电话|邮编|尾号|参考号)/i;
  const COLOR_STYLE_HINT_RE = /(?:color|background|border|fill|stroke|font-face|stylesheet|style=|rgba?\(|hsla?\(|#[0-9a-f]{3,8})/i;
  const HTML_TAG_RE = /<[^>]+>/g;
  const EMAIL_AROUND_CANDIDATE_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const CONTEXTUAL_NUMERIC_OTP_RE = /(?:verification\s*code|verify\s*code|security\s*code|one[-\s]*time\s*(?:pass)?code|login\s*code|sign[\s-]*in\s*code|confirmation\s*code|email\s*code|otp|passcode|验证码|校验码|动态码|动态密码|口令|代码为|代码是|enter\s+this\s+temporary\s+verification\s+code)[^0-9]{0,80}(\d{6})(?!\d)/i;
  const LETTER_ONLY_STOPWORDS = new Set(['CODE','IS','VERIFY','VERIFICATION','LOGIN','SIGNIN','PASSWORD','PASSCODE','CONFIRM','CONFIRMATION','SECURITY','EMAIL','ENTER','CONTINUE','IGNORE','TRACKING','NUMBER','EXPIRES','MINUTES','OPENAI','CHATGPT']);
  function parseDateValue(value) { const normalized = String(value || '').trim(); if (!normalized) return 0; if (/^\d{10,13}$/.test(normalized)) { const num = Number(normalized); return Number.isFinite(num) ? (normalized.length >= 13 ? num : num * 1000) : 0; } const parsed = Date.parse(normalized); return Number.isFinite(parsed) ? parsed : 0; }
  function chooseObservedAt(...candidates) { for (const candidate of candidates) { const ms = parseDateValue(candidate); if (ms > 0) return new Date(ms).toISOString(); } return ''; }
  function formatObservedAt(value) { const ms = parseDateValue(value); return ms > 0 ? new Date(ms).toLocaleString() : t('none'); }
  function escapeRegex(value) { return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function compactCandidateCode(code) { return normalizeCandidateCode(code).replace(/-/g, ''); }
  function appearsInsideEmailAddress(text, code, index) { if (!String(code || '').trim()) return false; const source = String(text || ''); const start = Math.max(0, index - 80); const end = Math.min(source.length, index + String(code || '').length + 80); const segment = source.slice(start, end); const codePattern = new RegExp(escapeRegex(String(code || '')), 'i'); return [...segment.matchAll(EMAIL_AROUND_CANDIDATE_RE)].some((match) => codePattern.test(match[0])); }
  function normalizeContent(value, source) { if (!value || !String(value).trim()) return undefined; const text = source === 'html' ? String(value).replace(HTML_TAG_RE, ' ') : String(value); const normalized = text.replace(/\s+/g, ' ').trim(); return normalized || undefined; }
  function normalizeCandidateCode(code) { return String(code || '').trim().replace(/\s+/g, '-').toUpperCase(); }
  function scoreCandidate(source, code, context, counts, uniqueCount) { let score = source === 'subject' ? 18 : source === 'text' ? 12 : 9; const canonical = normalizeCandidateCode(code); const compact = canonical.replace(/-/g, ''); const hasDigit = /\d/.test(compact); const hasLetter = /[A-Z]/.test(compact); const isLetterOnly = hasLetter && !hasDigit; const isGrouped = canonical.includes('-'); if (CONTEXT_RE.test(context)) score += 90; if (VALIDITY_HINT_RE.test(context)) score += 10; if (NEGATIVE_RE.test(context)) score -= 85; if (hasDigit && hasLetter) score += 24; else if (hasDigit) { if (compact.length === 6) score += 18; else if (compact.length >= 4 && compact.length <= 8) score += 12; else score += 6; } else if (isLetterOnly) { score += LETTER_ONLY_STOPWORDS.has(compact) ? -30 : 4; if (compact !== compact.toUpperCase()) score -= 12; } if (isGrouped) score += CONTEXT_RE.test(context) ? 12 : -8; const repeated = counts.get(canonical) || 1; if (repeated > 1) score += 12 * (repeated - 1); if (uniqueCount === 1) score += 8; return score; }
  function isViableCandidate(code, context) { const canonical = normalizeCandidateCode(code); const compact = canonical.replace(/-/g, ''); const hasDigit = /\d/.test(compact); const hasLetter = /[A-Z]/.test(compact); const segments = canonical.split(/[- ]+/).filter(Boolean); const isHexLikeColor = /^[A-F0-9]{6}(?:[A-F0-9]{2})?$/.test(compact) && /[A-F]/.test(compact); if (!hasDigit && !hasLetter) return false; if (isHexLikeColor && COLOR_STYLE_HINT_RE.test(context)) return false; if (hasLetter && !hasDigit) { if (compact.length < 4 || compact.length > 12) return false; if (compact !== compact.toUpperCase()) return false; if (LETTER_ONLY_STOPWORDS.has(compact)) return false; return CONTEXT_RE.test(context); } if (segments.length > 1) { const hasValidSegment = segments.some((segment) => /\d/.test(segment) || /^[A-Z]{4,12}$/.test(segment)); const hasBlockedAlphaSegment = segments.some((segment) => /^[A-Z]+$/.test(segment) && LETTER_ONLY_STOPWORDS.has(segment)); const hasLowercaseAlphaSegment = segments.some((segment) => /[A-Za-z]/.test(segment) && segment !== segment.toUpperCase()); if (!hasValidSegment || hasBlockedAlphaSegment || hasLowercaseAlphaSegment) return false; } if (hasDigit && !hasLetter) return compact.length >= 4 && compact.length <= 10; return compact.length >= 5 && compact.length <= 24; }
  function extractCandidates(value, source, counts, uniqueCount) { const normalized = normalizeContent(value, source); if (!normalized) return []; const candidates = []; const regexes = [GROUPED_CODE_RE, ALPHANUMERIC_CODE_RE, NUMERIC_CODE_RE]; for (const regex of regexes) { for (const match of normalized.matchAll(regex)) { const code = match[1]; const index = match.index || 0; if (appearsInsideEmailAddress(normalized, code, index)) continue; const context = normalized.slice(Math.max(0, index - 32), Math.min(normalized.length, index + code.length + 48)); if (!isViableCandidate(code, context)) continue; const canonicalCode = normalizeCandidateCode(code); candidates.push({ code: String(code || '').trim(), canonicalCode, source, score: scoreCandidate(source, code, context, counts, uniqueCount) }); } } return candidates; }
  function collectOccurrences(input) { const counts = new Map(); const values = [normalizeContent(input.subject, 'subject'), normalizeContent(input.textBody, 'text'), normalizeContent(input.htmlBody, 'html')]; for (const value of values) { if (!value) continue; const seen = new Set(); for (const regex of [GROUPED_CODE_RE, ALPHANUMERIC_CODE_RE, NUMERIC_CODE_RE]) { for (const match of value.matchAll(regex)) { const code = match[1]; const index = match.index || 0; if (appearsInsideEmailAddress(value, code, index)) continue; const context = value.slice(Math.max(0, index - 32), Math.min(value.length, index + code.length + 48)); if (!isViableCandidate(code, context)) continue; const canonicalCode = normalizeCandidateCode(code); if (seen.has(canonicalCode)) continue; seen.add(canonicalCode); counts.set(canonicalCode, (counts.get(canonicalCode) || 0) + 1); } } } return counts; }
  function extractContextualNumericOtp(input) { const orderedValues = [{ value: input.subject, source: 'subject' }, { value: input.textBody, source: 'text' }, { value: input.htmlBody, source: 'html' }]; const matches = []; for (const entry of orderedValues) { const normalized = normalizeContent(entry.value, entry.source); if (!normalized) continue; for (const match of normalized.matchAll(new RegExp(CONTEXTUAL_NUMERIC_OTP_RE, 'ig'))) { const code = String(match[1] || '').trim(); if (/^\d{6}$/.test(code)) matches.push({ code, source: entry.source }); } } if (matches.length === 0) return undefined; const uniqueCodes = [...new Set(matches.map((item) => item.code))]; const best = matches[0]; return { code: best.code, source: best.source, ...(uniqueCodes.length > 1 ? { candidates: uniqueCodes } : {}) }; }
  function extractOtpFromContent(input) { const contextualNumericOtp = extractContextualNumericOtp(input); if (contextualNumericOtp) return contextualNumericOtp; const counts = collectOccurrences(input); if (!counts.size) return undefined; const candidates = [...extractCandidates(input.subject, 'subject', counts, counts.size), ...extractCandidates(input.textBody, 'text', counts, counts.size), ...extractCandidates(input.htmlBody, 'html', counts, counts.size)]; if (!candidates.length) return undefined; candidates.sort((left, right) => { if (right.score !== left.score) return right.score - left.score; const sourcePriority = { subject: 3, text: 2, html: 1 }; return sourcePriority[right.source] - sourcePriority[left.source]; }); const sixDigitNumericCandidates = candidates.filter((candidate) => /^\d{6}$/.test(compactCandidateCode(candidate.code))); const best = sixDigitNumericCandidates.length > 0 ? sixDigitNumericCandidates[0] : candidates[0]; const usefulCompanions = candidates.filter((candidate) => { const compact = compactCandidateCode(candidate.code); if (/^\d{6}$/.test(compact)) return true; return candidate.score >= Math.max(20, best.score - 12); }).map((candidate) => candidate.code); const uniqueCandidates = [...new Set(usefulCompanions)].slice(0, 8); return best.score >= 15 ? { code: best.code, source: best.source, ...(uniqueCandidates.length > 1 ? { candidates: uniqueCandidates } : {}) } : undefined; }
  function normalizeMessageBodies(textBodyInput, htmlBodyInput) {
    const rawTextBody = normalizeReadableText(textBodyInput);
    const rawHtmlBody = String(htmlBodyInput || '').trim();
    const htmlHasMarkup = htmlLooksLikeMarkup(rawHtmlBody);
    const htmlReadableBody = rawHtmlBody ? (htmlHasMarkup ? htmlToText(rawHtmlBody) : normalizeReadableText(rawHtmlBody)) : '';
    const mergedTextBody = mergeReadableTexts([rawTextBody, htmlReadableBody]).join('\n\n');
    return { textBody: mergedTextBody, htmlBody: htmlHasMarkup ? rawHtmlBody : '' };
  }
  function normalizeObservedMessage(message) { if (!message) return null; const bodies = normalizeMessageBodies(message.textBody || '', message.htmlBody || ''); const textBody = bodies.textBody; const htmlBody = bodies.htmlBody; const otp = message.extractedCode ? { code: message.extractedCode, source: message.codeSource || 'text', candidates: message.extractedCandidates || [] } : extractOtpFromContent({ subject: message.subject, textBody, htmlBody }); const actionLinks = Array.isArray(message.actionLinks) && message.actionLinks.length ? message.actionLinks.map((link) => ({ url: sanitizeActionUrl(link && link.url), label: summarizeActionLabel(sanitizeActionUrl(link && link.url), link && link.label) })).filter((link) => link.url) : extractMessageLinks({ subject: message.subject, textBody, htmlBody }); return { id: String(message.id || `${Date.now()}-${randomHex(6)}`), sender: normalizeText(message.sender || ''), subject: normalizeText(message.subject || ''), textBody, htmlBody, observedAt: chooseObservedAt(message.observedAt, message.receivedAt, message.createdAt, message.updatedAt, message.date, message.sentAt), extractedCode: otp ? otp.code : '', extractedCandidates: otp ? otp.candidates || [] : [], codeSource: otp ? otp.source : '', actionLinks }; }
  function createLocalPart(seed) { const host = (location.hostname || 'mail').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 8) || 'mail'; const basis = String(seed || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12); return `${basis || host}${randomHex(6)}`.slice(0, 24); }
  function matchesSenderFilter(message, filter) { const normalized = String(filter || '').trim().toLowerCase(); if (!normalized) return true; const text = `${String(message.sender || '').toLowerCase()}\n${String(message.subject || '').toLowerCase()}\n${String(message.textBody || '').toLowerCase()}\n${String(message.htmlBody || '').toLowerCase()}`; return text.includes(normalized); }
  async function cloudflareGetSettings(cfg) { const result = await requestJsonAbsolute('GET', `${normalizeUrl(cfg.baseUrl)}/open_api/settings`, { Accept: 'application/json, text/plain, */*', ...(cfg.customAuth ? { 'x-custom-auth': cfg.customAuth } : {}) }); if (result.status !== 200) throw new Error(`Cloudflare Temp Email settings failed: HTTP ${result.status}`); const payload = typeof result.data === 'string' ? {} : result.data; const explicitDomains = normalizeDomainEntries(Array.isArray(payload.domains) ? payload.domains : []); const randomSubdomainRoots = normalizeDomainEntries(Array.isArray(payload.randomSubdomainDomains) ? payload.randomSubdomainDomains : []); setCachedProviderDomains('cloudflare_temp_email', explicitDomains, randomSubdomainRoots); return { ...payload, domains: explicitDomains, randomSubdomainDomains: randomSubdomainRoots }; }
  async function cloudflareOpenMailbox(cfg) { const settings = await cloudflareGetSettings(cfg).catch(() => ({})); const domains = Array.isArray(settings.domains) ? settings.domains.filter((item) => typeof item === 'string' && item.trim()) : []; const selectedDomain = cfg.preferredDomain ? cfg.preferredDomain.trim() : (domains.length ? domains[Math.floor(Math.random() * domains.length)] : ''); const result = await requestJsonAbsolute('POST', `${normalizeUrl(cfg.baseUrl)}/api/new_address`, { Accept: 'application/json, text/plain, */*', ...(cfg.customAuth ? { 'x-custom-auth': cfg.customAuth } : {}), 'Content-Type': 'application/json' }, { name: createLocalPart('cf'), ...(selectedDomain ? { domain: selectedDomain } : {}) }); if (result.status !== 200) throw new Error(`Cloudflare Temp Email open failed: HTTP ${result.status}`); const payload = typeof result.data === 'string' ? {} : result.data; const address = String(payload.address || '').trim(); const jwt = String(payload.jwt || '').trim(); if (!address || !jwt) throw new Error('Cloudflare Temp Email open returned empty address or jwt.'); return { email: address, mailboxData: { address, jwt }, metadata: { selectedDomain: address.split('@')[1] || selectedDomain || '', availableDomains: domains } }; }
  async function cloudflareAdminListMessages(cfg, email) {
    if (!String(cfg.adminAuth || '').trim()) {
      throw new Error('Cloudflare 临时邮箱手动查询需要管理查询密钥。');
    }
    const result = await requestJsonAbsolute('GET', `${normalizeUrl(cfg.baseUrl)}/admin/mails?address=${encodeURIComponent(email)}&limit=20&offset=0`, { Accept: 'application/json, text/plain, */*', ...(cfg.customAuth ? { 'x-custom-auth': cfg.customAuth } : {}), ...(cfg.adminAuth ? { 'x-admin-auth': cfg.adminAuth } : {}) });
    if (result.status !== 200) throw new Error(`Cloudflare Temp Email admin list failed: HTTP ${result.status}`);
    return Array.isArray(result.data && result.data.results) ? result.data.results : [];
  }
  async function cloudflareListMessages(cfg, mailbox) {
    const usingAdminLookup = !mailbox.mailboxData || !mailbox.mailboxData.jwt;
    const rows = usingAdminLookup
      ? await cloudflareAdminListMessages(cfg, mailbox.email)
      : (() => undefined)();
    const result = usingAdminLookup ? null : await requestJsonAbsolute('GET', `${normalizeUrl(cfg.baseUrl)}/api/mails?limit=20&offset=0`, { Accept: 'application/json, text/plain, */*', ...(cfg.customAuth ? { 'x-custom-auth': cfg.customAuth } : {}), Authorization: `Bearer ${mailbox.mailboxData.jwt}` });
    if (!usingAdminLookup && result.status !== 200) throw new Error(`Cloudflare Temp Email list failed: HTTP ${result.status}`);
    const sourceRows = usingAdminLookup ? rows : (Array.isArray(result.data && result.data.results) ? result.data.results : []);
    const sorted = [...sourceRows].sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
    const messages = [];
    for (const row of sorted) {
      const sender = normalizeText(row.source || row.from || '');
      const subject = normalizeText(row.subject || '');
      let raw = typeof row.raw === 'string' ? row.raw : '';
      let detailData = {};
      if (!usingAdminLookup && !raw && row.id !== undefined && row.id !== null) {
        const detail = await requestJsonAbsolute('GET', `${normalizeUrl(cfg.baseUrl)}/api/mail/${encodeURIComponent(String(row.id))}`, { Accept: 'application/json, text/plain, */*', ...(cfg.customAuth ? { 'x-custom-auth': cfg.customAuth } : {}), Authorization: `Bearer ${mailbox.mailboxData.jwt}` });
        if (detail.status === 200 && detail.data && typeof detail.data !== 'string') {
          detailData = detail.data;
          raw = String(detail.data.raw || '');
        }
      }
      const fallbackHtml = String(detailData.html || detailData.htmlBody || row.html || row.htmlBody || '').trim();
      const fallbackText = normalizeReadableText(detailData.text || detailData.textBody || detailData.body || row.text || row.textBody || row.body || '') || htmlToText(fallbackHtml);
      const parsed = raw ? parseRawMail(raw) : { textBody: fallbackText, htmlBody: fallbackHtml, texts: fallbackText ? [fallbackText] : [], subject, from: sender, date: '' };
      messages.push(normalizeObservedMessage({ id: `cloudflare_temp_email:${String(row.id || randomHex(6))}`, sender: sender || parsed.from, subject: subject || parsed.subject, textBody: parsed.textBody || fallbackText || '', htmlBody: parsed.htmlBody || fallbackHtml || '', observedAt: chooseObservedAt(row.receivedAt, row.createdAt, row.created_at, row.updatedAt, row.date, detailData.receivedAt, detailData.createdAt, detailData.date, parsed.date) }));
    }
    return messages.filter(Boolean);
  }
  async function im215ResolveMailboxByEmail(cfg, email) {
    const normalized = normalizeEmailAddress(email);
    if (!normalized) throw new Error('Invalid 215.im address.');
    return { email: normalized, mailboxData: { address: normalized, email: normalized }, metadata: { manualLookup: true, selectedDomain: normalized.split('@')[1] || '' } };
  }
  async function mailtmGetDomains(baseUrl) { const result = await requestJsonAbsolute('GET', `${normalizeUrl(baseUrl)}/domains?page=1`, { Accept: 'application/json' }); if (result.status !== 200) throw new Error(`Mail.tm domains failed: HTTP ${result.status}`); const rows = Array.isArray(result.data && result.data['hydra:member']) ? result.data['hydra:member'] : []; const domains = rows.filter((item) => item && item.domain && item.isActive && !item.isPrivate).map((item) => String(item.domain).trim()); setCachedProviderDomains('mailtm', domains); return domains; }
  async function mailtmCreateAccount(baseUrl, email, password) { const result = await requestJsonAbsolute('POST', `${normalizeUrl(baseUrl)}/accounts`, { Accept: 'application/json', 'Content-Type': 'application/json' }, { address: email, password }); if (![200, 201, 422].includes(result.status)) throw new Error(`Mail.tm create account failed: HTTP ${result.status}`); return result; }
  async function mailtmCreateToken(baseUrl, email, password) { const result = await requestJsonAbsolute('POST', `${normalizeUrl(baseUrl)}/token`, { Accept: 'application/json', 'Content-Type': 'application/json' }, { address: email, password }); if (result.status !== 200) throw new Error(`Mail.tm token failed: HTTP ${result.status}`); const token = String(result.data && result.data.token || '').trim(); const id = String(result.data && result.data.id || '').trim(); if (!token) throw new Error('Mail.tm token response missing token.'); return { token, id }; }
  async function mailtmOpenMailbox(cfg) { const domains = await mailtmGetDomains(cfg.baseUrl); const domain = cfg.preferredDomain && domains.includes(cfg.preferredDomain) ? cfg.preferredDomain : domains[0]; if (!domain) throw new Error('Mail.tm has no public domain.'); const password = `P@ssw0rd_${randomString(10)}`; for (let attempt = 0; attempt < 5; attempt += 1) { const email = `${createLocalPart('tm')}@${domain}`; const created = await mailtmCreateAccount(cfg.baseUrl, email, password); if (created.status === 422) continue; const tokenResult = await mailtmCreateToken(cfg.baseUrl, email, password); return { email, mailboxData: { email, password, token: tokenResult.token, accountId: tokenResult.id || email }, metadata: { selectedDomain: domain } }; } throw new Error('Mail.tm failed to create a unique mailbox.'); }
  async function mailtmListMessages(cfg, mailbox) { const list = await requestJsonAbsolute('GET', `${normalizeUrl(cfg.baseUrl)}/messages?page=1`, { Accept: 'application/json', Authorization: `Bearer ${mailbox.mailboxData.token}` }); if (list.status !== 200) throw new Error(`Mail.tm list failed: HTTP ${list.status}`); const rows = Array.isArray(list.data && list.data['hydra:member']) ? list.data['hydra:member'] : []; const messages = []; for (const row of rows) { const id = String(row && row.id || '').trim(); if (!id) continue; const detail = await requestJsonAbsolute('GET', `${normalizeUrl(cfg.baseUrl)}/messages/${encodeURIComponent(id)}`, { Accept: 'application/json', Authorization: `Bearer ${mailbox.mailboxData.token}` }); if (detail.status !== 200) continue; const data = typeof detail.data === 'string' ? {} : detail.data; messages.push(normalizeObservedMessage({ id: `mailtm:${id}`, sender: data.from && (data.from.address || data.from.name) || data.from_address || '', subject: data.subject || row.subject || '', textBody: data.text || data.intro || '', htmlBody: data.html || '', observedAt: chooseObservedAt(data.createdAt, data.created_at, row.createdAt, row.created_at, data.receivedAt, row.receivedAt) })); } return messages.filter(Boolean); }
  async function duckmailRequest(baseUrl, method, path, options = {}) {
    return requestJsonAbsolute(method, `${normalizeUrl(baseUrl)}${path}`, { Accept: 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, options.body);
  }
  function duckmailHydraRows(body) {
    if (Array.isArray(body)) return body.filter((item) => item && typeof item === 'object');
    const record = readValueRecord(body);
    return readValueRecordList(record['hydra:member'] || record.items || record.messages || record.domains);
  }
  function duckmailHydraLastPage(body) {
    const view = readValueRecord(readValueRecord(body)['hydra:view']);
    const raw = readValueString(view['hydra:last']) || readValueString(view['@id']);
    if (!raw) return 1;
    try {
      const url = raw.startsWith('http://') || raw.startsWith('https://') ? new URL(raw) : new URL(raw, 'https://duckmail.local');
      const page = Number.parseInt(url.searchParams.get('page') || '1', 10);
      return Number.isFinite(page) && page > 0 ? page : 1;
    } catch {
      return 1;
    }
  }
  async function duckmailGetDomains(cfg) {
    const domains = new Set();
    let page = 1;
    let lastPage = 1;
    while (page <= lastPage && page <= 5) {
      const result = await duckmailRequest(cfg.baseUrl, 'GET', `/domains?page=${page}`);
      if (result.status !== 200) throw new Error(`DuckMail domains failed: HTTP ${result.status}`);
      duckmailHydraRows(result.data).forEach((item) => {
        const domain = readValueString(item.domain || item.name);
        const verified = item.verified ?? item.isVerified ?? true;
        if (domain && verified !== false) domains.add(String(domain).trim().toLowerCase());
      });
      lastPage = Math.max(page, duckmailHydraLastPage(result.data));
      page += 1;
    }
    const list = [...domains];
    setCachedProviderDomains('duckmail', list);
    return list;
  }
  async function duckmailCreateToken(baseUrl, email, password) {
    const result = await duckmailRequest(baseUrl, 'POST', '/token', { body: { address: email, password } });
    if (result.status !== 200) throw new Error(`DuckMail token failed: HTTP ${result.status}`);
    const token = readValueString(readValueRecord(result.data).token);
    if (!token) throw new Error('DuckMail token response missing token.');
    return token;
  }
  async function duckmailOpenMailbox(cfg) {
    const domains = await duckmailGetDomains(cfg);
    const preferred = String(cfg.preferredDomain || '').trim().toLowerCase();
    const domain = preferred && domains.includes(preferred) ? preferred : domains[0];
    if (!domain) throw new Error('DuckMail has no available domains.');
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const email = `${createLocalPart('duck')}-${randomString(4)}@${domain}`.slice(0, 60 + domain.length + 1);
      const password = randomString(16);
      const created = await duckmailRequest(cfg.baseUrl, 'POST', '/accounts', { body: { address: email, password } });
      if (created.status === 400 || created.status === 409 || created.status === 422) continue;
      if (created.status !== 200 && created.status !== 201) throw new Error(`DuckMail create account failed: HTTP ${created.status}`);
      const account = readValueRecord(created.data);
      const resolvedEmail = readValueString(account.address) || email;
      const accountId = readValueString(account.id || account.account_id) || resolvedEmail;
      const token = await duckmailCreateToken(cfg.baseUrl, resolvedEmail, password);
      return { email: resolvedEmail.toLowerCase(), mailboxData: { email: resolvedEmail.toLowerCase(), password, token, accountId }, metadata: { selectedDomain: resolvedEmail.split('@')[1] || domain } };
    }
    throw new Error('DuckMail failed to create a unique mailbox.');
  }
  async function duckmailListMessages(cfg, mailbox) {
    const rows = [];
    let page = 1;
    let lastPage = 1;
    while (page <= lastPage && page <= 3) {
      const list = await duckmailRequest(cfg.baseUrl, 'GET', `/messages?page=${page}`, { token: mailbox.mailboxData.token });
      if (list.status !== 200) throw new Error(`DuckMail list failed: HTTP ${list.status}`);
      rows.push(...duckmailHydraRows(list.data));
      lastPage = Math.max(page, duckmailHydraLastPage(list.data));
      page += 1;
    }
    const messages = [];
    for (const row of rows) {
      const id = readValueString(row.id || row['@id']);
      if (!id) continue;
      const detail = await duckmailRequest(cfg.baseUrl, 'GET', `/messages/${encodeURIComponent(id)}`, { token: mailbox.mailboxData.token });
      if (detail.status !== 200 && detail.status !== 404) throw new Error(`DuckMail detail failed: HTTP ${detail.status}`);
      const data = detail.status === 200 ? readValueRecord(detail.data) : row;
      messages.push(normalizeObservedMessage({
        id: `duckmail:${id}`,
        sender: readSenderValue(data.from) || readSenderValue(row.from) || '',
        subject: readValueString(data.subject) || readValueString(row.subject) || '',
        textBody: readValueString(data.text) || readValueString(data.body) || readValueString(row.intro) || '',
        htmlBody: readValueString(data.html) || '',
        observedAt: chooseObservedAt(data.createdAt, data.updatedAt, row.createdAt, row.updatedAt),
      }));
    }
    return messages.filter(Boolean);
  }
  async function tempmailLolRequest(baseUrl, method, path, options = {}) {
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'TempMailJS/4.4.0',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    };
    const payload = options.body || undefined;
    let lastResult = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await requestJsonAbsolute(method, `${normalizeUrl(baseUrl)}${path}`, headers, payload);
      lastResult = result;
      if (result.status !== 429 && result.status < 500) return result;
      if (attempt < 2) await sleep((attempt + 1) * 700);
    }
    return lastResult;
  }
  function tempmailLolRows(body) {
    const record = readValueRecord(body);
    return readValueRecordList(record.emails || record.messages);
  }
  async function tempmailLolOpenMailbox(cfg) {
    const result = await tempmailLolRequest(cfg.baseUrl, 'POST', '/inbox/create', { body: {} });
    if (result.status !== 200 && result.status !== 201) throw new Error(`Tempmail.lol open failed: HTTP ${result.status}`);
    const payload = readValueRecord(result.data);
    const email = readValueString(payload.address || payload.email);
    const token = readValueString(payload.token);
    if (!email || !token) throw new Error('Tempmail.lol create inbox returned incomplete payload.');
    return { email: email.toLowerCase(), mailboxData: { email: email.toLowerCase(), token }, metadata: { selectedDomain: email.split('@')[1] || '' } };
  }
  async function tempmailLolListMessages(cfg, mailbox) {
    const token = readValueString(mailbox && mailbox.mailboxData && mailbox.mailboxData.token);
    if (!token) throw new Error('Tempmail.lol mailbox token is missing.');
    const result = await tempmailLolRequest(cfg.baseUrl, 'GET', `/inbox?token=${encodeURIComponent(token)}`);
    if (result.status === 404) return [];
    if (result.status !== 200) throw new Error(`Tempmail.lol inbox failed: HTTP ${result.status}`);
    return tempmailLolRows(result.data).map((row) => normalizeObservedMessage({
      id: `tempmail-lol:${readValueString(row.id) || readValueString(row.date) || randomHex(6)}`,
      sender: readValueString(row.from || row.sender) || '',
      subject: readValueString(row.subject) || '',
      textBody: readValueString(row.body || row.text) || '',
      htmlBody: readValueString(row.html) || '',
      observedAt: chooseObservedAt(row.createdAt, row.date),
    })).filter(Boolean);
  }
  function etempmailRequest(baseUrl, method, path, options = {}) {
    const headers = {
      Accept: options.accept || 'application/json, text/plain, */*',
      ...(options.cookieHeader ? { Cookie: options.cookieHeader } : {}),
      ...(options.contentType ? { 'Content-Type': options.contentType } : {}),
      ...(options.xRequestedWith ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
    };
    return requestAbsolute(method, `${normalizeUrl(baseUrl)}${path}`, headers, options.body, options.expectJson !== false);
  }
  function etempmailExtractMailbox(body) {
    const record = readValueRecord(body);
    const email = normalizeEmailAddress(readValueString(record.address) || readValueString(record.email) || readValueString(record.mail));
    const recoverKey = readValueString(record.recover_key) || readValueString(record.recoverKey) || readValueString(record.key);
    if (!email || !recoverKey) return undefined;
    return {
      email,
      recoverKey,
      mailboxId: readValueString(record.id) || readValueString(record.mailboxId) || '',
      creationTime: readValueString(record.creation_time) || readValueString(record.creationTime) || '',
    };
  }
  function etempmailExtractDomainOptions(htmlText) {
    const source = String(htmlText || '');
    const options = [];
    source.replace(/<option value="([^"]*)"(?:[^>]*)>([^<]+)<\/option>/gi, (_, id, domain) => {
      const normalizedId = String(id || '').trim();
      const normalizedDomain = String(domain || '').trim().toLowerCase();
      if (normalizedId && normalizedDomain && !normalizedDomain.startsWith('click here')) {
        options.push({ id: normalizedId, domain: normalizedDomain });
      }
      return '';
    });
    return options;
  }
  function etempmailExtractDetailBodies(htmlText) {
    const source = String(htmlText || '');
    const match = source.match(/<iframe[^>]+src="data:text\/html,([^"]+)"/i);
    if (!match) return { textBody: '', htmlBody: '' };
    let htmlBody = String(match[1] || '');
    try {
      htmlBody = decodeURIComponent(htmlBody);
    } catch {}
    return {
      htmlBody: htmlBody.trim(),
      textBody: normalizeReadableText(htmlToText(htmlBody)) || '',
    };
  }
  async function etempmailFetchMailbox(baseUrl, cookieHeader) {
    const result = await etempmailRequest(baseUrl, 'POST', '/getEmailAddress', {
      body: '{}',
      contentType: 'application/json',
      xRequestedWith: true,
      cookieHeader,
    });
    if (result.status !== 200) throw new Error(`eTempMail getEmailAddress failed: HTTP ${result.status}`);
    const mailbox = etempmailExtractMailbox(result.data);
    if (!mailbox) throw new Error('eTempMail getEmailAddress returned an incomplete mailbox payload.');
    return { mailbox, cookieHeader: extractCookieHeader(result.headers) || cookieHeader || '' };
  }
  async function etempmailRecoverCookie(baseUrl, recoverKey) {
    const result = await etempmailRequest(baseUrl, 'POST', '/recoverEmailAddress', {
      body: new URLSearchParams({ key: recoverKey }).toString(),
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      xRequestedWith: true,
    });
    if (result.status !== 200) throw new Error(`eTempMail recover failed: HTTP ${result.status}`);
    const body = readValueRecord(result.data);
    if (body.success !== true) throw new Error(`eTempMail recover failed: ${readValueString(body.message) || 'unknown error'}`);
    return extractCookieHeader(result.headers) || '';
  }
  async function etempmailOpenMailbox(cfg) {
    let state = await etempmailFetchMailbox(cfg.baseUrl);
    const preferredDomain = String(cfg.preferredDomain || '').trim().toLowerCase();
    const currentDomain = getEmailDomain(state.mailbox.email);
    if (preferredDomain && currentDomain !== preferredDomain) {
      const homeResult = await etempmailRequest(cfg.baseUrl, 'GET', '/', {
        accept: 'text/html,application/xhtml+xml',
        cookieHeader: state.cookieHeader,
        expectJson: false,
      });
      if (homeResult.status === 200) {
        const matched = etempmailExtractDomainOptions(homeResult.text).find((item) => item.domain === preferredDomain);
        if (matched) {
          const changeResult = await etempmailRequest(cfg.baseUrl, 'POST', '/changeEmailAddress', {
            body: new URLSearchParams({ id: matched.id }).toString(),
            contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
            xRequestedWith: true,
            accept: 'text/html,application/xhtml+xml',
            cookieHeader: state.cookieHeader,
            expectJson: false,
          });
          const changedCookieHeader = extractCookieHeader(changeResult.headers) || state.cookieHeader;
          if (changeResult.status === 200) {
            try {
              state = await etempmailFetchMailbox(cfg.baseUrl, changedCookieHeader);
            } catch {}
          }
        }
      }
    }
    return {
      email: state.mailbox.email,
      mailboxData: {
        email: state.mailbox.email,
        recoverKey: state.mailbox.recoverKey,
        mailboxId: state.mailbox.mailboxId || '',
        creationTime: state.mailbox.creationTime || '',
      },
      metadata: {
        selectedDomain: getEmailDomain(state.mailbox.email),
      },
    };
  }
  async function etempmailListMessages(cfg, mailbox) {
    const recoverKey = String(mailbox && mailbox.mailboxData && mailbox.mailboxData.recoverKey || '').trim();
    if (!recoverKey) throw new Error('eTempMail recovery key is missing.');
    const cookieHeader = await etempmailRecoverCookie(cfg.baseUrl, recoverKey);
    const inboxResult = await etempmailRequest(cfg.baseUrl, 'POST', '/getInbox', {
      body: '{}',
      contentType: 'application/json',
      xRequestedWith: true,
      cookieHeader,
    });
    if (inboxResult.status !== 200) throw new Error(`eTempMail inbox failed: HTTP ${inboxResult.status}`);
    const rows = Array.isArray(inboxResult.data)
      ? inboxResult.data
      : readValueRecordList(readValueRecord(inboxResult.data).messages || readValueRecord(inboxResult.data).items || readValueRecord(inboxResult.data).list);
    const messages = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = readValueRecord(rows[index]);
      const sender = readSenderValue(row.from) || readSenderValue(row.sender) || '';
      const subject = readValueString(row.subject) || '';
      const summary = normalizeObservedMessage({
        id: `etempmail:${readValueString(row.id) || String(index + 1)}`,
        sender,
        subject,
        textBody: '',
        htmlBody: '',
        observedAt: chooseObservedAt(row.date, row.createdAt, row.receivedAt),
      });
      if (summary && summary.extractedCode) {
        messages.push(summary);
        continue;
      }
      const detailResult = await etempmailRequest(cfg.baseUrl, 'GET', `/email?id=${encodeURIComponent(String(index + 1))}`, {
        accept: 'text/html,application/xhtml+xml',
        cookieHeader,
        expectJson: false,
      });
      if (detailResult.status !== 200) {
        if (summary) messages.push(summary);
        continue;
      }
      const detailBodies = etempmailExtractDetailBodies(detailResult.text);
      messages.push(normalizeObservedMessage({
        id: `etempmail:${readValueString(row.id) || String(index + 1)}`,
        sender,
        subject,
        textBody: detailBodies.textBody || '',
        htmlBody: detailBodies.htmlBody || '',
        observedAt: chooseObservedAt(row.date, row.createdAt, row.receivedAt),
      }));
    }
    return messages.filter(Boolean);
  }
  async function etempmailResolveMailboxByEmail(cfg, email) {
    const normalized = normalizeEmailAddress(email);
    if (!normalized) throw new Error('Invalid eTempMail address.');
    const historyMailbox = findHistoryMailboxByEmail(normalized);
    if (historyMailbox && historyMailbox.providerKey === 'etempmail' && historyMailbox.mailboxData && historyMailbox.mailboxData.recoverKey) {
      return { email: normalized, mailboxData: historyMailbox.mailboxData, metadata: { manualLookup: true, selectedDomain: getEmailDomain(normalized) } };
    }
    throw new Error(t('logManualUnsupported', { provider: providerLabel('etempmail') }));
  }
  function guerrillaEncode(params) { const query = new URLSearchParams(); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== null && String(value) !== '') query.set(key, String(value)); }); return query.toString(); }
  async function guerrillaRequest(apiBase, params) { const url = `${normalizeUrl(apiBase)}?${guerrillaEncode(params)}`; const result = await requestJsonAbsolute('GET', url, { Accept: 'application/json' }); if (result.status !== 200) throw new Error(`GuerrillaMail failed: HTTP ${result.status}`); return typeof result.data === 'string' ? {} : result.data; }
  const GUERRILLA_DOMAINS = ['guerrillamail.com', 'guerrillamailblock.com', 'sharklasers.com', 'grr.la', 'guerrillamail.biz', 'guerrillamail.de', 'spam4.me', 'pokemail.net'];
  async function guerrillaOpenMailbox(cfg) { const requestedUser = `${createLocalPart('gm')}${randomString(4)}`; const seeded = await guerrillaRequest(cfg.apiBase, { f: 'set_email_user', email_user: requestedUser, email_domain: cfg.preferredDomain || undefined, lang: 'en' }); let sidToken = String(seeded.sid_token || '').trim(); let emailAddress = String(seeded.email_addr || '').trim(); const emailUser = String(seeded.email_user || requestedUser).trim(); if (!sidToken || !emailAddress) { const fallback = await guerrillaRequest(cfg.apiBase, { f: 'get_email_address', sid_token: sidToken || undefined, lang: 'en' }); sidToken = String(fallback.sid_token || sidToken || '').trim(); emailAddress = String(fallback.email_addr || emailAddress || '').trim(); } if (!sidToken || !emailAddress) throw new Error('GuerrillaMail open returned incomplete mailbox payload.'); return { email: emailAddress.toLowerCase(), mailboxData: { emailAddress: emailAddress.toLowerCase(), emailUser: emailUser.toLowerCase(), sidToken }, metadata: { selectedDomain: emailAddress.split('@')[1] || '' } }; }
  async function guerrillaResolveMailboxByEmail(cfg, email) {
    const normalized = normalizeEmailAddress(email);
    if (!normalized) throw new Error('Invalid GuerrillaMail address.');
    const [localPart, domain] = normalized.split('@');
    const selectedDomain = String(domain || '').trim().toLowerCase();
    const result = await guerrillaRequest(cfg.apiBase, { f: 'set_email_user', email_user: localPart, email_domain: selectedDomain || undefined, lang: 'en' });
    const sidToken = String(result.sid_token || '').trim();
    const emailAddress = String(result.email_addr || normalized).trim().toLowerCase();
    if (!sidToken || !emailAddress.includes('@')) throw new Error('GuerrillaMail manual lookup failed to recover sid_token.');
    return { email: emailAddress, mailboxData: { emailAddress, emailUser: localPart.toLowerCase(), sidToken }, metadata: { manualLookup: true, selectedDomain: emailAddress.split('@')[1] || selectedDomain } };
  }
  async function guerrillaListMessages(cfg, mailbox) { const list = await guerrillaRequest(cfg.apiBase, { f: 'get_email_list', offset: 0, sid_token: mailbox.mailboxData.sidToken, lang: 'en' }); const rows = Array.isArray(list.list) ? [...list.list] : []; rows.sort((a, b) => (Number(b.mail_timestamp) || 0) - (Number(a.mail_timestamp) || 0)); const messages = []; for (const row of rows) { const id = String(row.mail_id || '').trim(); if (!id) continue; let detail = row; try { detail = await guerrillaRequest(cfg.apiBase, { f: 'fetch_email', email_id: id, sid_token: mailbox.mailboxData.sidToken, lang: 'en' }); } catch {} messages.push(normalizeObservedMessage({ id: `guerrillamail:${id}`, sender: detail.mail_from || row.mail_from || '', subject: detail.mail_subject || row.mail_subject || '', textBody: detail.mail_body || row.mail_excerpt || '', htmlBody: detail.mail_body || '', observedAt: new Date(((Number(detail.mail_timestamp || row.mail_timestamp) || Date.now() / 1000) * 1000)).toISOString() })); } return messages.filter(Boolean); }
  async function moemailRequest(baseUrl, apiKey, method, path, body, cursor) { const url = new URL(path, normalizeUrl(baseUrl).endsWith('/') ? normalizeUrl(baseUrl) : `${normalizeUrl(baseUrl)}/`); if (cursor) url.searchParams.set('cursor', cursor); return requestJsonAbsolute(method, url.toString(), { Accept: 'application/json', 'X-API-Key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body); }
  async function moemailGetConfig(cfg) {
    const cfgResult = await moemailRequest(cfg.baseUrl, cfg.apiKey, 'GET', '/api/config');
    if (cfgResult.status !== 200) throw new Error(`MoEmail config failed: HTTP ${cfgResult.status}`);
    const payload = typeof cfgResult.data === 'string' ? {} : cfgResult.data;
    const domains = extractDomainsFromBody(payload);
    setCachedProviderDomains('moemail', domains);
    return payload;
  }
  async function moemailOpenMailbox(cfg) { const configPayload = await moemailGetConfig(cfg); let domain = cfg.preferredDomain || ''; if (!domain) { const domains = extractDomainsFromBody(configPayload); if (domains.length) domain = domains[0]; } const result = await moemailRequest(cfg.baseUrl, cfg.apiKey, 'POST', '/api/emails/generate', { name: createLocalPart('mo'), expiryTime: Number.parseInt(cfg.expiryTimeMs || '3600000', 10) || 3600000, ...(domain ? { domain } : {}) }); if (![200, 201].includes(result.status)) throw new Error(`MoEmail open failed: HTTP ${result.status}${result.data && result.data.error ? `. ${result.data.error}` : ''}`); const payload = typeof result.data === 'string' ? {} : result.data; const candidates = [payload, payload.data || {}, payload.email || {}, payload.mailbox || {}]; let emailId = ''; let email = ''; for (const item of candidates) { emailId = emailId || String(item.emailId || item.id || item._id || item.mailboxId || '').trim(); email = email || String(item.emailAddress || item.address || item.email || item.mailbox || '').trim().toLowerCase(); } if (!emailId || !email || !email.includes('@')) throw new Error('MoEmail open returned incomplete mailbox payload.'); return { email, mailboxData: { emailId, email }, metadata: { selectedDomain: email.split('@')[1] || domain || '' } }; }
  async function moemailResolveMailboxByEmail(cfg, email) {
    const normalized = normalizeEmailAddress(email);
    if (!normalized) throw new Error('Invalid MoEmail address.');
    let cursor = '';
    for (let page = 0; page < 8; page += 1) {
      const result = await moemailRequest(cfg.baseUrl, cfg.apiKey, 'GET', '/api/emails', undefined, cursor || undefined);
      if (result.status !== 200) throw new Error(`MoEmail mailbox query failed: HTTP ${result.status}`);
      const body = typeof result.data === 'string' ? {} : result.data;
      const container = [body, body.data || {}, body.result || {}].find((item) => Array.isArray(item.emails || item.items || item.list)) || body;
      const rows = Array.isArray(container.emails) ? container.emails : Array.isArray(container.items) ? container.items : Array.isArray(container.list) ? container.list : [];
      const matched = rows.map((item) => readValueRecord(item)).find((item) => normalizeEmailAddress(readValueString(item.emailAddress) || readValueString(item.address) || readValueString(item.email) || readValueString(item.mailbox)) === normalized);
      if (matched) {
        const emailId = readValueString(matched.emailId) || readValueString(matched.id) || readValueString(matched._id) || readValueString(matched.mailboxId);
        if (!emailId) throw new Error('MoEmail matched mailbox is missing emailId.');
        return { email: normalized, mailboxData: { emailId, email: normalized }, metadata: { manualLookup: true, selectedDomain: normalized.split('@')[1] || '' } };
      }
      cursor = String(container.nextCursor || container.cursor || '').trim();
      if (!cursor) break;
    }
    throw new Error(`MoEmail 未找到邮箱 ${normalized}。`);
  }
  async function moemailListMessages(cfg, mailbox) { let cursor = ''; const messages = []; for (let page = 0; page < 3; page += 1) { const result = await moemailRequest(cfg.baseUrl, cfg.apiKey, 'GET', `/api/emails/${encodeURIComponent(mailbox.mailboxData.emailId)}`, undefined, cursor || undefined); if (result.status === 404) break; if (result.status !== 200) throw new Error(`MoEmail list failed: HTTP ${result.status}`); const body = typeof result.data === 'string' ? {} : result.data; const container = [body, body.data || {}, body.result || {}].find((item) => Array.isArray(item.messages || item.items || item.list)) || body; const rows = Array.isArray(container.messages) ? container.messages : Array.isArray(container.items) ? container.items : Array.isArray(container.list) ? container.list : []; for (const row of rows) { const id = String(row.messageId || row.id || row._id || row.mailId || '').trim(); if (!id) continue; const detail = await moemailRequest(cfg.baseUrl, cfg.apiKey, 'GET', `/api/emails/${encodeURIComponent(mailbox.mailboxData.emailId)}/${encodeURIComponent(id)}`); const info = detail.status === 200 && typeof detail.data !== 'string' ? detail.data : row; const from = info.from && typeof info.from === 'object' ? (info.from.address || info.from.email || info.from.name || info.from.from || '') : (info.from || info.sender || info.fromAddress || info.senderAddress || ''); messages.push(normalizeObservedMessage({ id: `moemail:${id}`, sender: from, subject: info.subject || info.title || row.subject || '', textBody: info.text || info.textBody || info.body || info.content || info.preview || info.snippet || row.textBody || '', htmlBody: info.html || info.htmlBody || info.htmlContent || info.rawHtml || row.htmlBody || '', observedAt: chooseObservedAt(info.receivedAt, info.createdAt, info.updatedAt, info.timestamp, row.receivedAt, row.createdAt, row.updatedAt, row.timestamp) })); } cursor = String(container.nextCursor || container.cursor || '').trim(); if (!cursor) break; } return messages.filter(Boolean); }

  async function m2uRequest(cfg, method, path, options = {}) {
    const headers = {
      Accept: 'application/json',
      'Accept-Language': currentLocale() === 'zh-CN' ? 'zh-CN,zh;q=0.9' : 'en-US,en;q=0.9',
      'User-Agent': 'EasyEmailBrowserRuntime/1.5.2',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    };
    return requestJsonAbsolute(method, `${normalizeUrl(cfg.baseUrl)}${path}`, headers, options.body);
  }
  async function m2uGetDomains(cfg) {
    const result = await m2uRequest(cfg, 'GET', '/v1/domains');
    if (result.status !== 200) throw buildStatusError('M2U', 'get domains', result.status, result.data);
    if (readBodyErrorCode(result.data)) throw buildBodyError('M2U', 'get domains', result.data);
    const domains = Array.isArray(readValueRecord(result.data).domains)
      ? readValueRecord(result.data).domains.map((item) => readValueString(item)).filter(Boolean).map((item) => String(item).trim().toLowerCase())
      : [];
    setCachedProviderDomains('m2u', domains);
    return [...new Set(domains)];
  }
  function normalizeM2uPreferredDomain(value) {
    return String(value || '').trim().toLowerCase();
  }
  function m2uDomainMatchesPreference(domain, preferredDomain) {
    const normalizedDomain = String(domain || '').trim().toLowerCase();
    const normalizedPreferredDomain = normalizeM2uPreferredDomain(preferredDomain);
    if (!normalizedDomain || !normalizedPreferredDomain) return false;
    return normalizedDomain === normalizedPreferredDomain || normalizedDomain.endsWith(`.${normalizedPreferredDomain}`);
  }
  function resolveM2uPreferredDomains(domains, preferredDomain) {
    const normalizedPreferredDomain = normalizeM2uPreferredDomain(preferredDomain);
    if (!normalizedPreferredDomain) return { preferredDomain: '', matchedDomains: [] };
    return {
      preferredDomain: normalizedPreferredDomain,
      matchedDomains: [...new Set((domains || []).map((item) => String(item || '').trim().toLowerCase()).filter((item) => item && m2uDomainMatchesPreference(item, normalizedPreferredDomain)))],
    };
  }
  function computeM2uMatchAttempts(totalDomainCount, matchedDomainCount) {
    const total = Number(totalDomainCount || 0);
    const matched = Number(matchedDomainCount || 0);
    if (total <= 0 || matched <= 0 || matched >= total) return 1;
    const failureProbability = 1 - (matched / total);
    if (failureProbability <= 0) return 1;
    const attempts = Math.ceil(Math.log(1 - 0.97) / Math.log(failureProbability));
    return Math.min(20, Math.max(2, attempts));
  }
  async function m2uOpenMailbox(cfg) {
    const domains = await m2uGetDomains(cfg);
    const preferred = resolveM2uPreferredDomains(domains, cfg.preferredDomain);
    if (preferred.preferredDomain && !preferred.matchedDomains.length) {
      throw new Error(`M2U has no available domain matching "${preferred.preferredDomain}".`);
    }
    const attempts = preferred.preferredDomain ? computeM2uMatchAttempts(domains.length, preferred.matchedDomains.length) : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const requestedDomain = preferred.matchedDomains.length ? preferred.matchedDomains[attempt % preferred.matchedDomains.length] : '';
      const result = await m2uRequest(cfg, 'POST', '/v1/mailboxes/auto', { body: requestedDomain ? { domain: requestedDomain } : {} });
      if (![200, 201].includes(result.status)) throw buildStatusError('M2U', 'open', result.status, result.data);
      if (readBodyErrorCode(result.data)) throw buildBodyError('M2U', 'open', result.data);
      const mailbox = readValueRecord(readValueRecord(result.data).mailbox);
      const localPart = readValueString(mailbox.local_part);
      const domain = readValueString(mailbox.domain);
      const token = readValueString(mailbox.token);
      const viewToken = readValueString(mailbox.view_token);
      if (!localPart || !domain || !token || !viewToken) throw new Error('M2U open returned incomplete mailbox payload.');
      const normalizedDomain = domain.toLowerCase();
      if (preferred.preferredDomain && !m2uDomainMatchesPreference(normalizedDomain, preferred.preferredDomain)) continue;
      const email = `${localPart}@${normalizedDomain}`.toLowerCase();
      return {
        email,
        mailboxData: {
          email,
          token,
          viewToken,
          mailboxId: readValueString(mailbox.id),
          expiresAt: readValueString(mailbox.expires_at),
        },
        metadata: {
          selectedDomain: normalizedDomain,
          expiresAt: readValueString(mailbox.expires_at) || '',
        },
      };
    }
    throw new Error(`M2U could not obtain a mailbox matching "${preferred.preferredDomain}" after ${attempts} attempts.`);
  }
  async function m2uListMessages(cfg, mailbox) {
    const token = readValueString(mailbox && mailbox.mailboxData && mailbox.mailboxData.token);
    const viewToken = readValueString(mailbox && mailbox.mailboxData && mailbox.mailboxData.viewToken);
    if (!token || !viewToken) throw new Error('M2U mailbox token/view token is missing.');
    const listResult = await m2uRequest(cfg, 'GET', `/v1/mailboxes/${encodeURIComponent(token)}/messages?view=${encodeURIComponent(viewToken)}`);
    if (listResult.status !== 200) throw buildStatusError('M2U', 'list', listResult.status, listResult.data);
    if (readBodyErrorCode(listResult.data)) throw buildBodyError('M2U', 'list', listResult.data);
    const rows = readValueRecordList(readValueRecord(listResult.data).messages);
    const messages = [];
    for (const row of rows) {
      const messageId = readValueString(row.id);
      if (!messageId) continue;
      const summarySubject = readValueString(row.subject) || '';
      const summaryMessage = normalizeObservedMessage({
        id: `m2u:${messageId}`,
        sender: readValueString(row.from_addr) || readValueString(row.from) || '',
        subject: summarySubject,
        textBody: '',
        htmlBody: '',
        observedAt: chooseObservedAt(row.received_at, row.receivedAt, row.created_at, row.createdAt),
      });
      if (summaryMessage && summaryMessage.extractedCode) {
        messages.push(summaryMessage);
        continue;
      }
      const detailResult = await m2uRequest(cfg, 'GET', `/v1/mailboxes/${encodeURIComponent(token)}/messages/${encodeURIComponent(messageId)}?view=${encodeURIComponent(viewToken)}`);
      if (detailResult.status !== 200) {
        if (detailResult.status === 404 && summaryMessage) {
          messages.push(summaryMessage);
          continue;
        }
        throw buildStatusError('M2U', 'detail', detailResult.status, detailResult.data);
      }
      if (readBodyErrorCode(detailResult.data)) {
        throw buildBodyError('M2U', 'detail', detailResult.data);
      }
      const detail = readValueRecord(readValueRecord(detailResult.data).message);
      messages.push(normalizeObservedMessage({
        id: `m2u:${messageId}`,
        sender: readValueString(detail.from_addr) || readValueString(detail.from) || readValueString(row.from_addr) || '',
        subject: readValueString(detail.subject) || summarySubject,
        textBody: readValueString(detail.text_body) || readValueString(detail.textBody) || readValueString(detail.text) || '',
        htmlBody: readValueString(detail.html_body) || readValueString(detail.htmlBody) || readValueString(detail.html) || '',
        observedAt: chooseObservedAt(detail.received_at, detail.receivedAt, row.received_at, row.receivedAt),
      }));
    }
    return messages.filter(Boolean);
  }

  function pickConfiguredKey(value) {
    const keys = Array.isArray(value) ? value.filter(Boolean) : splitConfiguredKeys(value);
    if (!keys.length) return '';
    return keys[Math.floor(Math.random() * keys.length)] || keys[0];
  }
  async function gptmailGenerateEmail(baseUrl, apiKey, prefix) { if (prefix && String(prefix).trim()) return requestJsonAbsolute('POST', `${normalizeUrl(baseUrl)}/api/generate-email`, { Accept: 'application/json', 'Content-Type': 'application/json', 'X-API-Key': apiKey }, { prefix: String(prefix).trim() }); return requestJsonAbsolute('GET', `${normalizeUrl(baseUrl)}/api/generate-email`, { Accept: 'application/json', 'X-API-Key': apiKey }); }
  async function gptmailOpenMailbox(cfg) {
    const apiKey = pickConfiguredKey(cfg.apiKeys);
    if (!apiKey) throw new Error('GPT Mail missing API key.');
    const result = await gptmailGenerateEmail(cfg.baseUrl, apiKey, cfg.prefix);
    if (result.status !== 200) throw new Error(`GPT Mail open failed: HTTP ${result.status}`);
    const email = String(result.data && result.data.data && result.data.data.email || '').trim();
    if (!email) throw new Error('GPT Mail generate-email returned empty email.');
    return { email, mailboxData: { email, apiKey }, metadata: { selectedDomain: email.split('@')[1] || '' } };
  }
  async function gptmailListMessages(cfg, mailbox) {
    const apiKey = String(mailbox && mailbox.mailboxData && mailbox.mailboxData.apiKey || pickConfiguredKey(cfg.apiKeys) || '').trim();
    if (!apiKey) throw new Error('GPT Mail missing API key.');
    const list = await requestJsonAbsolute('GET', `${normalizeUrl(cfg.baseUrl)}/api/emails?email=${encodeURIComponent(mailbox.mailboxData.email)}`, { Accept: 'application/json', 'X-API-Key': apiKey });
    if (list.status !== 200) throw new Error(`GPT Mail list failed: HTTP ${list.status}`);
    const rows = Array.isArray(list.data && list.data.data && list.data.data.emails) ? list.data.data.emails : [];
    const messages = [];
    for (const row of rows) {
      const id = String(row.id || '').trim();
      if (!id) continue;
      const detail = await requestJsonAbsolute('GET', `${normalizeUrl(cfg.baseUrl)}/api/email/${encodeURIComponent(id)}`, { Accept: 'application/json', 'X-API-Key': apiKey });
      const payload = detail.status === 200 && typeof detail.data !== 'string' ? detail.data : row;
      messages.push(normalizeObservedMessage({ id: `gptmail:${id}`, sender: payload.from_address || row.from_address || '', subject: payload.subject || row.subject || '', textBody: payload.content || payload.raw_content || '', htmlBody: payload.html_content || '', observedAt: chooseObservedAt(payload.created_at, payload.createdAt, row.created_at, row.createdAt, payload.receivedAt, row.receivedAt) }));
    }
    return messages.filter(Boolean);
  }
  async function gptmailResolveMailboxByEmail(cfg, email) {
    const normalized = normalizeEmailAddress(email);
    if (!normalized) throw new Error('Invalid GPT Mail address.');
    const apiKey = pickConfiguredKey(cfg.apiKeys);
    if (!apiKey) throw new Error('GPT Mail missing API key.');
    return { email: normalized, mailboxData: { email: normalized, apiKey }, metadata: { manualLookup: true, selectedDomain: normalized.split('@')[1] || '' } };
  }
  async function tmailorRequest(cfg, jsonBody) {
    const url = `${normalizeUrl(cfg.baseUrl)}/api`;
    return requestJsonAbsolute('POST', url, {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'Origin': normalizeUrl(cfg.baseUrl),
      'Referer': `${normalizeUrl(cfg.baseUrl)}/`,
    }, jsonBody);
  }
  async function tmailorOpenMailbox(cfg) {
    const existingToken = String(cfg.accessToken || '').trim();
    if (existingToken) {
      const checkResult = await tmailorRequest(cfg, { action: 'checktokenlive', accesstoken: existingToken, curentToken: existingToken, fbToken: null });
      const checkBody = readValueRecord(checkResult.data);
      if (checkBody.msg === 'ok' && checkBody.permission_desc !== 'exp_token') {
        const listResult = await tmailorRequest(cfg, { action: 'listinbox', accesstoken: existingToken, curentToken: existingToken, fbToken: null });
        const listBody = readValueRecord(listResult.data);
        const email = readValueString(listBody.email);
        if (email) {
          return { email: email.toLowerCase(), mailboxData: { email: email.toLowerCase(), token: existingToken }, metadata: { selectedDomain: email.split('@')[1] || '' } };
        }
      }
    }
    const result = await tmailorRequest(cfg, { action: 'newemail', fbToken: null, curentToken: null });
    if (result.status !== 200) throw buildStatusError('Tmailor', 'open', result.status, result.data);
    const body = readValueRecord(result.data);
    if (body.msg !== 'ok') throw new Error(`Tmailor open failed: msg=${String(body.msg || 'unknown')}`);
    const email = readValueString(body.email);
    const token = readValueString(body.accesstoken);
    if (!email || !token) throw new Error('Tmailor open returned incomplete payload.');
    return { email: email.toLowerCase(), mailboxData: { email: email.toLowerCase(), token }, metadata: { selectedDomain: email.split('@')[1] || '' } };
  }
  async function tmailorListMessages(cfg, mailbox) {
    const token = readValueString(mailbox && mailbox.mailboxData && mailbox.mailboxData.token);
    if (!token) throw new Error('Tmailor mailbox token is missing.');
    const listResult = await tmailorRequest(cfg, { action: 'listinbox', accesstoken: token, curentToken: token, fbToken: null });
    if (listResult.status !== 200) throw buildStatusError('Tmailor', 'list', listResult.status, listResult.data);
    const listBody = readValueRecord(listResult.data);
    if (listBody.msg !== 'ok') return [];
    const data = listBody.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
    const entries = Object.values(data);
    const messages = [];
    for (const entry of entries) {
      const msg = readValueRecord(entry);
      const summarySubject = readValueString(msg.subject) || '';
      const summaryText = readValueString(msg.text || msg.body) || '';
      const summaryMessage = normalizeObservedMessage({ id: `tmailor:${readValueString(msg.id || msg.uuid) || randomHex(6)}`, sender: readValueString(msg.sender_email || msg.from || msg.sender) || '', subject: summarySubject, textBody: summaryText, htmlBody: '', observedAt: chooseObservedAt(msg.receive_time, msg.date, msg.createdAt) });
      if (summaryMessage && summaryMessage.extractedCode) { messages.push(summaryMessage); continue; }
      const detailResult = await tmailorRequest(cfg, { action: 'read', accesstoken: token, curentToken: token, fbToken: null, email_code: msg.id || msg.uuid, email_token: msg.email_id || msg.uuid });
      if (detailResult.status !== 200) { if (summaryMessage) messages.push(summaryMessage); continue; }
      const detailBody = readValueRecord(detailResult.data);
      const detail = detailBody.msg === 'ok' ? readValueRecord(detailBody.data) : {};
      messages.push(normalizeObservedMessage({ id: `tmailor:${readValueString(msg.id || msg.uuid) || randomHex(6)}`, sender: readValueString(detail.sender_email || detail.from || detail.sender || msg.sender_email || msg.from || msg.sender) || '', subject: readValueString(detail.subject) || summarySubject, textBody: readValueString(detail.textBody || detail.text || detail.body) || summaryText, htmlBody: readValueString(detail.htmlBody || detail.html || detail.body_html) || '', observedAt: chooseObservedAt(detail.receive_time, detail.date, detail.createdAt, msg.receive_time, msg.date, msg.createdAt) }));
    }
    return messages.filter(Boolean);
  }

  const PROVIDERS = {
    cloudflare_temp_email: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.cloudflare_baseUrl) && String(s.cloudflare_customAuth || '').trim()), getConfig: (s) => ({ baseUrl: normalizeUrl(s.cloudflare_baseUrl), customAuth: String(s.cloudflare_customAuth || '').trim(), adminAuth: String(s.cloudflare_adminAuth || '').trim(), preferredDomain: String(s.cloudflare_preferredDomain || '').trim() }), openMailbox: cloudflareOpenMailbox, listMessages: cloudflareListMessages },
    mailtm: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.mailtm_baseUrl)), getConfig: (s) => ({ baseUrl: normalizeUrl(s.mailtm_baseUrl) }), openMailbox: mailtmOpenMailbox, listMessages: mailtmListMessages },
    duckmail: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.duckmail_baseUrl)), getConfig: (s) => ({ baseUrl: normalizeUrl(s.duckmail_baseUrl), preferredDomain: String(s.duckmail_preferredDomain || '').trim() }), openMailbox: duckmailOpenMailbox, listMessages: duckmailListMessages },
    guerrillamail: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.guerrillamail_apiBase)), getConfig: (s) => ({ apiBase: normalizeUrl(s.guerrillamail_apiBase) }), openMailbox: guerrillaOpenMailbox, listMessages: guerrillaListMessages },
    'tempmail-lol': { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.tempmailLol_baseUrl)), getConfig: (s) => ({ baseUrl: normalizeUrl(s.tempmailLol_baseUrl) }), openMailbox: tempmailLolOpenMailbox, listMessages: tempmailLolListMessages },
    etempmail: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.etempmail_baseUrl)), getConfig: (s) => ({ baseUrl: normalizeUrl(s.etempmail_baseUrl), preferredDomain: String(s.etempmail_preferredDomain || '').trim() }), openMailbox: etempmailOpenMailbox, listMessages: etempmailListMessages },
    moemail: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.moemail_baseUrl) && String(s.moemail_apiKey || '').trim()), getConfig: (s) => ({ baseUrl: normalizeUrl(s.moemail_baseUrl), apiKey: String(s.moemail_apiKey || '').trim(), expiryTimeMs: String(s.moemail_expiryTimeMs || '3600000').trim() }), openMailbox: moemailOpenMailbox, listMessages: moemailListMessages },
    m2u: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.m2u_baseUrl)), getConfig: (s) => ({ baseUrl: normalizeUrl(s.m2u_baseUrl), preferredDomain: String(s.m2u_preferredDomain || '').trim() }), openMailbox: m2uOpenMailbox, listMessages: m2uListMessages },
    gptmail: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.gptmail_baseUrl) && splitConfiguredKeys(s.gptmail_apiKey).length), getConfig: (s) => ({ baseUrl: normalizeUrl(s.gptmail_baseUrl), apiKeys: splitConfiguredKeys(s.gptmail_apiKey), prefix: String(s.gptmail_prefix || '').trim() }), openMailbox: gptmailOpenMailbox, listMessages: gptmailListMessages },
    tmailor: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.tmailor_baseUrl)), getConfig: (s) => ({ baseUrl: normalizeUrl(s.tmailor_baseUrl), accessToken: String(s.tmailor_accessToken || '').trim() }), openMailbox: tmailorOpenMailbox, listMessages: tmailorListMessages },
    im215: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.im215_baseUrl) && String(s.im215_apiKey || '').trim()), getConfig: (s) => ({ baseUrl: normalizeUrl(s.im215_baseUrl), apiKey: String(s.im215_apiKey || '').trim() }), openMailbox: im215OpenMailbox, listMessages: im215ListMessages },
  };

  function selectedProviderPool(settings) { const raw = String(settings.selectedProvidersCsv ?? ''); const requested = raw.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean); if (!raw.trim()) return []; return requested.filter((key) => PROVIDERS[key]); }
  function providerScore(providerKey) {
    const stat = providerStat(providerKey);
    let score = 120;
    score -= (Number(stat.failures) || 0) * 10;
    score -= (Number(stat.openFailures) || 0) * 6;
    score -= (Number(stat.readFailures) || 0) * 4;
    score -= (Number(stat.deliveryFailures) || 0) * 14;
    score -= (Number(stat.consecutiveFailures) || 0) * 18;
    if (stat.lastErrorKind === 'auth') score -= 500;
    if (stat.lastErrorKind === 'capacity') score -= 80;
    if (stat.lastSuccessAt) {
      const age = Date.now() - Number(stat.lastSuccessAt || 0);
      if (age <= 5 * 60 * 1000) score += 24;
      else if (age <= 15 * 60 * 1000) score += 12;
    }
    if (stat.lastOpenAt && Date.now() - Number(stat.lastOpenAt || 0) <= 10 * 60 * 1000) score += 8;
    if (stat.lastReadAt && Date.now() - Number(stat.lastReadAt || 0) <= 10 * 60 * 1000) score += 12;
    if (stat.lastFailureAt && Date.now() - Number(stat.lastFailureAt || 0) <= 3 * 60 * 1000) score -= 16;
    return score;
  }
  function orderedProviderCandidates(settings) {
    const pool = selectedProviderPool(settings).filter((key) => PROVIDERS[key] && PROVIDERS[key].isEnabled(settings) && PROVIDERS[key].isConfigured(settings));
    return pool
      .map((key) => ({ key, score: providerScore(key), tie: Math.random() }))
      .sort((a, b) => (b.score - a.score) || (a.tie - b.tie))
      .map((entry) => entry.key);
  }
  function providerRuntimeHint(providerKey, settings) {
    const provider = PROVIDERS[providerKey];
    if (!provider) return '';
    if (!provider.isEnabled(settings)) return t('disabled');
    if (!provider.isConfigured(settings)) return t('unconfigured');
    const stat = providerStat(providerKey);
    if (stat.lastSuccessAt) return currentLocale() === 'zh-CN' ? '可用' : 'Available';
    return t('configured');
  }
  function providerCardClass(providerKey, settings) {
    const provider = PROVIDERS[providerKey];
    if (!provider || !provider.isEnabled(settings)) return 'eep-provider-card is-disabled';
    if (!provider.isConfigured(settings)) return 'eep-provider-card is-unconfigured';
    return 'eep-provider-card is-configured';
  }
  function providerCardStatusDetail(providerKey, settings) {
    const provider = PROVIDERS[providerKey];
    if (!provider) return '';
    if (!provider.isEnabled(settings)) return currentLocale() === 'zh-CN' ? '当前已停用。' : 'Currently disabled.';
    if (!provider.isConfigured(settings)) return currentLocale() === 'zh-CN' ? '当前未配置。' : 'Not configured.';
    const stat = providerStat(providerKey);
    if (stat.lastErrorKind && stat.lastError) {
      return `${currentLocale() === 'zh-CN' ? '最近错误' : 'Last error'} · ${providerCoolingReasonText(providerKey)}`;
    }
    return currentLocale() === 'zh-CN' ? '当前可用。' : 'Currently available.';
  }
  function findHistoryMailboxByEmail(email) {
    const normalized = normalizeEmailAddress(email);
    if (!normalized) return null;
    return state.mailboxHistory.find((item) => normalizeEmailAddress(item.email) === normalized) || null;
  }
  function knownDomainsFromHistory(providerKey) {
    return [...new Set(state.mailboxHistory
      .filter((item) => item.providerKey === providerKey)
      .map((item) => getEmailDomain(item.email))
      .filter(Boolean))];
  }
  async function detectCloudflareDomainMatch(domain, cfg) {
    const cachedDomains = getCachedProviderDomains('cloudflare_temp_email');
    const cachedRootDomains = getCachedProviderRootDomains('cloudflare_temp_email');
    if (domainMatchesLibrary(domain, CLOUDFLARE_DOMAIN_LIBRARY.exactDomains, CLOUDFLARE_DOMAIN_LIBRARY.randomSubdomainRoots)) return true;
    if (domainMatchesLibrary(domain, cachedDomains, cachedRootDomains)) return true;
    const settings = await cloudflareGetSettings(cfg);
    const settingsDomains = splitDomainEntries(settings.domains || []);
    const settingsRootDomains = normalizeDomainEntries(settings.randomSubdomainDomains || []);
    return domainMatchesLibrary(
      domain,
      [...settingsDomains.exactDomains, ...CLOUDFLARE_DOMAIN_LIBRARY.exactDomains],
      [...settingsDomains.rootDomains, ...settingsRootDomains, ...CLOUDFLARE_DOMAIN_LIBRARY.randomSubdomainRoots],
    );
  }
  async function detectMoemailDomainMatch(domain, cfg) {
    const cached = getCachedProviderDomains('moemail');
    if (cached.length) return cached.includes(domain);
    const settings = await moemailGetConfig(cfg);
    const domains = extractDomainsFromBody(settings);
    setCachedProviderDomains('moemail', domains);
    return domains.includes(domain);
  }
  async function detectMailtmDomainMatch(domain, cfg) {
    const cached = getCachedProviderDomains('mailtm');
    if (cached.length) return cached.includes(domain);
    const domains = await mailtmGetDomains(cfg.baseUrl);
    return domains.includes(domain);
  }
  async function detectDuckmailDomainMatch(domain, cfg) {
    const cached = getCachedProviderDomains('duckmail');
    if (cached.length) return cached.includes(domain);
    const domains = await duckmailGetDomains(cfg);
    return domains.includes(domain);
  }
  async function detectIm215DomainMatch(domain, cfg) {
    const cached = getCachedProviderDomains('im215');
    if (cached.length) return cached.includes(domain);
    const domains = await im215GetDomains(cfg);
    return domains.includes(domain);
  }
  async function detectM2uDomainMatch(domain, cfg) {
    const cached = getCachedProviderDomains('m2u');
    if (cached.length) return cached.includes(domain);
    const domains = await m2uGetDomains(cfg);
    return domains.includes(domain);
  }
  async function guessMailboxProvider(email, settings) {
    const normalized = normalizeEmailAddress(email);
    if (!normalized) return null;
    const fromHistory = findHistoryMailboxByEmail(normalized);
    if (fromHistory) {
      return { providerKey: fromHistory.providerKey, mailbox: fromHistory, source: 'history', supported: true };
    }
    const domain = getEmailDomain(normalized);
    if (!domain) return null;
    const checks = [];
    if (PROVIDERS.cloudflare_temp_email.isConfigured(settings)) checks.push(async () => (await detectCloudflareDomainMatch(domain, PROVIDERS.cloudflare_temp_email.getConfig(settings))) ? ({ providerKey: 'cloudflare_temp_email', supported: true }) : null);
    if (GUERRILLA_DOMAINS.includes(domain)) checks.push(async () => ({ providerKey: 'guerrillamail', supported: true }));
    if (PROVIDERS.moemail.isConfigured(settings)) checks.push(async () => (await detectMoemailDomainMatch(domain, PROVIDERS.moemail.getConfig(settings))) ? ({ providerKey: 'moemail', supported: true }) : null);
    if (PROVIDERS.m2u.isConfigured(settings)) checks.push(async () => (await detectM2uDomainMatch(domain, PROVIDERS.m2u.getConfig(settings))) ? ({ providerKey: 'm2u', supported: false, reason: 'history-only' }) : null);
    if (PROVIDERS.im215.isConfigured(settings)) checks.push(async () => (await detectIm215DomainMatch(domain, PROVIDERS.im215.getConfig(settings))) ? ({ providerKey: 'im215', supported: true }) : null);
    if (PROVIDERS.duckmail.isConfigured(settings)) checks.push(async () => (await detectDuckmailDomainMatch(domain, PROVIDERS.duckmail.getConfig(settings))) ? ({ providerKey: 'duckmail', supported: false, reason: 'history-only' }) : null);
    if (PROVIDERS.mailtm.isConfigured(settings)) checks.push(async () => (await detectMailtmDomainMatch(domain, PROVIDERS.mailtm.getConfig(settings))) ? ({ providerKey: 'mailtm', supported: false, reason: 'history-only' }) : null);
    if (knownDomainsFromHistory('gptmail').includes(domain)) checks.push(async () => ({ providerKey: 'gptmail', supported: true }));
    if (knownDomainsFromHistory('tmailor').includes(domain)) checks.push(async () => ({ providerKey: 'tmailor', supported: true, reason: 'history-only' }));
    for (const run of checks) {
      try {
        const matched = await run();
        if (matched) return matched;
      } catch {}
    }
    return null;
  }
  function renderManualGuessHint(result) {
    const node = document.getElementById('eep-manual-guess');
    if (!node) return;
    if (!result) {
      node.textContent = t('manualGuessUnknown');
      node.dataset.tone = 'neutral';
      return;
    }
    if (result.mailbox && result.source === 'history') {
      node.textContent = `${providerLabel(result.providerKey)} · ${t('manualGuessHistory')}`;
      node.dataset.tone = 'success';
      return;
    }
    node.textContent = result.supported
      ? `${providerLabel(result.providerKey)} · ${t('manualGuessSupported')}`
      : `${providerLabel(result.providerKey)} · ${t('manualGuessUnsupported')}`;
    node.dataset.tone = result.supported ? 'success' : 'warn';
  }
  async function refreshManualGuess(email) {
    const normalized = normalizeEmailAddress(email || loadSetting('manualQueryEmail'));
    if (!normalized) return renderManualGuessHint(null);
    const result = await guessMailboxProvider(normalized, getSettings());
    renderManualGuessHint(result);
  }
  async function resolveManualMailboxByProvider(providerKey, email, settings) {
    const normalized = normalizeEmailAddress(email);
    if (!normalized) throw new Error('邮箱地址格式不正确。');
    if (providerKey === 'cloudflare_temp_email') {
      const cfg = PROVIDERS.cloudflare_temp_email.getConfig(settings);
      return { providerKey, email: normalized, mailboxData: { address: normalized }, metadata: { manualLookup: true, selectedDomain: getEmailDomain(normalized) }, listMessages: () => cloudflareListMessages(cfg, { email: normalized, mailboxData: { address: normalized } }) };
    }
    if (providerKey === 'guerrillamail') {
      const cfg = PROVIDERS.guerrillamail.getConfig(settings);
      const resolved = await guerrillaResolveMailboxByEmail(cfg, normalized);
      return { providerKey, ...resolved };
    }
    if (providerKey === 'moemail') {
      const cfg = PROVIDERS.moemail.getConfig(settings);
      const resolved = await moemailResolveMailboxByEmail(cfg, normalized);
      return { providerKey, ...resolved };
    }
    if (providerKey === 'gptmail') {
      const cfg = PROVIDERS.gptmail.getConfig(settings);
      const resolved = await gptmailResolveMailboxByEmail(cfg, normalized);
      return { providerKey, ...resolved };
    }
    if (providerKey === 'im215') {
      const cfg = PROVIDERS.im215.getConfig(settings);
      const resolved = await im215ResolveMailboxByEmail(cfg, normalized);
      return { providerKey, ...resolved };
    }
    if (providerKey === 'tmailor') {
      const historyMatch = findHistoryMailboxByEmail(normalized);
      if (historyMatch && historyMatch.mailboxData && historyMatch.mailboxData.token) {
        return { providerKey, email: normalized, mailboxData: historyMatch.mailboxData, metadata: { manualLookup: true, selectedDomain: getEmailDomain(normalized) } };
      }
      throw new Error(`Tmailor 需要 access token 才能查询邮箱。请先通过自动开邮箱创建，或在 Tmailor 设置中填入 access token。`);
    }
    if (providerKey === 'etempmail') {
      const historyMatch = findHistoryMailboxByEmail(normalized);
      if (historyMatch && historyMatch.mailboxData && historyMatch.mailboxData.recoverKey) {
        return { providerKey, email: normalized, mailboxData: historyMatch.mailboxData, metadata: { manualLookup: true, selectedDomain: getEmailDomain(normalized) } };
      }
      throw new Error(t('logManualUnsupported', { provider: providerLabel(providerKey) }));
    }
    if (providerKey === 'mailtm') {
      throw new Error(t('logManualUnsupported', { provider: providerLabel(providerKey) }));
    }
    throw new Error(t('logManualUnknown', { email: normalized }));
  }
  async function ensureManualMailboxEntry(email, settings) {
    const normalized = normalizeEmailAddress(email);
    if (!normalized) throw new Error('邮箱地址格式不正确。');
    const historyMailbox = findHistoryMailboxByEmail(normalized);
    if (historyMailbox) {
      selectHistoryMailbox(historyMailbox, false);
      renderManualGuessHint({ providerKey: historyMailbox.providerKey, mailbox: historyMailbox, source: 'history', supported: true });
      return historyMailbox;
    }
    const guessed = await guessMailboxProvider(normalized, settings);
    if (!guessed) throw new Error(t('logManualUnknown', { email: normalized }));
    renderManualGuessHint(guessed);
    if (!guessed.supported) throw new Error(t('logManualUnsupported', { provider: providerLabel(guessed.providerKey) }));
    const resolved = await resolveManualMailboxByProvider(guessed.providerKey, normalized, settings);
    const entry = {
      id: `manual:${resolved.providerKey}:${normalized}`,
      providerKey: resolved.providerKey,
      email: normalized,
      mailboxData: resolved.mailboxData,
      metadata: { ...(resolved.metadata || {}), manualLookup: true },
      openedAt: '',
    };
    upsertMailbox(entry);
    state.currentMessages = [];
    state.currentMessageId = '';
    state.historyDetailMode = 'code';
    setCurrentCode('');
    logLine(t('logManualGuess', { email: normalized, provider: providerLabel(resolved.providerKey) }));
    logLine(t('logManualPolling', { email: normalized, provider: providerLabel(resolved.providerKey) }));
    return entry;
  }
  function currentConfigProviderKey(settings) {
    const selected = String(settings.configProviderKey || DEFAULTS.configProviderKey || '').trim();
    return PROVIDERS[selected] ? selected : 'cloudflare_temp_email';
  }
  function renderProviderConfigForm(providerKey, settings) {
    const cardClass = providerCardClass(providerKey, settings);
    const hint = escapeHtml(providerRuntimeHint(providerKey, settings));
    const detail = escapeHtml(providerCardStatusDetail(providerKey, settings));
    if (providerKey === 'cloudflare_temp_email') {
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="cloudflare_baseUrl" value="${escapeHtml(settings.cloudflare_baseUrl)}" /></label><label class="eep-field"><span>${escapeHtml(t('auth'))}</span><input type="password" data-setting="cloudflare_customAuth" value="${escapeHtml(settings.cloudflare_customAuth)}" /></label><label class="eep-field"><span>${escapeHtml(t('adminAuth'))}</span><input type="password" data-setting="cloudflare_adminAuth" value="${escapeHtml(settings.cloudflare_adminAuth)}" /></label><label class="eep-field"><span>${escapeHtml(t('domain'))}</span><input data-setting="cloudflare_preferredDomain" value="${escapeHtml(settings.cloudflare_preferredDomain)}" /></label></div></div>`;
    }
    if (providerKey === 'mailtm') {
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="mailtm_baseUrl" value="${escapeHtml(settings.mailtm_baseUrl)}" /></label></div></div>`;
    }
    if (providerKey === 'duckmail') {
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="duckmail_baseUrl" value="${escapeHtml(settings.duckmail_baseUrl)}" /></label><label class="eep-field"><span>${escapeHtml(t('domain'))}</span><input data-setting="duckmail_preferredDomain" value="${escapeHtml(settings.duckmail_preferredDomain)}" /></label></div></div>`;
    }
    if (providerKey === 'guerrillamail') {
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="guerrillamail_apiBase" value="${escapeHtml(settings.guerrillamail_apiBase)}" /></label></div></div>`;
    }
    if (providerKey === 'tempmail-lol') {
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="tempmailLol_baseUrl" value="${escapeHtml(settings.tempmailLol_baseUrl)}" /></label></div></div>`;
    }
    if (providerKey === 'etempmail') {
      const currentRecoverKey = (() => { const mb = currentMailbox(); return mb && mb.providerKey === 'etempmail' && mb.mailboxData && mb.mailboxData.recoverKey ? mb.mailboxData.recoverKey : ''; })();
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="etempmail_baseUrl" value="${escapeHtml(settings.etempmail_baseUrl)}" /></label><label class="eep-field"><span>${escapeHtml(t('domain'))}</span><input data-setting="etempmail_preferredDomain" value="${escapeHtml(settings.etempmail_preferredDomain || '')}" placeholder="cross.edu.pl / beta.edu.pl" /></label>${currentRecoverKey ? `<label class="eep-field"><span>Recovery Key</span><input readonly value="${escapeHtml(currentRecoverKey)}" class="eep-copy-value" onclick="navigator.clipboard.writeText(this.value).catch(()=>{})" title="点击复制" style="cursor:pointer;opacity:.85" /></label>` : ''}</div></div>`;
    }
    if (providerKey === 'moemail') {
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="moemail_baseUrl" value="${escapeHtml(settings.moemail_baseUrl)}" /></label><label class="eep-field"><span>${escapeHtml(t('apiKey'))}</span><input type="password" data-setting="moemail_apiKey" value="${escapeHtml(settings.moemail_apiKey)}" /></label><label class="eep-field"><span>${escapeHtml(t('expiry'))}</span><input type="number" min="60000" step="60000" data-setting="moemail_expiryTimeMs" value="${escapeHtml(settings.moemail_expiryTimeMs || '3600000')}" /></label></div></div>`;
    }
    if (providerKey === 'm2u') {
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="m2u_baseUrl" value="${escapeHtml(settings.m2u_baseUrl)}" /></label><label class="eep-field"><span>${escapeHtml(t('domain'))}</span><input data-setting="m2u_preferredDomain" value="${escapeHtml(settings.m2u_preferredDomain)}" placeholder="edu.kg / cpu.edu.kg" /></label></div></div>`;
    }
    if (providerKey === 'gptmail') {
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="gptmail_baseUrl" value="${escapeHtml(settings.gptmail_baseUrl)}" /></label><label class="eep-field"><span>${escapeHtml(t('apiKeys'))}</span><input type="password" data-setting="gptmail_apiKey" value="${escapeHtml(settings.gptmail_apiKey)}" /></label><label class="eep-field"><span>${escapeHtml(t('prefix'))}</span><input data-setting="gptmail_prefix" value="${escapeHtml(settings.gptmail_prefix)}" /></label></div></div>`;
    }
    if (providerKey === 'tmailor') {
      const currentTmailorToken = (() => { const mb = currentMailbox(); return mb && mb.providerKey === 'tmailor' && mb.mailboxData && mb.mailboxData.token ? mb.mailboxData.token : ''; })();
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="tmailor_baseUrl" value="${escapeHtml(settings.tmailor_baseUrl)}" /></label><label class="eep-field"><span>Access Token</span><input data-setting="tmailor_accessToken" value="${escapeHtml(settings.tmailor_accessToken || '')}" placeholder="留空则自动创建新邮箱" /></label>${currentTmailorToken ? `<label class="eep-field"><span>当前邮箱 Token</span><input readonly value="${escapeHtml(currentTmailorToken)}" class="eep-copy-value" onclick="navigator.clipboard.writeText(this.value).catch(()=>{})" title="点击复制" style="cursor:pointer;opacity:.85" /></label>` : ''}</div></div>`;
    }
    if (providerKey === 'im215') {
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="im215_baseUrl" value="${escapeHtml(settings.im215_baseUrl)}" /></label><label class="eep-field"><span>${escapeHtml(t('apiKey'))}</span><input type="password" data-setting="im215_apiKey" value="${escapeHtml(settings.im215_apiKey)}" /></label></div></div>`;
    }
    return '';
  }
  function updateMiniSummary() { const node = document.getElementById('eep-mini-summary'); if (!node) return; const mailbox = currentMailbox(); node.textContent = !mailbox ? t('none') : (state.lastCode ? `${mailbox.email} · ${state.lastCode}` : mailbox.email); }
  function miniChipNode(kind) { return document.getElementById(`eep-mini-chip-${kind}`); }
  function hideMiniChip(kind) { const node = miniChipNode(kind); if (!node) return; node.classList.remove('is-visible'); node.textContent = ''; node.dataset.copyText = ''; }
  function showMiniChip(kind, text) { const node = miniChipNode(kind); if (!node || !text) return; node.textContent = String(text); node.dataset.copyText = String(text); node.classList.add('is-visible'); copyText(String(text)).catch(() => {}); if (miniChipTimers[kind]) clearTimeout(miniChipTimers[kind]); miniChipTimers[kind] = setTimeout(() => hideMiniChip(kind), 5000); }
  function setCurrentCode(code) { state.lastCode = String(code || '').trim(); const node = document.getElementById('eep-current-code'); if (node) node.textContent = state.lastCode || t('none'); if (!state.lastCode) hideMiniChip('code'); updateMiniSummary(); }
  function renderMailboxSummary() { const mailbox = currentMailbox(); const emailNode = document.getElementById('eep-current-email'); const providerNode = document.getElementById('eep-current-provider'); const codeNode = document.getElementById('eep-current-code'); const openedNode = document.getElementById('eep-current-opened'); if (!mailbox) { if (emailNode) emailNode.textContent = t('emptyHistory'); if (providerNode) providerNode.textContent = t('none'); if (codeNode) codeNode.textContent = state.lastCode || t('none'); if (openedNode) openedNode.textContent = t('none'); return; } if (emailNode) emailNode.textContent = mailbox.email; if (providerNode) providerNode.textContent = providerLabel(mailbox.providerKey); if (codeNode) codeNode.textContent = state.lastCode || t('none'); if (openedNode) openedNode.textContent = formatObservedAt(mailbox.openedAt); }
  function renderActionLinks(message) {
    const links = Array.isArray(message && message.actionLinks) ? message.actionLinks.filter((link) => link && link.url) : [];
    if (!links.length) return `<div class="eep-raw-block"><h4>${escapeHtml(t('rawLinks'))}</h4><pre>${escapeHtml(t('none'))}</pre></div>`;
    return `<div class="eep-raw-block"><h4>${escapeHtml(t('rawLinks'))}</h4><div style="display:grid;gap:10px;margin-top:12px;">${links.map((link) => {
      const url = String(link.url || '');
      const label = String(link.label || url);
      return `<div style="display:grid;gap:8px;padding:12px;border-radius:14px;background:rgba(9,15,27,.66);border:1px solid rgba(130,170,255,.08);"><div style="word-break:break-word;font-weight:700;">${escapeHtml(label)}</div><div style="word-break:break-all;color:rgba(217,235,255,.72);font-size:12px;">${escapeHtml(url)}</div><div style="display:flex;flex-wrap:wrap;gap:8px;"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;justify-content:center;border-radius:12px;background:linear-gradient(90deg,#2563eb,#22a7f0);color:#fff;padding:10px 14px;text-decoration:none;">${escapeHtml(t('openLink'))}</a><button type="button" data-message-link-copy="${escapeHtml(url)}">${escapeHtml(t('copyLink'))}</button></div></div>`;
    }).join('')}</div></div>`;
  }
  function renderMessageBodyBlock(title, value, preClass = '') {
    return `<div class="eep-raw-block"><h4>${escapeHtml(title)}</h4><pre class="${preClass}">${escapeHtml(String(value || '').trim() || t('none'))}</pre></div>`;
  }
  function renderHtmlSourceBlock(message) {
    const htmlBody = String(message && message.htmlBody || '').trim();
    if (!htmlBody) return '';
    return `<details class="eep-raw-toggle"><summary>${escapeHtml(t('rawHtml'))}</summary><div class="eep-raw-block eep-raw-block-compact"><pre class="eep-raw-source-pre">${escapeHtml(htmlBody)}</pre></div></details>`;
  }
  function renderInlineMessageDetail(message) {
    if (!message) return `<div class="eep-empty">${escapeHtml(t('emptyMessages'))}</div>`;
    return `<div class="eep-raw-head"><div><strong>${escapeHtml(message.subject || t('none'))}</strong></div><div>${escapeHtml(message.sender || t('none'))}</div><div>${escapeHtml(formatObservedAt(message.observedAt))}</div><div>${escapeHtml(t('rawSource'))}: ${escapeHtml(message.codeSource || t('none'))}</div></div>${renderMessageBodyBlock(t('rawText'), message.textBody, 'eep-raw-body-pre')}${renderHtmlSourceBlock(message)}${renderActionLinks(message)}${renderMessageBodyBlock(t('rawCandidates'), (message.extractedCandidates || []).join(', '), 'eep-raw-meta-pre')}`;
  }
  function renderInlineCodeDetail(mailbox) {
    const metadata = mailbox && mailbox.metadata ? mailbox.metadata : {};
    const code = String(metadata.lastCodeValue || '').trim();
    const codeObservedAt = metadata.lastCodeObservedAt ? formatObservedAt(metadata.lastCodeObservedAt) : t('none');
    if (!code) return `<div class="eep-empty">${escapeHtml(t('logReadNone'))}</div>`;
    return `<div class="eep-code-detail"><div class="eep-code-value">${escapeHtml(code)}</div><div class="eep-code-meta">${escapeHtml(codeObservedAt)}</div></div>`;
  }
  function renderMailboxHistory() {
    const root = document.getElementById('eep-history-list');
    if (!root) return;
    if (!state.mailboxHistory.length) {
      root.innerHTML = `<div class="eep-empty">${escapeHtml(t('emptyHistory'))}</div>`;
      return;
    }
    root.innerHTML = state.mailboxHistory.map((item) => {
      const isCurrent = item.id === state.currentMailboxId;
      const activeMessage = isCurrent ? (state.currentMessages.find((message) => message.id === state.currentMessageId) || state.currentMessages[0] || null) : null;
      const detailHtml = isCurrent
        ? (state.historyDetailMode === 'messages'
          ? `<div class="eep-history-message-shell">${!state.currentMessages.length ? `<div class="eep-empty">${escapeHtml(t('emptyMessages'))}</div>` : `<div class="eep-message-list eep-message-list-inline">${state.currentMessages.map((message) => `<button class="eep-message-item${message.id === (activeMessage && activeMessage.id) ? ' is-active' : ''}" data-message-id="${escapeHtml(message.id)}"><strong>${escapeHtml(message.subject || t('none'))}</strong><span>${escapeHtml(message.sender || t('none'))}</span><span>${escapeHtml(formatObservedAt(message.observedAt))}</span>${message.extractedCode ? `<span class="eep-chip">${escapeHtml(message.extractedCode)}</span>` : ''}</button>`).join('')}</div><div class="eep-raw-message eep-raw-message-inline">${renderInlineMessageDetail(activeMessage)}</div>`}</div>`
          : `<div class="eep-history-message-shell">${renderInlineCodeDetail(item)}</div>`)
        : '';
      return `<div class="eep-history-item${isCurrent ? ' is-current' : ''}"><div class="eep-history-main" data-history-select="${escapeHtml(item.id)}"><div class="eep-history-email">${escapeHtml(item.email)}</div><div class="eep-history-meta">${escapeHtml(providerLabel(item.providerKey))} · ${escapeHtml(formatObservedAt(item.openedAt))}</div></div><div class="eep-history-actions"><button data-history-action="poll" data-history-id="${escapeHtml(item.id)}">${escapeHtml(t('historyPoll'))}</button><button data-history-action="messages" data-history-id="${escapeHtml(item.id)}">${escapeHtml(t('historyMessages'))}</button></div>${detailHtml}</div>`;
    }).join('');
  }
  function renderMessages(messages) {
    state.currentMessages = Array.isArray(messages) ? messages : [];
    if (!state.currentMessages.find((message) => message.id === state.currentMessageId)) {
      state.currentMessageId = state.currentMessages[0] ? state.currentMessages[0].id : '';
    }
    renderMailboxHistory();
  }
  function renderMessageDetail(message) {
    if (!message) return;
    state.currentMessageId = message.id;
    renderMailboxHistory();
  }
  function isVisible(node) { const rect = node.getBoundingClientRect(); const style = window.getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; }
  function isWritableField(node) { return !!node && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) && !node.disabled && !node.readOnly && isVisible(node) && !node.closest('#eep-panel') && !node.closest('#eep-mini-bar') && !node.closest('[data-easyemail-ignore="true"]') && !node.closest('form[data-easyemail-ignore]'); }
  function elementDescriptor(node) { const parts = [node.tagName.toLowerCase()]; if (node.id) parts.push(`#${node.id}`); const name = node.getAttribute('name'); if (name) parts.push(`[name='${name}']`); const placeholder = node.getAttribute('placeholder'); if (placeholder) parts.push(`“${placeholder}”`); return parts.join(' '); }
  function collectInputs(scope) { return Array.from(scope.querySelectorAll('input, textarea')).filter(isWritableField); }
  function activeScope() { const active = document.activeElement; const form = active && active.closest ? active.closest('form') : null; return form || document.body; }
  function emailFieldScore(node) { const haystack = [node.type, node.name, node.id, node.placeholder, node.autocomplete, node.getAttribute('aria-label')].map((item) => String(item || '').toLowerCase()).join('\n'); let score = 0; if (node.type === 'email') score += 120; if ((node.autocomplete || '').toLowerCase() === 'email') score += 80; if (/email|e-mail|mail|邮箱|电子邮箱/.test(haystack)) score += 60; return score; }
  function codeFieldScore(node) { const haystack = [node.type, node.name, node.id, node.placeholder, node.autocomplete, node.getAttribute('aria-label')].map((item) => String(item || '').toLowerCase()).join('\n'); let score = 0; if (/otp|one-time|verification|verify|security code|auth code|2fa|验证码|校验码|动态码|口令/.test(haystack)) score += 80; if (node.maxLength && Number(node.maxLength) >= 4 && Number(node.maxLength) <= 10) score += 18; if ((node.inputMode || '').toLowerCase() === 'numeric') score += 12; return score; }
  function findEmailTarget() { const inputs = collectInputs(activeScope()); return [...inputs].sort((a, b) => emailFieldScore(b) - emailFieldScore(a))[0] || null; }
  function otpGroupContainer(node) { if (!node || !node.parentElement) return null; const siblings = Array.from(node.parentElement.querySelectorAll('input')); const similar = siblings.filter((candidate) => isWritableField(candidate) && candidate.maxLength === 1); return similar.length >= 4 ? similar : null; }
  function findCodeTargets() { const inputs = collectInputs(activeScope()); const scored = inputs.map((node) => ({ node, score: codeFieldScore(node) })).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score); const top = scored[0] ? scored[0].node : null; if (!top) return { nodes: [], kind: 'single' }; const group = otpGroupContainer(top); return group ? { nodes: group, kind: 'group' } : { nodes: [top], kind: 'single' }; }
  function flashTargets(nodes, tone = 'info') { if (!readBool('highlightTargets')) return; nodes.forEach((node) => { node.classList.add('eep-target-flash', `eep-target-${tone}`); setTimeout(() => node.classList.remove('eep-target-flash', `eep-target-${tone}`), 1400); }); }
  function renderDetectedTargets() { const emailNode = document.getElementById('eep-detected-email'); const codeNode = document.getElementById('eep-detected-code'); if (emailNode) emailNode.textContent = state.detectedTargets.email ? elementDescriptor(state.detectedTargets.email) : t('notFound'); if (codeNode) codeNode.textContent = !state.detectedTargets.code.length ? t('notFound') : state.detectedTargets.kind === 'group' ? `${elementDescriptor(state.detectedTargets.code[0])} × ${state.detectedTargets.code.length}` : elementDescriptor(state.detectedTargets.code[0]); }
  function removeInlineWidget(kind) { const node = document.querySelector(`.eep-inline-widget[data-kind="${kind}"]`); if (node) node.remove(); }
  function getInlineAnchor(kind) { return kind === 'email' ? state.detectedTargets.email : state.detectedTargets.code[0] || null; }
  function placeInlineWidget(widget, anchor) { if (!widget || !anchor) return; const rect = anchor.getBoundingClientRect(); widget.style.top = `${window.scrollY + rect.top - 4}px`; widget.style.left = `${window.scrollX + rect.right + 8}px`; }
  function createInlineWidget(kind) { removeInlineWidget(kind); const widget = document.createElement('div'); widget.className = 'eep-inline-widget'; widget.dataset.kind = kind; widget.innerHTML = kind === 'email' ? `<button data-action="fill-email">${escapeHtml(t('widgetFillEmail'))}</button><button data-action="open-fill">${escapeHtml(t('widgetOpenFill'))}</button>` : `<button data-action="fill-code">${escapeHtml(t('widgetFillCode'))}</button><button data-action="poll-fill">${escapeHtml(t('widgetPoll'))}</button>`; document.body.appendChild(widget); const anchor = getInlineAnchor(kind); if (anchor) placeInlineWidget(widget, anchor); return widget; }
  function syncInlineWidgets() { if (state.detectedTargets.email) placeInlineWidget(document.querySelector('.eep-inline-widget[data-kind="email"]') || createInlineWidget('email'), state.detectedTargets.email); else removeInlineWidget('email'); if (state.detectedTargets.code.length) placeInlineWidget(document.querySelector('.eep-inline-widget[data-kind="code"]') || createInlineWidget('code'), state.detectedTargets.code[0]); else removeInlineWidget('code'); }
  function scheduleDetectTargets() { state.detectedTargets.email = findEmailTarget(); const codeTargets = findCodeTargets(); state.detectedTargets.code = codeTargets.nodes; state.detectedTargets.kind = codeTargets.kind; renderDetectedTargets(); syncInlineWidgets(); }
  function dispatchFieldEvents(node) { node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); }
  function fillNodeValue(node, value) { node.focus(); node.value = value; dispatchFieldEvents(node); }
  function shouldOverwrite(node) { return readBool('forceFillNonEmpty') || !String(node.value || '').trim(); }
  function fillEmailTarget(email) { const target = state.detectedTargets.email || findEmailTarget(); if (!target) return logLine(t('logNoEmailField'), 'error'); if (!shouldOverwrite(target)) return false; fillNodeValue(target, email); flashTargets([target], 'success'); logLine(t('logEmailFilled', { target: elementDescriptor(target) })); return true; }
  function fillCodeTarget(code) { const codeTargets = state.detectedTargets.code.length ? state.detectedTargets : findCodeTargets(); if (!codeTargets.nodes.length) return logLine(t('logNoCodeField'), 'error'); if (!code) return logLine(t('logNoCode'), 'error'); if (codeTargets.kind === 'group') { const chars = Array.from(String(code)); if (chars.length === codeTargets.nodes.length) { codeTargets.nodes.forEach((node, index) => { if (shouldOverwrite(node)) fillNodeValue(node, chars[index] || ''); }); flashTargets(codeTargets.nodes, 'success'); logLine(t('logCodeGroupFilled', { count: codeTargets.nodes.length })); return true; } } const target = codeTargets.nodes[0]; if (!shouldOverwrite(target)) return false; fillNodeValue(target, code); flashTargets([target], 'success'); logLine(t('logCodeFilled', { target: elementDescriptor(target) })); return true; }
  function renderSelectedProviders(settings) {
    const root = document.getElementById('eep-selected-providers');
    if (!root) return;
    const selected = new Set(selectedProviderPool(settings));
    root.innerHTML = Object.keys(PROVIDERS).map((key) => {
      const hint = providerRuntimeHint(key, settings);
      const detail = providerCardStatusDetail(key, settings);
      return `<label class="eep-chip${selected.has(key) ? ' is-selected' : ''}" title="${escapeHtml(detail)}"><input type="checkbox" data-provider-pool="${escapeHtml(key)}" ${selected.has(key) ? 'checked' : ''} /><span>${escapeHtml(providerLabel(key))}</span><small>${escapeHtml(hint)}</small></label>`;
    }).join('');
  }
  function buildModeUi(settings) {
    const autoRow = document.getElementById('eep-row-auto');
    const explicitRow = document.getElementById('eep-row-explicit');
    const isAuto = String(settings.providerMode || DEFAULTS.providerMode) !== 'explicit';
    if (autoRow) autoRow.style.display = isAuto ? '' : 'none';
    if (explicitRow) explicitRow.style.display = isAuto ? 'none' : '';
  }
  function renderActionState() { document.querySelectorAll('#eep-panel button[data-action], #eep-mini-bar button[data-action]').forEach((button) => { const action = button.dataset.action || ''; if (action === 'toggle-panel' || action === 'poll-otp') button.disabled = false; else button.disabled = state.busy; }); const pollButton = document.getElementById('eep-side-poll-btn'); if (pollButton) { pollButton.textContent = state.polling ? '■' : '码'; pollButton.title = state.polling ? t('stop') : t('pollCode'); } }
  async function runAction(name, fn, options = {}) { if (state.busy) return; state.busy = true; state.polling = Boolean(options.polling); state.stopRequested = false; renderActionState(); try { return await fn(); } catch (error) { const message = error instanceof Error ? error.message : String(error); setStatus(message, 'error'); logLine(message, 'error'); return undefined; } finally { state.busy = false; if (!options.keepPollingState) state.polling = false; renderActionState(); if (!state.polling && document.getElementById('eep-status')?.dataset.tone !== 'error') setStatus(t('ready')); } }
  function updateStoredSettingsFromUi() { document.querySelectorAll('[data-setting]').forEach((node) => { const key = node.dataset.setting; if (!key) return; saveSetting(key, node.type === 'checkbox' ? (node.checked ? 'true' : 'false') : (node.value || '')); }); const selected = Array.from(document.querySelectorAll('input[data-provider-pool]:checked')).map((node) => node.dataset.providerPool).filter(Boolean); saveSetting('selectedProvidersCsv', selected.join(',')); }
  function mailboxOpenedAtMs(mailboxEntry) { return parseDateValue(mailboxEntry && mailboxEntry.metadata && mailboxEntry.metadata.notBeforeAt || mailboxEntry && mailboxEntry.openedAt); }
  function mailboxLastCodeObservedAtMs(mailboxEntry) { return parseDateValue(mailboxEntry && mailboxEntry.metadata && mailboxEntry.metadata.lastCodeObservedAt); }
  function messageIsFreshForMailbox(message, mailboxEntry) { const observedMs = parseDateValue(message && message.observedAt); if (!observedMs) return false; const lastCodeMs = mailboxLastCodeObservedAtMs(mailboxEntry); const lastCodeMessageId = mailboxEntry && mailboxEntry.metadata && mailboxEntry.metadata.lastCodeMessageId ? String(mailboxEntry.metadata.lastCodeMessageId) : ''; if (lastCodeMs) return observedMs > lastCodeMs || (observedMs === lastCodeMs && String(message && message.id || '') !== lastCodeMessageId); const openMs = mailboxOpenedAtMs(mailboxEntry); if (!openMs) return true; return observedMs >= (openMs - 1000); }
  async function openMailboxUsingProvider(providerKey, settings) { const provider = PROVIDERS[providerKey]; logLine(t('logTryProvider', { provider: providerLabel(providerKey) })); const opened = await provider.openMailbox(provider.getConfig(settings)); const openedAt = new Date().toISOString(); const entry = { id: `${providerKey}:${Date.now()}:${randomHex(6)}`, providerKey, email: opened.email, mailboxData: opened.mailboxData, metadata: { ...(opened.metadata || {}), notBeforeAt: openedAt }, openedAt }; upsertMailbox(entry); state.currentMessages = []; state.currentMessageId = ''; state.historyDetailMode = 'code'; setCurrentCode(''); renderMessages([]); recordProviderSuccess(providerKey, 'open'); showMiniChip('email', opened.email); if (providerKey === 'tmailor' && opened.mailboxData && opened.mailboxData.token) { saveSetting('tmailor_accessToken', opened.mailboxData.token); const tokenInput = document.querySelector('[data-setting="tmailor_accessToken"]'); if (tokenInput) tokenInput.value = opened.mailboxData.token; } logLine(t('logOpen', { email: opened.email, provider: providerLabel(providerKey) })); return entry; }
  async function openMailboxAuto(settings) {
    const candidates = settings.providerMode === 'explicit' ? [settings.explicitProviderKey] : orderedProviderCandidates(settings);
    if (!candidates.length) throw new Error(t('logNoProvider'));
    for (const providerKey of candidates) {
      const provider = PROVIDERS[providerKey];
      if (!provider || !provider.isEnabled(settings) || !provider.isConfigured(settings)) continue;
      try {
        return await openMailboxUsingProvider(providerKey, settings);
      } catch (error) {
        recordProviderFailure(providerKey, error, 'open');
        logLine(t('logProviderFailed', { provider: providerLabel(providerKey), detail: String(error.message || error) }), 'error');
      }
    }
    throw new Error(t('logNoProvider'));
  }
  async function loadMailboxMessages(mailboxEntry, settings) {
    if (!mailboxEntry) throw new Error(t('logNoMailbox'));
    const provider = PROVIDERS[mailboxEntry.providerKey];
    try {
      const messages = await provider.listMessages(provider.getConfig(settings), mailboxEntry);
      const normalized = messages.filter(Boolean).sort((a, b) => (String(settings.newestFirst) === 'true' ? (Date.parse(b.observedAt || '') || 0) - (Date.parse(a.observedAt || '') || 0) : (Date.parse(a.observedAt || '') || 0) - (Date.parse(b.observedAt || '') || 0)));
      state.currentMessages = normalized;
      renderMessages(normalized);
      recordProviderSuccess(mailboxEntry.providerKey, 'read');
      logLine(t('logMessages', { count: normalized.length }));
      setJsonOutput({ provider: mailboxEntry.providerKey, messages: normalized });
      return normalized;
    } catch (error) {
      recordProviderFailure(mailboxEntry.providerKey, error, 'read');
      throw error;
    }
  }
  function selectMatchingMessage(messages, settings, mailboxEntry) { return messages.filter((message) => matchesSenderFilter(message, settings.fromContains)).filter((message) => messageIsFreshForMailbox(message, mailboxEntry)).find((message) => message.extractedCode) || null; }
  async function readMailboxOnce(mailboxEntry, settings) {
    const messages = await loadMailboxMessages(mailboxEntry, settings);
    const matched = selectMatchingMessage(messages, settings, mailboxEntry);
    if (!matched || !matched.extractedCode) {
      const hasHistoricalOnly = messages.filter((message) => matchesSenderFilter(message, settings.fromContains)).some((message) => message.extractedCode);
      state.historyDetailMode = 'code';
      renderMailboxHistory();
      return logLine(hasHistoricalOnly ? t('logReadHistoricalOnly') : t('logReadNone'));
    }
    mailboxEntry.metadata = mailboxEntry.metadata || {};
    mailboxEntry.metadata.lastCodeObservedAt = matched.observedAt || new Date().toISOString();
    mailboxEntry.metadata.lastCodeMessageId = matched.id;
    mailboxEntry.metadata.lastCodeValue = matched.extractedCode;
    upsertMailbox(mailboxEntry);
    recordProviderSuccess(mailboxEntry.providerKey, 'read');
    setCurrentCode(matched.extractedCode);
    state.historyDetailMode = 'code';
    showMiniChip('code', matched.extractedCode);
    renderMessageDetail(matched);
    logLine(t('logRead', { code: matched.extractedCode }));
    return matched;
  }
  async function pollMailboxUntilCode(mailboxEntry, settings) {
    state.polling = true;
    renderActionState();
    const pollSeconds = Math.max(1, Number.parseInt(settings.pollSeconds, 10) || 3);
    const timeoutSeconds = Math.max(1, Number.parseInt(settings.timeoutSeconds, 10) || 180);
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (!state.stopRequested) {
      const matched = await readMailboxOnce(mailboxEntry, settings);
      if (matched && matched.extractedCode) {
        state.polling = false;
        renderActionState();
        return matched;
      }
      if (Date.now() >= deadline) {
        state.polling = false;
        renderActionState();
        const timeoutError = new Error(t('logPollTimeout', { provider: providerLabel(mailboxEntry.providerKey), seconds: timeoutSeconds }));
        recordProviderFailure(mailboxEntry.providerKey, timeoutError, 'poll-timeout');
        throw timeoutError;
      }
      logLine(t('logSleep', { seconds: pollSeconds }));
      await sleep(pollSeconds * 1000);
    }
    state.polling = false;
    renderActionState();
    logLine(t('logPollStopped'));
    return null;
  }
  function selectHistoryMailbox(mailbox, clearMessages = false) {
    if (!mailbox) return;
    const changed = state.currentMailboxId !== mailbox.id;
    state.currentMailboxId = mailbox.id;
    if (changed || clearMessages) {
      state.currentMessages = [];
      state.currentMessageId = '';
    }
    saveMailboxHistory();
  }
  async function onHistoryAction(action, id) {
    const mailbox = state.mailboxHistory.find((item) => item.id === id);
    if (!mailbox) return logLine(t('logMailboxNotFound'), 'error');
    selectHistoryMailbox(mailbox, action !== 'messages');
    const settings = getSettings();
    if (action === 'poll') {
      state.historyDetailMode = 'code';
      renderMailboxHistory();
      return runAction('history-poll', () => pollMailboxUntilCode(mailbox, settings), { polling: true, keepPollingState: true });
    }
    if (action === 'messages') {
      state.historyDetailMode = 'messages';
      renderMailboxHistory();
      return runAction('history-messages', () => loadMailboxMessages(mailbox, settings));
    }
  }
  function updateMiniBarVisibility() { const minimized = document.body.dataset.eepMinimized === 'true'; const panel = document.getElementById('eep-panel'); if (panel) panel.classList.toggle('is-minimized', minimized); }
  function toggleMinimize() { const next = document.body.dataset.eepMinimized === 'true' ? 'false' : 'true'; document.body.dataset.eepMinimized = next; updateMiniBarVisibility(); }
  function createPanel() {
    const existing = document.getElementById('eep-panel');
    if (existing) existing.remove();
    const settings = getSettings();
    const panel = document.createElement('section');
    panel.id = 'eep-panel';
    panel.innerHTML = `
      <div class="eep-head"><div><h1>${escapeHtml(t('title'))}</h1></div></div>
      <div class="eep-current-card"><div class="eep-current-head">${escapeHtml(t('current'))}</div><div class="eep-current-grid"><div><span>${escapeHtml(t('currentEmail'))}</span><strong class="eep-copy-value" id="eep-current-email" title="点击复制"></strong></div><div><span>${escapeHtml(t('currentCode'))}</span><strong class="eep-copy-value" id="eep-current-code" title="点击复制"></strong></div><div><span>${escapeHtml(t('currentProvider'))}</span><strong id="eep-current-provider"></strong></div><div><span>${escapeHtml(t('currentOpened'))}</span><strong id="eep-current-opened"></strong></div></div></div>
      <div class="eep-manual-card"><div class="eep-manual-head">${escapeHtml(t('manualLookup'))}</div><div class="eep-grid eep-main-grid"><label class="eep-field eep-main-span"><span>${escapeHtml(t('manualEmail'))}</span><input type="text" id="eep-manual-email" data-setting="manualQueryEmail" value="${escapeHtml(settings.manualQueryEmail || '')}" placeholder="example@mail.com" /></label></div><div class="eep-manual-actions"><div class="eep-manual-guess"><span>${escapeHtml(t('manualGuess'))}</span><strong id="eep-manual-guess">${escapeHtml(t('manualGuessUnknown'))}</strong></div><button data-action="manual-poll">${escapeHtml(t('manualPoll'))}</button></div></div>
      <div class="eep-settings-shell"><div class="eep-grid eep-main-grid"><label class="eep-field"><span>${escapeHtml(t('locale'))}</span><select data-setting="locale" id="eep-locale"><option value="zh-CN">中文</option><option value="en-US">English</option></select></label><label class="eep-field"><span>${escapeHtml(t('mode'))}</span><select data-setting="providerMode" id="eep-provider-mode"><option value="auto">${escapeHtml(t('auto'))}</option><option value="explicit">${escapeHtml(t('explicit'))}</option></select></label></div><div id="eep-row-auto" class="eep-help eep-settings-block"><span>${escapeHtml(t('providerPool'))}</span><div id="eep-selected-providers" class="eep-provider-pool"></div></div><div id="eep-row-explicit" class="eep-grid eep-main-grid"><label class="eep-field"><span>${escapeHtml(t('provider'))}</span><select data-setting="explicitProviderKey" id="eep-explicit-provider"></select></label></div><div class="eep-grid eep-main-grid"><label class="eep-field"><span>${escapeHtml(t('poll'))}</span><input type="number" min="1" data-setting="pollSeconds" value="${escapeHtml(settings.pollSeconds)}" /></label><label class="eep-field"><span>${escapeHtml(t('timeout'))}</span><input type="number" min="5" data-setting="timeoutSeconds" value="${escapeHtml(settings.timeoutSeconds)}" /></label></div><div class="eep-grid eep-main-grid"><label class="eep-field"><span>${escapeHtml(t('filter'))}</span><input type="text" data-setting="fromContains" value="${escapeHtml(settings.fromContains)}" /></label><label class="eep-field"><span>${escapeHtml(t('configProvider'))}</span><select data-setting="configProviderKey" id="eep-config-provider"></select></label></div><div id="eep-provider-settings" class="eep-provider-settings"></div></div>
      <details open><summary>${escapeHtml(t('history'))}</summary><div id="eep-history-list"></div></details>`;
    document.body.appendChild(panel);
    const explicit = document.getElementById('eep-explicit-provider'); if (explicit) { explicit.innerHTML = Object.keys(PROVIDERS).map((key) => `<option value="${escapeHtml(key)}">${escapeHtml(providerLabel(key))}</option>`).join(''); explicit.value = settings.explicitProviderKey || DEFAULTS.explicitProviderKey; }
    const configProvider = document.getElementById('eep-config-provider'); if (configProvider) { configProvider.innerHTML = Object.keys(PROVIDERS).map((key) => `<option value="${escapeHtml(key)}">${escapeHtml(providerLabel(key))}</option>`).join(''); configProvider.value = currentConfigProviderKey(settings); }
    document.getElementById('eep-locale').value = settings.locale || DEFAULTS.locale;
    document.getElementById('eep-provider-mode').value = settings.providerMode || DEFAULTS.providerMode;
    buildModeUi(settings); renderSelectedProviders(settings);
    const root = document.getElementById('eep-provider-settings'); if (root) root.innerHTML = renderProviderConfigForm(currentConfigProviderKey(settings), settings);
    renderMailboxSummary(); renderMailboxHistory(); renderMessages(state.currentMessages || []); renderActionState(); updateMiniSummary(); refreshManualGuess(settings.manualQueryEmail).catch(() => renderManualGuessHint(null));
  }

  function createMiniBar() { const existing = document.getElementById('eep-mini-bar'); if (existing) existing.remove(); const bar = document.createElement('div'); bar.id = 'eep-mini-bar'; bar.innerHTML = `<div class="eep-side-row"><button class="eep-side-btn" data-action="toggle-panel" title="${escapeHtml(t('settings'))}">⚙</button></div><div class="eep-side-row"><button class="eep-mini-chip" id="eep-mini-chip-email" data-copy-kind="email"></button><button class="eep-side-btn" data-action="open-mailbox" title="${escapeHtml(t('open'))}">✉</button></div><div class="eep-side-row"><button class="eep-mini-chip" id="eep-mini-chip-code" data-copy-kind="code"></button><button class="eep-side-btn" id="eep-side-poll-btn" data-action="poll-otp" title="${escapeHtml(t('pollCode'))}">码</button></div>`; document.body.appendChild(bar); renderActionState(); }

  function attachEvents() {
    [document.getElementById('eep-panel'), document.getElementById('eep-mini-bar')].filter(Boolean).forEach((root) => {
      root.addEventListener('click', async (event) => {
        const emailStrong = event.target.closest('#eep-current-email');
        if (emailStrong) {
          const mailbox = currentMailbox();
          if (mailbox && mailbox.email) {
            copyText(mailbox.email).catch(() => {});
            logLine(t('logCopyEmail'));
          }
          return;
        }
        const codeStrong = event.target.closest('#eep-current-code');
        if (codeStrong) {
          const code = state.lastCode;
          if (code) {
            copyText(code).catch(() => {});
            logLine(t('logCopyCode'));
          }
          return;
        }
        const copyChip = event.target.closest('button[data-copy-kind]');
        if (copyChip) {
          const value = String(copyChip.dataset.copyText || '').trim();
          const kind = copyChip.dataset.copyKind || '';
          if (value) {
            copyText(value).catch(() => {});
            logLine(kind === 'email' ? t('logCopyEmail') : t('logCopyCode'));
            showMiniChip(kind, value);
          }
          return;
        }
        const copyLinkButton = event.target.closest('button[data-message-link-copy]');
        if (copyLinkButton) {
          const value = String(copyLinkButton.dataset.messageLinkCopy || '').trim();
          if (value) {
            copyText(value).catch(() => {});
            logLine(t('logCopyLink'));
          }
          return;
        }
        const actionButton = event.target.closest('button[data-action]');
        if (actionButton) {
          const action = actionButton.dataset.action || '';
          if (action === 'toggle-panel') return toggleMinimize();
          if (action === 'open-mailbox') return runAction(action, async () => { updateStoredSettingsFromUi(); await openMailboxAuto(getSettings()); });
          if (action === 'manual-poll') {
            return runAction(action, async () => {
              updateStoredSettingsFromUi();
              const settings = getSettings();
              const manualEmail = String(settings.manualQueryEmail || '').trim();
              const mailbox = await ensureManualMailboxEntry(manualEmail, settings);
              await pollMailboxUntilCode(mailbox, settings);
            }, { polling: true, keepPollingState: true });
          }
          if (action === 'poll-otp') {
            if (state.polling) { state.stopRequested = true; state.polling = false; renderActionState(); return logLine(t('logPollStopped')); }
            return runAction(action, async () => { updateStoredSettingsFromUi(); const mailbox = currentMailbox(); if (!mailbox) throw new Error(t('logNoMailbox')); await pollMailboxUntilCode(mailbox, getSettings()); }, { polling: true, keepPollingState: true });
          }
        }
        const historyButton = event.target.closest('button[data-history-action]');
        if (historyButton) return onHistoryAction(historyButton.dataset.historyAction, historyButton.dataset.historyId);
        const historySelect = event.target.closest('[data-history-select]');
        if (historySelect) {
          const mailbox = state.mailboxHistory.find((item) => item.id === historySelect.dataset.historySelect);
          if (mailbox) {
            selectHistoryMailbox(mailbox, false);
            logLine(t('logHistorySelected', { email: mailbox.email }));
          }
          return;
        }
        const messageButton = event.target.closest('button[data-message-id]');
        if (messageButton) {
          const message = state.currentMessages.find((item) => item.id === messageButton.dataset.messageId);
          if (message) renderMessageDetail(message);
        }
      });
      root.addEventListener('dblclick', (event) => {
        const copyChip = event.target.closest('button[data-copy-kind]');
        if (!copyChip) return;
        const kind = copyChip.dataset.copyKind || '';
        if (kind === 'email' || kind === 'code') hideMiniChip(kind);
      });
      root.addEventListener('change', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
        if (target.dataset.setting) {
          saveSetting(target.dataset.setting, target.type === 'checkbox' ? (target.checked ? 'true' : 'false') : (target.value || ''));
          if (target.dataset.setting === 'locale') return rebuildUi();
          createPanel();
          createMiniBar();
          updateMiniBarVisibility();
          attachEvents();
          if (target.dataset.setting === 'manualQueryEmail') refreshManualGuess(target.value).catch(() => renderManualGuessHint(null));
          logLine(t('logSaved'));
          return;
        }
        if (target.dataset.providerPool) {
          updateStoredSettingsFromUi();
          createPanel();
          createMiniBar();
          updateMiniBarVisibility();
          attachEvents();
        }
      });
      root.addEventListener('input', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
        if (target.dataset.setting === 'manualQueryEmail') {
          renderManualGuessHint(null);
          refreshManualGuess(target.value).catch(() => renderManualGuessHint(null));
        }
      });
    });
  }

  function installStyles() { GM_addStyle(`#eep-panel{position:fixed;top:16px;right:16px;width:420px;max-height:calc(100vh - 32px);overflow:auto;z-index:2147483000;background:linear-gradient(180deg,rgba(15,24,44,.98),rgba(11,19,34,.98));color:#edf5ff;border:1px solid rgba(120,160,255,.18);box-shadow:0 20px 60px rgba(0,0,0,.35);border-radius:20px;padding:16px;font-family:Inter,'Microsoft YaHei UI',sans-serif}#eep-panel.is-minimized{display:none}#eep-panel .eep-head{display:flex;align-items:flex-start;justify-content:flex-start;gap:12px}#eep-panel h1{margin:0;font-size:28px;line-height:1.1}#eep-panel button,#eep-mini-bar button,#eep-panel input,#eep-panel select,#eep-panel summary{font:inherit}#eep-panel button,#eep-mini-bar button{border:none;border-radius:12px;background:linear-gradient(90deg,#2563eb,#22a7f0);color:#fff;padding:10px 14px;cursor:pointer}#eep-panel button:disabled,#eep-mini-bar button:disabled{opacity:.45;cursor:not-allowed}#eep-panel details{margin-top:14px;border:1px solid rgba(130,170,255,.12);border-radius:14px;background:rgba(17,27,47,.72)}#eep-panel summary{list-style:none;cursor:pointer;padding:12px 14px;font-weight:700}#eep-panel summary::-webkit-details-marker{display:none}.eep-main-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}.eep-main-span{grid-column:1/-1}.eep-field{display:flex;flex-direction:column;gap:6px;color:rgba(237,245,255,.86)}.eep-field span{font-size:13px;letter-spacing:.03em;text-transform:uppercase;color:rgba(237,245,255,.68)}.eep-field input,.eep-field select{width:100%;box-sizing:border-box;border-radius:14px;border:1px solid rgba(130,170,255,.12);background:rgba(13,20,37,.92);color:#edf5ff;padding:12px 14px}.eep-help{justify-content:center;background:rgba(9,15,27,.66);border-radius:14px;padding:10px 14px}.eep-settings-shell,.eep-manual-card{margin-top:14px;padding:14px;border-radius:16px;background:rgba(17,27,47,.72);border:1px solid rgba(130,170,255,.12)}.eep-settings-block{margin-top:12px}.eep-manual-head,.eep-current-head{font-weight:700;margin-bottom:10px}.eep-manual-actions{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-top:12px}.eep-manual-guess{display:grid;gap:4px;min-width:0;flex:1 1 auto}.eep-manual-guess span{font-size:12px;color:rgba(237,245,255,.66);text-transform:uppercase}.eep-manual-guess strong{display:block;word-break:break-word}.eep-manual-guess strong[data-tone="warn"]{color:#ffd7a8}.eep-manual-guess strong[data-tone="success"]{color:#9ff0c0}.eep-current-card{margin-top:14px;padding:14px;border-radius:16px;background:rgba(12,19,34,.92);border:1px solid rgba(130,170,255,.12)}.eep-current-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.eep-current-grid span{display:block;color:rgba(237,245,255,.66);font-size:12px;text-transform:uppercase}.eep-current-grid strong{display:block;margin-top:4px;word-break:break-word}.eep-copy-value{cursor:pointer;transition:opacity .2s ease}.eep-copy-value:hover{opacity:.82}.eep-provider-pool{display:flex;flex-wrap:wrap;gap:8px}.eep-chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:8px 10px;background:rgba(13,20,37,.92);border:1px solid rgba(130,170,255,.12)}.eep-chip small{color:rgba(237,245,255,.66);font-size:11px}.eep-chip.is-selected{border-color:rgba(61,181,255,.55);background:rgba(21,72,120,.45)}.eep-provider-settings{display:grid;gap:12px;padding:14px}.eep-provider-card{border:1px solid rgba(130,170,255,.12);border-radius:16px;background:rgba(9,15,27,.66);padding:12px}.eep-provider-card.is-configured{border-color:rgba(88,200,145,.3)}.eep-provider-card.is-unconfigured{border-color:rgba(255,170,120,.28)}.eep-provider-card.is-disabled{border-color:rgba(130,170,255,.12);opacity:.8}.eep-provider-card.is-cooling{border-color:rgba(255,215,100,.45)}.eep-provider-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}.eep-provider-card-head h4{margin:0}.eep-provider-pill{display:inline-flex;align-items:center;border-radius:999px;padding:4px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;background:rgba(18,30,53,.88);border:1px solid rgba(130,170,255,.12);color:rgba(237,245,255,.78)}.eep-provider-status-note{margin:-2px 0 10px;color:rgba(237,245,255,.72);font-size:12px;line-height:1.45}.eep-provider-card-fields{display:grid;gap:10px}#eep-history-list{display:grid;gap:10px;padding:0 14px 14px;max-height:330px;overflow:auto}.eep-history-item{display:flex;flex-wrap:wrap;align-items:flex-start;gap:12px;padding:12px;border-radius:14px;background:rgba(9,15,27,.66);border:1px solid rgba(130,170,255,.08)}.eep-history-item.is-current{border-color:rgba(61,181,255,.45)}.eep-history-main{flex:1 1 200px;cursor:pointer}.eep-history-email{font-weight:700;word-break:break-all}.eep-history-meta{color:rgba(237,245,255,.65);font-size:12px;margin-top:4px}.eep-history-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}.eep-history-actions button{padding:8px 10px;font-size:12px}.eep-history-message-shell{width:100%;display:grid;gap:10px;margin-top:6px}.eep-code-detail{display:grid;gap:6px;padding:12px;border-radius:14px;background:rgba(9,15,27,.66);border:1px solid rgba(130,170,255,.08)}.eep-code-value{font-size:24px;font-weight:800;letter-spacing:.04em;word-break:break-word}.eep-code-meta{font-size:12px;color:rgba(237,245,255,.66)}.eep-message-list{display:grid;gap:8px;max-height:220px;overflow:auto}.eep-message-list-inline{grid-template-columns:1fr}.eep-message-item{text-align:left;background:rgba(9,15,27,.66)}.eep-message-item.is-active{outline:2px solid rgba(61,181,255,.45)}.eep-message-item strong,.eep-message-item span{display:block}.eep-message-item span{font-size:12px;color:rgba(237,245,255,.72);margin-top:4px}.eep-raw-message{max-height:min(72vh,680px);overflow:auto;background:rgba(9,15,27,.66);border-radius:14px;padding:12px;border:1px solid rgba(130,170,255,.08)}.eep-raw-message-inline{margin-top:2px}.eep-raw-head{display:grid;gap:6px;margin-bottom:14px}.eep-raw-block{display:grid;gap:8px;margin-top:12px}.eep-raw-block-compact{margin-top:0;padding:0 12px 12px}.eep-raw-block h4{margin:0}.eep-raw-block pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;background:rgba(9,15,27,.66);border-radius:14px;padding:12px;margin:0;border:1px solid rgba(130,170,255,.08);color:#d9ebff;line-height:1.58;max-height:360px;overflow:auto}.eep-raw-body-pre{font-size:13px}.eep-raw-meta-pre{font-size:12px;color:rgba(217,235,255,.82)}.eep-raw-source-pre{font-size:12px;color:rgba(217,235,255,.78)}.eep-raw-toggle{margin-top:12px;border:1px solid rgba(130,170,255,.08);border-radius:14px;background:rgba(8,13,24,.5)}.eep-raw-toggle summary{padding:10px 12px;font-size:12px;letter-spacing:.03em;text-transform:uppercase;color:rgba(237,245,255,.72)}.eep-empty{color:rgba(237,245,255,.66);padding:14px}#eep-mini-bar{position:fixed;right:16px;top:50%;transform:translateY(-50%);z-index:2147483001;display:flex;flex-direction:column;gap:10px;color:#fff;font-family:Inter,'Microsoft YaHei UI',sans-serif}.eep-side-row{display:flex;align-items:center;justify-content:flex-end;gap:8px}.eep-side-btn{width:30px;height:30px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;font-size:14px;padding:0;background:linear-gradient(180deg,#ffffff,#eef5ff)!important;color:#ff6a8d!important;box-shadow:0 8px 18px rgba(0,0,0,.18)}.eep-mini-chip{max-width:220px;border:none;border-radius:999px;padding:10px 14px;background:rgba(9,15,27,.94)!important;color:#edf5ff!important;box-shadow:0 14px 28px rgba(0,0,0,.28);opacity:0;transform:translateX(10px);pointer-events:none;transition:opacity .35s ease,transform .35s ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.eep-mini-chip.is-visible{opacity:1;transform:translateX(0);pointer-events:auto}@media (max-width:920px){#eep-panel{width:calc(100vw - 24px);right:12px;left:12px;top:12px}.eep-main-grid,.eep-current-grid{grid-template-columns:1fr}.eep-main-span{grid-column:auto}#eep-mini-bar{right:10px}.eep-manual-actions{flex-direction:column;align-items:stretch}.eep-raw-message{max-height:min(68vh,540px)}}`); }
  async function bootstrapImportFlow() {
    const locationImportCode = readImportCodeFromLocation();
    if (locationImportCode) {
      const imported = await importUserscriptSettings(locationImportCode, {});
      logLine(currentLocale() === 'zh-CN'
        ? `已通过 URL 参数导入 ${imported.settingsCount} 项远程配置。`
        : `Imported ${imported.settingsCount} remote settings from URL parameter.`);
      scheduleImportSyncIfNeeded();
      refreshRuntimeUi();
      return;
    }

    const existingImportCode = currentImportCode();
    if (existingImportCode) {
      const syncResult = await maybeSyncImportedUserscriptSettings('boot');
      scheduleImportSyncIfNeeded();
      if (syncResult && syncResult.updated) {
        logLine(currentLocale() === 'zh-CN' ? '已同步最新导入配置。' : 'Imported settings synced.');
        refreshRuntimeUi();
      }
      return;
    }

    if (hasAnyStoredUserSettings()) return;
    const promptState = loadImportPromptState();
    if (promptState && promptState.dismissed) return;
    const enteredImportCode = await promptForImportCode(currentLocale() === 'zh-CN'
      ? '当前没有远程导入配置。请输入 EasyEmail 导入码，或直接取消后手动配置。'
      : 'No remote import config is set. Enter your EasyEmail import code, or cancel to configure manually.');
    if (!enteredImportCode) {
      saveImportPromptState({ dismissed: true, dismissedAtMs: Date.now() });
      return;
    }
    const imported = await importUserscriptSettings(enteredImportCode, {});
    saveImportPromptState({});
    scheduleImportSyncIfNeeded();
    refreshRuntimeUi();
    logLine(currentLocale() === 'zh-CN'
      ? `已导入 ${imported.settingsCount} 项远程配置。`
      : `Imported ${imported.settingsCount} remote settings.`);
  }
  function maybeRegisterMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    GM_registerMenuCommand('EasyEmail Runtime: 切换面板', () => toggleMinimize());
    GM_registerMenuCommand(currentLocale() === 'zh-CN' ? 'EasyEmail Runtime: 导入/替换导入码' : 'EasyEmail Runtime: Import or replace code', () => {
      promptAndImportUserscriptSettings().then((result) => {
        if (result) logLine(currentLocale() === 'zh-CN' ? '导入码已更新。' : 'Import code updated.');
      }).catch((error) => logLine(String(error && error.message ? error.message : error || 'Import failed.'), 'error'));
    });
    GM_registerMenuCommand(currentLocale() === 'zh-CN' ? 'EasyEmail Runtime: 立即同步导入配置' : 'EasyEmail Runtime: Sync imported config now', () => {
      maybeSyncImportedUserscriptSettings('force').then((result) => {
        if (result && result.updated) {
          refreshRuntimeUi();
          logLine(currentLocale() === 'zh-CN' ? '已同步最新导入配置。' : 'Imported settings synced.');
        } else {
          logLine(currentLocale() === 'zh-CN' ? '远程导入配置没有变化。' : 'Remote imported settings are unchanged.');
        }
      }).catch((error) => logLine(String(error && error.message ? error.message : error || 'Sync failed.'), 'error'));
    });
    GM_registerMenuCommand(readImportSyncEnabled()
      ? (currentLocale() === 'zh-CN' ? 'EasyEmail Runtime: 关闭导入配置自动同步' : 'EasyEmail Runtime: Disable import auto-sync')
      : (currentLocale() === 'zh-CN' ? 'EasyEmail Runtime: 开启导入配置自动同步' : 'EasyEmail Runtime: Enable import auto-sync'), () => {
      const stateRecord = loadImportState();
      saveImportState({ ...stateRecord, syncEnabled: !readImportSyncEnabled() });
      scheduleImportSyncIfNeeded();
      logLine(readImportSyncEnabled()
        ? (currentLocale() === 'zh-CN' ? '已开启导入配置自动同步。' : 'Import auto-sync enabled.')
        : (currentLocale() === 'zh-CN' ? '已关闭导入配置自动同步。' : 'Import auto-sync disabled.'));
    });
    GM_registerMenuCommand(currentLocale() === 'zh-CN' ? 'EasyEmail Runtime: 清除导入码绑定' : 'EasyEmail Runtime: Clear import code binding', () => {
      clearImportedUserscriptBinding();
      logLine(currentLocale() === 'zh-CN' ? '已清除导入码绑定，当前配置已保留。' : 'Import code binding cleared. Current settings were kept.');
    });
  }
  async function bootstrap() {
    if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function' || typeof GM_xmlhttpRequest !== 'function') { console.warn('EasyEmail Runtime userscript requires GM_* APIs.'); return; }
    seedMissingSettings();
    state.currentMailboxId = String(loadSetting('currentMailboxId') || '');
    state.mailboxHistory = loadJson('mailboxHistory', []);
    state.providerStats = loadJson('providerStats', {});
    state.historyDetailMode = 'code';
    document.body.dataset.eepMinimized = 'true';
    installStyles();
    createPanel();
    createMiniBar();
    updateMiniBarVisibility();
    attachEvents();
    maybeRegisterMenu();
    setStatus(t('ready'));
    hideMiniChip('email');
    hideMiniChip('code');
    await bootstrapImportFlow();
    logLine(t('ready'));
  }
  bootstrap().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[EasyEmail Runtime] bootstrap failed:', error);
    try { logLine(message, 'error'); } catch {}
  });
})();
