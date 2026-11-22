import { HttpError } from "../http";
import type { MailCredential, OutgoingContent, ProviderConfig, ProviderSecret } from "./contracts";
import { object, providerJson } from "./http";
import { extendedRecipients, toList } from "../outgoing-recipients";

export async function cloudflareSend(config: ProviderConfig, secret: ProviderSecret, signal: AbortSignal,
  mail: OutgoingContent, credential: MailCredential): Promise<void> {
  const site: Record<string, string> = secret.sitePassword ? { "x-custom-auth": secret.sitePassword } : {};
  let path: string, headers: Record<string, string>, body: unknown;
  if (config.sendTransport === "worker") {
    if (extendedRecipients(mail)) throw new HttpError(409, "multiple_recipients_unavailable");
    if (mail.attachments?.length) throw new HttpError(409, "attachment_send_unavailable");
    if (!credential.token) throw new HttpError(503, "mailbox_credential_unavailable");
    path = "/api/send_mail";
    headers = { ...site, authorization: `Bearer ${credential.token}` };
    body = { from_name: "", to_mail: toList(mail)[0], to_name: "", subject: mail.subject, content: mail.text, is_html: false };
  } else if (config.sendTransport === "binding") {
    path = "/admin/send_mail_by_binding";
    headers = { ...site, "x-admin-auth": secret.apiKey };
    body = { from: mail.from, to: toList(mail), subject: mail.subject, text: mail.text,
      ...(mail.cc?.length ? { cc: mail.cc } : {}), ...(mail.bcc?.length ? { bcc: mail.bcc } : {}),
      ...(mail.attachments?.length ? { attachments: mail.attachments } : {}),
      ...(mail.replyMessageId ? { headers: { "In-Reply-To": mail.replyMessageId, References: mail.replyMessageId } } : {}) };
  } else throw new HttpError(409, "sending_disabled");
  // Exactly one HTTP write; no access requests, admin delegation, redirect or retry.
  const result = object(await providerJson(config.baseUrl, path, headers, signal, body, { expectedStatus: 200 }));
  if (result.status !== "ok") throw new HttpError(502, "provider_invalid_response");
}
