# Repo Raccoon

Research + tooling for Morpho Blue liquidations. Goal: find out whether a simple (non-"pro") bot can
ever beat existing liquidation bots on a real transaction, starting with a **no-money practice run**.

**Current task: run `npm run practice` for ~24 h on the owner's Mac, then judge the results against the success criteria below.**

---

## Ground rules (read first)

- **Read-only. No wallet, no private keys, no transactions.** Nothing in this repo sends a transaction yet.
  Don't add signing code unless the owner explicitly asks.
- **Packages:** supply-chain caution. Only `viem` and `dotenv` are installed, pinned to exact versions
  (`viem 2.57.1`, `dotenv 16.6.1`), all deps resolved with `--before=2026-10-01`. `.npmrc` sets
  `ignore-scripts=true` and `save-exact=true`. **Don't add new packages** without asking; if one is truly
  needed, pin an exact version that's at least a few weeks old and run `npm audit`.
- Node 25, ESM (`.mjs`). Use built-in `fetch` and `WebSocket` (Node has both globally).
- Don't create Markdown reports/notes unless asked. Script output goes to `reports/*.json` / `*.jsonl`.
- Prefer free public RPCs; allow overrides via `.env` as `RPC_<chainId>=...`.

## What exists

| File | What it does | Run |
|---|---|---|
| `src/config.mjs` | Chain list (RPCs, KyberSwap names), Morpho API `gql()` helper, formatters. `CHAINS=8453,1` env var limits chains. | — |
| `src/scan.mjs` | Every currently-liquidatable Morpho position: re-checks on-chain (oracle, debt, health), computes seize/repay with Morpho's liquidation bonus, prices selling the collateral via KyberSwap, prints profitable vs traps. | `npm run scan [-- minCollUsd]` |
| `src/competition.mjs` | Liquidations per chain over N days: # bots, bonuses, top bot share, top markets. | `npm run competition [-- days]` |
| `src/winners.mjs` | For one chain: replays each past liquidation at earlier blocks to measure **how long the loan sat liquidatable before someone took it**, plus winners' gas, priority fee, block position. `NO_MULTICALL=1` if an RPC rejects batching. | `npm run winners [-- days chainId]` |
| `src/aave-scan.mjs` | Aave v3 on 15 smaller chains: liquidations, bots, currently liquidatable borrowers. | `npm run aave [-- days chainIds]` |
| `src/aave-winners.mjs` | Same "how long did it sit" replay for Aave (Avalanche 43114, Polygon 137). | `node src/aave-winners.mjs 43114 30` |
| `src/practice.mjs` | No-money practice run on Base (spec below). Watches ~8.5k near-liquidation loans every block, logs when each becomes liquidatable vs when a real bot took it. Loans already liquidatable at startup are ignored. Summary every 5 min + on Ctrl-C → `reports/practice-summary.json`; every event → `reports/practice-log.jsonl`. Env overrides: `POLL_MS`, `MIN_BORROW_USD`, `HF_MAX`, `WIN_LEAD_MS`, `GAS_USD`, `PRACTICE_RPC`, `PRACTICE_WS`. | `npm run practice [-- hours]` |
| `src/pull-survey.mjs` | For the "push the price yourself" idea: finds Morpho markets whose oracle reads a **pull** feed (Pyth / RedStone, detected on-chain), checks whether a random sender may submit a price (Pyth core = permissionless; RedStone = adapter's verified Sourcify source, following "WithReference" wrappers to their main adapter), and ranks real borrowing in pushable markets. Excludes Resolv traps (USR/RLP) and phantom markets (> `PHANTOM_USD`, default $3B, runaway interest). RedStone multi-feed adapters with unpublished code are "unclear" (their dry run can't prove access). Pyth's Hermes API now needs a free key: set `PYTH_API_KEY` (Bearer, from app.pyth.com; `HERMES_URL` to override) to dry-run Pyth pushes and compare Hermes vs on-chain prices. → `reports/pull-survey.json` | `npm run pull-survey` |

## What we learned (Nov 2026)

1. **Nothing is profitable to liquidate "lazily."** Of ~314 liquidatable Morpho positions across 9 chains, 0
   are profitable. Big-looking ones are traps: collapsed collateral the oracle still prices high
   (Resolv USR/RLP/wstUSR), or unsellable collateral (Altura AVLT — vault in wind-down, payouts frozen;
   ynETHx — illiquid, needs ~$1M capital; yUSD — 30% exit fee).
2. **Aave on small chains / brand-new chains:** nothing liquidatable now; bots already present
   (Robinhood Chain had 127 bots). Avalanche Aave is the only small chain with real money (~$13k/mo).
3. **Base is where the money is:** ~$350k in Morpho liquidation bonuses in 4 days (Nov 4–7), 66 bots,
   top bot ~23%. Pro bots make few, huge transactions ($500–$8,000 each, often batching many loans).
   Median winning tx nets ~$1.75; txs netting under $5 lost money in aggregate.
4. **Base blocks are now ~0.2 s** (not 2 s). Every $10+ liquidation on Base, Avalanche, Polygon, HyperEVM
   landed in **the same block** the loan became liquidatable → winners pre-position based on off-chain
   price feeds; a reactive bot can't win those.
5. **The one gap:** small loans. On Base, using 0.2 s blocks:

   | Bonus | Taken in same block | Sat 0.2–1 s | Sat long |
   |---|---|---|---|
   | < $1 | 57% | 40% | 3% |
   | $1–10 | 96% | 4% | 0% |

   A reactive bot polling every ~100 ms might win some of these. Expected value is small
   (a few dollars/day at best) — the point is to **prove we can beat other bots head-to-head**.

## `src/practice.mjs` — design spec (built Nov 2026)

Run it for ~24 h and answer: **how often would we have been first, and what would it have made?**

### Data sources (verified working)

- **Low-latency RPC:** `https://mainnet-preconf.base.org` (HTTP ~65–70 ms round trip from the owner's Mac;
  `eth_getBlockByNumber("latest"/"pending")` advances every ~0.2 s). WebSocket `wss://mainnet-preconf.base.org`
  supports `eth_subscribe` `"logs"` (confirmed delivering Morpho logs) and `"newHeads"`.
  Note: raw `wss://mainnet.flashblocks.base.org/ws` connects but sent nothing — don't rely on it.
- **Archive/fallback RPC:** `https://base-rpc.publicnode.com` (supports historical `blockNumber` reads).
- **Morpho API:** `https://api.morpho.org/graphql` (see `gql()` in config). Useful queries:
  - Positions: `marketPositions(first:1000, skip, where:{chainId_in:[8453], healthFactor_lte: 1.15})`
    → `healthFactor user{address} market{ marketId lltv oracle{address} loanAsset{address symbol decimals price{usd}} collateralAsset{...} } state{ collateral borrowShares borrowAssetsUsd }`
  - Field names that exist: `Market.marketId` (not uniqueKey), `Asset.price{usd}` (not priceUsd),
    `Market.morphoBlue{address}`, `Market.oracle{address}`.
- **Morpho Blue on Base:** `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`. Multicall3: `0xcA11bde05977b3631167028862bE2a173976CA11`.

### Contract math (copy from `scan.mjs` / `winners.mjs`)

- `idToMarketParams(id) → (loanToken, collateralToken, oracle, irm, lltv)`
- `position(id, user) → (supplyShares, borrowShares, collateral)`
- `market(id) → (totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee)`
- `oracle.price()` — scaled 1e36 (adjusted for decimals)
- debt = `borrowShares * (totalBorrowAssets + 1) / (totalBorrowShares + 1e6)` (round up)
- maxBorrow = `collateral * price / 1e36 * lltv / 1e18`; **liquidatable when maxBorrow < debt**
- LIF = `min(1.15, 1 / (1 - 0.3 * (1 - lltv)))`
- seized = min(collateral, debt * LIF * 1e36 / price); repaid = seized * price / 1e36 / LIF;
  bonus (loan units) = seized * price / 1e36 − repaid → USD via loan asset price.

### Events (Morpho Blue, decode with viem `parseAbiItem`)

```
event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)
event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)
event Repay(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)
event SupplyCollateral(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets)
event WithdrawCollateral(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets)
```

### Design

1. **Watchlist:** load Base positions with `healthFactor_lte: 1.15` and borrow ≥ ~$2 from the Morpho API.
   Re-read each position + its market params on-chain once at start. Refresh the list from the API every ~10 min.
2. **Every new block (~0.2 s):** poll `eth_blockNumber` on the preconf RPC every ~50–80 ms. On a new block,
   one multicall at that block: `price()` for each unique oracle in the watchlist, and `market(id)` for each
   watched market. Recompute health for every watched position from cached shares/collateral.
3. **Keep positions fresh:** subscribe (WebSocket `logs`, address = Morpho) to Borrow/Repay/SupplyCollateral/
   WithdrawCollateral/Liquidate; on any event for a watched (or new) borrower, re-read `position()` on-chain.
4. **Opportunity log:** when a position first becomes liquidatable, record
   `{market, pair, borrower, firstSeenBlock, firstSeenAtMs, estBonusUsd, seizedUsd, repaidUsd}`.
   Optional: for estBonus ≥ $0.50, one KyberSwap quote (see `kyberQuote` in `scan.mjs`, rate-limited) to check the
   collateral can actually be sold.
5. **Outcome:** when a `Liquidate` event arrives for that (market, borrower): record `liquidatedBlock`, winner
   (`caller`), and tx hash. Then:
   - `liquidatedBlock > firstSeenBlock` → **"we had a shot"**; lead = `(liquidatedBlock − firstSeenBlock) * 0.2 s`
     minus our measured detection latency. Count as a hypothetical **win** if lead ≥ ~150 ms (time to send a tx).
   - `Liquidate` for a position we never saw liquidatable (same block as the price change) → **"lost: pre-positioned bot."**
   - Became healthy again without liquidation → "missed opportunity disappeared."
6. **Hypothetical profit:** for wins, `estBonusUsd − ~$0.02 gas`. Ignore swap slippage for < $1 bonuses but flag it.
7. **Output:** append every event to `reports/practice-log.jsonl`. Print a summary every 5 min and on Ctrl-C,
   split by bonus bucket (< $1, $1–10, $10+): opportunities seen, we-had-a-shot count, lost-to-pre-positioned
   count, median lead time, hypothetical profit total and per day.
8. Add `"practice": "node src/practice.mjs"` to `package.json`.

### Success criteria

- **Promising:** we "had a shot" on a meaningful share of $1–10 liquidations (e.g. 20%+) → next step is a
  live version with a fresh wallet holding ~$15–25 on Base (ETH for gas + USDC to repay small loans directly,
  no flash loans, no contract). Owner must approve before anything live.
- **Not promising:** we're always too late, or hypothetical profit < ~$1/day → stop the liquidation idea.

### Where it runs

- First run: on the owner's Mac (keep it awake). Expect first events within 1–2 hours in a normal market;
  a reliable answer after ~24 h (Nov 4–7 rates: ~25 catchable sub-$1 and ~3 catchable $1–10 events/day).
- Later (not yet): Cloudflare's free tier is a poor fit (10 ms CPU limit, 1-min cron). Use Oracle Cloud
  Always Free or a ~$5/mo VPS in US-East instead.
