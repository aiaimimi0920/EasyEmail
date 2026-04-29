import type { CodeSource, ObserveMessageInput } from "./models.js";

export interface ExtractedOtp {
  code: string;
  source: CodeSource;
  candidates?: string[];
}

export interface ExtractOtpContentInput {
  sender?: string;
  subject?: string;
  htmlBody?: string;
  textBody?: string;
}

interface OtpCandidate {
  code: string;
  source: CodeSource;
  score: number;
  canonicalCode: string;
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
] as const;
const LETTER_ONLY_STOPWORDS = new Set([
  "CODE",
  "IS",
  "VERIFY",
  "VERIFICATION",
  "LOGIN",
  "SIGNIN",
  "PASSWORD",
  "PASSCODE",
  "CONFIRM",
  "CONFIRMATION",
  "SECURITY",
  "EMAIL",
  "ENTER",
  "CONTINUE",
  "IGNORE",
  "TRACKING",
  "NUMBER",
  "EXPIRES",
  "MINUTES",
  "OPENAI",
  "CHATGPT",
  "TEMPORARY",
]);

function normalizeContent(value: string | undefined, source: CodeSource): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const text = source === "html"
    ? value.replace(HTML_TAG_RE, " ")
    : value;

  const normalized = text
    .replace(/\s+/g, " ")
    .trim();

  return normalized || undefined;
}

function scoreCandidate(
  source: CodeSource,
  code: string,
  context: string,
  occurrencesByCode: Map<string, number>,
  uniqueCodeCount: number,
): number {
  let score = source === "subject" ? 18 : source === "text" ? 12 : 9;
  const canonical = normalizeCandidateCode(code);
  const compact = canonical.replace(/-/g, "");
  const rawCompact = code.trim().replace(/[-\s]+/g, "");
  const hasDigit = /\d/.test(compact);
  const hasLetter = /[A-Z]/.test(compact);
  const isLetterOnly = hasLetter && !hasDigit;
  const isGrouped = canonical.includes("-");

  if (CONTEXT_RE.test(context)) {
    score += 90;
  }

  if (VALIDITY_HINT_RE.test(context)) {
    score += 10;
  }

  if (NEGATIVE_RE.test(context)) {
    score -= 85;
  }

  if (hasDigit && hasLetter) {
    score += 24;
  } else if (hasDigit) {
    if (compact.length === 6) {
      score += 18;
    } else if (compact.length >= 4 && compact.length <= 8) {
      score += 12;
    } else {
      score += 6;
    }
  } else if (isLetterOnly) {
    score += LETTER_ONLY_STOPWORDS.has(compact) ? -30 : 4;
    if (/[a-z]/.test(rawCompact)) {
      score -= 12;
    }
  }

  if (isGrouped) {
    score += CONTEXT_RE.test(context) ? 12 : -8;
  }

  const repeated = occurrencesByCode.get(canonical) ?? 1;
  if (repeated > 1) {
    score += 12 * (repeated - 1);
  }

  if (uniqueCodeCount === 1) {
    score += 8;
  }

  return score;
}

function normalizeCandidateCode(code: string): string {
  return code.trim().replace(/\s+/g, "-").toUpperCase();
}

function compactCandidateCode(code: string): string {
  return normalizeCandidateCode(code).replace(/-/g, "");
}

function trimFusedMixedCodeSuffix(code: string): string {
  const rawCode = code.trim();
  if (!/[A-Z]/.test(rawCode) || !/\d/.test(rawCode) || !/[a-z]/.test(rawCode)) {
    return rawCode;
  }

  for (let length = 5; length <= Math.min(12, rawCode.length - 2); length += 1) {
    const prefix = rawCode.slice(0, length);
    const suffix = rawCode.slice(length);
    if (!/[A-Z]/.test(prefix) || !/\d/.test(prefix)) {
      continue;
    }
    if (!/^[A-Za-z]{2,}$/.test(suffix) || !/[a-z]/.test(suffix)) {
      continue;
    }
    return prefix;
  }

  return rawCode;
}

function buildFusedCoreCandidates(code: string): string[] {
  const rawCode = code.trim();
  const candidates = new Set<string>();

  const fusedNumericMatch = rawCode.match(/^(?:[A-Za-z]{2,})?(\d{4,10})(?:[A-Za-z]{2,})?$/);
  if (fusedNumericMatch?.[1] && fusedNumericMatch[1] !== rawCode) {
    candidates.add(fusedNumericMatch[1]);
  }

  const trimmedMixedCode = trimFusedMixedCodeSuffix(rawCode);
  if (trimmedMixedCode !== rawCode) {
    candidates.add(trimmedMixedCode);
  }

  return [...candidates];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function appearsInsideEmailAddress(text: string, code: string, index: number): boolean {
  if (!code.trim()) {
    return false;
  }

  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + code.length + 80);
  const segment = text.slice(start, end);
  const codePattern = new RegExp(escapeRegex(code), "i");

  return [...segment.matchAll(EMAIL_AROUND_CANDIDATE_RE)].some((match) => {
    const email = match[0];
    return codePattern.test(email);
  });
}

function isViableCandidate(code: string, context: string): boolean {
  const rawTrimmed = code.trim();
  const canonical = normalizeCandidateCode(code);
  const compact = canonical.replace(/-/g, "");
  const rawCompact = rawTrimmed.replace(/[-\s]+/g, "");
  const hasDigit = /\d/.test(compact);
  const hasLetter = /[A-Z]/.test(compact);
  const segments = canonical.split(/[- ]+/).filter(Boolean);
  const rawSegments = rawTrimmed.split(/[- ]+/).filter(Boolean);
  const isHexLikeColor = /^[A-F0-9]{6}(?:[A-F0-9]{2})?$/.test(compact) && /[A-F]/.test(compact);

  if (!hasDigit && !hasLetter) {
    return false;
  }

  if (isHexLikeColor && COLOR_STYLE_HINT_RE.test(context)) {
    return false;
  }

  if (hasLetter && !hasDigit) {
    if (compact.length < 4 || compact.length > 12) {
      return false;
    }
    if (/[a-z]/.test(rawCompact)) {
      return false;
    }
    if (LETTER_ONLY_STOPWORDS.has(compact)) {
      return false;
    }
    return CONTEXT_RE.test(context);
  }

  if (segments.length > 1) {
    const hasValidSegment = segments.some((segment) => /\d/.test(segment) || /^[A-Z]{4,12}$/.test(segment));
    const hasBlockedAlphaSegment = segments.some((segment) => /^[A-Z]+$/.test(segment) && LETTER_ONLY_STOPWORDS.has(segment));
    const hasLowercaseAlphaSegment = rawSegments.some((segment) => /[a-z]/.test(segment));
    if (!hasValidSegment || hasBlockedAlphaSegment || hasLowercaseAlphaSegment) {
      return false;
    }
  }

  if (hasDigit && !hasLetter) {
    return compact.length >= 4 && compact.length <= 10;
  }

  return compact.length >= 5 && compact.length <= 24;
}

function extractCandidates(
  value: string | undefined,
  source: CodeSource,
  occurrencesByCode: Map<string, number>,
  uniqueCodeCount: number,
): OtpCandidate[] {
  const normalized = normalizeContent(value, source);
  if (!normalized) {
    return [];
  }

  const candidates: OtpCandidate[] = [];

  const regexes = [GROUPED_CODE_RE, ALPHANUMERIC_CODE_RE, NUMERIC_CODE_RE];
  for (const regex of regexes) {
    for (const match of normalized.matchAll(regex)) {
      const code = match[1];
      const index = match.index ?? 0;
      if (appearsInsideEmailAddress(normalized, code, index)) {
        continue;
      }
      const context = normalized.slice(Math.max(0, index - 32), Math.min(normalized.length, index + code.length + 48));
      if (!isViableCandidate(code, context)) {
        continue;
      }

      const canonicalCode = normalizeCandidateCode(code);
      candidates.push({
        code: code.trim(),
        canonicalCode,
        source,
        score: scoreCandidate(source, code, context, occurrencesByCode, uniqueCodeCount),
      });

      for (const fusedCore of buildFusedCoreCandidates(code)) {
        const numericCanonical = normalizeCandidateCode(fusedCore);
        candidates.push({
          code: fusedCore,
          canonicalCode: numericCanonical,
          source,
          score: scoreCandidate(source, fusedCore, context, occurrencesByCode, uniqueCodeCount) + 6,
        });
      }
    }
  }

  return candidates;
}

function collectOccurrences(input: ExtractOtpContentInput): Map<string, number> {
  const counts = new Map<string, number>();
  const values: Array<string | undefined> = [
    normalizeContent(input.subject, "subject"),
    normalizeContent(input.textBody, "text"),
    normalizeContent(input.htmlBody, "html"),
  ];

  for (const value of values) {
    if (!value) {
      continue;
    }

    const seenInValue = new Set<string>();
    for (const regex of [GROUPED_CODE_RE, ALPHANUMERIC_CODE_RE, NUMERIC_CODE_RE]) {
      for (const match of value.matchAll(regex)) {
        const code = match[1];
        const index = match.index ?? 0;
        if (appearsInsideEmailAddress(value, code, index)) {
          continue;
        }
        const context = value.slice(Math.max(0, index - 32), Math.min(value.length, index + code.length + 48));
        if (!isViableCandidate(code, context)) {
          continue;
        }
        const canonicalCode = normalizeCandidateCode(code);
        if (seenInValue.has(canonicalCode)) {
          continue;
        }
        seenInValue.add(canonicalCode);
        counts.set(canonicalCode, (counts.get(canonicalCode) ?? 0) + 1);
      }
    }
  }

  return counts;
}

function extractContextualNumericOtp(input: ExtractOtpContentInput): ExtractedOtp | undefined {
  const orderedValues: Array<{ value: string | undefined; source: CodeSource }> = [
    { value: input.subject, source: "subject" },
    { value: input.textBody, source: "text" },
    { value: input.htmlBody, source: "html" },
  ];
  const matches: Array<{ code: string; source: CodeSource }> = [];
  for (const entry of orderedValues) {
    const normalized = normalizeContent(entry.value, entry.source);
    if (!normalized) {
      continue;
    }
    for (const match of normalized.matchAll(new RegExp(CONTEXTUAL_NUMERIC_OTP_RE, "ig"))) {
      const code = String(match[1] || "").trim();
      if (/^\d{6}$/.test(code)) {
        matches.push({ code, source: entry.source });
      }
    }
  }
  if (matches.length === 0) {
    return undefined;
  }
  const uniqueCodes = [...new Set(matches.map((item) => item.code))];
  const best = matches[0];
  return {
    code: best.code,
    source: best.source,
    ...(uniqueCodes.length > 1 ? { candidates: uniqueCodes } : {}),
  };
}

function extractContextualShortOtp(input: ExtractOtpContentInput): ExtractedOtp | undefined {
  const orderedValues: Array<{ value: string | undefined; source: CodeSource }> = [
    { value: input.subject, source: "subject" },
    { value: input.textBody, source: "text" },
    { value: input.htmlBody, source: "html" },
  ];

  for (const entry of orderedValues) {
    const normalized = normalizeContent(entry.value, entry.source);
    if (!normalized) {
      continue;
    }

    for (const pattern of CONTEXTUAL_SHORT_OTP_PATTERNS) {
      const match = normalized.match(pattern);
      const rawCode = String(match?.[1] ?? "").trim();
      if (rawCode) {
        const fusedNumericMatch = rawCode.match(/^(?:[A-Za-z]{2,})?(\d{4,10})(?:[A-Za-z]{2,})?$/);
        const trimmedMixedCode = trimFusedMixedCodeSuffix(rawCode);
        const code = fusedNumericMatch?.[1] && fusedNumericMatch[1] !== rawCode
          ? fusedNumericMatch[1]
          : trimmedMixedCode;
        if (/[A-Za-z0-9]/.test(code)) {
          return {
            code,
            source: entry.source,
          };
        }
      }
    }
  }

  return undefined;
}

export function extractOtpFromContent(input: ExtractOtpContentInput): ExtractedOtp | undefined {
  const contextualNumericOtp = extractContextualNumericOtp(input);
  if (contextualNumericOtp) {
    return contextualNumericOtp;
  }

  const contextualShortOtp = extractContextualShortOtp(input);
  if (contextualShortOtp) {
    return contextualShortOtp;
  }

  const occurrencesByCode = collectOccurrences(input);
  if (occurrencesByCode.size === 0) {
    return undefined;
  }

  const candidates = [
    ...extractCandidates(input.subject, "subject", occurrencesByCode, occurrencesByCode.size),
    ...extractCandidates(input.textBody, "text", occurrencesByCode, occurrencesByCode.size),
    ...extractCandidates(input.htmlBody, "html", occurrencesByCode, occurrencesByCode.size),
  ];

  if (candidates.length === 0) {
    return undefined;
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    const sourcePriority = {
      subject: 3,
      text: 2,
      html: 1,
    } satisfies Record<CodeSource, number>;

    return sourcePriority[right.source] - sourcePriority[left.source];
  });

  const topCandidate = candidates[0]!;
  const sixDigitNumericCandidates = candidates.filter((candidate) => /^\d{6}$/.test(compactCandidateCode(candidate.code)));
  const preferredSixDigitNumericCandidate = sixDigitNumericCandidates.find((candidate) => candidate.score >= topCandidate.score - 4);
  const best = preferredSixDigitNumericCandidate ?? topCandidate;
  const uniqueCandidates = [...new Set(candidates.map((candidate) => candidate.code))].slice(0, 8);
  return best.score >= 15
    ? {
        code: best.code,
        source: best.source,
        ...(uniqueCandidates.length > 1 ? { candidates: uniqueCandidates } : {}),
      }
    : undefined;
}

export function extractOtpCode(message: ObserveMessageInput): ExtractedOtp | undefined {
  return extractOtpFromContent({
    sender: message.sender,
    subject: message.subject,
    htmlBody: message.htmlBody,
    textBody: message.textBody,
  });
}
