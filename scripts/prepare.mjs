import { DEPLOYMENT } from "../src/deployment.js";
import fs from "node:fs";
import { makeTree } from "./shared.mjs";
import { keccak256, toUtf8Bytes } from "ethers";
const text = fs.readFileSync("public/snapshot.json", "utf8");
const snapshot = JSON.parse(text);
if (makeTree(snapshot).root !== snapshot.merkleRoot)
  throw Error("Snapshot root mismatch");
const artifact = JSON.parse(
  fs.readFileSync("artifacts/contracts/TownRefund.sol/TownRefund.json", "utf8"),
);
fs.writeFileSync(
  "public/refund-artifact.json",
  JSON.stringify({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    deployedBytecode: artifact.deployedBytecode,
    immutableReferences: artifact.immutableReferences,
  }),
);
const hash = keccak256(toUtf8Bytes(text));
if (
  hash !== DEPLOYMENT.snapshotHash ||
  snapshot.merkleRoot !== DEPLOYMENT.merkleRoot
)
  throw Error("Snapshot differs from the pinned deployment");
fs.mkdirSync("public/snapshots", { recursive: true });
fs.writeFileSync(`public/snapshots/${hash}.json`, text);
console.log(
  "Prepared pinned snapshot and runtime verification artifact. Snapshot hash: " +
    keccak256(toUtf8Bytes(text)),
);
