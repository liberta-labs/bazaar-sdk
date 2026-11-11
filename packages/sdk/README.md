# @liberta-labs/bazaar-sdk

Everything a frontend, bot or service needs to integrate [Bazaar](https://github.com/liberta-labs/bazaar):
markets and accounts, live prices, every trading action (direct and gasless), USDC permits, history,
previews, user-facing errors, insurance, market termination and settlement, and listing new markets.
It runs in browsers and in Node, depends only on [viem](https://viem.sh), and never holds a user's key.

```bash
npm install @liberta-labs/bazaar-sdk
```

**Documentation:** [sdk-docs.bazaar.finance](https://sdk-docs.bazaar.finance): guides, examples and
the full API reference.

## Connect

```ts
import { Bazaar } from "@liberta-labs/bazaar-sdk";

const bz = await Bazaar.connect({
  transport: window.ethereum,     // any EIP-1193 provider (a wallet, a viem client) or an RPC URL
  factory: "0x...",               // the deployment, from the Bazaar docs' deployments page
  chainId: 42161,                 // optional: refuse any other chain
  prices: { token: pythToken },   // signed Pyth Pro updates for calls that need one: short-lived tokens from your backend
  subgraph: "https://...",        // optional: history
  integrator: "0xYourFrontend",   // optional: your referral fee address, set on every order you create
});
```

`bz.ctx` is the connection (chain, factory, lens, terminator, oracle, USDC). Every area below is on `bz`
with the connection bound (`bz.trade.createOrder(...)`); the same functions are exported per area for
use without the facade (`import { trade } from "@liberta-labs/bazaar-sdk"; trade.createOrder(ctx, ...)`),
along with the pure helpers (packing, formatting, type strings) that need no connection.

Do not put a Pyth API key in a browser bundle: point `prices` at a proxy you control, or at an endpoint
that needs no key.

## Read

```ts
const markets = await bz.markets.listMarkets();               // labels like "ETH/USD", cached
const eth = await bz.markets.getMarket("ETH/USD");            // label, address or pair id
const snap = await bz.markets.marketSnapshot(eth);            // prices, funding, margin, OI, insurance, status
snap.status;                                                  // live | adl | limbo | settling | terminated
snap.marketOrdersDisabled;                                    // also venueClosed, positionWithdrawalsFrozen, allWithdrawalsPaused
snap.reasons.marketOrdersDisabled;                            // ...each with the reason, for the UI
const book = await bz.markets.getBook(eth, 20);               // aggregated price levels, both sides

const me = await bz.account.accountSnapshot(eth, user);       // position, health at the live price, orders, max withdrawable, fees
const all = await bz.account.portfolio(user);                 // every market with collateral, a position, orders or fees

const prices = await bz.livePrices();                         // streamed composed prices, freshness, venue closed
const unsubscribe = prices.subscribe((changed) => render(changed)); // Map<market address, price>

const watch = bz.live.watchAccount(user, [eth], (u) => apply(u)); // events and refreshed snapshots, reorg-safe
await watch.ready;                                            // ... watch.stop() when the view unmounts
```

## Trade

Writes return a `PreparedCall` (`to`, `data`, `value`, `summary`, `pullsUsdc`, ...). Simulate it as the
user first: a revert comes back decoded, with a sentence for the user. Then send it with the wallet
(`bz.send`, or `toTransactionRequest(call)` for viem/wagmi).

```ts
import { OrderType, parseUnits18, errorMessage } from "@liberta-labs/bazaar-sdk";

await bz.trade.depositCollateral(eth.address, user, parseUnits18("100"));
const order = await bz.trade.createOrder(eth.address, user, {
  orderType: OrderType.StopLoss, isLong: false, size: parseUnits18("0.5"),
  triggerPrice: parseUnits18("1850"), bounty: parseUnits18("0.5"),   // what a keeper earns for firing it
});
const sim = await bz.simulate(order);
if (!sim.ok) showError(sim.error!.message);
else await bz.waitForReceipt(await bz.send(window.ethereum, order));
```

Also: `amendOrders` (reprice/resize up to 32 resting limits, best-effort flag), `cancelOrders` (up to 200),
`withdrawCollateral`, `claimFees`, and `executeTriggeredOrders` for a user's own zero-bounty stops.
`orders.buildOrderSpec` validates an order exactly as the contract does, so a UI can show errors as the
user types; `orders.checkOrderCaps` checks the per-user caps (32 active limits, one TP and one SL per
position).

**Prices.** Order paths carry a Pyth print at most 3 seconds older than the block. Build those calls as
late as possible, right before the wallet prompt (`buildAndSend`), and rebuild one whose `priceTime` is
more than a second or two old. Gasless calls avoid the problem: the relayer attaches the price.

## Gasless calls and permits

A user can sign instead of sending: the relayer submits, attaches a fresh price and book hints, and earns
up to $1 per call in USDC. A USDC permit rides along, so a user needs no ETH at all.

```ts
import { relay } from "@liberta-labs/bazaar-sdk";

const req = await bz.relay.signRelayed({ action: "createOrder", order: { ... } }, { wallet: window.ethereum, signer: user, pair: eth.address, relayerFee: parseUnits18("0.05") });
await fetch("https://your-relayer/submit", { method: "POST", body: relay.serializeRelayed(req) });

// On the relayer:
const check = await bz.relay.verifyRelayed(req);          // signer, deadline, nonce, fee cap, bounds, permit
const call = await bz.relay.encodeRelayed(req, { relayer }); // fresh price update and hints; send it at once
```

The deadline is at most 10 seconds after the chain's time: a relayer must submit immediately.
Signatures are checked with plain ECDSA on chain, so smart-contract wallets (ERC-1271) cannot sign
relayed calls; the SDK refuses them with a clear message. `permits.signPermit` and
`allowance.approveUsdc` cover direct calls; approvals are for the exact amount unless you ask for
unlimited explicitly.

## Preview, explain, history

- `bz.previews.previewOrder(pair, user, order)`: the resulting position, fees (insurance, integrator,
  bug-bounty split), the margin it needs, the estimated liquidation price, max leverage, and the reasons
  the contract would refuse it. `previewWithdrawal` gives the maximum and every freeze that applies.
- `errorMessage(e)` turns any failure (a decoded revert, a wallet rejection, an input error) into one
  sentence for the user. Every custom error the contracts declare has one.
- `bz.history.*`: trades and candles, orders and their events, positions, collateral transfers, fees,
  liquidations, ADL, insurance, terminations, proposals and votes, listings, from Bazaar's subgraph,
  paginated. `subgraphLag()` says how far behind the index is.

## Insurance

`depositToInsurance`, `requestInsuranceWithdrawal`, `executeInsuranceWithdrawal` (an exit on a live
market is a request, a lock, then a paying call), quotes at the live price, and `insuranceExitPlan`,
which tells the UI which step the LP is on and when the next call can land.

## Termination, settlement, governance, listings

Every builder that posts a bond, a seed or a levy returns its `costs` (amount, holder, when it comes
back, worst case), the exact `approvals` it needs, and plain-language `notes`.

- `bz.termination`: `terminationStatus` (one call: phase, cutoff, rule, proposals), UMA termination
  proposals (`proposeTermination`, `settleTerminationProposal`), insurer votes
  (`proposeInsurerTermination`, `voteForInsurerTermination`, `executeInsurerTermination`),
  `terminateStalePair`, `terminateScheduledPair` (fetches and checks the archived Pyth prints that prove
  the settlement price, under each settlement rule), `finalizeTermination`, `getTerminalEntitlement`.
- `bz.listings`: `proposePairDeployment` (bond and seed), settle, expire, `claimSeedRefund`, composites,
  and `openListings`: every listing proposal not yet resolved (in review, settleable or disputed),
  found through the subgraph, or the factory's logs from a `fromBlock` when there is none, and each
  read on chain.
- `bz.governance`: UMA identifier upgrades (propose, settle, expire, activate) and their timelock.
- `bz.uma`: assertion status, disputes (`disputeAssertion` with its bond approval), settlement, and a
  preview of a DVM ruling before anyone records it.

## Smart accounts

`batching.walletSendCallsRequest` (EIP-5792) and `batching.tradingAccountExecute` (Bazaar's example
trading account) run several prepared calls in one transaction; `shareOnePriceUpdate` keeps one Pyth
update per pair.

## Units

The pair takes and reports amounts in 18 decimals (1e18 = $1 or one unit) and floors cash to USDC's 6
decimals; USDC's own calls are in 6. `parseUnits18("12.5")`, `formatUnits18(x)`, `toUsdcUnits`,
`fromUsdcUnits`. Protocol quantities are `bigint`; times, blocks and counts are `number`.

## For integrators

- Render on-chain and subgraph strings (market descriptions, proposal reasons) as text, never as HTML.
- Simulate before asking for a signature, and show `call.summary` and every `cost` the user will pay.
- The contracts cannot tell who calls them: which users, regions and markets you serve is your decision
  and your responsibility (see Bazaar's integrator guide).
