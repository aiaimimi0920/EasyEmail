  function decodeHtmlEntities(value) {
    const source = String(value || '');
    if (!source) return '';
    try {
      const textarea = document.createElement('textarea');
      textarea.innerHTML = source;
      return textarea.value;
    } catch {
      return source.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&#x27;/gi, '\'');
    }
  }
  function cleanCandidateUrl(value) { return String(value || '').trim().replace(/^[<(]+/, '').replace(/[>)\].,;!?]+$/, ''); }
  function sanitizeActionUrl(value) {
    const raw = decodeHtmlEntities(String(value || '')).replace(/[\u0000-\u001F\s]+/g, '').trim();
    const cleaned = cleanCandidateUrl(raw);
    if (!cleaned) return '';
    if (/^mailto:/i.test(cleaned)) return cleaned;
    try {
      const parsed = new URL(cleaned, location.href);
      return /^(https?:)$/i.test(parsed.protocol) ? parsed.toString() : '';
    } catch {
      return '';
    }
  }
  function extractTextUrls(value) {
    const source = String(value || '');
    if (!source) return [];
    const urls = [];
    [/\bhttps?:\/\/[^\s<>"']+/gi, /\bmailto:[^\s<>"']+/gi].forEach((pattern) => {
      for (const match of source.matchAll(pattern)) {
        const url = sanitizeActionUrl(match[0]);
        if (url) urls.push(url);
      }
    });
    return urls;
  }
  function summarizeActionLabel(url, label) {
    const normalizedLabel = normalizeReadableText(decodeHtmlEntities(label || ''));
    if (normalizedLabel && normalizedLabel.length <= 96 && !/^https?:\/\//i.test(normalizedLabel)) return normalizedLabel;
    try {
      const parsed = new URL(url);
      const tail = `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`.replace(/\/$/, '');
      return tail || url;
    } catch {
      return url;
    }
  }
  const ACTION_LINK_RE = /(?:verify|verification|activate|activation|confirm|complete|continue|action-code|magic|sign[\s-]*in|login|reset|approve|appeal|unlock|join|access)/i;
  const NOISY_LINK_RE = /(?:twitter\.com|linkedin\.com|youtube\.com|instagram\.com|unsubscribe|public\/images|logo-primary|email\.mg\.|pixel|tracking)/i;
  function linkPriority(link) {
    const haystack = `${String(link.url || '')}\n${String(link.label || '')}`;
    let score = 0;
    if (ACTION_LINK_RE.test(haystack)) score += 60;
    if (/replit\.com\/action-code/i.test(link.url || '')) score += 120;
    if (/docs\./i.test(link.url || '')) score += 12;
    if (/^mailto:/i.test(link.url || '')) score += 10;
    if (NOISY_LINK_RE.test(link.url || '')) score -= 120;
    if (/https?:\/\/[^/]+\/?$/i.test(link.url || '')) score -= 60;
    if (link.label && link.label !== link.url) score += 4;
    return score;
  }
  function extractLinksFromHtml(html) {
    const source = String(html || '');
    if (!source.trim()) return [];
    const links = [];
    const seen = new Set();
    const push = (href, label) => {
      const url = sanitizeActionUrl(href);
      if (!url || seen.has(url)) return;
      seen.add(url);
      links.push({ url, label: summarizeActionLabel(url, label) });
    };
    if (typeof DOMParser !== 'undefined') {
      try {
        const doc = new DOMParser().parseFromString(source, 'text/html');
        Array.from(doc.querySelectorAll('a[href]')).forEach((node) => push(node.getAttribute('href') || '', node.textContent || ''));
      } catch {}
    }
    for (const match of source.matchAll(/<a\b[^>]*href=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
      push(match[1] || match[2] || match[3] || '', htmlToText(match[4] || ''));
    }
    return links;
  }
  function extractMessageLinks(message) {
    const seen = new Set();
    const links = [];
    const push = (url, label) => {
      const normalizedUrl = sanitizeActionUrl(url);
      if (!normalizedUrl || seen.has(normalizedUrl)) return;
      seen.add(normalizedUrl);
      links.push({ url: normalizedUrl, label: summarizeActionLabel(normalizedUrl, label) });
    };
    extractLinksFromHtml(message && message.htmlBody).forEach((link) => push(link.url, link.label));
    extractTextUrls(message && message.textBody).forEach((url) => push(url, url));
    extractTextUrls(message && message.subject).forEach((url) => push(url, url));
    return links
      .map((link) => ({ ...link, priority: linkPriority(link) }))
      .filter((link) => link.priority > -40)
      .sort((a, b) => b.priority - a.priority || a.url.length - b.url.length)
      .slice(0, 8)
      .map(({ priority, ...link }) => link);
  }

  const NUMERIC_CODE_RE = /(?<![A-Za-z0-9])(\d{4,10})(?![A-Za-z0-9])/g;
  const ALPHANUMERIC_CODE_RE = /(?<![A-Za-z0-9])([A-Za-z0-9]{5,18})(?![A-Za-z0-9])/g;
  const GROUPED_CODE_RE = /(?<![A-Za-z0-9])([A-Za-z0-9]{2,8}(?:-[A-Za-z0-9]{2,8}){1,3})(?![A-Za-z0-9])/g;
  const CONTEXT_RE = /(?:verification\s*code|verify\s*code|security\s*code|one[-\s]*time\s*(?:pass)?code|login\s*code|sign[\s-]*in\s*code|confirmation\s*code|email\s*code|otp|passcode|验证码|校验码|动态码|动态密码|口令|代码为|代码是|code\s*(?:is|:))/i;
  const VALIDITY_HINT_RE = /(?:expire|expired|expires|valid|validity|minute|minutes|min|mins|second|seconds|sec|secs|分钟|秒|有效期)/i;
  const NEGATIVE_RE = /(?:backup|ignore|secondary|order|invoice|tracking|parcel|shipment|ticket|reference|ref\b|phone|mobile|zip|postal|amount|price|total|订单|金额|价格|快递|包裹|物流|手机号|电话|邮编|尾号|参考号)/i;
  const COLOR_STYLE_HINT_RE = /(?:color|background|border|fill|stroke|font-face|stylesheet|style=|rgba?\(|hsla?\(|#[0-9a-f]{3,8})/i;
  const HTML_TAG_RE = /<[^>]+>/g;
  const EMAIL_AROUND_CANDIDATE_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const CONTEXTUAL_NUMERIC_OTP_RE = /(?:verification\s*code|verify\s*code|security\s*code|one[-\s]*time\s*(?:pass)?code|login\s*code|sign[\s-]*in\s*code|confirmation\s*code|email\s*code|otp|passcode|验证码|校验码|动态码|动态密码|口令|代码为|代码是|enter\s+this\s+temporary\s+verification\s+code)[^0-9]{0,80}(\d{6})(?!\d)/i;
  const CONTEXTUAL_SHORT_OTP_PATTERNS = [
    /primary\s*code[^A-Za-z0-9]{0,12}([A-Za-z0-9][A-Za-z0-9-]{3,23})(?![A-Za-z0-9])/i,
    /verification\s*code[^A-Za-z0-9]{0,12}([A-Za-z0-9][A-Za-z0-9-]{3,23})(?![A-Za-z0-9])/i,
    /verify\s*code[^A-Za-z0-9]{0,12}([A-Za-z0-9][A-Za-z0-9-]{3,23})(?![A-Za-z0-9])/i,
    /security\s*code[^A-Za-z0-9]{0,12}([A-Za-z0-9][A-Za-z0-9-]{3,23})(?![A-Za-z0-9])/i,
    /login\s*code[^A-Za-z0-9]{0,12}([A-Za-z0-9][A-Za-z0-9-]{3,23})(?![A-Za-z0-9])/i,
    /confirmation\s*code[^A-Za-z0-9]{0,12}([A-Za-z0-9][A-Za-z0-9-]{3,23})(?![A-Za-z0-9])/i,
    /email\s*code[^A-Za-z0-9]{0,12}([A-Za-z0-9][A-Za-z0-9-]{3,23})(?![A-Za-z0-9])/i,
    /(?:code\s*(?:is|:)|代码为|代码是)[^A-Za-z0-9]{0,12}([A-Za-z0-9][A-Za-z0-9-]{3,23})(?![A-Za-z0-9])/i,
    /use\s+(?:the\s+)?code[^A-Za-z0-9]{0,12}([A-Za-z0-9][A-Za-z0-9-]{3,23})(?![A-Za-z0-9])/i,
    /enter\s+(?:the\s+)?code[^A-Za-z0-9]{0,12}([A-Za-z0-9][A-Za-z0-9-]{3,23})(?![A-Za-z0-9])/i,
  ];
  const LETTER_ONLY_STOPWORDS = new Set(['CODE','IS','VERIFY','VERIFICATION','LOGIN','SIGNIN','PASSWORD','PASSCODE','CONFIRM','CONFIRMATION','SECURITY','EMAIL','ENTER','CONTINUE','IGNORE','TRACKING','NUMBER','EXPIRES','MINUTES','OPENAI','CHATGPT','TEMPORARY']);
  function normalizeUtcLikeTimestamp(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return '';
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(normalized)) {
      return `${normalized.replace(' ', 'T')}Z`;
    }
    return normalized;
  }
  function parseDateValue(value) { const normalized = normalizeUtcLikeTimestamp(value); if (!normalized) return 0; if (/^\d{10,13}$/.test(normalized)) { const num = Number(normalized); return Number.isFinite(num) ? (normalized.length >= 13 ? num : num * 1000) : 0; } const parsed = Date.parse(normalized); return Number.isFinite(parsed) ? parsed : 0; }
  function chooseObservedAt(...candidates) { for (const candidate of candidates) { const ms = parseDateValue(candidate); if (ms > 0) return new Date(ms).toISOString(); } return ''; }
  function formatObservedAt(value) { const ms = parseDateValue(value); return ms > 0 ? new Date(ms).toLocaleString() : t('none'); }
  function escapeRegex(value) { return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function compactCandidateCode(code) { return normalizeCandidateCode(code).replace(/-/g, ''); }
  function appearsInsideEmailAddress(text, code, index) { if (!String(code || '').trim()) return false; const source = String(text || ''); const start = Math.max(0, index - 80); const end = Math.min(source.length, index + String(code || '').length + 80); const segment = source.slice(start, end); const codePattern = new RegExp(escapeRegex(String(code || '')), 'i'); return [...segment.matchAll(EMAIL_AROUND_CANDIDATE_RE)].some((match) => codePattern.test(match[0])); }
  function normalizeContent(value, source) { if (!value || !String(value).trim()) return undefined; const text = source === 'html' ? String(value).replace(HTML_TAG_RE, ' ') : String(value); const normalized = text.replace(/\s+/g, ' ').trim(); return normalized || undefined; }
  function normalizeCandidateCode(code) { return String(code || '').trim().replace(/\s+/g, '-').toUpperCase(); }
  function scoreCandidate(source, code, context, counts, uniqueCount) { let score = source === 'subject' ? 18 : source === 'text' ? 12 : 9; const canonical = normalizeCandidateCode(code); const compact = canonical.replace(/-/g, ''); const rawCompact = String(code || '').trim().replace(/[-\s]+/g, ''); const hasDigit = /\d/.test(compact); const hasLetter = /[A-Z]/.test(compact); const isLetterOnly = hasLetter && !hasDigit; const isGrouped = canonical.includes('-'); if (CONTEXT_RE.test(context)) score += 90; if (VALIDITY_HINT_RE.test(context)) score += 10; if (NEGATIVE_RE.test(context)) score -= 85; if (hasDigit && hasLetter) score += 24; else if (hasDigit) { if (compact.length === 6) score += 18; else if (compact.length >= 4 && compact.length <= 8) score += 12; else score += 6; } else if (isLetterOnly) { score += LETTER_ONLY_STOPWORDS.has(compact) ? -30 : 4; if (/[a-z]/.test(rawCompact)) score -= 12; } if (isGrouped) score += CONTEXT_RE.test(context) ? 12 : -8; const repeated = counts.get(canonical) || 1; if (repeated > 1) score += 12 * (repeated - 1); if (uniqueCount === 1) score += 8; return score; }
  function trimFusedMixedCodeSuffix(code) { const rawCode = String(code || '').trim(); if (!/[A-Z]/.test(rawCode) || !/\d/.test(rawCode) || !/[a-z]/.test(rawCode)) return rawCode; for (let length = 5; length <= Math.min(12, rawCode.length - 2); length += 1) { const prefix = rawCode.slice(0, length); const suffix = rawCode.slice(length); if (!/[A-Z]/.test(prefix) || !/\d/.test(prefix)) continue; if (!/^[A-Za-z]{2,}$/.test(suffix) || !/[a-z]/.test(suffix)) continue; return prefix; } return rawCode; }
  function buildFusedCoreCandidates(code) { const rawCode = String(code || '').trim(); const candidates = new Set(); const fusedNumericMatch = rawCode.match(/^(?:[A-Za-z]{2,})?(\d{4,10})(?:[A-Za-z]{2,})?$/); if (fusedNumericMatch && fusedNumericMatch[1] && fusedNumericMatch[1] !== rawCode) candidates.add(fusedNumericMatch[1]); const trimmedMixedCode = trimFusedMixedCodeSuffix(rawCode); if (trimmedMixedCode !== rawCode) candidates.add(trimmedMixedCode); return [...candidates]; }
  function isViableCandidate(code, context) { const rawTrimmed = String(code || '').trim(); const canonical = normalizeCandidateCode(code); const compact = canonical.replace(/-/g, ''); const rawCompact = rawTrimmed.replace(/[-\s]+/g, ''); const hasDigit = /\d/.test(compact); const hasLetter = /[A-Z]/.test(compact); const segments = canonical.split(/[- ]+/).filter(Boolean); const rawSegments = rawTrimmed.split(/[- ]+/).filter(Boolean); const isHexLikeColor = /^[A-F0-9]{6}(?:[A-F0-9]{2})?$/.test(compact) && /[A-F]/.test(compact); if (!hasDigit && !hasLetter) return false; if (isHexLikeColor && COLOR_STYLE_HINT_RE.test(context)) return false; if (hasLetter && !hasDigit) { if (compact.length < 4 || compact.length > 12) return false; if (/[a-z]/.test(rawCompact)) return false; if (LETTER_ONLY_STOPWORDS.has(compact)) return false; return CONTEXT_RE.test(context); } if (segments.length > 1) { const hasValidSegment = segments.some((segment) => /\d/.test(segment) || /^[A-Z]{4,12}$/.test(segment)); const hasBlockedAlphaSegment = segments.some((segment) => /^[A-Z]+$/.test(segment) && LETTER_ONLY_STOPWORDS.has(segment)); const hasLowercaseAlphaSegment = rawSegments.some((segment) => /[a-z]/.test(segment)); if (!hasValidSegment || hasBlockedAlphaSegment || hasLowercaseAlphaSegment) return false; } if (hasDigit && !hasLetter) return compact.length >= 4 && compact.length <= 10; return compact.length >= 5 && compact.length <= 24; }
  function extractCandidates(value, source, counts, uniqueCount) { const normalized = normalizeContent(value, source); if (!normalized) return []; const candidates = []; const regexes = [GROUPED_CODE_RE, ALPHANUMERIC_CODE_RE, NUMERIC_CODE_RE]; for (const regex of regexes) { for (const match of normalized.matchAll(regex)) { const code = match[1]; const index = match.index || 0; if (appearsInsideEmailAddress(normalized, code, index)) continue; const context = normalized.slice(Math.max(0, index - 32), Math.min(normalized.length, index + code.length + 48)); if (!isViableCandidate(code, context)) continue; const canonicalCode = normalizeCandidateCode(code); candidates.push({ code: String(code || '').trim(), canonicalCode, source, score: scoreCandidate(source, code, context, counts, uniqueCount) }); for (const fusedCore of buildFusedCoreCandidates(code)) { candidates.push({ code: fusedCore, canonicalCode: normalizeCandidateCode(fusedCore), source, score: scoreCandidate(source, fusedCore, context, counts, uniqueCount) + 6 }); } } } return candidates; }
  function collectOccurrences(input) { const counts = new Map(); const values = [normalizeContent(input.subject, 'subject'), normalizeContent(input.textBody, 'text'), normalizeContent(input.htmlBody, 'html')]; for (const value of values) { if (!value) continue; const seen = new Set(); for (const regex of [GROUPED_CODE_RE, ALPHANUMERIC_CODE_RE, NUMERIC_CODE_RE]) { for (const match of value.matchAll(regex)) { const code = match[1]; const index = match.index || 0; if (appearsInsideEmailAddress(value, code, index)) continue; const context = value.slice(Math.max(0, index - 32), Math.min(value.length, index + code.length + 48)); if (!isViableCandidate(code, context)) continue; const canonicalCode = normalizeCandidateCode(code); if (seen.has(canonicalCode)) continue; seen.add(canonicalCode); counts.set(canonicalCode, (counts.get(canonicalCode) || 0) + 1); } } } return counts; }
  function extractContextualShortOtp(input) { const orderedValues = [{ value: input.subject, source: 'subject' }, { value: input.textBody, source: 'text' }, { value: input.htmlBody, source: 'html' }]; for (const entry of orderedValues) { const normalized = normalizeContent(entry.value, entry.source); if (!normalized) continue; for (const pattern of CONTEXTUAL_SHORT_OTP_PATTERNS) { const match = normalized.match(pattern); const rawCode = String(match && match[1] || '').trim(); if (!rawCode) continue; const fusedNumericMatch = rawCode.match(/^(?:[A-Za-z]{2,})?(\\d{4,10})(?:[A-Za-z]{2,})?$/); const code = fusedNumericMatch && fusedNumericMatch[1] !== rawCode ? fusedNumericMatch[1] : rawCode; const context = normalized.slice(Math.max(0, (match.index || 0) - 32), Math.min(normalized.length, (match.index || 0) + rawCode.length + 48)); const isPrimaryCodeHint = /^primary\s*code/i.test(String(match && match[0] || '')); const normalizedCode = normalizeCandidateCode(code); const rawCompact = rawCode.replace(/[-\s]+/g, ''); const contextualPrimaryLooksValid = isPrimaryCodeHint && normalizedCode.replace(/-/g, '').length >= 5 && normalizedCode.replace(/-/g, '').length <= 24 && !/[a-z]/.test(rawCompact); if (/[A-Za-z0-9]/.test(code) && (isViableCandidate(code, context) || contextualPrimaryLooksValid)) return { code, source: entry.source }; } } return undefined; }
  function extractContextualNumericOtp(input) { const orderedValues = [{ value: input.subject, source: 'subject' }, { value: input.textBody, source: 'text' }, { value: input.htmlBody, source: 'html' }]; const matches = []; for (const entry of orderedValues) { const normalized = normalizeContent(entry.value, entry.source); if (!normalized) continue; for (const match of normalized.matchAll(new RegExp(CONTEXTUAL_NUMERIC_OTP_RE, 'ig'))) { const code = String(match[1] || '').trim(); if (/^\d{6}$/.test(code)) matches.push({ code, source: entry.source }); } } if (matches.length === 0) return undefined; const uniqueCodes = [...new Set(matches.map((item) => item.code))]; const best = matches[0]; return { code: best.code, source: best.source, ...(uniqueCodes.length > 1 ? { candidates: uniqueCodes } : {}) }; }
  function extractOtpFromContent(input) { const contextualShortOtp = extractContextualShortOtp(input); if (contextualShortOtp) return contextualShortOtp; const contextualNumericOtp = extractContextualNumericOtp(input); if (contextualNumericOtp) return contextualNumericOtp; const counts = collectOccurrences(input); if (!counts.size) return undefined; const candidates = [...extractCandidates(input.subject, 'subject', counts, counts.size), ...extractCandidates(input.textBody, 'text', counts, counts.size), ...extractCandidates(input.htmlBody, 'html', counts, counts.size)]; if (!candidates.length) return undefined; candidates.sort((left, right) => { if (right.score !== left.score) return right.score - left.score; const sourcePriority = { subject: 3, text: 2, html: 1 }; return sourcePriority[right.source] - sourcePriority[left.source]; }); const topCandidate = candidates[0]; const sixDigitNumericCandidates = candidates.filter((candidate) => /^\d{6}$/.test(compactCandidateCode(candidate.code))); const preferredSixDigitNumericCandidate = sixDigitNumericCandidates.find((candidate) => candidate.score >= topCandidate.score - 4); const best = preferredSixDigitNumericCandidate || topCandidate; const usefulCompanions = candidates.filter((candidate) => { const compact = compactCandidateCode(candidate.code); if (/^\d{6}$/.test(compact)) return true; return candidate.score >= Math.max(20, best.score - 12); }).map((candidate) => candidate.code); const uniqueCandidates = [...new Set(usefulCompanions)].slice(0, 8); return best.score >= 15 ? { code: best.code, source: best.source, ...(uniqueCandidates.length > 1 ? { candidates: uniqueCandidates } : {}) } : undefined; }
  function normalizeMessageBodies(textBodyInput, htmlBodyInput) {
    const rawTextBody = normalizeReadableText(textBodyInput);
    const rawHtmlBody = String(htmlBodyInput || '').trim();
    const htmlHasMarkup = htmlLooksLikeMarkup(rawHtmlBody);
    const htmlReadableBody = rawHtmlBody ? (htmlHasMarkup ? htmlToText(rawHtmlBody) : normalizeReadableText(rawHtmlBody)) : '';
    const mergedTextBody = mergeReadableTexts([rawTextBody, htmlReadableBody]).join('\n\n');
    return { textBody: mergedTextBody, htmlBody: htmlHasMarkup ? rawHtmlBody : '' };
  }
  function normalizeObservedMessage(message) { if (!message) return null; const bodies = normalizeMessageBodies(message.textBody || '', message.htmlBody || ''); const textBody = bodies.textBody; const htmlBody = bodies.htmlBody; const otp = message.extractedCode ? { code: message.extractedCode, source: message.codeSource || 'text', candidates: message.extractedCandidates || [] } : extractOtpFromContent({ subject: message.subject, textBody, htmlBody }); const actionLinks = Array.isArray(message.actionLinks) && message.actionLinks.length ? message.actionLinks.map((link) => ({ url: sanitizeActionUrl(link && link.url), label: summarizeActionLabel(sanitizeActionUrl(link && link.url), link && link.label) })).filter((link) => link.url) : extractMessageLinks({ subject: message.subject, textBody, htmlBody }); return { id: String(message.id || `${Date.now()}-${randomHex(6)}`), sender: normalizeText(message.sender || ''), subject: normalizeText(message.subject || ''), textBody, htmlBody, observedAt: chooseObservedAt(message.observedAt, message.receivedAt, message.createdAt, message.updatedAt, message.date, message.sentAt), extractedCode: otp ? otp.code : '', extractedCandidates: otp ? otp.candidates || [] : [], codeSource: otp ? otp.source : '', actionLinks }; }
  function createLocalPart(seed) { const host = (location.hostname || 'mail').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 8) || 'mail'; const basis = String(seed || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12); return `${basis || host}${randomHex(6)}`.slice(0, 24); }
  function matchesSenderFilter(message, filter) { const normalized = String(filter || '').trim().toLowerCase(); if (!normalized) return true; const text = `${String(message.sender || '').toLowerCase()}\n${String(message.subject || '').toLowerCase()}\n${String(message.textBody || '').toLowerCase()}\n${String(message.htmlBody || '').toLowerCase()}`; return text.includes(normalized); }
