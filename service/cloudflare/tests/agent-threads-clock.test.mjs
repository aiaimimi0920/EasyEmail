import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/agent-thread-model.ts", import.meta.url))], bundle: true, write: false, format: "esm", platform: "neutral" });
const { agentThreadView } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
test("thread DTO evaluates pending timeout at the same database snapshot time as its SQL state filter", () => {
  const row = { thread_observed_at: 100, outgoing_state: "pending", submitted_at: 41, thread_state: "draft", job_state: "submitted",
    management_state: null, management_revision: null, management_updated_at: null };
  const original = Date.now;
  try {
    Date.now = () => 200000;
    assert.equal(agentThreadView(row).management.state, "open"); assert.equal(agentThreadView(row).task.state, "pending");
    row.thread_observed_at = 101;
    assert.equal(agentThreadView(row).management.state, "needs_attention"); assert.equal(agentThreadView(row).task.state, "unknown");
  } finally { Date.now = original; }
});
