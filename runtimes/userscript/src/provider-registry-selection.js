  const PROVIDERS = {
    cloudflare_temp_email: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.cloudflare_baseUrl) && String(s.cloudflare_customAuth || '').trim()), getConfig: (s) => ({ baseUrl: normalizeUrl(s.cloudflare_baseUrl), customAuth: String(s.cloudflare_customAuth || '').trim(), adminAuth: String(s.cloudflare_adminAuth || '').trim(), preferredDomain: String(s.cloudflare_preferredDomain || '').trim() }), openMailbox: cloudflareOpenMailbox, listMessages: cloudflareListMessages },
    mailtm: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.mailtm_baseUrl)), getConfig: (s) => ({ baseUrl: normalizeUrl(s.mailtm_baseUrl) }), openMailbox: mailtmOpenMailbox, listMessages: mailtmListMessages },
    duckmail: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.duckmail_baseUrl)), getConfig: (s) => ({ baseUrl: normalizeUrl(s.duckmail_baseUrl), preferredDomain: String(s.duckmail_preferredDomain || '').trim() }), openMailbox: duckmailOpenMailbox, listMessages: duckmailListMessages },
    guerrillamail: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.guerrillamail_apiBase)), getConfig: (s) => ({ apiBase: normalizeUrl(s.guerrillamail_apiBase) }), openMailbox: guerrillaOpenMailbox, listMessages: guerrillaListMessages },
    'tempmail-lol': { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.tempmailLol_baseUrl)), getConfig: (s) => ({ baseUrl: normalizeUrl(s.tempmailLol_baseUrl) }), openMailbox: tempmailLolOpenMailbox, listMessages: tempmailLolListMessages },
    temporam: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.temporam_baseUrl)), getConfig: (s) => ({ baseUrl: normalizeUrl(s.temporam_baseUrl), preferredDomain: String(s.temporam_preferredDomain || '').trim() }), openMailbox: temporamOpenMailbox, listMessages: temporamListMessages, resolveMailboxByEmail: temporamResolveMailboxByEmail },
    etempmail: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.etempmail_baseUrl)), getConfig: (s) => ({ baseUrl: normalizeUrl(s.etempmail_baseUrl), preferredDomain: String(s.etempmail_preferredDomain || '').trim() }), openMailbox: etempmailOpenMailbox, listMessages: etempmailListMessages },
    moemail: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.moemail_baseUrl) && String(s.moemail_apiKey || '').trim()), getConfig: (s) => ({ baseUrl: normalizeUrl(s.moemail_baseUrl), apiKey: String(s.moemail_apiKey || '').trim(), expiryTimeMs: String(s.moemail_expiryTimeMs || '3600000').trim() }), openMailbox: moemailOpenMailbox, listMessages: moemailListMessages },
    m2u: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.m2u_baseUrl)), getConfig: (s) => ({ baseUrl: normalizeUrl(s.m2u_baseUrl), preferredDomain: String(s.m2u_preferredDomain || '').trim() }), openMailbox: m2uOpenMailbox, listMessages: m2uListMessages },
    gptmail: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.gptmail_baseUrl) && splitConfiguredKeys(s.gptmail_apiKey).length), getConfig: (s) => ({ baseUrl: normalizeUrl(s.gptmail_baseUrl), apiKeys: splitConfiguredKeys(s.gptmail_apiKey), prefix: String(s.gptmail_prefix || '').trim() }), openMailbox: gptmailOpenMailbox, listMessages: gptmailListMessages },
    im215: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.im215_baseUrl) && String(s.im215_apiKey || '').trim()), getConfig: (s) => ({ baseUrl: normalizeUrl(s.im215_baseUrl), apiKey: String(s.im215_apiKey || '').trim(), preferredDomain: String(s.im215_preferredDomain || '').trim() }), openMailbox: im215OpenMailbox, listMessages: im215ListMessages },
    mail2925: { isEnabled: () => true, isConfigured: (s) => Boolean(normalizeUrl(s.mail2925_baseUrl) && String(s.mail2925_account || '').trim() && String(s.mail2925_jwtToken || '').trim()), getConfig: (s) => ({ baseUrl: normalizeUrl(s.mail2925_baseUrl), account: String(s.mail2925_account || '').trim(), jwtToken: String(s.mail2925_jwtToken || '').trim(), deviceUid: String(s.mail2925_deviceUid || '').trim(), cookieHeader: String(s.mail2925_cookieHeader || '').trim(), folderName: String(s.mail2925_folderName || 'Inbox').trim() || 'Inbox', domain: String(s.mail2925_account || '').trim().split('@')[1] || '2925.com' }), openMailbox: mail2925OpenMailbox, listMessages: mail2925ListMessages },
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
  async function detectTemporamDomainMatch(domain, cfg) {
    const cached = getCachedProviderDomains('temporam');
    if (cached.length) return cached.includes(domain);
    const domains = await temporamGetDomains(cfg);
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
    if (PROVIDERS.temporam.isConfigured(settings)) checks.push(async () => (await detectTemporamDomainMatch(domain, PROVIDERS.temporam.getConfig(settings))) ? ({ providerKey: 'temporam', supported: true }) : null);
    if (PROVIDERS.m2u.isConfigured(settings)) checks.push(async () => (await detectM2uDomainMatch(domain, PROVIDERS.m2u.getConfig(settings))) ? ({ providerKey: 'm2u', supported: false, reason: 'history-only' }) : null);
    if (PROVIDERS.im215.isConfigured(settings)) checks.push(async () => (await detectIm215DomainMatch(domain, PROVIDERS.im215.getConfig(settings))) ? ({ providerKey: 'im215', supported: true }) : null);
    if (PROVIDERS.duckmail.isConfigured(settings)) checks.push(async () => (await detectDuckmailDomainMatch(domain, PROVIDERS.duckmail.getConfig(settings))) ? ({ providerKey: 'duckmail', supported: false, reason: 'history-only' }) : null);
    if (PROVIDERS.mailtm.isConfigured(settings)) checks.push(async () => (await detectMailtmDomainMatch(domain, PROVIDERS.mailtm.getConfig(settings))) ? ({ providerKey: 'mailtm', supported: false, reason: 'history-only' }) : null);
    if (knownDomainsFromHistory('gptmail').includes(domain)) checks.push(async () => ({ providerKey: 'gptmail', supported: true }));
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
    if (providerKey === 'temporam') {
      const cfg = PROVIDERS.temporam.getConfig(settings);
      const resolved = await temporamResolveMailboxByEmail(cfg, normalized);
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
