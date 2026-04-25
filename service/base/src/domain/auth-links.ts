import type {
  ActionLinkCandidate,
  ActionLinkSource,
} from "./models.js";

export interface ExtractAuthenticationLinkContentInput {
  sender?: string;
  subject?: string;
  htmlBody?: string;
  textBody?: string;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, digits) => String.fromCharCode(Number.parseInt(digits, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, digits) => String.fromCharCode(Number.parseInt(digits, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&#x27;/gi, "'");
}

function normalizeReadableText(value: string | undefined): string {
  const normalized = String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u2000-\u200F\u2060\uFEFF\u00AD]/g, "")
    .replace(/\r\n?/g, "\n");

  if (!normalized.trim()) {
    return "";
  }

  const output: string[] = [];
  let previousBlank = false;
  for (const line of normalized.split("\n")) {
    const compact = line.replace(/\s+/g, " ").trim();
    if (!compact) {
      if (output.length > 0 && !previousBlank) {
        output.push("");
      }
      previousBlank = true;
      continue;
    }
    output.push(compact);
    previousBlank = false;
  }

  return output.join("\n").trim();
}

function htmlToText(value: string | undefined): string {
  const html = String(value ?? "").trim();
  if (!html) {
    return "";
  }

  const markup = html
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ")
    .replace(/<[^>]+data-skip-in-text="true"[^>]*>[\s\S]*?<\/[^>]+>/gi, " ")
    .replace(/<[^>]+style="[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|max-height\s*:\s*0|max-width\s*:\s*0|font-size\s*:\s*0|line-height\s*:\s*0)[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, " ")
    .replace(/<(?:br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|header|footer|li|tr|table|h[1-6]|blockquote|pre)>/gi, "\n");

  const stripped = markup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  return normalizeReadableText(decodeHtmlEntities(stripped));
}

function cleanCandidateUrl(value: string): string {
  return value.trim().replace(/^[<(]+/, "").replace(/[>)\].,;!?]+$/, "");
}

function sanitizeActionUrl(value: string): string {
  const decoded = decodeHtmlEntities(String(value ?? ""))
    .replace(/[\u0000-\u001F\s]+/g, "")
    .trim();
  const cleaned = cleanCandidateUrl(decoded);
  if (!cleaned) {
    return "";
  }

  try {
    const parsed = new URL(cleaned, "https://easyemail.local");
    return /^(https?:)$/i.test(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function summarizeActionLabel(url: string, label: string | undefined): string | undefined {
  const normalized = normalizeReadableText(decodeHtmlEntities(label ?? ""));
  if (normalized && normalized.length <= 96 && !/^https?:\/\//i.test(normalized)) {
    return normalized;
  }

  try {
    const parsed = new URL(url);
    const tail = `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`.replace(/\/$/, "");
    return tail || undefined;
  } catch {
    return undefined;
  }
}

const ACTION_LINK_RE = /(?:verify|verification|activate|activation|confirm|complete|continue|action-code|magic|sign[\s-]*in|login|reset|approve|unlock|join|access|auth|authenticate)/i;
const NOISY_LINK_RE = /(?:twitter\.com|linkedin\.com|youtube\.com|instagram\.com|unsubscribe|public\/images|logo-primary|email\.[^/]+\/o\/|pixel|tracking)/i;

function linkPriority(link: ActionLinkCandidate): number {
  const haystack = `${link.url}\n${link.label ?? ""}`;
  let score = 0;
  if (ACTION_LINK_RE.test(haystack)) score += 60;
  if (/\/action-code\b/i.test(link.url)) score += 120;
  if (/[?&](?:oobcode|token|verify|activation|confirmation|auth|code)=/i.test(link.url)) score += 45;
  if (NOISY_LINK_RE.test(link.url)) score -= 120;
  if (/https?:\/\/[^/]+\/?$/i.test(link.url)) score -= 60;
  if (link.label && link.label !== link.url) score += 4;
  if (link.source === "html") score += 6;
  if (link.source === "text") score += 2;
  return score;
}

function extractTextUrls(value: string | undefined, source: ActionLinkSource): ActionLinkCandidate[] {
  const text = String(value ?? "");
  if (!text) {
    return [];
  }

  const links: ActionLinkCandidate[] = [];
  for (const pattern of [/\bhttps?:\/\/[^\s<>"']+/gi]) {
    for (const match of text.matchAll(pattern)) {
      const url = sanitizeActionUrl(match[0]);
      if (!url) continue;
      links.push({
        url,
        label: summarizeActionLabel(url, source === "text" ? url : undefined),
        source,
      });
    }
  }

  return links;
}

function extractLinksFromHtml(value: string | undefined): ActionLinkCandidate[] {
  const html = String(value ?? "");
  if (!html.trim()) {
    return [];
  }

  const links: ActionLinkCandidate[] = [];
  for (const match of html.matchAll(/<a\b[^>]*href=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = sanitizeActionUrl(match[1] ?? match[2] ?? match[3] ?? "");
    if (!url) continue;
    links.push({
      url,
      label: summarizeActionLabel(url, htmlToText(match[4] ?? "")),
      source: "html",
    });
  }
  return links;
}

export function extractAuthenticationLinksFromContent(
  input: ExtractAuthenticationLinkContentInput,
): ActionLinkCandidate[] {
  const all = [
    ...extractLinksFromHtml(input.htmlBody),
    ...extractTextUrls(input.textBody, "text"),
    ...extractTextUrls(input.subject, "subject"),
  ];

  const deduped = new Map<string, ActionLinkCandidate>();
  for (const link of all) {
    if (!link.url) continue;
    const existing = deduped.get(link.url);
    if (!existing || linkPriority(link) > linkPriority(existing)) {
      deduped.set(link.url, link);
    }
  }

  return [...deduped.values()]
    .filter((link) => linkPriority(link) > -40)
    .sort((left, right) => linkPriority(right) - linkPriority(left) || left.url.length - right.url.length)
    .slice(0, 8);
}

export function extractPrimaryAuthenticationLink(
  input: ExtractAuthenticationLinkContentInput,
): ActionLinkCandidate | undefined {
  return extractAuthenticationLinksFromContent(input)[0];
}
