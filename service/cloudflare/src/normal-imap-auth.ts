import { HttpError } from "./http";
import type { SaslAuthentication } from "./mail-authentication";
import type { ImapWire } from "./normal-imap-wire";

export async function authenticateImap(wire: ImapWire, advertised: string[], sasl: SaslAuthentication) {
  if (!advertised.includes(`AUTH=${sasl.mechanism}`)) throw new HttpError(409, "imap_auth_method_unavailable");
  if (sasl.mechanism === "PLAIN") {
    await wire.command("AUTHENTICATE PLAIN", sasl.response); return;
  }
  let sent = advertised.includes("SASL-IR"), failed = false;
  const tag = await wire.start(`AUTHENTICATE XOAUTH2${sent ? " " + sasl.response : ""}`);
  for (let count = 0; count < 100; count++) {
    const line = await wire.line();
    if (/^\+(?: |$)/.test(line)) {
      if (!sent) {
        // A nonempty challenge is an error, not a request for a fresh bearer token.
        if (!/^\+ ?$/.test(line)) throw new HttpError(403, "imap_auth_failed");
        sent = true; await wire.write(sasl.response);
      } else {
        if (failed) throw new HttpError(403, "imap_auth_failed");
        failed = true; await wire.write("");
      }
      continue;
    }
    if (line.startsWith(`${tag} `)) {
      if (failed || !new RegExp(`^${tag} OK(?: |$)`, "i").test(line)) throw new HttpError(403, "imap_auth_failed");
      if (!sent) throw new HttpError(502, "imap_protocol_invalid");
      wire.completion = line; return;
    }
    if (!line.startsWith("* ") || /^\* BYE(?: |$)/i.test(line)) throw new HttpError(502, "imap_connection_closed");
  }
  throw new HttpError(502, "imap_response_limit");
}
