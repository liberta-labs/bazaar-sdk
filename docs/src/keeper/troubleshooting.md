# Troubleshooting

What each `doctor` failure and each common warning means, and how to fix it. Messages are quoted as
the keeper prints them; `…` stands for the part that varies. Run `bazaar keeper doctor` first: it checks
everything `start` relies on and names the failing piece. Add `--debug` before the command
(`bazaar --debug keeper start`) for a full stack trace.

## The Config

**`no config at /home/me/keeper/bazaar-keeper.yaml; run bazaar keeper init to create one`**
No file at the path. Run `bazaar keeper init`, pass `-c <path>`, or run from the config's directory.

**`the config is not valid:` followed by one line per problem**
The schema refused something. Each line names the key: `Unrecognized key(s) in object: 'chunk'` is a
typo (unknown keys are always refused), `a keystore wallet needs path` a missing field, `Expected
number, received string` a value of the wrong type. Every key is in [Configuration
Reference](configuration.md).

**`… has no official factory address in this release yet; set factory to the deployment you want to keep`**
No network preset carries an official factory address yet. Add `factory: "0x…"` (quoted).

**`a custom network needs chainId and factory`**
`network: custom` needs both.

**`… holds a secret written into the file (a ${NAME:-default} default counts) …`**
A key, password, phrase, API key, bot token or Discord webhook is written into the YAML. Put the value
in `.env` and write `${NAME}` ([the secrets rules](wallets.md#the-secrets-rules)).

**`rpc.http is a URL with a key in its path, written into the file …`**
The URL may carry a credential. Put the whole URL in `.env` (`http: ${RPC_HTTP_URL}`), or only the key
(`https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`). (The printed suggestion may show the key
part masked; write `${NAME}` there.) The same applies to `subgraph.url`, `prices.endpoint`,
`alerts.webhook.url` and a remote signer's `url`.

**`prices.headers.X-Api-Key holds a value written into the file …`**
Header values must be `${NAME}`, or a scheme and a reference: `Bearer ${NAME}`.

**`rpc.http: environment variable RPC_HTTP_URL is not set (add it to .env or export it)`**
The `.env` beside the config lacks the variable, or the keeper runs from a service whose environment
does not have it. Check the `.env` is next to the config file (not the current directory).

**`… is not valid YAML: …`**
Often a `${NAME}` inside a flow mapping (`{ botToken: ${TG_BOT_TOKEN} }`): write the mapping in block
style, one key per line. Or an unquoted value starting with a YAML indicator.

**`job liquidation uses wallet 'fast', which is not under wallets`**
Add the wallet under `wallets`, or change the job's `wallet`.

**A job does not run, and nothing says why**
A job key with nothing under it (`liquidation:`) is null, which turns the job off. Write
`liquidation: {}`. `doctor`'s `Jobs` line lists the jobs that are on.

**`prices.endpoint: the 'bazaar' price endpoint has no URLs yet; …`**
`bazaar` is the default endpoint, and it does not exist yet. Set `prices.endpoint: pyth` with your own
Pyth Pro access token in `prices.token`, or the URL of a Pyth Pro compatible service.

**`prices.apiKey is not a setting: the Pyth Pro access token goes in prices.token (a Pyth Core or Hermes key does not work), and prices.endpoint must be pyth or the URL of a Pyth Pro compatible service`**
A config written for Pyth Core. It is reported before any `${NAME}` is filled, so an old variable
that is gone from `.env` does not hide it. Replace `apiKey` with `token: ${PYTH_PRO_TOKEN}` (a Pyth
Pro access token, in `.env`), and set `prices.endpoint` to `pyth` or a Pyth Pro compatible URL.

**`prices.endpoint names a Hermes (Pyth Core) service, and the keeper sends its Pyth Pro token wherever prices are asked for: …`**
(Or `prices.restUrl`, `prices.streamUrls`.) An endpoint left from a Pyth Core setup: the keeper would
send its Pyth Pro token there. Set `prices.endpoint` to `pyth`, or to the URL of a Pyth Pro
compatible service.

**`prices: the price token (prices.token) holds a line break or another character a request header cannot carry: re-enter it`**
The token in `.env` was pasted with something around it. Paste it again, on one line.

**`rpc.send is 'sequencer', but arbitrum-sepolia has no sequencer endpoint preset`**
Only Arbitrum One has one. Remove `rpc.send`, or give a URL.

## The RPC

**`✘ RPC … unreachable: …`**
The URL is wrong, the provider is down, or the key is invalid. The printed URL is masked; check the
value in `.env`.

**`✘ RPC chain 1, but network arbitrum-one is chain 42161`**
(`start`: `the RPC is on chain 1, but network arbitrum-one is chain 42161`.) The URL is for another
chain. Use the network's URL, or fix `network`.

**`⚠ RPC … no eth_call state overrides: rewards cannot be measured before sending, so paid jobs will skip`**
The node refused (or ignored) an `eth_call` with a state override, which the keeper needs to place its
probe contract and measure rewards. The keeper still runs: calls are simulated directly, reverts are
still caught, but every reward reads as 0, so paid calls fail the profit rule and only unpaid duties
and jobs with `allowLoss` send. Use a provider whose `eth_call` accepts the state-override parameter
(Arbitrum Nitro nodes do; some gateways strip it), and run `doctor` again.

**`could not find the factory's deployment block (…). Set startBlock in the config …`**
A first start without a subgraph needs the factory's deployment block, and the RPC could not answer
historical `eth_getCode` reads (`the node may not keep historical state`). Set `startBlock` to the
block the factory was deployed in (a block explorer shows it), use an RPC that keeps historical state,
or configure a subgraph.

**`the node refused logs for 2000 blocks (…); asking for 1000 at a time. A lower rpc.logChunk avoids the refused requests`**
Logged at info level, once per scan. The provider caps `eth_getLogs` ranges or results. The keeper
halves the range until the node accepts it (down to one block) and widens it again after eight
successes, so it keeps working; set `rpc.logChunk` to what your provider allows (often 500 to 10,000
blocks) to skip the refused requests.

**`engine step failed: …`** (at most every 30 s)
A tick failed: often a rate limit (HTTP 429) or a timeout. The next tick resumes where it stopped.
Persistent: lower `rpc.maxRequestsPerSecond`, raise `engine.idleRefreshSeconds`, or use a faster
plan.

**`chain reorganized below block …; re-reading the last 64 blocks`**
The stored head's hash changed. Nothing to do: the keeper rewinds and re-applies.

## The Factory

**`✘ Factory 0x…: …`**
The factory cannot be read: the address is wrong, has no code on this chain, or is not a Bazaar
factory. Check the address against the deployment and the network.

**`✘ Wiring the lens belongs to a different factory`** (or `the terminator …`, `… does not report a factory`)
(`start`: `refusing to start: …`.) The factory points at a lens or terminator that does not point back
at it. That is not a deployment the keeper will keep; check you have the right factory.

**`factory 0x… is not an official deployment`** (a warning)
The factory is not a network preset's official one. At present no preset has one, so every deployment
shows this. It changes nothing in how the keeper runs.

## The Subgraph

**`✔ Subgraph synced to block … (N blocks behind)`**
A lagging subgraph is harmless: the keeper bootstraps from the subgraph's own block and replays the
chain's logs from there, and every decision is made from chain state. A very large lag only makes the
first replay longer.

**`⚠ Subgraph … with indexing errors`** (`start`: `the subgraph reports indexing errors; chain reads will correct what it misses`)
The subgraph may be missing accounts or orders. The keeper uses what it has and re-reads every
candidate from the chain; to be complete, configure a healthy subgraph or `subgraph.url: none`.

**`✘ Subgraph …; the keeper falls back to chain logs`** (`start`: `subgraph unavailable (…); indexing from chain logs instead`)
The subgraph cannot be reached or returned something unusable. A first start indexes from logs
instead (which needs `startBlock` or historical state); later starts do not use the subgraph.

## Prices

**`✘ Prices …`**
The price endpoint failed: a bad or missing token (`prices.token`; `price endpoint refused the request
(HTTP 401)` or `403`), a wrong URL, or a service down. A token that does not cover a feed or the
channel can be refused the same way.

**`⚠ Prices the fixed_rate@200ms stream is not delivering (…): the keeper would poll the request API every 1 s instead`**
The request API answered but the WebSocket stream did not: a stream URL is wrong (`prices.streamUrls`),
a proxy or firewall blocks WebSockets, or the token is refused on the stream. The keeper still runs on
polls, a step behind the stream.

**`price stream refused the subscription for feed(s) N on …`**, or **`price stream left out feeds it does not serve on …`**
Pyth does not serve those feeds on the configured channel (`prices.channel`) for your token: a feed
whose fastest channel is slower than the one asked for, or a feed the token does not cover. Choose a
slower channel, or ask Pyth. Other feeds are unaffected.

**`price stream went quiet: no new update for 10 s`**
No endpoint brought a new update for `prices.streamIdleTimeoutSeconds`: every fixed-rate channel sends
one per interval whether or not a price changed, so the connections are dropped and reconnected.

**`a price update is signed by 0x…, which is not a signer Pyth's verifier trusts: refusing it`**
With `prices.checkSigners` on, the keeper asks the deployment's verifier whether it trusts each
update's signer, drops the stream endpoint that sent one it does not (it reconnects later), and
refuses a request API response that carries one. An endpoint that is not Pyth's (a proxy, a local
mock) must pass Pyth's signed bytes through unchanged.

**`prices.checkSigners is off: price updates are used whoever signed them. …`**
At start, and in `doctor`'s `Prices` lines. Without the check, a forged update fails only on chain, and
the ETH/USD print that prices gas reaches no contract. Turn it back on unless the keeper cannot keep
up with the stream.

**`⚠ Prices N/M markets have a print`**, or at runtime **`price endpoint sent no print for feed 0x…: markets on it get no price until it does …`**
The endpoint serves no print for some markets' feeds: it does not carry that feed, the token does not
cover it, Pyth has no price or no confidence for it (the oracle refuses a price without one, so the
keeper never attaches it), or the feed is closed (a market with trading hours outside them). Markets on it get no fresh price: liquidation still
works from a stored price up to 9.5 minutes old, other price-driven jobs wait. Check the endpoint
serves the feed.

**`… not fresh right now (AAPL/USD, …)`**
Those markets have a print, but not one recent enough to send: usually a session market outside its
hours. Normal.

**`price endpoint: …`** (repeated), and `status` shows **`prices down: …`**
The stream or the polls are failing. After three failures in a row prices are marked unhealthy and a
stream falls back to polling for a minute, then tries the stream again. Calls that need a fresh print
wait. Fix the endpoint; the keeper recovers on its own.

**`ignored a print for feed 0x… dated N s ahead of the clock …`**
The endpoint's print is in the future relative to the chain's clock: the endpoint is wrong, or (on a
local chain) the clock was moved backwards. Prints more than 5 s ahead are ignored.

**`⚠ Prices no fresh, plausible ETH/USD print: gas is priced at the $3000 fallback (never below gas.ethUsdFloor, $1000)`**
The endpoint serves no ETH/USD print, or one older than `gas.ethUsdMaxAgeSeconds`, or one outside $100
to $1,000,000. Gas is priced at `gas.ethUsdFallback`, never below `gas.ethUsdFloor`. The keeper works,
but the USD costs it books are only as good as the fallback: keep it near the real price, or fix the
feed.

## Wallets

**`wallet default: wrong keystore password`**
The password in `.env` (or typed) does not open the keystore.

**`wallet default: cannot read keystore /…/default.json: No such file or directory`**
The `path` is wrong, or (in Docker) the file is outside the mounted directory.

**`no wallet configured: watch-only, nothing will be sent`**
There is no `wallets` section. Results end with `(watch-only: no wallet configured)`, and collect says
`needs a wallet to simulate (watch-only)`.

### Keystore Password Prompts in Docker

**`wallet default (default.json) needs a password: set wallets.default.password: ${KEEPER_KEYSTORE_PASSWORD} in the config and KEEPER_KEYSTORE_PASSWORD in .env or the environment, or start the keeper in a terminal to be asked for it`**
The config has no `password` for a keystore, and the keeper has no terminal to ask on: a detached
container, a systemd service, pm2. Add `password: ${KEEPER_KEYSTORE_PASSWORD}` under the wallet and
`KEEPER_KEYSTORE_PASSWORD=…` to the `.env` beside the config (or the service's environment). In
Docker, `docker run -it` gives the keeper a terminal for a one-off run, but not a detached one; let
`init` store the password when it asks.

### Low Balance

**`✘ Wallet default 0x…, 0.00100 ETH: below budget.minEthBalance; fund it`**
At runtime: a `lowBalance` alert and, in `status`, **`sending paused: default (0x…) holds 0.00100 ETH,
below budget.minEthBalance`**. While any wallet is below `budget.minEthBalance`, nothing is sent from
any wallet. Send ETH to the wallet; sending resumes within a minute. Lower `minEthBalance` only if you
know your calls' gas.

## Markets

### Labels Shared by Several Markets

**`jobs.liquidation.markets: 'ETH/USD' names 2 markets (0x…, 0x…); it covers each of them, in the statuses each job runs in. Write an address to choose one`**
A label is not unique: a market relisted after a termination keeps its predecessor's label, and a
composite is labelled after its base. A job's label covers every market carrying it; each job acts
only on those in a state it runs in (so a live-market job acts on the live one, while terminal
settlement and collect still reach the terminated one). To choose one, write its address.
`bazaar keeper markets` lists them.

For a one-shot run a shared label is refused: **`'ETH/USD' matches several markets (0x…, 0x…); use an
address`**.

**`no market called 'XYZ/USD'. Markets: …`**
No market carries that label or description. Check the spelling against `bazaar keeper markets`.

**`0x… is not a market of this factory`**
An address under `markets` or `exclude`, or in `--market`, is not one of this factory's markets.

**`the jobs' markets were not updated for the new listing: …`**
A new market was listed while the keeper ran, and re-resolving the jobs' markets failed. Each job keeps
the markets it had; fix the config and restart to pick the listing up.

## Skips and Pauses

A call that is not sent is logged with its reason (each distinct reason at most every five minutes at
info level). The common ones:

| Reason | Meaning |
|---|---|
| `below the profit rule: earns $… for $… of gas, needs ×1.25 and $0.001 net (allowLoss is off)` | the call would not pay enough; normal for most candidates. See [Budgets](budgets.md#2-the-profit-rule) |
| `pays nothing, and this job does not take losses (allowLoss is off)` | an unpaid call without consent |
| `would lose $…, above the $… per-call cap` / `…'s daily loss budget is spent` / `the global daily loss budget is spent` | a loss cap |
| `daily gas budget reached ($… of $… spent)` / `daily ETH spend cap reached …` | a spend cap: nothing more is sent until older calls leave the 24-hour window |
| `base fee … gwei is above the … gwei ceiling` | `gas.maxFeeGwei`, or `gas.backgroundMaxFeeGwei` for background work |
| `the call's cost could not be priced in USD; …` | no usable gas price: check the RPC and ETH/USD |
| `the book has nothing the vault may sell into at this price` | unload: no bid within reach yet |
| `the refresh would not change the vault's health state` | a health poke that would change nothing |
| a decoded revert (`BazaarPair__…`) | the call reverts in simulation: another keeper got there first, or the state is not what the index thought. Retried after a cooldown |
| `already in flight: the keeper is sending this call; try again once it lands` | a one-shot run of a call the keeper in the same process is sending |

### Paused Jobs

**`liquidation paused on ETH/USD for 15 min after repeated reverts`** (a `jobPaused` alert)
`safety.pauseAfterReverts` (3) transactions in a row reverted on chain: the state changed between the
simulation and the block, usually because a faster keeper took the same work. The job stops on that
market for `safety.pauseMinutes` (15), then resumes. Pauses are kept by label, so other markets sharing
the label pause too. Frequent pauses mean you are losing races: give the job its own wallet, use
`rpc.send: sequencer` on Arbitrum One, and run closer to your RPC.

**`the transaction reverted on chain (state changed after the simulation)`**
One such revert. You paid its gas; the ledger books it as `reverted`.

**`no receipt within the timeout; the nonce is re-read before the next send`**
The transaction was sent but no receipt arrived within 90 s. It is booked as `unknown` at its estimated
cost, and its candidate stays locked for 5 minutes in case it lands. Check the hash on an explorer. If
the send itself got no answer, an `endpointDown` alert says so.

**`send refused: …`**
The node refused the signed transaction (insufficient funds, a fee too low for the node's minimum).
Nothing went out.

## Status and Commands

**`No keeper has run with this config yet. Start one with bazaar keeper start.`**
`status` found no `status.json` for this config's network and factory. Check `-c` names the same
config the running keeper uses (the state directory depends on `state.dir`, the chain and the factory).

**`not running (last seen N min ago)`**
The status file is older than 30 seconds: the keeper stopped or hangs. Check its log.

**`init needs an interactive terminal. Copy bazaar-keeper.example.yaml and edit it instead.`**
Run `init` in a terminal (in Docker, `docker run -it`), or write the config by hand.

**`Not sent: pass --yes to send without confirming.`**
A manual operation without a terminal to confirm on. Add `--yes` once you have checked the preview.

**`liquidate needs --market`** (and the like)
The operation needs that option ([Commands](commands.md#keeper-run)).

**Commands are slow before the first `start`**
`markets`, `opportunities`, `run` and `wallet list` connect as `start` does: with no snapshot yet they
build the index first, and do not save it. Start the keeper once; afterwards they load its snapshot.

## Related Pages

- [Setting Up a Keeper](setup.md#3-check-everything-bazaar-keeper-doctor): what `doctor` checks.
- [Budgets & Losing Calls](budgets.md): every skip rule.
- [Running in Production](production.md#monitoring): watching for these in `status.json`.
