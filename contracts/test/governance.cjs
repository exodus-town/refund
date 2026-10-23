const assert = require("node:assert/strict");
const { ethers, network } = require("hardhat");

describe("ExodusDAO integration (original governance and TOWN sources)", function () {
  it("proposes, votes, executes funding atomically, and refunds the NFT to the DAO", async () => {
    const { StandardMerkleTree } = await import("@openzeppelin/merkle-tree");
    const { makeProposal } = await import("../../scripts/shared.mjs");
    const [owner] = await ethers.getSigners();
    const town = await (await ethers.getContractFactory("TownToken")).deploy();
    const dao = await (
      await ethers.getContractFactory("ExodusDAO")
    ).deploy(town.target, 3);
    const mana = await (await ethers.getContractFactory("TestMana")).deploy();
    const auction = await (
      await ethers.getContractFactory("TestAuction")
    ).deploy(dao.target);
    for (let i = 0; i < 3; i++) await town.mint();
    await town.delegate(owner.address);
    await network.provider.send("hardhat_mine", ["0x2"]);
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const tree = StandardMerkleTree.of(
      [[String(chainId), town.target, "0", "100"]],
      ["uint256", "address", "uint256", "uint256"],
    );
    const snapshot = {
      chainId,
      town: town.target,
      blockNumber: 1,
      blockHash: ethers.id("block"),
      merkleRoot: tree.root,
      totalAllocation: "100",
      refunds: [{ tokenId: "0", amount: "100" }],
    };
    const refund = await (
      await ethers.getContractFactory("TownRefund")
    ).deploy(
      town.target,
      mana.target,
      dao.target,
      tree.root,
      ethers.id("snapshot"),
      1,
      100,
    );
    const proposal = makeProposal(
      { auction: auction.target, mana: mana.target },
      snapshot,
      ethers.id("snapshot"),
      refund.target,
      false,
    );
    await dao.propose(
      proposal.targets,
      proposal.values,
      proposal.calldatas,
      proposal.description,
    );
    const id = await dao.hashProposal(
      proposal.targets,
      proposal.values,
      proposal.calldatas,
      proposal.descriptionHash,
    );
    assert.equal(await dao.state(id), 0n);
    await network.provider.send("hardhat_mine", ["0xa8c1"]);
    await dao.castVote(id, 1);
    await network.provider.send("hardhat_mine", ["0x49d41"]);
    assert.equal(await dao.state(id), 4n);
    // Insufficient funding must roll back pause AND execution status.
    await assert.rejects(
      dao.execute(
        proposal.targets,
        proposal.values,
        proposal.calldatas,
        proposal.descriptionHash,
      ),
    );
    assert.equal(await auction.paused(), false);
    assert.equal(await refund.active(), false);
    assert.equal(await dao.state(id), 4n);
    await mana.mint(dao.target, 100);
    await dao.execute(
      proposal.targets,
      proposal.values,
      proposal.calldatas,
      proposal.descriptionHash,
    );
    assert.equal(await dao.state(id), 7n);
    assert.equal(await auction.paused(), true);
    assert.equal(await refund.active(), true);
    await town.approve(refund.target, 0);
    await refund.refund(0, 100, tree.getProof(0));
    assert.equal(await town.ownerOf(0), dao.target);
    assert.equal(await mana.balanceOf(owner.address), 100n);
    // DAO custody does not restore eligibility if governance later transfers the token back.
    const iface = new ethers.Interface([
      "function transferFrom(address,address,uint256)",
    ]);
    const transfer = [town.target],
      [value] = [0];
    const data = [
      iface.encodeFunctionData("transferFrom", [dao.target, owner.address, 0]),
    ];
    await dao.propose(
      transfer,
      [value],
      data,
      "Return an already refunded NFT",
    );
    const nextId = await dao.hashProposal(
      transfer,
      [value],
      data,
      ethers.id("Return an already refunded NFT"),
    );
    await network.provider.send("hardhat_mine", ["0xa8c1"]);
    await dao.castVote(nextId, 1);
    await network.provider.send("hardhat_mine", ["0x49d41"]);
    await dao.execute(
      transfer,
      [value],
      data,
      ethers.id("Return an already refunded NFT"),
    );
    await town.approve(refund.target, 0);
    await assert.rejects(refund.refund(0, 100, tree.getProof(0)));
  });
});
