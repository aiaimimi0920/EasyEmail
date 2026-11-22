import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../web/agent-services-api.ts", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "browser" });
const { readAgentServiceReceipt } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
const key = crypto.randomUUID(), id = crypto.randomUUID();
const attempt = { key, method: "PATCH", path: `/agent-services/${id}`, body: { expectedVersion: 7, trustLevel: "blocked" } };
const good = { requestKey: key, serviceId: id, kind: "PATCH", version: 8, deleted: false, completedAt: 1793356800 };

test("service receipts validate immutable target, original key/method/version, completion and delete semantics", () => {
  assert.deepEqual(readAgentServiceReceipt({ operation: good }, attempt), good);
  for (const value of [null, [], {}, { operation: {} }, { operation: [] }, ...[
    { requestKey: crypto.randomUUID() }, { serviceId: crypto.randomUUID() }, { serviceId: "invalid" }, { kind: "POST" },
    { version: 9 }, { version: "8" }, { deleted: true }, { completedAt: null }, { completedAt: -1 }, { completedAt: 1.5 },
  ].map(patch => ({ operation: { ...good, ...patch } }))]) {
    assert.throws(() => readAgentServiceReceipt(value, attempt), error => error.status === 502 && error.message === "agent_service_receipt_invalid");
  }
  const deletion = { ...attempt, method: "DELETE" }, deleted = { ...good, kind: "DELETE", deleted: true };
  assert.deepEqual(readAgentServiceReceipt({ operation: deleted }, deletion), deleted);
  assert.throws(() => readAgentServiceReceipt({ operation: good }, deletion));
  const creation = { key, method: "POST", path: "/agent-services", body: {} }, created = { ...good, kind: "POST", version: 1 };
  assert.deepEqual(readAgentServiceReceipt({ operation: created }, creation), created);
  assert.throws(() => readAgentServiceReceipt({ operation: { ...created, version: 2 } }, creation));
});
