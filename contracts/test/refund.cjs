const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("TownRefund", function () {
  let owner, alice, bob, town, mana, refund, tree;
  beforeEach(async () => {
    const { StandardMerkleTree } = await import("@openzeppelin/merkle-tree");
    [owner, alice, bob] = await ethers.getSigners();
    town = await (await ethers.getContractFactory("TestTown")).deploy();
    mana = await (await ethers.getContractFactory("TestMana")).deploy();
    await town.mint(alice.address, 0);
    await town.mint(alice.address, 1);
    const chain = (await ethers.provider.getNetwork()).chainId;
    tree = StandardMerkleTree.of(
      [
        [String(chain), town.target, "0", "100"],
        [String(chain), town.target, "1", "250"],
      ],
      ["uint256", "address", "uint256", "uint256"],
    );
    refund = await (
      await ethers.getContractFactory("TownRefund")
    ).deploy(
      town.target,
      mana.target,
      owner.address,
      tree.root,
      ethers.id("snapshot"),
      1,
      350,
    );
  });
  const reject = async (p) => assert.rejects(p);
  async function activate() {
    await mana.mint(refund.target, 350);
    await refund.activate();
  }
  it("requires DAO activation and full reserve", async () => {
    await reject(refund.connect(alice).activate());
    await reject(refund.activate());
    await activate();
    await reject(refund.activate());
    assert.equal(await refund.remainingAllocation(), 350n);
  });
  it("pays the current owner and returns NFT to DAO", async () => {
    await activate();
    await town.connect(alice).transferFrom(alice.address, bob.address, 0);
    await town.connect(bob).approve(refund.target, 0);
    await refund.connect(bob).refund(0, 100, tree.getProof(0));
    assert.equal(await town.ownerOf(0), owner.address);
    assert.equal(await mana.balanceOf(bob.address), 100n);
    assert.equal(await refund.remainingAllocation(), 250n);
    await reject(refund.connect(bob).refund(0, 100, tree.getProof(0)));
  });
  it("rejects inactive, forged, later, and nonowner claims", async () => {
    await reject(refund.connect(alice).refund(0, 100, tree.getProof(0)));
    await activate();
    await reject(refund.connect(bob).refund(0, 100, tree.getProof(0)));
    await reject(refund.connect(alice).refund(0, 250, tree.getProof(0)));
    await town.mint(alice.address, 2);
    await reject(refund.connect(alice).refund(2, 100, tree.getProof(0)));
  });
  it("rolls back accounting when approval is missing", async () => {
    await activate();
    await reject(refund.connect(alice).refund(0, 100, tree.getProof(0)));
    assert.equal(await refund.claimed(0), false);
    assert.equal(await refund.remainingAllocation(), 350n);
  });
  it("redeems every allocation and exhausts the reserve exactly", async () => {
    await activate();
    for (let i = 0; i < 2; i++) {
      await town.connect(alice).approve(refund.target, i);
      await refund
        .connect(alice)
        .refund(i, i === 0 ? 100 : 250, tree.getProof(i));
    }
    assert.equal(await mana.balanceOf(alice.address), 350n);
    assert.equal(await mana.balanceOf(refund.target), 0n);
    assert.equal(await refund.remainingAllocation(), 0n);
  });
  it("bulk refunds multiple tokens in one atomic transaction", async () => {
    await activate();
    await town.connect(alice).setApprovalForAll(refund.target, true);
    await refund
      .connect(alice)
      .refundBatch([0, 1], [100, 250], [tree.getProof(0), tree.getProof(1)]);
    assert.equal(await mana.balanceOf(alice.address), 350n);
    assert.equal(await town.ownerOf(0), owner.address);
    assert.equal(await town.ownerOf(1), owner.address);
    assert.equal(await refund.remainingAllocation(), 0n);
  });
  it("rejects empty, mismatched, duplicated, and partially invalid batches without partial refunds", async () => {
    await activate();
    await town.connect(alice).setApprovalForAll(refund.target, true);
    await reject(refund.connect(alice).refundBatch([], [], []));
    await reject(
      refund.connect(alice).refundBatch([0], [100, 250], [tree.getProof(0)]),
    );
    await reject(
      refund
        .connect(alice)
        .refundBatch([0, 0], [100, 100], [tree.getProof(0), tree.getProof(0)]),
    );
    await reject(
      refund
        .connect(alice)
        .refundBatch([0, 1], [100, 251], [tree.getProof(0), tree.getProof(1)]),
    );
    assert.equal(await refund.claimed(0), false);
    assert.equal(await town.ownerOf(0), alice.address);
    assert.equal(await mana.balanceOf(alice.address), 0n);
    assert.equal(await refund.remainingAllocation(), 350n);
  });
});
