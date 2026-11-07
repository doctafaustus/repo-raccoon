// Aave v3: how long did loans sit liquidatable before a bot took them, by bonus size?
// Read-only. Usage: node src/aave-winners.mjs <chainId> [days]
import fs from 'node:fs';
import { createPublicClient, http, parseAbi, parseAbiItem } from 'viem';
import { usd, short } from './config.mjs';

const NETS = {
  43114: { name: 'Avalanche', pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', logsRpc: 'https://avalanche-c-chain-rpc.publicnode.com', stateRpc: 'https://api.avax.network/ext/bc/C/rpc' },
  137: { name: 'Polygon', pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', logsRpc: 'https://polygon-bor-rpc.publicnode.com', stateRpc: 'https://polygon.drpc.org' },
};
const CHAIN_ID = Number(process.argv[2] || 43114);
const DAYS = Number(process.argv[3] || 30);
const N = NETS[CHAIN_ID];
const PROBE_SEC = [2, 10, 60, 300, 1800, 10800];

const mk = (rpc) => createPublicClient({ transport: http(rpc, { timeout: 30000, retryCount: 5, retryDelay: 1500 }) });
const logsC = mk(N.logsRpc);
const stateC = mk(N.stateRpc);

const poolAbi = parseAbi([
  'function getUserAccountData(address) view returns (uint256, uint256, uint256, uint256, uint256, uint256 healthFactor)',
  'function ADDRESSES_PROVIDER() view returns (address)',
]);
const LIQ = parseAbiItem('event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const latest = await logsC.getBlock();
const older = await logsC.getBlock({ blockNumber: latest.number - 20000n });
const BLOCK_SEC = Number(latest.timestamp - older.timestamp) / 20000;
const PROBES = PROBE_SEC.map((s) => BigInt(Math.max(1, Math.round(s / BLOCK_SEC))));
const fromBlock = latest.number - BigInt(Math.floor((DAYS * 86400) / BLOCK_SEC));
console.log(`${N.name}: ~${BLOCK_SEC.toFixed(2)}s/block, reading ${DAYS}d of liquidations…`);

const logs = [];
let hi = latest.number, chunk = 50_000n, fails = 0;
while (hi >= fromBlock) {
  const lo = hi - chunk + 1n > fromBlock ? hi - chunk + 1n : fromBlock;
  try { logs.push(...(await logsC.getLogs({ address: N.pool, event: LIQ, fromBlock: lo, toBlock: hi }))); hi = lo - 1n; fails = 0; }
  catch { if (++fails > 10) break; chunk = chunk / 3n > 500n ? chunk / 3n : 500n; await sleep(500); }
}
console.log(`${logs.length} liquidations found`);

// prices + decimals
const provider = await stateC.readContract({ address: N.pool, abi: poolAbi, functionName: 'ADDRESSES_PROVIDER' });
const oracle = await stateC.readContract({ address: provider, abi: parseAbi(['function getPriceOracle() view returns (address)']), functionName: 'getPriceOracle' });
const info = new Map();
const getInfo = (a) => {
  if (!info.has(a)) info.set(a, Promise.all([
    stateC.readContract({ address: oracle, abi: parseAbi(['function getAssetPrice(address) view returns (uint256)']), functionName: 'getAssetPrice', args: [a] }).catch(() => 0n),
    stateC.readContract({ address: a, abi: parseAbi(['function decimals() view returns (uint8)']), functionName: 'decimals' }).catch(() => 18),
    stateC.readContract({ address: a, abi: parseAbi(['function symbol() view returns (string)']), functionName: 'symbol' }).catch(() => '?'),
  ]).then(([p, d, s]) => ({ price: Number(p) / 1e8, dec: Number(d), sym: s })));
  return info.get(a);
};

const rows = [];
for (const l of logs) {
  const [ci, di] = await Promise.all([getInfo(l.args.collateralAsset), getInfo(l.args.debtAsset)]);
  const collUsd = (Number(l.args.liquidatedCollateralAmount) / 10 ** ci.dec) * ci.price;
  const debtUsd = (Number(l.args.debtToCover) / 10 ** di.dec) * di.price;
  rows.push({ block: l.blockNumber, tx: l.transactionHash, user: l.args.user, liquidator: l.args.liquidator, pair: `${ci.sym}/${di.sym}`, debtUsd, bonusUsd: Math.max(0, Math.min(collUsd - debtUsd, collUsd * 0.2)) });
}

// replay: was the user already liquidatable N seconds earlier?
const liquidatable = async (user, block) => {
  const r = await stateC.readContract({ address: N.pool, abi: poolAbi, functionName: 'getUserAccountData', args: [user], blockNumber: block });
  return r[1] > 0n && r[5] < 10n ** 18n;
};
let i = 0, done = 0;
await Promise.all(Array.from({ length: 5 }, async () => {
  while (i < rows.length) {
    const r = rows[i++];
    let lag = 0;
    try {
      for (let k = 0; k < PROBES.length; k++) {
        if (await liquidatable(r.user, r.block - PROBES[k])) lag = PROBE_SEC[k]; else break;
      }
      r.lagSec = lag;
    } catch { r.lagSec = null; }
    if (++done % 10 === 0) process.stdout.write(`\r  replayed ${done}/${rows.length}`);
  }
}));
console.log('\n');

const ORDER = [[0, '<2s'], [2, '2-10s'], [10, '10s-1m'], [60, '1-5m'], [300, '5-30m'], [1800, '30m-3h'], [10800, '3h+']];
const lbl = (s) => ORDER.find(([v]) => v === s)?.[1] ?? '?';
const P = rows.filter((r) => r.lagSec != null);
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(0) + '%' : '-');
console.log('bonus      count  ' + ORDER.map(([, n]) => n.padEnd(7)).join(' '));
for (const [name, lo, hi] of [['<$5', 0, 5], ['$5–50', 5, 50], ['$50–500', 50, 500], ['$500+', 500, Infinity]]) {
  const g = P.filter((r) => r.bonusUsd >= lo && r.bonusUsd < hi);
  console.log(`${name.padEnd(10)} ${String(g.length).padStart(5)}  ` + ORDER.map(([, n]) => pct(g.filter((r) => lbl(r.lagSec) === n).length, g.length).padEnd(7)).join(' '));
}
const slow = P.filter((r) => r.bonusUsd >= 5 && r.lagSec >= 2).sort((a, b) => b.bonusUsd - a.bonusUsd);
console.log(`\n$5+ liquidations that sat ≥2s: ${slow.length} of ${P.filter((r) => r.bonusUsd >= 5).length}, worth ~${usd(slow.reduce((s, r) => s + r.bonusUsd, 0))}`);
for (const r of slow.slice(0, 15)) console.log(`  ${r.pair.padEnd(16)} bonus ${usd(r.bonusUsd).padEnd(8)} sat ${lbl(r.lagSec).padEnd(7)} winner ${short(r.liquidator)}`);
const bots = new Map();
for (const r of rows) { const b = bots.get(r.liquidator) || { n: 0, bonus: 0 }; b.n++; b.bonus += r.bonusUsd; bots.set(r.liquidator, b); }
console.log('\ntop bots:');
for (const [a, b] of [...bots.entries()].sort((x, y) => y[1].bonus - x[1].bonus).slice(0, 6)) console.log(`  ${short(a)}  wins ${b.n}  ~${usd(b.bonus)}`);
fs.writeFileSync(`reports/aave-winners-${CHAIN_ID}.json`, JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
