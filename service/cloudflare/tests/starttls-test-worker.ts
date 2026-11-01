import worker from "../src/worker";
import type { Env } from "../src/contracts";
import { configureStarttlsFixture } from "./starttls-transport-fixture";

export default { fetch(request: Request, env: Env & { TEST_STARTTLS_FIXTURE: string }) {
  configureStarttlsFixture(env.TEST_STARTTLS_FIXTURE); return worker.fetch(request, env);
} };
