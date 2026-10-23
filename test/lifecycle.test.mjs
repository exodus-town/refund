import { test } from "node:test";
import assert from "node:assert/strict";
import {
  relevantStep,
  followLifecycle,
  estimatedBlockTime,
} from "../src/lifecycle.js";

test("new visitors land on the appropriate step for every proposal state", () => {
  for (const [state, expected] of [
    [undefined, "proposal"],
    [0, "vote"],
    [1, "vote"],
    [2, "vote"],
    [3, "vote"],
    [4, "execute"],
    [5, "execute"],
    [6, "vote"],
    [7, "refund"],
  ]) {
    assert.equal(followLifecycle("proposal", null, { state }).tab, expected);
  }
  assert.equal(relevantStep({ active: true }), "refund");
});
test("visitors can review other tabs until the lifecycle advances", () => {
  assert.deepEqual(followLifecycle("proposal", 1, { state: 1 }), {
    tab: "proposal",
    phase: 1,
  });
  assert.deepEqual(followLifecycle("proposal", 1, { state: 4 }), {
    tab: "execute",
    phase: 4,
  });
  assert.deepEqual(
    followLifecycle("vote", 4, { state: 7, active: true }),
    { tab: "refund", phase: "refund-open" },
  );
});
test("pending voting opens on snapshot + 1, and voting closes on deadline + 1", () => {
  const current = 100,
    timestamp = 1000,
    seconds = 2;
  assert.equal(
    estimatedBlockTime(110n + 1n, current, timestamp, seconds),
    1022000,
  );
  assert.equal(
    estimatedBlockTime(120n + 1n, current, timestamp, seconds),
    1042000,
  );
});

test("voting opening also advances visitors who were reviewing another tab while pending", () => {
 assert.equal(followLifecycle("proposal", 0, {state:1}).tab, "vote");
});
