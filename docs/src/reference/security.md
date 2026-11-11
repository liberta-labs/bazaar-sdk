# Security Notes for Integrators

What a frontend, a relayer, a bot or a keeper operator has to do to use the SDK safely, and what the
SDK already does for you. Bazaar's contracts have no owner, no pauser and no allowlist: whatever an
interface puts in front of a user is the interface's responsibility. The SDK is built so that the safe
path is the default one, but several duties stay with you, and this page lists them.

The short version:

1. Simulate every call as the user before asking for a signature, and show what it does and costs.
2. Approve exact amounts. Never default to an unlimited approval.
3. Render every string that comes from the chain or the subgraph as text, never as HTML.
4. Let the SDK check every market address; never build a call for a pair from a link by hand.
5. Keep API keys out of the browser: put a proxy you control in front of keyed endpoints.
6. Do not override the clock-skew check; tell the user to fix their clock or RPC instead.
7. Know which calls a smart-contract wallet can make (direct ones) and which it cannot (gasless ones).
8. Keep keeper keys in `.env` or a keystore, in a directory only the keeper's user can read.

## What the SDK Never Does

- **It never holds a user's key.** Every write is a `PreparedCall` (`to`, `data`, `value`, `summary`,
  and the rest) that your wallet stack sends, and every signature (a gasless request, a USDC permit) is
  requested from the user's wallet with `eth_signTypedData_v4`, so the wallet shows every field it signs.
  See [Sending Transactions](../sdk/sending.md).
- **It never assumes an approval exists.** A call that pulls tokens reports how much (`pullsUsdc`, or a
  costed call's `approvals`), and the approvals it builds are for the exact amount.
- **It never prints a raw URL or a token.** Errors from `JsonRpc`, `ProClient`, `SubgraphClient` and the
  history queries carry the endpoint through `redactUrl`, which keeps only the parts of a URL known to
  be public and masks the rest (an Alchemy `/v2/<key>`, a `?key=` query, `user:password@`). See
  [Low-Level Building Blocks](../sdk/low-level.md#urls).

## Simulate Before Signing

Run every call through `bz.simulate(call)` as the user before the wallet opens. A call that would
revert comes back with `ok: false` and a decoded `error` whose `message` is a sentence for the user
(every custom error the contracts declare has one; see [Errors & Messages](../sdk/errors.md)). Nothing
has been signed or sent at that point, so the user loses nothing.

Simulation is not a guarantee: the chain can move between the simulation and the block the transaction
lands in. Two cases need care:

- **Calls that carry a price.** The pair refuses a Pyth print more than 3 seconds from the block's time.
  A `PreparedCall` that carries one has `priceTime`; build it as late as possible (`buildAndSend`), and
  rebuild one whose `priceTime` is more than a second or two old. See
  [Sending Transactions](../sdk/sending.md).
- **A step that depends on an earlier one.** A deposit cannot be simulated until the approval it needs
  has landed: simulate each step right before you send it, as below.

## Show What It Does and Costs

Show `call.summary` (one line written by the SDK from the call's own arguments, such as "Deposit 100
USDC as collateral") on the confirmation screen, with the exact amounts the call moves:

- `pullsUsdc`: the USDC the call takes from the wallet (18 decimals). `allowance.usdcFunding` turns it
  into what the wallet holds, what it has approved, and what to approve.
- `value`: the ETH the call sends, which is the Pyth update fee when a price update is attached.
- For the calls that post a bond, a seed or a levy (termination, insurer votes, listings, identifier
  upgrades, disputes), the `CostedCall` fields: `costs` (each amount, who holds it, when it comes back,
  and whether it is a worst case), `approvals` (to send first), `requires` (preconditions in words) and
  `notes`. Show all four. See [Termination & Settlement](../sdk/termination.md) for the shape.

```ts
{{#include ../../examples/reference/security.ts:costed}}
```

A bond is real money at risk: a disputed listing or termination claim that loses forfeits it. Do not
hide `costs` behind a "details" link.

## Approve Exact Amounts

`allowance.approveUsdc(owner, pair, amountUsdc)` approves exactly `amountUsdc`. An unlimited approval
(`{ unlimited: true }`) leaves the whole wallet balance pullable by that contract for as long as the
approval stands; offer it only as the user's explicit choice, say what it means, and let them revoke it
(`approveUsdc(owner, pair, 0n)`). The costed builders' `approvals` are always for the exact amount, and
when the wallet already allows the spender more than the quote, the call's `notes` say so: the
contract takes what it charges when the call runs, up to that allowance.

A USDC permit (`permits.signPermit`) is the alternative to an approval: it rides inside the call, covers
one amount, and expires (30 minutes after it is signed by default).

The whole flow, with the market from a link, the exact approval, and simulation before each send:

```ts
{{#include ../../examples/reference/security.ts:confirm}}
```

This assumes `bz` connected as in [Connecting](../sdk/connecting.md), `user` the wallet's account and
`market` resolved as in the next section. See
[Collateral, Approvals & Permits](../sdk/collateral.md) for the functions.

## The Pair Check

A market address reaches a frontend from a link, a query string, a subgraph row or a cached list, so it
is untrusted. A builder that took it on faith would show "Deposit 1000 USDC" for a call to any
contract, approve that contract as a USDC spender, or have the user sign a permit or a gasless request
for it.

The SDK checks every pair a write names before anything is built or signed:

- The trading, collateral, insurance, approval, permit and gasless builders call `requirePair`, which
  asks the deployment's factory (`factory.isPair`) and throws `InputError` on `pair` for anything else.
  The answer is cached per connection; a refusal is not, so a market listed later is asked again.
- The termination builders that name a pair check it with the terminator's own `isPair`.
- A relayer's `verifyRelayed` checks the request's pair the same way before reading anything else from
  it.

`finalizeTermination` is the exception: it reads the pair directly and does not ask the factory, so pass
it a market from `listMarkets` or `getMarket`, not an address from a link.

Resolve a market from a link through `getMarket`, which only ever returns one of the factory's own
markets:

```ts
{{#include ../../examples/reference/security.ts:pair}}
```

Market labels ("ETH/USD") come from the Pyth symbols of the market's feeds, never from the subgraph's
description, which is unverified and could name another market. A label is not unique either: a market
relisted after a termination keeps its label. Use the address as the identity, the label for display.

Connect with `chainId` set to the chain you expect (`Bazaar.connect({ ..., chainId: 42161 })`): the
connection then fails on any other chain instead of reading another network's contracts.

## Render Strings as Text

Market descriptions, termination reasons and every other string from the chain or the subgraph are
user input. Put them into the page as text (`textContent`, or your framework's default escaping),
never as HTML (`innerHTML`, `dangerouslySetInnerHTML`, `v-html`).

```ts
{{#include ../../examples/reference/security.ts:text}}
```

The contracts restrict these strings: a listing description is 1 to 200 bytes of letters, digits,
space and `. , & / -`, and a termination reason 1 to 1,000 bytes of letters, digits, space and
`. , & / - : ? = # % _ ~ +` (`listings.descriptionProblem`, `termination.reasonProblem`). That keeps
them from forging the claim text UMA's voters read, but it is not HTML escaping, and the subgraph's copy
is not checked against the chain at all. The SDK keeps a subgraph description only when it passes the
factory's own rule, as decoration; treat it as such.

## Keep API Keys Off the Browser

Anything in a browser bundle is public. A Pyth Pro API key, a subgraph gateway key or a keyed RPC
URL in frontend code is a key you have published.

- **Prices.** Give `prices` short-lived tokens your backend mints from the API key
  ([Connecting](../sdk/connecting.md#tokens-for-a-browser) has the endpoint and the page's side), or
  leave prices out and send orders through a relayer that attaches the update. A token expires within
  15 minutes; the key never leaves your server.
- **Whose prices.** Every price is read from Pyth's signed update, and a connection refuses updates
  not signed by a signer the deployment's Pyth verifier trusts, so a compromised endpoint or proxy can
  withhold prices but cannot make the page show, or a call carry, one Pyth did not sign.
- **Subgraph.** The same applies to `subgraph: { url, apiKey }`: in a browser, use a gateway key
  restricted to your domain, or a proxy.
- **RPC.** In a browser, use the user's wallet as the transport (`transport: window.ethereum`), or an
  RPC URL meant to be public.

On a server the keys are fine, and the SDK keeps them out of its errors (see above). The keeper's config
refuses them in its YAML (see [Keeper Keys](#keeper-keys) below).

The prints a price endpoint serves are not trusted either: the SDK reads each price from the signed
update bytes themselves (what the chain verifies), never from the endpoint's JSON, and a live view
ignores prints dated more than `priceFeeds.BROWSER_FUTURE_SKEW` (120) seconds ahead of the device's
clock.

## The Clock-Skew Check

Gasless requests and USDC permits carry a deadline. The SDK counts every deadline it signs from the
lower of two clocks: the latest block's timestamp as the RPC reports it, and this device's clock. If
the two differ by more than `signing.MAX_CLOCK_SKEW` (120 seconds), it refuses to sign and throws
`signing.ClockSkewError`. An RPC that reported a block far in the future would otherwise have the user
sign a request or a permit that stays valid long after they meant it to, a signature someone could
store and use later.

Show the error's own message, which tells the user to set their clock to update automatically or to use
another RPC. `errorMessage(e)` returns a generic sentence for this error, so check for it first:

```ts
{{#include ../../examples/reference/security.ts:skew}}
```

Local development chains (chain ids 31337 and 1337, `signing.DEV_CHAIN_IDS`) are exempt, since tests
move their clocks; a signature made for one is void on every public chain, because the chain id is part
of every domain the SDK signs under.

## Smart-Contract Wallets and Gasless Calls

The pair verifies relayed calls with plain ECDSA: it acts for whatever address the signature recovers
to. A smart-contract wallet (a Safe, an ERC-4337 account) that signs through ERC-1271 produces a
signature that recovers to some other address, so the SDK refuses it: `signing.signTypedDataV4`
recovers every signature locally and throws `SigningError` when it does not recover to the signer. The
same check covers USDC permits, which the pair also decodes as `(v, r, s)`.

So a smart-contract wallet:

- sends **direct** calls (it pays gas itself), with an approval instead of a permit;
- can batch several calls into one transaction through `wallet_sendCalls` (EIP-5792) or Bazaar's
  example trading account; see [Smart Accounts & Batching](../sdk/batching.md);
- cannot sign **gasless** requests.

Detect this before you offer a gasless flow, or catch the `SigningError` and fall back to a direct call.

### For Relayers

A relayer receives signed requests from the network, so it treats every field as untrusted.
`relay.parseRelayed` checks the body's types and shapes and canonicalizes the signature;
`relay.verifyRelayed` checks the pair, the chain id, that the signature recovers to the signer over
exactly these fields, the deadline (ahead, and no more than 10 seconds out by chain time), the nonce,
the fee cap and the action's own bounds, and the permit (as a warning: the pair executes a permit
best-effort and falls back to the existing allowance). Submit only a request whose check is `ok`, and
submit it at once: the deadline is seconds away. `relay.encodeRelayed` attaches a fresh price update
whose Pyth fee the relayer pays. See [Gasless Trading & Relayers](../sdk/gasless.md).

## UMA Oracles

The dispute, settlement and status functions find the oracle an assertion was made on themselves. An
`oo` option, when given, must be Bazaar's own Optimistic Oracle or the one the assertion was recorded
on, or the call throws `InputError` on `oo`. `uma.previewSettlementOn` skips that check: never pass it
an oracle address a user typed. See [UMA Disputes & Governance](../sdk/governance.md).

## Keeper Keys

A keeper holds a hot key: it signs and sends transactions unattended. The keeper package is built to
keep that key out of files you might share:

- **Secrets live only in `.env`.** The config loader refuses a private key, password, mnemonic phrase,
  API key, bot token or webhook written into the YAML (the keys in `SECRET_KEYS`), as the default of a
  `${NAME:-default}`, in a `prices.headers` value, or inside a URL (Alchemy's `/v2/<key>`, a `?key=`
  query). Write `${NAME}` and put the value in `.env`. `bazaar keeper init` writes `.env` owner-only.
- **Prefer a keystore.** `bazaar wallet new` writes an encrypted v3 keystore with owner-only
  permissions where the OS has them, and refuses to overwrite an existing file. The keystore password
  can be prompted for at start, or stored in `.env` for an unattended keeper. A `remote` signer (any
  service that answers `eth_signTransaction`, such as Web3Signer or a KMS bridge) keeps the key out of
  the keeper's process entirely.
- **Nothing prints a key.** Keys, passwords and phrases never appear in an error or a log line; a remote
  signer's URL appears only redacted.
- **Run it as its own user.** The repository's `Dockerfile` runs the keeper as an unprivileged user
  that owns nothing but the mounted config directory. Outside Docker, give the keeper's directory to a
  user that runs nothing else.
- **Fund it for gas only.** The keeper wallet needs ETH for gas; its earnings accrue on the pairs and
  `collect` can forward them elsewhere (`forwardTo`). `budget.maxSpendUsdPerDay` and
  `budget.maxSpendEthPerDay` cap what it can spend in a day whatever the price feeds say.

The `.gitignore` excludes `.env`, `bazaar-keeper.yaml`, `/keys/` and `/state/`; keep it that way in your
own deployment repository. See [Wallets & Secrets](../keeper/wallets.md) and
[Running in Production](../keeper/production.md).

The local price server (`bazaar mock-prices`, for Anvil) accepts a price change (`POST /mock/price`)
only as JSON whose Host names this machine and that no web page on another origin sent, so a site open
in a browser cannot set its prices; its Pyth Pro routes change nothing. It signs every update with the
public test key, which only a local chain's mock verifier trusts (the deployment script refuses such a
verifier anywhere but chain id 31337), so its prices verify nowhere else. It is for local testing only.

## Your Users, Your Jurisdiction

The contracts cannot tell who calls them. Which users, regions and markets you serve, and how you
enforce that, is your decision and your responsibility. Read Bazaar's
[integrator guide](https://docs.bazaar.finance/guide/integrators.html) before you launch.

## What Can Go Wrong

| What the user sees | What it means |
|---|---|
| `InputError` on `pair`: "... is not a market of this Bazaar deployment" | The address is not one of the factory's pairs. Check the link; nothing was built or signed. |
| `ConnectError`: "connected to chain ..., expected ..." | The wallet or RPC is on another chain than `chainId`. Ask the user to switch networks. |
| `signing.ClockSkewError` | The RPC's time and the device's clock differ by more than 120 seconds. Nothing was signed. |
| `signing.SigningError`: "this wallet does not sign as a plain account" | A smart-contract wallet tried a gasless request or a permit. Use a direct call and an approval. |
| A costed call's `notes` warn of a larger allowance | The wallet already allows the spender more than the quote. Approve the exact amount first to cap it. |
| `uma.BondQuoteError` | A bond read from the chain is below the contract's own floor (an RPC answering 0). Nothing was built; try another RPC. |
| `ConfigError` naming a key in the YAML | The keeper refused a secret written into its config file. Move it to `.env`. |

## Related Pages

- [Sending Transactions](../sdk/sending.md): simulation, the price window, sending.
- [Collateral, Approvals & Permits](../sdk/collateral.md): exact approvals and permits.
- [Gasless Trading & Relayers](../sdk/gasless.md): signing and relaying.
- [Termination & Settlement](../sdk/termination.md): the `CostedCall` shape.
- [Errors & Messages](../sdk/errors.md): what to show for each error.
- [Wallets & Secrets](../keeper/wallets.md): keeper keys.
