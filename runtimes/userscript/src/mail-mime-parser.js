  function decodeBytesToText(bytes, preferredCharset) { const list = []; const normalized = String(preferredCharset || '').trim().toLowerCase(); if (normalized) list.push(normalized); if (!list.includes('utf-8')) list.push('utf-8'); if (!list.includes('windows-1252')) list.push('windows-1252'); for (const name of list) { try { return new TextDecoder(name, { fatal: false }).decode(bytes); } catch {} } return Array.from(bytes).map((byte) => String.fromCharCode(byte)).join(''); }
  function base64ToBytes(value) { const normalized = String(value || '').replace(/\s+/g, ''); if (!normalized) return new Uint8Array(); try { const binary = atob(normalized); const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i); return bytes; } catch { return new Uint8Array(); } }
  function extractCharset(contentType) { const match = String(contentType || '').match(/charset="?([^";]+)"?/i); return match ? match[1].trim() : 'utf-8'; }
  function decodeQuotedPrintable(value, preferredCharset) { const input = String(value || '').replace(/=\r?\n/g, ''); const bytes = []; for (let i = 0; i < input.length; i += 1) { const current = input[i]; const hex = input.slice(i + 1, i + 3); if (current === '=' && /^[0-9a-fA-F]{2}$/.test(hex)) { bytes.push(Number.parseInt(hex, 16)); i += 2; continue; } bytes.push(input.charCodeAt(i) & 0xff); } return decodeBytesToText(new Uint8Array(bytes), preferredCharset); }
  function decodeBase64Text(value, preferredCharset) { const bytes = base64ToBytes(value); return bytes.length ? decodeBytesToText(bytes, preferredCharset) : String(value || ''); }
  function decodeMimeWords(value) { return String(value || '').replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_, charset, encoding, encodedText) => String(encoding).toUpperCase() === 'B' ? decodeBase64Text(encodedText, charset) : decodeQuotedPrintable(String(encodedText).replace(/_/g, ' '), charset)); }
  function splitRawMessage(raw) { const text = String(raw || ''); const match = text.match(/\r?\n\r?\n/); if (!match || match.index === undefined) return { headerText: '', bodyText: text }; return { headerText: text.slice(0, match.index), bodyText: text.slice(match.index + match[0].length) }; }
  function parseHeaderBlock(headerText) { const headers = {}; const unfolded = String(headerText || '').replace(/\r?\n[ \t]+/g, ' '); unfolded.split(/\r?\n/).forEach((line) => { const idx = line.indexOf(':'); if (idx <= 0) return; const key = line.slice(0, idx).trim().toLowerCase(); const value = line.slice(idx + 1).trim(); if (!key) return; headers[key] = headers[key] ? `${headers[key]}, ${value}` : value; }); return headers; }
  function getMultipartBoundary(contentType) { const match = String(contentType || '').match(/boundary="?([^";]+)"?/i); return match ? match[1].trim() : ''; }
  function splitMultipartBody(bodyText, boundary) { const marker = `--${boundary}`; return String(bodyText || '').split(marker).slice(1).map((part) => part.replace(/^\r?\n/, '').replace(/\r?\n--$/, '').trim()).filter((part) => part && part !== '--'); }
  function normalizeReadableText(value) {
    const normalized = String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u2000-\u200F\u2060\uFEFF\u00AD]/g, '')
      .replace(/\r\n?/g, '\n');
    if (!normalized.trim()) return '';
    const out = [];
    let previousBlank = false;
    normalized.split('\n').forEach((line) => {
      const compact = line.replace(/\s+/g, ' ').trim();
      if (!compact) {
        if (out.length && !previousBlank) out.push('');
        previousBlank = true;
        return;
      }
      out.push(compact);
      previousBlank = false;
    });
    return out.join('\n').trim();
  }
  function htmlLooksLikeMarkup(value) { return /<\s*\/?\s*[a-z][^>]*>/i.test(String(value || '')); }
  function normalizeComparableText(value) { return normalizeReadableText(decodeHtmlEntities(String(value || ''))).toLowerCase().replace(/\s+/g, ''); }
  function textsSubstantiallyOverlap(left, right) {
    const leftComparable = normalizeComparableText(left);
    const rightComparable = normalizeComparableText(right);
    if (!leftComparable || !rightComparable) return false;
    if (leftComparable === rightComparable) return true;
    const shorter = leftComparable.length <= rightComparable.length ? leftComparable : rightComparable;
    const longer = shorter === leftComparable ? rightComparable : leftComparable;
    return shorter.length >= 32 && longer.includes(shorter) && (shorter.length / longer.length) >= 0.68;
  }
  function pickMoreCompleteText(left, right) {
    const leftText = normalizeReadableText(left);
    const rightText = normalizeReadableText(right);
    if (!leftText) return rightText;
    if (!rightText) return leftText;
    if (rightText.length !== leftText.length) return rightText.length > leftText.length ? rightText : leftText;
    const leftLineCount = leftText.split('\n').length;
    const rightLineCount = rightText.split('\n').length;
    return rightLineCount > leftLineCount ? rightText : leftText;
  }
  function mergeReadableTexts(items) {
    const merged = [];
    for (const item of items || []) {
      const text = normalizeReadableText(item);
      if (!text) continue;
      const existingIndex = merged.findIndex((entry) => textsSubstantiallyOverlap(entry, text));
      if (existingIndex >= 0) {
        merged[existingIndex] = pickMoreCompleteText(merged[existingIndex], text);
        continue;
      }
      merged.push(text);
    }
    return merged;
  }
  function pushHtmlTextChunk(chunks, value) {
    const text = String(value || '');
    if (!text) return;
    chunks.push(text);
  }
  function pushHtmlBoundary(chunks, marker = '\n') {
    if (!chunks.length) return;
    const last = String(chunks[chunks.length - 1] || '');
    if (last.endsWith(marker) || last.endsWith('\n\n')) return;
    chunks.push(marker);
  }
  function hasVisibleHtmlStyle(node) {
    const style = String(node && node.getAttribute ? node.getAttribute('style') || '' : '').replace(/\s+/g, '').toLowerCase();
    return !/(display:none|visibility:hidden|opacity:0|max-height:0|max-width:0|font-size:0|line-height:0)/.test(style);
  }
  function extractHtmlTextChunks(node, chunks) {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      pushHtmlTextChunk(chunks, node.nodeValue || '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = String(node.tagName || '').toLowerCase();
    if (!tag || /^(script|style|noscript|svg|img|meta|link|title)$/i.test(tag)) return;
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' || node.getAttribute('data-skip-in-text') === 'true' || !hasVisibleHtmlStyle(node)) return;
    if (tag === 'br' || tag === 'hr') {
      pushHtmlBoundary(chunks, '\n');
      return;
    }
    const startsBlock = /^(address|article|aside|blockquote|div|dl|dt|dd|fieldset|figcaption|figure|footer|form|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tbody|thead|tfoot|tr|ul)$/i.test(tag);
    if (startsBlock) pushHtmlBoundary(chunks, '\n');
    if (tag === 'li') pushHtmlTextChunk(chunks, '- ');
    if (tag === 'td' || tag === 'th') {
      const previous = node.previousElementSibling;
      if (previous && /^(td|th)$/i.test(String(previous.tagName || '').toLowerCase())) pushHtmlTextChunk(chunks, ' | ');
    }
    Array.from(node.childNodes || []).forEach((child) => extractHtmlTextChunks(child, chunks));
    if (/^(p|div|section|article|header|footer|li|tr|table|tbody|thead|tfoot|h[1-6]|blockquote|pre|ul|ol)$/i.test(tag)) pushHtmlBoundary(chunks, '\n');
  }
  function htmlToText(value) {
    const html = String(value || '').trim();
    if (!html) return '';
    const markup = html
      .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(?:p|div|section|article|header|footer|li|tr|table|h[1-6]|blockquote|pre|ul|ol)>/gi, '\n');
    try {
      const doc = new DOMParser().parseFromString(markup, 'text/html');
      if (doc.body) {
        const chunks = [];
        Array.from(doc.body.childNodes || []).forEach((node) => extractHtmlTextChunks(node, chunks));
        const combined = normalizeReadableText(chunks.join(''));
        if (combined) return combined;
      }
      return normalizeReadableText(doc.body ? (doc.body.innerText || doc.body.textContent || markup) : markup);
    } catch {
      const temp = document.createElement('div');
      temp.innerHTML = markup;
      return normalizeReadableText(temp.innerText || temp.textContent || markup);
    }
  }
  function decodeTransferEncodedBody(bodyText, encoding, preferredCharset) { const mode = String(encoding || '').trim().toLowerCase(); if (mode.includes('quoted-printable')) return decodeQuotedPrintable(bodyText, preferredCharset); if (mode.includes('base64')) return decodeBase64Text(bodyText, preferredCharset); return String(bodyText || ''); }
  function dedupeTexts(items) { const out = []; const seen = new Set(); for (const item of items || []) { const text = String(item || '').trim(); if (!text || seen.has(text)) continue; seen.add(text); out.push(text); } return out; }
  function mergeParsedMailParts(target, incoming) {
    if (!incoming) return target;
    target.textParts.push(...(incoming.textParts || []));
    target.htmlParts.push(...(incoming.htmlParts || []));
    return target;
  }
  function finalizeParsedMailParts(parts) {
    return {
      textParts: dedupeTexts((parts.textParts || []).map((item) => normalizeReadableText(item)).filter(Boolean)),
      htmlParts: dedupeTexts((parts.htmlParts || []).map((item) => String(item || '').trim()).filter(Boolean))
    };
  }
  function collectRawMailParts(sectionText, depth) {
    if (depth > 4) return { textParts: [], htmlParts: [] };
    const { headerText, bodyText } = splitRawMessage(sectionText);
    const headers = parseHeaderBlock(headerText);
    const contentType = String(headers['content-type'] || 'text/plain');
    const boundary = getMultipartBoundary(contentType);
    if (boundary && /multipart\//i.test(contentType)) {
      return finalizeParsedMailParts(splitMultipartBody(bodyText, boundary).reduce((acc, part) => mergeParsedMailParts(acc, collectRawMailParts(part, depth + 1)), { textParts: [], htmlParts: [] }));
    }
    const charset = extractCharset(contentType);
    const decoded = decodeTransferEncodedBody(bodyText, headers['content-transfer-encoding'], charset);
    const trimmed = String(decoded || '').trim();
    if (!trimmed) return { textParts: [], htmlParts: [] };
    const textParts = [];
    const htmlParts = [];
    if (/text\/html/i.test(contentType)) {
      htmlParts.push(trimmed);
    } else if (/text\/plain/i.test(contentType) || !/^[a-z]+\/[a-z0-9.+-]+/i.test(contentType)) {
      const text = normalizeReadableText(trimmed);
      if (text) textParts.push(text);
    } else if (/<(?:!doctype|html|body|div|p|table|tr|td|a)\b/i.test(trimmed)) {
      htmlParts.push(trimmed);
    }
    return finalizeParsedMailParts({ textParts, htmlParts });
  }
  function collectRawMailTexts(sectionText, depth) {
    const parts = collectRawMailParts(sectionText, depth);
    return mergeReadableTexts([...(parts.textParts || []), ...((parts.htmlParts || []).map((html) => htmlToText(html)).filter(Boolean))]);
  }
  function parseRawMail(raw) {
    const source = String(raw || '');
    const { headerText, bodyText } = splitRawMessage(source);
    const headers = parseHeaderBlock(headerText);
    const subject = normalizeText(decodeMimeWords(headers.subject || ''));
    const from = normalizeText(decodeMimeWords(headers.from || ''));
    const date = normalizeText(decodeMimeWords(headers.date || ''));
    const parts = collectRawMailParts(source, 0);
    const textParts = [...(parts.textParts || [])];
    const htmlParts = dedupeTexts(parts.htmlParts || []);
    if (!(textParts.length || htmlParts.length) && bodyText) {
      const fallbackSource = String(bodyText || '').trim();
      if (htmlLooksLikeMarkup(fallbackSource)) {
        htmlParts.push(fallbackSource);
        const derivedText = htmlToText(fallbackSource);
        if (derivedText) textParts.push(derivedText);
      } else {
        const fallbackText = normalizeReadableText(fallbackSource);
        if (fallbackText) textParts.push(fallbackText);
      }
    }
    const derivedHtmlTexts = htmlParts.map((html) => htmlToText(html)).filter(Boolean);
    const finalTexts = mergeReadableTexts([...textParts, ...derivedHtmlTexts]);
    const finalHtml = htmlParts.join('\n\n');
    return { subject, from, date, textBody: finalTexts.join('\n\n'), htmlBody: finalHtml, texts: finalTexts };
  }
