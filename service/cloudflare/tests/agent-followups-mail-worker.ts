import worker from "./agent-followups-test-worker";
import type { Env } from "../src/contracts";
import { configureImapFixture } from "./normal-imap-transport-fixture";
interface TestEnv extends Env { TEST_SMTP_FIXTURE: string; TEST_IMAP_FIXTURE: string }
export default {
  fetch(request: Request, env: TestEnv, context: ExecutionContext) {
    configureImapFixture(env.TEST_IMAP_FIXTURE); return worker.fetch(request, env, context);
  },
  scheduled(controller: ScheduledController, env: TestEnv) {
    configureImapFixture(env.TEST_IMAP_FIXTURE); return worker.scheduled(controller, env);
  },
};
