import { HttpError } from "./http";
import { SmtpWire, type SmtpSocket } from "./smtp-wire";
import type { MailSocketControl } from "./mail-socket-session";
import { mailSasl, type MailAuthentication } from "./mail-authentication";
import { authenticateSmtp } from "./smtp-auth";

export interface SmtpAttempt { dataStarted: boolean }
export interface SmtpMessage { from: string; recipients: string[]; mime: string }
export class SmtpRejected extends HttpError {}
function expect(code: number, allowed: number[], error: string) {
  if (allowed.includes(code)) return;
  if (code >= 400) throw new SmtpRejected(502, error);
  throw new HttpError(502, "smtp_protocol_invalid");
}
async function hello(wire: SmtpWire) {
  await wire.write("EHLO easyemail.invalid\r\n"); const response = await wire.reply();
  expect(response.code, [250], "smtp_command_rejected"); return response.lines.slice(1);
}
export async function submitSmtp(socket: SmtpSocket, username: string, authentication: MailAuthentication, message: SmtpMessage, attempt: SmtpAttempt, control?: MailSocketControl) {
  const wire = new SmtpWire(socket, control);
  try {
    const sasl = mailSasl(username, authentication);
    await socket.opened;
    expect((await wire.reply()).code, [220], "smtp_greeting_rejected");
    let capabilities = await hello(wire);
    if (wire.needsStartTls) {
      if (!capabilities.some(line => /^STARTTLS$/i.test(line))) throw new HttpError(502, "smtp_starttls_unavailable");
      await wire.write("STARTTLS\r\n"); expect((await wire.reply()).code, [220], "smtp_starttls_rejected");
      await wire.startTls(); capabilities = await hello(wire);
    }
    await authenticateSmtp(wire, capabilities, sasl);
    await wire.write(`MAIL FROM:<${message.from}>\r\n`); expect((await wire.reply()).code, [250], "smtp_sender_rejected");
    // Do not send DATA unless every recipient was accepted: no silent partial delivery.
    for (const address of message.recipients) {
      await wire.write(`RCPT TO:<${address}>\r\n`); expect((await wire.reply()).code, [250, 251], "smtp_recipient_rejected");
    }
    await wire.write("DATA\r\n"); expect((await wire.reply()).code, [354], "smtp_message_rejected");
    attempt.dataStarted = true;
    await wire.write(message.mime);
    expect((await wire.reply()).code, [250], "smtp_message_rejected");
    // Final 250 is sufficient. QUIT/connection-close failure cannot undo acceptance.
  } finally { wire.release(); }
}
