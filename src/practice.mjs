// No-money practice run on Base: watch Morpho loans close to liquidation, note the moment each one becomes
// liquidatable, then compare with when a real bot liquidated it. Answers "how often would we have been first?"
// Read-only: no wallet, never sends a transaction.
// Usage: npm run practice [-- hours]   (runs until Ctrl-C if hours is omitted)
import fs from 'node:fs';
import { createPublicClient, http, parseAbi, parseAbiItem, decodeEventLog, formatUnits } from 'viem';
import { CHAINS, gql, usd, short } from './config.mjs';

const CHAIN_ID = 8453;
const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ZERO = '0x0000000000000000000000000000000000000000';
const HTTP_RPC = process.env.PRACTICE_RPC || 'https://mainnet-preconf.base.org';
const WS_RPC = process.env.PRACTICE_WS || 'wss://mainnet-preconf.base.org';
const ARCHIVE_RPC = CHAINS[CHAIN_ID]?.rpc || 'https://base-rpc.publicnode.com';

const num = (k, d) => (process.env[k] != null && process.env[k] !== '' ? Number(process.env[k]) : d);
const RUN_HOURS = Number(process.argv[2] || 0);
const POLL_MS = num('POLL_MS', 70);
const MIN_BORROW_USD = num('MIN_BORROW_USD', 2);
const HF_MAX = num('HF_MAX', 1.15);
const WIN_LEAD_MS = num('WIN_LEAD_MS', 150);
const GAS_USD = num('GAS_USD', 0.02);
const KYBER_MIN_BONUS = num('KYBER_MIN_BONUS', 0.5);
const BLOCK_MS = 200;
const REFRESH_MS = 10 * 60_000;
const RATE_REFRESH_MS = 60_000;
const SUMMARY_MS = 5 * 60_000;
const BACKSTOP_MS = 20_000;
const LOG_FILE = 'reports/practice-log.jsonl';
const SUMMARY_FILE = 'reports/practice-summary.json';

const WAD = 10n ** 18n;
const ORACLE_SCALE = 10n ** 36n;
const divUp = (a, b) => (a + b - 1n) / b;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lower = (a) => a.toLowerCase();
const posKey = (mid, user) => `${lower(mid)}|${lower(user)}`;
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);

const morphoAbi = parseAbi([
  'function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
  'function position(bytes32, address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
]);
const oracleAbi = parseAbi(['function price() view returns (uint256)']);
const mc3Abi = parseAbi(['function getCurrentBlockTimestamp() view returns (uint256)']);
const irmAbi = parseAbi([
  'function borrowRateView((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) view returns (uint256)',
]);
const eventAbi = [
  parseAbiItem('event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)'),
  parseAbiItem('event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)'),
  parseAbiItem('event Repay(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)'),
  parseAbiItem('event SupplyCollateral(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets)'),
  parseAbiItem('event WithdrawCollateral(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets)'),
];

const chain = {
  id: CHAIN_ID, name: 'Base', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [HTTP_RPC] } }, contracts: { multicall3: { address: MULTICALL3 } },
};
const fast = createPublicClient({ chain, transport: http(HTTP_RPC, { timeout: 4000, retryCount: 0 }) });
const archive = createPublicClient({ chain, transport: http(ARCHIVE_RPC, { timeout: 20000, retryCount: 3, retryDelay: 1000 }) });
const multicall = (contracts, opts = {}, c = fast) => c.multicall({ contracts, allowFailure: true, batchSize: 0, ...opts });
// Startup/refresh reads: try the fast RPC, fall back to the archive RPC.
const readMany = (contracts) => multicall(contracts).catch(() => multicall(contracts, {}, archive));

// ---------- state ----------
const markets = new Map(); // marketId(lower) → market info
const positions = new Map(); // posKey → { mid, user, borrowShares, collateral, stale, opp, lastHf, lastDebtUsd }
const blockSeenAt = new Map(); // block number → ms we first saw it
const evaluated = new Set(); // block numbers we evaluated
const pendingLiqs = [];
const seenLogs = new Set();
const unknownMarketCache = new Map();
const outcomes = []; // resolved records used for the summary
const opportunities = [];
const stats = { startedAt: Date.now(), blocksSeen: 0, blocksEvaluated: 0, evalErrors: 0, pollErrors: 0, evalMs: [], wsMessages: 0, wsReconnects: 0, backstopLogs: 0 };
let latestSeen = 0;
let lastEvaluated = 0;
let evalInFlight = null; // block number currently being evaluated
let wantEval = 0;
let rttEma = 70;
let pollGapEma = POLL_MS;
let lastLogBlock = 0;
let oppSeq = 0;
let stopping = false;

fs.mkdirSync('reports', { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const jsonSafe = (k, v) => (typeof v === 'bigint' ? v.toString() : v);
function record(type, data) {
  logStream.write(JSON.stringify({ t: new Date().toISOString(), type, ...data }, jsonSafe) + '\n');
}

// ---------- Morpho math ----------
const lifOf = (lltv) => {
  const l = (WAD * WAD) / (WAD - (3n * (WAD - lltv)) / 10n);
  return l > (115n * WAD) / 100n ? (115n * WAD) / 100n : l;
};
// Morpho's interest compounding (wTaylorCompounded), so our debt matches what liquidate() would see.
function accrued(totalBorrowAssets, ratePerSec, elapsed) {
  if (!ratePerSec || elapsed <= 0n) return totalBorrowAssets;
  const first = ratePerSec * elapsed;
  const second = (first * first) / (2n * WAD);
  const third = (second * first) / (3n * WAD);
  return totalBorrowAssets + (totalBorrowAssets * (first + second + third)) / WAD;
}

function evaluatePosition(p, m, blockTs) {
  if (!m.price || !m.state || p.borrowShares === 0n) return null;
  const tba = accrued(m.state.totalBorrowAssets, m.rate, blockTs - m.state.lastUpdate);
  const debt = divUp(p.borrowShares * (tba + 1n), m.state.totalBorrowShares + 10n ** 6n);
  const maxBorrow = (((p.collateral * m.price) / ORACLE_SCALE) * m.lltv) / WAD;
  const hf = debt === 0n ? Infinity : Number((maxBorrow * 10000n) / debt) / 10000;
  const debtUsd = Number(formatUnits(debt, m.loan.decimals)) * m.loan.usd;
  if (maxBorrow >= debt) return { liquidatable: false, hf, debtUsd };
  let seized = p.collateral;
  let repaid = divUp(divUp(seized * m.price, ORACLE_SCALE) * WAD, m.lif);
  if (repaid > debt) {
    repaid = debt;
    seized = (((debt * m.lif) / WAD) * ORACLE_SCALE) / m.price;
  }
  const seizedLoanUnits = (seized * m.price) / ORACLE_SCALE;
  const toUsd = (x) => Number(formatUnits(x, m.loan.decimals)) * m.loan.usd;
  return {
    liquidatable: true, hf, debtUsd, seized, repaid, badDebt: repaid < debt,
    seizedUsd: toUsd(seizedLoanUnits), repaidUsd: toUsd(repaid), bonusUsd: toUsd(seizedLoanUnits - repaid),
  };
}

// ---------- watchlist ----------
const POS_Q = `query($skip:Int!) {
  marketPositions(first: 1000, skip: $skip, where: { chainId_in: [${CHAIN_ID}], healthFactor_lte: ${HF_MAX} }) {
    items { healthFactor user { address }
      market { marketId lltv
        loanAsset { address symbol decimals price { usd } }
        collateralAsset { address symbol decimals price { usd } } }
      state { collateral borrowShares borrowAssetsUsd } } } }`;

async function addMarkets(apiMarkets) {
  const fresh = apiMarkets.filter((m) => !markets.has(lower(m.marketId)));
  if (!fresh.length) return;
  const res = await readMany(fresh.map((m) => ({ address: MORPHO, abi: morphoAbi, functionName: 'idToMarketParams', args: [m.marketId] })));
  fresh.forEach((m, i) => {
    if (res[i].status !== 'success') return;
    const [loanToken, collateralToken, oracle, irm, lltv] = res[i].result;
    markets.set(lower(m.marketId), {
      id: m.marketId, params: { loanToken, collateralToken, oracle, irm, lltv }, oracle: lower(oracle), lltv, lif: lifOf(lltv),
      loan: { address: loanToken, symbol: m.loanAsset.symbol, decimals: m.loanAsset.decimals, usd: m.loanAsset.price?.usd ?? 0 },
      coll: { address: collateralToken, symbol: m.collateralAsset?.symbol, decimals: m.collateralAsset?.decimals, usd: m.collateralAsset?.price?.usd ?? 0 },
      pair: `${m.collateralAsset?.symbol}/${m.loanAsset.symbol}`, rate: 0n, price: null, state: null,
    });
  });
}

function updateMarketPrices(apiMarkets) {
  for (const m of apiMarkets) {
    const mk = markets.get(lower(m.marketId));
    if (!mk) continue;
    if (m.loanAsset.price?.usd) mk.loan.usd = m.loanAsset.price.usd;
    if (m.collateralAsset?.price?.usd) mk.coll.usd = m.collateralAsset.price.usd;
  }
}

async function readPositions(keys) {
  const list = keys.map((k) => positions.get(k)).filter(Boolean);
  for (let i = 0; i < list.length; i += 400) {
    const chunk = list.slice(i, i + 400);
    const res = await readMany(chunk.map((p) => ({ address: MORPHO, abi: morphoAbi, functionName: 'position', args: [p.mid, p.user] })));
    chunk.forEach((p, j) => {
      if (res[j].status !== 'success') return;
      p.borrowShares = BigInt(res[j].result[1]);
      p.collateral = BigInt(res[j].result[2]);
      p.stale = false;
    });
  }
}

async function refreshWatchlist() {
  const items = [];
  for (let skip = 0; skip < 20000; skip += 1000) {
    const d = await gql(POS_Q, { skip });
    items.push(...d.marketPositions.items);
    if (d.marketPositions.items.length < 1000) break;
  }
  const wanted = items.filter((p) => (p.state?.borrowAssetsUsd ?? 0) >= MIN_BORROW_USD && p.market.loanAsset?.price?.usd);
  const apiMarkets = [...new Map(wanted.map((p) => [lower(p.market.marketId), p.market])).values()];
  await addMarkets(apiMarkets);
  updateMarketPrices(apiMarkets);

  const keep = new Set();
  const added = [];
  for (const p of wanted) {
    if (!markets.has(lower(p.market.marketId))) continue;
    const k = posKey(p.market.marketId, p.user.address);
    keep.add(k);
    if (!positions.has(k)) {
      positions.set(k, { mid: p.market.marketId, user: p.user.address, borrowShares: 0n, collateral: 0n, stale: true, opp: null, lastHf: null, lastDebtUsd: null });
      added.push(k);
    }
  }
  // Drop positions the API no longer lists, unless our own math says they're still close.
  for (const [k, p] of positions) {
    if (keep.has(k) || p.opp || p.pendingLiq) continue;
    if (p.lastHf != null && p.lastHf <= HF_MAX && (p.lastDebtUsd ?? 0) >= MIN_BORROW_USD) continue;
    positions.delete(k);
  }
  await readPositions(added);
  await refreshRates();
  record('watchlist', { positions: positions.size, markets: markets.size, added: added.length });
  return { positions: positions.size, markets: markets.size };
}

async function refreshRates() {
  const list = [...markets.values()].filter((m) => m.params.irm !== ZERO);
  if (!list.length) return;
  const mres = await readMany(list.map((m) => ({ address: MORPHO, abi: morphoAbi, functionName: 'market', args: [m.id] })));
  const calls = [];
  const targets = [];
  list.forEach((m, i) => {
    if (mres[i].status !== 'success') return;
    const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = mres[i].result;
    calls.push({ address: m.params.irm, abi: irmAbi, functionName: 'borrowRateView', args: [m.params, { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee }] });
    targets.push(m);
  });
  const rres = await readMany(calls);
  rres.forEach((r, i) => { if (r.status === 'success') targets[i].rate = BigInt(r.result); });
}

// ---------- per-block evaluation ----------
function noteBlock(bn, source) {
  if (bn <= latestSeen) return;
  const now = Date.now();
  if (!blockSeenAt.has(bn)) blockSeenAt.set(bn, now);
  stats.blocksSeen += latestSeen ? bn - latestSeen : 1;
  latestSeen = bn;
  wantEval = bn;
  if (blockSeenAt.size > 20000) {
    const cut = bn - 15000;
    for (const k of blockSeenAt.keys()) if (k < cut) blockSeenAt.delete(k); else break;
    for (const k of evaluated) if (k < cut) evaluated.delete(k);
  }
  kickEval();
}

function kickEval() {
  if (evalInFlight || stopping || wantEval <= lastEvaluated) return;
  const bn = wantEval;
  evalInFlight = bn;
  evaluateBlock(bn)
    .catch((e) => { stats.evalErrors++; if (stats.evalErrors % 50 === 1) console.log(`  eval error @${bn}: ${(e.shortMessage || e.message).slice(0, 120)}`); })
    .finally(() => {
      evalInFlight = null;
      processPendingLiqs();
      kickEval();
    });
}

async function evaluateBlock(bn) {
  const t0 = Date.now();
  const mlist = [...markets.values()];
  const oracles = [...new Set(mlist.map((m) => m.oracle))];
  const contracts = [
    { address: MULTICALL3, abi: mc3Abi, functionName: 'getCurrentBlockTimestamp' },
    ...oracles.map((o) => ({ address: o, abi: oracleAbi, functionName: 'price' })),
    ...mlist.map((m) => ({ address: MORPHO, abi: morphoAbi, functionName: 'market', args: [m.id] })),
  ];
  const res = await multicall(contracts, { blockNumber: BigInt(bn) });
  if (res[0].status !== 'success') throw new Error('block timestamp read failed');
  const blockTs = BigInt(res[0].result);
  const prices = new Map();
  oracles.forEach((o, i) => { const r = res[1 + i]; prices.set(o, r.status === 'success' && r.result > 0n ? BigInt(r.result) : null); });
  mlist.forEach((m, i) => {
    const r = res[1 + oracles.length + i];
    m.price = prices.get(m.oracle);
    if (r.status === 'success') {
      const [, , totalBorrowAssets, totalBorrowShares, lastUpdate] = r.result;
      m.state = { totalBorrowAssets: BigInt(totalBorrowAssets), totalBorrowShares: BigInt(totalBorrowShares), lastUpdate: BigInt(lastUpdate) };
    }
  });
  const detectedAt = Date.now();
  // A newer block may have been evaluated while this one was in flight; don't go backwards.
  if (bn <= lastEvaluated) return;
  lastEvaluated = bn;
  evaluated.add(bn);
  stats.blocksEvaluated++;
  stats.evalMs.push(detectedAt - t0);
  if (stats.evalMs.length > 5000) stats.evalMs.splice(0, 2500);

  for (const [k, p] of positions) {
    if (p.stale) continue;
    const m = markets.get(lower(p.mid));
    const e = m && evaluatePosition(p, m, blockTs);
    if (!e) continue;
    p.lastHf = e.hf;
    p.lastDebtUsd = e.debtUsd;
    // Already liquidatable the first time we look (old traps like USR): not a fresh race, track separately.
    if (!p.checked) {
      p.checked = true;
      if (e.liquidatable) { p.alreadyLiquidatable = true; continue; }
    }
    if (p.alreadyLiquidatable) {
      if (!e.liquidatable) p.alreadyLiquidatable = false;
      continue;
    }
    if (e.liquidatable && !p.opp) openOpportunity(k, p, m, e, bn, detectedAt);
    else if (!e.liquidatable && p.opp && !p.pendingLiq) closeOpportunity(p, 'disappeared', { block: bn, lastEvent: p.lastEvent || null });
  }
}

function openOpportunity(k, p, m, e, bn, detectedAt) {
  const seenAt = blockSeenAt.get(bn) ?? detectedAt;
  const opp = {
    id: ++oppSeq, market: m.id, pair: m.pair, borrower: p.user, firstSeenBlock: bn, firstSeenAtMs: detectedAt,
    detectMs: detectedAt - seenAt, hf: e.hf, estBonusUsd: e.bonusUsd, seizedUsd: e.seizedUsd, repaidUsd: e.repaidUsd, badDebt: e.badDebt,
  };
  p.opp = opp;
  opportunities.push(opp);
  record('opportunity', opp);
  console.log(`  ⚑ liquidatable  ${m.pair.padEnd(18)} bonus ~${usd(opp.estBonusUsd).padEnd(8)} repay ${usd(opp.repaidUsd).padEnd(9)} block ${bn}  borrower ${short(p.user)}`);
  if (opp.estBonusUsd >= KYBER_MIN_BONUS) {
    kyberQuote(m.coll.address, m.loan.address, e.seized).then((q) => {
      const sellUsd = q.amountOut != null ? Number(formatUnits(q.amountOut, m.loan.decimals)) * m.loan.usd : null;
      opp.kyber = q.error ? { error: q.error } : { sellUsd, slippageUsd: sellUsd != null ? opp.seizedUsd - sellUsd : null };
      record('kyber', { opp: opp.id, ...opp.kyber });
    });
  }
}

function closeOpportunity(p, outcome, extra = {}) {
  const opp = p.opp;
  p.opp = null;
  const rec = { outcome, opp: opp.id, market: opp.market, pair: opp.pair, borrower: opp.borrower, firstSeenBlock: opp.firstSeenBlock, estBonusUsd: opp.estBonusUsd, bonusUsd: opp.estBonusUsd, ...extra };
  outcomes.push(rec);
  record('outcome', rec);
  if (outcome === 'disappeared') console.log(`  ○ went away     ${opp.pair.padEnd(18)} bonus ~${usd(opp.estBonusUsd)} (healthy again, nobody liquidated)`);
}

// ---------- events ----------
function handleLog(raw, source) {
  if (raw.removed) return;
  const id = `${raw.transactionHash}:${raw.logIndex}`;
  if (seenLogs.has(id)) return;
  seenLogs.add(id);
  if (seenLogs.size > 50000) seenLogs.clear();
  if (source === 'backstop') stats.backstopLogs++;
  let ev;
  try {
    ev = decodeEventLog({ abi: eventAbi, topics: raw.topics, data: raw.data });
  } catch {
    return;
  }
  const block = Number(raw.blockNumber);
  if (block > lastLogBlock && source === 'ws') lastLogBlock = block;
  const a = ev.args;
  const user = a.borrower ?? a.onBehalf;
  const mid = a.id;
  const k = posKey(mid, user);
  let p = positions.get(k);
  if (!p && markets.has(lower(mid)) && ev.eventName !== 'Liquidate') {
    p = { mid, user, borrowShares: 0n, collateral: 0n, stale: true, opp: null, lastHf: null, lastDebtUsd: null };
    positions.set(k, p);
  }
  if (p) {
    p.stale = true;
    p.lastEvent = ev.eventName;
    readPositions([k]).catch(() => setTimeout(() => readPositions([k]).catch(() => {}), 1000));
  }
  if (ev.eventName === 'Liquidate') {
    const liq = { key: k, mid, borrower: user, caller: a.caller, block, tx: raw.transactionHash, repaidAssets: a.repaidAssets, seizedAssets: a.seizedAssets, badDebtAssets: a.badDebtAssets, receivedAt: Date.now() };
    if (p) p.pendingLiq = (p.pendingLiq || 0) + 1;
    pendingLiqs.push(liq);
    processPendingLiqs();
  }
}

function processPendingLiqs() {
  for (let i = 0; i < pendingLiqs.length; ) {
    const l = pendingLiqs[i];
    // Wait if an evaluation of an earlier block is still running; it could still open the opportunity.
    if (evalInFlight && evalInFlight < l.block && Date.now() - l.receivedAt < 5000) { i++; continue; }
    pendingLiqs.splice(i, 1);
    resolveLiquidation(l).catch((e) => console.log(`  resolve error: ${e.message}`));
  }
}

async function unknownMarketInfo(mid) {
  if (!unknownMarketCache.has(mid)) {
    unknownMarketCache.set(mid, gql(`{ marketById(marketId:"${mid}", chainId:${CHAIN_ID}) { loanAsset { symbol decimals price { usd } } collateralAsset { symbol decimals price { usd } } } }`)
      .then((d) => d.marketById).catch(() => null));
  }
  return unknownMarketCache.get(mid);
}

function seenAtOf(block) {
  if (blockSeenAt.has(block)) return blockSeenAt.get(block);
  for (let b = block + 1; b <= block + 50; b++) if (blockSeenAt.has(b)) return blockSeenAt.get(b) - (b - block) * BLOCK_MS;
  return null;
}

async function resolveLiquidation(l) {
  const p = positions.get(l.key);
  const m = markets.get(lower(l.mid));
  let pair, bonusUsd;
  if (m) {
    pair = m.pair;
    const seizedLoan = m.price ? (l.seizedAssets * m.price) / ORACLE_SCALE : null;
    bonusUsd = seizedLoan != null ? Number(formatUnits(seizedLoan - l.repaidAssets, m.loan.decimals)) * m.loan.usd : null;
  } else {
    const info = await unknownMarketInfo(l.mid);
    pair = info ? `${info.collateralAsset?.symbol}/${info.loanAsset?.symbol}` : '?';
    if (info?.loanAsset?.price?.usd && info?.collateralAsset?.price?.usd) {
      bonusUsd = (Number(l.seizedAssets) / 10 ** info.collateralAsset.decimals) * info.collateralAsset.price.usd
        - (Number(l.repaidAssets) / 10 ** info.loanAsset.decimals) * info.loanAsset.price.usd;
    }
  }
  const base = { market: l.mid, pair, borrower: l.borrower, winner: l.caller, tx: l.tx, liquidatedBlock: l.block, bonusUsd: bonusUsd ?? null };
  if (p) p.pendingLiq = Math.max(0, (p.pendingLiq || 1) - 1);

  if (!p) {
    const rec = { outcome: 'unwatched', ...base };
    outcomes.push(rec);
    record('outcome', rec);
    console.log(`  · liquidated (not on our watchlist) ${pair.padEnd(18)} bonus ~${usd(bonusUsd)} by ${short(l.caller)}`);
    return;
  }
  if (p.alreadyLiquidatable && !p.opp) {
    const rec = { outcome: 'old-liquidatable', ...base };
    outcomes.push(rec);
    record('outcome', rec);
    console.log(`  · liquidated (was already liquidatable when we started) ${pair.padEnd(18)} bonus ~${usd(bonusUsd)} by ${short(l.caller)}`);
    return;
  }
  const opp = p.opp;
  if (opp && opp.firstSeenBlock < l.block) {
    const liqSeenAt = seenAtOf(l.block);
    // We see each block a bit after it's published (half a poll + half a round trip); subtract that.
    const lagEst = rttEma / 2 + Math.max(pollGapEma, rttEma) / 2;
    const leadMs = liqSeenAt != null ? Math.round(liqSeenAt - opp.firstSeenAtMs - lagEst) : Math.round((l.block - opp.firstSeenBlock) * BLOCK_MS - opp.detectMs - lagEst);
    const win = leadMs >= WIN_LEAD_MS;
    closeOpportunity(p, win ? 'win' : 'shot-too-slow', {
      ...base, estBonusUsd: opp.estBonusUsd, bonusUsd: opp.estBonusUsd, actualBonusUsd: bonusUsd ?? null,
      blocksLead: l.block - opp.firstSeenBlock, leadMs, detectMs: opp.detectMs, kyber: opp.kyber || null,
      profitUsd: win ? opp.estBonusUsd - GAS_USD : null, slippageFlag: win && opp.estBonusUsd < 1,
    });
    console.log(`  ${win ? '★ WE WOULD WIN ' : '△ had a shot   '} ${pair.padEnd(18)} bonus ~${usd(opp.estBonusUsd).padEnd(8)} lead ${leadMs} ms (${l.block - opp.firstSeenBlock} blocks)  winner ${short(l.caller)}`);
    return;
  }
  // Never saw it liquidatable before the block it was liquidated in → a bot got there first.
  const lastEvalBefore = (() => { for (let b = l.block - 1; b > l.block - 30; b--) if (evaluated.has(b)) return b; return null; })();
  const maybeSkipped = lastEvalBefore == null || lastEvalBefore < l.block - 1;
  const extra = { ...base, maybeSkipped, lastEvaluatedBefore: lastEvalBefore };
  if (opp) closeOpportunity(p, 'lost-preposition', { ...extra, estBonusUsd: opp.estBonusUsd, bonusUsd: bonusUsd ?? opp.estBonusUsd });
  else {
    const rec = { outcome: 'lost-preposition', ...extra };
    outcomes.push(rec);
    record('outcome', rec);
  }
  console.log(`  ✗ lost (same block) ${pair.padEnd(18)} bonus ~${usd(bonusUsd)} by ${short(l.caller)}${maybeSkipped ? '  (we skipped the block before)' : ''}`);
}

let ws;
function connectWs() {
  if (stopping) return;
  ws = new WebSocket(WS_RPC);
  const subs = {};
  ws.onopen = () => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['logs', { address: MORPHO }] }));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_subscribe', params: ['newHeads'] }));
  };
  ws.onmessage = (e) => {
    stats.wsMessages++;
    let j;
    try { j = JSON.parse(e.data); } catch { return; }
    if (j.id === 1) subs[j.result] = 'logs';
    else if (j.id === 2) subs[j.result] = 'heads';
    else if (j.method === 'eth_subscription') {
      const kind = subs[j.params.subscription];
      if (kind === 'heads') noteBlock(Number(j.params.result.number), 'ws');
      else if (kind === 'logs') handleLog(j.params.result, 'ws');
    }
  };
  ws.onclose = () => {
    if (stopping) return;
    stats.wsReconnects++;
    setTimeout(connectWs, 2000);
  };
  ws.onerror = () => {};
}

// Catches any events the WebSocket missed (disconnects etc).
async function backstopLogs() {
  if (!latestSeen) return;
  const to = latestSeen;
  const from = Math.max(lastLogBlock ? lastLogBlock - 20 : to - 200, to - 500);
  try {
    const logs = await fast.request({ method: 'eth_getLogs', params: [{ address: MORPHO, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }] })
      .catch(() => archive.request({ method: 'eth_getLogs', params: [{ address: MORPHO, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }] }));
    for (const l of logs) handleLog(l, 'backstop');
    lastLogBlock = Math.max(lastLogBlock, to);
  } catch {}
}

async function pollLoop() {
  let lastStart = Date.now();
  while (!stopping) {
    const t = Date.now();
    pollGapEma = pollGapEma * 0.95 + (t - lastStart) * 0.05;
    lastStart = t;
    try {
      const res = await fetch(HTTP_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }), signal: AbortSignal.timeout(2000) });
      const j = await res.json();
      rttEma = rttEma * 0.95 + (Date.now() - t) * 0.05;
      if (j.result) noteBlock(Number(j.result), 'poll');
      else { stats.pollErrors++; if (res.status === 429) await sleep(1000); }
    } catch {
      stats.pollErrors++;
      await sleep(250);
    }
    await sleep(Math.max(0, POLL_MS - (Date.now() - t)));
  }
}

// ---------- KyberSwap (copied from scan.mjs, simplified) ----------
let kyberChain = Promise.resolve();
function kyberQuote(tokenIn, tokenOut, amountIn) {
  if (lower(tokenIn) === lower(tokenOut)) return Promise.resolve({ amountOut: amountIn });
  const job = kyberChain.then(async () => {
    const url = `https://aggregator-api.kyberswap.com/base/api/v1/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'x-client-id': 'repo-raccoon' } });
        const j = await res.json().catch(() => ({}));
        if (j?.data?.routeSummary) return { amountOut: BigInt(j.data.routeSummary.amountOut) };
        if (res.status !== 429 && res.status !== 403) return { error: j?.message || `HTTP ${res.status}` };
      } catch (e) {
        if (attempt === 2) return { error: e.message };
      }
      await sleep(3000 * (attempt + 1));
    }
    return { error: 'throttled' };
  });
  kyberChain = job.then(() => sleep(700), () => sleep(700));
  return job.catch((e) => ({ error: e.message }));
}

// ---------- summary ----------
const bucketOf = (b) => (b == null ? 'unknown $' : b < 1 ? '< $1' : b < 10 ? '$1–10' : '$10+');
const BUCKETS = ['< $1', '$1–10', '$10+', 'unknown $'];

function summarize() {
  const hours = (Date.now() - stats.startedAt) / 3_600_000;
  const rows = {};
  for (const b of BUCKETS) rows[b] = { seen: 0, liquidations: 0, hadShot: 0, wins: 0, tooSlow: 0, lostPreposition: 0, lostMaybeSkipped: 0, unwatched: 0, disappeared: 0, oldLiquidatable: 0, leads: [], profit: 0 };
  for (const o of opportunities) rows[bucketOf(o.estBonusUsd)].seen++;
  for (const o of outcomes) {
    const r = rows[bucketOf(o.bonusUsd)];
    if (o.outcome === 'disappeared') { r.disappeared++; continue; }
    if (o.outcome === 'old-liquidatable') { r.oldLiquidatable++; continue; }
    r.liquidations++;
    if (o.outcome === 'win' || o.outcome === 'shot-too-slow') {
      r.hadShot++;
      r.leads.push(o.leadMs);
      if (o.outcome === 'win') { r.wins++; r.profit += o.profitUsd; } else r.tooSlow++;
    } else if (o.outcome === 'lost-preposition') { r.lostPreposition++; if (o.maybeSkipped) r.lostMaybeSkipped++; }
    else if (o.outcome === 'unwatched') r.unwatched++;
  }
  const out = {
    at: new Date().toISOString(), hoursRunning: +hours.toFixed(3), watching: { positions: positions.size, markets: markets.size, alreadyLiquidatable: [...positions.values()].filter((p) => p.alreadyLiquidatable).length },
    blocks: { seen: stats.blocksSeen, evaluated: stats.blocksEvaluated, evalErrors: stats.evalErrors, pollErrors: stats.pollErrors, medianEvalMs: median(stats.evalMs), rttMs: Math.round(rttEma), pollGapMs: Math.round(pollGapEma) },
    ws: { messages: stats.wsMessages, reconnects: stats.wsReconnects, eventsOnlyFromBackstop: stats.backstopLogs },
    buckets: {},
  };
  let profit = 0;
  for (const b of BUCKETS) {
    const r = rows[b];
    profit += r.profit;
    const contested = r.hadShot + r.lostPreposition;
    out.buckets[b] = {
      opportunitiesSeen: r.seen, liquidations: r.liquidations, weHadAShot: r.hadShot, hypotheticalWins: r.wins, shotButTooSlow: r.tooSlow,
      lostToPrepositioned: r.lostPreposition, ofWhichWeSkippedBlocks: r.lostMaybeSkipped, notOnWatchlist: r.unwatched, disappeared: r.disappeared, oldLiquidatableTaken: r.oldLiquidatable,
      winShareOfWatched: contested ? +(r.wins / contested).toFixed(3) : null, medianLeadMs: median(r.leads),
      hypotheticalProfitUsd: +r.profit.toFixed(2), perDayUsd: hours > 0 ? +((r.profit / hours) * 24).toFixed(2) : null,
    };
  }
  out.totalProfitUsd = +profit.toFixed(2);
  out.perDayUsd = hours > 0 ? +((profit / hours) * 24).toFixed(2) : null;
  return out;
}

function printSummary() {
  const s = summarize();
  record('summary', s);
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(s, null, 2));
  console.log(`\n── Practice summary (${s.hoursRunning.toFixed(2)} h, watching ${s.watching.positions} loans in ${s.watching.markets} markets; ${s.watching.alreadyLiquidatable} were already liquidatable at start, ignored) ──`);
  console.log(`   blocks seen ${s.blocks.seen}, evaluated ${s.blocks.evaluated}, check takes ~${s.blocks.medianEvalMs ?? '?'} ms, RPC round trip ~${s.blocks.rttMs} ms${s.blocks.evalErrors ? `, ${s.blocks.evalErrors} eval errors` : ''}`);
  console.log(`   ${'bonus'.padEnd(10)} ${'seen'.padStart(5)} ${'liqs'.padStart(5)} ${'shot'.padStart(5)} ${'win'.padStart(5)} ${'lost'.padStart(5)} ${'unwtch'.padStart(6)} ${'gone'.padStart(5)} ${'win%'.padStart(6)} ${'lead'.padStart(7)} ${'profit'.padStart(8)} ${'/day'.padStart(8)}`);
  for (const b of BUCKETS) {
    const r = s.buckets[b];
    if (b === 'unknown $' && !r.liquidations && !r.opportunitiesSeen) continue;
    console.log(`   ${b.padEnd(10)} ${String(r.opportunitiesSeen).padStart(5)} ${String(r.liquidations).padStart(5)} ${String(r.weHadAShot).padStart(5)} ${String(r.hypotheticalWins).padStart(5)} ${String(r.lostToPrepositioned).padStart(5)} ${String(r.notOnWatchlist).padStart(6)} ${String(r.disappeared).padStart(5)} ${(r.winShareOfWatched != null ? (r.winShareOfWatched * 100).toFixed(0) + '%' : '-').padStart(6)} ${(r.medianLeadMs != null ? r.medianLeadMs + 'ms' : '-').padStart(7)} ${usd(r.hypotheticalProfitUsd).padStart(8)} ${(r.perDayUsd != null ? usd(r.perDayUsd) : '-').padStart(8)}`);
  }
  console.log(`   total hypothetical profit ${usd(s.totalProfitUsd)} (~${usd(s.perDayUsd)}/day). Full log: ${LOG_FILE}\n`);
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  try { ws?.close(); } catch {}
  for (const l of pendingLiqs.splice(0)) await resolveLiquidation(l).catch(() => {});
  printSummary();
  record('stop', {});
  logStream.end(() => process.exit(0));
}

// ---------- main ----------
console.log(`Practice run on Base (no money, read-only). RPC ${HTTP_RPC}, poll every ${POLL_MS} ms, win needs ≥ ${WIN_LEAD_MS} ms lead.`);
console.log(`Loading loans with health ≤ ${HF_MAX} and debt ≥ ${usd(MIN_BORROW_USD)} from the Morpho API…`);
const w = await refreshWatchlist();
console.log(`Watching ${w.positions} loans in ${w.markets} markets. Logging to ${LOG_FILE}. Ctrl-C to stop and print the summary.\n`);
record('start', { rpc: HTTP_RPC, ws: WS_RPC, pollMs: POLL_MS, minBorrowUsd: MIN_BORROW_USD, hfMax: HF_MAX, winLeadMs: WIN_LEAD_MS, gasUsd: GAS_USD, ...w });

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
connectWs();
pollLoop();
setInterval(() => refreshWatchlist().catch((e) => console.log(`  watchlist refresh failed: ${e.message.slice(0, 120)}`)), REFRESH_MS).unref();
setInterval(() => refreshRates().catch(() => {}), RATE_REFRESH_MS).unref();
setInterval(backstopLogs, BACKSTOP_MS).unref();
setInterval(printSummary, SUMMARY_MS).unref();
if (RUN_HOURS > 0) setTimeout(shutdown, RUN_HOURS * 3_600_000);
