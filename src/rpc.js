import { JsonRpcProvider } from "ethers";

const readMethods =
  /^(eth_(chainId|blockNumber|call|estimateGas|gasPrice|maxPriorityFeePerGas|feeHistory|get[A-Za-z]+)|net_version)$/;
const transientError = (error) =>
  error &&
  !/revert/i.test(error.message ?? "") &&
  ([-32603, -32005, -32002].includes(error.code) ||
    /rate limit|too many requests|upstream|internal error|temporarily unavailable|archive|historical state|missing trie node/i.test(
      error.message ?? "",
    ));

/** Read-only transport. Wallet transactions never pass through public RPC failover. */
export function createReadTransport(
  urls,
  chainId,
  { fetchFn = globalThis.fetch, timeoutMs = 8000 } = {},
) {
  const endpoints = [...new Set(urls.filter(Boolean))];
  if (!endpoints.length) throw Error("No Polygon RPC endpoints configured");
  const verified = new Map();
  let preferred = 0;
  async function request(url, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok) throw Error(`RPC HTTP ${response.status}`);
      const data = await response.json();
      if (
        !data ||
        data.jsonrpc !== "2.0" ||
        data.id !== payload.id ||
        !(Object.hasOwn(data, "result") || Object.hasOwn(data, "error"))
      ) {
        throw Error("Invalid RPC response");
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
  async function verify(url) {
    if (!verified.has(url)) {
      const check = request(url, {
        jsonrpc: "2.0",
        id: "refund-chain-check",
        method: "eth_chainId",
        params: [],
      }).then((data) => {
        if (data.error || BigInt(data.result) !== BigInt(chainId))
          throw Error("RPC chain mismatch");
      });
      verified.set(url, check);
    }
    await verified.get(url);
  }
  return async (payload) => {
    // Ethers batching is disabled, avoiding provider-specific batch limits.
    if (Array.isArray(payload) || !readMethods.test(payload.method)) {
      throw Error(
        "Only individual read requests are supported by public RPC failover",
      );
    }
    const start = preferred;
    for (let offset = 0; offset < endpoints.length; offset++) {
      const index = (start + offset) % endpoints.length;
      const url = endpoints[index];
      try {
        await verify(url);
        const data = await request(url, payload);
        if (transientError(data.error))
          throw Error("RPC temporarily unavailable");
        preferred = index;
        // Preserve contract reverts so failed governance/approval checks remain failures.
        return [data];
      } catch {
        verified.delete(url);
      }
    }
    throw Error(
      "Polygon RPC services are unavailable. Use Refresh to retry.",
    );
  };
}

export function createReadProvider(urls, chainId, options) {
  const send = createReadTransport(urls, chainId, options);
  class ReadProvider extends JsonRpcProvider {
    async _send(payload) {
      return send(payload);
    }
  }
  return new ReadProvider(urls[0], chainId, { batchMaxCount: 1 });
}
