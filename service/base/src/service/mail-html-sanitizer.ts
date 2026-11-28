import { sanitizeSafeMailHtml, type SanitizeSafeMailHtmlOptions } from "../domain/mail-safe-html-engine.js";

export function sanitizeMailHtml(
  rawHtml: string | undefined | null,
  options: SanitizeSafeMailHtmlOptions = {},
): string | undefined {
  if (typeof rawHtml !== "string") {
    return undefined;
  }
  const trimmed = rawHtml.trim();
  if (!trimmed) {
    return undefined;
  }
  const result = sanitizeSafeMailHtml(trimmed, {
    allowRemoteImages: options.allowRemoteImages ?? false,
    ...(options.cidUrlMap ? { cidUrlMap: options.cidUrlMap } : {}),
  });
  const combined = result.css ? `<style>${result.css}</style>${result.html}` : result.html;
  return combined.trim() || undefined;
}

export function extractSnippetFromBodies(
  bodyText: string | undefined,
  bodyHtml: string | undefined,
  fallbackSubject: string,
  maxChars = 180,
): string {
  const plainCandidate = bodyText?.trim()
    || (bodyHtml
      ? bodyHtml
          .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
          .replace(/<[^>]+>/g, " ")
      : "")
    || fallbackSubject;
  const collapsed = plainCandidate.replace(/\s+/g, " ").trim();
  return Array.from(collapsed).slice(0, maxChars).join("");
}
