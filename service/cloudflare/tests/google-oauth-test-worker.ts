import worker from "../src/worker";
import type { Env } from "../src/contracts";
import { configureStarttlsFixture } from "./starttls-transport-fixture";

// Only transport replacement, no synthetic authentication or business routes.
export default { ...worker, fetch(request: Request, env: Env) {
  configureStarttlsFixture("https://synthetic-oauth-mail.test");
  return worker.fetch(request, env);
}, scheduled(controller: ScheduledController, env: Env) {
  configureStarttlsFixture("https://synthetic-oauth-mail.test");
  return worker.scheduled(controller, env);
} };
