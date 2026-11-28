export type MailSecurityLevel = "safe" | "warning" | "danger";
export type MailAuthVerdict = "pass" | "fail" | "softfail" | "neutral" | "none";

export interface MailSecurityEvaluationInput {
  senderHeader?: string;
  senderName?: string;
  senderAddress?: string;
  replyToAddresses?: readonly string[];
  authenticationResultsHeader?: string;
  rawHeaders?: ReadonlyArray<{ key: string; value: string }> | string;
  htmlBody?: string;
  attachmentFilenames?: readonly string[];
}

export interface MailSecurityEvaluationResult {
  level: MailSecurityLevel;
  title: string;
  reasons: string[];
  spf: MailAuthVerdict;
  dkim: MailAuthVerdict;
  dmarc: MailAuthVerdict;
}

export interface ExternalLinkSafetyCheck {
  safeHref: string | null;
  scheme: "https" | "http" | "mailto" | "blocked";
  hostname: string;
  registrableDomain: string;
  isPunycode: boolean;
  isTrusted: boolean;
  requiresConfirmation: boolean;
}

const ANCHOR_PAIR_RE = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const EMAIL_IN_TEXT_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/;
const STRIP_TAGS_RE = /<[^>]+>/g;
const MULTI_PART_PUBLIC_SUFFIXES = new Set([
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "co.uk", "org.uk", "co.jp", "ne.jp", "co.kr", "com.hk", "com.tw", "com.au",
]);
const HIGH_RISK_ATTACHMENT_EXTS = new Set([
  "exe", "scr", "bat", "cmd", "vbs", "vbe", "js", "jse", "wsf", "msi", "msp", "com", "pif", "lnk", "iso", "img", "hta", "ps1",
]);

function extractEmailDomain(rawEmail: string | undefined): string {
  if (!rawEmail) return "";
  const cleaned = rawEmail.trim();
  const angle = /<\s*[^<>@\s]+@([^<>@\s]+)\s*>/.exec(cleaned);
  if (angle?.[1]) return angle[1].toLowerCase().replace(/\.+$/, "");
  const at = cleaned.lastIndexOf("@");
  if (at < 0) return "";
  return cleaned.slice(at + 1).toLowerCase().replace(/[>\s.]+$/g, "");
}

function parseSenderNameAndAddress(senderHeader?: string, senderName?: string, senderAddress?: string): { name: string; address: string } {
  if (senderAddress) {
    return { name: senderName ?? "", address: senderAddress };
  }
  const raw = (senderHeader ?? "").trim();
  const match = /^(.*?)<\s*([^<>@\s]+@[^<>@\s]+)\s*>$/.exec(raw);
  if (match) {
    return {
      name: senderName ?? match[1]!.trim().replace(/^["']+|["']+$/g, ""),
      address: match[2]!.trim(),
    };
  }
  return { name: senderName ?? "", address: raw };
}

export function getRegistrableDomain(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/\.+$/, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return host;
  const lastTwo = `${labels[labels.length - 2]}.${labels[labels.length - 1]}`;
  if (MULTI_PART_PUBLIC_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return `${labels[labels.length - 3]}.${lastTwo}`;
  }
  return lastTwo;
}

function sameRegistrableMailDomain(left: string, right: string): boolean {
  if (!left || !right) return false;
  return getRegistrableDomain(left) === getRegistrableDomain(right);
}

function normalizeVerdict(token: string | undefined): MailAuthVerdict {
  const low = (token ?? "").toLowerCase();
  if (low === "pass") return "pass";
  if (low === "fail" || low === "permerror" || low === "temperror") return "fail";
  if (low === "softfail") return "softfail";
  if (low === "neutral" || low === "policy") return "neutral";
  return "none";
}

export function parseMailAuthenticationResults(
  authHeader?: string,
  rawHeaders?: ReadonlyArray<{ key: string; value: string }> | string,
): { spf: MailAuthVerdict; dkim: MailAuthVerdict; dmarc: MailAuthVerdict } {
  const segments: string[] = [];
  if (authHeader?.trim()) segments.push(authHeader);
  if (typeof rawHeaders === "string") {
    for (const m of rawHeaders.matchAll(/^authentication-results\s*:\s*(.+(?:\r?\n[ \t]+.+)*)/gim)) {
      if (m[1]) segments.push(m[1]);
    }
  } else if (Array.isArray(rawHeaders)) {
    for (const hdr of rawHeaders) {
      if (hdr.key.toLowerCase() === "authentication-results" && hdr.value) segments.push(hdr.value);
    }
  }
  const combined = segments.join(" ; ");
  if (!combined) return { spf: "none", dkim: "none", dmarc: "none" };
  const spf = normalizeVerdict(/\bspf\s*=\s*([a-z]+)/i.exec(combined)?.[1]);
  const dkim = normalizeVerdict(/\bdkim\s*=\s*([a-z]+)/i.exec(combined)?.[1]);
  const dmarc = normalizeVerdict(/\bdmarc\s*=\s*([a-z]+)/i.exec(combined)?.[1]);
  return { spf, dkim, dmarc };
}

function extractUrlDomain(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return "";
  }
}

export function evaluateMailPhishingSecurity(input: MailSecurityEvaluationInput): MailSecurityEvaluationResult {
  const { spf, dkim, dmarc } = parseMailAuthenticationResults(input.authenticationResultsHeader, input.rawHeaders);
  const sender = parseSenderNameAndAddress(input.senderHeader, input.senderName, input.senderAddress);
  const fromDomain = extractEmailDomain(sender.address);
  const reasons: string[] = [];
  const state: { level: MailSecurityLevel } = { level: "safe" };

  const elevate = (next: "warning" | "danger", reason: string) => {
    reasons.push(reason);
    if (next === "danger" || state.level === "safe") state.level = next;
  };

  // 1. DMARC-aligned authentication evaluation (avoids false positives on forwarded mail when dmarc=pass & dkim=pass).
  if (dmarc === "fail" || (spf === "fail" && dkim === "fail")) {
    elevate("danger", "发件域身份认证未通过（DMARC 或 SPF+DKIM 校验失败），极可能为伪造发件人");
  } else if (dmarc !== "pass" && (spf === "fail" || spf === "softfail" || dkim === "fail")) {
    elevate("warning", "部分发件服务器签名未通过校验，请核实发件人真实身份");
  }

  // 2. Display-Name Email Domain Spoofing.
  if (fromDomain.includes(".")) {
    const spoofMatch = EMAIL_IN_TEXT_RE.exec(sender.name);
    if (spoofMatch?.[1]) {
      const displayDomain = spoofMatch[1].toLowerCase().replace(/\.+$/, "");
      if (displayDomain.includes(".") && !sameRegistrableMailDomain(displayDomain, fromDomain)) {
        elevate("danger", `发件人显示名称伪装为其他域名（${displayDomain}），与真实发件域（${fromDomain}）不一致`);
      }
    }
  }

  // 3. Punycode IDN homograph attack.
  if (fromDomain.includes("xn--") || /:\/\/[^/\s]*xn--/i.test(input.htmlBody ?? "")) {
    elevate("danger", "检测到 Punycode (xn--) 国际化同形异义混淆域名，警惕高仿钓鱼站点");
  }

  // 4. Cross-domain Reply-To hijack without valid DKIM signature.
  for (const rt of input.replyToAddresses ?? []) {
    const rtDomain = extractEmailDomain(rt);
    if (rtDomain.includes(".") && fromDomain.includes(".") && !sameRegistrableMailDomain(rtDomain, fromDomain) && dkim !== "pass") {
      elevate("warning", `回复地址域名（${rtDomain}）与发件人域名（${fromDomain}）不一致`);
      break;
    }
  }

  // 5. Anchor text URL vs actual href registrable domain mismatch.
  if (input.htmlBody) {
    let checked = 0;
    for (const pair of input.htmlBody.matchAll(ANCHOR_PAIR_RE)) {
      if (checked >= 30) break;
      checked += 1;
      const hrefDomain = extractUrlDomain(pair[1] ?? "");
      const visibleText = (pair[2] ?? "").replace(STRIP_TAGS_RE, "").trim();
      if (/^https?:\/\//i.test(visibleText)) {
        const visibleDomain = extractUrlDomain(visibleText);
        if (hrefDomain && visibleDomain && !sameRegistrableMailDomain(hrefDomain, visibleDomain)) {
          elevate("danger", `正文链接文字显示为 ${visibleDomain}，实际跳转至不同域名 ${hrefDomain}`);
          break;
        }
      }
    }
  }

  // 6. High-risk executable or double-extension spoofed attachments.
  for (const rawName of input.attachmentFilenames ?? []) {
    const fileName = rawName.trim().toLowerCase();
    const parts = fileName.split(".").filter(Boolean);
    if (parts.length >= 2) {
      const ext = parts[parts.length - 1]!;
      if (HIGH_RISK_ATTACHMENT_EXTS.has(ext)) {
        if (parts.length >= 3) {
          elevate("danger", `检测到双扩展名伪装高危附件（${rawName.trim()}），切勿下载运行`);
        } else {
          elevate("danger", `包含可执行或脚本类高危附件（.${ext}），请谨慎处理`);
        }
        break;
      }
    }
  }

  const level = state.level;
  const title = level === "danger"
    ? "高危钓鱼或伪造身份风险预警"
    : level === "warning"
      ? "发件身份或链接存在异常，请注意核实"
      : "未发现明显钓鱼伪装特征";

  return { level, title, reasons, spf, dkim, dmarc };
}

export function inspectExternalLinkSafety(
  rawHref: string,
  trustedDomains: readonly string[] = [],
): ExternalLinkSafetyCheck {
  const trimmed = rawHref.trim();
  if (/^mailto:[^\s<>"{}|\\^`]+$/i.test(trimmed)) {
    return {
      safeHref: trimmed, scheme: "mailto", hostname: "", registrableDomain: "",
      isPunycode: false, isTrusted: true, requiresConfirmation: false,
    };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return {
        safeHref: null, scheme: "blocked", hostname: "", registrableDomain: "",
        isPunycode: false, isTrusted: false, requiresConfirmation: true,
      };
    }
    const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    const registrableDomain = getRegistrableDomain(hostname);
    const isPunycode = hostname.includes("xn--");
    const trustedSet = new Set(trustedDomains.map((d) => d.trim().toLowerCase().replace(/\.+$/, "")).filter(Boolean));
    const isTrusted = !isPunycode && parsed.protocol === "https:"
      && (trustedSet.has(hostname) || trustedSet.has(registrableDomain));
    return {
      safeHref: parsed.href,
      scheme: parsed.protocol === "https:" ? "https" : "http",
      hostname,
      registrableDomain,
      isPunycode,
      isTrusted,
      requiresConfirmation: !isTrusted,
    };
  } catch {
    return {
      safeHref: null, scheme: "blocked", hostname: "", registrableDomain: "",
      isPunycode: false, isTrusted: false, requiresConfirmation: true,
    };
  }
}
