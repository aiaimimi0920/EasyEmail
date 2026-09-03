import type { MailCreateMailItem } from "./models.js";

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : {};
}

export function asMailItems(value: unknown): MailCreateMailItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item) => item && typeof item === "object") as MailCreateMailItem[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseRawMailHeader(raw: string | undefined, headerName: string): string | undefined {
  if (!raw) {
    return undefined;
  }

  const escapedHeaderName = headerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escapedHeaderName}:\\s*(.+)$`, "gim");
  const match = regex.exec(raw);
  return match?.[1]?.trim() || undefined;
}

export function extractObservedAtFromRaw(raw: string | undefined): string {
  const dateHeader = parseRawMailHeader(raw, "Date");
  if (!dateHeader) {
    return "";
  }

  const parsed = Date.parse(dateHeader);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function decodeQuotedPrintableBody(value: string): string {
  const normalized = value.replace(/=\r?\n/g, "");
  const bytes: number[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index]!;
    if (
      current === "="
      && index + 2 < normalized.length
      && /^[0-9A-Fa-f]{2}$/.test(normalized.slice(index + 1, index + 3))
    ) {
      bytes.push(Number.parseInt(normalized.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }

    bytes.push(current.charCodeAt(0));
  }

  return Buffer.from(bytes).toString("utf8");
}

function decodeMimeBodyByTransferEncoding(body: string, transferEncoding: string | undefined): string {
  const normalizedEncoding = transferEncoding?.trim().toLowerCase();
  if (normalizedEncoding?.includes("quoted-printable")) {
    return decodeQuotedPrintableBody(body).trim();
  }
  return body.trim();
}

export function parseRawMailBodies(raw: string | undefined): { textBody?: string; htmlBody?: string } {
  if (!raw?.trim()) {
    return {};
  }

  const normalized = raw.replace(/\r\n/g, "\n");
  const parsed: { textBody?: string; htmlBody?: string } = {};

  const boundary = parseRawMailHeader(raw, "Content-Type")?.match(/boundary="?([^";\r\n]+)"?/i)?.[1]?.trim();
  if (boundary) {
    const boundaryRegex = new RegExp(`\\n--${escapeRegex(boundary)}(?:--)?\\n`, "g");
    const parts = normalized
      .split(boundaryRegex)
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && part !== "--");

    for (const part of parts) {
      const separatorIndex = part.indexOf("\n\n");
      if (separatorIndex < 0) {
        continue;
      }

      const headers = part.slice(0, separatorIndex).trim();
      const body = part.slice(separatorIndex + 2);
      const contentType = headers.match(/Content-Type:\s*(text\/plain|text\/html)/i)?.[1]?.trim().toLowerCase();
      if (!contentType) {
        continue;
      }

      const transferEncoding = headers.match(/Content-Transfer-Encoding:\s*([^\n]+)/i)?.[1];
      const decoded = decodeMimeBodyByTransferEncoding(body, transferEncoding);
      if (!decoded) {
        continue;
      }

      if (contentType === "text/plain") {
        parsed.textBody = decoded;
      } else if (contentType === "text/html") {
        parsed.htmlBody = decoded;
      }
    }
  }

  if (!parsed.textBody && !parsed.htmlBody) {
    const separatorIndex = normalized.indexOf("\n\n");
    if (separatorIndex >= 0) {
      const headers = normalized.slice(0, separatorIndex).trim();
      const body = normalized.slice(separatorIndex + 2);
      const contentType = headers.match(/Content-Type:\s*(text\/plain|text\/html)/i)?.[1]?.trim().toLowerCase();
      const transferEncoding = headers.match(/Content-Transfer-Encoding:\s*([^\n]+)/i)?.[1];
      const decoded = decodeMimeBodyByTransferEncoding(body, transferEncoding);
      if (decoded && contentType === "text/plain") {
        parsed.textBody = decoded;
      } else if (decoded && contentType === "text/html") {
        parsed.htmlBody = decoded;
      }
    }
  }

  if (!parsed.textBody && !parsed.htmlBody) {
    return {
      textBody: raw.trim(),
    };
  }

  return parsed;
}
