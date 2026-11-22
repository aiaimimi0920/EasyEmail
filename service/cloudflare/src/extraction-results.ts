import { extractAuthenticationLinksFromContent } from "../../base/src/domain/auth-links";
import { extractOtpFromContent } from "../../base/src/domain/otp";
import type { ExtractionFilter } from "./extraction-query";

export interface ExtractionRow { id: string; sender: string; recipient: string; subject: string; text_body: string; html_body: string; received_at: number }
export function extractionResults(rows: ExtractionRow[], filter: ExtractionFilter, limit = 100) {
  const items = [];
  for (const row of rows.slice(0, limit)) {
    if (row.recipient !== filter.recipient || (filter.sender && !row.sender.toLowerCase().includes(filter.sender))
      || (filter.subject && !row.subject.toLowerCase().includes(filter.subject))) continue;
    const input = { sender: row.sender, subject: row.subject, textBody: row.text_body, htmlBody: row.html_body };
    const otp = extractOtpFromContent(input);
    const links = extractAuthenticationLinksFromContent(input).filter((link) => {
      const url = new URL(link.url); return url.hostname !== "easyemail.local" && !url.username && !url.password;
    });
    const matched = filter.kind === "otp" ? !!otp : filter.kind === "link" ? links.length > 0 : !!otp || links.length > 0;
    if (matched) items.push({ messageId: row.id, receivedAt: row.received_at, otp: otp ?? null, links });
    if (items.length === 10) break;
  }
  return { items, searched: Math.min(rows.length, limit), searchLimited: rows.length > limit };
}
