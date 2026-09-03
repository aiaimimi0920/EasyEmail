  async function tempmailLolRequest(baseUrl, method, path, options = {}) {
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'TempMailJS/4.4.0',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    };
    const payload = options.body || undefined;
    let lastResult = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await requestJsonAbsolute(method, `${normalizeUrl(baseUrl)}${path}`, headers, payload);
      lastResult = result;
      if (result.status !== 429 && result.status < 500) return result;
      if (attempt < 2) await sleep((attempt + 1) * 700);
    }
    return lastResult;
  }
  function tempmailLolRows(body) {
    const record = readValueRecord(body);
    return readValueRecordList(record.emails || record.messages);
  }
  function tempmailLolDecodeBodies(row) {
    let textBody = readValueString(row.body || row.text) || '';
    let htmlBody = readValueString(row.html) || '';
    if (!htmlBody && textBody && (/(=3D|=\r?\n)/i.test(textBody) || /<html|<body|<div|<span|<p|<table/i.test(textBody))) {
      const decoded = decodeQuotedPrintable(textBody, 'utf-8');
      if (decoded) {
        if (htmlLooksLikeMarkup(decoded)) htmlBody = decoded;
        textBody = normalizeReadableText(htmlToText(decoded)) || normalizeReadableText(decoded) || textBody;
      }
    }
    return { textBody, htmlBody };
  }
  async function tempmailLolOpenMailbox(cfg) {
    const result = await tempmailLolRequest(cfg.baseUrl, 'POST', '/inbox/create', { body: {} });
    if (result.status !== 200 && result.status !== 201) throw new Error(`Tempmail.lol open failed: HTTP ${result.status}`);
    const payload = readValueRecord(result.data);
    const email = readValueString(payload.address || payload.email);
    const token = readValueString(payload.token);
    if (!email || !token) throw new Error('Tempmail.lol create inbox returned incomplete payload.');
    return { email: email.toLowerCase(), mailboxData: { email: email.toLowerCase(), token }, metadata: { selectedDomain: email.split('@')[1] || '' } };
  }
  async function tempmailLolListMessages(cfg, mailbox) {
    const token = readValueString(mailbox && mailbox.mailboxData && mailbox.mailboxData.token);
    if (!token) throw new Error('Tempmail.lol mailbox token is missing.');
    const result = await tempmailLolRequest(cfg.baseUrl, 'GET', `/inbox?token=${encodeURIComponent(token)}`);
    if (result.status === 404) return [];
    if (result.status !== 200) throw new Error(`Tempmail.lol inbox failed: HTTP ${result.status}`);
    return [...tempmailLolRows(result.data)].sort((left, right) => {
      const leftTime = parseDateValue(readValueString(left.createdAt || left.date) || '');
      const rightTime = parseDateValue(readValueString(right.createdAt || right.date) || '');
      if (rightTime !== leftTime) return rightTime - leftTime;
      const leftId = Number.parseInt(readValueString(left.id) || '0', 10);
      const rightId = Number.parseInt(readValueString(right.id) || '0', 10);
      if (Number.isFinite(leftId) && Number.isFinite(rightId) && rightId !== leftId) return rightId - leftId;
      return 0;
    }).map((row) => {
      const bodies = tempmailLolDecodeBodies(row);
      return normalizeObservedMessage({
        id: `tempmail-lol:${readValueString(row.id) || readValueString(row.date) || randomHex(6)}`,
        sender: readValueString(row.from || row.sender) || '',
        subject: readValueString(row.subject) || '',
        textBody: bodies.textBody,
        htmlBody: bodies.htmlBody,
        observedAt: chooseObservedAt(row.createdAt, row.date),
      });
    }).filter(Boolean);
  }
