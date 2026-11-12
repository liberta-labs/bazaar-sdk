# Introduction

[Bazaar](https://docs.bazaar.finance) is a permissionless perpetual futures protocol on Arbitrum:
any asset with a Pyth price feed can be listed and traded on a fully on-chain central limit order
book, margined in USDC. The contracts are immutable, with no owner, pauser or upgrade key, and every
role an exchange keeps for itself (listing, insuring, liquidating, firing stops) is open to anyone.

The protocol runs on the Arbitrum Sepolia testnet; there is no mainnet deployment yet. Bazaar's
[deployments page](https://docs.bazaar.finance/reference/networks.html) lists the official
addresses, and the `arbitrum-sepolia` network preset carries the testnet's factory. Examples that
take a factory address use a placeholder.

This site documents the TypeScript tools for building on it. They come in two packages:

| Package | What it is | Who it is for | Runs in |
|---|---|---|---|
| `@liberta-labs/bazaar-sdk` | Everything an application needs: markets and accounts, live prices and events, every trading action (direct and gasless), USDC approvals and permits, previews, user-facing error messages, history, insurance, termination and settlement, listings and governance | Frontend developers, people writing trading bots and services, relayers | Browsers and Node 20+ |
| `@liberta-labs/bazaar-keeper` | The keeper: Bazaar's permissionless upkeep (liquidations, trigger orders, vault unloads, ADL, price refreshes, terminal settlement, collection), run from your own wallet for the bounties it earns, with the `bazaar` command-line tool | Keeper operators; services that want the keeper's engine as a library | Node 20+ |

The keeper is built on the SDK: the chain client, the ABIs, the price layer, the formulas and the
market reader are the same code a frontend uses.

## What the SDK Does

- **Reads**, batched into as few RPC calls as the node allows: the market list with labels, a market's
  whole state at one block (prices, funding, margin, open interest, insurance, ADL, termination, the
  book), an account's position, health, orders, withdrawable amount and fees, and a portfolio across
  every market.
- **Live data**: a streamed, composed Pyth price per market with freshness and venue-closed flags, and
  typed contract events with refreshed snapshots, safe across reorgs.
- **Writes**, checked before they are built: each builder validates its inputs the way the contract
  will, then returns a `PreparedCall` (target, calldata, ETH value, a one-line summary, the USDC it
  pulls) for your code to simulate and send.
- **Explanations**: a revert decoded to a named error and a sentence for the user, for every custom
  error the contracts declare, and for the failures wallets raise.

## What It Does Not Do

- **It never holds a key.** It does not sign or send on its own. A write is a `PreparedCall` that you
  simulate and hand to the user's wallet (or, in a bot, to a viem `WalletClient` holding the bot's
  key). Signatures for gasless calls and USDC permits are requested from an EIP-1193 wallet with
  `eth_signTypedData_v4`, so the wallet shows the user what they sign.
- **It does not choose for you** whom you serve, which markets you show, or how you present them. The
  contracts cannot tell who calls them; that decision belongs to whoever puts an interface in front of
  users (see Bazaar's [integrator guide](https://docs.bazaar.finance/guide/integrators.html)).
- **It does not run a relayer or an indexer.** It builds and verifies gasless requests and reads
  Bazaar's subgraph; running those services is yours.
- **It does not re-explain the protocol.** Margin, funding, liquidation, ADL and termination are
  defined in [Bazaar's own docs](https://docs.bazaar.finance), which these pages link wherever a rule
  matters.

## A Taste

Connect a browser wallet, read the user's account on the ETH/USD market, and place a limit order,
simulated before the wallet is asked to sign:

```ts
{{#include ../examples/getting-started/taste.ts:taste}}
```

`FACTORY` is the deployment's factory address, from Bazaar's
[deployments page](https://docs.bazaar.finance/reference/networks.html), and `PRICES` where the
order's signed Pyth Pro price comes from: the API key on a server, or a proxy of your own that adds it,
since a page must not hold the key (see [Connecting](sdk/connecting.md#prices)). A page without one
sends its orders through a relayer ([Gasless Trading](sdk/gasless.md)). Amounts are 18-decimal `bigint`s:
`parseUnits18("0.5")` is half a unit, `parseUnits18("2400")` is $2,400.

## A Map of These Docs

**Getting Started**

- [Installation](getting-started/installation.md): requirements, installing, TypeScript settings.
- [Quick Start: a Frontend](getting-started/quick-start-frontend.md): a plain web page from connect to
  a placed order.
- [Quick Start: a Bot](getting-started/quick-start-bot.md): a Node script with its own key.
- [Core Concepts](getting-started/concepts.md): the connection, prepared calls, units, prices, errors,
  what is cached. Read this before going further.

**The Keeper**: [what it does](keeper/overview.md), [setting one up](keeper/setup.md), its
[configuration](keeper/configuration.md), [jobs](keeper/jobs.md) and
[budgets](keeper/budgets.md), [running it in production](keeper/production.md), and
[the keeper as a library](keeper/library.md).

**Frontends & Bots**: [connecting](sdk/connecting.md), [markets](sdk/markets.md),
[accounts](sdk/accounts.md), [live prices](sdk/live-prices.md) and [live updates](sdk/live-updates.md);
[sending transactions](sdk/sending.md), [collateral and permits](sdk/collateral.md),
[placing](sdk/orders.md) and [managing](sdk/managing-orders.md) orders, [previews](sdk/previews.md) and
[errors](sdk/errors.md); [gasless trading](sdk/gasless.md) and [smart accounts](sdk/batching.md);
[history](sdk/history.md); [insurance](sdk/insurance.md), [termination](sdk/termination.md),
[listings](sdk/listings.md) and [governance](sdk/governance.md); [building a bot](sdk/bots.md) and the
[low-level building blocks](sdk/low-level.md).

**Reference**: the [API index](reference/api.md), [units and constants](reference/units.md),
[security notes for integrators](reference/security.md), and [development](reference/development.md)
of the packages themselves.
