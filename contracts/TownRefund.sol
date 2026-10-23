// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/// @notice One immutable snapshot. Only the DAO can activate fully funded redemption.
/// @dev TOWN has no burn function: refunded NFTs are transferred to ExodusDAO.
contract TownRefund is ReentrancyGuard {
    using SafeERC20 for IERC20;
    IERC721 public immutable town;
    IERC20 public immutable mana;
    address public immutable governor;
    bytes32 public immutable merkleRoot;
    bytes32 public immutable snapshotHash;
    uint256 public immutable snapshotBlock;
    uint256 public immutable totalAllocation;
    uint256 public remainingAllocation;
    bool public active;
    mapping(uint256 => bool) public claimed;

    event Activated(bytes32 indexed root, uint256 allocation);
    event Refunded(address indexed holder, uint256 indexed tokenId, uint256 amount);

    constructor(address town_, address mana_, address governor_, bytes32 root_, bytes32 snapshotHash_, uint256 block_, uint256 total_) {
        require(town_ != address(0) && mana_ != address(0) && governor_ != address(0), "Zero address");
        require(root_ != bytes32(0) && snapshotHash_ != bytes32(0) && total_ > 0, "Invalid snapshot");
        require(block_ < block.number, "Snapshot not historical");
        town = IERC721(town_);
        mana = IERC20(mana_);
        governor = governor_;
        merkleRoot = root_;
        snapshotHash = snapshotHash_;
        snapshotBlock = block_;
        totalAllocation = total_;
    }

    function activate() external {
        require(msg.sender == governor, "Only governor");
        require(!active, "Already active");
        require(mana.balanceOf(address(this)) >= totalAllocation, "Not fully funded");
        remainingAllocation = totalAllocation;
        active = true;
        emit Activated(merkleRoot, totalAllocation);
    }

    function refund(uint256 tokenId, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        _refund(tokenId, amount, proof);
    }

    /// @notice Refund multiple NFTs atomically. Each token requires its own proof.
    function refundBatch(uint256[] calldata tokenIds, uint256[] calldata amounts, bytes32[][] calldata proofs) external nonReentrant {
        require(tokenIds.length > 0, "Empty batch");
        require(tokenIds.length == amounts.length && tokenIds.length == proofs.length, "Length mismatch");
        for (uint256 i; i < tokenIds.length; ++i) {
            _refund(tokenIds[i], amounts[i], proofs[i]);
        }
    }

    function _refund(uint256 tokenId, uint256 amount, bytes32[] calldata proof) internal {
        require(active, "Not active");
        require(!claimed[tokenId], "Already claimed");
        require(amount > 0, "Zero refund");
        // OpenZeppelin StandardMerkleTree uses double-hashed ABI-encoded leaves.
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(block.chainid, address(town), tokenId, amount))));
        require(MerkleProof.verifyCalldata(proof, merkleRoot, leaf), "Invalid proof");
        require(town.ownerOf(tokenId) == msg.sender, "Not token owner");
        claimed[tokenId] = true;
        remainingAllocation -= amount;
        // Use transferFrom: the DAO does not need an ERC721 receiver callback.
        town.transferFrom(msg.sender, governor, tokenId);
        mana.safeTransfer(msg.sender, amount);
        emit Refunded(msg.sender, tokenId, amount);
    }
}
