// Buffer replay ("flipped trigger" check). Read-only.
// Some Morpho loans sit liquidatable because their collateral is a vault token nobody can sell on a DEX. The idea:
// wait for cash to land in the vault (a deposit, a top-up), then liquidate a slice and redeem it at NAV in one tx.
// This replays the past N days: every time cash appeared in the vault, was a loan underwater, how long did the cash
// stay, and who took it (a Morpho liquidator, a holder redeeming directly, or the vault operator)?
// Usage: npm run buffer-replay [-- days]   (env: TARGETS=AVLT,ynETHx  MIN_CASH_USD=100  REPLAY_RPC_<chainId>=…)
import fs from 'node:fs';
import { createPublicClient, http, parseAbi, parseAbiItem, decodeEventLog, toEventSelector } from 'viem';
import { gql, usd, short } from './config.mjs';

const DAYS = Number(process.argv[2] || process.env.DAYS || 30);
const MIN_CASH_USD = Number(process.env.MIN_CASH_USD || 100);
const MAX_EPISODES = Number(process.env.MAX_EPISODES || 400);
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

// cash = 'vault': the vault holds its redeemable cash itself (AVLT NavVault: redeem pays from its own balance).
// cash = 'buffer': the vault redeems from a separate buffer vault (YieldNest: buffer().maxWithdraw(vault)), so the
// cash ledger is the vault's share balance in that buffer.
const TARGETS = [
  { key: 'AVLT', chainId: 999, chain: 'HyperEVM', vault: '0xd0Ee0CF300DFB598270cd7F4D0c6E0D8F6e13f29', cash: 'vault', rpc: process.env.REPLAY_RPC_999 || 'https://hyperliquid-rpc.publicnode.com', logRange: 1000, concurrency: 6, gasUsd: Number(process.env.GAS_USD_999 || 0.05) },
  { key: 'ynETHx', chainId: 1, chain: 'Ethereum', vault: '0x657d9ABA1DBb59e53f9F3eCAA878447dCfC96dCb', cash: 'buffer', rpc: process.env.REPLAY_RPC_1 || 'https://rpc.mevblocker.io', logRange: 10000, concurrency: 2, gasUsd: Number(process.env.GAS_USD_1 || 1) },
].filter((t) => !process.env.TARGETS || process.env.TARGETS.split(',').includes(t.key));

const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
const vaultAbi = parseAbi([
  'function asset() view returns (address)', 'function buffer() view returns (address)', 'function decimals() view returns (uint8)',
  'function convertToAssets(uint256) view returns (uint256)', 'function previewRedeem(uint256) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
]);
const morphoAbi = parseAbi([
  'function position(bytes32, address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
]);
const oracleAbi = parseAbi(['function price() view returns (uint256)']);
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const LIQUIDATE = parseAbiItem('event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)');
const WITHDRAW = parseAbiItem('event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)');
const DEPOSIT = parseAbiItem('event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)');
const topicOf = (ev) => `${ev.name}(${ev.inputs.map((i) => i.type).join(',')})`;
const T_LIQ = toEventSelector(topicOf(LIQUIDATE));
const T_WITHDRAW = toEventSelector(topicOf(WITHDRAW));
const T_DEPOSIT = toEventSelector(topicOf(DEPOSIT));
const T_TRANSFER = toEventSelector(topicOf(TRANSFER));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lower = (a) => a?.toLowerCase();
const num = (x, dec) => Number(x) / 10 ** dec;

async function retry(fn, tries = 6) {
  for (let t = 0; ; t++) {
    try {
      return await fn();
    } catch (e) {
      if (t >= tries) throw e;
      await sleep(700 * (t + 1));
    }
  }
}

async function getLogsChunked(client, params, from, to, range, conc, label) {
  const ranges = [];
  for (let s = from; s <= to; s += BigInt(range)) ranges.push([s, s + BigInt(range) - 1n > to ? to : s + BigInt(range) - 1n]);
  const out = [];
  let next = 0;
  let done = 0;
  const t0 = Date.now();
  async function worker() {
    while (next < ranges.length) {
      const [a, b] = ranges[next++];
      out.push(...(await retry(() => client.getLogs({ ...params, fromBlock: a, toBlock: b }))));
      if (++done % 250 === 0) process.stdout.write(`\r    ${label}: ${done}/${ranges.length} chunks (${Math.round((Date.now() - t0) / 1000)}s)   `);
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  if (ranges.length >= 250) process.stdout.write(`\r    ${label}: ${ranges.length}/${ranges.length} chunks (${Math.round((Date.now() - t0) / 1000)}s)   \n`);
  return out.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : Number(x.blockNumber - y.blockNumber)));
}

async function readMany(client, hasMc, calls, blockNumber) {
  if (hasMc) {
    const out = [];
    for (let i = 0; i < calls.length; i += 250) out.push(...(await retry(() => client.multicall({ contracts: calls.slice(i, i + 250), allowFailure: true, blockNumber, batchSize: 0 }))));
    return out.map((r) => (r.status === 'success' ? r.result : null));
  }
  const out = [];
  for (let i = 0; i < calls.length; i += 8) {
    out.push(...(await Promise.all(calls.slice(i, i + 8).map((c) => client.readContract({ ...c, blockNumber }).catch(() => null)))));
  }
  return out;
}

const lifOf = (lltv) => Math.min(1.15, 1 / (1 - 0.3 * (1 - lltv)));

async function replay(t) {
  const client = createPublicClient({
    chain: { id: t.chainId, name: t.chain, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [t.rpc] } }, contracts: { multicall3: { address: MULTICALL3 } } },
    transport: http(t.rpc, { timeout: 30000, retryCount: 2, retryDelay: 1000 }),
  });
  const hasMc = ((await client.getCode({ address: MULTICALL3 })) || '0x').length > 2;
  const toBlock = await client.getBlockNumber();
  const [bNow, bOld] = await Promise.all([client.getBlock({ blockNumber: toBlock }), client.getBlock({ blockNumber: toBlock - 100000n })]);
  const blocksPerDay = (100000 * 86400) / Number(bNow.timestamp - bOld.timestamp);
  const fromBlock = toBlock - BigInt(Math.round(blocksPerDay * DAYS));
  const secPerBlock = 86400 / blocksPerDay;

  // Vault, its underlying asset, and where the cash lives.
  const read = (address, abi, functionName, args = [], blockNumber) => client.readContract({ address, abi, functionName, args, blockNumber });
  const underlying = await read(t.vault, vaultAbi, 'asset');
  const vaultDec = await read(t.vault, vaultAbi, 'decimals');
  const [uDec, uSym] = await Promise.all([read(underlying, erc20Abi, 'decimals'), read(underlying, erc20Abi, 'symbol')]);
  const buffer = t.cash === 'buffer' ? await read(t.vault, vaultAbi, 'buffer') : null;
  const ledgerToken = buffer || underlying; // token whose balance (held by `holder`) is the redeemable cash
  const holder = t.vault;
  const ledgerDec = buffer ? await read(buffer, vaultAbi, 'decimals') : uDec;
  const ONE_LEDGER = 10n ** BigInt(ledgerDec);
  const ledgerToUnderlying = buffer ? num(await read(buffer, vaultAbi, 'convertToAssets', [ONE_LEDGER]), uDec) : 1;

  // Markets that take this vault as collateral, and their borrowers.
  const md = await gql(`query($c:[Int!],$a:[String!]){markets(where:{chainId_in:$c,collateralAssetAddress_in:$a}){items{marketId lltv morphoBlue{address} oracle{address} loanAsset{address symbol decimals price{usd}} collateralAsset{symbol decimals price{usd}} state{borrowAssetsUsd}}}}`, { c: [t.chainId], a: [t.vault] });
  const markets = md.markets.items.filter((m) => m.state.borrowAssetsUsd > 1 && m.oracle?.address);
  const morpho = markets[0]?.morphoBlue.address;
  const ad = await gql(`query($a:[String!],$c:[Int!]){assets(where:{address_in:$a,chainId_in:$c}){items{address price{usd}}}}`, { a: [underlying], c: [t.chainId] });
  const uUsd = ad.assets.items[0]?.price?.usd || (lower(markets[0]?.loanAsset.address) === lower(underlying) ? markets[0].loanAsset.price.usd : null);
  const minCash = MIN_CASH_USD / (uUsd || 1); // in underlying units
  console.log(`  ${t.key} on ${t.chain}: ${DAYS} days = blocks ${fromBlock}…${toBlock} (~${secPerBlock.toFixed(2)} s/block). Cash = ${buffer ? `vault's shares in buffer ${short(buffer)}` : `${uSym} held by the vault`}. ${markets.length} market(s).`);

  // 1. Cash ledger: every transfer of the ledger token into / out of the vault.
  const conc = t.concurrency;
  const ins = await getLogsChunked(client, { address: ledgerToken, event: TRANSFER, args: { to: holder } }, fromBlock, toBlock, t.logRange, conc, 'cash in');
  const outs = await getLogsChunked(client, { address: ledgerToken, event: TRANSFER, args: { from: holder } }, fromBlock, toBlock, t.logRange, conc, 'cash out');
  const liqs = morpho && markets.length
    ? await getLogsChunked(client, { address: morpho, event: LIQUIDATE, args: { id: markets.map((m) => m.marketId) } }, fromBlock, toBlock, t.logRange, conc, 'liquidations')
    : [];
  const moves = [...ins.map((l) => ({ ...l, dir: 1 })), ...outs.map((l) => ({ ...l, dir: -1 }))]
    .filter((l) => lower(l.args.from) !== lower(l.args.to))
    .sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : Number(x.blockNumber - y.blockNumber)));

  // Rebuild the balance backwards from today's balance (no archive reads needed).
  const balNow = await read(ledgerToken, erc20Abi, 'balanceOf', [holder], toBlock);
  let bal = balNow;
  for (const m of moves) bal -= BigInt(m.dir) * m.args.value;
  const balStart = bal;
  const toU = (v) => num(v, ledgerDec) * ledgerToUnderlying;

  // 2. Episodes: cash rises from below the threshold to at least it, until it falls back below.
  const episodes = [];
  let cur = null;
  bal = balStart;
  if (toU(balStart) >= minCash) cur = { start: { blockNumber: fromBlock, txHash: null, logIndex: -1 }, startedBefore: true, peak: toU(balStart), outflows: [], inflows: [] };
  for (const m of moves) {
    const before = toU(bal);
    bal += BigInt(m.dir) * m.args.value;
    const after = toU(bal);
    if (!cur && before < minCash && after >= minCash) cur = { start: m, peak: after, outflows: [], inflows: [m] };
    else if (cur) {
      if (m.dir > 0) cur.inflows.push(m);
      else cur.outflows.push(m);
      cur.peak = Math.max(cur.peak, after);
      if (after < minCash) {
        cur.end = m;
        episodes.push(cur);
        cur = null;
      }
    }
  }
  if (cur) episodes.push(cur); // still open today

  // 3. Details per episode (most recent first if capped): timing, who refilled, who drained, was a loan underwater.
  const receipts = new Map();
  const receipt = async (h) => {
    if (!receipts.has(h)) receipts.set(h, await retry(() => client.getTransactionReceipt({ hash: h })));
    return receipts.get(h);
  };
  const blockTs = new Map();
  const tsOf = async (bn) => {
    if (!blockTs.has(bn)) blockTs.set(bn, Number((await retry(() => client.getBlock({ blockNumber: bn }))).timestamp));
    return blockTs.get(bn);
  };
  const marketIds = new Set(markets.map((m) => lower(m.marketId)));
  const classify = async (h) => {
    const r = await receipt(h);
    const liq = r.logs.find((l) => lower(l.address) === lower(morpho) && l.topics[0] === T_LIQ && marketIds.has(lower(l.topics[1])));
    if (liq) return { kind: 'morpho-liquidator', who: r.from, to: r.to };
    const w = r.logs.find((l) => lower(l.address) === lower(t.vault) && l.topics[0] === T_WITHDRAW);
    if (w) {
      const ev = decodeEventLog({ abi: [WITHDRAW], data: w.data, topics: w.topics });
      return { kind: 'direct-redeemer', who: ev.args.owner, to: r.to };
    }
    return { kind: 'operator/other', who: r.from, to: r.to };
  };
  const refillKind = async (h) => {
    const r = await receipt(h);
    if (r.logs.some((l) => lower(l.address) === lower(t.vault) && l.topics[0] === T_DEPOSIT)) return 'vault deposit';
    if (r.logs.some((l) => lower(l.address) === lower(t.vault) && l.topics[0] !== T_TRANSFER && l.topics[0] !== T_WITHDRAW && l.logIndex !== undefined)) return 'vault call';
    return 'transfer-in';
  };

  // Borrowers: today's API list plus everyone liquidated in the window.
  const borrowers = new Map(markets.map((m) => [lower(m.marketId), new Set()]));
  for (const m of markets) {
    for (let skip = 0; skip < 5000; skip += 1000) {
      const d = await gql(`query($c:Int!,$ids:[String!],$skip:Int!){marketPositions(first:1000,skip:$skip,where:{chainId_in:[$c],marketUniqueKey_in:$ids,borrowShares_gte:"1"}){items{user{address}}}}`, { c: t.chainId, ids: [m.marketId], skip });
      for (const p of d.marketPositions.items) borrowers.get(lower(m.marketId)).add(lower(p.user.address));
      if (d.marketPositions.items.length < 1000) break;
    }
  }
  for (const l of liqs) borrowers.get(lower(l.args.id))?.add(lower(l.args.borrower));

  async function underwaterAt(blockNumber) {
    let shares = 0; // collateral (vault shares, human units) we could seize from underwater loans
    let repay = 0; // loan-token amount we'd repay for all of it
    let count = 0;
    let debtUsd = 0;
    const perMarket = [];
    for (const m of markets) {
      const list = [...borrowers.get(lower(m.marketId))];
      const res = await readMany(client, hasMc, [
        { address: morpho, abi: morphoAbi, functionName: 'market', args: [m.marketId] },
        { address: m.oracle.address, abi: oracleAbi, functionName: 'price' },
        ...list.map((u) => ({ address: morpho, abi: morphoAbi, functionName: 'position', args: [m.marketId, u] })),
      ], blockNumber);
      const [mk, price] = res;
      if (!mk || !price) continue;
      const lltv = Number(m.lltv) / 1e18;
      const lif = lifOf(lltv);
      const lDec = m.loanAsset.decimals;
      const cDec = m.collateralAsset.decimals;
      let mShares = 0;
      let mRepay = 0;
      let mCount = 0;
      list.forEach((u, i) => {
        const p = res[i + 2];
        if (!p || p[1] === 0n) return;
        const debt = (p[1] * (mk[2] + 1n) + (mk[3] + 1000000n) - 1n) / (mk[3] + 1000000n);
        const collInLoan = (p[2] * price) / 10n ** 36n;
        if ((Number(collInLoan) * lltv) >= Number(debt)) return;
        const seizeByDebt = (debt * BigInt(Math.floor(lif * 1e9)) * 10n ** 36n) / (price * 1000000000n);
        const seize = seizeByDebt < p[2] ? seizeByDebt : p[2];
        mShares += num(seize, cDec);
        mRepay += num((seize * price) / 10n ** 36n, lDec) / lif;
        mCount++;
        debtUsd += num(debt, lDec) * (m.loanAsset.price?.usd || 0);
      });
      shares += mShares;
      repay += mRepay * (m.loanAsset.price?.usd || 0);
      count += mCount;
      perMarket.push({ marketId: m.marketId, pair: `${m.collateralAsset.symbol}/${m.loanAsset.symbol}`, underwater: mCount, seizableShares: mShares, oraclePrice: num(price, 36 + lDec - cDec) });
    }
    return { count, seizableShares: shares, repayUsdAll: repay, debtUsd, perMarket };
  }

  const navAt = async (blockNumber) => {
    const one = 10n ** BigInt(vaultDec);
    const [net, gross] = await Promise.all([
      read(t.vault, vaultAbi, 'previewRedeem', [one], blockNumber).catch(() => null),
      read(t.vault, vaultAbi, 'convertToAssets', [one], blockNumber).catch(() => null),
    ]);
    return { net: net == null ? null : num(net, uDec), gross: gross == null ? null : num(gross, uDec) };
  };

  const detailed = episodes.slice(-MAX_EPISODES);
  const rows = [];
  let i = 0;
  for (const e of detailed) {
    if (++i % 20 === 0) process.stdout.write(`\r    checking episodes ${i}/${detailed.length}   `);
    const sb = e.start.blockNumber;
    const eb = e.end?.blockNumber ?? null;
    const blocksOpen = eb == null ? null : Number(eb - sb);
    const sameTx = !!(e.end && e.start.transactionHash && e.end.transactionHash === e.start.transactionHash);
    const bucket = eb == null ? 'still open' : sameTx ? 'same tx' : blocksOpen === 0 ? 'same block' : blocksOpen <= 2 ? '1-2 blocks' : '>2 blocks';
    const [tsStart, tsEnd] = await Promise.all([tsOf(sb), eb == null ? null : tsOf(eb)]);
    const drainers = [];
    for (const o of e.outflows) drainers.push({ ...(await classify(o.transactionHash)), amount: toU(o.args.value), block: Number(o.blockNumber), tx: o.transactionHash });
    const closing = e.end ? drainers[drainers.length - 1] : null;
    const refill = e.startedBefore ? 'before window' : await refillKind(e.start.transactionHash);

    // Was anything liquidatable, and what could a slice have earned? Read state at the refill block.
    const uw = await underwaterAt(sb).catch(() => null);
    const nav = await navAt(sb);
    let biteProfitUsd = 0;
    let biteCashUsed = 0;
    if (uw && uw.count && nav.net) {
      const cashShares = e.peak / (nav.gross || nav.net);
      const biteShares = Math.min(uw.seizableShares, cashShares);
      const frac = uw.seizableShares ? biteShares / uw.seizableShares : 0;
      const proceedsUsd = biteShares * nav.net * (uUsd || 0);
      const repayUsd = uw.repayUsdAll * frac;
      biteCashUsed = biteShares * (nav.gross || nav.net);
      biteProfitUsd = proceedsUsd - repayUsd - t.gasUsd;
    }
    rows.push({
      startBlock: Number(sb), endBlock: eb == null ? null : Number(eb), blocksOpen, secondsOpen: tsEnd == null ? null : tsEnd - tsStart, bucket,
      startTime: new Date(tsStart * 1000).toISOString(), refillTx: e.start.transactionHash, refillKind: refill,
      peakCash: e.peak, peakCashUsd: e.peak * (uUsd || 0),
      closedBy: closing?.kind ?? null, closedByAddress: closing?.who ?? null,
      drained: Object.fromEntries(['morpho-liquidator', 'direct-redeemer', 'operator/other'].map((k) => [k, drainers.filter((d) => d.kind === k).reduce((s, d) => s + d.amount, 0)])),
      drainers: drainers.slice(0, 20),
      underwaterLoans: uw?.count ?? null, underwaterDebtUsd: uw?.debtUsd ?? null, navPerShare: nav.net,
      oraclePerShare: uw?.perMarket?.[0]?.oraclePrice ?? null,
      biteCashUsed, biteProfitUsd,
    });
  }
  if (detailed.length >= 20) process.stdout.write(`\r    checking episodes ${detailed.length}/${detailed.length}   \n`);

  // 4. Every liquidation in the window: did it redeem from the vault in the same tx (= someone already does this)?
  const liqRows = [];
  for (const l of liqs) {
    const r = await receipt(l.transactionHash);
    const redeemed = r.logs.some((x) => lower(x.address) === lower(t.vault) && x.topics[0] === T_WITHDRAW);
    const tookCash = outs.some((o) => o.transactionHash === l.transactionHash);
    const m = markets.find((mm) => lower(mm.marketId) === lower(l.args.id));
    liqRows.push({
      block: Number(l.blockNumber), tx: l.transactionHash, liquidator: r.from, viaContract: r.to, borrower: l.args.borrower,
      repaidUsd: num(l.args.repaidAssets, m.loanAsset.decimals) * (m.loanAsset.price?.usd || 0), seizedShares: num(l.args.seizedAssets, m.collateralAsset.decimals),
      redeemedInSameTx: redeemed || tookCash,
    });
  }

  const now = await underwaterAt(toBlock).catch(() => null);
  return {
    key: t.key, chain: t.chain, chainId: t.chainId, vault: t.vault, underlying, underlyingSymbol: uSym, buffer, days: DAYS, fromBlock: Number(fromBlock), toBlock: Number(toBlock), secPerBlock,
    minCashUsd: MIN_CASH_USD, cashNow: toU(balNow), cashNowUsd: toU(balNow) * (uUsd || 0), underwaterNow: now ? { count: now.count, debtUsd: now.debtUsd } : null,
    markets: markets.map((m) => ({ marketId: m.marketId, pair: `${m.collateralAsset.symbol}/${m.loanAsset.symbol}`, borrowUsd: m.state.borrowAssetsUsd, lltv: Number(m.lltv) / 1e18 })),
    transfersIn: ins.length, transfersOut: outs.length, episodesTotal: episodes.length, episodesDetailed: rows.length, episodes: rows, liquidations: liqRows,
  };
}

// ---------- main ----------
console.log(`Buffer replay (read-only): when cash landed in a trapped vault, how long did it stay and who took it? Last ${DAYS} days, cash ≥ ${usd(MIN_CASH_USD)}.`);
const results = [];
for (const t of TARGETS) {
  try {
    results.push(await replay(t));
  } catch (e) {
    console.log(`  ${t.key}: error ${(e.shortMessage || e.message).slice(0, 200)} ${process.env.DEBUG ? e.stack : ""}`);
    results.push({ key: t.key, chain: t.chain, error: (e.shortMessage || e.message).slice(0, 300) });
  }
}

const BUCKETS = ['same tx', 'same block', '1-2 blocks', '>2 blocks', 'still open'];
for (const r of results) {
  if (r.error) continue;
  const ep = r.episodes;
  const uwEp = ep.filter((e) => e.underwaterLoans > 0);
  const weeks = r.days / 7;
  console.log(`\n=== ${r.key} on ${r.chain} (${r.markets.map((m) => `${m.pair} ${usd(m.borrowUsd)}`).join(', ')}) ===`);
  console.log(`  cash redeemable now: ${usd(r.cashNowUsd)}   loans underwater now: ${r.underwaterNow?.count ?? '?'} (${usd(r.underwaterNow?.debtUsd)} debt)`);
  console.log(`  ${r.transfersIn} transfers in, ${r.transfersOut} out → ${r.episodesTotal} times cash reached ≥ ${usd(r.minCashUsd)}${r.episodesTotal > r.episodesDetailed ? ` (latest ${r.episodesDetailed} checked)` : ''}; ${uwEp.length} while a loan was underwater`);
  console.log(`  ${'how long the cash stayed'.padEnd(26)} ${BUCKETS.map((b) => b.padStart(11)).join('')}`);
  console.log(`  ${'all refills'.padEnd(26)} ${BUCKETS.map((b) => String(ep.filter((e) => e.bucket === b).length).padStart(11)).join('')}`);
  console.log(`  ${'…with a loan underwater'.padEnd(26)} ${BUCKETS.map((b) => String(uwEp.filter((e) => e.bucket === b).length).padStart(11)).join('')}`);
  const kinds = ['morpho-liquidator', 'direct-redeemer', 'operator/other'];
  console.log(`  closed by (count / $ drained):  ${kinds.map((k) => `${k} ${ep.filter((e) => e.closedBy === k).length} / ${usd(ep.reduce((s, e) => s + (e.drained[k] || 0), 0) * (r.cashNowUsd && r.cashNow ? r.cashNowUsd / r.cashNow : 1))}`).join('   ')}`);
  const top = Object.entries(ep.filter((e) => e.closedByAddress).reduce((o, e) => ((o[`${e.closedBy} ${e.closedByAddress}`] = (o[`${e.closedBy} ${e.closedByAddress}`] || 0) + 1), o), {})).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (top.length) console.log(`  top closers: ${top.map(([k, n]) => `${k.split(' ')[0]} ${short(k.split(' ')[1])}×${n}`).join(', ')}`);
  const refills = Object.entries(ep.reduce((o, e) => ((o[e.refillKind] = (o[e.refillKind] || 0) + 1), o), {}));
  console.log(`  refills came from: ${refills.map(([k, n]) => `${k} ${n}`).join(', ') || '-'}`);
  const open1 = uwEp.filter((e) => e.blocksOpen == null || e.blocksOpen >= 1);
  const open3 = uwEp.filter((e) => e.blocksOpen == null || e.blocksOpen > 2);
  const sum = (a) => a.reduce((s, e) => s + Math.max(0, e.biteProfitUsd), 0);
  console.log(`  profitable slices (> $1) while underwater: ${uwEp.filter((e) => e.biteProfitUsd > 1).length}; hypothetical profit if we took every window open ≥ 1 block: ${usd(sum(open1))} (~${usd(sum(open1) / weeks)}/week); open > 2 blocks: ${usd(sum(open3))} (~${usd(sum(open3) / weeks)}/week)`);
  const lq = r.liquidations;
  console.log(`  liquidations on these markets: ${lq.length} (${usd(lq.reduce((s, l) => s + l.repaidUsd, 0))} repaid); redeemed from the vault in the same tx: ${lq.filter((l) => l.redeemedInSameTx).length}`);
  if (lq.length) {
    const byLiq = Object.entries(lq.reduce((o, l) => ((o[l.liquidator] = (o[l.liquidator] || 0) + 1), o), {})).sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`  liquidators: ${byLiq.map(([a, n]) => `${short(a)}×${n}`).join(', ')}`);
  }
  if (r.underlying && r.markets.length && r.key === 'ynETHx') console.log(`  note: redeeming gives ${r.underlyingSymbol} but the debt is in the loan token; profit assumes a swap at API prices (msETH is thin).`);
}

fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync('reports/buffer-replay.json', JSON.stringify({ at: new Date().toISOString(), days: DAYS, minCashUsd: MIN_CASH_USD, results }, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
console.log(`\nSaved reports/buffer-replay.json`);
