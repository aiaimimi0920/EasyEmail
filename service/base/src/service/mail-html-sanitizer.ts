const BLOCKED_CONTAINER_TAG_RE =
  /<\s*(script|iframe|frame|frameset|object|embed|applet|base|meta|link|form)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;

const BLOCKED_VOID_OR_UNCLOSED_TAG_RE =
  /<\s*\/?\s*(script|iframe|frame|frameset|object|embed|applet|base|meta|link|form|input|button|textarea|select)\b[^>]*>/gi;

const INLINE_EVENT_ATTRIBUTE_RE =
  /\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

const SRC_OR_HREF_EXECUTABLE_ATTR_RE =
  /\s+(href|src|xlink:href|formaction|action|srcdoc)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

const STYLE_EXPRESSION_RE =
  /\s+style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

function isDangerousUriValue(rawValue: string): boolean {
  const compact = rawValue
    .replace(/[\u0000-\u0020]+/gu, "")
    .replace(/&#x?[0-9a-f]+;?/gi, "")
    .toLowerCase();
  if (
    compact.startsWith("javascript:")
    || compact.startsWith("vbscript:")
    || compact.startsWith("file:")
  ) {
    return true;
  }
  if (compact.startsWith("data:") && !compact.startsWith("data:image/")) {
    return true;
  }
  return false;
}

function sanitizeStyleAttributeValue(rawStyle: string): string {
  const lowered = rawStyle.toLowerCase();
  if (
    lowered.includes("expression(")
    || lowered.includes("javascript:")
    || lowered.includes("vbscript:")
    || lowered.includes("@import")
    || /url\s*\(/i.test(rawStyle)
  ) {
    return "";
  }
  return rawStyle.replace(/"/g, "'").trim();
}

export function sanitizeMailHtml(rawHtml: string | undefined | null): string | undefined {
  if (typeof rawHtml !== "string") {
    return undefined;
  }
  const trimmed = rawHtml.trim();
  if (!trimmed) {
    return undefined;
  }

  let sanitized = trimmed
    .replace(/\u0000/g, "")
    .replace(BLOCKED_CONTAINER_TAG_RE, "")
    .replace(BLOCKED_VOID_OR_UNCLOSED_TAG_RE, "")
    .replace(INLINE_EVENT_ATTRIBUTE_RE, "");

  sanitized = sanitized.replace(
    SRC_OR_HREF_EXECUTABLE_ATTR_RE,
    (fullMatch, attrName: string, doubleQuoted?: string, singleQuoted?: string, bareValue?: string) => {
      const normalizedAttr = attrName.toLowerCase();
      if (normalizedAttr === "srcdoc") {
        return "";
      }
      const candidate = doubleQuoted ?? singleQuoted ?? bareValue ?? "";
      if (isDangerousUriValue(candidate)) {
        return "";
      }
      return fullMatch;
    },
  );

  sanitized = sanitized.replace(
    STYLE_EXPRESSION_RE,
    (_fullMatch, doubleQuoted?: string, singleQuoted?: string) => {
      const cleaned = sanitizeStyleAttributeValue(doubleQuoted ?? singleQuoted ?? "");
      return cleaned ? ` style="${cleaned}"` : "";
    },
  );

  const normalized = sanitized.trim();
  return normalized || undefined;
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
