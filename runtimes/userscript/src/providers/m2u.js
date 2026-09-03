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

