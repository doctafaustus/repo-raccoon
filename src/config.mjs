import 'dotenv/config';

export const MORPHO_API = 'https://api.morpho.org/graphql';

// Chains we check. RPC can be overridden in .env (e.g. RPC_8453=https://...).
// `kyber` is the KyberSwap aggregator name, used to price selling seized collateral.
export const CHAINS = {
  1: { name: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com', kyber: 'ethereum', gasUnits: 450000n },
  8453: { name: 'Base', rpc: 'https://base-rpc.publicnode.com', kyber: 'base', gasUnits: 600000n },
  42161: { name: 'Arbitrum', rpc: 'https://arbitrum-one-rpc.publicnode.com', kyber: 'arbitrum', gasUnits: 900000n },
  999: { name: 'HyperEVM', rpc: 'https://rpc.hyperliquid.xyz/evm', kyber: 'hyperevm', gasUnits: 600000n },
  137: { name: 'Polygon', rpc: 'https://polygon-bor-rpc.publicnode.com', kyber: 'polygon', gasUnits: 600000n },
  10: { name: 'Optimism', rpc: 'https://optimism-rpc.publicnode.com', kyber: 'optimism', gasUnits: 600000n },
  130: { name: 'Unichain', rpc: 'https://unichain-rpc.publicnode.com', kyber: 'unichain', gasUnits: 600000n },
  747474: { name: 'Katana', rpc: 'https://rpc.katana.network', kyber: 'katana', gasUnits: 600000n },
  143: { name: 'Monad', rpc: 'https://rpc.monad.xyz', kyber: 'monad', gasUnits: 600000n },
  // Newer chains (kyber: null = no swap pricing available there)
  4663: { name: 'Robinhood', rpc: 'https://robinhood-rpc.publicnode.com', kyber: 'robinhood', gasUnits: 600000n },
  5042: { name: 'Arc', rpc: 'https://rpc.mainnet.arc.io', kyber: 'arc', gasUnits: 600000n },
  480: { name: 'World Chain', rpc: 'https://480.rpc.thirdweb.com', kyber: null, gasUnits: 600000n },
  988: { name: 'Stable', rpc: 'https://rpc.stable.xyz', kyber: null, gasUnits: 600000n },
  4217: { name: 'Tempo', rpc: 'https://rpc.mainnet.tempo.xyz', kyber: null, gasUnits: 600000n },
  196: { name: 'X Layer', rpc: 'https://rpc.xlayer.tech', kyber: null, gasUnits: 600000n },
};

// Optional: limit a run to some chains with CHAINS=4663,5042
if (process.env.CHAINS) {
  const keep = process.env.CHAINS.split(',');
  for (const id of Object.keys(CHAINS)) if (!keep.includes(id)) delete CHAINS[id];
}

for (const id of Object.keys(CHAINS)) {
  if (process.env[`RPC_${id}`]) CHAINS[id].rpc = process.env[`RPC_${id}`];
}

export async function gql(query, variables = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(MORPHO_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      const json = await res.json();
      if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 400));
      return json.data;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

export const usd = (n) =>
  n == null || !isFinite(n) ? '?' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0 });

export const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '?');
