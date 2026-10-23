import "./style.css";
import {
  BrowserProvider,
  JsonRpcProvider,
  FetchRequest,
  Contract,
  ContractFactory,
  formatUnits,
  keccak256,
  toUtf8Bytes,
  getAddress,
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
let config = await fetch("/config.json").then((r) => r.json());
const published = { ...config };
try {
  const local = JSON.parse(
    localStorage.getItem("exodus-refund-setup") || "null",
  );
  if (
    local &&
    local.chainId === config.chainId &&
    local.governor === config.governor &&
    !config.redemption
  )
    config = {
      ...config,
      redemption: local.redemption,
      proposal: local.proposal,
    };
} catch {}
const sharedRefund = new URLSearchParams(location.search).get("refund");
if (sharedRefund) {
  try { config = {...config, redemption: getAddress(sharedRefund), proposal: null}; }
  catch { config = {...published}; }
}
function shareURL() { const url = new URL(location.href); url.searchParams.set("refund", config.redemption); return url.href; }
let selected = new Set();
function provider(url) {
  const request = new FetchRequest(url);
  request.timeout = 15000;
  return new JsonRpcProvider(request, config.chainId, { staticNetwork: true });
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
let town = new Contract(config.town, townABI, rpc),
  mana = new Contract(config.mana, manaABI, rpc),
  governor = new Contract(config.governor, governorABI, rpc),
  auction = new Contract(config.auction, auctionABI, rpc);
const money = (n) =>
  Number(formatUnits(n ?? 0n, live.decimals ?? 18)).toLocaleString("en-US", {
    maximumFractionDigits: 4,
  });
function persist() {
  localStorage.setItem("exodus-refund-setup", JSON.stringify(config));
}
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
      throw Error("Invalid or duplicate refund");
    ids.add(BigInt(r.tokenId).toString());
    sum += BigInt(r.amount);
  }
  if (String(sum) !== s.totalAllocation) throw Error("Snapshot total mismatch");
  const t = makeTree(s);
  if (t.root !== s.merkleRoot) throw Error("Snapshot Merkle root mismatch");
  snapshot = s;
  tree = t;
  snapshotHash = keccak256(toUtf8Bytes(text));
}
async function verifyRefund() {
  if (!config.redemption) return;
  const artifact = await fetch('/refund-artifact.json').then(r => r.json());
  if (!matchesRuntime(await rpc.getCode(config.redemption), artifact)) throw Error('Refund runtime bytecode does not match the published contract');
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
        `Refund contract ${["town", "mana", "governor", "root", "snapshot hash", "snapshot block", "allocation"][i]} mismatch`,
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
  if (!config.proposal && snapshot && config.redemption) {
    for (const wasPaused of [false, true]) {
      const p = makeProposal(config, snapshot, snapshotHash, config.redemption, wasPaused);
      const proposalId = await governor.hashProposal(p.targets, p.values, p.calldatas, p.descriptionHash);
      try { await governor.state(proposalId); config.proposal = p; persist(); break; }
      catch (error) { if (error.code !== 'CALL_EXCEPTION') throw error; }
    }
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
      throw Error("Proposal differs from the expected refund actions");
    live.proposalId = await governor.hashProposal(
      p.targets,
      p.values,
      p.calldatas,
      p.descriptionHash,
    );
    try {
      live.state = Number(await governor.state(live.proposalId));
    } catch (e) {
      if (e.code !== "CALL_EXCEPTION") throw e;
      live.state = null;
    }
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
  tokens = [];
  if (account) {
    live.votingPower = await town.getVotes(account);
    live.delegate = await town.delegates(account);
    if (live.proposalId && live.state !== null)
      live.hasVoted = await governor.hasVoted(live.proposalId, account);
    const count = Number(await town.balanceOf(account));
    const refund = config.redemption
      ? new Contract(config.redemption, refundABI, rpc)
      : null;
    // Chunk wallet inventory reads to stay responsive without flooding public RPCs.
    for (let offset = 0; offset < count; offset += 12) {
      const chunk = await Promise.all(
        Array.from({ length: Math.min(12, count - offset) }, async (_, j) => {
          const id = await town.tokenOfOwnerByIndex(account, offset + j);
          const entry = snapshot?.refunds.find((r) => r.tokenId === String(id));
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
  healthy = true;
  render();
}
function disabled(condition) {
  return condition || busy ? "disabled" : "";
}
function render() {
  const stage = live.active
    ? 3
    : live.state === 1
      ? 1
      : live.state === 4
        ? 2
        : 0;
  $("#app").innerHTML =
    `<header><a class="brand" href="/" aria-label="Exodus Town Refund home"><span class="mark">↶</span> exodus town <span class="slash">/</span> <strong>refund</strong></a><div class="header-right"><span class="network"><i></i> Polygon</span><button id="connect" class="outline" ${disabled(false)}>${account ? esc(short(account)) : "Connect wallet"}</button></div></header>
 <main><section class="hero"><div><p class="eyebrow">A COMMUNITY DECISION · EXODUS DAO</p><h1>Bring your TOWN.<br><em>Take your MANA home.</em></h1><p class="intro">A proposal to return each parcel’s original contribution.<br>Decided by the community. Settled onchain.</p></div><div class="hero-seal"><span>EXODUS TOWN</span><b>↶</b><span>THE RETURN JOURNEY</span></div></section>
 <section class="stats" aria-label="Refund overview"><div><span>DAO TREASURY</span><strong>${live.treasury !== undefined ? money(live.treasury) : "—"} <small>MANA</small></strong></div><div><span>PROPOSED REFUND</span><strong>${snapshot ? money(snapshot.totalAllocation) : "—"} <small>MANA</small></strong></div><div><span>ELIGIBLE PARCELS</span><strong>${snapshot ? snapshot.refunds.length : "—"} <small>TOWN</small></strong></div><div><span>SNAPSHOT BLOCK</span><strong class="block-number">${snapshot ? snapshot.blockNumber.toLocaleString() : "Not prepared"}</strong></div></section>
 <nav class="steps" aria-label="Refund lifecycle">${["01 · Proposal", "02 · Vote", "03 · Execute", "04 · Refund"].map((s, i) => `<button data-tab="${["proposal", "vote", "execute", "refund"][i]}" class="${tab === ["proposal", "vote", "execute", "refund"][i] ? "selected" : ""}">${s}${i === stage ? "<i></i>" : ""}</button>`).join("")}</nav>
 ${notice ? `<div class="notice" role="status">${esc(notice)}</div>` : ""}
 <div class="workspace"><section class="primary">${tab === "proposal" ? proposalView() : tab === "vote" ? voteView() : tab === "execute" ? executeView() : refundView()}</section>
 <aside><p class="eyebrow">THE AGREEMENT</p><h3>One parcel.<br>Its original contribution.</h3><p>Refunds follow the NFT, so the current holder can exchange it for the MANA paid at its settled auction.</p><ul><li>TOWN goes to ExodusDAO.</li><li>Each token can be refunded once.</li><li>Later mints are excluded.</li><li>No deadline to claim.</li></ul><hr><span class="detail-label">CONTRACTS · POLYGON</span><div class="contract-row">ExodusDAO ${link(config.governor)}</div><div class="contract-row">TOWN ${link(config.town)}</div><div class="contract-row">MANA ${link(config.mana)}</div>${config.redemption ? `<div class="contract-row">Refund ${link(config.redemption)}</div>` : ""}<a class="source-link" href="https://github.com/exodus-town/refund" target="_blank" rel="noreferrer">Read the source ↗</a></aside></div>
 <section class="transparency"><div><span class="eyebrow">PUBLIC BY DESIGN</span><h3>Every refund is verifiable.</h3></div><p>The snapshot lists settled auction amounts, token IDs, and transaction hashes. Its Merkle root and file hash are fixed in the refund contract and proposal.</p><button id="download-snapshot" class="outline" ${disabled(!snapshot)}>Download snapshot ↓</button></section>
 <footer><span>EXODUS TOWN · THE RETURN JOURNEY</span><span>Community governed. Onchain settled.</span></footer></main>`;
  bind();
}
function proposalView() {
  return `<p class="eyebrow">01 / SET THE TERMS</p><h2>The refund proposal</h2><p>Publish the snapshot, deploy its refund contract, then ask the DAO to fund and activate it.</p><div class="status-pill">${live.active ? "Refunds are open" : live.state !== undefined && live.state !== null ? states[live.state] : snapshot ? "Snapshot prepared" : "Preparing the snapshot"}</div>${snapshot ? `<div class="data-line"><span>Snapshot root</span><code>${esc(short(snapshot.merkleRoot))}</code></div><div class="data-line"><span>Snapshot file hash</span><code>${esc(short(snapshotHash))}</code></div><div class="data-line"><span>Required reserve</span><b>${money(snapshot.totalAllocation)} MANA</b></div>` : '<div class="empty"><b>The snapshot has not been published yet.</b><p>Historical auction data must be verified before a proposal can be posted.</p></div>'}
 ${snapshot && live.treasury !== undefined && live.treasury < BigInt(snapshot.totalAllocation) ? '<div class="warning">The DAO treasury cannot cover this snapshot. The full contribution refund cannot execute without additional funding.</div>' : ""}
 <div class="actions">${!config.redemption ? `<button id="deploy" ${disabled(!account || !snapshot || !healthy)}>Deploy refund contract ↗</button>` : !config.proposal ? `<button id="prepare-proposal" ${disabled(!snapshot || !healthy)}>Prepare proposal</button>` : `<button id="propose" ${disabled(!account || !healthy || live.state !== null || live.treasury < BigInt(snapshot?.totalAllocation ?? 0) || live.votingPower < live.threshold)}>Post proposal onchain ↗</button>`}<button id="refresh" class="outline" ${disabled(false)}>Refresh</button></div>
 ${account ? `<p class="fine">Your delegated voting power: ${live.votingPower ?? "—"}. Proposal threshold: ${live.threshold ?? "—"}. Governance also requires at least 100 total TOWN.</p>` : '<p class="fine">Connect a wallet on Polygon to deploy or propose.</p>'}
 ${config.proposal ? `<details><summary>Review the complete proposal</summary><pre>${esc(config.proposal.description)}</pre><pre>${esc(JSON.stringify({ targets: config.proposal.targets, values: config.proposal.values, calldatas: config.proposal.calldatas }, null, 2))}</pre></details>` : ""}
 ${config.redemption?`<label>Share this refund<input readonly value="${esc(shareURL())}" aria-label="Share this refund"></label>`:""}<details class="setup"><summary>Setup &amp; shared configuration</summary><p>Import a verified snapshot or a published config. Share the refund link after deployment so other holders can discover this proposal directly onchain. You can also export config.json and commit it to make the proposal the site default.</p><label>Snapshot JSON<input id="snapshot-file" type="file" accept="application/json"></label><label>Shared config JSON<input id="config-file" type="file" accept="application/json"></label><button id="export-config" class="outline">Export config.json ↓</button><label>RPC endpoint<input id="rpc-url" type="url" value="${esc(config.rpcUrl)}"></label><button id="set-rpc" class="outline">Use RPC</button></details>`;
}
function voteView() {
  return `<p class="eyebrow">02 / HAVE YOUR SAY</p><h2>A decision we make together.</h2><p>Delegate your TOWN voting power before the proposal’s voting snapshot. Delegation after that block applies to future proposals.</p>${live.state !== undefined && live.state !== null ? `<div class="status-pill">${states[live.state]}</div><div class="vote-totals"><div><span>FOR</span><strong>${live.votes?.forVotes ?? 0}</strong></div><div><span>AGAINST</span><strong>${live.votes?.againstVotes ?? 0}</strong></div><div><span>ABSTAIN</span><strong>${live.votes?.abstainVotes ?? 0}</strong></div></div><div class="data-line"><span>Voting blocks</span><code>${live.start} → ${live.end}</code></div><div class="data-line"><span>Quorum (for + abstain)</span><b>${live.quorum ?? "Set at voting snapshot"}</b></div><p class="fine">Current block: ${live.block}. ${live.hasVoted ? "Your vote has been recorded." : ""}</p>` : '<div class="empty">Voting will open after the proposal is posted and its voting delay has elapsed.</div>'}<div class="actions"><button data-vote="1" ${disabled(!account || !healthy || live.state !== 1 || live.hasVoted)}>Vote for</button><button data-vote="0" class="outline" ${disabled(!account || !healthy || live.state !== 1 || live.hasVoted)}>Against</button><button data-vote="2" class="outline" ${disabled(!account || !healthy || live.state !== 1 || live.hasVoted)}>Abstain</button></div><hr><div class="data-line"><span>Your delegated power now</span><b>${live.votingPower ?? "Connect wallet"}</b></div><button id="delegate" class="outline" ${disabled(!account || !healthy)}>Delegate to myself</button>`;
}
function executeView() {
  return `<p class="eyebrow">03 / PUT THE VOTE INTO ACTION</p><h2>Approved by the DAO.<br>Executed by anyone.</h2><p>Once the vote passes, one transaction ${config.proposal?.targets.length === 2 ? "" : "pauses the auctions, "}transfers the full MANA allocation from the DAO and activates refunds. All actions succeed together or revert together.</p><div class="status-pill">${live.state !== undefined && live.state !== null ? states[live.state] : "Awaiting proposal"}</div><div class="data-line"><span>MANA to fund</span><b>${snapshot ? money(snapshot.totalAllocation) : "—"}</b></div><div class="data-line"><span>Refund contract</span>${config.redemption ? link(config.redemption) : "<span>Not deployed yet</span>"}</div><div class="actions"><button id="execute" ${disabled(!account || !healthy || live.state !== 4)}>Execute proposal ↗</button><button id="refresh" class="outline">Refresh</button></div><p class="fine">This DAO has no timelock. Execution becomes available when voting ends and the proposal succeeds.</p>`;
}
function refundView() {
  return `<p class="eyebrow">04 / THE RETURN JOURNEY</p><h2>Your TOWN, refunded.</h2><p>Select your tokens, approve once, then refund the selection together. The NFT transfers to ExodusDAO and its original MANA contribution arrives in your wallet in the same transaction.</p><div class="status-pill">${live.active ? "Refunds are open" : "Awaiting DAO execution"}</div>${!account ? '<div class="empty">Connect your wallet to see your TOWN tokens.</div>' : !tokens.length ? '<div class="empty">This wallet holds no TOWN tokens.</div>' : `<div class="batch-bar"><label class="select-all"><input id="select-all" type="checkbox" ${tokens.filter((t) => t.entry && !t.claimed).every((t) => selected.has(t.id)) ? "checked" : ""}> Select all eligible</label><span>${tokens.filter((t) => selected.has(t.id) && t.entry && !t.claimed).length} selected · ${money(tokens.filter((t) => selected.has(t.id) && t.entry && !t.claimed).reduce((sum, t) => sum + BigInt(t.entry.amount), 0n))} MANA</span></div><div class="token-list">${tokens.map((t) => `<article class="token"><input class="token-select" aria-label="Select TOWN #${esc(t.id)}" type="checkbox" data-select="${esc(t.id)}" ${selected.has(t.id) ? "checked" : ""} ${disabled(!t.entry || t.claimed)}><div class="parcel-icon">⌗<span>${esc(t.id)}</span></div><div class="token-info"><h3>TOWN #${esc(t.id)}</h3><span>${t.claimed ? "Already refunded" : t.entry ? `${money(t.entry.amount)} MANA` : "Not eligible in this snapshot"}</span></div><button data-token="${esc(t.id)}" ${disabled(!healthy || !live.active || !t.entry || t.claimed)}>${t.claimed ? "Refunded" : t.approved ? "Refund ↗" : "Approve TOWN"}</button></article>`).join("")}</div><div class="actions"><button id="refund-batch" ${disabled(!healthy || !live.active || !tokens.some((t) => selected.has(t.id) && t.entry && !t.claimed))}>${tokens.filter((t) => selected.has(t.id) && t.entry && !t.claimed).every((t) => t.approved) ? "Refund selected ↗" : "Approve bulk refunds"}</button><button id="revoke" class="outline" ${disabled(!healthy || !config.redemption)}>Revoke bulk approval</button></div>`}<p class="fine">Individual approval is for one NFT. Bulk approval authorizes the refund contract for your TOWN collection; you can revoke it below. Refunds always require a transaction from the current owner. The refund is available to its current holder, even if it was transferred after the snapshot. A token that has already been refunded cannot be refunded again.</p>`;
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
    busy = false;
    try {
      await refresh();
    } catch (e) {
      healthy = false;
      notice =
        notice ||
        `Unable to verify live chain data: ${e.shortMessage || e.message}`;
    }
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
        render();
      }),
  );
  $("#refresh")?.addEventListener("click", () => run(async () => {}));
  $("#download-snapshot").onclick = () => {
    if (snapshot) download("snapshot.json", snapshotText);
  };
  $("#snapshot-file")?.addEventListener("change", (e) =>
    run(async () => {
      if (config.redemption)
        throw Error(
          "A refund contract is already configured; use its committed snapshot.",
        );
      snapshotText = await e.target.files[0].text();
      await loadSnapshot(snapshotText);
    }),
  );
  $("#config-file")?.addEventListener("change", (e) =>
    run(async () => {
      const c = JSON.parse(await e.target.files[0].text());
      for (const key of ["chainId", "town", "mana", "auction", "governor"])
        if (
          String(c[key]).toLowerCase() !== String(published[key]).toLowerCase()
        )
          throw Error(`Config ${key} mismatch`);
      if (c.redemption) getAddress(c.redemption);
      const previous = config;
      config = { ...config, redemption: c.redemption, proposal: c.proposal };
      try {
        await refresh();
        persist();
      } catch (error) {
        config = previous;
        throw error;
      }
    }),
  );
  $("#export-config")?.addEventListener("click", () =>
    download("config.json", JSON.stringify(config, null, 2) + "\n"),
  );
  $("#set-rpc")?.addEventListener("click", () =>
    run(async () => {
      const url = new URL($("#rpc-url").value);
      if (!["https:", "http:"].includes(url.protocol))
        throw Error("Expected an HTTP RPC");
      const next = provider(url.href);
      if (Number((await next.getNetwork()).chainId) !== config.chainId)
        throw Error("Wrong RPC chain");
      rpc.destroy();
      rpc = next;
      config.rpcUrl = url.href;
      town = new Contract(config.town, townABI, rpc);
      mana = new Contract(config.mana, manaABI, rpc);
      governor = new Contract(config.governor, governorABI, rpc);
      auction = new Contract(config.auction, auctionABI, rpc);
    }),
  );
  $("#deploy")?.addEventListener("click", () =>
    run(async () => {
      await wallet();
      const a = await fetch("/refund-artifact.json").then((r) => {
        if (!r.ok)
          throw Error("Compile and run proposal:prepare before deploying");
        return r.json();
      });
      const deployed = await new ContractFactory(
        a.abi,
        a.bytecode,
        signer,
      ).deploy(
        config.town,
        config.mana,
        config.governor,
        snapshot.merkleRoot,
        snapshotHash,
        snapshot.blockNumber,
        snapshot.totalAllocation,
      );
      notice = "Deploying refund contract…";
      render();
      await deployed.waitForDeployment();
      config.redemption = await deployed.getAddress();
      history.replaceState(null, "", shareURL());
      persist();
      notice =
        "Refund contract deployed. Prepare the proposal and export the shared configuration.";
    }),
  );
  $("#prepare-proposal")?.addEventListener("click", () =>
    run(async () => {
      await verifyRefund();
      config.proposal = makeProposal(
        config,
        snapshot,
        snapshotHash,
        config.redemption,
        await auction.paused(),
      );
      persist();
      notice =
        "Proposal prepared. Review the full text and actions below before posting.";
    }),
  );
  $("#propose")?.addEventListener("click", () =>
    run(async () => {
      const p = config.proposal;
      await send(governor, "propose", [
        p.targets,
        p.values,
        p.calldatas,
        p.description,
      ]);
      persist();
    }),
  );
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
