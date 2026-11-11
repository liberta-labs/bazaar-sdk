# Wallets & Secrets

The keeper signs its transactions with wallets you configure under `wallets:`, each under a name of
your choosing. Jobs send from the wallet named `default` unless their `wallet` key names another.
This page covers every wallet type, the `bazaar wallet` commands, and the rules that keep keys,
passwords and API keys out of the config file.

## Wallet Types

```yaml
wallets:
  default:
    type: keystore                  # keystore | privateKey | mnemonic | remote
    path: ~/.bazaar/keys/default.json
    password: ${KEEPER_KEYSTORE_PASSWORD}
```

| `type` | Needs | Optional | What it is |
|---|---|---|---|
| `keystore` | `path` | `password` | an encrypted JSON keystore (version 3). Recommended: the key is encrypted at rest, and only the password needs protecting |
| `privateKey` | `key` | | a raw 32-byte private key, hex with or without `0x`, from the environment |
| `mnemonic` | `phrase` | `index` (default 0) | a BIP39 phrase; the key is derived at `m/44'/60'/0'/0/{index}` |
| `remote` | `url`, `address` | | any signer that answers `eth_signTransaction` over JSON-RPC (Web3Signer, a KMS bridge) |

A wallet missing what its type needs is a config error (`wallets.default: a keystore wallet needs
path`). With no `wallets` section at all, the keeper is **watch-only**: it plans and simulates every
call, logs what it would send, and sends nothing.

### Keystore

`path` may start with `~/`, which is your home directory. The keystore is decrypted once, when the
keeper starts (`Keeper.create` in the library), so a wrong password fails at once with
`wallet default: wrong keystore password`.

`password` is the keystore's password, as a `${NAME}` reference to `.env` or the environment. Left
out, the keeper asks for it at start (`Password for wallet default (default.json):`) when it runs in a
terminal. Without a terminal (a service, a detached container) it cannot ask, and stops with:

```text
wallet default (default.json) needs a password: set wallets.default.password: ${KEEPER_KEYSTORE_PASSWORD} in the config and KEEPER_KEYSTORE_PASSWORD in .env or the environment, or start the keeper in a terminal to be asked for it
```

### Private Key

```yaml
wallets:
  fast:
    type: privateKey
    key: ${KEEPER_FAST_KEY}
```

The key must be 32 bytes of hex within the secp256k1 range. An invalid key fails with `wallet fast:
not a valid private key: …`, which never quotes the key.

### Mnemonic

```yaml
wallets:
  second:
    type: mnemonic
    phrase: ${KEEPER_MNEMONIC}
    index: 1
```

The phrase is checked as eth-account checks it: 12, 15, 18, 21 or 24 words, every word from one
BIP39 word list (English, Czech, French, Italian, Japanese, Korean, Portuguese, Spanish, simplified
or traditional Chinese), and a matching checksum. Errors name the word's position, never the word.
`index` picks the account: 0 is the first address a wallet app shows for that phrase. BIP39
passphrases are not supported.

### Remote Signer

```yaml
wallets:
  default:
    type: remote
    url: ${SIGNER_URL}
    address: "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955"
```

For each transaction the keeper posts one JSON-RPC request, `eth_signTransaction`, with an EIP-1559
transaction (`type: 0x2`, `chainId`, `nonce`, `to`, `value`, `data`, `gas`, `maxFeePerGas`,
`maxPriorityFeePerGas`, `from`), and expects the signed raw transaction as `result` (a hex string, or
an object with a `raw` field). It waits 15 seconds. The keeper then parses what came back and refuses
it, sending nothing, unless it is exactly the transaction asked for (every field the same, no access
list) and recovers to the configured `address`. The URL is masked in every message.

## The `bazaar wallet` Commands

### `bazaar wallet new`

Creates a random key and saves it as an encrypted keystore. It asks for a password twice.

```bash
bazaar wallet new                      # ~/.bazaar/keys/default.json
bazaar wallet new --name fast          # ~/.bazaar/keys/fast.json
bazaar wallet new --path ./keys/fast.json
```

```text
✔ 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955 saved encrypted at /home/me/.bazaar/keys/fast.json
Fund it with a little ETH for gas. No keeper call needs USDC or an approval.
In bazaar-keeper.yaml:
  wallets:
    fast:
      type: keystore
      path: /home/me/.bazaar/keys/fast.json
      password: ${KEEPER_KEYSTORE_PASSWORD}   # in .env, or leave out to be asked at start
```

It never overwrites a file (`… already exists`). Cancelling at a prompt writes nothing.

### `bazaar wallet import`

The same, for a private key you paste (hidden as you type). A bad key fails before you choose a
password.

```bash
bazaar wallet import --name fast
```

### `bazaar wallet list`

Reads the config, loads every wallet (prompting for keystore passwords that are not stored), and
prints each one's ETH balance and what it can claim across the markets:

```bash
bazaar wallet list -c ~/keeper/bazaar-keeper.yaml
```

```text
 WALLET   ADDRESS                                         ETH  CLAIMABLE
 default  0x14dC79964da2C08b23698B3D3cc7Ca32193d9955  0.02000  $12.40 across 2 market(s)
 fast     0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f  0.01000  $3.15 across 1 market(s)
```

`list` connects like `start` does, so with no snapshot yet it builds the index first.

## Keystore Compatibility

Keystores are Ethereum's JSON keystore, version 3, as geth and eth-account read and write them:

- **Reading**: scrypt or PBKDF2 (HMAC-SHA256 or HMAC-SHA512) key derivation, AES-128-CTR, the MAC
  checked in constant time before anything is decrypted. Key names are matched without case, so old
  geth files with `"Crypto"` load too.
- **Writing**: scrypt with n = 2^18, r = 8, p = 1, a 16-byte salt and a random 16-byte IV, in
  eth-account's field order, written owner-only (0600) and never over an existing file.

So a version 3 keystore from geth, Foundry (`cast wallet new`) or the Python keeper opens here, and
one written here opens in any tool that reads version 3 keystores.

## Passwords and `.env`

The keeper reads `.env` from the config file's directory before it reads the config. Variables
already in the environment win over `.env`. `bazaar keeper init` writes `.env` owner-only (0600) and
asks before putting the keystore password there.

| Where the password lives | Starts unattended | Trade-off |
|---|---|---|
| `.env` beside the config (`password: ${KEEPER_KEYSTORE_PASSWORD}`) | yes | anyone who can read `.env` and the keystore has the key: keep the directory private |
| the service's environment (systemd `EnvironmentFile`, a container secret, a secret manager that exports it) | yes | the same, with the file kept elsewhere |
| left out, typed at each start | no | nothing on disk but the encrypted keystore |

A hot wallet holds only what it needs: a little ETH for gas, and the bounties it earned until
`collect` claims them. Use `collect.forwardTo` to move claimed USDC to a cold address
([The Jobs](jobs.md#collect)).

## The Secrets Rules

The config file is meant to be shareable: you can commit it, paste it into an issue, or show it on
screen. So the loader refuses to read a config that holds a secret, and says how to fix it.

### Secret Keys

The values of these keys, wherever they appear, must be a single `${NAME}` reference (or be left out):

| Key | Where |
|---|---|
| `key` | `wallets.<name>.key` |
| `password` | `wallets.<name>.password` |
| `phrase` | `wallets.<name>.phrase` |
| `token` | `prices.token` |
| `apiKey` | `subgraph.apiKey` |
| `botToken` | `alerts.telegram.botToken` |
| `webhook` | `alerts.discord.webhook` |

```text
prices.token holds a secret written into the file (a ${NAME:-default} default counts). Put it in .env as a variable and write token: ${NAME} here instead
```

### URLs That Carry Keys

Hosted RPCs, indexers and price services often put the API key inside the URL: Alchemy's
`/v2/<key>`, Infura's `/v3/<id>`, QuickNode's `/<token>/`, a `?key=` query, `user:password@` before
the host. The loader refuses any URL written into the file that may carry a credential, under any key.
It judges by structure, not by what a key looks like: a URL passes only when every part of it is
known to be public (short host labels or lowercase words joined by `-`; path segments that are
well-known words such as `rpc`, `api` or `stream`, versions, short numbers, or lowercase words joined
by `-` or `_`; the values of a few public query parameters). Everything else counts as a possible key.

```text
rpc.http is a URL with a key in its path, written into the file. Put the URL in .env as a variable and write ${NAME} here instead, …
```

Two fixes:

```yaml
rpc:
  http: ${RPC_HTTP_URL}                                        # the whole URL in .env
  # http: https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}  # or only the key in .env
```

The check runs on the text as written, with each reference's default in its place, so
`https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` passes (the key is a reference) while a default
holding the key does not. When in doubt, put the whole URL in `.env`, as `init` does for every URL you
type.

### `${NAME}` and `${NAME:-default}`

Any string value in the config may hold references, filled from the environment (after `.env` is
loaded):

| Form | When `NAME` is set | When it is not |
|---|---|---|
| `${NAME}` | its value | an error: `rpc.http: environment variable RPC_HTTP_URL is not set (add it to .env or export it)` |
| `${NAME:-default}` | its value | `default` |
| `${NAME:-}` | its value | the empty string |

A default is text in the file like any other, so a secret key's value may use `${NAME:-}` (empty when
unset; an empty `subgraph.apiKey` sends no key, while an empty `prices.token` is refused: leave the
line out for an endpoint that needs no token) but never `${NAME:-the-secret}`. Names are letters, digits and
`_`, not starting with a digit. References are filled in values only, never in keys.

### Headers

`prices.headers` values go to the price endpoint with every request and usually carry its key, so
each one is held to the same rule: a `${NAME}` reference, optionally after an auth scheme.

```yaml
prices:
  endpoint: ${PRICE_ENDPOINT_URL}
  headers:
    x-api-key: ${PRICE_HEADER_KEY}
    Authorization: Bearer ${PRICE_TOKEN}
```

`prices.token` is the shorter way to send `Authorization: Bearer <token>`. Neither the token nor the
headers go to the symbols registry, which needs no credentials.

### What the Keeper Prints

Keys, passwords and phrases never appear in an error or a log line. Every URL the CLI prints passes
through the same structural redaction first (`https://arb-sepolia.g.alchemy.com/v2/***`), and
`doctor` also masks the configured API keys and bot token wherever an error might quote them. Errors
print one line; `--debug` adds the stack trace, also redacted. An address field that receives
something the length of a private key says so without echoing it.

## Several Wallets

Each wallet is its own nonce sequence: a send takes the wallet's lock only to assign a nonce and sign,
so two jobs on different wallets never wait for each other. Liquidations and trigger executions race
other keepers; give them their own wallet so they never queue behind a collect, a sweep or a
settlement:

```yaml
wallets:
  default:
    type: keystore
    path: /home/me/keeper/keys/default.json
    password: ${KEEPER_KEYSTORE_PASSWORD}
  fast:
    type: keystore
    path: /home/me/keeper/keys/fast.json
    password: ${KEEPER_FAST_PASSWORD}

jobs:
  liquidation:
    wallet: fast
  triggers:
    wallet: fast
  unload: {}
  refresh: {}
  collect: {}
```

A job naming a wallet that is not under `wallets` is a config error (`job liquidation uses wallet
'fast', which is not under wallets`).

What every wallet shares:

- **The low-balance halt.** The keeper checks every wallet's ETH once a minute. If any one is below
  `budget.minEthBalance`, all sending stops until it is funded. Fund every wallet.
- **The budgets.** Daily spend and loss caps count every wallet's transactions together.
- **Collect.** `collect` claims every wallet's balances, each from the wallet that earned it, and
  `forwardTo` forwards from each wallet.
- **Manual operations** send from `default`, or from the first wallet configured when there is no
  `default`.

Your own positions are never liquidated or settled by your keeper: every configured wallet's address
is skipped.

**One process per set of wallets.** Two keepers signing with the same wallet would fight over its
nonces (each would see the other's transactions take "its" nonce). The keeper recovers from a taken
nonce by re-reading it and retrying once, which makes an occasional one-shot `bazaar keeper run`
beside a running keeper workable, but two long-running processes on one wallet are not.

## Related Pages

- [Configuration Reference](configuration.md#wallets) for every wallet key.
- [Running in Production](production.md#backups) for backing up keystores.
- [Troubleshooting](troubleshooting.md#keystore-password-prompts-in-docker) for password prompts in containers.
