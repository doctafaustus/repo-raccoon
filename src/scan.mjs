// Find Morpho loans that can be liquidated right now, and check if doing it would actually make money.
// Read-only: never sends a transaction. Usage: npm run scan [-- minCollateralUsd]
import fs from 'node:fs';
import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { CHAINS, gql, usd, short } from './config.mjs';

const MIN_COLL_USD = Number(process.argv[2] || 5);
const WAD = 10n ** 18n;
const ORACLE_SCALE = 10n ** 36n;

const morphoAbi = parseAbi([
  'function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
  'function position(bytes32, address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
]);
const oracleAbi = parseAbi(['function price() view returns (uint256)']);

const Q = `query($skip:Int!) {
  marketPositions(first: 1000, skip: $skip, where: { healthFactor_lte: 1 }, orderBy: BorrowShares, orderDirection: Desc) {
    items { healthFactor user { address }
      market { marketId lltv chain { id } morphoBlue { address }
        loanAsset { symbol address decimals price { usd } }
        collateralAsset { symbol address decimals price { usd } } }
      state { collateral collateralUsd borrowAssets borrowAssetsUsd } } } }`;

async function fetchCandidates() {
  const all = [];
  for (let skip = 0; skip < 20000; skip += 1000) {
    const d = await gql(Q, { skip });
    const items = d.marketPositions.items;
    all.push(...items);
    if (items.length < 1000) break;
  }
  return all.filter((p) => (p.state.collateralUsd ?? 0) >= MIN_COLL_USD && CHAINS[p.market.chain.id]);
}

// Morpho's liquidation bonus: min(1.15, 1 / (1 - 0.3 * (1 - lltv)))
const lifOf = (lltv) => {
  const l = (WAD * WAD) / (WAD - (3n * (WAD - lltv)) / 10n);
  return l > (115n * WAD) / 100n ? (115n * WAD) / 100n : l;
};
const divUp = (a, b) => (a + b - 1n) / b;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// KyberSwap rate-limits hard, so quotes go one at a time with a gap, and retry when throttled.
let kyberChain = Promise.resolve();
const quoteCache = new Map();
function kyberQuote(chain, tokenIn, tokenOut, amountIn) {
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) return Promise.resolve({ amountOut: amountIn, gasUsd: 0 });
  if (!chain.kyber) return Promise.resolve({ error: 'no swap pricing on this chain', unpriced: true });
  const job = kyberChain.then(() => kyberQuoteNow(chain, tokenIn, tokenOut, amountIn));
  kyberChain = job.then(() => sleep(700), () => sleep(700));
  return job;
}

async function kyberQuoteNow(chain, tokenIn, tokenOut, amountIn) {
  const url = `https://aggregator-api.kyberswap.com/${chain.kyber}/api/v1/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`;
  if (quoteCache.has(url)) return quoteCache.get(url);
  let last = 'no route';
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'x-client-id': 'repo-raccoon' } });
      const j = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
      const r = j?.data?.routeSummary;
      if (r) {
        const out = { amountOut: BigInt(r.amountOut), amountInUsd: Number(r.amountInUsd), amountOutUsd: Number(r.amountOutUsd), gasUsd: Number(r.gasUsd || 0) };
        quoteCache.set(url, out);
        return out;
      }
      last = j?.message || `HTTP ${res.status}`;
      if (!/forbidden|rate|429|too many/i.test(last) && res.status !== 403 && res.status !== 429) break;
    } catch (e) {
      last = e.message;
    }
    await sleep(3000 * (attempt + 1));
  }
  const out = /forbidden|rate|429|too many/i.test(last) ? { error: last, throttled: true } : { error: last };
  quoteCache.set(url, out);
  return out;
}

const clients = {};
const client = (id) =>
  (clients[id] ||= createPublicClient({
    batch: { multicall: true },
    transport: http(CHAINS[id].rpc, { timeout: 30000, retryCount: 6, retryDelay: 2000 }),
  }));

async function check(p) {
  const id = p.market.chain.id;
  const chain = CHAINS[id];
  const c = client(id);
  const morpho = p.market.morphoBlue.address;
  const mid = p.market.marketId;
  const user = p.user.address;
  const r = {
    chain: chain.name, market: mid, borrower: user,
    pair: `${p.market.collateralAsset?.symbol}/${p.market.loanAsset?.symbol}`,
    apiCollateralUsd: p.state.collateralUsd, apiDebtUsd: p.state.borrowAssetsUsd,
  };
  try {
    const [params, pos, mkt] = await Promise.all([
      c.readContract({ address: morpho, abi: morphoAbi, functionName: 'idToMarketParams', args: [mid] }),
      c.readContract({ address: morpho, abi: morphoAbi, functionName: 'position', args: [mid, user] }),
      c.readContract({ address: morpho, abi: morphoAbi, functionName: 'market', args: [mid] }),
    ]);
    const [loanToken, collToken, oracle, , lltv] = params;
    const [, borrowShares, collateral] = pos;
    const [, , totalBorrowAssets, totalBorrowShares] = mkt;
    if (borrowShares === 0n || collateral === 0n) return { ...r, verdict: 'already closed' };

    let price;
    try {
      price = await c.readContract({ address: oracle, abi: oracleAbi, functionName: 'price' });
    } catch {
      return { ...r, verdict: 'TRAP: price oracle is broken (reverts), liquidation would fail' };
    }
    if (price === 0n) return { ...r, verdict: 'TRAP: oracle price is 0' };

    // Debt in loan-token units (virtual shares = 1e6, virtual assets = 1). Ignores interest since last update (tiny).
    const debt = divUp(BigInt(borrowShares) * (totalBorrowAssets + 1n), totalBorrowShares + 10n ** 6n);
    const maxBorrow = (((BigInt(collateral) * price) / ORACLE_SCALE) * lltv) / WAD;
    const hf = Number((maxBorrow * 10000n) / (debt || 1n)) / 10000;
    if (maxBorrow >= debt) return { ...r, onchainHF: hf, verdict: 'healthy on-chain (API was stale)' };

    const lif = lifOf(lltv);
    // Seize as much collateral as the debt allows (all of it if the loan is underwater).
    let seized = BigInt(collateral);
    let repaid = divUp(divUp(seized * price, ORACLE_SCALE) * WAD, lif);
    if (repaid > debt) {
      repaid = debt;
      seized = (((debt * lif) / WAD) * ORACLE_SCALE) / price;
    }

    const q = await kyberQuote(chain, collToken, loanToken, seized);
    const ld = p.market.loanAsset.decimals;
    const loanUsd = p.market.loanAsset.price?.usd ?? 1;
    const repaidUsd = Number(formatUnits(repaid, ld)) * loanUsd;
    const base = { ...r, onchainHF: hf, lif: Number(lif) / 1e18, badDebt: repaid < debt, repaidUsd, loanToken, collToken };
    if (q.unpriced) return { ...base, verdict: `unknown: can't price the sale on this chain (repay ${usd(repaidUsd)} for collateral the API values at ${usd(p.state.collateralUsd)})` };
    if (q.throttled) return { ...base, verdict: `unknown: price service throttled us, re-run later` };
    if (q.error) return { ...base, verdict: `TRAP: can't sell the collateral (${q.error})` };

    const sellUsd = Number(formatUnits(q.amountOut, ld)) * loanUsd;
    const gasUsd = (q.gasUsd || 0) * 2.5; // swap + liquidation + flash loan overhead, rough
    const profit = sellUsd - repaidUsd - gasUsd;
    const impact = q.amountInUsd ? 1 - q.amountOutUsd / q.amountInUsd : null;
    let verdict = profit > 1 ? 'PROFITABLE' : 'not profitable';
    if (profit > 1 && impact != null && impact > 0.05) verdict = 'PROFITABLE but thin market (high price impact)';
    return { ...base, sellUsd, gasUsd, profitUsd: profit, priceImpact: impact, verdict };
  } catch (e) {
    return { ...r, verdict: `error: ${e.shortMessage || e.message}`.slice(0, 160) };
  }
}

console.log(`Fetching liquidatable positions with ≥ ${usd(MIN_COLL_USD)} collateral…`);
const cands = await fetchCandidates();
console.log(`${cands.length} candidates. Checking each on-chain + pricing the sale…\n`);

const results = [];
const BATCH = 3;
for (let i = 0; i < cands.length; i += BATCH) {
  results.push(...(await Promise.all(cands.slice(i, i + BATCH).map(check))));
  process.stdout.write(`\r  checked ${Math.min(i + BATCH, cands.length)}/${cands.length}`);
}
console.log('\n');

const tally = {};
for (const r of results) {
  const k = r.verdict.split(' (')[0].split(':')[0];
  tally[k] = (tally[k] || 0) + 1;
}
console.log('Summary:', tally, '\n');

const good = results.filter((r) => r.verdict.startsWith('PROFITABLE')).sort((a, b) => b.profitUsd - a.profitUsd);
console.log(`Profitable right now: ${good.length}`);
for (const r of good.slice(0, 30)) {
  console.log(`  ${r.chain.padEnd(9)} ${r.pair.padEnd(20)} profit ~${usd(r.profitUsd).padEnd(9)} pay ${usd(r.repaidUsd).padEnd(9)} sell ${usd(r.sellUsd).padEnd(9)} ${r.badDebt ? 'underwater ' : ''}${r.verdict !== 'PROFITABLE' ? '⚠ ' + r.verdict : ''}  borrower ${short(r.borrower)}`);
}

const traps = results.filter((r) => r.verdict.startsWith('TRAP')).sort((a, b) => (b.apiCollateralUsd || 0) - (a.apiCollateralUsd || 0));
console.log(`\nLook-profitable-but-aren't (top 10 by collateral):`);
for (const r of traps.slice(0, 10)) console.log(`  ${r.chain.padEnd(9)} ${r.pair.padEnd(20)} coll ${usd(r.apiCollateralUsd).padEnd(9)} ${r.verdict}`);

const notProf = results.filter((r) => r.verdict === 'not profitable').sort((a, b) => (b.apiCollateralUsd || 0) - (a.apiCollateralUsd || 0));
console.log(`\nNot profitable after selling (top 10 by collateral):`);
for (const r of notProf.slice(0, 10)) console.log(`  ${r.chain.padEnd(9)} ${r.pair.padEnd(20)} coll ${usd(r.apiCollateralUsd).padEnd(9)} would pay ${usd(r.repaidUsd)} → sell for ${usd(r.sellUsd)} (price impact ${r.priceImpact != null ? (r.priceImpact * 100).toFixed(1) + '%' : '?'})`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(`reports/scan-${stamp}.json`, JSON.stringify(results, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
console.log(`\nSaved reports/scan-${stamp}.json`);
