# @liberta-labs/bazaar-keeper

The Bazaar **keeper**: the protocol's permissionless upkeep, for its bounties. It watches the markets
you choose, works out which calls pay, simulates each one against the chain, and sends it from your own
wallet. Built on [`@liberta-labs/bazaar-sdk`](../sdk).

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

Manual operations (`terminateScheduledPair`, `terminateStalePair`, UMA and insurer-vote settlement,
`finalizeTermination`, and the factory's listing and identifier-upgrade housekeeping) run when you call
them, naming the market on each call. `bazaar keeper opportunities` tells you when one is available.

## Install

Node 20 or later. The price stream runs on the `ws` package, so no global WebSocket is needed.

```bash
npm install -g @liberta-labs/bazaar-keeper     # or, from this repository: npm install && npm run build
```

## Quick start

```bash
bazaar keeper init      # asks for the network, RPC, subgraph, price endpoint, wallet, jobs and markets
bazaar keeper doctor    # checks every connection, the wallet's ETH, and the jobs
bazaar keeper start     # runs until Ctrl-C (or SIGTERM)
bazaar keeper status    # from another terminal: what it is doing and what it has earned
```

`init` writes `bazaar-keeper.yaml` and a `.env` beside it (owner-only), puts a new keystore in `keys/`
beside them and sets `state.dir` to `state/` beside them, so one directory holds everything the keeper
keeps. It asks before storing the keystore password in `.env`. Secrets live only in `.env`: the loader
refuses a private key, password or API key written into the YAML, including as the default of a
`${NAME:-default}`, in a `prices.headers` value (write `Bearer ${NAME}` or `${NAME}`), or inside a URL
such as Alchemy's `/v2/<key>` or a `?key=` query. Write the whole URL as `${RPC_HTTP_URL}`, or only its
key, as in `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`. See
[bazaar-keeper.example.yaml](../../bazaar-keeper.example.yaml) for every option. Errors print one
readable line; add `--debug` for the full trace. URLs and keys are masked in everything the CLI prints.

## Configuration in brief

- **Network.** `arbitrum-one`, `arbitrum-sepolia`, `anvil`, or `custom` with `chainId`. Give `factory`
  until the network's preset carries the official address. Everything else (lens, terminator, oracle,
  markets, feeds) is read from the factory, and the keeper refuses to start if the lens or terminator
  belongs to a different factory.
- **RPC.** Any JSON-RPC provider. It needs `eth_call` state overrides to measure rewards before sending
  (`doctor` checks; without them only unpaid duties and loss-taking jobs send) and `eth_getLogs` over
  `rpc.logChunk` blocks (refused ranges are split automatically). `rpc.send: sequencer` submits straight
  to Arbitrum One's sequencer.
- **Subgraph.** `subgraph.url` is any deployment of Bazaar's subgraph, or `none` to index from chain
  logs. The subgraph only finds accounts and orders; every decision is made from chain state. Without
  one, the first start replays every Bazaar log from the factory's deployment block (`startBlock`);
  left out, the keeper finds that block itself with about 30 historical `eth_getCode` reads, which
  needs an RPC that keeps historical state (hosted providers do). Later starts tail from the snapshot.
- **Prices.** Pyth Pro. `prices.endpoint` is `pyth` (with your own Pyth Pro access token in
  `prices.token`), the URL of a Pyth Pro compatible service (`bazaar mock-prices` on a local chain,
  a proxy), or `bazaar` once Bazaar's shared endpoint exists; `prices.streamUrls`, `prices.restUrl` and
  `prices.symbolsUrl` replace one place each. The keeper streams `prices.channel`
  (`fixed_rate@200ms` by default) with one subscription per market, and uses only updates signed by a
  signer the deployment's Pyth verifier trusts (`prices.checkSigners`). A stream that brings no new
  update for `prices.streamIdleTimeoutSeconds` (10) is dropped and reconnected. Feed ids are Pyth Pro
  feed numbers (ETH/USD, which prices gas, is 2).
- **Wallets.** `keystore` (recommended; `bazaar wallet new` makes one), `privateKey` from the
  environment, `mnemonic`, or a `remote` signer. Each wallet is its own nonce queue: give
  latency-critical jobs their own (`wallet: fast`). With no wallet the keeper is watch-only.
- **Markets.** Each job takes `markets: all` (new listings included) or a list of pair addresses, pair
  ids or labels such as `BTC/USD`, plus `exclude`. `bazaar keeper markets` lists them; `init` writes
  addresses, each with its label as a comment. Labels are not unique (a market relisted after a
  termination keeps the label, a composite is labelled after its base): a label covers every market
  carrying it, each job acting only on those in a status it runs in, and the keeper warns with their
  addresses. Commands the keeper suggests name markets by address.

## Losing calls are your choice

By default a paid call is sent only when it is profitable: reward − gas ≥ `minProfitUsd` and reward ≥
gas × `gasSafetyMultiplier`. The reward is not estimated: the keeper simulates the call through a probe
contract placed by `eth_call` state override and reads exactly what it would earn.

A keeper may still want to send calls that lose money, because the work matters to the protocol
(liquidating a position before it becomes bad debt, opening an ADL window) or as a public service. Each
job can opt in:

```yaml
jobs:
  liquidation:
    allowLoss: true            # also send calls that cost more than they earn
    maxLossUsdPerCall: 0.10    # never lose more than this on one call
    lossBudgetUsdPerDay: 2     # nor more than this per day for this job
budget:
  maxLossUsdPerDay: 5          # and never more than this across all jobs
```

`sweepExpired` is loss-taking by nature, so it ships with `allowLoss: true` and a $0.25 daily budget,
and runs only if you enable the job. `terminalSettlement.finalize` and `refresh.healthPokes` are consent
to pay for those specific calls, within `finalizeMaxCostUsd` / `healthPokeMaxCostUsd` and the job's loss
budget. A one-shot `bazaar keeper run … --force` skips the profit and loss rules for that call. Whatever
you choose (`--force` included), every call must fit `budget.maxSpendUsdPerDay` and
`budget.maxSpendEthPerDay` (the same cap counted in wei, so no price feed can lift it; by default
`maxSpendUsdPerDay` at `gas.ethUsdFloor`, $1,000), gas is never priced below `gas.ethUsdFloor`, `maxFeeGwei`
caps the fee per gas outright, and nothing that reverts in simulation is
ever sent.

## Commands

Everything below is `bazaar keeper <command>`; `bazaar wallet new|import|list` and `bazaar mock-prices`
are shared tools.

| Command | |
|---|---|
| `init` | the setup wizard |
| `doctor` | check the RPC, factory wiring, subgraph, prices, wallets and jobs |
| `start [--dry-run] [--only liquidation,triggers]` | run the enabled jobs |
| `status` | jobs, wallets and today's earnings of a running keeper |
| `markets` | every market with its label, status and open positions |
| `earnings [--since 7d] [--by job\|market]` | rewards, gas and net from the ledger |
| `opportunities` | manual operations available now, each confirmed by simulation |
| `run <operation> --market <m> [--dry-run] [--force] [--yes]` | one operation now |

`run` operations: `liquidate`, `execute-triggers`, `unload`, `execute-adl`, `refresh-price`, `collect`,
`settle-terminal`, `sweep-expired`, and the manual `finalize`, `terminate-stale`, `terminate-scheduled`,
`settle-termination`, `execute-insurer-termination`, `settle-listing`, `expire-listing`,
`settle-identifier-upgrade`, `expire-identifier-upgrade`, `activate-identifier-upgrade`. Manual
operations show what would happen and ask before sending.

## As a library

```ts
import { Keeper, loadConfig } from "@liberta-labs/bazaar-keeper";

const keeper = await Keeper.create(loadConfig("bazaar-keeper.yaml"));
keeper.on("action", (r) => console.log(r.job, r.market, r.status, r.rewardUsd, r.costUsd));

// One call, market named per call:
console.log(await keeper.run.liquidate("ETH/USD", { dryRun: true }));
console.log(await keeper.run.terminateScheduledPair("TSLA/USD", { dryRun: true }));

await keeper.start();   // runs until keeper.stop()
```

## Speed

A new price reaches the liquidation and trigger planners without waiting for the tick: each print plans
only the markets whose feeds moved (median 0.5 ms from print to planned, with 200 markets of 2,000
positions each), and nothing touches the RPC unless something crosses at the live price. Latency wins
races on Arbitrum, so give latency-critical jobs their own wallet and point `rpc.send` at the sequencer.

## Running it around the clock

Run one process per set of wallets: two processes signing with one wallet would fight over its nonces.
The keeper keeps a snapshot, its earnings ledger and a status file under `state.dir` (`~/.bazaar` by
default, `state/` next to the config when `init` wrote it, under `keeper/`), so a restart resumes where
it stopped. The repository's `Dockerfile` runs it as an unprivileged user, with everything it keeps in
the directory mounted at `/config`:

```bash
mkdir -p keeper
docker run --rm -it --user "$(id -u):$(id -g)" -v "$PWD/keeper:/config" bazaar-keeper keeper init   # once
docker run -d --restart unless-stopped --user "$(id -u):$(id -g)" -v "$PWD/keeper:/config" bazaar-keeper
```

Let `init` store the keystore password in `.env` there: a detached container cannot ask for it.
`docker stop` stops the keeper cleanly.

How it works, and why it is built this way: [DESIGN.md](../../DESIGN.md).
