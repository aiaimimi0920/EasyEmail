  function pickConfiguredKey(value) {
    const keys = Array.isArray(value) ? value.filter(Boolean) : splitConfiguredKeys(value);
    if (!keys.length) return '';
    return keys[Math.floor(Math.random() * keys.length)] || keys[0];
  }
  function gptmailBuildHeaders(baseUrl, apiKey, hasBody) {
    const normalizedBaseUrl = normalizeUrl(baseUrl);
    return {
      Accept: 'application/json',
      'X-API-Key': apiKey,
      'Origin': normalizedBaseUrl,
      'Referer': `${normalizedBaseUrl}/`,
      'X-Requested-With': 'XMLHttpRequest',
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    };
  }
  async function gptmailGenerateEmail(baseUrl, apiKey, prefix) {
    const normalizedPrefix = String(prefix || '').trim();
    if (normalizedPrefix) {
      return requestJsonAbsolute('POST', `${normalizeUrl(baseUrl)}/api/generate-email`, gptmailBuildHeaders(baseUrl, apiKey, true), { prefix: normalizedPrefix });
    }
    const getResult = await requestJsonAbsolute('GET', `${normalizeUrl(baseUrl)}/api/generate-email`, gptmailBuildHeaders(baseUrl, apiKey, false));
    if (getResult.status === 200) return getResult;
    return requestJsonAbsolute('POST', `${normalizeUrl(baseUrl)}/api/generate-email`, gptmailBuildHeaders(baseUrl, apiKey, true), {});
  }
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
    const list = await requestJsonAbsolute('GET', `${normalizeUrl(cfg.baseUrl)}/api/emails?email=${encodeURIComponent(mailbox.mailboxData.email)}`, gptmailBuildHeaders(cfg.baseUrl, apiKey, false));
    if (list.status !== 200) throw new Error(`GPT Mail list failed: HTTP ${list.status}`);
    const rows = Array.isArray(list.data && list.data.data && list.data.data.emails) ? list.data.data.emails : [];
    const messages = [];
    for (const row of rows) {
      const id = String(row.id || '').trim();
      if (!id) continue;
      const detail = await requestJsonAbsolute('GET', `${normalizeUrl(cfg.baseUrl)}/api/email/${encodeURIComponent(id)}`, gptmailBuildHeaders(cfg.baseUrl, apiKey, false));
      const payload = detail.status === 200 && typeof detail.data !== 'string'
        ? (detail.data && detail.data.data && typeof detail.data.data === 'object' ? detail.data.data : detail.data)
        : row;
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

