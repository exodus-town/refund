import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { Interface, keccak256, toUtf8Bytes } from "ethers";
export const leafTypes = ["uint256", "address", "uint256", "uint256"];
export function makeTree(snapshot) {
  return StandardMerkleTree.of(
    snapshot.refunds.map((r) => [
      String(snapshot.chainId),
      snapshot.town,
      r.tokenId,
      r.amount,
    ]),
    leafTypes,
  );
}
export function makeProposal(config, snapshot, hash, redemption, paused) {
  const erc20 = new Interface(["function transfer(address,uint256)"]);
  const refund = new Interface(["function activate()"]);
  const auction = new Interface(["function pause()"]);
  const targets = paused ? [] : [config.auction];
  const calldatas = paused ? [] : [auction.encodeFunctionData("pause")];
  targets.push(config.mana, redemption);
  calldatas.push(
    erc20.encodeFunctionData("transfer", [
      redemption,
      snapshot.totalAllocation,
    ]),
    refund.encodeFunctionData("activate"),
  );
  const description = `Refund Exodus Town\n\nExchange each eligible TOWN NFT for the MANA paid in its settled auction. Rights follow the current NFT holder. Refunded NFTs are transferred to ExodusDAO. Individual and bulk refunds are supported. No claim deadline.\n\nChain: ${snapshot.chainId}\nSnapshot block: ${snapshot.blockNumber}\nSnapshot block hash: ${snapshot.blockHash}\nSnapshot data: https://raw.githubusercontent.com/exodus-town/refund/main/public/snapshots/${hash}.json\nSnapshot file keccak256: ${hash}\nMerkle root: ${snapshot.merkleRoot}\nEligible NFTs: ${snapshot.refunds.length}\nTotal MANA (base units): ${snapshot.totalAllocation}\nRedemption contract: ${redemption}\n\nOnly settled, positive-price auctions through the snapshot block are eligible. Later auctions and mints are excluded. The active auction is not settled by this proposal. ${paused ? "Auctions are already paused." : "Pause auctions, then"} Transfer the exact allocation from the DAO treasury and activate redemption atomically. Publish the complete snapshot file with this proposal so anyone can reproduce the root.\n\nThis proposal distributes MANA only; it does not liquidate any other DAO assets.`;
  return {
    targets,
    values: targets.map(() => "0"),
    calldatas,
    description,
    descriptionHash: keccak256(toUtf8Bytes(description)),
  };
}

// Compare exact compiled runtime while ignoring only compiler-declared immutable slots.
export function matchesRuntime(actual, artifact) {
  if (!artifact.deployedBytecode || actual.length !== artifact.deployedBytecode.length) return false;
  const normalize = code => {
    let result = code.toLowerCase();
    for (const slots of Object.values(artifact.immutableReferences ?? {})) {
      for (const {start, length} of slots) {
        const offset = 2 + start * 2;
        result = result.slice(0, offset) + '0'.repeat(length * 2) + result.slice(offset + length * 2);
      }
    }
    return result;
  };
  return normalize(actual) === normalize(artifact.deployedBytecode);
}
