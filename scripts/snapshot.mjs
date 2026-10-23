import fs from "node:fs";
import { Contract, JsonRpcProvider, keccak256, toUtf8Bytes } from "ethers";
import { makeTree } from "./shared.mjs";
const config = JSON.parse(fs.readFileSync("public/config.json", "utf8"));
const provider = new JsonRpcProvider(process.env.RPC_URL || config.rpcUrl);
try {
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.chainId)
    throw Error("Wrong RPC chain");
  const blockNumber = process.env.SNAPSHOT_BLOCK
    ? Number(process.env.SNAPSHOT_BLOCK)
    : (await provider.getBlockNumber()) - 256;
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 1)
    throw Error("Invalid snapshot block");
  const latest = await provider.getBlockNumber();
  if (blockNumber > latest - 128)
    throw Error("Use a snapshot at least 128 blocks deep");
  const block = await provider.getBlock(blockNumber);
  const auction = new Contract(
    config.auction,
    [
      "event AuctionSettled(uint256 indexed tokenId,address winner,uint256 amount)",
      "function town() view returns(address)",
      "function mana() view returns(address)",
      "function owner() view returns(address)",
    ],
    provider,
  );
  for (const [method, expected] of [
    ["town", config.town],
    ["mana", config.mana],
    ["owner", config.governor],
  ])
    if (
      (await auction[method]({ blockTag: blockNumber })).toLowerCase() !==
      expected.toLowerCase()
    )
      throw Error(`Auction ${method} mismatch`);
  // Find deployment without trusting a hand-entered start block.
  let low = 0,
    high = blockNumber;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((await provider.getCode(config.auction, mid)) === "0x") low = mid + 1;
    else high = mid;
  }
  const fromBlock = low;
  let cursor = fromBlock,
    span = blockNumber - fromBlock + 1;
  const events = [];
  while (cursor <= blockNumber) {
    const end = Math.min(cursor + span - 1, blockNumber);
    try {
      events.push(
        ...(await auction.queryFilter(
          auction.filters.AuctionSettled(),
          cursor,
          end,
        )),
      );
      cursor = end + 1;
      console.log(`Scanned through ${end}: ${events.length} settlements`);
    } catch (error) {
      if (span <= 100) throw error;
      span = Math.max(100, Math.floor(span / 2));
    }
  }
  const seen = new Set();
  const refunds = [];
  for (const event of events) {
    const [tokenId, winner, amount] = event.args;
    if (seen.has(String(tokenId)))
      throw Error(`Duplicate settlement ${tokenId}`);
    seen.add(String(tokenId));
    if (amount > 0n)
      refunds.push({
        tokenId: String(tokenId),
        amount: String(amount),
        winner,
        transactionHash: event.transactionHash,
        settlementBlock: event.blockNumber,
      });
  }
  refunds.sort((a, b) => (BigInt(a.tokenId) < BigInt(b.tokenId) ? -1 : 1));
  if (!refunds.length) throw Error("No settled positive-price auctions");
  const town = new Contract(
    config.town,
    [
      "function ownerOf(uint256) view returns(address)",
      "function totalSupply() view returns(uint256)",
    ],
    provider,
  );
  for (const refund of refunds)
    await town.ownerOf(refund.tokenId, { blockTag: blockNumber });
  const totalAllocation = refunds
    .reduce((sum, r) => sum + BigInt(r.amount), 0n)
    .toString();
  const snapshot = {
    version: 1,
    chainId: config.chainId,
    town: config.town,
    mana: config.mana,
    auction: config.auction,
    governor: config.governor,
    fromBlock,
    blockNumber,
    blockHash: block.hash,
    totalSupply: String(await town.totalSupply({ blockTag: blockNumber })),
    totalAllocation,
    refunds,
  };
  snapshot.merkleRoot = makeTree(snapshot).root;
  const content = JSON.stringify(snapshot, null, 2) + "\n";
  fs.writeFileSync("public/snapshot.json", content);
  console.log(
    JSON.stringify(
      {
        blockNumber,
        eligible: refunds.length,
        totalAllocation,
        merkleRoot: snapshot.merkleRoot,
        snapshotHash: keccak256(toUtf8Bytes(content)),
      },
      null,
      2,
    ),
  );
} finally {
  provider.destroy();
}
