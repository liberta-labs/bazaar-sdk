# Quick Start: a Bot

This walkthrough writes a Node script that trades with its own key: it connects over an RPC URL,
reads a market and its own account, tops up its collateral with a USDC permit, rests a post-only
limit order and cancels it. Transactions are signed in the script with a viem `WalletClient`; the SDK
builds and checks them, and never sees the key.

It is the skeleton every Bazaar bot starts from. [Building a Bot](../sdk/bots.md) goes further: live
prices, events, nonces, many orders at once.

## What You Need

- Node 20 or later, and a project with the SDK and viem installed
  ([Installation](installation.md)).
- A private key for the bot, holding ETH for gas (and the Pyth fee that order calls send) and USDC on
  the deployment's network.
- An RPC URL. Any JSON-RPC provider works; a key inside the URL (Alchemy's `/v2/<key>`, a `?key=`
  query) is never printed by the SDK.
- A Pyth Pro API key, for signed Pyth prices. A server may hold the key itself.
- Node 22 or later if the bot streams prices (the stream runs over the global `WebSocket`); on Node 20
  give the price client a WebSocket constructor, such as the `ws` package's.
- The deployment's factory address, from Bazaar's
  [deployments page](https://docs.bazaar.finance/reference/networks.html).

The script reads them from the environment:

```bash
RPC_URL=https://arb-sepolia.g.alchemy.com/v2/...
BAZAAR_FACTORY=0x...
PYTH_PRO_API_KEY=...
BOT_PRIVATE_KEY=0x...
MARKET=ETH/USD                # optional
```

Keep them in a `.env` file that is never committed, and load it with `node --env-file=.env` (Node
20.6+) or your process manager.

The complete script is `docs/examples/getting-started/bot.ts` in the SDK's repository, with the
wallet helper in `local-wallet.ts` beside it. Compile it with `tsc`, or run it with a TypeScript
runner.

## 1. The Key and the Environment

```ts
{{#include ../../examples/getting-started/bot.ts:setup}}
```

`privateKeyToAccount` makes a viem local account: it signs in this process, and nothing about the key
leaves it.

## 2. Connect

```ts
{{#include ../../examples/getting-started/bot.ts:connect}}
```

With a URL as its `transport`, the SDK reads through its own JSON-RPC client: 25 requests a second at
most, a 30-second timeout, and up to three retries with doubling delays on transient failures (never
on a send). `prices` holds the Pyth Pro token; on a server it can be the API key itself, sent as
`Authorization: Bearer <key>`. [Connecting](../sdk/connecting.md) has every option, and how to change
those defaults with a `JsonRpc` of your own.

The `WalletClient` is what signs and sends. It needs the chain object for the network
(`viem/chains` has Arbitrum One, Arbitrum Sepolia and Anvil); the script picks it from the chain id
the connection found.

## 3. Send a PreparedCall

Every write the SDK builds is a `PreparedCall` (`to`, `data`, `value`, `from`, `summary`, ...). The bot
sends each one the same way:

```ts
{{#include ../../examples/getting-started/bot.ts:send}}
```

- **Simulate first.** `bz.simulate(call)` runs the call as the bot with `eth_call` and, when it
  passes, estimates its gas. A revert comes back as `sim.error`: the contract's custom error, decoded,
  with a sentence saying what happened. Nothing is sent, and no gas is spent.
- **Then send with the WalletClient.** `toTransactionRequest(call)` gives viem's `to`, `data` and
  `value` (the ETH a call with a price update must send for Pyth's fee), and `account`, set to the
  call's `from` address. **Override `account` with the local account object.** viem treats an
  `account` given as a bare address as a JSON-RPC account and asks the node to sign with
  `eth_sendTransaction`, which a hosted RPC refuses; given the local account, it signs here and sends
  the raw transaction. Passing the simulation's gas estimate (with some headroom) saves viem a second
  estimate.
- **Wait for the receipt.** `bz.waitForReceipt(hash)` polls every 500 ms for up to two minutes and
  throws a `CallError` if the transaction reverted or never landed.

**Calls that carry a price.** Order creation, amendments, trigger executions and some withdrawals
attach a signed Pyth print, and the pair accepts a print at most 3 seconds from the block's time.
`sendPriced` builds such a call, and rebuilds it (twice at most) when the print it got is already
more than 2 seconds old; a bot signs locally, so the whole build, simulate, sign and send takes well
under a second after that. See [The 3-Second Price Window](../sdk/sending.md#the-3-second-price-window).

## 4. Read the Market and the Account

```ts
{{#include ../../examples/getting-started/bot.ts:read}}
```

`getMarket` accepts a label, a pair address or a pair id. `marketSnapshot` reads the market's state at
one block: its status, the pair's stored price and its age, funding, margin rates, open interest,
insurance, and flags such as `marketOrdersDisabled` with the reason for each. `accountSnapshot` reads
the bot's position, collateral, orders, what it can withdraw, its claimable fees and its wallet's USDC
balance (in USDC's own 6-decimal units, hence `fromUsdcUnits` before printing). The fields are on
[Markets](../sdk/markets.md) and [Accounts & Portfolios](../sdk/accounts.md).

## 5. Top Up Collateral With a Permit

Collateral is per market, and the market pulls it from the wallet, so the wallet must allow it. An
approval is a transaction of its own; a USDC permit (ERC-2612) is a signature the deposit carries
instead:

```ts
{{#include ../../examples/getting-started/bot.ts:deposit}}
```

`permits.signPermit` builds the permit's typed data and asks a *wallet* to sign it with
`eth_signTypedData_v4`, as it would ask a browser wallet. A viem `WalletClient` would forward that
request to the RPC node, which cannot sign, and the SDK has no local-key wallet of its own, so the bot
uses a few lines that answer the request with the local account:

```ts
{{#include ../../examples/getting-started/local-wallet.ts:local-wallet}}
```

The SDK checks every signature it gets back: it must recover to the signer, as a 65-byte low-`s`
ECDSA signature. The same helper signs gasless requests (`relay.signRelayed`); see
[Gasless Trading & Relayers](../sdk/gasless.md).

The permit covers `toUsdcUnitsCeil(amount)`: the deposit is in 18 decimals, USDC counts in 6, and a
permit must cover the pull rounded up. The minimum deposit is 5 USDC.

## 6. Place an Order and Cancel It

```ts
{{#include ../../examples/getting-started/bot.ts:order}}
```

`trade.livePairPrice` fetches the signed update and composes the price the pair itself will compute
from it (spot, and the confidence band). The order is a post-only limit 2% under it, so it rests in
the book as a maker; a post-only order that would cross is canceled instead of filling. Its size is
about $20 of notional (`size × price / 1e18`; the minimum is $5), and it expires in an hour of
Arbitrum blocks (`orders.blocksIn(3600)`, about four blocks a second).

The pair numbers orders itself; the new order's id is in the `OrderUpdated` event of the receipt,
which `live.decodeLiveLog` turns into a typed event (`payload.action` 0 is "created"). Canceling takes
a list of up to 200 ids. Every order option is on [Placing Orders](../sdk/orders.md), canceling and
amending on [Managing Orders](../sdk/managing-orders.md).

## 7. Run It

```ts
{{#include ../../examples/getting-started/bot.ts:main}}
```

A run prints the market and the account, then one line per transaction:

```text
ETH/USD is live: stored price 3012.41 (2 s old), funding 0.0012%/h, max leverage 20x
collateral 0 USDC, wallet 250 USDC, flat, 0 open orders
Deposit 50 USDC as collateral: 0x5c1d... (block 98211873)
Buy 0.006774722395125601 at 2952.16378 (limit, GTC, post-only): 0x8e02... (block 98211881)
order #4182 is resting
Cancel order #4182: 0x1f7a... (block 98211889)
...
```

(The figures are illustrative.) A summary prints every amount exactly, never rounded: it is what
the transaction does.

If anything fails, the script prints the error's name and message and exits with code 1. The SDK's
messages are written to be read: a refused input names its field, a decoded revert says what
happened, and a URL is printed with its key masked. A user-facing app shows `errorMessage(e)` instead
(see [Errors & Messages](../sdk/errors.md)).

## What Can Go Wrong

| Message | Why |
|---|---|
| `Error: set RPC_URL in the environment` | A variable is missing. |
| `ConnectError: 0x... does not answer as a Bazaar factory on chain 421614` | `BAZAAR_FACTORY` is wrong for this RPC's chain. |
| `HttpError: HTTP 401 from https://.../v2/***: the provider refused the request; check the key in the URL` | The RPC key is wrong. |
| `ProError: price endpoint refused the request (HTTP 401); check the token (prices.token) and that it covers these feeds and this channel` | The Pyth Pro key is wrong, missing, or not entitled to the market's feeds. |
| `CallError: Deposit 50 USDC as collateral: ...` | The simulation reverted; the rest of the message is the contract's reason (for example, the wallet holds less USDC than the deposit). |
| `CallError: Buy ...: This order needs $... of collateral ...` | Not enough collateral behind the order. |
| `InputError: orderType: You already have 32 open limit and stop-limit orders on this market, ...` | The SDK refused the order before building it. |
| A viem error from `eth_sendTransaction` (an unknown account, a method the provider does not serve) | `account` was left as the address from `toTransactionRequest`; pass the local account. |
| `CallError: transaction 0x... reverted` | It reverted on chain after a passing simulation: the state changed in between, or (for an order) its price print had gone stale. |

## Next

- [Core Concepts](concepts.md).
- [Building a Bot](../sdk/bots.md): live prices and events, nonce handling, quoting many orders.
- [Live Updates](../sdk/live-updates.md), to react to fills instead of polling.
- [Errors & Messages](../sdk/errors.md).
