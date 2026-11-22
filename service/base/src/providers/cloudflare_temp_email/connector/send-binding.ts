import { extractErrorDetail, requestAdminJson } from "./http.js";
import type { CloudflareTempEmailConfig, CloudflareTempMailboxCredentials } from "./models.js";

export async function sendMailWithNativeBinding(
  config: CloudflareTempEmailConfig,
  mailbox: CloudflareTempMailboxCredentials,
  request: {
    toEmailAddress: string;
    toName?: string;
    subject: string;
    textBody?: string;
    htmlBody?: string;
    fromName?: string;
  },
): Promise<void> {
  const fromName = request.fromName?.trim();
  const toName = request.toName?.trim();
  // This is an explicit transport, never a fallback after an uncertain send.
  const response = await requestAdminJson(config, "POST", "/admin/send_mail_by_binding", {
    jsonBody: {
      from: fromName ? { email: mailbox.address, name: fromName } : mailbox.address,
      to: [toName ? { email: request.toEmailAddress, name: toName } : request.toEmailAddress],
      subject: request.subject,
      ...(request.textBody?.trim() ? { text: request.textBody } : {}),
      ...(request.htmlBody?.trim() ? { html: request.htmlBody } : {}),
    },
  });
  if (response.status !== 200) {
    const detail = extractErrorDetail(response.body, response.rawText);
    throw new Error(`Cloudflare Temp Email native binding send failed with status ${response.status}${detail ? `: ${detail}` : "."}`);
  }
}
