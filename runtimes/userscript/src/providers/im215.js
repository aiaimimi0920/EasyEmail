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
    const pinnedDomain = preferred && domains.includes(preferred) ? preferred : '';
    const firstDomain = pinnedDomain || nextProviderDomain('im215', domains);
    const rotationOffset = Math.max(0, domains.indexOf(firstDomain));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const domain = pinnedDomain || domains[(rotationOffset + attempt) % domains.length];
      if (!domain) throw new Error('215.im has no available domains.');
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

