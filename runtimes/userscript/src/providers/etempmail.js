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
      const observedAt = chooseObservedAt(row.date, row.createdAt, row.receivedAt) || new Date().toISOString();
      messages.push(normalizeObservedMessage({
        id: `etempmail:${readValueString(row.id) || String(index + 1)}`,
        sender,
        subject,
        textBody: detailBodies.textBody || '',
        htmlBody: detailBodies.htmlBody || '',
        observedAt,
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
