import worker from "../src/worker";
import type { Env } from "../src/contracts";
import { HttpError } from "../src/http";
import { readImapMessages } from "../src/normal-imap-client";
import { parseNormalMime } from "../src/normal-mime-content";
import { configureImapFixture } from "./normal-imap-transport-fixture";

export default {
  async fetch(request: Request, env: Env & { TEST_IMAP_FIXTURE: string }) {
    configureImapFixture(env.TEST_IMAP_FIXTURE, true);
    if (new URL(request.url).pathname !== "/__test/imap-read") return worker.fetch(request, env);
    try {
      const body = await request.json() as { cursor?: import("../src/normal-imap-read").ImapCursor | null };
      const batch = await readImapMessages({ id: "example", label: "Fixture", hostname: "imap.example.test", port: 993 },
        "Alice", "Synthetic-reader-password", body.cursor ?? null);
      const items = await Promise.all(batch.items.map(async item => ({ uid: item.uid, bytes: item.raw.length,
        flags: item.flags, ...(await parseNormalMime(item.raw, "alice@example.test", item.receivedAt)) })));
      return Response.json({ ...batch, items });
    } catch (error) {
      return Response.json({ error: { code: error instanceof HttpError ? error.code : "test_unexpected_error" } },
        { status: error instanceof HttpError ? error.status : 500 });
    }
  },
};
