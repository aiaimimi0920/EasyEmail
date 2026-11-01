import worker from "../src/worker";
import type { Env } from "../src/contracts";
import { configureImapFixture } from "./normal-imap-transport-fixture";
export default {
  async fetch(request: Request, env: Env & { TEST_IMAP_FIXTURE: string }, context: ExecutionContext) {
    configureImapFixture(env.TEST_IMAP_FIXTURE);
    return worker.fetch(request, env, context);
  },
};
