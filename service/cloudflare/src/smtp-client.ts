import { HttpError } from "./http";
import { withMailSocket } from "./mail-socket-session";
import type { SmtpEndpoint } from "./smtp-config-input";
import { SmtpRejected, submitSmtp, type SmtpMessage } from "./smtp-protocol";
import { assertMailAuthentication, type MailAuthentication } from "./mail-authentication";

export async function sendSmtp(endpoint: SmtpEndpoint, username: string, authentication: MailAuthentication, message: SmtpMessage) {
  const attempt = { dataStarted: false };
  try {
    assertMailAuthentication(username, authentication);
    await withMailSocket(endpoint, "smtp", (socket, control) => submitSmtp(socket, username, authentication, message, attempt, control));
    return { state: "accepted" as const, error: null };
  } catch (error) {
    if (attempt.dataStarted && !(error instanceof SmtpRejected)) return { state: "unknown" as const, error: "smtp_outcome_unknown" };
    return { state: "rejected" as const, error: error instanceof HttpError ? error.code : "smtp_connection_failed" };
  }
}
