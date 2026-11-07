// Study the bots that win Morpho liquidations on one chain:
//  - how fast they act (how long a loan sat liquidatable before someone took it)
//  - how much they pay to get ahead (priority fee, position in block)
//  - which loan sizes / markets they take quickly vs. leave sitting
// Read-only. Usage: npm run winners [-- days] [chainId]
import fs from 'node:fs';
import { createPublicClient, http, parseAbi } from 'viem';
import { gql, usd, short, CHAINS } from './config.mjs';

const DAYS = Number(process.argv[2] || 30);
const CHAIN_ID = Number(process.argv[3] || 8453);
const RPC = process.env[`RPC_${CHAIN_ID}`] || CHAINS[CHAIN_ID]?.rpc || 'https://base-rpc.publicnode.com';
const PROBE_SEC = [2, 10, 60, 300, 1800, 10800]; // how far back to check: 2s, 10s, 1m, 5m, 30m, 3h

const c = createPublicClient({
  chain: { id: CHAIN_ID, name: 'x', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } }, contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } } },
  batch: { multicall: !process.env.NO_MULTICALL },
  transport: http(RPC, { timeout: 30000, retryCount: 5, retryDelay: 1500 }),
});

const _latest = await c.getBlock();
const _older = await c.getBlock({ blockNumber: _latest.number - 2000n });
const BLOCK_SEC = Number(_latest.timestamp - _older.timestamp) / 2000 || 1;
const PROBES = PROBE_SEC.map((s) => BigInt(Math.max(1, Math.round(s / BLOCK_SEC))));
console.log(`chain ${CHAIN_ID}: ~${BLOCK_SEC.toFixed(2)}s per block`);

const morphoAbi = parseAbi([
  'function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
  'function position(bytes32, address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
]);
const oracleAbi = parseAbi(['function price() view returns (uint256)']);

const since = Math.floor(Date.now() / 1000) - DAYS * 86400;
const Q = `query($chain:Int!, $since:Int!, $skip:Int!) {
  marketTransactions(first: 1000, skip: $skip, orderBy: Timestamp, orderDirection: Desc,
    where: { type_in: [Liquidation], chainId_in: [$chain], timestamp_gte: $since }) {
    items { txHash timestamp blockNumber user { address }
      data { ... on MarketTransactionLiquidationData { liquidator repaidAssets seizedAssets badDebtAssets } }
      market { marketId lltv morphoBlue { address }
        collateralAsset { symbol decimals price { usd } }
        loanAsset { symbol decimals price { usd } } } } } }`;

const liqs = [];
for (let skip = 0; skip < 20000; skip += 1000) {
  const d = await gql(Q, { chain: CHAIN_ID, since, skip });
  liqs.push(...d.marketTransactions.items);
  if (d.marketTransactions.items.length < 1000) break;
}
const ethUsd = (await gql(`{ assetByAddress(address:"0x4200000000000000000000000000000000000006", chainId:${CHAIN_ID}){ price{usd} } }`).catch(() => null))?.assetByAddress?.price?.usd || 3000;
console.log(`${liqs.length} liquidations in ${DAYS} days. ETH ≈ ${usd(ethUsd)}. Pulling transactions + replaying history…`);

// ---- per-liquidation value
for (const l of liqs) {
  const m = l.market;
  const seized = (Number(l.data.seizedAssets) / 10 ** m.collateralAsset.decimals) * (m.collateralAsset.price?.usd ?? 0);
  const repaid = (Number(l.data.repaidAssets) / 10 ** m.loanAsset.decimals) * (m.loanAsset.price?.usd ?? 0);
  l.repaidUsd = repaid;
  l.bonusUsd = Math.max(0, Math.min(seized - repaid, seized * 0.2));
  l.pair = `${m.collateralAsset.symbol}/${m.loanAsset.symbol}`;
}

// ---- transaction details (gas, priority fee, block position, sender)
const txs = new Map();
const hashes = [...new Set(liqs.map((l) => l.txHash))];
const pool = async (items, n, fn) => {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
};
let done = 0;
await pool(hashes, 8, async (h) => {
  try {
    const [tx, rc] = await Promise.all([c.getTransaction({ hash: h }), c.getTransactionReceipt({ hash: h })]);
    const l2 = Number(rc.gasUsed * rc.effectiveGasPrice) / 1e18;
    const l1 = rc.l1Fee ? Number(rc.l1Fee) / 1e18 : 0;
    txs.set(h, {
      from: tx.from, to: tx.to, index: tx.transactionIndex, block: rc.blockNumber,
      priorityGwei: tx.maxPriorityFeePerGas != null ? Number(tx.maxPriorityFeePerGas) / 1e9 : null,
      gasUsd: (l2 + l1) * ethUsd, ok: rc.status === 'success',
    });
  } catch {}
  if (++done % 50 === 0) process.stdout.write(`\r  txs ${done}/${hashes.length}`);
});
console.log(`\r  txs ${hashes.length}/${hashes.length}`);

// ---- how long was each loan liquidatable before it got taken?
const paramsCache = new Map();
async function liquidatableAt(l, block) {
  const morpho = l.market.morphoBlue.address;
  const id = l.market.marketId;
  if (!paramsCache.has(id)) paramsCache.set(id, c.readContract({ address: morpho, abi: morphoAbi, functionName: 'idToMarketParams', args: [id] }));
  const [, , oracle, , lltv] = await paramsCache.get(id);
  const [pos, mkt, price] = await Promise.all([
    c.readContract({ address: morpho, abi: morphoAbi, functionName: 'position', args: [id, l.user.address], blockNumber: block }),
    c.readContract({ address: morpho, abi: morphoAbi, functionName: 'market', args: [id], blockNumber: block }),
    c.readContract({ address: oracle, abi: oracleAbi, functionName: 'price', blockNumber: block }),
  ]);
  const borrowShares = BigInt(pos[1]);
  if (borrowShares === 0n) return false;
  const debt = (borrowShares * (BigInt(mkt[2]) + 1n)) / (BigInt(mkt[3]) + 10n ** 6n);
  const maxBorrow = (((BigInt(pos[2]) * price) / 10n ** 36n) * lltv) / 10n ** 18n;
  return maxBorrow < debt;
}

// One probe per (tx, borrower). Walk back until the loan was still healthy.
const seen = new Set();
const probeList = liqs.filter((l) => {
  const k = l.txHash + l.user.address + l.market.marketId;
  if (seen.has(k) || !txs.get(l.txHash)) return false;
  seen.add(k);
  return true;
});
done = 0;
await pool(probeList, 6, async (l) => {
  const block = BigInt(l.blockNumber);
  let lagBlocks = 0n;
  try {
    for (const back of PROBES) {
      if (await liquidatableAt(l, block - back)) lagBlocks = back;
      else break;
    }
    l.lagSec = lagBlocks === 0n ? 0 : PROBE_SEC[PROBES.indexOf(lagBlocks)];
    l.lagCapped = lagBlocks === PROBES[PROBES.length - 1];
  } catch { l.lagSec = null; }
  if (++done % 25 === 0) process.stdout.write(`\r  history ${done}/${probeList.length}`);
});
console.log(`\r  history ${probeList.length}/${probeList.length}\n`);

// ---- reports
const lagLabel = (s) => (s == null ? '?' : s === 0 ? 'same block (<2s)' : s <= 10 ? '≤10s' : s <= 60 ? '≤1m' : s <= 300 ? '≤5m' : s <= 1800 ? '≤30m' : s < 10800 ? '≤3h' : '3h+');
const ORDER = ['same block (<2s)', '≤10s', '≤1m', '≤5m', '≤30m', '≤3h', '3h+'];
const P = probeList.filter((l) => l.lagSec != null);
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(0) + '%' : '-');

const out = [];
const log = (s = '') => { console.log(s); out.push(s); };

log(`# How the winners win — chain ${CHAIN_ID}, last ${DAYS} days`);
log(`${liqs.length} liquidations, ${hashes.length} transactions, ${P.length} with timing replayed\n`);

log('## How long loans sat before being taken, by bonus size');
const buckets = [['<$1', 0, 1], ['$1–10', 1, 10], ['$10–100', 10, 100], ['$100–1k', 100, 1000], ['$1k+', 1000, Infinity]];
log('bonus     count  ' + ORDER.map((o) => o.padEnd(8).slice(0, 8)).join(' '));
for (const [name, lo, hi] of buckets) {
  const g = P.filter((l) => l.bonusUsd >= lo && l.bonusUsd < hi);
  log(`${name.padEnd(9)} ${String(g.length).padStart(5)}  ` + ORDER.map((o) => pct(g.filter((l) => lagLabel(l.lagSec) === o).length, g.length).padEnd(8)).join(' '));
}

log('\n## Slow pickups (sat ≥ 1 minute) — where small bots can win');
const slow = P.filter((l) => l.lagSec >= 60).sort((a, b) => b.bonusUsd - a.bonusUsd);
log(`${slow.length} of ${P.length} (${pct(slow.length, P.length)}), worth ~${usd(slow.reduce((s, l) => s + l.bonusUsd, 0))} in bonuses`);
const slowByMarket = new Map();
for (const l of slow) { const m = slowByMarket.get(l.pair) || { n: 0, bonus: 0, repaid: [] }; m.n++; m.bonus += l.bonusUsd; m.repaid.push(l.repaidUsd); slowByMarket.set(l.pair, m); }
for (const [pair, m] of [...slowByMarket.entries()].sort((a, b) => b[1].bonus - a[1].bonus).slice(0, 12))
  log(`  ${pair.padEnd(20)} ${String(m.n).padStart(4)} slow pickups, ~${usd(m.bonus)} total, typical loan repaid ${usd(m.repaid.sort((a, b) => a - b)[Math.floor(m.repaid.length / 2)])}`);
log('  biggest slow ones:');
for (const l of slow.slice(0, 10)) {
  const t = txs.get(l.txHash);
  log(`   ${l.pair.padEnd(18)} bonus ${usd(l.bonusUsd).padEnd(8)} sat ${lagLabel(l.lagSec).padEnd(6)}${l.lagCapped ? '+' : ' '} gas ${usd(t?.gasUsd)}  winner ${short(l.data.liquidator)}  ${new Date(l.timestamp * 1000).toISOString().slice(0, 16)}`);
}

log('\n## The top bots');
const bots = new Map();
for (const l of liqs) {
  const t = txs.get(l.txHash);
  const b = bots.get(l.data.liquidator) || { wins: 0, bonus: 0, gas: 0, prio: [], idx: [], lags: [], senders: new Set(), sizes: [], txs: new Set() };
  b.wins++; b.bonus += l.bonusUsd; b.sizes.push(l.bonusUsd);
  if (t && !b.txs.has(l.txHash)) { b.txs.add(l.txHash); b.gas += t.gasUsd; if (t.priorityGwei != null) b.prio.push(t.priorityGwei); b.idx.push(t.index); b.senders.add(t.from); }
  if (l.lagSec != null) b.lags.push(l.lagSec);
  bots.set(l.data.liquidator, b);
}
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
log('bot            wins   bonuses    gas paid   med prio fee   med block pos   instant(<2s)   smallest bonus   wallets');
for (const [a, b] of [...bots.entries()].sort((x, y) => y[1].bonus - x[1].bonus).slice(0, 12)) {
  const inst = b.lags.filter((s) => s === 0).length;
  log(`${short(a)}  ${String(b.wins).padStart(5)}  ${usd(b.bonus).padStart(9)}  ${usd(b.gas).padStart(9)}  ${(med(b.prio)?.toFixed(4) ?? '?').padStart(10)} gwei  ${String(med(b.idx) ?? '?').padStart(12)}  ${pct(inst, b.lags.length).padStart(13)}  ${usd(Math.min(...b.sizes)).padStart(15)}  ${String(b.senders.size).padStart(7)}`);
}

log('\n## Cheapest wins (smallest bonus anyone bothered with)');
const sizes = liqs.map((l) => l.bonusUsd).sort((a, b) => a - b);
log(`median bonus ${usd(med(sizes))}, 10th pct ${usd(sizes[Math.floor(sizes.length * 0.1)])}, 90th pct ${usd(sizes[Math.floor(sizes.length * 0.9)])}`);
const g = [...txs.values()].map((t) => t.gasUsd).sort((a, b) => a - b);
log(`gas per liquidation tx: median ${usd(med(g))}, 90th pct ${usd(g[Math.floor(g.length * 0.9)])}`);

log('\n## When the money showed up (bonuses per day)');
const byDay = new Map();
for (const l of liqs) { const d = new Date(l.timestamp * 1000).toISOString().slice(0, 10); byDay.set(d, (byDay.get(d) || 0) + l.bonusUsd); }
for (const [d, v] of [...byDay.entries()].sort()) log(`  ${d}  ${usd(v).padStart(9)}  ${'█'.repeat(Math.min(60, Math.round(v / 1000)))}`);

fs.writeFileSync(`reports/winners-${CHAIN_ID}.json`, JSON.stringify({ liqs, txs: Object.fromEntries(txs) }, (k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Set ? [...v] : v), 2));
console.log(`\nSaved reports/winners-${CHAIN_ID}.json`);
