export type ComposeLinkType = "web" | "email" | "phone";

export function normalizeComposeLinkHref(
  value: string,
  type: ComposeLinkType,
): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (type === "email") {
    const address = trimmed.replace(/^mailto:/i, "").trim();
    return address && !/[\r\n]|%(?:0a|0d)/i.test(address) ? `mailto:${address}` : null;
  }

  if (type === "phone") {
    const number = trimmed.replace(/^tel:/i, "").trim();
    return number && !/[\r\n]|%(?:0a|0d)/i.test(number) ? `tel:${number}` : null;
  }

  const withScheme = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
