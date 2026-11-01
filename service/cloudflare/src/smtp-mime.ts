import { toList, type RecipientFields } from "./outgoing-recipients";
import { smtpMultipart, type SmtpAttachment } from "./smtp-attachments";
import { HttpError } from "./http";

export const utf8Base64 = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value)));
export function smtpMime(input: RecipientFields & { from: string; subject: string; text: string; id: string; createdAt: number;
  threading?: { inReplyTo: string | null; references: string[] }; attachments?: SmtpAttachment[] }) {
  // Each encoded-word is below 75 octets and never splits a UTF-8 code point.
  const words: string[] = []; let chunk = "";
  for (const char of input.subject) {
    if (new TextEncoder().encode(chunk + char).length > 42) { words.push(`=?UTF-8?B?${utf8Base64(chunk)}?=`); chunk = ""; }
    chunk += char;
  }
  if (chunk) words.push(`=?UTF-8?B?${utf8Base64(chunk)}?=`);
  const list = (name: string, addresses: string[]) => `${name}: ${addresses.map(address => `<${address}>`).join(",\r\n ")}`;
  const body = utf8Base64(input.text.replace(/\r\n|\r|\n/g, "\r\n")).match(/.{1,76}/g)?.join("\r\n") ?? "";
  // Bcc exists only in the SMTP envelope, never in serialized headers.
  const mime = [`From: <${input.from}>`, list("To", toList(input)), ...(input.cc?.length ? [list("Cc", input.cc)] : []),
    ...(input.threading?.inReplyTo ? [`In-Reply-To: ${input.threading.inReplyTo}`, `References: ${input.threading.references.join("\r\n ")}`] : []),
    `Subject: ${words.join("\r\n ")}`, `Date: ${new Date(input.createdAt * 1000).toUTCString()}`,
    `Message-ID: <${input.id}@easyemail.invalid>`, "MIME-Version: 1.0", ...(input.attachments?.length
      ? smtpMultipart(`easyemail-${input.id}`, body, input.attachments)
      : ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", body]), ".", ""].join("\r\n");
  if (new TextEncoder().encode(mime).length > 5 * 1024 * 1024) throw new HttpError(413, "outbox_message_too_large");
  return mime;
}
