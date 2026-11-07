// Who has been winning Morpho liquidations, per chain and per market?
// Usage: npm run competition [-- days]
import fs from 'node:fs';
import { CHAINS, gql, usd, short } from './config.mjs';

const DAYS = Number(process.argv[2] || 30);
const since = Math.floor(Date.now() / 1000) - DAYS * 86400;

const Q = `query($chain:Int!, $since:Int!, $skip:Int!) {
  marketTransactions(first: 1000, skip: $skip, orderBy: Timestamp, orderDirection: Desc,
    where: { type_in: [Liquidation], chainId_in: [$chain], timestamp_gte: $since }) {
    pageInfo { countTotal }
    items { txHash timestamp
      data { ... on MarketTransactionLiquidationData { liquidator repaidAssets seizedAssets badDebtAssets } }
      market { marketId lltv
        collateralAsset { symbol decimals price { usd } }
        loanAsset { symbol decimals price { usd } } } } } }`;

async function fetchChain(chainId) {
  const out = [];
  for (let skip = 0; skip < 10000; skip += 1000) {
    const d = await gql(Q, { chain: Number(chainId), since, skip });
    const items = d.marketTransactions.items;
    out.push(...items);
    if (items.length < 1000) break;
  }
  return out;
}

const report = { generatedAt: new Date().toISOString(), days: DAYS, chains: {} };
const lines = [`# Liquidation competition — last ${DAYS} days`, `Generated ${report.generatedAt}`, ''];

for (const [chainId, chain] of Object.entries(CHAINS)) {
  let txs;
  try {
    txs = await fetchChain(chainId);
  } catch (e) {
    console.log(`${chain.name}: API error ${e.message.slice(0, 120)}`);
    continue;
  }
  const byLiq = new Map();
  const byMarket = new Map();
  let total = 0;
  for (const t of txs) {
    const m = t.market;
    const cp = m.collateralAsset?.price?.usd ?? 0;
    const lp = m.loanAsset?.price?.usd ?? 0;
    const seized = (Number(t.data.seizedAssets) / 10 ** (m.collateralAsset?.decimals ?? 18)) * cp;
    const repaid = (Number(t.data.repaidAssets) / 10 ** (m.loanAsset?.decimals ?? 18)) * lp;
    // Bonus = what the liquidator got minus what they paid (at today's prices, so approximate).
    const bonus = Math.max(0, Math.min(seized - repaid, seized * 0.2));
    total += bonus;
    const liq = t.data.liquidator;
    const L = byLiq.get(liq) || { count: 0, bonus: 0 };
    L.count++; L.bonus += bonus; byLiq.set(liq, L);
    const key = m.marketId;
    const M = byMarket.get(key) || {
      pair: `${m.collateralAsset?.symbol}/${m.loanAsset?.symbol}`, lltv: Number(m.lltv) / 1e18,
      count: 0, bonus: 0, liquidators: new Map(),
    };
    M.count++; M.bonus += bonus; M.liquidators.set(liq, (M.liquidators.get(liq) || 0) + 1);
    byMarket.set(key, M);
  }
  const liqs = [...byLiq.entries()].sort((a, b) => b[1].bonus - a[1].bonus);
  const topShare = total ? liqs[0]?.[1].bonus / total : 0;
  report.chains[chain.name] = {
    liquidations: txs.length, uniqueLiquidators: byLiq.size, totalBonusUsd: total, topLiquidatorShare: topShare,
    topLiquidators: liqs.slice(0, 10).map(([a, v]) => ({ address: a, ...v })),
    markets: [...byMarket.entries()].map(([id, v]) => ({ id, ...v, liquidators: v.liquidators.size }))
      .sort((a, b) => b.bonus - a.bonus),
  };

  console.log(`\n=== ${chain.name}: ${txs.length} liquidations, ${byLiq.size} different bots, ~${usd(total)} in bonuses, top bot took ${(topShare * 100).toFixed(0)}%`);
  lines.push(`## ${chain.name}`, `${txs.length} liquidations · ${byLiq.size} bots · ~${usd(total)} bonuses · top bot ${(topShare * 100).toFixed(0)}%`, '');
  for (const [a, v] of liqs.slice(0, 5)) {
    console.log(`  bot ${short(a)}  wins ${String(v.count).padStart(5)}  earned ~${usd(v.bonus)}`);
    lines.push(`- bot \`${a}\` — ${v.count} wins, ~${usd(v.bonus)}`);
  }
  const mk = report.chains[chain.name].markets.filter((m) => m.bonus > 20).slice(0, 12);
  if (mk.length) {
    console.log('  top markets:  pair | liquidations | bots | bonus');
    lines.push('', '| market | liquidations | bots | bonus |', '|---|---|---|---|');
  }
  for (const m of mk) {
    console.log(`   ${m.pair.padEnd(22)} ${String(m.count).padStart(5)}  ${String(m.liquidators).padStart(3)}  ${usd(m.bonus)}`);
    lines.push(`| ${m.pair} (lltv ${m.lltv}) | ${m.count} | ${m.liquidators} | ${usd(m.bonus)} |`);
  }
  lines.push('');
}

fs.writeFileSync('reports/competition.json', JSON.stringify(report, null, 2));
fs.writeFileSync('reports/competition.md', lines.join('\n'));
console.log('\nSaved reports/competition.md and reports/competition.json');
