import { mailAddress } from "./mail-address";

// Pure Web-API policy shared by server parsing and the explicit browser link surface.
export function safeUnsubscribeUrl(value: string): string | null {
  if (!value || value.length > 2048 || /[\s\p{Cc}\p{Cf}<>]/u.test(value)) return null;
  try {
    if (/[\p{Cc}\p{Cf}]/u.test(decodeURIComponent(value))) return null;
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol)) return url.hostname && !url.username && !url.password ? url.href : null;
    if (url.protocol !== "mailto:" || !mailAddress(decodeURIComponent(url.pathname)) || url.hash) return null;
    if ([...url.searchParams.keys()].some(key => !["subject", "body"].includes(key.toLowerCase()))) return null;
    return url.href;
  } catch { return null; }
}

export function unsubscribeMethods(value: string) {
  const candidates = [...value.matchAll(/<([^<>]*)>/g)].map(match => match[1].trim()), methods: string[] = [];
  let limited = !!value.replace(/<[^<>]*>/g, "").replace(/[,\s]/g, "");
  for (const candidate of candidates) {
    const url = safeUnsubscribeUrl(candidate);
    if (!url) { limited = true; continue; }
    if (!methods.includes(url)) { if (methods.length === 8) limited = true; else methods.push(url); }
  }
  return { methods, limited };
}
