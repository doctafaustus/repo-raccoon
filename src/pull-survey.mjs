// Which Morpho markets use "pull" oracles (Pyth, RedStone, Stork) where anyone can submit a fresh signed price?
// Ranks them by real borrowing so we know where a "push the price + liquidate" bot could even play.
// Read-only: only eth_call dry runs (fake sender), never sends a transaction.
// Usage: npm run pull-survey   (CHAINS=8453,999 to limit chains)
import fs from 'node:fs';
import { createPublicClient, http, parseAbi, encodeFunctionData, toFunctionSelector } from 'viem';
import { CHAINS, gql, usd } from './config.mjs';

const ZERO = '0x0000000000000000000000000000000000000000';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const DUMMY = '0x00000000000000000000000000000000DeaDBeef';
const HERMES = process.env.HERMES_URL || 'https://hermes.pyth.network';
// Hermes price updates now need a (free) Pyth API key, sent as a bearer token. Without it we can't dry-run Pyth pushes.
const PYTH_API_KEY = process.env.PYTH_API_KEY || '';
// Resolv markets: collateral collapsed but the stale Pyth feed still prices it high (see README "What we learned").
const isTrap = (m) => /USR|RLP/i.test(`${m.collateralAsset?.symbol} ${m.loanAsset?.symbol}`);

const feedAbi = parseAbi([
  'function description() view returns (string)',
  'function priceId() view returns (bytes32)',
  'function pyth() view returns (address)',
  'function getDataFeedId() view returns (bytes32)',
  'function getPriceFeedAdapter() view returns (address)',
  'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
  'function decimals() view returns (uint8)',
]);
const oracleAbi = parseAbi([
  'function BASE_FEED_1() view returns (address)', 'function BASE_FEED_2() view returns (address)',
  'function QUOTE_FEED_1() view returns (address)', 'function QUOTE_FEED_2() view returns (address)',
]);
const pythAbi = parseAbi([
  'function getPriceUnsafe(bytes32) view returns ((int64 price, uint64 conf, int32 expo, uint256 publishTime))',
  'function getUpdateFee(bytes[]) view returns (uint256)',
  'function updatePriceFeeds(bytes[]) payable',
]);
const redstoneAbi = parseAbi(['function updateDataFeedsValues(uint256)', 'function updateDataFeedsValuesPartial(bytes32[])', 'function getMainAdapter() view returns (address)']);
// Abandoned markets where interest compounded into billions of phantom debt (e.g. 26B "USDC" on Arbitrum K/USDC). Not real money.
const PHANTOM_USD = Number(process.env.PHANTOM_USD || 3e9);
const RS_ERRORS = Object.fromEntries(['CalldataMustHaveValidPayload()', 'CalldataOverOrUnderFlow()', 'RedstonePayloadMustHaveAtLeastOneDataPackage()', 'InsufficientNumberOfUniqueSigners(uint256,uint256)', 'IncorrectUnsignedMetadataSize()'].map((e) => [toFunctionSelector(e), e.split('(')[0]]));
const UPDATER_NOT_AUTHORISED = toFunctionSelector('UpdaterNotAuthorised(address)');

const EIP1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
// RedStone adapters decide who may update in Solidity, often by quietly skipping unknown senders, so a dry run alone
// can't tell. Read the verified source from Sourcify (free) and look at how the deployed contract treats outside senders.
async function redstoneSourceAccess(client, chainId, adapter, depth = 0) {
  let addr = adapter;
  try {
    const slot = await client.getStorageAt({ address: adapter, slot: EIP1967_IMPL });
    if (slot && BigInt(slot) !== 0n) addr = '0x' + slot.slice(-40);
  } catch {}
  let j;
  try {
    const res = await fetch(`https://sourcify.dev/server/v2/contract/${chainId}/${addr}?fields=sources,compilation`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    j = await res.json();
  } catch {
    return null;
  }
  const target = j.compilation?.fullyQualifiedName;
  const sources = j.sources || {};
  const file = target && sources[target.split(':')[0]]?.content;
  if (!file) return null;
  const name = target.split(':')[1];
  // "WithReference" wrappers can't be updated themselves; prices come from their main adapter, so judge that one.
  if (depth < 2 && /function getMainAdapter\(\)[^;{]*\{/.test(file)) {
    try {
      const main = await client.readContract({ address: adapter, abi: redstoneAbi, functionName: 'getMainAdapter' });
      const r = await redstoneSourceAccess(client, chainId, main, depth + 1);
      if (r) return { ...r, contract: `${name} → ${r.contract}`, mainAdapter: main };
    } catch {}
    return { access: 'unknown', contract: name, note: 'wrapper whose main adapter could not be checked' };
  }
  const body = (fn) => {
    const i = file.indexOf(`function ${fn}`);
    if (i < 0) return null;
    let depth = 0;
    for (let k = file.indexOf('{', i); k < file.length; k++) {
      if (file[k] === '{') depth++;
      else if (file[k] === '}' && --depth === 0) return file.slice(i, k + 1);
    }
    return null;
  };
  const delay = (b) => (b?.match(/(\d+)\s*seconds/) || [])[1];
  const vbt = body('_validateBlockTimestamp');
  const rau = body('requireAuthorisedUpdater');
  if (vbt && /return\s+false\s*;/.test(vbt) && /msg\.sender\s*==/.test(vbt)) return { access: 'locked', contract: name, note: 'only RedStone\'s whitelisted updaters (others are silently skipped)' };
  if (vbt && delay(vbt)) return { access: 'open-after-delay', delaySec: Number(delay(vbt)), contract: name, note: `anyone, once ${delay(vbt)}s passed since the last update` };
  if (rau && delay(rau)) return { access: 'open-after-delay', delaySec: Number(delay(rau)), contract: name, note: `anyone, once ${delay(rau)}s passed since the last update` };
  if (rau && /revert\s+UpdaterNotAuthorised/.test(rau)) return { access: 'locked', contract: name, note: 'requireAuthorisedUpdater allows only listed updaters' };
  if (!rau && !vbt) return { access: 'open', contract: name, note: 'no updater restriction in the deployed contract (base adapters let anyone update)', weak: true };
  return { access: 'unknown', contract: name, note: 'source found but access rule not recognised' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lower = (a) => a?.toLowerCase();

function clientFor(id) {
  const c = CHAINS[id];
  return createPublicClient({
    chain: { id: Number(id), name: c.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } }, contracts: { multicall3: { address: MULTICALL3 } } },
    transport: http(c.rpc, { timeout: 25000, retryCount: 2, retryDelay: 1500 }),
  });
}

// Multicall when the chain has Multicall3, otherwise one call at a time (a few in parallel).
async function readAll(client, contracts) {
  if (!contracts.length) return [];
  const out = [];
  try {
    for (let i = 0; i < contracts.length; i += 300) out.push(...(await client.multicall({ contracts: contracts.slice(i, i + 300), allowFailure: true })));
    return out;
  } catch {
    const res = new Array(contracts.length);
    for (let i = 0; i < contracts.length; i += 8) {
      await Promise.all(contracts.slice(i, i + 8).map((k, j) =>
        client.readContract(k).then((result) => (res[i + j] = { status: 'success', result }), () => (res[i + j] = { status: 'failure' }))));
    }
    return res;
  }
}

const ok = (r) => (r?.status === 'success' ? r.result : null);
const revertData = (e) => {
  for (let x = e; x; x = x.cause) {
    const d = x.data?.data ?? x.data;
    if (typeof d === 'string' && d.startsWith('0x')) return d;
  }
  return (String(e?.details || e?.message || '').match(/0x[0-9a-fA-F]{8,}/) || [null])[0];
};

const MARKETS_Q = `query($chain:Int!, $skip:Int!) {
  markets(first: 1000, skip: $skip, where: { chainId_in: [$chain] }) {
    items { marketId lltv
      oracle { address data { __typename
        ... on MorphoChainlinkOracleV2Data { baseFeedOne { address } baseFeedTwo { address } quoteFeedOne { address } quoteFeedTwo { address } }
        ... on MorphoChainlinkOracleData { baseFeedOne { address } quoteFeedOne { address } } } }
      loanAsset { symbol price { usd } } collateralAsset { symbol }
      state { borrowAssetsUsd } } } }`;

const POS_Q = `query($chain:Int!, $ids:[String!], $skip:Int!) {
  marketPositions(first: 1000, skip: $skip, where: { chainId_in: [$chain], marketUniqueKey_in: $ids, borrowShares_gte: "1" }) {
    items { healthFactor market { marketId } state { borrowAssetsUsd } } } }`;

async function hermesLatest(ids) {
  if (!ids.length) return { parsed: new Map(), vaa: null };
  if (!PYTH_API_KEY) return { parsed: new Map(), vaa: null, error: 'no PYTH_API_KEY', noKey: true };
  const q = ids.map((id) => `ids[]=${id}`).join('&');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${HERMES}/v2/updates/price/latest?${q}&parsed=true&ignore_invalid_price_ids=true`, { headers: { authorization: `Bearer ${PYTH_API_KEY}` } });
      if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
      if (res.status === 401 || res.status === 403) return { parsed: new Map(), vaa: null, error: `Hermes HTTP ${res.status} (check PYTH_API_KEY)` };
      const j = await res.json();
      const parsed = new Map((j.parsed || []).map((p) => [lower('0x' + p.id.replace(/^0x/, '')), p]));
      return { parsed, vaa: j.binary?.data?.[0] ? '0x' + j.binary.data[0] : null };
    } catch {
      await sleep(1500);
    }
  }
  return { parsed: new Map(), vaa: null, error: 'hermes unreachable' };
}

async function surveyChain(id) {
  const chain = CHAINS[id];
  const client = clientFor(id);
  const markets = [];
  for (let skip = 0; skip < 20000; skip += 1000) {
    const d = await gql(MARKETS_Q, { chain: Number(id), skip });
    markets.push(...d.markets.items);
    if (d.markets.items.length < 1000) break;
  }
  const phantom = markets.filter((m) => (m.state?.borrowAssetsUsd || 0) > PHANTOM_USD);
  const realBorrow = (m) => (m.loanAsset?.price?.usd && (m.state?.borrowAssetsUsd || 0) <= PHANTOM_USD ? m.state?.borrowAssetsUsd || 0 : 0);

  // Feeds per market: from the API when it knows the oracle, otherwise read BASE_FEED_1… on-chain (only for markets with borrowing).
  const feedsOf = new Map();
  const unknown = [];
  for (const m of markets) {
    const f = m.oracle?.data;
    if (f) feedsOf.set(m.marketId, [f.baseFeedOne, f.baseFeedTwo, f.quoteFeedOne, f.quoteFeedTwo].map((x) => lower(x?.address)).filter((a) => a && a !== ZERO));
    else if (m.oracle?.address && realBorrow(m) >= 100) unknown.push(m);
  }
  const fnames = ['BASE_FEED_1', 'BASE_FEED_2', 'QUOTE_FEED_1', 'QUOTE_FEED_2'];
  const ures = await readAll(client, unknown.flatMap((m) => fnames.map((fn) => ({ address: m.oracle.address, abi: oracleAbi, functionName: fn }))));
  let unreadableBorrowUsd = 0;
  unknown.forEach((m, i) => {
    const fs4 = ures.slice(i * 4, i * 4 + 4).map(ok);
    if (fs4.every((x) => x == null)) unreadableBorrowUsd += realBorrow(m);
    feedsOf.set(m.marketId, fs4.map(lower).filter((a) => a && a !== ZERO));
  });

  // Identify each feed's vendor on-chain.
  const feeds = [...new Set([...feedsOf.values()].flat())];
  const fns = ['description', 'priceId', 'pyth', 'getDataFeedId', 'getPriceFeedAdapter', 'latestRoundData'];
  const fres = await readAll(client, feeds.flatMap((a) => fns.map((fn) => ({ address: a, abi: feedAbi, functionName: fn }))));
  const feedInfo = new Map();
  feeds.forEach((a, i) => {
    const r = Object.fromEntries(fns.map((fn, j) => [fn, ok(fres[i * fns.length + j])]));
    let vendor = 'other';
    if (r.priceId && /stork/i.test(r.description || '')) vendor = 'stork';
    else if (r.priceId && r.pyth) vendor = 'pyth';
    else if (r.getDataFeedId || /redstone/i.test(r.description || '')) vendor = 'redstone';
    feedInfo.set(a, { address: a, vendor, description: r.description, priceId: r.priceId && lower(r.priceId), pythContract: lower(r.pyth), dataFeedId: r.getDataFeedId, adapter: lower(r.getPriceFeedAdapter) || a, updatedAt: r.latestRoundData ? Number(r.latestRoundData[3]) : null });
  });

  const pullMarkets = markets.filter((m) => (feedsOf.get(m.marketId) || []).some((a) => feedInfo.get(a).vendor !== 'other'));
  const pullFeeds = [...new Set(pullMarkets.flatMap((m) => feedsOf.get(m.marketId)))].map((a) => feedInfo.get(a)).filter((f) => f.vendor !== 'other');
  const nowSec = Math.floor(Date.now() / 1000);

  // Pyth: on-chain price vs Hermes, and a dry-run update from a random address to prove anyone can push.
  const pythFeeds = pullFeeds.filter((f) => f.vendor === 'pyth');
  const pythContracts = [...new Set(pythFeeds.map((f) => f.pythContract))];
  const hermes = await hermesLatest([...new Set(pythFeeds.map((f) => f.priceId))]);
  const onchain = await readAll(client, pythFeeds.map((f) => ({ address: f.pythContract, abi: pythAbi, functionName: 'getPriceUnsafe', args: [f.priceId] })));
  pythFeeds.forEach((f, i) => {
    const oc = ok(onchain[i]);
    const h = hermes.parsed.get(f.priceId);
    f.onchainPublishTime = oc ? Number(oc.publishTime) : null;
    f.onchainAgeSec = oc ? nowSec - Number(oc.publishTime) : null;
    f.inHermes = !!h;
    if (h) {
      f.hermesAgeSec = nowSec - h.price.publish_time;
      const hp = Number(h.price.price) * 10 ** h.price.expo;
      const op = oc ? Number(oc.price) * 10 ** Number(oc.expo) : null;
      f.hermesVsOnchainPct = op ? +(((hp - op) / op) * 100).toFixed(3) : null;
    }
  });
  const pythPush = {};
  for (const pc of pythContracts) {
    const ids = [...new Set(pythFeeds.filter((f) => f.pythContract === pc && (f.inHermes || hermes.noKey)).map((f) => f.priceId))];
    const r = { contract: pc, idsTested: ids.length };
    try {
      // Without a key: just confirm a Pyth core contract is there (getUpdateFee); updatePriceFeeds is permissionless by design.
      if (hermes.noKey) {
        r.updateFeeWei = (await client.readContract({ address: pc, abi: pythAbi, functionName: 'getUpdateFee', args: [[]] })).toString();
        r.anyoneCanPush = true;
        r.verified = false;
        pythPush[pc] = r;
        continue;
      }
      const { vaa, error } = await hermesLatest(ids);
      if (!vaa) throw new Error(error || 'no Hermes update for these ids');
      r.updateFeeWei = (await client.readContract({ address: pc, abi: pythAbi, functionName: 'getUpdateFee', args: [[vaa]] })).toString();
      await client.call({
        account: DUMMY, to: pc, value: BigInt(r.updateFeeWei),
        data: encodeFunctionData({ abi: pythAbi, functionName: 'updatePriceFeeds', args: [[vaa]] }),
        stateOverride: [{ address: DUMMY, balance: 10n ** 18n }],
      });
      r.anyoneCanPush = true;
      r.verified = true;
    } catch (e) {
      r.anyoneCanPush = false;
      r.error = (e.shortMessage || e.message).slice(0, 160);
    }
    pythPush[pc] = r;
  }
  for (const f of pythFeeds) {
    const pp = pythPush[f.pythContract];
    f.pushable = !!pp?.anyoneCanPush && (hermes.noKey || f.inHermes);
    f.pushVerified = !!pp?.verified;
  }

  // RedStone: if the adapter restricts who can update, a dry run from a random address fails with UpdaterNotAuthorised.
  // Any other failure (e.g. missing signed payload) means the sender check passed, so anyone can push.
  const rsFeeds = pullFeeds.filter((f) => f.vendor === 'redstone');
  const rsAdapters = [...new Set(rsFeeds.map((f) => f.adapter))];
  const rsPush = {};
  const classify = (e) => {
    const d = revertData(e);
    if (d?.startsWith(UPDATER_NOT_AUTHORISED)) return { anyoneCanPush: false, note: 'UpdaterNotAuthorised' };
    if (d && d.length >= 10) return { anyoneCanPush: true, note: `reverted after sender check (${RS_ERRORS[d.slice(0, 10)] || d.slice(0, 10)})` };
    return null;
  };
  for (const ad of rsAdapters) {
    // Classic adapters: updateDataFeedsValues(timestamp). Multi-feed adapters: updateDataFeedsValuesPartial(feedIds).
    const feedIds = [...new Set(rsFeeds.filter((f) => f.adapter === ad && f.dataFeedId).map((f) => f.dataFeedId))];
    const tries = [
      encodeFunctionData({ abi: redstoneAbi, functionName: 'updateDataFeedsValues', args: [BigInt(Date.now())] }),
      ...(feedIds.length ? [encodeFunctionData({ abi: redstoneAbi, functionName: 'updateDataFeedsValuesPartial', args: [feedIds] })] : []),
    ];
    let result = null;
    let last = '';
    let viaPartial = false;
    for (const [ti, data] of tries.entries()) {
      try {
        await client.call({ account: DUMMY, to: ad, data });
        result = { anyoneCanPush: true, note: 'dry run succeeded without a payload (unexpected)' };
      } catch (e) {
        result = classify(e);
        last = (e.shortMessage || e.message).slice(0, 100);
      }
      if (result) { viaPartial = ti === 1; break; }
    }
    let dry = result || { anyoneCanPush: null, note: `unclear: ${last}` };
    // Multi-feed adapters parse the payload before checking the sender (and may skip unknown senders without reverting).
    if (viaPartial && dry.anyoneCanPush) dry = { anyoneCanPush: null, note: `unclear: multi-feed adapter, dry run can't prove access (${dry.note})` };
    const src = await redstoneSourceAccess(client, id, ad);
    if (src && src.access !== 'unknown' && !(src.weak && dry.anyoneCanPush === false)) {
      rsPush[ad] = { anyoneCanPush: src.access !== 'locked', delaySec: src.delaySec, verified: true, source: src.contract, note: src.note, dryRun: dry.note };
    } else {
      rsPush[ad] = { ...dry, verified: false, note: `${dry.note} (no verified source; dry run only${src ? ', ' + src.note : ''})` };
    }
  }
  for (const f of pullFeeds.filter((f) => f.vendor === 'redstone')) {
    Object.assign(f, rsPush[f.adapter]);
    f.pushable = f.anyoneCanPush ?? null;
    f.onchainAgeSec = f.updatedAt ? nowSec - f.updatedAt : null;
  }
  // Stork: permissionless signed updates exist, but no free Hermes-style source wired up here; flag only.
  for (const f of pullFeeds.filter((f) => f.vendor === 'stork')) { f.pushable = null; f.note = 'Stork feed (not checked)'; }

  // Loans per pull market.
  const ids = pullMarkets.filter((m) => realBorrow(m) > 0).map((m) => m.marketId);
  const loans = new Map(ids.map((k) => [k, { loans: 0, loans2: 0, near: 0, liqNow: 0, nearUsd: 0 }]));
  for (let i = 0; i < ids.length; i += 50) {
    for (let skip = 0; skip < 20000; skip += 1000) {
      const d = await gql(POS_Q, { chain: Number(id), ids: ids.slice(i, i + 50), skip });
      for (const p of d.marketPositions.items) {
        const s = loans.get(p.market.marketId);
        const u = p.state?.borrowAssetsUsd || 0;
        s.loans++;
        if (u < 2) continue;
        s.loans2++;
        if (p.healthFactor != null && p.healthFactor <= 1.15) { s.near++; s.nearUsd += u; }
        if (p.healthFactor != null && p.healthFactor <= 1) s.liqNow++;
      }
      if (d.marketPositions.items.length < 1000) break;
    }
  }

  const rows = pullMarkets.map((m) => {
    const fl = feedsOf.get(m.marketId).map((a) => feedInfo.get(a));
    const pulls = fl.filter((f) => f.vendor !== 'other');
    const pushable = pulls.some((f) => f.pushable === true);
    const l = loans.get(m.marketId) || { loans: 0, loans2: 0, near: 0, liqNow: 0, nearUsd: 0 };
    return {
      chainId: Number(id), chain: chain.name, marketId: m.marketId, pair: `${m.collateralAsset?.symbol}/${m.loanAsset?.symbol}`,
      lltv: Number(m.lltv) / 1e18, borrowUsd: realBorrow(m), ...l, trap: isTrap(m), pushable,
      vendors: [...new Set(pulls.map((f) => f.vendor))],
      pullFeeds: pulls.map((f) => ({ vendor: f.vendor, description: f.description, address: f.address, priceId: f.priceId, pushable: f.pushable, pushVerified: f.pushVerified ?? (f.vendor === 'redstone' && !!f.verified), delaySec: f.delaySec, pushNote: f.note, onchainAgeSec: f.onchainAgeSec, hermesVsOnchainPct: f.hermesVsOnchainPct, inHermes: f.inHermes, note: f.note })),
      otherFeeds: fl.filter((f) => f.vendor === 'other').map((f) => ({ description: f.description, address: f.address })),
    };
  });
  return {
    chainId: Number(id), chain: chain.name, markets: markets.length, pullMarkets: rows.length,
    borrowUsdAllMarkets: markets.reduce((s, m) => s + realBorrow(m), 0), unreadableOracleBorrowUsd: unreadableBorrowUsd,
    pythPush: Object.values(pythPush), redstonePush: rsPush,
    phantomMarkets: phantom.map((m) => ({ marketId: m.marketId, pair: `${m.collateralAsset?.symbol}/${m.loanAsset?.symbol}`, apiBorrowUsd: m.state?.borrowAssetsUsd })), rows,
  };
}

// ---------- main ----------
const ids = Object.keys(CHAINS);
console.log(`Surveying pull oracles (Pyth / RedStone / Stork) on ${ids.length} chains…`);
const chains = [];
for (const id of ids) {
  process.stdout.write(`  ${CHAINS[id].name.padEnd(12)} `);
  try {
    const r = await surveyChain(id);
    chains.push(r);
    const real = r.rows.filter((x) => x.pushable && !x.trap);
    console.log(`${String(r.markets).padStart(5)} markets, ${String(r.pullMarkets).padStart(3)} pull-oracle, ${String(real.length).padStart(3)} pushable non-trap with ${usd(real.reduce((s, x) => s + x.borrowUsd, 0))} borrowed`);
  } catch (e) {
    chains.push({ chainId: Number(id), chain: CHAINS[id].name, error: (e.shortMessage || e.message).slice(0, 200), rows: [] });
    console.log(`error: ${(e.shortMessage || e.message).slice(0, 120)}`);
  }
}

const all = chains.flatMap((c) => c.rows);
const ranked = all.filter((r) => r.pushable && !r.trap && r.borrowUsd > 0).sort((a, b) => b.borrowUsd - a.borrowUsd);
const isUnclear = (r) => r.pullFeeds.some((f) => f.pushable == null);
const age = (s) => (s == null ? '?' : s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`);

console.log(`\n=== Markets where anyone can submit a price (traps excluded), ranked by borrowing ===`);
console.log(`${'chain'.padEnd(10)} ${'pair'.padEnd(24)} ${'vendor'.padEnd(9)} ${'borrowed'.padStart(11)} ${'loans≥$2'.padStart(8)} ${'HF≤1.15'.padStart(7)} ${'liq now'.padStart(7)} ${'feed age'.padStart(8)} ${'Hermes Δ'.padStart(9)} ${'proof'.padStart(8)}  market`);
for (const r of ranked.slice(0, 40)) {
  const f = r.pullFeeds.find((x) => x.pushable) || r.pullFeeds[0];
  console.log(`${r.chain.padEnd(10)} ${r.pair.slice(0, 24).padEnd(24)} ${r.vendors.join('+').padEnd(9)} ${usd(r.borrowUsd).padStart(11)} ${String(r.loans2).padStart(8)} ${String(r.near).padStart(7)} ${String(r.liqNow).padStart(7)} ${age(f.onchainAgeSec).padStart(8)} ${(f.hermesVsOnchainPct != null ? f.hermesVsOnchainPct.toFixed(2) + '%' : '-').padStart(9)} ${(f.vendor === 'redstone' ? (f.pushVerified ? (f.delaySec ? `src+${f.delaySec}s` : 'source') : 'dry-run') : f.pushVerified ? 'dry-run' : 'assumed').padStart(8)}  ${r.marketId.slice(0, 10)}`);
}
if (ranked.length > 40) console.log(`  … ${ranked.length - 40} more in the JSON`);

const unclear = all.filter((r) => !r.pushable && !r.trap && isUnclear(r) && r.borrowUsd >= 1000).sort((a, b) => b.borrowUsd - a.borrowUsd);
if (unclear.length) {
  console.log(`\n=== Unclear: RedStone adapters whose code we couldn't read (not counted as pushable) ===`);
  for (const r of unclear.slice(0, 15)) console.log(`${r.chain.padEnd(10)} ${r.pair.slice(0, 24).padEnd(24)} ${usd(r.borrowUsd).padStart(11)} ${String(r.loans2).padStart(4)} loans  ${String(r.near).padStart(3)} HF≤1.15  ${r.marketId.slice(0, 10)}`);
}

console.log(`\n=== Per chain (pushable, non-trap) ===`);
const perChain = chains.map((c) => {
  const rs = c.rows.filter((r) => r.pushable && !r.trap);
  return {
    chain: c.chain, error: c.error, markets: rs.length, borrowUsd: rs.reduce((s, r) => s + r.borrowUsd, 0), loans2: rs.reduce((s, r) => s + r.loans2, 0),
    near: rs.reduce((s, r) => s + r.near, 0), nearUsd: rs.reduce((s, r) => s + r.nearUsd, 0),
    trapUsd: c.rows.filter((r) => r.trap).reduce((s, r) => s + r.borrowUsd, 0),
    notPushableUsd: c.rows.filter((r) => !r.pushable && !r.trap && !isUnclear(r)).reduce((s, r) => s + r.borrowUsd, 0),
    unclearUsd: c.rows.filter((r) => !r.pushable && !r.trap && isUnclear(r)).reduce((s, r) => s + r.borrowUsd, 0),
    phantomUsd: (c.phantomMarkets || []).reduce((s, m) => s + m.apiBorrowUsd, 0),
    pythPush: c.pythPush?.map((p) => (p.anyoneCanPush ? `ok${p.verified ? ' (dry run passed)' : ' (unverified, no key)'} fee ${p.updateFeeWei} wei` : `FAIL ${p.error}`)).join('; ') || '',
    unreadable: c.unreadableOracleBorrowUsd || 0,
  };
}).sort((a, b) => b.borrowUsd - a.borrowUsd);
console.log(`${'chain'.padEnd(12)} ${'mkts'.padStart(4)} ${'borrowed'.padStart(11)} ${'loans≥$2'.padStart(8)} ${'HF≤1.15'.padStart(7)} ${'$ near'.padStart(10)} ${'traps $'.padStart(11)} ${'locked $'.padStart(10)} ${'unclear $'.padStart(10)} ${'phantom $'.padStart(10)}  Pyth push`);
for (const c of perChain) {
  if (c.error) { console.log(`${c.chain.padEnd(12)} error: ${c.error.slice(0, 100)}`); continue; }
  console.log(`${c.chain.padEnd(12)} ${String(c.markets).padStart(4)} ${usd(c.borrowUsd).padStart(11)} ${String(c.loans2).padStart(8)} ${String(c.near).padStart(7)} ${usd(c.nearUsd).padStart(10)} ${usd(c.trapUsd).padStart(11)} ${usd(c.notPushableUsd).padStart(10)} ${usd(c.unclearUsd).padStart(10)} ${usd(c.phantomUsd).padStart(10)}  ${c.pythPush.slice(0, 40)}`);
}
if (!PYTH_API_KEY) console.log(`\nNo PYTH_API_KEY set: Pyth pushes are assumed (Pyth core updates are permissionless) but not dry-run tested, and Hermes Δ is blank.`);
console.log(`\n"locked $" = pull-oracle markets where a random sender can't submit a price. "traps $" = Resolv USR/RLP markets.`);
console.log(`"unclear $" = adapter code not published, can't tell. "phantom $" = abandoned markets with runaway interest (> ${usd(PHANTOM_USD)}), not real money.`);
console.log(`proof: dry-run = simulated price push from a random address passed; assumed = Pyth core (permissionless) but no key to test;`);
console.log(`       source = RedStone contract's verified code lets anyone update; src+40s = only once the price is 40 s old.`);
const unread = perChain.filter((c) => c.unreadable > 1000);
if (unread.length) console.log(`Oracles we couldn't break into feeds (may hide more Pyth/RedStone, often spam tokens): ${unread.map((c) => `${c.chain} ${usd(c.unreadable)}`).join(', ')}`);

fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync('reports/pull-survey.json', JSON.stringify({ at: new Date().toISOString(), ranked, perChain, chains }, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
console.log(`\nSaved reports/pull-survey.json`);
