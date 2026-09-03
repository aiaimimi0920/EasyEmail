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
    const pinnedDomain = preferred && domains.includes(preferred) ? preferred : '';
    const firstDomain = pinnedDomain || nextProviderDomain('duckmail', domains);
    const rotationOffset = Math.max(0, domains.indexOf(firstDomain));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const domain = pinnedDomain || domains[(rotationOffset + attempt) % domains.length];
      if (!domain) throw new Error('DuckMail has no available domains.');
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
