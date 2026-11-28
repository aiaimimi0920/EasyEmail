export type MailReaderThemeMode = "adaptive-dark" | "paper-light";

export interface SanitizedCssResult {
  css: string;
  hadRemoteUrl: boolean;
}

const SAFE_CSS_PROPERTIES = new Set([
  "color", "background", "background-color", "background-position", "background-repeat", "background-size",
  "border", "border-top", "border-right", "border-bottom", "border-left",
  "border-color", "border-style", "border-width", "border-radius", "border-collapse", "border-spacing",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "font", "font-family", "font-size", "font-style", "font-weight", "font-variant",
  "line-height", "letter-spacing", "text-align", "text-decoration", "text-indent", "text-transform",
  "vertical-align", "white-space", "word-break", "word-wrap", "overflow-wrap",
  "width", "min-width", "max-width", "height", "min-height", "max-height",
  "display", "box-sizing", "table-layout", "list-style", "list-style-type", "list-style-position",
  "flex", "flex-direction", "flex-wrap", "justify-content", "align-items", "gap",
  "grid-template-columns", "opacity", "overflow", "overflow-x", "overflow-y", "direction",
]);

const DANGEROUS_CSS_VALUE_RE = /(?:expression\s*\(|javascript\s*:|vbscript\s*:|data\s*:\s*(?!image\/(?:png|jpeg|jpg|gif|webp);base64,)|-moz-binding|behavior\s*:|@import)/i;
const CSS_URL_TOKEN_RE = /url\s*\(\s*(['"]?)\s*([^)'"]+?)\s*\1\s*\)/gi;
const CSS_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const PREFERS_SCHEME_CLAUSE_RE = /^\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/i;

export function sanitizeInlineStyleDeclarations(
  rawStyle: string,
  allowRemoteUrls = false,
): { style: string; stashedBgUrl?: string; hadRemoteUrl: boolean } {
  const withoutComments = rawStyle.replace(CSS_COMMENT_RE, " ").trim();
  if (!withoutComments) return { style: "", hadRemoteUrl: false };

  let hadRemoteUrl = false;
  let stashedBgUrl: string | undefined;
  const cleanDecls: string[] = [];

  for (const rawDecl of splitCssDeclarations(withoutComments)) {
    const colonIdx = rawDecl.indexOf(":");
    if (colonIdx <= 0) continue;
    const prop = rawDecl.slice(0, colonIdx).trim().toLowerCase();
    let val = rawDecl.slice(colonIdx + 1).trim();
    if (!val || DANGEROUS_CSS_VALUE_RE.test(val) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(val)) {
      continue;
    }
    if (prop === "position") {
      if (/^(?:fixed|sticky)$/i.test(val)) cleanDecls.push("position: static");
      else if (/^(?:static|relative|absolute)$/i.test(val)) cleanDecls.push(`position: ${val.toLowerCase()}`);
      continue;
    }
    if (!SAFE_CSS_PROPERTIES.has(prop)) continue;

    if (/url\s*\(/i.test(val)) {
      val = val.replace(CSS_URL_TOKEN_RE, (_full, _q: string, rawUrl: string) => {
        const trimmedUrl = rawUrl.trim();
        if (/^https?:\/\//i.test(trimmedUrl) || trimmedUrl.startsWith("//")) {
          const normalized = trimmedUrl.startsWith("//") ? `https:${trimmedUrl}` : trimmedUrl;
          hadRemoteUrl = true;
          if (!allowRemoteUrls) {
            if (!stashedBgUrl && (prop === "background" || prop === "background-image" || SAFE_CSS_PROPERTIES.has(prop))) {
              stashedBgUrl = normalized;
            }
            return "none";
          }
          return `url("${normalized.replace(/["\\]/g, "")}")`;
        }
        if (/^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(trimmedUrl) && trimmedUrl.length <= 65536) {
          return `url("${trimmedUrl.replace(/\s+/g, "")}")`;
        }
        return "none";
      });
    }
    const sanitizedVal = val.replace(/[<>"]/g, "'").trim();
    if (sanitizedVal) cleanDecls.push(`${prop}: ${sanitizedVal}`);
  }

  return { style: cleanDecls.join("; "), ...(stashedBgUrl ? { stashedBgUrl } : {}), hadRemoteUrl };
}

function splitCssDeclarations(block: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < block.length; i += 1) {
    const ch = block[i]!;
    if (quote) {
      if (ch === "\\" && i + 1 < block.length) {
        i += 1;
      } else if (ch === quote) {
        quote = "";
      }
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth += 1;
    else if (ch === ")" && depth > 0) depth -= 1;
    else if (ch === ";" && depth === 0) {
      result.push(block.slice(start, i));
      start = i + 1;
    }
  }
  result.push(block.slice(start));
  return result;
}

function scopeSelectorList(rawSelector: string, scopePrefix = ".ee-mail-root"): string {
  const parts = rawSelector.split(",").map((s) => s.trim()).filter(Boolean);
  const scoped: string[] = [];
  for (const part of parts) {
    if (/[{}@;<>\\]/.test(part) || part.length > 160) continue;
    const normalized = part.replace(/\b(?:html|body|:root)\b/gi, scopePrefix);
    if (normalized.includes(scopePrefix)) {
      scoped.push(normalized);
    } else {
      scoped.push(`${scopePrefix} ${normalized}`);
    }
  }
  return scoped.join(", ");
}

function parseColorSchemeMediaHead(mediaQuery: string): { scheme?: "dark" | "light"; remainingMedia: string; valid: boolean } {
  const trimmed = mediaQuery.trim();
  if (!trimmed) return { remainingMedia: "", valid: false };
  let negated = false;
  let body = trimmed;
  if (/^not\s+/i.test(body)) {
    negated = true;
    body = body.slice(4).trim();
  }
  const clauses = body.split(/\band\b/i).map((c) => c.trim()).filter(Boolean);
  let scheme: "dark" | "light" | undefined;
  const kept: string[] = [];
  for (const clause of clauses) {
    const m = PREFERS_SCHEME_CLAUSE_RE.exec(clause);
    if (m?.[1]) {
      let detected = m[1].toLowerCase() as "dark" | "light";
      if (negated && clauses.length === 1) {
        detected = detected === "dark" ? "light" : "dark";
        negated = false;
      } else if (negated) {
        return { remainingMedia: "", valid: false };
      }
      scheme = detected;
    } else if (!/^(?:all|only\s+all|screen|only\s+screen)$/i.test(clause)) {
      kept.push(clause);
    }
  }
  return { ...(scheme ? { scheme } : {}), remainingMedia: kept.join(" and "), valid: true };
}

export function sanitizeMailStylesheet(rawCss: string, allowRemoteUrls = false): SanitizedCssResult {
  const stripped = rawCss.replace(CSS_COMMENT_RE, " ").replace(/<!--|-->/g, " ");
  let hadRemoteUrl = false;
  const outputRules: string[] = [];

  let index = 0;
  while (index < stripped.length && outputRules.length < 400) {
    while (index < stripped.length && /\s/.test(stripped[index]!)) index += 1;
    if (index >= stripped.length) break;

    if (stripped[index] === "@") {
      const semiIdx = stripped.indexOf(";", index);
      const braceIdx = stripped.indexOf("{", index);
      if (semiIdx !== -1 && (braceIdx === -1 || semiIdx < braceIdx)) {
        index = semiIdx + 1;
        continue;
      }
      if (braceIdx === -1) break;
      const head = stripped.slice(index, braceIdx).trim();
      const closeIdx = findMatchingBrace(stripped, braceIdx);
      if (closeIdx === -1) break;
      const inner = stripped.slice(braceIdx + 1, closeIdx);
      index = closeIdx + 1;

      if (/^@media\b/i.test(head)) {
        const mqText = head.slice(6).trim();
        if (/prefers-color-scheme/i.test(mqText)) {
          const parsed = parseColorSchemeMediaHead(mqText);
          if (!parsed.valid) continue;
          const scope = parsed.scheme === "dark"
            ? '.ee-mail-root[data-ee-reader-scheme="adaptive-dark"]'
            : parsed.scheme === "light"
              ? '.ee-mail-root[data-ee-reader-scheme="paper-light"]'
              : ".ee-mail-root";
          const innerSanitized = sanitizeRuleSequence(inner, scope, allowRemoteUrls);
          if (innerSanitized.hadRemoteUrl) hadRemoteUrl = true;
          if (innerSanitized.css) {
            outputRules.push(parsed.remainingMedia ? `@media ${parsed.remainingMedia} {\n${innerSanitized.css}\n}` : innerSanitized.css);
          }
        } else if (!/[{};<>]/.test(mqText)) {
          const innerSanitized = sanitizeRuleSequence(inner, ".ee-mail-root", allowRemoteUrls);
          if (innerSanitized.hadRemoteUrl) hadRemoteUrl = true;
          if (innerSanitized.css) outputRules.push(`@media ${mqText} {\n${innerSanitized.css}\n}`);
        }
      }
      continue;
    }

    const braceIdx = stripped.indexOf("{", index);
    if (braceIdx === -1) break;
    const selector = stripped.slice(index, braceIdx).trim();
    const closeIdx = findMatchingBrace(stripped, braceIdx);
    if (closeIdx === -1) break;
    const body = stripped.slice(braceIdx + 1, closeIdx);
    index = closeIdx + 1;

    const scopedSel = scopeSelectorList(selector, ".ee-mail-root");
    if (!scopedSel) continue;
    const decls = sanitizeInlineStyleDeclarations(body, allowRemoteUrls);
    if (decls.hadRemoteUrl) hadRemoteUrl = true;
    if (decls.style) outputRules.push(`${scopedSel} { ${decls.style}; }`);
  }

  return { css: outputRules.join("\n"), hadRemoteUrl };
}

function sanitizeRuleSequence(raw: string, scopePrefix: string, allowRemoteUrls: boolean): SanitizedCssResult {
  let hadRemoteUrl = false;
  const rules: string[] = [];
  let index = 0;
  while (index < raw.length && rules.length < 200) {
    const braceIdx = raw.indexOf("{", index);
    if (braceIdx === -1) break;
    const selector = raw.slice(index, braceIdx).trim();
    const closeIdx = findMatchingBrace(raw, braceIdx);
    if (closeIdx === -1) break;
    const body = raw.slice(braceIdx + 1, closeIdx);
    index = closeIdx + 1;
    if (selector.startsWith("@")) continue;
    const scopedSel = scopeSelectorList(selector, scopePrefix);
    if (!scopedSel) continue;
    const decls = sanitizeInlineStyleDeclarations(body, allowRemoteUrls);
    if (decls.hadRemoteUrl) hadRemoteUrl = true;
    if (decls.style) rules.push(`${scopedSel} { ${decls.style}; }`);
  }
  return { css: rules.join("\n"), hadRemoteUrl };
}

function findMatchingBrace(source: string, openBraceIndex: number): number {
  let depth = 0;
  let quote = "";
  for (let i = openBraceIndex; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quote) {
      if (ch === "\\" && i + 1 < source.length) i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function buildReaderBaseThemeCss(): string {
  // Uses natural comfortable studio palettes (warm editorial cream #F5F2EB and soft slate #161B22, never pure #000000).
  return [
    "html, body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; line-height: 1.6; }",
    ".ee-mail-root { padding: 16px 18px; overflow-wrap: break-word; word-break: break-word; box-sizing: border-box; }",
    '.ee-mail-root[data-ee-reader-scheme="adaptive-dark"] { background-color: #161B22; color: #E6EDF3; color-scheme: dark; }',
    '.ee-mail-root[data-ee-reader-scheme="adaptive-dark"] a { color: #58A6FF; }',
    '.ee-mail-root[data-ee-reader-scheme="paper-light"] { background-color: #F5F2EB; color: #1F2328; color-scheme: light; }',
    '.ee-mail-root[data-ee-reader-scheme="paper-light"] a { color: #0969DA; }',
    ".ee-mail-root img { max-width: 100%; height: auto; }",
    ".ee-mail-root table { max-width: 100%; border-collapse: collapse; }",
    ".ee-mail-root pre, .ee-mail-root code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }",
    ".ee-mail-root pre { overflow-x: auto; padding: 10px 12px; border-radius: 6px; background: rgba(127,138,154,0.12); }",
    ".ee-mail-root blockquote { margin: 8px 0; padding-left: 12px; border-left: 3px solid rgba(127,138,154,0.45); }",
    ".ee-bilingual-translation { display: block; margin-top: 4px; padding: 4px 8px; border-left: 2px solid #38BDF8; opacity: 0.92; font-size: 0.95em; }",
    "img[data-ee-remote-src]:not([src]), img[data-ee-cid-missing]:not([src]) { display: inline-block; min-width: 24px; min-height: 18px; border: 1px dashed rgba(127,138,154,0.45); border-radius: 4px; padding: 2px 6px; font-size: 12px; }",
    "img[data-ee-tracking-blocked]:not([src]) { display: none; }",
  ].join("\n");
}
