  function extractResponseSetCookie(rawHeaders) {
    const text = String(rawHeaders || '');
    const matches = [...text.matchAll(/^set-cookie:\s*(.+)$/gim)].map((match) => String(match[1] || '').trim()).filter(Boolean);
    return matches.length ? matches : [];
  }
  function parseSetCookieHeader(rawSetCookie) {
    return String(rawSetCookie || '')
      .split(/,(?=\s*[A-Za-z0-9_\-]+=)/)
      .map((entry) => String(entry || '').split(';', 1)[0].trim())
      .filter(Boolean)
      .join('; ');
  }
  function extractCookieHeader(rawHeaders) {
    const cookies = extractResponseSetCookie(rawHeaders).map((entry) => parseSetCookieHeader(entry)).filter(Boolean);
    if (!cookies.length) return '';
    const pairs = new Map();
    cookies.join('; ').split(/;\s*/).forEach((entry) => {
      const parts = String(entry || '').split('=');
      const key = parts.shift();
      if (!key) return;
      pairs.set(key.trim(), `${key.trim()}=${parts.join('=').trim()}`);
    });
    return [...pairs.values()].join('; ');
  }

  function buildStatusError(providerName, phase, status, body) {
    const record = readValueRecord(body);
    const detail = readValueString(record.message) || readValueString(record.error) || readValueString(record.detail) || (typeof body === 'string' ? body.trim() : undefined);
    return new Error(`${providerName} ${phase} failed: HTTP ${status}${detail ? `. ${detail}` : ''}`);
  }
  function extractDomainsFromBody(body) {
    const roots = [body, readValueRecord(body).data, readValueRecord(body).result];
    for (const root of roots) {
      const csvField = readValueString(root && root.emailDomains) || readValueString(root && root.email_domains);
      if (csvField) {
        const domains = csvField.split(/[\s,;]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
        if (domains.length) return [...new Set(domains)];
      }
      const rows = [].concat(readValueRecordList(root && root.domains), readValueRecordList(root && root.items), readValueRecordList(root && root.list), Array.isArray(root) ? root : []);
      const domains = rows.map((item) => readValueString(item.domain) || readValueString(item.name) || readValueString(item.address)).filter(Boolean);
      if (domains.length) return [...new Set(domains.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
    }
    return [];
  }
  function readBodyErrorCode(body) {
    return readValueString(readValueRecord(body).error) || readValueString(readValueRecord(body).code) || '';
  }
  function readBodyErrorReason(body) {
    const record = readValueRecord(body);
    return readValueString(record.reason) || readValueString(record.message) || readValueString(record.detail) || '';
  }
  function buildBodyError(providerName, phase, body) {
    const errorCode = readBodyErrorCode(body) || 'unknown_error';
    const reason = readBodyErrorReason(body);
    return new Error(`${providerName} ${phase} failed: ${errorCode}${reason ? `. ${reason}` : ''}`);
  }
  function extractIm215Address(body) {
    const roots = [body, readValueRecord(body).data, readValueRecord(body).result, readValueRecord(body).account, readValueRecord(body).mailbox];
    for (const root of roots) {
      const address = readValueString(root && root.address) || readValueString(root && root.email) || readValueString(root && root.mail) || readValueString(root && root.username);
      if (address && address.includes('@')) return { address: address.trim().toLowerCase(), mailboxId: readValueString(root.id) || readValueString(root.mailboxId) || readValueString(root.accountId), domain: readValueString(root.domain) || address.split('@')[1] || '', tempToken: readValueString(root.tempToken) || readValueString(root.token) };
    }
    return undefined;
  }
