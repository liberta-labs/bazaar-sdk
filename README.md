# Bazaar SDK

TypeScript tools for the [Bazaar](https://github.com/liberta-labs/bazaar) protocol, in two packages:

| Package | For | Runs in |
|---|---|---|
| [`@liberta-labs/bazaar-sdk`](packages/sdk) | frontends, bots and services: markets and accounts, live prices, every trading action (direct and gasless), USDC permits, history, previews, user-facing errors, insurance, market termination and settlement (UMA and insurer votes), listing new markets | browsers and Node |
| [`@liberta-labs/bazaar-keeper`](packages/keeper) | the **keeper**: Bazaar's permissionless upkeep, for its bounties, from your own wallet, and the `bazaar` CLI | Node 20+ |

The keeper is built on the SDK: the chain, ABI, price, formula and market layers are the same code a
frontend uses.

## The keeper

| Job | What it does | Who pays you |
|---|---|---|
| `liquidation` | seizes positions below their maintenance margin | insurance fund: $0.05 per account, or 2 bp of what a netting retires |
| `triggers` | fires StopLimit, StopLoss and TakeProfit orders | the order's owner, through the bounty they attached |
| `unload` | sells the vault's liquidated inventory into the book | insurance fund: 2 bp of what sells, $0.25 floor |
| `adl` | runs ADL batches while a window is open | insurance fund: 2 bp of what closes, or 0.1% of the bad debt averted |
| `refresh` | stores a fresh price on quiet markets | insurance fund: $0.10 |
| `terminalSettlement` | settles positions at a fixed settlement price, then finalizes | up to $0.05 per position settled |
| `collect` | claims your earnings, optionally forwarding them | — |
| `sweepExpired` | unlinks expired orders, returns stranded bounties | nobody: a public service |

```bash
npm install
npm run build
npx bazaar keeper init      # asks for the network, RPC, subgraph, price endpoint, wallet, jobs and markets
npx bazaar keeper doctor    # checks every connection, the wallet's ETH, and the jobs
npx bazaar keeper start     # runs until Ctrl-C
npx bazaar keeper status    # from another terminal: what it is doing and what it has earned
```

Secrets live only in `.env`: the loader refuses a private key, password or API key written into the
YAML, including a key inside a URL such as Alchemy's `/v2/<key>` or a `?key=` query. Write the whole URL
as `${RPC_HTTP_URL}`, or only its key, as in `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`.

The keeper connects to any JSON-RPC provider (Alchemy, Infura, QuickNode, your own node). It needs
`eth_call` state overrides to measure rewards before sending (`doctor` checks), and `eth_getLogs` over
`rpc.logChunk` blocks. Full guide: [packages/keeper](packages/keeper/README.md).

## Frontends

```ts
import { Bazaar, OrderType, parseUnits18 } from "@liberta-labs/bazaar-sdk";

const bz = await Bazaar.connect({
  transport: window.ethereum,            // any EIP-1193 provider, a viem client, or an RPC URL
  factory: "0x...",
  prices: "https://hermes.example",      // Hermes-compatible endpoint (your own key, or a proxy)
  subgraph: "https://subgraph.example",  // optional: history
  integrator: "0xYourFrontend",          // optional: earns the integrator fee on your users' fills
});

const eth = await bz.markets.getMarket("ETH/USD");
const call = await bz.trade.createOrder(eth.address, user, {
  orderType: OrderType.Limit, isLong: true, size: parseUnits18("0.5"), limitPrice: parseUnits18("1990"),
});
const sim = await bz.simulate(call);     // a revert comes back decoded, with a message for the user
if (sim.ok) await bz.send(window.ethereum, call);
```

The SDK never holds a user's key: every write is a `PreparedCall` the frontend simulates and sends with
the user's wallet, and signatures (gasless calls, USDC permits) are requested from the wallet. Full guide:
[packages/sdk](packages/sdk/README.md).

## Development

Node 20 or later.

```bash
npm install
npm run build            # tsc -b, both packages
npm test                 # unit tests (vitest)
npm run typecheck:check  # typecheck sources and tests without emitting; the SDK also without Node types
npm run test:e2e         # end to end against a fresh Anvil (see below)
npm run sync-abis -- ../bazaar   # refresh the typed ABIs after a contract change
npm run build-probe      # rebuild the simulation probe (solc 0.8.34; on Windows, Foundry's copy in WSL)
npm run gen-bindings     # refresh the Bazaar facade's bindings after adding a client function
```

The end-to-end tests replay a recorded Bazaar deployment on a fresh Anvil, build a market, then run
the real keeper and the frontend SDK against it; see
[packages/keeper/test/e2e/fixtures/README.md](packages/keeper/test/e2e/fixtures/README.md) for how the
recording is made. Start Anvil with

```bash
anvil --port 8546 --block-time 1 --base-fee 10000000 --code-size-limit 100000
```

then `BAZAAR_E2E_RPC=http://127.0.0.1:8546 npm run test:e2e`. The tests skip when no Anvil answers.

A `Dockerfile` runs the keeper as an unprivileged user. How it works, and why it is built this way:
[DESIGN.md](DESIGN.md).

## License

MIT. See [LICENSE](LICENSE).
