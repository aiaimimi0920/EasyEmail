  function sk(key) { return `${STORAGE_PREFIX}${key}`; }
  function loadSetting(key) { try { const value = GM_getValue(sk(key), DEFAULTS[key]); return value === undefined ? DEFAULTS[key] : value; } catch { return DEFAULTS[key]; } }
  function saveSetting(key, value) { GM_setValue(sk(key), value); }
  function loadScopedValue(key, fallback = '') { try { const value = GM_getValue(sk(key), fallback); return value === undefined ? fallback : value; } catch { return fallback; } }
  function saveScopedValue(key, value) { GM_setValue(sk(key), value); }
  function isLocalSecretPlaceholder(value) { return String(value || '').startsWith(LOCAL_SECRET_PREFIX) && String(value || '').endsWith('__'); }
  function seedMissingSettings() {
    const legacyDefaultProviderPools = [
      'cloudflare_temp_email,mailtm,duckmail,guerrillamail,tempmail-lol,etempmail,moemail,gptmail,im215',
      'cloudflare_temp_email,mailtm,duckmail,guerrillamail,tempmail-lol,etempmail,moemail,m2u,gptmail,im215,mail2925',
    ];
  const secretKeys = ['cloudflare_customAuth', 'cloudflare_adminAuth', 'moemail_apiKey', 'gptmail_apiKey', 'im215_apiKey', 'mail2925_account', 'mail2925_jwtToken', 'mail2925_deviceUid', 'mail2925_cookieHeader'];
    secretKeys.forEach((key) => {
      const seeded = String(DEFAULTS[key] || '').trim();
      if (!seeded || isLocalSecretPlaceholder(seeded)) return;
      const current = String(loadSetting(key) || '').trim();
      if (current !== seeded) saveSetting(key, seeded);
    });
    const selectedProviders = String(loadSetting('selectedProvidersCsv') || '').trim();
    if (!selectedProviders || legacyDefaultProviderPools.includes(selectedProviders)) {
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
