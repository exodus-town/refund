// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TestTown is ERC721Enumerable {
    constructor() ERC721("Town", "TOWN") {}
    function mint(address to, uint256 id) external { _mint(to, id); }
}
contract TestMana is ERC20 {
    constructor() ERC20("Mana", "MANA") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}
contract TestAuction {
    address public owner;
    bool public paused;
    constructor(address owner_) { owner = owner_; }
    function pause() external { require(msg.sender == owner, "Not owner"); require(!paused, "Already paused"); paused = true; }
}
