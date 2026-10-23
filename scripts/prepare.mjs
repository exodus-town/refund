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
  JSON.stringify({ abi: artifact.abi, bytecode: artifact.bytecode }),
);
const hash = keccak256(toUtf8Bytes(text));
fs.mkdirSync("public/snapshots", { recursive: true });
fs.writeFileSync(`public/snapshots/${hash}.json`, text);
const config = JSON.parse(fs.readFileSync("public/config.json", "utf8"));
config.snapshot = `/snapshots/${hash}.json`;
fs.writeFileSync("public/config.json", JSON.stringify(config, null, 2) + "\n");
console.log(
  "Prepared wallet deployment UI. Snapshot hash: " +
    keccak256(toUtf8Bytes(text)),
);
