# Quick Start: a Frontend

This walkthrough builds a working trading page with no framework: it connects the user's wallet,
lists Bazaar's markets with their prices and status, shows the user's position on one, deposits
collateral, and places a limit order, simulating every transaction before the wallet is asked to sign.
At the end the page follows the account live. It is one TypeScript file and one HTML file, about 200
lines in all.

You need a browser wallet (MetaMask, Rabby, ...) on Arbitrum Sepolia with a little ETH for gas and
some of the deployment's USDC, the deployment's factory address (Bazaar's
[deployments page](https://docs.bazaar.finance/reference/networks.html)), and a way for your page to
get Pyth Pro prices without holding the API key: an endpoint of your backend that mints short-lived
tokens from it (see [Connecting](../sdk/connecting.md#tokens-for-a-browser)).

## 1. Create the Page

```bash
npm create vite@latest bazaar-demo -- --template vanilla-ts
cd bazaar-demo
npm install @liberta-labs/bazaar-sdk viem
```

Until the SDK is on npm, install it from the repository instead, as in
[Installation](installation.md#installing-the-sdk).

Replace `index.html` with a page that has a few named elements:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Bazaar demo</title>
  </head>
  <body>
    <button id="connect">Connect wallet</button>
    <select id="market"></select>
    <pre id="position"></pre>

    <form id="deposit">
      <input name="amount" placeholder="USDC to deposit" />
      <button>Deposit</button>
    </form>

    <form id="order">
      <select name="side"><option value="buy">Buy</option><option value="sell">Sell</option></select>
      <input name="size" placeholder="Size" />
      <input name="price" placeholder="Limit price" />
      <button>Place limit order</button>
    </form>

    <p id="status"></p>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

Everything below goes into `src/main.ts`, in the order shown (delete what Vite put there). The
complete file is `docs/examples/getting-started/frontend.ts` in the SDK's repository.

## 2. Configure

```ts
{{#include ../../examples/getting-started/frontend.ts:config}}
```

The SDK reads everything else (the lens, the terminator, the oracle, USDC, the markets and their
feeds) from the factory. The price endpoint serves the signed Pyth updates that order calls carry and
the feed symbols the market list labels markets with; never put a Pyth API key in code a browser
downloads.

## 3. Two Helpers

```ts
{{#include ../../examples/getting-started/frontend.ts:helpers}}
```

`errorMessage(e)` turns whatever a step throws (a decoded contract revert, a wallet rejection, an
input the SDK refused) into one sentence for the user. Inputs are parsed with `parseUnits18`, which
throws a `UnitError` for anything that is not a plain decimal number; the helper words that one
itself. Text from the chain or the subgraph (market descriptions, for one) is untrusted: the page only
ever sets `textContent`.

## 4. Connect

```ts
{{#include ../../examples/getting-started/frontend.ts:connect}}
```

`eth_requestAccounts` asks the wallet for the user's address. `wallet_switchEthereumChain` moves the
wallet to the right network (it fails with error 4902 when the wallet does not know the chain; add it
first with `wallet_addEthereumChain`). `Bazaar.connect` then reads the deployment's wiring from the
factory in one batched call and checks the chain: with `chainId` set, it throws a `ConnectError` on
any other. The result, `bz`, carries every area of the SDK with this connection bound
(`bz.markets`, `bz.account`, `bz.trade`, ...). All options are on [Connecting](../sdk/connecting.md).

## 5. List the Markets

```ts
{{#include ../../examples/getting-started/frontend.ts:markets}}
```

`listMarkets()` returns every market the factory has deployed, in the factory's order, with its
static facts: `label` ("ETH/USD", from the feed's Pyth symbol), `address`, `hours` ("24/7" or
"trading-hours"), its feeds. It is cached on the connection, so later calls cost nothing.
`marketSnapshots(list)` reads every market's live state at one block in two batched calls; here the
page shows the pair's stored price and its status (`live`, `adl`, `limbo`, `settling`,
`terminated`). Every field is on [Markets](../sdk/markets.md).

## 6. Show the Position

```ts
{{#include ../../examples/getting-started/frontend.ts:position}}
```

`accountSnapshot(market, user)` reads the user's position on one market and values it at the live
price: the position bucket (`size`, `entryPrice`, `collateral`), `health` (PnL, equity, the margin
ratio, below 1 of which anyone may liquidate), the live orders, `maxWithdrawable`, and
`withdrawalBlocked`, the reason a withdrawal would be refused right now. Amounts are 18-decimal
`bigint`s; `formatUnits18(x, 2)` prints one with two decimals. Every field is on
[Accounts & Portfolios](../sdk/accounts.md).

## 7. Simulate, Then Send

Every write the SDK builds is a `PreparedCall`: a target, calldata, an ETH value, the account it acts
for and a one-line `summary`. The page runs each one through the same function:

```ts
{{#include ../../examples/getting-started/frontend.ts:send}}
```

`bz.simulate(call)` runs the call as the user with `eth_call` and estimates its gas. If it would
revert, the revert comes back decoded (`sim.error.name` is the contract's custom error, and
`sim.error.message` a sentence for the user), and the wallet is never asked. Otherwise `bz.send`
hands the call to the wallet (`eth_sendTransaction`), and `bz.waitForReceipt` polls for the receipt,
throwing a `CallError` if the transaction reverted after all. See
[Sending Transactions](../sdk/sending.md).

## 8. Deposit Collateral

Collateral is per market: each market (each pair contract) holds its own, and pulls the USDC from the
wallet itself, so the wallet must allow that pair to take it.

```ts
{{#include ../../examples/getting-started/frontend.ts:deposit}}
```

`usdcFunding` reads the wallet's USDC balance and its allowance to the pair, and says how much to
approve (`approveUsdc`, in USDC's own 6-decimal units). `approveUsdc` builds an approval for exactly
that amount; `depositCollateral` then builds the deposit (at least 5 USDC). A deposit can instead
carry a USDC permit, a signature in place of the approval transaction: see
[Collateral, Approvals & Permits](../sdk/collateral.md).

## 9. Place a Limit Order

```ts
{{#include ../../examples/getting-started/frontend.ts:order}}
```

`createOrder` checks the order exactly as the pair will (a size and price, a limit within 50% of the
market price, at least $5 of notional, an expiry at least about a minute away, the per-user order
caps) and throws an `InputError` naming the field otherwise. It then finds the order's place in the
book and attaches a fresh signed Pyth price, which every order call carries.

That price is the catch: the pair accepts a print at most 3 seconds from the block's time. The page
builds the call right before the wallet prompt and rebuilds it if simulating took long enough that the
print is more than 2 seconds old (`call.priceTime` is its publish time). A user who takes longer than
that to approve in the wallet can still see the transaction revert on a quiet market; on an active
one, another trade has usually refreshed the pair's price within the window. Production apps either
offer a retry with a freshly built call or trade gasless, where the relayer attaches the price when it
submits ([Gasless Trading & Relayers](../sdk/gasless.md)). The details are in
[The 3-Second Price Window](../sdk/sending.md#the-3-second-price-window).

`expirationBlock` counts Arbitrum blocks, about four a second: `orders.blocksIn(seconds)` converts.
Every option of every order type is on [Placing Orders](../sdk/orders.md).

## 10. Wire the Buttons

```ts
{{#include ../../examples/getting-started/frontend.ts:wire}}
```

## 11. Keep It Current

```ts
{{#include ../../examples/getting-started/frontend.ts:watch}}
```

`watchAccount` follows the chain (on new-head notifications where the wallet's provider pushes them,
otherwise polling the head about once a second) and delivers the
account's own events and a refreshed `AccountSnapshot` for each market an event touched, plus one
every 15 seconds as funding accrues and clocks run. The page re-renders from the snapshot it is handed,
with no read of its own. See [Live Updates](../sdk/live-updates.md).

## 12. Run It

```bash
npm run dev
```

Open the page, connect, deposit 20 USDC, and place a buy a little under the market price. The order
appears in the position view as soon as the transaction lands.

## What Can Go Wrong

| What the user sees | Why |
|---|---|
| "You rejected the request in your wallet." | The user declined a prompt (EIP-1193 error 4001). |
| "This network has not been added to your wallet yet. Add it and try again." | `wallet_switchEthereumChain` failed with 4902. |
| "Something went wrong. Please try again." on connect | A `ConnectError`: the wallet is on another chain, or `FACTORY` is not a Bazaar factory on this chain. Log `e.message` for which. |
| "Something went wrong..." on the first market list | The price endpoint or the RPC could not be reached (labels fall back to short addresses when only the feed metadata fails). |
| A sentence naming a field, such as "limitPrice: A limit price must be within 50% of the market price: ..." | An `InputError`: the SDK refused the order before building it. |
| "This order needs $... of collateral ..." | The simulation reverted: not enough collateral for the order's margin. Deposit first. |
| The order's transaction reverts on chain | The attached price was more than 3 seconds old when it landed (a slow wallet confirmation on a quiet market). Build and send it again. |

## Next

- [Core Concepts](concepts.md): what is behind each step above.
- [Live Prices](../sdk/live-prices.md), to show a streaming price next to each market.
- [Previews](../sdk/previews.md), to show the fees, margin and liquidation price of an order before
  it is placed.
- [Managing Orders](../sdk/managing-orders.md), to amend and cancel.
