export type MailTranslationDisplayMode = "original" | "translated" | "bilingual";

export interface MailTranslationState {
  mode: MailTranslationDisplayMode;
  targetLang: string;
  segments: Readonly<Record<string, string | undefined>>;
}

export interface MinimalDomTextNode {
  data: string;
  readonly parentElement: MinimalDomElement | null;
  after(node: MinimalDomElement): void;
}

export interface MinimalDomElement {
  className: string;
  lang: string;
  textContent: string | null;
  readonly parentElement: MinimalDomElement | null;
  readonly ownerDocument: MinimalDomDocument;
  getAttribute(name: string): string | null;
  closest(selector: string): unknown;
  remove(): void;
}

export interface MinimalDomTreeWalker {
  readonly currentNode: unknown;
  nextNode(): unknown;
}

export interface MinimalDomDocument {
  createElement(tagName: string): MinimalDomElement;
  createTreeWalker(root: MinimalDomElement, whatToShow: number): MinimalDomTreeWalker;
}

const SHOW_TEXT_FILTER = 4;
const SKIP_ANCESTOR_SELECTOR = "script,style,pre,code,textarea,template,svg,math,title,noscript,[hidden]";
const HIDDEN_INLINE_STYLE_RE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i;
const STRIP_SKIP_BLOCKS_RE = /<\s*(script|style|pre|code|svg|math|template|noscript)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const BLOCK_BREAK_TAG_RE = /<\s*\/?\s*(?:p|div|li|tr|td|th|h[1-6]|blockquote|section|article|header|footer|br|hr)\b[^>]*>/gi;
const ANY_HTML_TAG_RE = /<[^>]+>/g;

function decodeBasicHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

export function extractTranslatableTextSegments(
  input: { textBody?: string; htmlBody?: string },
  maxSegments = 60,
  maxSegmentLength = 600,
): string[] {
  const sourceHtml = input.htmlBody?.trim();
  const rawChunks = sourceHtml
    ? decodeBasicHtmlEntities(
        sourceHtml
          .replace(STRIP_SKIP_BLOCKS_RE, "\n")
          .replace(BLOCK_BREAK_TAG_RE, "\n")
          .replace(ANY_HTML_TAG_RE, " "),
      ).split(/\r?\n+/)
    : (input.textBody ?? "").split(/\r?\n+/);

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawChunks) {
    const trimmed = raw.replace(/\s+/g, " ").trim();
    if (!trimmed || trimmed.length < 2) continue;
    if (/^[\d\s.,:;!?@#$%^&*()_+\-=[\]{}|\\/<>~`'"]+$/.test(trimmed)) continue;
    if (/^https?:\/\/\S+$/i.test(trimmed)) continue;
    const bounded = Array.from(trimmed).slice(0, maxSegmentLength).join("");
    if (seen.has(bounded)) continue;
    seen.add(bounded);
    unique.push(bounded);
    if (unique.length >= maxSegments) break;
  }
  return unique;
}

export function groupSegmentsIntoBatches(segments: readonly string[], maxBatchChars = 1800, maxBatchItems = 12): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const segment of segments) {
    if (!segment.trim()) continue;
    if (current.length > 0 && (current.length >= maxBatchItems || chars + segment.length > maxBatchChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(segment);
    chars += segment.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function lookupTranslatedSegment(
  rawNodeText: string,
  segments: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const key = rawNodeText.replace(/\s+/g, " ").trim();
  if (!key) return undefined;
  const hit = Object.prototype.hasOwnProperty.call(segments, key) ? segments[key] : undefined;
  return hit && hit.trim() && hit.trim() !== key ? hit.trim() : undefined;
}

function hasHiddenInlineAncestor(element: MinimalDomElement | null, boundary: MinimalDomElement): boolean {
  let cursor: MinimalDomElement | null = element;
  while (cursor && cursor !== boundary) {
    if (HIDDEN_INLINE_STYLE_RE.test(cursor.getAttribute("style") ?? "")) return true;
    cursor = cursor.parentElement;
  }
  return false;
}

// Text-node-only DOM translation renderer: preserves tables, links, buttons and never parses model output as HTML.
export function createTextNodeTranslationController(root: MinimalDomElement): (state?: MailTranslationState) => void {
  const walker = root.ownerDocument.createTreeWalker(root, SHOW_TEXT_FILTER);
  const tracked: Array<{
    node: MinimalDomTextNode;
    original: string;
    bilingualSpan?: MinimalDomElement;
  }> = [];

  while (walker.nextNode()) {
    const textNode = walker.currentNode as MinimalDomTextNode;
    const parent = textNode.parentElement;
    if (!parent || parent.closest(SKIP_ANCESTOR_SELECTOR)) continue;
    if (hasHiddenInlineAncestor(parent, root)) continue;
    if (!textNode.data.trim()) continue;
    tracked.push({ node: textNode, original: textNode.data });
  }

  return (state?: MailTranslationState) => {
    for (const record of tracked) {
      const translated = state ? lookupTranslatedSegment(record.original, state.segments) : undefined;
      const nextText = translated && state?.mode === "translated"
        ? record.original.replace(/\S[\s\S]*\S|\S/u, () => translated)
        : record.original;
      if (record.node.data !== nextText) {
        record.node.data = nextText;
      }

      if (!translated || state?.mode !== "bilingual") {
        record.bilingualSpan?.remove();
        record.bilingualSpan = undefined;
        continue;
      }

      if (!record.bilingualSpan) {
        const span = root.ownerDocument.createElement("span");
        span.className = "ee-bilingual-translation";
        span.lang = state.targetLang;
        span.textContent = translated;
        record.node.after(span);
        record.bilingualSpan = span;
      } else {
        if (record.bilingualSpan.lang !== state.targetLang) record.bilingualSpan.lang = state.targetLang;
        if (record.bilingualSpan.textContent !== translated) record.bilingualSpan.textContent = translated;
      }
    }
  };
}
