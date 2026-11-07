// Aave v3 on smaller chains: who's competing for liquidations, and is anything liquidatable right now?
// Reads straight from each chain (no API lists Aave borrowers). Read-only.
// Usage: npm run aave [-- days] [chainId,chainId,...]
import fs from 'node:fs';
import { createPublicClient, http, parseAbi, parseAbiItem } from 'viem';
import { usd, short } from './config.mjs';

const DAYS = Number(process.argv[2] || 30);
const ONLY = process.argv[3] ? process.argv[3].split(',').map(Number) : null;
const TIME_BUDGET_MS = 150_000; // per chain, for reading event history

const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const AAVE = {
  9745: { name: 'Plasma', pool: '0x925a2A7214Ed92428B5b1B090F80b25700095e12', rpc: 'https://rpc.plasma.to' },
  143: { name: 'Monad', pool: '0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef', rpc: 'https://rpc.monad.xyz' },
  43114: { name: 'Avalanche', pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', rpc: 'https://avalanche-c-chain-rpc.publicnode.com' },
  5000: { name: 'Mantle', pool: '0x458F293454fE0d67EC0655f3672301301DD51422', rpc: 'https://mantle-rpc.publicnode.com' },
  56: { name: 'BNB', pool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB', rpc: 'https://bsc-rpc.publicnode.com' },
  137: { name: 'Polygon', pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', rpc: 'https://polygon-bor-rpc.publicnode.com' },
  57073: { name: 'Ink', pool: '0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA', rpc: 'https://rpc-gel.inkonchain.com' },
  196: { name: 'X Layer', pool: '0xE3F3Caefdd7180F884c01E57f65Df979Af84f116', rpc: 'https://rpc.xlayer.tech' },
  10: { name: 'Optimism', pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', rpc: 'https://optimism-rpc.publicnode.com' },
  100: { name: 'Gnosis', pool: '0xb50201558B00496A145fE76f7424749556E326D8', rpc: 'https://gnosis-rpc.publicnode.com' },
  59144: { name: 'Linea', pool: '0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac', rpc: 'https://linea-rpc.publicnode.com' },
  4326: { name: 'MegaETH', pool: '0x7e324AbC5De01d112AfC03a584966ff199741C28', rpc: 'https://mainnet.megaeth.com/rpc' },
  146: { name: 'Sonic', pool: '0x5362dBb1e601abF3a4c14c22ffEdA64042E5eAA3', rpc: 'https://sonic-rpc.publicnode.com' },
  42220: { name: 'Celo', pool: '0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402', rpc: 'https://celo-rpc.publicnode.com' },
  534352: { name: 'Scroll', pool: '0x11fCfe756c05AD438e312a7fd934381537D3cFfe', rpc: 'https://scroll-rpc.publicnode.com' },
};
for (const id of Object.keys(AAVE)) if (process.env[`RPC_${id}`]) AAVE[id].rpc = process.env[`RPC_${id}`];

const poolAbi = parseAbi([
  'function getUserAccountData(address) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function ADDRESSES_PROVIDER() view returns (address)',
]);
const providerAbi = parseAbi(['function getPriceOracle() view returns (address)']);
const oracleAbi = parseAbi(['function getAssetPrice(address) view returns (uint256)']);
const erc20Abi = parseAbi(['function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
const BORROW = parseAbiItem('event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)');
const LIQ = parseAbiItem('event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Walk backwards through history in chunks, shrinking the chunk when the RPC complains.
async function getLogsBack(c, address, events, fromBlock, toBlock, deadline) {
  const logs = [];
  let chunk = 50_000n;
  let hi = toBlock;
  let fails = 0;
  while (hi >= fromBlock && Date.now() < deadline) {
    const lo = hi - chunk + 1n > fromBlock ? hi - chunk + 1n : fromBlock;
    try {
      const got = await c.getLogs({ address, events, fromBlock: lo, toBlock: hi });
      logs.push(...got);
      hi = lo - 1n;
      fails = 0;
      if (chunk < 200_000n) chunk = chunk * 3n / 2n;
    } catch (e) {
      fails++;
      chunk = chunk / 3n > 200n ? chunk / 3n : 200n;
      if (fails > 8) return { logs, reachedBlock: hi, error: (e.shortMessage || e.message).slice(0, 100) };
      await sleep(400);
    }
  }
  return { logs, reachedBlock: hi < fromBlock ? fromBlock : hi, complete: hi < fromBlock };
}

async function scanChain(id, cfg) {
  const chainDef = { id: Number(id), name: cfg.name, nativeCurrency: { name: 'x', symbol: 'x', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpc] } }, contracts: { multicall3: { address: MC3 } } };
  const c = createPublicClient({ chain: chainDef, batch: { multicall: { batchSize: 2048 } }, transport: http(cfg.rpc, { timeout: 30000, retryCount: 3, retryDelay: 1500 }) });

  const latest = await c.getBlock();
  const older = await c.getBlock({ blockNumber: latest.number > 100_000n ? latest.number - 100_000n : 1n });
  const secPerBlock = Number(latest.timestamp - older.timestamp) / Number(latest.number - older.number) || 1;
  const fromBlock = latest.number - BigInt(Math.floor((DAYS * 86400) / secPerBlock));

  const { logs, reachedBlock, complete, error } = await getLogsBack(c, cfg.pool, [BORROW, LIQ], fromBlock, latest.number, Date.now() + TIME_BUDGET_MS);
  const coveredDays = (Number(latest.number - reachedBlock) * secPerBlock) / 86400;

  // Prices for valuing past liquidations
  const provider = await c.readContract({ address: cfg.pool, abi: poolAbi, functionName: 'ADDRESSES_PROVIDER' });
  const oracle = await c.readContract({ address: provider, abi: providerAbi, functionName: 'getPriceOracle' });
  const assetInfo = new Map();
  const info = async (a) => {
    if (!assetInfo.has(a)) {
      assetInfo.set(a, (async () => {
        const [price, dec, sym] = await Promise.all([
          c.readContract({ address: oracle, abi: oracleAbi, functionName: 'getAssetPrice', args: [a] }).catch(() => 0n),
          c.readContract({ address: a, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
          c.readContract({ address: a, abi: erc20Abi, functionName: 'symbol' }).catch(() => '?'),
        ]);
        return { price: Number(price) / 1e8, dec: Number(dec), sym };
      })());
    }
    return assetInfo.get(a);
  };

  const borrowers = new Set();
  const liqs = [];
  for (const l of logs) {
    if (l.eventName === 'Borrow') borrowers.add(l.args.onBehalfOf);
    else liqs.push(l);
  }

  // Competition
  const byLiq = new Map();
  let totalBonus = 0;
  for (const l of liqs) {
    const [ci, di] = await Promise.all([info(l.args.collateralAsset), info(l.args.debtAsset)]);
    const collUsd = (Number(l.args.liquidatedCollateralAmount) / 10 ** ci.dec) * ci.price;
    const debtUsd = (Number(l.args.debtToCover) / 10 ** di.dec) * di.price;
    const bonus = Math.max(0, Math.min(collUsd - debtUsd, collUsd * 0.2));
    totalBonus += bonus;
    const L = byLiq.get(l.args.liquidator) || { count: 0, bonus: 0 };
    L.count++; L.bonus += bonus; byLiq.set(l.args.liquidator, L);
  }
  const bots = [...byLiq.entries()].sort((a, b) => b[1].bonus - a[1].bonus);

  // Current health of every recent borrower
  const list = [...borrowers];
  const health = [];
  for (let i = 0; i < list.length; i += 500) {
    const part = list.slice(i, i + 500);
    const res = await Promise.all(part.map((u) => c.readContract({ address: cfg.pool, abi: poolAbi, functionName: 'getUserAccountData', args: [u] }).catch(() => null)));
    res.forEach((r, j) => r && health.push({ user: part[j], coll: Number(r[0]) / 1e8, debt: Number(r[1]) / 1e8, hf: Number(r[5]) / 1e18 }));
  }
  const open = health.filter((h) => h.debt > 0.01);
  const liquidatable = open.filter((h) => h.hf < 1).map((h) => {
    // Rough: ~5% bonus; up to 50% of debt (100% if HF < 0.95 or tiny). Capped by collateral.
    const closeFactor = h.hf < 0.95 || h.debt < 2000 ? 1 : 0.5;
    const repay = Math.min(h.debt * closeFactor, h.coll / 1.05);
    return { ...h, estProfit: repay * 0.05 };
  }).sort((a, b) => b.estProfit - a.estProfit);
  const nearly = open.filter((h) => h.hf >= 1 && h.hf < 1.03);

  return {
    chain: cfg.name, coveredDays, complete, error, borrowersChecked: open.length,
    liquidations: liqs.length, bots: bots.length, totalBonus, topShare: totalBonus ? bots[0][1].bonus / totalBonus : 0,
    topBots: bots.slice(0, 5).map(([a, v]) => ({ address: a, ...v })),
    liquidatable, nearlyCount: nearly.length, nearlyDebt: nearly.reduce((s, h) => s + h.debt, 0),
  };
}

const results = [];
const ids = Object.keys(AAVE).filter((id) => !ONLY || ONLY.includes(Number(id)));
await Promise.all(ids.map(async (id) => {
  const cfg = AAVE[id];
  try {
    const r = await scanChain(id, cfg);
    results.push(r);
    console.log(`✓ ${cfg.name}: ${r.liquidations} liquidations / ${r.bots} bots over ${r.coveredDays.toFixed(1)}d, ${r.liquidatable.length} liquidatable now`);
  } catch (e) {
    results.push({ chain: cfg.name, failed: (e.shortMessage || e.message).slice(0, 140) });
    console.log(`✗ ${cfg.name}: ${(e.shortMessage || e.message).slice(0, 140)}`);
  }
}));

console.log(`\n=== Aave on smaller chains (target ${DAYS} days of history) ===`);
console.log('chain       history  liquidations  bots  ~bonuses   top-bot  borrowers  closeable-now  est-profit-now  at-risk(HF<1.03)');
for (const r of results.sort((a, b) => (b.totalBonus || 0) - (a.totalBonus || 0))) {
  if (r.failed) { console.log(`${r.chain.padEnd(11)} FAILED: ${r.failed}`); continue; }
  const profitNow = r.liquidatable.reduce((s, x) => s + x.estProfit, 0);
  console.log(`${r.chain.padEnd(11)} ${(r.coveredDays.toFixed(1) + 'd').padEnd(8)} ${String(r.liquidations).padStart(12)}  ${String(r.bots).padStart(4)}  ${usd(r.totalBonus).padStart(9)}  ${((r.topShare * 100).toFixed(0) + '%').padStart(7)}  ${String(r.borrowersChecked).padStart(9)}  ${String(r.liquidatable.length).padStart(13)}  ${usd(profitNow).padStart(14)}  ${r.nearlyCount} (${usd(r.nearlyDebt)} debt)`);
}
for (const r of results) {
  if (r.liquidatable?.length) {
    console.log(`\n${r.chain} closeable now:`);
    for (const x of r.liquidatable.slice(0, 8)) console.log(`  ${short(x.user)}  HF ${x.hf.toFixed(3)}  debt ${usd(x.debt)}  coll ${usd(x.coll)}  est profit ~${usd(x.estProfit)}`);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(`reports/aave-${stamp}.json`, JSON.stringify(results, null, 2));
console.log(`\nSaved reports/aave-${stamp}.json`);
