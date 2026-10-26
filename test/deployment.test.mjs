import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AbiCoder, Interface, keccak256, toUtf8Bytes } from "ethers";
import { DEPLOYMENT } from "../src/deployment.js";

const refund = "0x4597d46C178C0B11d0F17ACb62bE81555D471524";
const proposalId =
  "109081609158717326940535053193722669125280727004013537787103873027278016885048";

test("the fixed deployment never reads URL or local-storage overrides", async () => {
  const saved = new Map();
  for (const name of ["location", "localStorage"]) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        throw Error(`Untrusted ${name} accessed`);
      },
    });
  }
  try {
    const { DEPLOYMENT: loaded } = await import(
      "../src/deployment.js?refund=0x000000000000000000000000000000000000dead&proposal=evil"
    );
    assert.equal(loaded.redemption, refund);
    assert.equal(loaded.proposalId, proposalId);
    assert.equal(loaded.siteUrl, "https://exodus-town-proposal-9.vercel.app/");
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test("contract addresses and nested proposal actions cannot be overwritten", () => {
  assert.throws(() => {
    DEPLOYMENT.redemption = "0x000000000000000000000000000000000000dead";
  }, TypeError);
  assert.throws(() => {
    DEPLOYMENT.proposal.targets[2] =
      "0x000000000000000000000000000000000000dead";
  }, TypeError);
  assert.throws(() => {
    DEPLOYMENT.proposal.calldatas.push("0x");
  }, TypeError);
  assert.equal(DEPLOYMENT.redemption, refund);
});

test("pinned execution calldata retains the exact posted proposal ID and refund recipient", () => {
  const p = DEPLOYMENT.proposal;
  assert.equal(keccak256(toUtf8Bytes(p.description)), p.descriptionHash);
  const hash = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["address[]", "uint256[]", "bytes[]", "bytes32"],
      [p.targets, p.values, p.calldatas, p.descriptionHash],
    ),
  );
  assert.equal(BigInt(hash).toString(), proposalId);
  assert.equal(p.targets[0], DEPLOYMENT.auction);
  assert.equal(
    p.calldatas[0],
    new Interface(["function pause()"]).encodeFunctionData("pause"),
  );
  const [recipient, amount] = new Interface([
    "function transfer(address,uint256)",
  ]).decodeFunctionData("transfer", p.calldatas[1]);
  assert.equal(recipient, refund);
  assert.equal(amount, 25569340000000000000000n);
  assert.equal(p.targets[2], refund);
});

test("the downloadable snapshot remains pinned byte for byte", () => {
  const text = fs.readFileSync("public/snapshot.json", "utf8");
  assert.equal(keccak256(toUtf8Bytes(text)), DEPLOYMENT.snapshotHash);
  assert.equal(JSON.parse(text).merkleRoot, DEPLOYMENT.merkleRoot);
});
