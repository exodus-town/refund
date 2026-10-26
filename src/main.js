import "./style.css";
import { DEPLOYMENT as config } from "./deployment.js";
import {
  relevantStep,
  followLifecycle,
  estimatedBlockTime,
} from "./lifecycle.js";
import { createReadProvider } from "./rpc.js";
import {
  BrowserProvider,
  Contract,
  formatUnits,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import { makeTree, makeProposal, matchesRuntime } from "../scripts/shared.mjs";
import { townABI, manaABI, governorABI, refundABI, auctionABI } from "./abi";

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const short = (s) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "Not deployed");
const states = [
  "Pending",
  "Active",
  "Canceled",
  "Defeated",
  "Succeeded",
  "Queued",
  "Expired",
  "Executed",
];
// Old links still work, but no URL input can select contracts or proposals.
if (location.search)
  history.replaceState(null, "", location.pathname + location.hash);
let selected = new Set();
let previousPhase = null;
function provider(url) {
  return createReadProvider(
    [url, ...(config.rpcFallbackUrls ?? [])],
    config.chainId,
  );
}
let rpc = provider(config.rpcUrl),
  signer,
  account,
  snapshot,
  tree,
  snapshotHash,
  notice = "",
  tab = "proposal",
  busy = false,
  live = {},
  tokens = [],
  healthy = false;
const town = new Contract(config.town, townABI, rpc),
  mana = new Contract(config.mana, manaABI, rpc),
  governor = new Contract(config.governor, governorABI, rpc),
  auction = new Contract(config.auction, auctionABI, rpc);
const money = (n) =>
  Number(formatUnits(n ?? 0n, live.decimals ?? 18)).toLocaleString("en-US", {
    maximumFractionDigits: 4,
  });
function download(name, content) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([content], { type: "application/json" }),
  );
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function link(address) {
  return `<a href="${esc(config.explorer)}/address/${esc(address)}" target="_blank" rel="noreferrer">${esc(short(address))} ↗</a>`;
}
async function loadSnapshot(text) {
  if (keccak256(toUtf8Bytes(text)) !== config.snapshotHash)
    throw Error("Snapshot differs from the pinned deployment");
  const s = JSON.parse(text);
  for (const key of ["chainId", "town", "mana", "auction", "governor"])
    if (String(s[key]).toLowerCase() !== String(config[key]).toLowerCase())
      throw Error(`Snapshot ${key} mismatch`);
  if (
    !Number.isSafeInteger(s.blockNumber) ||
    s.blockNumber < 1 ||
    !/^0x[\da-fA-F]{64}$/.test(s.blockHash)
  )
    throw Error("Invalid snapshot block");
  if (!Array.isArray(s.refunds) || !s.refunds.length)
    throw Error("Empty snapshot");
  const ids = new Set();
  let sum = 0n;
  for (const r of s.refunds) {
    if (
      !/^\d+$/.test(r.tokenId) ||
      !/^\d+$/.test(r.amount) ||
      BigInt(r.amount) <= 0n ||
      ids.has(BigInt(r.tokenId).toString())
    )
      throw Error("Invalid or duplicate snapshot entry");
    ids.add(BigInt(r.tokenId).toString());
    sum += BigInt(r.amount);
  }
  if (String(sum) !== s.totalAllocation) throw Error("Snapshot total mismatch");
  const t = makeTree(s);
  if (t.root !== s.merkleRoot || t.root !== config.merkleRoot)
    throw Error("Snapshot Merkle root mismatch");
  snapshot = s;
  tree = t;
  snapshotHash = keccak256(toUtf8Bytes(text));
}
async function verifyRefund() {
  if (!config.redemption) return;
  const artifact = await fetch("/refund-artifact.json").then((r) => r.json());
  if (!matchesRuntime(await rpc.getCode(config.redemption), artifact))
    throw Error(
      "Plot return contract bytecode does not match the published contract",
    );
  const r = new Contract(config.redemption, refundABI, rpc);
  const values = await Promise.all(
    [
      "town",
      "mana",
      "governor",
      "merkleRoot",
      "snapshotHash",
      "snapshotBlock",
      "totalAllocation",
    ].map((k) => r[k]()),
  );
  const expected = [
    config.town,
    config.mana,
    config.governor,
    snapshot.merkleRoot,
    snapshotHash,
    snapshot.blockNumber,
    snapshot.totalAllocation,
  ];
  values.forEach((v, i) => {
    if (String(v).toLowerCase() !== String(expected[i]).toLowerCase())
      throw Error(
        `Plot return contract ${["town", "mana", "governor", "root", "snapshot hash", "snapshot block", "allocation"][i]} mismatch`,
      );
  });
  live.active = await r.active();
  live.remaining = await r.remainingAllocation();
}
async function refresh() {
  healthy = false;
  const net = await rpc.getNetwork();
  if (Number(net.chainId) !== config.chainId)
    throw Error("RPC is on the wrong network");
  const [
    treasury,
    supply,
    threshold,
    delay,
    period,
    block,
    decimals,
    paused,
    owner,
    daoToken,
  ] = await Promise.all([
    mana.balanceOf(config.governor),
    town.totalSupply(),
    governor.proposalThreshold(),
    governor.votingDelay(),
    governor.votingPeriod(),
    rpc.getBlockNumber(),
    mana.decimals(),
    auction.paused(),
    auction.owner(),
    governor.token(),
  ]);
  if (
    owner.toLowerCase() !== config.governor.toLowerCase() ||
    daoToken.toLowerCase() !== config.town.toLowerCase()
  )
    throw Error("Live DAO configuration differs from expected contracts");
  live = {
    treasury,
    supply,
    threshold,
    delay,
    period,
    block,
    decimals: Number(decimals),
    paused,
  };
  if (snapshot) {
    const b = await rpc.getBlock(snapshot.blockNumber);
    if (b?.hash !== snapshot.blockHash)
      throw Error("Snapshot block hash differs from chain");
    await verifyRefund();
  }
  if (config.proposal && snapshot && config.redemption) {
    // Only permit the exact known refund proposal, including whether pause was included.
    const p = config.proposal;
    const expected = makeProposal(
      config,
      snapshot,
      snapshotHash,
      config.redemption,
      p.targets.length === 2,
    );
    if (JSON.stringify(p) !== JSON.stringify(expected))
      throw Error("Proposal differs from the expected actions");
    live.proposalId = await governor.hashProposal(
      p.targets,
      p.values,
      p.calldatas,
      p.descriptionHash,
    );
    if (String(live.proposalId) !== config.proposalId)
      throw Error("Proposal ID differs from the pinned deployment");
    live.state = Number(await governor.state(BigInt(config.proposalId)));
    if (live.state !== null) {
      [live.start, live.end, live.votes] = await Promise.all([
        governor.proposalSnapshot(live.proposalId),
        governor.proposalDeadline(live.proposalId),
        governor.proposalVotes(live.proposalId),
      ]);
      if (BigInt(block) > live.start)
        live.quorum = await governor.quorum(live.start);
    }
  }
  // Route before loading wallet inventory so execution opens Refund immediately.
  const route = followLifecycle(tab, previousPhase, live);
  tab = route.tab;
  previousPhase = route.phase;
  if (live.start !== undefined) {
    try {
      const [latest, earlier] = await Promise.all([
        rpc.getBlock(block),
        rpc.getBlock(Math.max(0, block - 4096)),
      ]);
      live.timestamp = latest.timestamp;
      live.secondsPerBlock =
        (latest.timestamp - earlier.timestamp) / (block - earlier.number);
    } catch {
      // An unavailable time estimate must not prevent a verified onchain action.
      console.warn("Voting time estimate unavailable");
    }
  }
  tokens = [];
  if (account) {
    live.votingPower = await town.getVotes(account);
    live.delegate = await town.delegates(account);
    if (live.proposalId && live.state !== null)
      live.hasVoted = await governor.hasVoted(live.proposalId, account);
    if (tab === "refund") {
      const count = Number(await town.balanceOf(account));
      const refund = config.redemption
        ? new Contract(config.redemption, refundABI, rpc)
        : null;
      // Chunk wallet inventory reads to stay responsive without flooding public RPCs.
      for (let offset = 0; offset < count; offset += 12) {
        const chunk = await Promise.all(
          Array.from({ length: Math.min(12, count - offset) }, async (_, j) => {
            const id = await town.tokenOfOwnerByIndex(account, offset + j);
            const entry = snapshot?.refunds.find(
              (r) => r.tokenId === String(id),
            );
            const [claimed, approvedAddress, approvedAll] = refund
              ? await Promise.all([
                  refund.claimed(id),
                  town.getApproved(id),
                  town.isApprovedForAll(account, config.redemption),
                ])
              : [false, "", false];
            return {
              id: String(id),
              entry,
              claimed,
              approved:
                approvedAll ||
                approvedAddress.toLowerCase() ===
                  config.redemption?.toLowerCase(),
            };
          }),
        );
        tokens.push(...chunk);
      }
    }
  }
  healthy = true;
  render();
}
function disabled(condition) {
  return condition || busy ? "disabled" : "";
}
function parcelMap() {
  const count = Math.min(Number(live.supply ?? 230), 900);
  let x = 0,
    y = 0,
    direction = 0,
    length = 1,
    step = 0,
    segment = 0;
  const directions = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  const eligible = new Set(
    snapshot?.refunds.map((r) => Number(r.tokenId)) ?? [],
  );
  const owned = new Set(tokens.map((t) => Number(t.id)));
  const tiles = [];
  for (let id = 0; id < count; id++) {
    const fill = owned.has(id)
      ? "#fc9dfe"
      : eligible.has(id)
        ? "#796a88"
        : "#a524b3";
    tiles.push(
      `<rect x="${x * 18 - 8}" y="${-y * 18 - 8}" width="16" height="16" rx="1" fill="${fill}"/>`,
    );
    x += directions[direction][0];
    y += directions[direction][1];
    step++;
    if (step === length) {
      step = 0;
      direction = (direction + 1) % 4;
      segment++;
      if (segment % 2 === 0) length++;
    }
  }
  return `<svg viewBox="-530 -165 1060 330" preserveAspectRatio="xMidYMid slice" role="presentation"><defs><pattern id="atlas-grid" width="18" height="18" patternUnits="userSpaceOnUse" x="-8" y="-8"><rect width="16" height="16" rx="1" fill="#29242f"/></pattern><radialGradient id="atlas-shade"><stop offset="0" stop-color="#18141a" stop-opacity="0"/><stop offset="1" stop-color="#18141a" stop-opacity=".72"/></radialGradient></defs><rect x="-800" y="-400" width="1600" height="800" fill="url(#atlas-grid)"/><g>${tiles.join("")}</g><rect x="-800" y="-400" width="1600" height="800" fill="url(#atlas-shade)"/></svg>`;
}
function render() {
  const stage = ["proposal", "vote", "execute", "refund"].indexOf(
    relevantStep(live),
  );
  $("#app").innerHTML =
    `<header><a class="brand" href="/" aria-label="Exodus Town Proposal #9 home"><img class="brand-logo" src="/exodus-logo.svg" alt=""> <span>Exodus Town</span><span class="slash">/</span><strong>Proposal #9</strong></a><div class="header-right"><a class="town-link" href="https://exodus.town" target="_blank" rel="noreferrer">TOWN ↗</a><span class="network"><i></i> Polygon</span><button id="connect" class="outline" ${disabled(false)}>${account ? esc(short(account)) : "Connect wallet"}</button></div></header>
 <div class="atlas-banner" aria-hidden="true">${parcelMap()}<div class="atlas-caption">EXODUS TOWN <span>ONE PARCEL AT A TIME</span></div></div><main><section class="hero"><div><p class="eyebrow">EXODUS DAO · PROPOSAL #9</p><h1>Unwind the Exodus DAO<br><em>Return your plot for its minting cost.</em></h1><p class="intro">Proposal #9 asks TOWN holders to wind down the DAO. If it passes, every citizen can hand their plot back to the DAO for the MANA it cost to mint at auction.<br>Decided by vote. Executed onchain.</p></div><div class="hero-badge"><img src="/exodus-logo.svg" alt=""><div><span>EXODUS DAO</span><strong>Proposal #9</strong><small>On Polygon</small></div></div></section>
 <section class="stats" aria-label="Proposal overview"><div><span>DAO TREASURY</span><strong>${live.treasury !== undefined ? money(live.treasury) : "—"} <small>MANA</small></strong></div><div><span>MINTING COSTS</span><strong>${snapshot ? money(snapshot.totalAllocation) : "—"} <small>MANA</small></strong></div><div><span>PLOTS COVERED</span><strong>${snapshot ? snapshot.refunds.length : "—"} <small>TOWN</small></strong></div><div><span>SNAPSHOT BLOCK</span><strong class="block-number">${snapshot ? snapshot.blockNumber.toLocaleString() : "Not prepared"}</strong></div></section>
 <nav class="steps" aria-label="Proposal lifecycle">${["01 · Proposal", "02 · Vote", "03 · Execute", "04 · Return plots"].map((s, i) => `<button data-tab="${["proposal", "vote", "execute", "refund"][i]}" class="${tab === ["proposal", "vote", "execute", "refund"][i] ? "selected" : ""}">${s}${i === stage ? "<i></i>" : ""}</button>`).join("")}</nav>
 ${notice ? `<div class="notice" role="status">${esc(notice)}</div>` : ""}
 <div class="workspace"><section class="primary">${tab === "proposal" ? proposalView() : tab === "vote" ? voteView() : tab === "execute" ? executeView() : refundView()}</section>
 <aside><p class="eyebrow">IF IT PASSES</p><h3>One plot.<br>Its minting cost.</h3><p>The right to return a plot travels with the TOWN NFT: whoever holds it can hand it back for the MANA paid when it was minted at auction.</p><ul><li>Returned plots go to ExodusDAO.</li><li>Each plot can be returned once.</li><li>Plots minted after the snapshot are not covered.</li><li>No deadline.</li></ul><hr><span class="detail-label">CONTRACTS · POLYGON</span><div class="contract-row">ExodusDAO ${link(config.governor)}</div><div class="contract-row">TOWN ${link(config.town)}</div><div class="contract-row">MANA ${link(config.mana)}</div>${config.redemption ? `<div class="contract-row">Plot return ${link(config.redemption)}</div>` : ""}<a class="source-link" href="https://github.com/exodus-town/refund" target="_blank" rel="noreferrer">Read the source ↗</a></aside></div>
 <section class="transparency"><div><span class="eyebrow">PUBLIC BY DESIGN</span><h3>Every amount is verifiable.</h3></div><p>The snapshot lists each plot’s settled auction price, token ID, and transaction hash. Its Merkle root and file hash are fixed in the plot return contract and in the proposal.</p><button id="download-snapshot" class="outline" ${disabled(!snapshot)}>Download snapshot ↓</button></section>
 <footer><span>EXODUS TOWN · PROPOSAL #9</span><span>Community governed. Onchain settled.</span></footer></main>`;
  bind();
}
function proposalView() {
  const p = config.proposal;
  return `<p class="eyebrow">01 / THE PROPOSAL</p><h2>Proposal #9: unwind the Exodus DAO</h2><p>Posted to ExodusDAO and pinned in this app. If it passes, one transaction pauses auctions, moves the plots’ total minting cost from the treasury into the plot return contract, and opens returns.</p><div class="status-pill">${live.active ? "Returns are open" : live.state !== undefined ? states[live.state] : "Checking proposal"}</div><div class="data-line"><span>Plot return contract</span>${link(config.redemption)}</div><div class="data-line"><span>Snapshot root</span><code>${esc(short(config.merkleRoot))}</code></div><div class="data-line"><span>Snapshot file hash</span><code>${esc(short(config.snapshotHash))}</code></div><div class="data-line"><span>Set aside from treasury</span><b>${snapshot ? money(snapshot.totalAllocation) : "—"} MANA</b></div><div class="actions"><button id="refresh" class="outline" ${disabled(false)}>Refresh</button><a href="${config.explorer}/tx/${config.proposalTransaction}" target="_blank" rel="noreferrer">View posted proposal ↗</a></div><details><summary>Review the complete proposal</summary><p class="fine">This is the exact text and actions posted onchain. They can’t be edited after posting.</p><pre>${esc(p.description)}</pre><pre>${esc(JSON.stringify({ proposalId: config.proposalId, targets: p.targets, values: p.values, calldatas: p.calldatas }, null, 2))}</pre></details><label>Share this proposal<input readonly value="${config.siteUrl}" aria-label="Share this proposal"></label>`;
}
function votingEstimate(block) {
  if (!live.secondsPerBlock || !live.timestamp)
    return "Calculated after the next refresh";
  const time = estimatedBlockTime(
    block,
    live.block,
    live.timestamp,
    live.secondsPerBlock,
  );
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(time));
}
function voteView() {
  const exists = live.state !== undefined && live.state !== null;
  const pending = live.state === 0;
  const timing = exists
    ? `<div class="data-line"><span>Voting opens</span><b>${pending ? `~ ${esc(votingEstimate(live.start + 1n))}` : live.state === 1 ? "Open now" : "Voting ended"}</b></div><div class="data-line"><span>Voting closes</span><b>${[0, 1].includes(live.state) ? `~ ${esc(votingEstimate(live.end + 1n))}` : "Closed"}</b></div><p class="fine">${pending ? `Voting opens in ${(live.start + 1n - BigInt(live.block)).toLocaleString()} blocks. Delegate before block ${live.start.toLocaleString()} to participate. ` : ""}Times are estimates based on recent Polygon blocks. The onchain block numbers determine the actual voting window.</p>`
    : "";
  return `<p class="eyebrow">02 / HAVE YOUR SAY</p><h2>${pending ? "The proposal is posted. Voting opens soon." : "A decision we make together."}</h2><p>Delegate your TOWN voting power before the proposal’s voting snapshot. Delegation after that block applies to future proposals.</p>${exists ? `<div class="status-pill">${states[live.state]}</div>${timing}<div class="vote-totals"><div><span>FOR</span><strong>${live.votes?.forVotes ?? 0}</strong></div><div><span>AGAINST</span><strong>${live.votes?.againstVotes ?? 0}</strong></div><div><span>ABSTAIN</span><strong>${live.votes?.abstainVotes ?? 0}</strong></div></div><div class="data-line"><span>Voting blocks (inclusive)</span><code>${live.start + 1n} → ${live.end}</code></div><div class="data-line"><span>Quorum (for + abstain)</span><b>${live.quorum ?? "Set at voting snapshot"}</b></div><p class="fine">Current block: ${live.block}. ${live.hasVoted ? "Your vote has been recorded." : ""}</p>` : '<div class="empty">Voting will open after the proposal is posted and its voting delay has elapsed.</div>'}<div class="actions"><button data-vote="1" ${disabled(!account || !healthy || live.state !== 1 || live.hasVoted)}>Vote for</button><button data-vote="0" class="outline" ${disabled(!account || !healthy || live.state !== 1 || live.hasVoted)}>Against</button><button data-vote="2" class="outline" ${disabled(!account || !healthy || live.state !== 1 || live.hasVoted)}>Abstain</button><button id="refresh" class="outline" ${disabled(false)}>Refresh</button></div><hr><div class="data-line"><span>Your delegated power now</span><b>${live.votingPower ?? "Connect wallet"}</b></div><button id="delegate" class="outline" ${disabled(!account || !healthy)}>Delegate to myself</button>`;
}
function executeView() {
  return `<p class="eyebrow">03 / PUT THE VOTE INTO ACTION</p><h2>Approved by the DAO.<br>Executed by anyone.</h2><p>Once the vote passes, one transaction ${config.proposal?.targets.length === 2 ? "" : "pauses the auctions, "}transfers the plots’ total minting cost from the DAO and opens returns. All actions succeed together or revert together.</p><div class="status-pill">${live.state !== undefined && live.state !== null ? states[live.state] : "Awaiting proposal"}</div><div class="data-line"><span>MANA set aside</span><b>${snapshot ? money(snapshot.totalAllocation) : "—"}</b></div><div class="data-line"><span>Plot return contract</span>${config.redemption ? link(config.redemption) : "<span>Not deployed yet</span>"}</div><div class="actions"><button id="execute" ${disabled(!account || !healthy || live.state !== 4)}>Execute proposal ↗</button><button id="refresh" class="outline">Refresh</button></div><p class="fine">This DAO has no timelock. Execution becomes available when voting ends and the proposal succeeds.</p>`;
}
function refundView() {
  return `<p class="eyebrow">04 / RETURN YOUR PLOTS</p><h2>Return your plots.</h2><p>Select your plots, approve once, then return them together. Each plot transfers to ExodusDAO and its minting cost in MANA arrives in your wallet in the same transaction.</p><div class="status-pill">${live.active ? "Returns are open" : "Opens after the proposal is executed"}</div>${!account ? '<div class="empty">Connect your wallet to see your TOWN tokens.</div>' : !tokens.length ? '<div class="empty">This wallet holds no TOWN tokens.</div>' : `<div class="batch-bar"><label class="select-all"><input id="select-all" type="checkbox" ${tokens.filter((t) => t.entry && !t.claimed).every((t) => selected.has(t.id)) ? "checked" : ""}> Select all covered</label><span>${tokens.filter((t) => selected.has(t.id) && t.entry && !t.claimed).length} selected · ${money(tokens.filter((t) => selected.has(t.id) && t.entry && !t.claimed).reduce((sum, t) => sum + BigInt(t.entry.amount), 0n))} MANA</span></div><div class="token-list">${tokens.map((t) => `<article class="token"><input class="token-select" aria-label="Select TOWN #${esc(t.id)}" type="checkbox" data-select="${esc(t.id)}" ${selected.has(t.id) ? "checked" : ""} ${disabled(!t.entry || t.claimed)}><div class="parcel-icon">⌗<span>${esc(t.id)}</span></div><div class="token-info"><h3>TOWN #${esc(t.id)}</h3><span>${t.claimed ? "Already returned" : t.entry ? `${money(t.entry.amount)} MANA` : "Not covered by the snapshot"}</span></div><button data-token="${esc(t.id)}" ${disabled(!healthy || !live.active || !t.entry || t.claimed)}>${t.claimed ? "Returned" : t.approved ? "Return ↗" : "Approve plot"}</button></article>`).join("")}</div><div class="actions"><button id="refund-batch" ${disabled(!healthy || !live.active || !tokens.some((t) => selected.has(t.id) && t.entry && !t.claimed))}>${tokens.filter((t) => selected.has(t.id) && t.entry && !t.claimed).every((t) => t.approved) ? "Return selected ↗" : "Approve all plots"}</button><button id="revoke" class="outline" ${disabled(!healthy || !config.redemption)}>Revoke approval</button></div>`}<p class="fine">Approving one plot covers only that plot. Approving all lets the plot return contract move your TOWN when you return them; you can revoke it here. Only the current holder can return a plot, including plots transferred after the snapshot. A plot can be returned only once.</p>`;
}
async function run(fn) {
  if (busy) return;
  busy = true;
  notice = "";
  render();
  try {
    await fn();
  } catch (e) {
    notice = e.shortMessage || e.reason || e.message;
    console.error(e);
  } finally {
    try {
      await refresh();
    } catch (e) {
      healthy = false;
      notice =
        notice ||
        `Unable to verify live chain data: ${e.shortMessage || e.message}`;
    }
    busy = false;
    render();
  }
}
async function wallet() {
  if (!window.ethereum) throw Error("Install an Ethereum wallet to continue");
  const p = new BrowserProvider(window.ethereum);
  await p.send("eth_requestAccounts", []);
  if (Number((await p.getNetwork()).chainId) !== config.chainId) {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x" + config.chainId.toString(16) }],
    });
  }
  const ready = new BrowserProvider(window.ethereum);
  if (Number((await ready.getNetwork()).chainId) !== config.chainId)
    throw Error("Switch the wallet to Polygon");
  signer = await ready.getSigner();
  account = await signer.getAddress();
}
async function send(contract, method, args = []) {
  await wallet();
  await contract.connect(signer)[method].staticCall(...args);
  const tx = await contract.connect(signer)[method](...args);
  notice = `Transaction submitted: ${tx.hash}`;
  render();
  await tx.wait();
  notice = "Transaction confirmed.";
}
function bind() {
  document.querySelectorAll("[data-select]").forEach(
    (el) =>
      (el.onchange = () => {
        el.checked
          ? selected.add(el.dataset.select)
          : selected.delete(el.dataset.select);
        render();
      }),
  );
  $("#select-all")?.addEventListener("change", (e) => {
    selected = e.target.checked
      ? new Set(tokens.filter((t) => t.entry && !t.claimed).map((t) => t.id))
      : new Set();
    render();
  });
  $("#revoke")?.addEventListener("click", () =>
    run(() => send(town, "setApprovalForAll", [config.redemption, false])),
  );
  $("#refund-batch")?.addEventListener("click", () =>
    run(async () => {
      const batch = tokens.filter(
        (t) => selected.has(t.id) && t.entry && !t.claimed,
      );
      if (!batch.length) throw Error("Select at least one token");
      if (!batch.every((t) => t.approved)) {
        await send(town, "setApprovalForAll", [config.redemption, true]);
        return;
      }
      await send(
        new Contract(config.redemption, refundABI, rpc),
        "refundBatch",
        [
          batch.map((t) => t.id),
          batch.map((t) => t.entry.amount),
          batch.map((t) =>
            tree.getProof(
              snapshot.refunds.findIndex((r) => r.tokenId === t.id),
            ),
          ),
        ],
      );
      selected = new Set();
    }),
  );
  $("#connect").onclick = () => run(wallet);
  document.querySelectorAll("[data-tab]").forEach(
    (el) =>
      (el.onclick = () => {
        tab = el.dataset.tab;
        if (tab === "refund" && account) run(async () => {});
        else render();
      }),
  );
  $("#refresh")?.addEventListener("click", () => run(async () => {}));
  $("#download-snapshot").onclick = () => {
    if (snapshot) download("snapshot.json", snapshotText);
  };
  $("#delegate")?.addEventListener("click", () =>
    run(async () => {
      await wallet();
      await send(town, "delegate", [account]);
    }),
  );
  document
    .querySelectorAll("[data-vote]")
    .forEach(
      (el) =>
        (el.onclick = () =>
          run(() =>
            send(governor, "castVote", [
              live.proposalId,
              Number(el.dataset.vote),
            ]),
          )),
    );
  $("#execute")?.addEventListener("click", () =>
    run(async () => {
      const p = config.proposal;
      await send(governor, "execute", [
        p.targets,
        p.values,
        p.calldatas,
        p.descriptionHash,
      ]);
    }),
  );
  document.querySelectorAll("[data-token]").forEach(
    (el) =>
      (el.onclick = () =>
        run(async () => {
          const t = tokens.find((t) => t.id === el.dataset.token);
          if (!t.approved) {
            await send(town, "approve", [config.redemption, t.id]);
            return;
          }
          const index = snapshot.refunds.findIndex((r) => r.tokenId === t.id);
          await send(
            new Contract(config.redemption, refundABI, rpc),
            "refund",
            [t.id, t.entry.amount, tree.getProof(index)],
          );
        })),
  );
}
let snapshotText;
render();
try {
  if (config.snapshot) {
    const response = await fetch(config.snapshot);
    if (!response.ok) throw Error("Published snapshot unavailable");
    snapshotText = await response.text();
    await loadSnapshot(snapshotText);
  }
  await refresh();
} catch (e) {
  notice = `Unable to verify live data: ${e.shortMessage || e.message}`;
  render();
}
window.ethereum?.on?.("accountsChanged", () => {
  account = null;
  signer = null;
  run(async () => {});
});
window.ethereum?.on?.("chainChanged", () => {
  account = null;
  signer = null;
  run(async () => {});
});
setInterval(() => {
  if (!busy) run(async () => {});
}, 45000);
