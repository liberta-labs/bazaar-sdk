# Installation

This page covers what the SDK needs, how to install it (from npm once it is published, from the
repository until then), how it fits a project that already uses viem or wagmi (or neither), the
TypeScript settings it expects, and how to install the keeper.

## Requirements

| Where | What it needs |
|---|---|
| Node | 20 or later (both packages declare `"engines": { "node": ">=20" }`). |
| Browsers | Any current browser. The package is compiled to ES2022 and uses `BigInt`, `fetch` with streamed response bodies, `AbortSignal.timeout` and `TextDecoder`. |
| Bundlers | Anything that reads ES modules and package `exports`: Vite, webpack 5, Rollup, esbuild, Next.js. No polyfills and no Node built-ins are needed in the browser: the SDK's sources are typechecked with DOM types only, so a stray `node:` import or `Buffer` cannot slip in. |
| Dependencies | `viem` (^2.57.17) and nothing else. |

**ES modules only.** The package is `"type": "module"` and its `exports` map has only an `import`
condition. Import it with `import`; from CommonJS, load it with a dynamic
`await import("@liberta-labs/bazaar-sdk")`.

**Tree-shaking.** The package declares `"sideEffects": ["./dist/errors/messages.js"]`, so a bundler
drops every module you do not use. The one module kept for its side effect registers the user-facing
error messages; `connect()` also registers them explicitly (`installUserMessages()`), so they survive
even a bundler that ignores the flag. If you decode errors without ever connecting (a script that
only calls `decodeError`), call `installUserMessages()` once yourself.

## Installing the SDK

Once published:

```bash
npm install @liberta-labs/bazaar-sdk
```

The packages are not on npm yet. Until they are, build them from the repository:

```bash
git clone https://github.com/liberta-labs/bazaar-sdk && cd bazaar-sdk && npm install && npm run build
```

Then either pack the SDK into a tarball and install that in your project, which is what npm will
later install:

```bash
npm pack -w @liberta-labs/bazaar-sdk          # writes liberta-labs-bazaar-sdk-0.1.0.tgz
cd ../my-app && npm install ../bazaar-sdk/liberta-labs-bazaar-sdk-0.1.0.tgz
```

or link the built package folder, which picks up rebuilds without reinstalling:

```bash
cd ../my-app && npm install ../bazaar-sdk/packages/sdk
```

Install `viem` in your project too if you import from it (the samples in these docs do, for types
such as `Address` and for wallet clients). Keep one copy: the same major version the SDK uses.

## With viem, wagmi, or Neither

The SDK talks to the chain through a `Transport`: anything with an EIP-1193
`request({ method, params })`. Three kinds of object fit, and you pick per project:

```ts
{{#include ../../examples/getting-started/install.ts:plain}}
```

- **No library at all.** In a browser, pass the wallet's provider (`window.ethereum`, or the provider
  an EIP-6963 picker hands you). In Node, pass an RPC URL: the SDK builds its own small HTTP client
  (`JsonRpc`), rate limited, retried on transient failures and never printing the URL's key. Sending
  then goes through the same wallet with `bz.send(wallet, call)`.
- **viem.** A viem `PublicClient` or `WalletClient` is itself an EIP-1193 transport. Use one for reads
  and a `WalletClient` to send, turning each `PreparedCall` into a transaction request with
  `toTransactionRequest`:

```ts
{{#include ../../examples/getting-started/install.ts:viem}}
```

- **wagmi.** wagmi's clients are viem clients: pass the connector's client (from `useConnectorClient`
  or `getConnectorClient`) as the transport, or keep `window.ethereum` for reads, and send with
  wagmi's `sendTransaction` and `toTransactionRequest(call)`, exactly as with viem above. A
  connection is bound to a chain, not to an account: connect again when the user switches chain.
- **ethers.** An ethers provider is not an EIP-1193 object (it has `send`, not `request`). Pass the
  underlying provider (`window.ethereum`) or an RPC URL to the SDK, and send a call's `to`, `data`
  and `value` with an ethers signer if you prefer.

A bot holding its own key uses an RPC URL for reads and a viem `WalletClient` with a local account to
send; [Quick Start: a Bot](quick-start-bot.md) shows it end to end, including the one detail that
trips people up (the `account` field).

## TypeScript

The package ships its own declarations (`dist/index.d.ts`). It is written with `strict` on and works
best in a project that has it on too. The settings that matter:

| Setting | Value | Why |
|---|---|---|
| `module` / `moduleResolution` | `NodeNext` for Node, `Bundler` (or `NodeNext`) for a bundled app | The package is ESM with an `exports` map. |
| `target` | `ES2020` or later | Amounts are `bigint` (`10n ** 18n` needs ES2020). |
| `lib` / `types` | `DOM` in a browser project; `@types/node` (20+) in a Node one | The declarations name `fetch`, `Response` and `AbortSignal`, which come from either. |

Every protocol quantity is a `bigint`, which `JSON.stringify` refuses: convert to a decimal string
(`formatUnits18`, or `String(x)`) before putting one in JSON, a URL or framework state that serializes.
See [Units & Constants](../reference/units.md).

## Installing the Keeper

The keeper is a Node 20+ program with a command-line tool, `bazaar`. Once published:

```bash
npm install -g @liberta-labs/bazaar-keeper
bazaar keeper init
```

Until then, run it from the repository you built above:

```bash
cd bazaar-sdk
npx bazaar keeper init      # asks for the network, RPC, subgraph, price endpoint, wallet, jobs and markets
npx bazaar keeper doctor    # checks every connection, the wallet's ETH, and the jobs
```

The repository's `Dockerfile` builds the same keeper as a container. The whole setup, wallets and
configuration are in [Setting Up a Keeper](../keeper/setup.md); using its engine from your own code is
in [The Keeper as a Library](../keeper/library.md).

## Next

- [Quick Start: a Frontend](quick-start-frontend.md) or [Quick Start: a Bot](quick-start-bot.md).
- [Core Concepts](concepts.md), before building anything larger.
- [Connecting](../sdk/connecting.md), for every connection option.
