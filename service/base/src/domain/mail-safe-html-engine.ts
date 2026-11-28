import {
  buildReaderBaseThemeCss,
  sanitizeInlineStyleDeclarations,
  sanitizeMailStylesheet,
  type MailReaderThemeMode,
} from "./mail-safe-css-engine.js";

export interface SanitizeSafeMailHtmlOptions {
  cidUrlMap?: Readonly<Record<string, string>>;
  allowRemoteImages?: boolean;
}

export interface SanitizeSafeMailHtmlResult {
  html: string;
  css: string;
  hasRemoteImages: boolean;
  remoteImageCount: number;
  trackingPixelCount: number;
  referencedCids: string[];
}

const MAX_INLINE_RASTER_DATA_BYTES = 2 * 1024 * 1024;
const FORBIDDEN_CONTAINER_RE = /<\s*(script|iframe|frame|frameset|object|embed|applet|form|svg|math|template|noscript|title|head)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const FORBIDDEN_VOID_TAG_RE = /<\s*\/?\s*(script|iframe|frame|frameset|object|embed|applet|base|meta|link|form|input|button|textarea|select|svg|math|template)\b[^>]*>/gi;
const MSO_OR_HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const STYLE_BLOCK_RE = /<\s*style\b[^>]*>([\s\S]*?)<\s*\/\s*style\s*>/gi;
const SAFE_DATA_IMAGE_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=\r\n\s]+)$/i;

const ALLOWED_TAGS = new Set([
  "a", "abbr", "address", "article", "aside", "b", "blockquote", "br", "caption", "center",
  "cite", "code", "col", "colgroup", "dd", "del", "div", "dl", "dt", "em", "figcaption", "figure",
  "font", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "kbd",
  "li", "main", "mark", "ol", "p", "pre", "q", "s", "samp", "section", "small", "span", "strong",
  "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul",
]);

const GLOBAL_ATTRS = new Set(["class", "id", "style", "align", "valign", "width", "height", "bgcolor", "dir", "lang", "title"]);
const TABLE_ATTRS = new Set(["border", "cellpadding", "cellspacing", "colspan", "rowspan", "scope", "headers"]);
const SAFE_TOKEN_RE = /^[A-Za-z0-9_\-\s]{1,128}$/;
const TRACKING_URL_HINT_RE = /(?:\/pixel\b|\/open\b|\/track(?:ing|er)?\b|utm_medium=email.*1x1|wf\/open|mailstat|beacon)/i;

export function normalizeMailContentId(rawCid: string): string {
  let cleaned = rawCid.trim();
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    // Keep literal string when percent sequence is not encoded URI text.
  }
  return cleaned.replace(/^cid:/i, "").replace(/^[<\s]+|[>\s]+$/g, "").toLowerCase();
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeSafeHttpOrMailHref(rawHref: string): string | undefined {
  const trimmed = rawHref.replace(/[\u0000-\u0020]+/g, "").trim();
  if (!trimmed) return undefined;
  if (/^mailto:[^\s<>"{}|\\^`]+$/i.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function normalizeSafeRasterDataUri(rawSrc: string): string | undefined {
  const match = SAFE_DATA_IMAGE_RE.exec(rawSrc.trim());
  if (!match?.[1] || !match[2]) return undefined;
  const subtype = match[1].toLowerCase() === "jpg" ? "jpeg" : match[1].toLowerCase();
  const compact = match[2].replace(/\s+/g, "");
  if (!compact) return undefined;
  const estimatedBytes = Math.floor((compact.length * 3) / 4);
  if (estimatedBytes <= 0 || estimatedBytes > MAX_INLINE_RASTER_DATA_BYTES) return undefined;
  return `data:image/${subtype};base64,${compact}`;
}

function parseTagAttributes(rawAttrs: string): Array<{ name: string; value: string }> {
  const attrs: Array<{ name: string; value: string }> = [];
  const attrRe = /([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of rawAttrs.matchAll(attrRe)) {
    const name = (match[1] ?? "").toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (name) attrs.push({ name, value });
  }
  return attrs;
}

function isLikelyTrackingPixel(attrs: ReadonlyArray<{ name: string; value: string }>, src: string): boolean {
  const map = new Map(attrs.map((a) => [a.name, a.value.trim().toLowerCase()]));
  const w = map.get("width") ?? "";
  const h = map.get("height") ?? "";
  const style = map.get("style") ?? "";
  if ((w === "0" || w === "1" || w === "1px") && (h === "0" || h === "1" || h === "1px")) return true;
  if (/(?:width\s*:\s*[01](?:px)?\b[\s\S]*height\s*:\s*[01](?:px)?\b|display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style)) {
    return true;
  }
  return TRACKING_URL_HINT_RE.test(src);
}

export function sanitizeSafeMailHtml(
  rawHtml: string,
  options: SanitizeSafeMailHtmlOptions = {},
): SanitizeSafeMailHtmlResult {
  if (!rawHtml.trim()) {
    return { html: "", css: "", hasRemoteImages: false, remoteImageCount: 0, trackingPixelCount: 0, referencedCids: [] };
  }

  const normalizedCidMap = new Map<string, string>();
  if (options.cidUrlMap) {
    for (const [key, url] of Object.entries(options.cidUrlMap)) {
      const cid = normalizeMailContentId(key);
      if (cid && url) normalizedCidMap.set(cid, url);
    }
  }
  const allowRemote = options.allowRemoteImages === true;
  const styleChunks: string[] = [];
  let hasRemoteImages = false;
  let remoteImageCount = 0;
  let trackingPixelCount = 0;
  const referencedCids = new Set<string>();

  let working = rawHtml
    .replace(/\u0000/g, "")
    .replace(FORBIDDEN_CONTAINER_RE, "");

  working = working.replace(STYLE_BLOCK_RE, (_full, cssText: string) => {
    const sanitizedCss = sanitizeMailStylesheet(cssText ?? "", allowRemote);
    if (sanitizedCss.hadRemoteUrl) {
      hasRemoteImages = true;
      remoteImageCount += 1;
    }
    if (sanitizedCss.css) styleChunks.push(sanitizedCss.css);
    return "";
  });

  working = working
    .replace(MSO_OR_HTML_COMMENT_RE, "")
    .replace(FORBIDDEN_VOID_TAG_RE, "");

  const sanitizedHtml = working.replace(/<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)((?:[^>"']|"(?:[^">]|>(?=[^<"]*"))*"|'(?:[^'>]|>(?=[^<']*'))*')*(?:["'][^>]*)?)>/g, (_full, slash: string, rawTag: string, rawAttrs: string) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return "";
    if (slash) {
      return tag === "br" || tag === "hr" || tag === "img" ? "" : `</${tag}>`;
    }

    const parsedAttrs = parseTagAttributes(rawAttrs);
    const outAttrs: string[] = [];
    let stashedBgUrl: string | undefined;
    let hasEmittedSrc = false;
    let hasEmittedRemoteSrc = false;
    let hasEmittedBg = false;
    let hasEmittedRemoteBg = false;
    let hasEmittedTrackingBlocked = false;
    let hasEmittedCid = false;
    let hasEmittedCidMissing = false;

    for (const attr of parsedAttrs) {
      if (attr.name.startsWith("on")) continue;

      if (attr.name === "style") {
        const styleRes = sanitizeInlineStyleDeclarations(attr.value, allowRemote);
        if (styleRes.hadRemoteUrl) {
          hasRemoteImages = true;
          remoteImageCount += 1;
        }
        if (styleRes.stashedBgUrl && !stashedBgUrl) stashedBgUrl = styleRes.stashedBgUrl;
        if (styleRes.style) outAttrs.push(`style="${escapeHtmlAttr(styleRes.style)}"`);
        continue;
      }

      if (attr.name === "background") {
        const safeBg = normalizeSafeHttpOrMailHref(attr.value);
        if (safeBg && /^https?:\/\//i.test(safeBg)) {
          hasRemoteImages = true;
          remoteImageCount += 1;
          if (allowRemote && !hasEmittedBg) {
            outAttrs.push(`background="${escapeHtmlAttr(safeBg)}"`);
            hasEmittedBg = true;
          } else if (!allowRemote && !stashedBgUrl) {
            stashedBgUrl = safeBg;
          }
        }
        continue;
      }

      if (attr.name === "data-ee-remote-bg") {
        const safeBg = normalizeSafeHttpOrMailHref(attr.value);
        if (safeBg && /^https?:\/\//i.test(safeBg) && !hasEmittedBg && !hasEmittedRemoteBg) {
          hasRemoteImages = true;
          remoteImageCount += 1;
          if (allowRemote) {
            outAttrs.push(`background="${escapeHtmlAttr(safeBg)}"`);
            hasEmittedBg = true;
          } else {
            stashedBgUrl = safeBg;
            hasEmittedRemoteBg = true;
          }
        }
        continue;
      }

      if (tag === "a" && attr.name === "href") {
        const safeHref = normalizeSafeHttpOrMailHref(attr.value);
        if (safeHref) {
          outAttrs.push(`href="${escapeHtmlAttr(safeHref)}"`);
          outAttrs.push('target="_blank"');
          outAttrs.push('rel="noopener noreferrer"');
        }
        continue;
      }

      if (tag === "img" && attr.name === "src") {
        const srcTrimmed = attr.value.trim();
        if (/^cid:/i.test(srcTrimmed)) {
          const cid = normalizeMailContentId(srcTrimmed);
          if (cid) referencedCids.add(cid);
          const mapped = cid ? normalizedCidMap.get(cid) : undefined;
          if (mapped && !hasEmittedSrc) {
            outAttrs.push(`src="${escapeHtmlAttr(mapped)}"`);
            hasEmittedSrc = true;
            if (!hasEmittedCid) {
              outAttrs.push(`data-ee-cid="${escapeHtmlAttr(cid)}"`);
              hasEmittedCid = true;
            }
          } else if (!hasEmittedCidMissing && !hasEmittedSrc) {
            outAttrs.push('data-ee-cid-missing="1"');
            hasEmittedCidMissing = true;
          }
        } else if (/^data:/i.test(srcTrimmed)) {
          const safeData = normalizeSafeRasterDataUri(srcTrimmed);
          if (safeData && !hasEmittedSrc) {
            outAttrs.push(`src="${safeData}"`);
            hasEmittedSrc = true;
          }
        } else if (/^(?:https?:)?\/\//i.test(srcTrimmed)) {
          const normalizedRemote = srcTrimmed.startsWith("//") ? `https:${srcTrimmed}` : srcTrimmed;
          const safeRemote = normalizeSafeHttpOrMailHref(normalizedRemote);
          if (safeRemote && /^https?:\/\//i.test(safeRemote)) {
            if (isLikelyTrackingPixel(parsedAttrs, safeRemote)) {
              if (!hasEmittedTrackingBlocked) {
                trackingPixelCount += 1;
                outAttrs.push('data-ee-tracking-blocked="1"');
                hasEmittedTrackingBlocked = true;
              }
            } else {
              hasRemoteImages = true;
              remoteImageCount += 1;
              if (allowRemote && !hasEmittedSrc) {
                outAttrs.push(`src="${escapeHtmlAttr(safeRemote)}"`);
                hasEmittedSrc = true;
              } else if (!allowRemote && !hasEmittedRemoteSrc) {
                outAttrs.push(`data-ee-remote-src="${escapeHtmlAttr(safeRemote)}"`);
                hasEmittedRemoteSrc = true;
              }
            }
          }
        }
        continue;
      }

      if (tag === "img" && attr.name === "data-ee-remote-src") {
        const safeRemote = normalizeSafeHttpOrMailHref(attr.value);
        if (safeRemote && /^https?:\/\//i.test(safeRemote) && !hasEmittedSrc && !hasEmittedRemoteSrc && !hasEmittedTrackingBlocked) {
          if (isLikelyTrackingPixel(parsedAttrs, safeRemote)) {
            trackingPixelCount += 1;
            outAttrs.push('data-ee-tracking-blocked="1"');
            hasEmittedTrackingBlocked = true;
          } else {
            hasRemoteImages = true;
            remoteImageCount += 1;
            if (allowRemote) {
              outAttrs.push(`src="${escapeHtmlAttr(safeRemote)}"`);
              hasEmittedSrc = true;
            } else {
              outAttrs.push(`data-ee-remote-src="${escapeHtmlAttr(safeRemote)}"`);
              hasEmittedRemoteSrc = true;
            }
          }
        }
        continue;
      }

      if (tag === "img" && attr.name === "data-ee-tracking-blocked") {
        if (attr.value.trim() === "1" && !hasEmittedTrackingBlocked) {
          trackingPixelCount += 1;
          outAttrs.push('data-ee-tracking-blocked="1"');
          hasEmittedTrackingBlocked = true;
        }
        continue;
      }

      if (tag === "img" && attr.name === "data-ee-cid") {
        const cid = normalizeMailContentId(attr.value);
        if (cid) {
          referencedCids.add(cid);
          if (!hasEmittedCid) {
            outAttrs.push(`data-ee-cid="${escapeHtmlAttr(cid)}"`);
            hasEmittedCid = true;
          }
        }
        continue;
      }

      if (tag === "img" && attr.name === "data-ee-cid-missing") {
        if (attr.value.trim() === "1" && !hasEmittedCidMissing && !hasEmittedSrc) {
          outAttrs.push('data-ee-cid-missing="1"');
          hasEmittedCidMissing = true;
        }
        continue;
      }

      if (tag === "img" && attr.name === "alt") {
        outAttrs.push(`alt="${escapeHtmlAttr(attr.value.slice(0, 300))}"`);
        continue;
      }

      if ((attr.name === "class" || attr.name === "id") && SAFE_TOKEN_RE.test(attr.value)) {
        outAttrs.push(`${attr.name}="${escapeHtmlAttr(attr.value.trim())}"`);
        continue;
      }

      if (GLOBAL_ATTRS.has(attr.name) && attr.name !== "class" && attr.name !== "id" && attr.name !== "style") {
        if (!/[<>"]/.test(attr.value) && attr.value.length <= 120) {
          outAttrs.push(`${attr.name}="${escapeHtmlAttr(attr.value)}"`);
        }
        continue;
      }

      if ((tag === "table" || tag === "td" || tag === "th" || tag === "tr" || tag === "col") && TABLE_ATTRS.has(attr.name)) {
        if (/^[A-Za-z0-9%._\-\s]{1,32}$/.test(attr.value)) {
          outAttrs.push(`${attr.name}="${escapeHtmlAttr(attr.value)}"`);
        }
      }
    }

    if (stashedBgUrl && !allowRemote && !hasEmittedBg) {
      outAttrs.push(`data-ee-remote-bg="${escapeHtmlAttr(stashedBgUrl)}"`);
    }

    const attrSuffix = outAttrs.length > 0 ? ` ${outAttrs.join(" ")}` : "";
    return tag === "br" || tag === "hr" || tag === "img" ? `<${tag}${attrSuffix} />` : `<${tag}${attrSuffix}>`;
  });

  return {
    html: sanitizedHtml.trim(),
    css: styleChunks.join("\n"),
    hasRemoteImages,
    remoteImageCount,
    trackingPixelCount,
    referencedCids: [...referencedCids],
  };
}

export function restoreSafeRemoteImagesInHtml(sanitizedHtml: string): string {
  let restored = sanitizedHtml.replace(/\bdata-ee-remote-src="([^"]+)"/g, (_full, encodedUrl: string) => {
    const raw = encodedUrl.replace(/&amp;/g, "&").replace(/&quot;/g, '"');
    const safe = normalizeSafeHttpOrMailHref(raw);
    return safe && /^https?:\/\//i.test(safe) ? `src="${escapeHtmlAttr(safe)}"` : "";
  });
  restored = restored.replace(/\bdata-ee-remote-bg="([^"]+)"/g, (_full, encodedUrl: string) => {
    const raw = encodedUrl.replace(/&amp;/g, "&").replace(/&quot;/g, '"');
    const safe = normalizeSafeHttpOrMailHref(raw);
    return safe && /^https?:\/\//i.test(safe) ? `background="${escapeHtmlAttr(safe)}"` : "";
  });
  return restored;
}

export function buildSandboxedReaderDocument(params: {
  html: string;
  css?: string;
  schemeMode?: MailReaderThemeMode;
  allowRemoteImages?: boolean;
}): string {
  const mode: MailReaderThemeMode = params.schemeMode ?? "adaptive-dark";
  const imgSrcDirective = params.allowRemoteImages ? "img-src data: blob: https: http:;" : "img-src data: blob:;";
  const csp = `default-src 'none'; style-src 'unsafe-inline'; ${imgSrcDirective} base-uri 'none'; form-action 'none';`;
  const combinedCss = [buildReaderBaseThemeCss(), params.css ?? ""].filter(Boolean).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${combinedCss}</style></head><body><div class="ee-mail-root" data-ee-reader-scheme="${mode}">${params.html}</div></body></html>`;
}
