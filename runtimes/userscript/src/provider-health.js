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
  function isKeylessProvider(providerKey) { return ['cloudflare_temp_email', 'mailtm', 'duckmail', 'guerrillamail', 'tempmail-lol', 'temporam', 'etempmail', 'm2u'].includes(String(providerKey || '')); }
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
  const providerDomainCursors = new Map();
  function nextProviderDomain(providerKey, domains) {
    const normalizedDomains = normalizeDomainEntries(domains);
    if (!normalizedDomains.length) return '';
    if (normalizedDomains.length === 1) return normalizedDomains[0];
    const key = `${providerKey}:${normalizedDomains.join(',')}`;
    const cursor = providerDomainCursors.get(key) || 0;
    providerDomainCursors.set(key, (cursor + 1) % normalizedDomains.length);
    return normalizedDomains[cursor % normalizedDomains.length] || normalizedDomains[0];
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

