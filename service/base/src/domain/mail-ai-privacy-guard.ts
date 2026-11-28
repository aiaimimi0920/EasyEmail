import type { MailSecurityLevel } from "./mail-phishing-evaluator.js";

export type MailAiProviderId = "openai" | "anthropic" | "gemini" | "deepseek" | "ollama" | "openai_compatible";

export interface MailPrivacyGuardPolicy {
  enabled: boolean;
  includeSubject?: boolean;
  requireExplicitConsent?: boolean;
  autoSummarizeOnOpen?: boolean;
  provider: MailAiProviderId | "free_translate";
  endpointUrl: string;
}

export interface MailPrivacyGuardInput {
  folder?: string;
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  snippet?: string;
  phishingLevel?: MailSecurityLevel;
  consentConfirmed?: boolean;
  autoTriggered?: boolean;
}

export type MailPrivacyBlockCode =
  | "AI_DISABLED"
  | "AUTO_TRIGGER_DISABLED"
  | "SENSITIVE_MAIL_BLOCKED"
  | "CONSENT_REQUIRED"
  | "INVALID_ENDPOINT";

export interface MailPrivacyGuardConsentPreview {
  charCount: number;
  scopeSummary: string;
  provider: string;
  endpointHost: string;
  willRedactPii: boolean;
}

export type MailPrivacyGuardDecision =
  | {
      allowed: true;
      sanitizedText: string;
      sanitizedSubject?: string;
      redactedCount: number;
      preview: MailPrivacyGuardConsentPreview;
    }
  | {
      allowed: false;
      code: MailPrivacyBlockCode;
      reason: string;
      preview?: MailPrivacyGuardConsentPreview;
    };

const PEM_PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const SENSITIVE_SECURITY_KEYWORDS_RE = /(?:验证码|动态口令|一次性密码|安全码|重置密码|密码重置|找回密码|银行账单|信用卡账单|交易提醒|转账确认|password\s+reset|reset\s+(?:your\s+)?password|(?:verification|security|login|sign[- ]in)\s+code|one[- ]time\s+(?:passcode|password|code)|two[- ]factor|2fa\s+code)/i;
const CN_IDENTITY_CARD_RE = /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g;
const BANK_CARD_NUMBER_RE = /\b[3-6]\d{15,18}\b/g;
const CN_MOBILE_PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const SECRET_API_TOKEN_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ee_[A-Za-z0-9_-]{20,})\b/g;
const EMAIL_ADDRESS_RE = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const STRIP_HTML_BLOCK_RE = /<\s*(?:script|style)\b[^>]*>[\s\S]*?<\s*\/\s*(?:script|style)\s*>/gi;
const STRIP_TAGS_RE = /<[^>]+>/g;

function truncateCodePoints(value: string, maxChars: number): string {
  const chars = Array.from(value);
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join("");
}

function htmlToVisiblePlainText(html: string | undefined): string {
  if (!html?.trim()) return "";
  return html
    .replace(STRIP_HTML_BLOCK_RE, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/p\s*>/gi, "\n")
    .replace(STRIP_TAGS_RE, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isLoopbackOllamaEndpoint(provider: string, endpointUrl: string): boolean {
  if (provider.trim().toLowerCase() !== "ollama") return false;
  try {
    const parsed = new URL(endpointUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export interface EndpointValidationResult {
  ok: boolean;
  normalizedOriginAndPath?: string;
  hostname?: string;
  reason?: string;
}

export function validateByokOrTranslationEndpoint(
  provider: MailAiProviderId | "free_translate",
  endpointUrl: string,
  allowLocalLoopback = false,
): EndpointValidationResult {
  try {
    const parsed = new URL(endpointUrl.trim());
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (isLoopback) {
      if (!allowLocalLoopback) {
        return { ok: false, reason: "云端运行时禁止将 AI 或翻译端点指向本机回环地址" };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, reason: "本地模型端点仅支持 HTTP 或 HTTPS 协议" };
      }
    } else {
      if (parsed.protocol !== "https:") {
        return { ok: false, reason: "外部 AI 与翻译端点必须使用 HTTPS 加密连接" };
      }
      if (/^(?:10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host) || /\.(?:local|internal|lan|home\.arpa)$/.test(host)) {
        return { ok: false, reason: "禁止将外部 AI 或翻译端点指向内网私有地址" };
      }
    }
    void provider;
    return {
      ok: true,
      normalizedOriginAndPath: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`,
      hostname: host,
    };
  } catch {
    return { ok: false, reason: "模型或翻译接口 URL 格式无效" };
  }
}

export function isSensitiveMailForAi(input: MailPrivacyGuardInput): boolean {
  const folder = (input.folder ?? "").trim().toLowerCase();
  if (folder === "spam" || folder === "junk" || folder === "trash") return true;
  if (input.phishingLevel === "danger") return true;

  const subject = input.subject ?? "";
  const textBody = input.textBody ?? "";
  const htmlVisible = htmlToVisiblePlainText(input.htmlBody);
  const snippet = input.snippet ?? "";
  const combined = `${subject}\n${textBody}\n${htmlVisible}\n${snippet}`;

  if (PEM_PRIVATE_KEY_RE.test(combined)) {
    PEM_PRIVATE_KEY_RE.lastIndex = 0;
    return true;
  }
  if (SENSITIVE_SECURITY_KEYWORDS_RE.test(combined)) return true;

  const contextualOtpRe = /(?:code|otp|pin|passcode|token|代码|口令|校验码|动态码)[^A-Za-z0-9]{0,40}\b(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{4,12}\b/i;
  return contextualOtpRe.test(combined);
}

export function redactOutgoingPromptPii(rawText: string): { redacted: string; replacements: number } {
  let replacements = 0;
  const replaceCounted = (source: string, pattern: RegExp, token: string): string =>
    source.replace(pattern, () => {
      replacements += 1;
      return token;
    });

  let out = rawText;
  out = replaceCounted(out, PEM_PRIVATE_KEY_RE, "[REDACTED_PRIVATE_KEY]");
  out = replaceCounted(out, SECRET_API_TOKEN_RE, "[REDACTED_API_KEY]");
  out = replaceCounted(out, CN_IDENTITY_CARD_RE, "[REDACTED_ID_NUMBER]");
  out = replaceCounted(out, BANK_CARD_NUMBER_RE, "[REDACTED_CARD_NUMBER]");
  out = replaceCounted(out, CN_MOBILE_PHONE_RE, "[REDACTED_PHONE]");
  out = replaceCounted(out, EMAIL_ADDRESS_RE, "[REDACTED_EMAIL]");
  return { redacted: out, replacements };
}

// Executes the 5-step PrivacyGuard: switch -> sensitive hard-block -> minimal visible text -> explicit consent -> PII redaction.
export function evaluateMailPrivacyGuard(
  policy: MailPrivacyGuardPolicy,
  input: MailPrivacyGuardInput,
  allowLocalLoopback = false,
): MailPrivacyGuardDecision {
  // Step 1: Feature master switch & auto-trigger gate.
  if (!policy.enabled) {
    return { allowed: false, code: "AI_DISABLED", reason: "智能辅助功能未启用" };
  }
  if (input.autoTriggered && !policy.autoSummarizeOnOpen) {
    return { allowed: false, code: "AUTO_TRIGGER_DISABLED", reason: "尚未开启打开邮件自动摘要" };
  }

  const endpointCheck = validateByokOrTranslationEndpoint(policy.provider, policy.endpointUrl, allowLocalLoopback);
  if (!endpointCheck.ok || !endpointCheck.hostname) {
    return { allowed: false, code: "INVALID_ENDPOINT", reason: endpointCheck.reason ?? "模型接口地址无效" };
  }
  const endpointHost = endpointCheck.hostname;

  // Step 2: Hard-block OTP, password reset, financial alerts, PEM private keys, spam/trash, and high-risk phishing BEFORE consent.
  if (isSensitiveMailForAi(input)) {
    return {
      allowed: false,
      code: "SENSITIVE_MAIL_BLOCKED",
      reason: "检测到验证码、安全口令、私钥或高危风险特征，已按隐私守卫规则拦截外发",
    };
  }

  // Step 3: Minimal context extraction (visible text + optional subject only; never headers or attachments).
  const rawVisibleBody = (input.textBody?.trim() || htmlToVisiblePlainText(input.htmlBody) || input.snippet?.trim() || "");
  const boundedBody = truncateCodePoints(rawVisibleBody, 8000);
  const boundedSubject = policy.includeSubject && input.subject?.trim()
    ? truncateCodePoints(input.subject.trim(), 1000)
    : undefined;
  const willRedactPii = !isLoopbackOllamaEndpoint(policy.provider, policy.endpointUrl);
  const scopeSummary = boundedSubject ? "仅邮件主题与可见正文（不含邮件头与任何附件）" : "仅可见邮件正文（不含主题、邮件头与任何附件）";
  const preview: MailPrivacyGuardConsentPreview = {
    charCount: Array.from(boundedBody).length + (boundedSubject ? Array.from(boundedSubject).length : 0),
    scopeSummary,
    provider: policy.provider,
    endpointHost,
    willRedactPii,
  };

  // Step 4: Explicit single-dispatch user consent gate.
  const requireConsent = policy.requireExplicitConsent !== false;
  if (requireConsent && !input.consentConfirmed && !input.autoTriggered) {
    return {
      allowed: false,
      code: "CONSENT_REQUIRED",
      reason: `即将发送约 ${preview.charCount} 字符（${scopeSummary}）至 ${endpointHost}`,
      preview,
    };
  }

  // Step 5: Mandatory PII regex redaction for all non-loopback endpoints.
  if (!willRedactPii) {
    return {
      allowed: true,
      sanitizedText: boundedBody,
      ...(boundedSubject ? { sanitizedSubject: boundedSubject } : {}),
      redactedCount: 0,
      preview,
    };
  }
  const bodyRedacted = redactOutgoingPromptPii(boundedBody);
  const subjectRedacted = boundedSubject ? redactOutgoingPromptPii(boundedSubject) : undefined;
  return {
    allowed: true,
    sanitizedText: bodyRedacted.redacted,
    ...(subjectRedacted ? { sanitizedSubject: subjectRedacted.redacted } : {}),
    redactedCount: bodyRedacted.replacements + (subjectRedacted?.replacements ?? 0),
    preview,
  };
}

export function prepareComposeDraftForAi(
  policy: MailPrivacyGuardPolicy,
  draftText: string,
  consentConfirmed: boolean,
  allowLocalLoopback = false,
): MailPrivacyGuardDecision {
  return evaluateMailPrivacyGuard(
    { ...policy, includeSubject: false },
    { textBody: truncateCodePoints(draftText.trim(), 6000), consentConfirmed, autoTriggered: false },
    allowLocalLoopback,
  );
}
