import worker from "../src/worker";
import type { Env } from "../src/contracts";
import { configureImapFixture } from "./normal-imap-transport-fixture";

export default {
  async fetch(request: Request, env: Env & { TEST_IMAP_FIXTURE: string }) {
    configureImapFixture(env.TEST_IMAP_FIXTURE, true);
    const bucket = env.INBOX;
    const inbox = bucket && new Proxy(bucket, { get(target, property) {
      if (property === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
        const gate = await fetch(`${env.TEST_IMAP_FIXTURE}/put`, { method: "POST" });
        if (!gate.ok) throw new Error("synthetic-put-failed"); return target.put(...args);
      };
      if (property === "get") return async (key: string) => {
        await fetch(`${env.TEST_IMAP_FIXTURE}/get`, { method: "POST" }); return target.get(key);
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    return worker.fetch(request, { ...env, INBOX: inbox });
  },
};
