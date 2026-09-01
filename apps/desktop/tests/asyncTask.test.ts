import assert from "node:assert/strict";
import test from "node:test";

import { createNonOverlappingAsyncRunner } from "../src/utils/asyncTask.ts";

test("non-overlapping async runner skips concurrent calls and can run again", async () => {
  let releaseFirstRun: (() => void) | undefined;
  let runs = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const runner = createNonOverlappingAsyncRunner(async () => {
    runs += 1;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    if (runs === 1) {
      await new Promise<void>((resolve) => {
        releaseFirstRun = resolve;
      });
    }
    concurrent -= 1;
  });

  const first = runner();
  assert.equal(await runner(), false);
  releaseFirstRun?.();
  assert.equal(await first, true);
  assert.equal(await runner(), true);
  assert.equal(runs, 2);
  assert.equal(maxConcurrent, 1);
});
