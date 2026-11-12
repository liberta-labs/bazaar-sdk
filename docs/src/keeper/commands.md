# Commands

Everything the `bazaar` command does. `bazaar keeper <command>` runs the keeper; `bazaar wallet` and
`bazaar mock-prices` are shared tools. Every command has `--help`.

| Command | What it does |
|---|---|
| [`keeper init`](#keeper-init) | the setup wizard |
| [`keeper doctor`](#keeper-doctor) | checks the RPC, the factory's wiring, the subgraph, prices, wallets and jobs |
| [`keeper start`](#keeper-start) | runs the enabled jobs until stopped |
| [`keeper status`](#keeper-status) | what a running keeper is doing |
| [`keeper markets`](#keeper-markets) | every market with its label, status and open positions |
| [`keeper earnings`](#keeper-earnings) | rewards, gas and net from the ledger |
| [`keeper opportunities`](#keeper-opportunities) | manual operations available now |
| [`keeper run`](#keeper-run) | one operation now |
| [`wallet`](#wallet) | create, import or list wallets |
| [`mock-prices`](#mock-prices) | a mock Pyth Pro price endpoint for a local chain |

## Common Options

| Option | Meaning |
|---|---|
| `-c, --config <path>` | the keeper's config file; default `bazaar-keeper.yaml` in the current directory (`~/` works). Every `keeper` command and `wallet list` take it |
| `--debug`, `--verbose` | print the whole error with its stack trace when a command fails (`bazaar --debug keeper start`, or at the end of the line) |
| `-h, --help` | the command's usage |

Errors print one readable line, with URLs and keys masked. Exit codes:

| Code | Meaning |
|---|---|
| 0 | done |
| 1 | the command failed (an unreachable RPC, a failed `doctor` check), setup was cancelled, or a stop ran past its 50 s deadline |
| 2 | a usage, config or wallet problem: an unknown option, a missing `--market`, an invalid config, a wrong keystore password |
| 130 | cancelled at a prompt, or stopped by a second Ctrl-C |

## `keeper init`

```bash
bazaar keeper init [-c bazaar-keeper.yaml]
```

Asks for the network, factory, RPC, subgraph, price endpoint, wallet, jobs and markets, checking each
answer, and writes the config and a `.env` beside it (secrets and URLs only in `.env`), a new keystore
in `keys/` beside them, and `state.dir` as `state/` beside them. Needs a terminal. Every question is
explained in [Setting Up a Keeper](setup.md#2-answer-the-wizard-bazaar-keeper-init).

## `keeper doctor`

```bash
bazaar keeper doctor [-c bazaar-keeper.yaml]
```

Checks everything `start` relies on. Exits 0 when nothing failed, 1 otherwise.

```text
✔ RPC            chain 42161, latency 61 ms, eth_call state overrides supported
✔ Factory        0x0000000000000000000000000000000000000000 not an official deployment, 12 market(s)
✔ Wiring         lens and terminator both point back at this factory
✔ Subgraph       synced to block 271,402,118 (14 blocks behind)
✔ Prices         12/12 markets have a print; 4 not fresh right now (AAPL/USD, TSLA/USD, NVDA/USD, SPY/USD)
✔ Prices         the fixed_rate@200ms stream is delivering
✔ Wallet default 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955, 0.05000 ETH (roughly 8,333 calls at today's base fee)
✔ Wallet fast    0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f, 0.03000 ETH (roughly 5,000 calls at today's base fee)
⚠ Jobs           liquidation takes losses: up to $0.1 a call, $2 a day
✔ Jobs           liquidation, triggers, unload, adl, refresh, collect, terminalSettlement
```

"Not fresh right now" is normal for markets with trading hours outside them. The first `Prices` line
is one request to the request API; the second opens the price stream for ETH/USD and waits up to 5
seconds for a print (skipped when `prices.stream` is off). Each line is explained in
[Setting Up a Keeper](setup.md#3-check-everything-bazaar-keeper-doctor); each failure in
[Troubleshooting](troubleshooting.md).

## `keeper start`

```bash
bazaar keeper start [-c bazaar-keeper.yaml] [--dry-run] [--only <jobs>]
```

| Option | Meaning |
|---|---|
| `--dry-run` | plan and simulate every call, log it, send nothing (sets every job's `dryRun`) |
| `--only <jobs>` | comma-separated jobs to run, out of those the config enables; the rest are switched off for this run. Names in any style: `liquidation,triggers`, `terminal-settlement`, `sweep_expired` |

Runs until Ctrl-C or SIGTERM. The first signal stops cleanly (in-flight transactions finish, collect
runs if its `onShutdown` is set, the snapshot is saved); a second leaves at once, and a stop still
running after 50 s is cut short.

```bash
bazaar keeper start --dry-run --only liquidation,triggers
```

## `keeper status`

```bash
bazaar keeper status [-c bazaar-keeper.yaml]
```

Reads the `status.json` of the keeper running with this config (it connects to nothing), so it works
from any terminal on the same machine:

```text
Bazaar keeper · arbitrum-one · block 271,402,140 · indexed 271,402,139 · prices live · running
factory 0x0000000000000000000000000000000000000000 is not an official deployment
 JOB                 MARKETS  LAST ACTION                                                  TODAY EARNED    GAS     NET
 liquidation              12  ETH/USD liquidate 1 account(s), $2,050 notional (confirmed)         $0.35  $0.01   $0.34
 triggers                 12  BTC/USD execute 2 trigger order(s), up to $0.40 of bounty (confirmed)  $1.20  $0.02   $1.18
 unload                   12  -                                                                   $0.00  $0.00   $0.00
 collect                 all  ETH/USD claim $5.12 (confirmed)                                     $0.00  $0.00  $-0.00
 WALLET   ADDRESS
 default  0x14dC79964da2C08b23698B3D3cc7Ca32193d9955
 fast     0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f
```

With no status file yet: `No keeper has run with this config yet. Start one with bazaar keeper start.`
A file more than 30 seconds old shows `not running (last seen N min ago)`. A red line under the header
says sending is halted. [Monitoring](production.md#monitoring) lists every field of the file.

## `keeper markets`

```bash
bazaar keeper markets [-c bazaar-keeper.yaml]
```

Every market of the factory, sorted by label. It connects without loading wallets; with no snapshot
yet it builds the index first, which takes as long as a first start.

```text
 MARKET    ADDRESS                                     STATUS      HOURS    POSITIONS  LIVE ORDERS  INVENTORY
 AAPL/USD  0x5FbDB2315678afecb367f032d93F642f64180aa3  live        session         41           63          0
 BTC/USD   0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512  live        24/7           388          912      0.012
 ETH/USD   0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0  live        24/7           521         1204          0
 ETH/USD   0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9  terminated  24/7             0            0          0
```

`STATUS` is `live`, `adl`, `limbo`, `settling` or `terminated`; `HOURS` is `24/7` or `session` (a
market with trading hours); `INVENTORY` is the vault's inherited position, in units. Two rows with one
label are two markets (here a terminated one and its relisting): name them by address.

## `keeper earnings`

```bash
bazaar keeper earnings [-c bazaar-keeper.yaml] [--since 7d] [--by job|market]
```

| Option | Default | Meaning |
|---|---|---|
| `--since <period>` | `7d` | how far back: `30m`, `24h`, `7d`; a bare number is days |
| `--by <group>` | `job` | one row per `job` or per `market` (market label; `-` for calls on no market) |

```text
 MARKET    CALLS  REVERTED   EARNED      GAS      NET  CLAIMED
 -             1         0  $0.0000  $0.0002  $-0.0002    $0.00
 BTC/USD      22         2  $3.4100  $0.0410  $3.3690    $0.00
 ETH/USD      19         1  $1.9500  $0.0380  $1.9120   $12.40
```

Reads `ledger.jsonl` only: it works whether or not the keeper is running. `No transactions in that
period.` when there are none. [The Ledger](budgets.md#the-ledger-and-earnings) explains the columns.

## `keeper opportunities`

```bash
bazaar keeper opportunities [-c bazaar-keeper.yaml]
```

Lists the manual operations a dry run shows would go through now, or that a "too early" revert shows
will open later, each with the command that runs it (naming the market by address):

```text
finalizeTermination ETH/USD: every position is settled, or the escape hatch has opened (ready now) — bazaar keeper run finalize --market 0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
terminateScheduledPair TSLA/USD: its scheduled cutoff has passed (opens at 2026-11-09 14:30 UTC) — bazaar keeper run terminate-scheduled --market 0x5FC8d32690cc91D4c39d9d3abcBD16989F875707
```

Or `Nothing is waiting for a manual call.` [Manual Operations](manual-operations.md#opportunities)
lists what it looks for.

## `keeper run`

```bash
bazaar keeper run <operation> [--market <m>] [options]
```

Runs one operation now. Every call is simulated first; nothing that reverts in simulation is sent.

| Option | Meaning | Used by |
|---|---|---|
| `--market <m>` | a market's label, address or pair id; comma-separated for `collect` | every per-market operation (required), `collect` (optional) |
| `--accounts <addresses>` | comma-separated accounts | `liquidate`, `settle-terminal` |
| `--orders <ids>` | comma-separated order ids | `execute-triggers`, `sweep-expired` |
| `--assertion <id>` | a UMA assertion id (32 bytes, with or without `0x`) | `settle-termination`, `settle-listing`, `settle-identifier-upgrade` (required) |
| `--proposal <id>` | an insurer proposal id | `execute-insurer-termination` (required) |
| `--pair-id <id>` | a listing's pair id | `expire-listing` (required) |
| `--dry-run` | simulate and report, send nothing | all |
| `--force` | send even when the profit and loss rules would skip it | the automatic operations |
| `-y, --yes` | send a manual operation without asking | the manual operations |
| `--stored-price <policy>` | when a settlement at the market's stored price is planned once its last resort is open: `whenAbsent` (default), `always` or `never` | `terminate-scheduled` |
| `--accept-stored-price` | send a settlement at the stored price, which is otherwise shown and not sent, `--yes` or not | `terminate-scheduled` |

| Operation | Calls | Needs |
|---|---|---|
| `liquidate` | `liquidate` on the accounts given, or every account below its requirement | `--market` |
| `execute-triggers` | `executeTriggeredOrders` on the orders given, or every ready one | `--market` |
| `unload` | `unloadVault` | `--market` |
| `execute-adl` | `executeAdl` with the planner's picks | `--market` |
| `refresh-price` | `refreshPrice` | `--market` |
| `collect` | `claimFees` on every market (or those given) where a wallet holds a balance | |
| `settle-terminal` | settlement-mode `liquidate` on the accounts given, or every open position | `--market` |
| `sweep-expired` | `sweepExpired` on the orders given, or every expired or finished one | `--market` |
| `finalize` | `finalizeTermination` | `--market` |
| `terminate-stale` | the terminator's `terminateStalePair` | `--market` |
| `terminate-scheduled` | the terminator's `terminateScheduledPair`, with the archived Pyth Pro updates its rule asks for | `--market` |
| `settle-termination` | the terminator's `settleTerminationProposal` | `--assertion` |
| `execute-insurer-termination` | the terminator's `executeInsurerTermination` | `--market`, `--proposal` |
| `settle-listing` | the factory's `settleDeploymentProposal` | `--assertion` |
| `expire-listing` | the factory's `expireStuckDeploymentProposal` | `--pair-id` |
| `settle-identifier-upgrade` | the factory's `settleIdentifierUpgradeProposal` | `--assertion` |
| `expire-identifier-upgrade` | the factory's `expireStuckIdentifierUpgradeProposal` | |
| `activate-identifier-upgrade` | the factory's `activateIdentifierUpgrade` | |

The automatic operations (the first eight) keep their job's profit and loss rules unless `--force`.
The manual ones show what would happen and ask `Send it?` (default no) before sending; without a
terminal they print `Not sent: pass --yes to send without confirming.` A missing required option is a
usage error (`liquidate needs --market`, exit 2).

Each result prints as a status, the job, the market and a summary, then its reason, what it earned or
would earn, its transaction, and when a "too early" call opens:

```text
$ bazaar keeper run liquidate --market ETH/USD --dry-run
simulated  liquidation  ETH/USD  liquidate 1 account(s), $2,050 notional
   earns $0.0500 for $0.0019 of gas
   would earn $0.0500 for about $0.0019 of gas

$ bazaar keeper run refresh-price --market BTC/USD
skipped  refresh  BTC/USD  refresh price
   below the profit rule: earns $0.0000 for $0.0021 of gas, needs ×1.25 and $0.001 net (allowLoss is off)

$ bazaar keeper run finalize --market 0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
simulated  finalizeTermination  ETH/USD  finalize ETH/USD
   sent on request (profit and loss rules skipped)
   would earn $0.0000 for about $0.0031 of gas
? Send it? Yes
confirmed  finalizeTermination  ETH/USD  finalize ETH/USD
   sent on request (profit and loss rules skipped)
   earned $0.0000, gas $0.0029
   tx 0x8a3f…
```

The statuses: `simulated` (a dry run, or a preview), `skipped` (not sent, with why), `confirmed`,
`reverted` (on chain), `unknown` (no receipt). [Manual Operations](manual-operations.md) covers each
operation.

## `wallet`

```bash
bazaar wallet new    [--name default] [--path <file>]
bazaar wallet import [--name default] [--path <file>]
bazaar wallet list   [-c bazaar-keeper.yaml]
```

| Option | Default | Meaning |
|---|---|---|
| `--name <name>` | `default` | the keystore's file name, and the name to put it under in `wallets` |
| `--path <file>` | `~/.bazaar/keys/<name>.json` | where to write the keystore |

`new` creates a key and saves it as an encrypted keystore; `import` encrypts a private key you paste;
both ask for a password twice and print the YAML to add. `list` loads the config's wallets and prints
each one's ETH and claimable earnings. [Wallets & Secrets](wallets.md#the-bazaar-wallet-commands).

## `mock-prices`

```bash
bazaar mock-prices [--rpc http://127.0.0.1:8545] [--price <FEED_ID=USD>]... \
  [--host 127.0.0.1] [--port 8787] [--token-env <NAME>]
```

| Option | Default | Meaning |
|---|---|---|
| `--rpc <url>` | `http://127.0.0.1:8545` | the local chain, whose clock the updates follow |
| `--price <FEED_ID=USD>` | ETH/USD at 2000 | a feed's starting price; repeatable. The feed is its Pyth Pro number (`2=3000` is ETH/USD) or the bytes32 a pair reports as its `baseFeedId` |
| `--host <host>` | `127.0.0.1` | the address to listen on. One other machines can reach (anything but `localhost`, `127.0.0.0/8` and `::1`) is refused without `--token-env` |
| `--port <port>` | `8787` | the port |
| `--token-env <NAME>` | none | the environment variable that holds a token every client must present, the price controls included (the symbols registry needs none). It is read from the environment, never the command line, where other users' process listings would show it |

Serves a mock Pyth Pro endpoint until Ctrl-C: the price stream, the request API and the symbols
registry. Its updates are signed with the public test key that only a local deployment's mock verifier
trusts, and stamped with the chain's time. For local testing only:
[Testing Locally with Anvil](local-testing.md#the-mock-price-server).

```text
mock Pyth Pro on http://127.0.0.1:8787 (stream ws://127.0.0.1:8787/v1/stream), on the clock of http://127.0.0.1:8545; feeds: 2
```
