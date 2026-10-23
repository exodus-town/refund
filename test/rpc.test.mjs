import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadTransport, createReadProvider } from "../src/rpc.js";
const payload = {
  jsonrpc: "2.0",
  id: 7,
  method: "eth_call",
  params: [{}, "latest"],
};
function mock(handler) {
  return async (url, options) => {
    const p = JSON.parse(options.body);
    return handler(url, p, options);
  };
}
function ok(p, result) {
  return { ok: true, json: async () => ({ jsonrpc: "2.0", id: p.id, result }) };
}

test("HTTP 500 fails over, verifies chain, and retains the working endpoint", async () => {
  const seen = [];
  const send = createReadTransport(["broken", "working"], 137, {
    fetchFn: mock((url, p) => {
      seen.push([url, p.method]);
      return url === "broken"
        ? { ok: false, status: 500 }
        : ok(p, p.method === "eth_chainId" ? "0x89" : "0x1234");
    }),
  });
  assert.equal((await send(payload))[0].result, "0x1234");
  await send({ ...payload, id: 8 });
  assert.equal(seen.filter(([u]) => u === "broken").length, 1);
  assert.equal(seen.filter(([, m]) => m === "eth_chainId").length, 2);
});
test("wrong-chain and malformed endpoints cannot supply verification data", async () => {
  const send = createReadTransport(["wrong", "malformed", "working"], 137, {
    fetchFn: mock((url, p) =>
      url === "wrong"
        ? ok(p, "0x1")
        : url === "malformed"
          ? { ok: true, json: async () => ({}) }
          : ok(p, p.method === "eth_chainId" ? "0x89" : "0x42"),
    ),
  });
  assert.equal((await send(payload))[0].result, "0x42");
});
test("rate limits and unsupported historical reads fail over per request", async () => {
  const send = createReadTransport(["limited", "working"], 137, {
    fetchFn: mock((url, p) =>
      p.method === "eth_chainId"
        ? ok(p, "0x89")
        : url === "limited"
          ? {
              ok: true,
              json: async () => ({
                jsonrpc: "2.0",
                id: p.id,
                error: { code: -32005, message: "rate limit" },
              }),
            }
          : ok(p, "0x42"),
    ),
  });
  assert.equal((await send(payload))[0].result, "0x42");
});
test("contract reverts retain their exact error and are not retried as outages", async () => {
  const error = { code: 3, message: "execution reverted", data: "0xdeadbeef" };
  const seen = [];
  const send = createReadTransport(["first", "second"], 137, {
    fetchFn: mock((url, p) => {
      seen.push(url);
      return p.method === "eth_chainId"
        ? ok(p, "0x89")
        : { ok: true, json: async () => ({ jsonrpc: "2.0", id: p.id, error }) };
    }),
  });
  assert.deepEqual((await send(payload))[0].error, error);
  assert.ok(!seen.includes("second"));
});
test("timeouts fail over and all endpoints failing gives a retryable message", async () => {
  const send = createReadTransport(["stalled", "working"], 137, {
    timeoutMs: 5,
    fetchFn: mock((url, p, options) =>
      url === "stalled"
        ? new Promise((_, reject) =>
            options.signal.addEventListener("abort", () =>
              reject(Error("timeout")),
            ),
          )
        : ok(p, p.method === "eth_chainId" ? "0x89" : "0x42"),
    ),
  });
  assert.equal((await send(payload))[0].result, "0x42");
  const down = createReadTransport(["down"], 137, {
    fetchFn: async () => {
      throw Error("offline");
    },
  });
  await assert.rejects(down(payload), /Refresh to retry/);
});
test("public transport never sends wallet transactions or batches", async () => {
  const send = createReadTransport(["rpc"], 137, {
    fetchFn: async () => assert.fail("must not send"),
  });
  await assert.rejects(send({ ...payload, method: "eth_sendRawTransaction" }));
  await assert.rejects(send([payload]));
});
test("ethers provider completes connected-wallet contract reads after a server failure", async () => {
  const provider = createReadProvider(["broken", "working"], 137, {
    fetchFn: mock((url, p) =>
      url === "broken"
        ? { ok: false, status: 500 }
        : ok(
            p,
            p.method === "eth_chainId"
              ? "0x89"
              : p.method === "eth_blockNumber"
                ? "0x100"
                : "0x" + "0".repeat(63) + "1",
          ),
    ),
  });
  try {
    assert.equal((await provider.getNetwork()).chainId, 137n);
    assert.equal(await provider.getBlockNumber(), 256);
    assert.equal(
      await provider.call({
        to: "0x0000000000000000000000000000000000000001",
        data: "0x12345678",
      }),
      "0x" + "0".repeat(63) + "1",
    );
  } finally {
    provider.destroy();
  }
});
