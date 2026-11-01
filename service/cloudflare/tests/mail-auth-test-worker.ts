import worker from "../src/worker";
import { HttpError, json } from "../src/http";
import type { Env } from "../src/contracts";
import { testImapConnection, readImapMessages } from "../src/normal-imap-client";
import { sendSmtp } from "../src/smtp-client";
import { configureStarttlsFixture } from "./starttls-transport-fixture";

// This synthetic-only route is never imported by the application entrypoint.
export default { async fetch(request: Request, env: Env & { TEST_MAIL_AUTH_FIXTURE: string }) {
  configureStarttlsFixture(env.TEST_MAIL_AUTH_FIXTURE);
  if (new URL(request.url).pathname !== "/__test/mail-auth") return worker.fetch(request, env);
  const input = await request.json() as { protocol: "imap" | "smtp"; security: "tls" | "starttls"; read?: boolean };
  const endpoint = { id: "example", label: "synthetic", hostname: `${input.protocol}.example.test`, security: input.security };
  const authentication = { method: "xoauth2" as const, accessToken: "ya29.Synthetic-_~+/accessToken==" }, username = "alice@example.test";
  try {
    if (input.protocol === "smtp") return json(await sendSmtp({ ...endpoint, port: input.security === "starttls" ? 587 : 465, recipients: ["*"] }, username, authentication,
      { from: username, recipients: ["receiver@example.test"], mime: "Subject: synthetic\r\n\r\nbody\r\n.\r\n" }));
    const imap = { ...endpoint, port: input.security === "starttls" ? 143 as const : 993 as const };
    if (!input.read) return json(await testImapConnection(imap, username, authentication));
    const result = await readImapMessages(imap, username, authentication);
    return json({ inbox: result.inbox, cursor: result.cursor, items: result.items.length, complete: result.complete });
  } catch (error) { return json({ error: error instanceof HttpError ? error.code : "synthetic_test_failure" }, error instanceof HttpError ? error.status : 500); }
} };
