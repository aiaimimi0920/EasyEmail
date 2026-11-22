import type {
  MailAvatarAuthSignal,
  MailAvatarCachedRecord,
  MailAvatarSenderAuth,
  MailAvatarSettings,
} from "../domain/mail-avatar.js";
import { createDefaultSenderAuth } from "../persistence/relational/mail-avatar-repository.js";
import {
  isPublicDnsName,
  isSafeAvatarHttpsUrl,
  MAX_BIMI_AVATAR_BYTES,
  MAX_FAVICON_AVATAR_BYTES,
  normalizeAvatarImageMime,
  validateSafeSvgBytes,
  type AvatarRemoteFetcher,
} from "./avatar-network.js";

const OFFICIAL_PROVIDER_ICONS: Readonly<Record<string, readonly string[]>> = {
  "qq-mail": [
    "https://res.wx.qq.com/t/webmail/webmail/res/static/images/base/style/favicon/qqmail_favicon_96h.8d124a7.png",
    "https://res.wx.qq.com/t/webmail/webmail/res/static/images/base/style/favicon/qqmail_favicon_48h.4e79647.png",
    "https://res.wx.qq.com/t/webmail/webmail/res/static/images/base/style/favicon/qqmail_favicon_32h.65f829f.png",
    "https://res.wx.qq.com/t/webmail/webmail/res/static/images/base/style/favicon/qqmail_favicon_16h.bc34dcb.png",
    "https://mail.qq.com/favicon.ico",
  ],
  openai: [
    "https://images.ctfassets.net/kftzwdyauwt9/3hUGLn3ypllZ0oa01qOYVq/28e8188e6f11b84c3e876569d492734f/Blossom_Light.svg?q=90&w=3840",
    "https://images.ctfassets.net/kftzwdyauwt9/2fkAIT3PbTRytKTBx9cx8o/229bc28cb338565fe735d8935abc801f/OpenAI_Wordmark_Gif.gif?fm=png&q=90&w=512",
  ],
  github: [
    "https://github.githubassets.com/favicons/favicon.svg",
    "https://github.githubassets.com/favicons/favicon.png",
    "https://github.com/fluidicon.png",
  ],
  google: ["https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico"],
  "railway-12306": ["https://www.12306.cn/index/images/favicon.ico"],
};

export interface NormalizedSenderIdentity {
  raw: string;
  normalizedSender: string;
  displayName: string;
  domain: string;
  cacheKey: string;
  fallbackText: string;
  builtinKind?: string;
}

interface ParsedBimiRecord {
  logoUrl?: string;
  certificateUrl?: string;
}

function extractEmailFromSender(value: string): string {
  const trimmed = value.trim();
  const lt = trimmed.indexOf("<");
  if (lt >= 0) {
    const rest = trimmed.slice(lt + 1);
    const gt = rest.indexOf(">");
    return (gt >= 0 ? rest.slice(0, gt) : rest).trim();
  }
  return trimmed;
}

function extractDisplayNameFromSender(value: string): string {
  const trimmed = value.trim();
  const lt = trimmed.indexOf("<");
  if (lt >= 0) {
    const rawName = trimmed.slice(0, lt).trim().replace(/^"+|"+$/gu, "").trim();
    if (rawName) return rawName;
  }
  return extractEmailFromSender(trimmed).split("@")[0] || "Unknown sender";
}

function computeFallbackText(displayName: string, email: string, domain: string): string {
  const nameToken = displayName.replace(/[^A-Za-z0-9]/gu, "").slice(0, 4).toUpperCase();
  if (nameToken) return nameToken;
  const fallbackSource = domain.split(".")[0] || email.split("@")[0] || "MAIL";
  return fallbackSource.replace(/[^A-Za-z0-9]/gu, "").slice(0, 4).toUpperCase() || "MAIL";
}

function resolveBuiltinKind(displayName: string, email: string, domain: string): string | undefined {
  const lowerName = displayName.toLowerCase();
  if (domain === "qq.com" || email === "10000@qq.com" || lowerName.includes("qq邮箱")) {
    return "qq-mail";
  }
  if (
    domain === "openai.com"
    || domain.endsWith(".openai.com")
    || lowerName.includes("openai")
    || lowerName.includes("chatgpt")
  ) {
    return "openai";
  }
  if (email.startsWith("12306@") || domain === "rails.com.cn" || lowerName.includes("12306")) {
    return "railway-12306";
  }
  if (domain.includes("github") || lowerName.includes("github")) {
    return "github";
  }
  if (domain.includes("google") || domain.includes("gmail") || lowerName.includes("google")) {
    return "google";
  }
  return undefined;
}

export function normalizeSenderIdentityForAvatar(rawSender: string): NormalizedSenderIdentity {
  const raw = rawSender.trim();
  const displayName = extractDisplayNameFromSender(raw);
  const normalizedSender = extractEmailFromSender(raw).toLowerCase();
  const atIdx = normalizedSender.indexOf("@");
  const domain = atIdx >= 0
    ? normalizedSender.slice(atIdx + 1).trim().replace(/>+$/gu, "").toLowerCase()
    : "";
  const fallbackText = computeFallbackText(displayName, normalizedSender, domain);
  const builtinKind = resolveBuiltinKind(displayName, normalizedSender, domain);
  const cacheKey = normalizedSender && normalizedSender.includes("@")
    ? `sender:${normalizedSender}`
    : `domain:${domain}`;
  return {
    raw,
    normalizedSender,
    displayName,
    domain,
    cacheKey,
    fallbackText,
    ...(builtinKind ? { builtinKind } : {}),
  };
}

export function domainCandidates(rawDomain: string): string[] {
  const domain = rawDomain.trim().replace(/\.+$/gu, "").toLowerCase();
  if (!domain) return [];
  const result = [domain];
  const parts = domain.split(".");
  if (parts.length > 2) {
    const tail2 = parts.slice(-2).join(".");
    const registered = parts.length > 3 && ["com.cn", "net.cn", "org.cn", "gov.cn"].includes(tail2)
      ? parts.slice(-3).join(".")
      : tail2;
    if (registered !== domain) {
      result.push(registered);
    }
  }
  return result;
}

export function officialUrlsForIdentity(identity: NormalizedSenderIdentity): readonly string[] {
  if (identity.builtinKind && OFFICIAL_PROVIDER_ICONS[identity.builtinKind]) {
    return OFFICIAL_PROVIDER_ICONS[identity.builtinKind]!;
  }
  if (identity.domain === "qq.com") {
    return OFFICIAL_PROVIDER_ICONS["qq-mail"]!;
  }
  return [];
}

function candidateAvatarUrls(identity: NormalizedSenderIdentity): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const url of officialUrlsForIdentity(identity)) {
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  for (const candidate of domainCandidates(identity.domain)) {
    for (const url of [`https://${candidate}/favicon.ico`, `https://${candidate}/apple-touch-icon.png`]) {
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
  }
  return urls;
}

function parseBimiTxtRecord(record: string): ParsedBimiRecord | undefined {
  let hasVersion = false;
  let logoUrl: string | undefined;
  let certificateUrl: string | undefined;
  for (const part of record.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const val = trimmed.slice(eq + 1).trim();
    if (key === "v") hasVersion = val.toUpperCase() === "BIMI1";
    else if (key === "l" && val) logoUrl = val;
    else if (key === "a" && val) certificateUrl = val;
  }
  return hasVersion ? { logoUrl, certificateUrl } : undefined;
}

export function cachedAvatarSatisfiesPolicy(
  identity: NormalizedSenderIdentity,
  cached: MailAvatarCachedRecord,
  settings: MailAvatarSettings,
): boolean {
  const official = officialUrlsForIdentity(identity);
  if (!settings.remoteEnabled || !settings.faviconEnabled || official.length === 0) {
    return true;
  }
  if (cached.status === "failed") {
    return true;
  }
  return cached.sourceKind === "bimi" || Boolean(cached.remoteUrl && official.includes(cached.remoteUrl));
}

async function downloadValidatedImage(
  remoteFetcher: AvatarRemoteFetcher,
  url: string,
  maxBytes: number,
): Promise<{ mime: string; bytes: Uint8Array; finalUrl: string }> {
  const downloaded = await remoteFetcher.downloadLimited(url, maxBytes);
  const normalizedMime = normalizeAvatarImageMime(
    downloaded.mime,
    new URL(downloaded.finalUrl).pathname,
  );
  if (normalizedMime === "image/svg+xml") {
    validateSafeSvgBytes(downloaded.bytes);
  }
  return { mime: normalizedMime, bytes: downloaded.bytes, finalUrl: downloaded.finalUrl };
}

export async function resolveDomainAuthSignals(
  remoteFetcher: AvatarRemoteFetcher,
  domain: string,
): Promise<MailAvatarSenderAuth> {
  const auth = createDefaultSenderAuth();
  if (!isPublicDnsName(domain)) {
    return auth;
  }
  const candidates = domainCandidates(domain);
  let spfPublished = false;
  let dmarcPublished = false;
  for (const candidate of candidates) {
    try {
      const txt = await remoteFetcher.lookupDnsTxtRecords(candidate);
      if (txt.some((r) => r.toLowerCase().startsWith("v=spf1"))) {
        spfPublished = true;
        break;
      }
    } catch {
      // Ignore DNS failure.
    }
  }
  for (const candidate of candidates) {
    try {
      const txt = await remoteFetcher.lookupDnsTxtRecords(`_dmarc.${candidate}`);
      if (txt.some((r) => r.toLowerCase().startsWith("v=dmarc1"))) {
        dmarcPublished = true;
        break;
      }
    } catch {
      // Ignore DNS failure.
    }
  }
  auth.spf = spfPublished
    ? { status: "published", detail: "SPF policy is published for sender domain" }
    : { status: "missing", detail: "No SPF policy was found for sender domain" };
  auth.dmarc = dmarcPublished
    ? { status: "published", detail: "DMARC policy is published for sender domain" }
    : { status: "missing", detail: "No DMARC policy was found for sender domain" };
  return auth;
}

async function verifyBimiCertificateSignal(
  remoteFetcher: AvatarRemoteFetcher,
  certUrl?: string,
): Promise<MailAvatarAuthSignal> {
  if (!certUrl) {
    return { status: "missing", detail: "BIMI record has no certificate URL" };
  }
  if (!isSafeAvatarHttpsUrl(certUrl)) {
    return { status: "fail", detail: "BIMI certificate URL is not a safe HTTPS URL" };
  }
  try {
    const downloaded = await remoteFetcher.downloadLimited(certUrl, 256 * 1024);
    if (downloaded.bytes.byteLength === 0) {
      return { status: "fail", detail: "BIMI certificate evidence was empty" };
    }
    return {
      status: "published",
      detail: `BIMI certificate evidence fetched with TLS (${downloaded.mime}, ${downloaded.bytes.byteLength} bytes)`,
    };
  } catch (error) {
    return {
      status: "fail",
      detail: `BIMI certificate evidence fetch failed: ${error instanceof Error ? error.message : "unknown"}`,
    };
  }
}

export async function fetchRemoteSenderAvatarWithPolicy(
  remoteFetcher: AvatarRemoteFetcher,
  identity: NormalizedSenderIdentity,
  settings: MailAvatarSettings,
): Promise<{
  sourceKind: string;
  imageMime: string;
  imageBytes: Uint8Array;
  remoteUrl: string;
  auth: MailAvatarSenderAuth;
}> {
  if (!isPublicDnsName(identity.domain)) {
    throw new Error("Sender domain is not eligible for remote avatar fetch.");
  }
  const baseAuth = settings.authEnabled
    ? await resolveDomainAuthSignals(remoteFetcher, identity.domain)
    : createDefaultSenderAuth();

  if (settings.bimiEnabled) {
    for (const candidate of domainCandidates(identity.domain)) {
      const recordName = `default._bimi.${candidate}`;
      try {
        const txtRecords = await remoteFetcher.lookupDnsTxtRecords(recordName);
        for (const txt of txtRecords) {
          const parsed = parseBimiTxtRecord(txt);
          if (parsed?.logoUrl && isSafeAvatarHttpsUrl(parsed.logoUrl)) {
            const downloaded = await downloadValidatedImage(
              remoteFetcher,
              parsed.logoUrl,
              MAX_BIMI_AVATAR_BYTES,
            );
            const certificate = await verifyBimiCertificateSignal(
              remoteFetcher,
              parsed.certificateUrl,
            );
            return {
              sourceKind: "bimi",
              imageMime: downloaded.mime,
              imageBytes: downloaded.bytes,
              remoteUrl: downloaded.finalUrl,
              auth: {
                ...baseAuth,
                bimi: { status: "pass", detail: `BIMI record found at ${recordName}` },
                certificate,
              },
            };
          }
        }
      } catch {
        // Fall through to next BIMI candidate or favicon.
      }
    }
  }

  if (settings.faviconEnabled) {
    const official = officialUrlsForIdentity(identity);
    for (const url of candidateAvatarUrls(identity)) {
      try {
        const downloaded = await downloadValidatedImage(
          remoteFetcher,
          url,
          MAX_FAVICON_AVATAR_BYTES,
        );
        return {
          sourceKind: official.includes(url) ? "official-icon" : "favicon",
          imageMime: downloaded.mime,
          imageBytes: downloaded.bytes,
          remoteUrl: downloaded.finalUrl,
          auth: baseAuth,
        };
      } catch {
        // Try next candidate URL.
      }
    }
  }

  throw new Error("No safe BIMI or favicon avatar was available.");
}
