export interface SmtpAttachment { filename: string; type: string; content: string }

function filenameParameters(filename: string) {
  // RFC 2231 continuations keep even 120 four-byte characters below SMTP line limits.
  // Split at code-point boundaries, never inside a percent escape or UTF-8 sequence.
  const chunks: string[] = []; let chunk = "";
  for (const character of filename) {
    const encoded = encodeURIComponent(character).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
    if (chunk.length + encoded.length > 48) { chunks.push(chunk); chunk = ""; }
    chunk += encoded;
  }
  chunks.push(chunk);
  return chunks.map((value, index) => ` filename*${index}*=${index === 0 ? "UTF-8''" : ""}${value}`).join(";\r\n");
}

export function smtpMultipart(boundary: string, text: string, attachments: SmtpAttachment[]) {
  const parts = [`Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", text];
  for (const attachment of attachments) parts.push(`--${boundary}`, `Content-Type: ${attachment.type}`,
    "Content-Transfer-Encoding: base64", "Content-Disposition: attachment;", filenameParameters(attachment.filename), "",
    attachment.content.match(/.{1,76}/g)?.join("\r\n") ?? "");
  parts.push(`--${boundary}--`);
  return parts;
}
