# Setting Up a Keeper

This page takes you from nothing to a running keeper: install it, answer the setup wizard, check
every connection with `doctor`, fund the wallet, start it, and read what it is doing. It assumes
Arbitrum Sepolia; the steps are the same on Arbitrum One. To try everything on a local chain first,
see [Testing Locally with Anvil](local-testing.md).

Before you start, have at hand:

- an Arbitrum RPC URL that supports `eth_call` state overrides (most hosted providers' URLs carry
  your API key; the wizard keeps them out of the config file);
- a Pyth Pro access token (from Pyth; a Pyth Core or Hermes key does not work), or the URL of another
  Pyth Pro compatible price service;
- the factory address of the Bazaar deployment you want to keep (the network presets carry no
  official address yet);
- a little ETH on that network for gas.

## 1. Install

The keeper needs Node 20 or later. Once the packages are published:

```bash
npm install -g @liberta-labs/bazaar-keeper
bazaar --help
```

Until then, install from the repository and run the built CLI with Node:

```bash
git clone https://github.com/liberta-labs/bazaar-sdk && cd bazaar-sdk
npm install && npm run build
alias bazaar="node $PWD/packages/keeper/dist/cli/main.js"
bazaar --help
```

The rest of this guide writes `bazaar`. [Installation](../getting-started/installation.md) covers the
SDK package as well. To run in a container instead, see
[Running in Production](production.md#docker): the wizard runs inside the container the same way.

Make a directory for the keeper and work in it. Everything the keeper keeps (its config, `.env`,
keystore and state) ends up there:

```bash
mkdir -p ~/keeper && cd ~/keeper
```

## 2. Answer the Wizard: `bazaar keeper init`

```bash
bazaar keeper init
```

The wizard asks what it cannot discover, checks each answer as you give it, and writes two files:
`bazaar-keeper.yaml` (or the path given with `-c`) and a `.env` beside it. Secrets and every URL you
type go to `.env` only; the YAML refers to them as `${NAME}`. It needs an interactive terminal: run
without one, it stops with *init needs an interactive terminal* (copy
`bazaar-keeper.example.yaml` and edit it instead). Ctrl-C at any question cancels and writes no
config.

If the config file already exists, the first question is whether to replace it (default no; answering
no leaves everything as it was).

### Network

| Answer | Writes |
|---|---|
| Arbitrum Sepolia (testnet) | `network: arbitrum-sepolia` |
| Arbitrum One | `network: arbitrum-one` |
| Local Anvil | `network: anvil` |
| Custom factory address | `network: custom`, then asks the **chain id** and writes `chainId` |

### Factory Address

Asked for a custom network, and for any preset without an official factory (at present all of them).
It must be an address; it is written as `factory: "0x…"`. Everything else (the lens, the terminator,
the oracle, the markets and their feeds) is read from the factory.

For a custom network the wizard then asks **the factory's deployment block**. Leave it empty and the
keeper finds the block on chain when it needs it (a first start without a subgraph); give it and it is
written as `startBlock`. See [Configuration Reference](configuration.md#where).

### RPC URL

Your node's HTTPS URL (on Anvil the default is `http://127.0.0.1:8545`). The wizard calls
`eth_chainId` and asks again until the URL answers with the network's chain id, printing what went
wrong (`✘ that RPC is on chain 1, not 421614`). It writes `rpc.http: ${RPC_HTTP_URL}` and puts the
URL in `.env` as `RPC_HTTP_URL`.

On Arbitrum One, which has a sequencer endpoint preset, it then asks whether to **submit transactions
straight to the sequencer** (default yes), which writes `rpc.send: sequencer`.

### Subgraph

| Answer | Writes |
|---|---|
| Bazaar's subgraph for this network (offered only when the network preset has one; none does yet) | `subgraph.url: default` |
| None: index from chain logs | `subgraph.url: none` |
| Custom URL | `subgraph.url: ${SUBGRAPH_URL}`, the URL in `.env` |

The subgraph only makes the first start faster. Without one, the first start replays every Bazaar log
from the factory's deployment block; later starts resume from the snapshot either way.

### Price Endpoint

| Answer | Asks | Writes |
|---|---|---|
| Pyth Pro, with my own access token | the token (hidden) | `prices.endpoint: pyth`, `prices.token: ${PYTH_PRO_TOKEN}` |
| Custom Pyth Pro compatible URL (bazaar mock-prices, a proxy) | the URL (on Anvil, default `http://127.0.0.1:8787`), then whether it needs an access token, and the token | `prices.endpoint: ${PRICE_ENDPOINT_URL}`, and `prices.token: ${PRICE_TOKEN}` if it needs one |
| Bazaar shared endpoint | (not selectable: it has no URLs yet) | |

It then reads an ETH/USD print (Pyth Pro feed 2) from the request API to check the endpoint and the
token: `✔ ETH/USD print 3,012.45`, or a warning (`⚠ could not read a print yet: …`) that does not stop
the wizard. The channel is left at its default, `fixed_rate@200ms`; set `prices.channel` to change it
([Configuration](configuration.md#prices)).

### Keeper Wallet

| Answer | What happens |
|---|---|
| Create a new wallet | generates a key, asks for a keystore password twice, and writes an encrypted keystore to `keys/default.json` beside the config (`default-2.json` and so on if that exists) |
| Import a private key | asks for the key (hidden, checked), then a password twice, and writes it the same way |
| Use an existing keystore file | asks for its path, which must exist; nothing is written |
| No wallet: watch-only | no `wallets` section: the keeper plans and simulates, and sends nothing |

A new keystore prints its address: `✔ 0x14dC…9955 encrypted at /home/me/keeper/keys/default.json.
Fund it with a little ETH for gas.` The config gets:

```yaml
wallets:
  default:
    type: keystore
    path: /home/me/keeper/keys/default.json
```

Then it asks whether to **store the keystore password in `.env`** (default yes). Yes adds
`password: ${KEEPER_KEYSTORE_PASSWORD}` and puts the password in `.env`; for an existing keystore it
asks for the password first (it does not check it: `doctor` will). No means the keeper asks for the
password at every start, which only works in a terminal: a service or a detached container cannot
answer. See [Wallets & Secrets](wallets.md).

### Jobs

A checklist of the eight jobs, each with what it pays. All are checked except `sweepExpired`, which
pays nothing. If you pick any job besides `collect`, the wizard lists the factory's markets.

### Losses

If you picked a job that can lose money (anything but `collect` and `sweepExpired`), it asks whether
any job should **also send calls that cost more than they earn**. Default no. Yes asks which jobs,
the largest loss per call (default `0.05` USD) and the daily loss budget per job (default `1`), and
writes `allowLoss: true`, `maxLossUsdPerCall` and `lossBudgetUsdPerDay` under each chosen job. See
[Budgets & Losing Calls](budgets.md).

### Markets for Each Job

For each picked job except `collect`, once markets were found:

| Answer | Writes |
|---|---|
| All markets, including future listings | `markets: all` |
| Choose markets… | the chosen markets' addresses, each with its label as a YAML comment (choosing none means all) |
| Same as the previous job | the previous job's choice |

Chosen markets are written by address because labels are not unique: a market relisted after a
termination keeps its label, and a composite is labelled after its base. If the markets could not be
listed, the wizard warns and every job runs on all markets.

### Collect

If you picked `collect`: the balance at which a market is claimed (default `5` USD, written as
`thresholdUsd`), and optionally an address to forward collected USDC to (`forwardTo`).

### What It Writes

The config ends with `state.dir` set to `state/` beside it, so the snapshot, the earnings ledger and
the status file live in the same directory. Paths are written absolute, so the keeper can be started
from anywhere. A typical result:

```yaml
# Written by bazaar keeper init. Secrets live in .env next to this file.

network: arbitrum-sepolia
factory: "0x0000000000000000000000000000000000000000"

rpc:
  http: ${RPC_HTTP_URL}

subgraph:
  url: none

prices:
  endpoint: pyth
  token: ${PYTH_PRO_TOKEN}

wallets:
  default:
    type: keystore
    path: /home/me/keeper/keys/default.json
    password: ${KEEPER_KEYSTORE_PASSWORD}

jobs:
  liquidation:
    markets: all
  triggers:
    markets: all
  unload:
    markets: all
  adl:
    markets: all
  refresh:
    markets: all
  terminalSettlement:
    markets: all
  collect:
    thresholdUsd: 5

# The snapshot, the earnings ledger and the status file, so a restart resumes where it stopped.
state:
  dir: /home/me/keeper/state
```

and the `.env` beside it, owner-only (mode 0600) where the file system has POSIX permissions:

```bash
RPC_HTTP_URL=https://arb-sepolia.g.alchemy.com/v2/your-key
PYTH_PRO_TOKEN=your-pyth-pro-token
KEEPER_KEYSTORE_PASSWORD=your-password
```

Running `init` again over an existing `.env` keeps the `NAME=value` lines already there (comments are
dropped) and replaces or adds the new ones. A job with nothing under it is written as `job: {}`:
a job key with an empty value reads as null, which turns the job off.

The wizard ends with `Next: bazaar keeper doctor, then bazaar keeper start`.

## 3. Check Everything: `bazaar keeper doctor`

```bash
bazaar keeper doctor
```

`doctor` loads the config and the wallets (a keystore without a stored password is asked for here),
then checks everything `start` relies on, one line each. It exits 0 when nothing failed (warnings
allowed) and 1 otherwise. A config file that does not load (invalid YAML, a secret written into it,
an unknown key) prints one line and exits 2. URLs and keys are masked in everything it prints.

```text
✔ RPC            chain 421614, latency 84 ms, eth_call state overrides supported
✔ Factory        0x0000000000000000000000000000000000000000 not an official deployment, 3 market(s)
✔ Wiring         lens and terminator both point back at this factory
⚠ Subgraph       none configured: the first start indexes from chain logs
✔ Prices         3/3 markets have a print
✔ Prices         the fixed_rate@200ms stream is delivering
✔ Wallet default 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955, 0.02000 ETH (roughly 3,333 calls at today's base fee)
✔ Jobs           liquidation, triggers, unload, adl, refresh, collect, terminalSettlement
```

| Line | What it checks | When it fails |
|---|---|---|
| Config | the keeper can be built: the network, `rpc.send`, the price endpoint, the wallets (keystores decrypted) | `✘ Config` with the reason, and nothing else is checked |
| RPC | `eth_chainId` and its latency; whether `eth_call` state overrides work | unreachable, or on another chain: stops here. No overrides is a warning: paid jobs will skip |
| Factory | the deployment can be read from the factory, and how many markets it lists; whether it is an official deployment | the factory cannot be read (wrong address, no code): stops here |
| Wiring | the lens and the terminator report this factory | either belongs to a different factory or reports none (`start` refuses to run) |
| Subgraph | how far the subgraph is synced and how far behind the head; indexing errors | unreachable: the keeper falls back to chain logs |
| Prices | a print for every market's legs (plus ETH/USD) from the request API; which markets are not fresh right now (a closed session); whether a fresh, plausible ETH/USD print exists to price gas; then, with `prices.stream` on, whether the stream brings an ETH/USD print within 5 s | the request API fails (a bad token, a wrong URL). A stream that brings nothing is a warning: the keeper would poll the request API instead |
| Wallet | each wallet's address, ETH balance, and roughly how many calls it pays for at the current base fee (600,000 gas each) | the balance is below `budget.minEthBalance` |
| Jobs | the enabled jobs; each job's markets resolve; warnings for jobs that take losses and for `sweepExpired` | a job names a market no market carries |

Fix every `✘` before starting; [Troubleshooting](troubleshooting.md) has each message and its fix.

## 4. Fund the Wallet

Send ETH on the keeper's network to the wallet address `doctor` printed. No keeper call needs USDC or
a token approval: gas and Pyth's small update fee are paid in ETH, and bounties accrue to the
wallet's claimable balance on each market.

How much: Arbitrum gas is cheap, and the keeper never spends more than `budget.maxSpendUsdPerDay` (and
`budget.maxSpendEthPerDay`) in a day. Keep comfortably more than `budget.minEthBalance` (0.002 ETH by
default): below it, the keeper stops sending until the wallet is funded again. `bazaar wallet list`
shows each wallet's ETH and what it can claim.

## 5. Start

```bash
bazaar keeper start
```

The first start connects, checks the chain and the factory's wiring, and builds its index: from the
subgraph if one is configured, or by replaying the chain's logs from the factory's deployment block.
Without `startBlock`, it first finds that block with about 30 historical `eth_getCode` reads. The log
shows each step:

```text
12:00:01 INFO    found the factory's deployment block, 123456789 (set startBlock: 123456789 in the config to skip the search)
12:00:01 INFO    indexing from chain logs, blocks 123456789 to 123987654
12:00:41 WARNING factory 0x0000000000000000000000000000000000000000 is not an official deployment
12:00:41 INFO    keeper running on arbitrum-sepolia (3 markets, jobs: liquidation, triggers, unload, adl, refresh, collect, terminalSettlement)
```

From then on it logs each sent call and its result, and each distinct skip reason at most every five
minutes (the rest at debug level):

```text
12:03:17 INFO    liquidation ETH/USD: sent 0x5c1e…a9 (earns $0.1000 for $0.0021 of gas)
12:03:18 INFO    liquidation ETH/USD: liquidate 2 account(s), $4,100 notional confirmed, earned $0.1000 for $0.0019
12:05:00 INFO    refresh BTC/USD: skipped refresh a quiet market's price: below the profit rule: earns $0.1000 for $0.1100 of gas, needs ×1.25 and $0.001 net (allowLoss is off)
```

To try it without sending anything, start with `--dry-run`: every call is planned and simulated, and
logged as it would be sent. `--only liquidation,triggers` runs just those jobs.

The first Ctrl-C (or SIGTERM) stops cleanly: in-flight transactions get their receipts, `collect`
claims your balances if its `onShutdown` is on (the default), and the snapshot is saved. A second
Ctrl-C leaves at once. The next start resumes from the snapshot, replaying only the blocks it missed.

## 6. Read the Status

From another terminal, in the same directory (or with the same `-c`):

```bash
bazaar keeper status
```

```text
Bazaar keeper · arbitrum-sepolia · block 123,987,700 · indexed 123,987,699 · prices live · running
factory 0x0000000000000000000000000000000000000000 is not an official deployment
 JOB                 MARKETS  LAST ACTION                                                  TODAY EARNED    GAS    NET
 liquidation               3  ETH/USD liquidate 2 account(s), $4,100 notional (confirmed)         $0.10  $0.00  $0.10
 triggers                  3  -                                                                   $0.00  $0.00  $0.00
 refresh                   3  -                                                                   $0.00  $0.00  $0.00
 collect                 all  -                                                                   $0.00  $0.00  $0.00
 WALLET   ADDRESS
 default  0x14dC79964da2C08b23698B3D3cc7Ca32193d9955
```

`status` reads the `status.json` the running keeper rewrites every 5 seconds; it does not connect to
anything. The header shows the network, the chain's head and the last block indexed, whether prices
are live (or `prices down:` with the endpoint's last error), and `running`, or `not running (last
seen N min ago)` when the file is more than 30 seconds old. A red line under it means sending is
halted (a wallet below `budget.minEthBalance`). Each job's row counts the markets it covers (`all`
for collect), its last sent call, and the last 24 hours from the ledger.

For longer periods, `bazaar keeper earnings --since 7d` sums the ledger by job or by market
([Commands](commands.md#keeper-earnings)).

## Next

- [Configuration Reference](configuration.md) for everything the wizard did not ask.
- [Running in Production](production.md) to run it around the clock.
- [Budgets & Losing Calls](budgets.md) before raising any cap.
