# Exodus Town Refund

Public dapp: **https://exodus-town-proposal-9.vercel.app** (ExodusDAO proposal #9)

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
# Optional: reproduce the existing pinned snapshot at its original block.
RPC_URL=https://polygon.gateway.tenderly.co SNAPSHOT_BLOCK=96050645 npm run snapshot
npm run compile
npm run proposal:prepare
npm run build
npm run deploy   # Vercel production deploy (project exodus-town-proposal-9)
```

Regenerating with a different block changes the committed terms and requires a new contract and proposal. The preparation script rejects any snapshot that differs from the pinned hash and root. Keep the original hash-named snapshot available permanently. `RPC_URL` should support historical state reads and historical logs. No explorer API key is needed. The generator binary-searches the auction deployment block and adaptively scans event ranges; it fails on incomplete queries rather than skipping failed ranges.

## Use the posted proposal

The public app is pinned at build time to the verified contract and exact posted proposal in `src/deployment.js`. The manifest, including nested transaction actions, is frozen. Contract addresses and proposal parameters cannot be supplied through URL parameters, local storage, uploaded files, or runtime configuration. Legacy query strings are removed from the address bar and ignored. Share the plain URL: https://exodus-town-proposal-9.vercel.app/.

1. Connect your Polygon wallet. No private key is stored by the app.
2. Delegate your TOWN to yourself before the proposal's voting snapshot if you want to vote.
3. Vote while the proposal is active. After a successful vote, anyone can execute the exact pinned proposal.
4. After execution, select eligible tokens on **Return plots**, approve the fixed refund contract, and return the selection. Bulk approval is ERC721 `setApprovalForAll` for that contract only; it can be revoked in the UI. Individual approvals also work. Split large selections if the chain's transaction gas limit requires it.

Deployment, proposal creation, config imports, and snapshot imports have been removed from the live app now that the real contract and proposal exist. A different deployment requires reviewing and rebuilding the source. The existing root, snapshot bytes, and proposal description must remain unchanged.

A paused auction can still be settled after it expires under the original AuctionHouse. This proposal does not settle that auction, refund outstanding bids, sweep later proceeds, sell land, or move other DAO assets. Funds from later settlement remain governed by the DAO. This is a MANA refund mechanism, not a complete liquidation of all DAO holdings.

## Contract details

`TownRefund` has no owner or upgrade mechanism. Only the immutable governor can activate it, once, with at least the total allocation deposited. `refund` and `refundBatch` verify an OpenZeppelin StandardMerkleTree proof over `(chainId, townAddress, tokenId, amount)`, verify current ownership, mark claimed, transfer the NFT to the DAO, and pay the holder with `SafeERC20`. Batch failure reverts the entire transaction, including previous transfers. Reentrancy protection covers both entrypoints.

The root commits to the list, not its historical truth: voters must review/reproduce the published snapshot. The contract checks available reserves; the published generator and UI check that the declared allocation equals the sum of leaves. There is no administrator function to correct a wrong root after deployment. Contract tests are included; an independent review is still appropriate before the DAO commits its treasury.

Vercel hosts static files only; wallet transactions and RPC reads run in the browser. Public configuration contains no credentials. See `vercel.json` for the build output and security headers (they mirror `public/_headers`). Production is the Vercel project `exodus-town-proposal-9`, served at https://exodus-town-proposal-9.vercel.app; `npm run deploy` runs `vercel deploy --prod` from a checkout linked with `vercel link --project exodus-town-proposal-9`. Share only the production URL. The earlier Cloudflare Pages and `exodus-town-refund` deployments are retired. API keys, if used for local verification, must remain outside the repository.

## Visual design

Uses the dark theme colors and magenta accents from `exodus-town/app`, its Exodus logo, and a parcel-map backdrop following the town’s spiral layout. The borrowed logo is covered by the original license retained in `notices/exodus-town-app-LICENSE`. The map is a visual overview; refund eligibility is determined by the committed snapshot.

Live reads use three public Polygon RPC endpoints with chain verification and automatic failover for HTTP errors, timeouts, rate limits, and historical-state outages. Requests are not batched, and wallet transactions continue to use the connected wallet. NFT inventory is loaded only on the Return plots screen. If all endpoints are unavailable, Refresh retries verification and transaction actions remain disabled.

## Current deployment and proposal

The live refund contract is `0x4597d46C178C0B11d0F17ACb62bE81555D471524`, which ExodusDAO's proposal #9 (the DAO's ninth proposal) funds and activates if it passes. The app is at https://exodus-town-proposal-9.vercel.app. Its exact runtime and immutable snapshot parameters were verified. The onchain proposal was posted in [transaction 0xf00204dc…df2fb5](https://polygonscan.com/tx/0xf00204dcf39c04826316b99e6a4d88d812fbdb194a9c22818beb083d23df2fb5). Its targets, calldata, and description match the prepared proposal.

Voting is available from block **96,095,299** through **96,397,698**, inclusive. Delegation must be effective by the proposal snapshot at block **96,095,298**. The Vote screen shows local time estimates based on recent block production; block numbers are authoritative.

The compiled deployment manifest pins this contract, the proposal ID, the exact proposal actions and description, and the snapshot hash. The main URL is the only share link; query strings never select another contract. New visitors land on Vote after posting (including its pending period), Execute after a successful vote, and Return plots after execution. The app checks state every 45 seconds and after wallet actions. Manual navigation remains available to review other steps; a lifecycle transition automatically advances the screen.
