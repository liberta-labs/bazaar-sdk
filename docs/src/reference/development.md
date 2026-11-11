# Development

How to work on the SDK and the keeper themselves: the workspace, building, the tests (unit and end to
end on Anvil), the generator scripts, these docs, and releasing. To use the packages in your own
project, see [Installation](../getting-started/installation.md) instead.

## The Workspace

The repository is one npm workspace with two packages:

| Path | Package | What it is |
|---|---|---|
| `packages/sdk` | `@liberta-labs/bazaar-sdk` | The SDK. Runs in browsers and Node; its only dependency is viem. |
| `packages/keeper` | `@liberta-labs/bazaar-keeper` | The keeper and the `bazaar` CLI. Node 20 or later; depends on the SDK. |

Beside them:

| Path | What it holds |
|---|---|
| `contracts/KeeperProbe.sol` | The simulation probe, compiled into the SDK by `build-probe` (never deployed). |
| `scripts/` | `sync-abis.mjs`, `build-probe.mjs`, `gen-bindings.mjs`. |
| `docs/` | This book (mdBook) and its code samples. |
| `tsconfig.base.json` | The compiler options both packages share (ES2022, NodeNext modules, strict). |
| `tsconfig.check.json`, `tsconfig.check-sdk.json` | Typecheck-only configs (below). |
| `vitest.config.ts`, `vitest.e2e.config.ts` | The unit and end-to-end test configs. |
| `Dockerfile` | The keeper as a container, run as an unprivileged user. |
| `DESIGN.md` | How the keeper works and why it is built this way. |

Set up a checkout with Node 20 or later:

```bash
git clone https://github.com/liberta-labs/bazaar-sdk
cd bazaar-sdk
npm install
npm run build
```

## Building

```bash
npm run build     # tsc -b packages/sdk packages/keeper
npm run clean     # tsc -b --clean packages/sdk packages/keeper
```

`npm run build` is a TypeScript project build: each package compiles `src/` into `dist/` (JavaScript,
declarations, declaration maps and source maps), and the keeper's `tsconfig.json` references the SDK,
so the SDK is built first. `npm run typecheck` runs the same build.

Two typecheck-only configs emit nothing, so they are safe to run while a build or a watcher is going:

| Command | What it checks |
|---|---|
| `npx tsc -p tsconfig.check.json` | Both packages' sources and tests, and the vitest configs, with Node types. The SDK resolves from its sources, so no build is needed first. |
| `npx tsc -p tsconfig.check-sdk.json` | The SDK's sources with DOM types and no Node types: a stray `node:` import or a `Buffer` fails here, which keeps the SDK browser-safe. |

`npm run typecheck:check` runs both.

## Unit Tests

```bash
npm test                                          # vitest run: every packages/*/test/**/*.test.ts
npm run test:watch                                # vitest in watch mode
npx vitest run packages/sdk/test/codec.test.ts    # one file
```

The tests import the SDK from its sources (`vitest.config.ts` aliases `@liberta-labs/bazaar-sdk` to
`packages/sdk/src/index.ts`), so they need no build. They need no chain and no network either: the SDK's
tests run against fake EIP-1193 transports that answer `eth_call` by contract and selector, decoding
the calldata with the SDK's own ABIs (`client-reads-fakes.ts`, `client-writes-fake.ts`,
`termination-fakes.ts`), and the keeper's job and engine tests run a `Keeper` over hand-built state
(`keeper-harness.ts`). Each test has 20 seconds.

One unit test also checks that the facade's generated bindings are current (it runs
`scripts/gen-bindings.mjs --check`), so adding a client function without regenerating them fails
`npm test`.

## End-to-End Tests on Anvil

The end-to-end suite runs the real keeper and the frontend SDK against a real chain: a fresh Anvil with
a Bazaar deployment replayed onto it.

Start Anvil with one-second blocks, a low base fee and Bazaar's contract sizes, then run the suite:

```bash
anvil --port 8546 --block-time 1 --base-fee 10000000 --code-size-limit 100000
```

```bash
npm run test:e2e                                            # every packages/*/test/e2e/**/*.e2e.test.ts
BAZAAR_E2E_RPC=http://127.0.0.1:8546 npm run test:e2e       # another Anvil URL (this is the default)
npx vitest run -c vitest.e2e.config.ts packages/keeper/test/e2e/keeper.e2e.test.ts   # one file
```

With no Anvil answering at `BAZAAR_E2E_RPC`, the suite is skipped with a warning rather than failing.
The files share one chain and one deployer, so `vitest.e2e.config.ts` runs them one at a time, in
order, with ten minutes per test.

| File | What it does |
|---|---|
| `deploy.e2e.test.ts` | Replays the deployment, builds the ETH/USD scenario, and checks through the SDK's reads that the chain holds what the scenario meant to build. |
| `keeper.e2e.test.ts` | Runs the keeper in-process with every automatic job, prices streamed from the mock Pyth Pro server (its updates signed with the test key the local verifier trusts) and no subgraph. Each step moves the price or the clock to give one job its work and checks the result on chain; it also measures how fast the keeper reacts to a price move. |
| `frontend.e2e.test.ts` | Connects the SDK over `JsonRpc`, takes prices from the mock Pyth Pro server (`proPriceSource`), and signs and sends through small test wallets: every write is simulated first, then sent and checked on chain, through gasless calls, insurance exits, a listing and a termination settled under the chain rule from the mock's archived one-second updates. |
| `chain.ts` | The helpers: the replay, the scenario, Anvil's dev accounts. |

Each file snapshots the chain before the replay and reverts to it afterwards, so the next file can
replay on the same Anvil. Every account is one of Anvil's ten unlocked dev accounts (the public test
mnemonic).

### The Fixtures

The deployment is replayed, not compiled: `packages/keeper/test/e2e/fixtures/` holds what the replay
reads, so the suite needs no Bazaar checkout and no Solidity compiler.

| File | What it is |
|---|---|
| `deployment.json` | The transactions Bazaar's Anvil deployment (`script/DeployBazaar.s.sol` with `HelperConfig`'s Anvil mocks) sends from Anvil's first account, each with its contract name, address, and `from`, `to`, `gas`, `input` and `nonce`. |
| `MockArbSys.json` | The `MockArbSys` runtime bytecode, which the replay places at the ArbSys precompile (`0x…64`), where the pair reads its block number. |
| `build.mjs` | Produces the two files above from a built Bazaar checkout's `out/` artifacts. |
| `README.md` | Which Bazaar commit the artifacts came from. |

`build.mjs` computes the deployment without a chain: it links the twelve external libraries in
dependency order and places each at its CREATE2 address through the deterministic deployer Anvil
predeploys, then deploys `MockPythLazer` (no fee) and has it trust the public test signer, then
`MockUSDC`, `MockOptimisticOracleV3`, `BazaarOracle`, the `BazaarPair` implementation, and the lens and
the terminator against the factory's predicted address, then `BazaarFactory`, with the constructor
arguments the deployment script passes on Anvil. Replaying the same transactions from the same
account on a fresh Anvil reproduces the same addresses.

To regenerate the fixtures after a contract change, build the contracts in a Bazaar checkout
(`forge build`), then, from this repository:

```bash
node packages/keeper/test/e2e/fixtures/build.mjs <path to that Bazaar checkout>
```

record the Bazaar commit in `fixtures/README.md`, and run the suite against a fresh Anvil. Regenerate
the fixtures together with the SDK's ABIs (`sync-abis`, below), so the two come from the same
contracts.

To run the keeper by hand against a local deployment, see
[Testing Locally with Anvil](../keeper/local-testing.md).

## Scripts

### `npm run sync-abis -- <bazaar checkout>`

Copies the five contract ABIs (`BazaarFactory`, `BazaarOracle`, `BazaarPair`, `BazaarPairLens`,
`BazaarPairTerminator`) from a Bazaar checkout's `abi/` directory (the MIT-licensed files its
`make abis` writes) into `packages/sdk/src/abi/<Name>.ts` as `as const` arrays, so viem infers every
function's argument and return types. It prints every function, event and error signature added or
removed, and records the Bazaar commit the ABIs came from (and whether that checkout's `abi/` had
uncommitted changes) in `packages/sdk/src/abi/source.ts`, which the SDK exports as `ABI_SOURCE`.

```bash
npm run sync-abis -- ../bazaar
npm run build && npm test
```

The script runs git in the checkout with its fsmonitor and hooks disabled, so an untrusted checkout
cannot run code through it.

### `npm run build-probe [-- <path to solc>]`

Compiles `contracts/KeeperProbe.sol` and writes `packages/sdk/src/probe/artifact.ts` (the probe's ABI
and runtime bytecode). The probe is never deployed: the SDK places its code at `PROBE_ADDRESS` through
an `eth_call` state override to measure exactly what a call would earn and to batch reads (see
[Low-Level Building Blocks](../sdk/low-level.md)). The artifact is committed, so users of the package
never compile it.

It needs solc 0.8.34 (the pragma is exact) and compiles with `--optimize --evm-version paris`, an EVM
version every Arbitrum chain and Anvil accept. Without an argument it uses `solc` from `PATH`; failing
that, Foundry's copy at `~/.svm/0.8.34/solc-0.8.34`, which on Windows it runs through WSL.

### `npm run gen-bindings`

Writes `packages/sdk/src/client/bindings.generated.ts`: for each client module, every exported function
whose first parameter is `ctx: BazaarContext` (except those tagged `@internal`). The `Bazaar` object
binds exactly these, so `bz.trade.createOrder(...)` is `trade.createOrder(ctx, ...)`. Run it after
adding, renaming or removing a context-first function; `node scripts/gen-bindings.mjs --check` exits 1
when the file is out of date, and a unit test runs that check.

## The Docs

This book is an [mdBook](https://rust-lang.github.io/mdBook/) in `docs/`:

| Path | What it is |
|---|---|
| `docs/book.toml` | The book's settings. `create-missing = false`: a link in `SUMMARY.md` to a page that does not exist fails the build. |
| `docs/src/SUMMARY.md` | The table of contents: every page, in order. |
| `docs/src/` | The pages, one Markdown file each. |
| `docs/examples/` | Every TypeScript sample the pages show, as complete modules. |
| `docs/theme/`, `docs/*.css`, `docs/*.js` | The Bazaar theme and the page actions. |

```bash
npm run docs:check   # typecheck every sample against the packages' sources
npm run docs:build   # docs:check, then mdbook build docs (into docs/book/)
npm run docs:serve   # mdbook serve docs --open: rebuilds and reloads as you edit
```

`docs:build` and `docs:serve` need `mdbook` on your `PATH`; CI uses mdBook 0.5.4, so use the same
version locally. `docs/book/` is ignored by git.

### How Samples Are Included

A page never holds TypeScript inline. Each sample is a file under `docs/examples/<area>/<topic>.ts`:
a complete module with its imports at the top and its setup (constants, the `bz` connection) in the
file, importing from the package names exactly as a user would. The part a page shows sits between
anchor comments:

```ts
// ANCHOR: options
const bz = await Bazaar.connect({ transport: window.ethereum, factory: FACTORY, chainId: 42161 });
// ANCHOR_END: options
```

and the page includes it by its path relative to the page (a page in `docs/src/sdk/` starts with
`../../examples/`) and the anchor name:

````markdown
```ts
\{{#include ../../examples/reads/connecting.ts:options}}
```
````

Leave the anchor name out to include the whole file. A file may hold several anchors.

`docs/examples/tsconfig.json` maps `@liberta-labs/bazaar-sdk` and `@liberta-labs/bazaar-keeper` to the
packages' sources, and `docs/examples/env.d.ts` declares `window.ethereum` for browser samples. So
`npm run docs:check` typechecks every sample against the code as it is: a sample that no longer matches
the SDK fails the check instead of misleading a reader. YAML, shell and JSON samples stay inline in the
pages.

### Publishing

`.github/workflows/docs.yml` builds and publishes the book to GitHub Pages
(sdk-docs.bazaar.finance) on every push to `main` that touches `docs/`, a package's `src/`, or the
workflow itself. It typechecks the samples first (`npm run docs:check`), so a broken sample stops the
deploy. It also publishes each page's Markdown source beside its HTML, which the page actions (copy
the page, open it in an assistant) use.

## Releasing

The packages are not yet on npm. Until they are, users install from a checkout
(`npm install && npm run build`); once published, `npm install @liberta-labs/bazaar-sdk` and
`npm install @liberta-labs/bazaar-keeper`.

Each package's `prepack` script runs `tsc -b`, so `npm pack` and `npm publish` build `dist/` first.
A package ships only `dist/`, its `README.md` and its `LICENSE` (the `files` field), as an ES module
with its types (`exports` points both at `dist/index.*`). The keeper also installs the `bazaar` command
(`bin`: `dist/cli/main.js`).

To release:

1. Bump `version` in `packages/sdk/package.json` and `packages/keeper/package.json`, the keeper's
   dependency on `@liberta-labs/bazaar-sdk` (pinned to an exact version), and `VERSION` in
   `packages/keeper/src/index.ts`, which is kept by hand.
2. Run the checks: `npm run build`, `npm test`, `npm run typecheck:check`, the end-to-end suite on a
   fresh Anvil, and `npm run docs:check`.
3. Publish the SDK first, then the keeper, which depends on that exact SDK version, for example:

```bash
npm publish -w packages/sdk --access public
npm publish -w packages/keeper --access public
```

The SDK's `package.json` marks `dist/errors/messages.js` as its one module with side effects: loading
it registers the user-facing error messages (`installUserMessages`), so a bundler must not drop it when
tree-shaking.

## Related Pages

- [Installation](../getting-started/installation.md): using the packages.
- [Testing Locally with Anvil](../keeper/local-testing.md): a keeper against a local deployment.
- [Low-Level Building Blocks](../sdk/low-level.md): the probe and the typed ABIs.
- [API Index](api.md): every export.
