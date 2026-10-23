# Exodus Town Refund

Public dapp: https://exodus-town-refund.pages.dev

A Polygon dapp and immutable redemption contract for a DAO-approved return of TOWN NFTs in exchange for the MANA originally paid in their settled auctions. NFTs transfer to **ExodusDAO**, and each token can be refunded only once. Both individual and bulk refunds are supported.

## Why a snapshot?

The existing AuctionHouse retains only its current auction in storage. Historical amounts are emitted in `AuctionSettled` events, which an ordinary EVM contract cannot directly query. We reconstruct a reproducible snapshot from those events, commit its Merkle root and file hash in the contract and proposal, and verify every claim onchain. There is no claim server, oracle, mutable root, administrator withdrawal, or claim deadline.

Refund rights follow the **current NFT holder**, not the bidder or snapshot owner. Amounts represent settled auction prices, not secondary-market purchase prices. The snapshot includes only positive-price auctions settled through its block. The unsold current auction and later settlements/mints are excluded. Original TOWN has no public burn method; this contract transfers tokens to the DAO instead. Even if the DAO later transfers a refunded token back out, it cannot be refunded again.

## Published snapshot

- Polygon block: **96,050,645**
- Eligible NFTs: **229** (token IDs 0–228)
- Allocation: **25,569.34 MANA**
- Root: `0xb37eb4c5eac13888782e8ad9a820240e4701363e3727b838344516aa35b1b4e6`
- Exact JSON file keccak256: `0x11cb2dc9e270fca11a72ec801cd20b34856f7925aa549b98437aad2cd08bc9da`

All 229 settlement transaction receipts were independently cross-checked through Alchemy against the snapshot collected through Tenderly. At inspection, the DAO treasury held exactly this allocation. Treasury balances can change before execution. Activation requires full funding, so successful claims do not depend on claim order.

## Existing Polygon contracts

| Contract | Address |
| --- | --- |
| ExodusDAO | `0x7E96f5242D1256E56E15b46EB2Fa1b1152dF5923` |
| TOWN | `0xAE38E6d941Fb364c142CC90df285CEEF85713467` |
| MANA | `0xA1c57f48F0Deb89f569dFbE6E2B7f46D33606fD4` |
| AuctionHouse | `0x0Ff58e235b154dd7785C4829D48948CE114248C4` |

These addresses come from the original [Exodus Town contracts](https://github.com/exodus-town/contracts). The UI also verifies the exact compiled refund runtime (masking only compiler-declared immutable slots), live governor token, auction ownership, snapshot block hash, root, allocation, and deployed refund contract's immutable parameters. Governance currently requires at least 100 total TOWN and 1 delegated vote to propose. Voting delay and period are **43,200 and 302,400 blocks**, respectively; do not assume these represent exact wall-clock days. There is no timelock in this Governor.

## Development

Requires Node.js 22.12+.

```sh
npm ci
npm test
npm run proposal:prepare
npm run dev
```

`npm test` uses locally pinned solc, without downloading a compiler. Tests cover exact reserves, activation authority, ownership and approval checks, invalid proofs, post-snapshot token exclusion, double refunds, batch atomicity, and the entire proposal → vote → execute → refund lifecycle using copies of the original TOWN and ExodusDAO sources. The governance integration also verifies that a refunded NFT returned by the DAO cannot claim twice.

```sh
# Optional: regenerate only when intentionally choosing a NEW snapshot.
RPC_URL=https://polygon.gateway.tenderly.co SNAPSHOT_BLOCK=96050645 npm run snapshot
npm run compile
npm run proposal:prepare
npm run build
npm run deploy
```

Regenerating with a different block changes the committed terms and requires a new contract and proposal. Keep the original hash-named snapshot available permanently. `RPC_URL` should support historical state reads and historical logs. No explorer API key is needed. The generator binary-searches the auction deployment block and adaptively scans event ranges; it fails on incomplete queries rather than skipping failed ranges.

## Deploy and post the real proposal

1. Open the public dapp and connect the intended Polygon wallet. No private key is stored by the dapp.
2. On **Proposal**, click **Deploy refund contract**. The wallet deploys `TownRefund` with the immutable root, file hash, snapshot block, and total allocation. This does not move DAO funds.
3. Click **Prepare proposal** and review all calldata and the complete description. The proposal pauses auctions (unless already paused), transfers the exact MANA allocation to the refund contract, then activates it, all atomically.
4. Share the generated `?refund=0x…` URL with voters. The UI verifies the exact compiled runtime and immutable snapshot parameters, then reconstructs the proposal and reads its state directly from the DAO. To make it the default for visitors without a link, export **config.json** from **Setup & shared configuration**, replace `public/config.json`, commit, push, and redeploy. The snapshot and proposal must be available publicly before voting. Exported setup is also retained locally for continuity; it is not automatically shared with other visitors.
5. Delegate your TOWN to yourself before the governance voting snapshot. Wait at least one mined block before proposing if newly delegated. Click **Post proposal onchain**. The proposer needs enough historical delegated votes and governance must be enabled.
6. Use **Vote** when the proposal is active. After the deadline and successful vote, anyone can use **Execute**.
7. Use **Refund** to select tokens and **Approve bulk refunds**, then **Refund selected**. Existing single-token approvals also work. Bulk approval is ERC721 `setApprovalForAll` for this refund contract only and can be revoked from the UI. Every refund still requires the current owner to call. Large selections can be split into smaller batches if the chain's gas limit requires it; simulation surfaces the failure before submitting.

Once a proposal has been posted, keep its exact actions and description. They determine its ID and are required for execution. The UI computes the proposal ID from the shared payload, so visitors do not depend on a local transaction receipt or an indexer to find its state.

A paused auction can still be settled after it expires under the original AuctionHouse. This proposal does not settle that auction, refund outstanding bids, sweep later proceeds, sell land, or move other DAO assets. Funds from later settlement remain governed by the DAO. This is a MANA refund mechanism, not a complete liquidation of all DAO holdings.

## Contract details

`TownRefund` has no owner or upgrade mechanism. Only the immutable governor can activate it, once, with at least the total allocation deposited. `refund` and `refundBatch` verify an OpenZeppelin StandardMerkleTree proof over `(chainId, townAddress, tokenId, amount)`, verify current ownership, mark claimed, transfer the NFT to the DAO, and pay the holder with `SafeERC20`. Batch failure reverts the entire transaction, including previous transfers. Reentrancy protection covers both entrypoints.

The root commits to the list, not its historical truth: voters must review/reproduce the published snapshot. The contract checks available reserves; the published generator and UI check that the declared allocation equals the sum of leaves. There is no administrator function to correct a wrong root after deployment. Contract tests are included; an independent review is still appropriate before the DAO commits its treasury.

Cloudflare hosts static files only; wallet transactions and RPC reads run in the browser. Public configuration contains no credentials. See `wrangler.jsonc` for the Cloudflare Pages deployment. API keys, if used for local verification, must remain outside the repository.

## Visual design

Uses the dark theme colors and magenta accents from `exodus-town/app`, its Exodus logo, and a parcel-map backdrop following the town’s spiral layout. The borrowed logo is covered by the original license retained in `notices/exodus-town-app-LICENSE`. The map is a visual overview; refund eligibility is determined by the committed snapshot.
