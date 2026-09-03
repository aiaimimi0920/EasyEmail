  async function cloudflareGetSettings(cfg) { const result = await requestJsonAbsolute('GET', `${normalizeUrl(cfg.baseUrl)}/open_api/settings`, { Accept: 'application/json, text/plain, */*', ...(cfg.customAuth ? { 'x-custom-auth': cfg.customAuth } : {}) }); if (result.status !== 200) throw new Error(`Cloudflare Temp Email settings failed: HTTP ${result.status}`); const payload = typeof result.data === 'string' ? {} : result.data; const explicitDomains = normalizeDomainEntries(Array.isArray(payload.domains) ? payload.domains : []); const randomSubdomainRoots = normalizeDomainEntries(Array.isArray(payload.randomSubdomainDomains) ? payload.randomSubdomainDomains : []); setCachedProviderDomains('cloudflare_temp_email', explicitDomains, randomSubdomainRoots); return { ...payload, domains: explicitDomains, randomSubdomainDomains: randomSubdomainRoots }; }
  async function cloudflareOpenMailbox(cfg) { const settings = await cloudflareGetSettings(cfg).catch(() => ({})); const settingsDomains = splitDomainEntries(Array.isArray(settings.domains) ? settings.domains : []); const randomSubdomainRoots = normalizeDomainEntries(Array.isArray(settings.randomSubdomainDomains) ? settings.randomSubdomainDomains : []); const serviceHost = (() => { try { return new URL(normalizeUrl(cfg.baseUrl)).hostname.toLowerCase(); } catch { return ''; } })(); const usableExplicitDomains = settingsDomains.exactDomains.filter((domain) => domain && domain !== serviceHost && !domain.startsWith('tx-mail.')); const requestedPreferredDomain = String(cfg.preferredDomain || '').trim().toLowerCase(); const preferredDomain = requestedPreferredDomain && requestedPreferredDomain !== serviceHost && !requestedPreferredDomain.startsWith('tx-mail.') ? requestedPreferredDomain : ''; const preferredIsRandomRoot = preferredDomain && randomSubdomainRoots.includes(preferredDomain); const selectedDomain = preferredDomain || (usableExplicitDomains.length ? usableExplicitDomains[Math.floor(Math.random() * usableExplicitDomains.length)] : (randomSubdomainRoots[0] || '')); const enableRandomSubdomain = Boolean(preferredIsRandomRoot || (!usableExplicitDomains.includes(selectedDomain) && randomSubdomainRoots.includes(selectedDomain))); const result = await requestJsonAbsolute('POST', `${normalizeUrl(cfg.baseUrl)}/api/new_address`, { Accept: 'application/json, text/plain, */*', ...(cfg.customAuth ? { 'x-custom-auth': cfg.customAuth } : {}), 'Content-Type': 'application/json' }, { name: createLocalPart('cf'), ...(selectedDomain ? { domain: selectedDomain } : {}), ...(enableRandomSubdomain ? { enableRandomSubdomain: true } : {}) }); if (result.status !== 200) throw new Error(`Cloudflare Temp Email open failed: HTTP ${result.status}`); const payload = typeof result.data === 'string' ? {} : result.data; const address = String(payload.address || '').trim(); const jwt = String(payload.jwt || '').trim(); if (!address || !jwt) throw new Error('Cloudflare Temp Email open returned empty address or jwt.'); return { email: address, mailboxData: { address, jwt }, metadata: { selectedDomain: address.split('@')[1] || selectedDomain || '', availableDomains: usableExplicitDomains, randomSubdomainRoots } }; }
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
