import { HttpError } from "./http";
import type { SaslAuthentication } from "./mail-authentication";
import type { SmtpWire } from "./smtp-wire";

export async function authenticateSmtp(wire: SmtpWire, capabilities: string[], sasl: SaslAuthentication) {
  const methods = capabilities.filter(line => /^AUTH(?:=| )/i.test(line)).flatMap(line => line.slice(5).toUpperCase().split(/ +/));
  if (!methods.includes(sasl.mechanism)) throw new HttpError(502, "smtp_auth_method_unavailable");
  await wire.write(`AUTH ${sasl.mechanism} ${sasl.response}\r\n`); let auth = await wire.reply();
  if (auth.code === 334) {
    if (sasl.mechanism === "XOAUTH2") {
      // XOAUTH2's post-response challenge is an error. Acknowledge once without
      // resending the bearer token; even a subsequent 235 cannot undo this error.
      await wire.write("\r\n"); await wire.reply(); throw new HttpError(502, "smtp_auth_failed");
    }
    await wire.write(sasl.response + "\r\n"); auth = await wire.reply();
  }
  if (auth.code !== 235) throw new HttpError(502, auth.code >= 400 ? "smtp_auth_failed" : "smtp_protocol_invalid");
}
