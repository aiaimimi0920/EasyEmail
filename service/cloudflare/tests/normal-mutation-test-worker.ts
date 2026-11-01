import { HttpError } from "../src/http";
import { writeImapMutation } from "../src/normal-imap-client";
import type { ImapMutationCommand, ImapMutationDispatch } from "../src/normal-imap-mutations";
import { configureImapFixture } from "./normal-imap-transport-fixture";

export default {
  async fetch(request: Request, env: { TEST_IMAP_FIXTURE: string }) {
    configureImapFixture(env.TEST_IMAP_FIXTURE, true);
    try {
      const body = await request.json() as { command: ImapMutationCommand; source?: string; destination?: string;
        username?: string; authentication?: string; omitFence?: boolean };
      const fence: ImapMutationDispatch = async (phase, destination) => {
        const response = await fetch(env.TEST_IMAP_FIXTURE + "/phase", { method: "POST", body: JSON.stringify({ phase, destination }) });
        if (!response.ok) throw new HttpError(409, "remote_mutation_target_changed");
      };
      const result = await writeImapMutation({ id: "fixture", label: "Fixture", hostname: "imap.example.test", port: 993 },
        body.username ?? "Alice", body.authentication ?? "Synthetic-mutation-password", body.command,
        body.omitFence ? undefined as unknown as ImapMutationDispatch : fence, body.source, body.destination);
      return Response.json({ result });
    } catch (error) {
      return Response.json({ error: { code: error instanceof HttpError ? error.code : "test_unexpected_error" } },
        { status: error instanceof HttpError ? error.status : 500 });
    }
  },
};
