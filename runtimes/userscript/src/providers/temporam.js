  function temporamRequest(cfg, method, path, options = {}) {
    const headers = {
      Accept: 'application/json',
      'Accept-Language': currentLocale() === 'zh-CN' ? 'zh-CN,zh;q=0.9' : 'en-US,en;q=0.9',
      'User-Agent': 'EasyEmailBrowserRuntime/1.5.2',
      Referer: `${normalizeUrl(cfg.baseUrl)}/`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    };
    return requestJsonAbsolute(method, `${normalizeUrl(cfg.baseUrl)}${path}`, headers, options.body);
  }
  function temporamBodyHasError(body) {
    const record = readValueRecord(body);
    if (record.error === true) return true;
    const code = Number.parseInt(readValueString(record.code) || '0', 10);
    return Number.isFinite(code) && code >= 400;
  }
  function temporamBodyErrorDetail(body) {
    const record = readValueRecord(body);
    return readValueString(record.message) || readValueString(record.error) || readValueString(record.reason) || '';
  }
  async function temporamGetDomains(cfg) {
    const result = await temporamRequest(cfg, 'GET', '/api/domains');
    if (result.status !== 200 || temporamBodyHasError(result.data)) {
      throw new Error(`Temporam domains failed: HTTP ${result.status}${temporamBodyErrorDetail(result.data) ? `. ${temporamBodyErrorDetail(result.data)}` : ''}`);
    }
    const domains = readValueRecordList(readValueRecord(result.data).data)
      .map((item) => readValueString(item.domain))
      .filter(Boolean)
      .map((item) => String(item).trim().toLowerCase())
      .filter((item) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(item));
    setCachedProviderDomains('temporam', domains);
    return [...new Set(domains)];
  }
  function temporamDomainMatchesPreference(domain, preferredDomain) {
    const normalizedDomain = String(domain || '').trim().toLowerCase();
    const normalizedPreferredDomain = String(preferredDomain || '').trim().toLowerCase();
    if (!normalizedDomain || !normalizedPreferredDomain) return false;
    return normalizedDomain === normalizedPreferredDomain || normalizedDomain.endsWith(`.${normalizedPreferredDomain}`);
  }
  function temporamSelectDomain(domains, preferredDomain) {
    const normalizedPreferredDomain = String(preferredDomain || '').trim().toLowerCase();
    if (normalizedPreferredDomain) {
      const matched = [...new Set((domains || []).filter((domain) => temporamDomainMatchesPreference(domain, normalizedPreferredDomain)))];
      if (!matched.length) throw new Error(`Temporam has no available domain matching "${normalizedPreferredDomain}".`);
      return matched[Math.floor(Math.random() * matched.length)] || matched[0];
    }
    if (!domains.length) throw new Error('Temporam has no public domain.');
    return domains[Math.floor(Math.random() * domains.length)] || domains[0];
  }
  function temporamSinceIso(mailbox) {
    const openedAt = readValueString(mailbox && mailbox.mailboxData && mailbox.mailboxData.openedAt) || readValueString(mailbox && mailbox.openedAt);
    const baseMs = parseDateValue(openedAt) || Date.now();
    return new Date(baseMs - 10 * 60 * 1000).toISOString();
  }
  function temporamNormalizeMessage(row, fallbackId) {
    const record = readValueRecord(row);
    const id = readValueString(record.id || record.emailId || record._id) || fallbackId || randomHex(6);
    const content = readValueString(record.content || record.body || record.message) || '';
    const contentLooksHtml = content && htmlLooksLikeMarkup(content);
    const htmlBody = readValueString(record.html || record.htmlBody || record.html_body) || (contentLooksHtml ? content : '');
    const textBody = readValueString(record.text || record.textBody || record.text_body || record.plainText || record.plain)
      || (contentLooksHtml ? normalizeReadableText(htmlToText(content)) : content);
    return normalizeObservedMessage({
      id: `temporam:${id}`,
      sender: readValueString(record.fromEmail || record.from_email || record.senderEmail || record.sender || record.from) || '',
      subject: readValueString(record.subject || record.title) || '',
      textBody,
      htmlBody,
      observedAt: chooseObservedAt(record.createdAt, record.created_at, record.receivedAt, record.received_at, record.date),
    });
  }
  async function temporamOpenMailbox(cfg) {
    const domains = await temporamGetDomains(cfg);
    const domain = temporamSelectDomain(domains, cfg.preferredDomain);
    const localPart = randomString(8);
    const email = `${localPart}@${domain}`.toLowerCase();
    const openedAt = new Date().toISOString();
    return {
      email,
      mailboxData: { email, localPart, domain, openedAt },
      metadata: { selectedDomain: domain, anonymousWebFlow: true },
    };
  }
  async function temporamResolveMailboxByEmail(cfg, email) {
    const normalized = normalizeEmailAddress(email);
    if (!normalized) throw new Error('邮箱地址格式不正确。');
    const domain = getEmailDomain(normalized);
    const domains = await temporamGetDomains(cfg);
    if (!domains.includes(domain)) throw new Error(`Temporam does not list domain ${domain}.`);
    const localPart = normalized.split('@')[0] || '';
    return {
      email: normalized,
      mailboxData: { email: normalized, localPart, domain, openedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
      metadata: { manualLookup: true, selectedDomain: domain, anonymousWebFlow: true },
    };
  }
  async function temporamListMessages(cfg, mailbox) {
    const email = normalizeEmailAddress(readValueString(mailbox && mailbox.mailboxData && mailbox.mailboxData.email) || readValueString(mailbox && mailbox.email));
    if (!email) throw new Error('Temporam mailbox email is missing.');
    const query = `email=${encodeURIComponent(email)}&since=${encodeURIComponent(temporamSinceIso(mailbox))}&limit=50`;
    const listResult = await temporamRequest(cfg, 'GET', `/api/emails?${query}`);
    if (listResult.status !== 200 || temporamBodyHasError(listResult.data)) {
      throw new Error(`Temporam list failed: HTTP ${listResult.status}${temporamBodyErrorDetail(listResult.data) ? `. ${temporamBodyErrorDetail(listResult.data)}` : ''}`);
    }
    const rows = readValueRecordList(readValueRecord(listResult.data).data).sort((left, right) => {
      const leftTime = parseDateValue(readValueString(left.createdAt || left.created_at || left.receivedAt || left.received_at || left.date) || '');
      const rightTime = parseDateValue(readValueString(right.createdAt || right.created_at || right.receivedAt || right.received_at || right.date) || '');
      return rightTime - leftTime;
    });
    const messages = [];
    for (const row of rows) {
      const summary = temporamNormalizeMessage(row, '');
      if (summary && summary.extractedCode) {
        messages.push(summary);
        continue;
      }
      const id = readValueString(row.id || row.emailId || row._id);
      if (!id) {
        if (summary) messages.push(summary);
        continue;
      }
      let detailRow = row;
      try {
        const detailResult = await temporamRequest(cfg, 'GET', `/api/emails/${encodeURIComponent(id)}`);
        if (detailResult.status === 200 && !temporamBodyHasError(detailResult.data)) {
          detailRow = { ...row, ...readValueRecord(readValueRecord(detailResult.data).data) };
        }
      } catch {}
      const detail = temporamNormalizeMessage(detailRow, id);
      if (detail) messages.push(detail);
    }
    return messages.filter(Boolean);
  }
