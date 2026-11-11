# End-to-end fixtures

What `../chain.ts` replays on a fresh Anvil, so the e2e run needs no Bazaar checkout and no compiler.

| File | What it is |
| --- | --- |
| `deployment.json` | The transactions Bazaar's Anvil deployment sends (`script/DeployBazaar.s.sol`, with `script/HelperConfig.s.sol`'s Anvil mocks), from Anvil's account 0: per transaction `contractName`, `contractAddress` and `transaction.{from,to,gas,input,nonce}`. |
| `MockArbSys.json` | `out/MockArbSys.sol/MockArbSys.json`, stripped to `deployedBytecode.object`. The replay etches it at the ArbSys precompile (`0x…64`), where the pair reads its block number. |
| `build.mjs` | Produces the two files above from a built Bazaar checkout's `out/` artifacts, with no chain and no compiler. |

## What the deployment is

21 transactions from Anvil's account 0 (`0xf39F…2266`, nonces 0 to 20):

1. The twelve external libraries (`script/LinkedLibraries.sol`'s set), linked in dependency order
   (five of them link `RiskParamsLib`), each through the deterministic CREATE2 deployer
   (`0x4e59…956C`, which Anvil predeploys) with a zero salt.
2. `MockPythLazer(0)`, Pyth's verifier with no fee, and its `updateTrustedSigner` call trusting the
   public test signer (`0x8E3f…B5BE`, the address of `keccak256("bazaar.test.pyth-lazer-signer")`)
   for good; then `MockUSDC` and `MockOptimisticOracleV3(usdc, 7200)`.
3. `BazaarOracle(verifier)`, the `BazaarPair` implementation, `BazaarPairLens` and
   `BazaarPairTerminator` against the factory's CREATE address, and `BazaarFactory` with account 0 as
   the bug-bounty address and `ASSERT_TRUTH2` as the identifier, as the script passes them on Anvil.

Each transaction's gas limit is its intrinsic cost, init-code word cost and code deposit with room to
spare (unused gas is refunded), and never above EIP-7825's cap, so the replay runs on any hardfork.

## Where they come from

- The Bazaar working tree at commit `e48b93d9d311bda9e40251271c8be50d9f3ed234` with the Pyth Pro
  contracts uncommitted on top of it (`src/`, `script/`, `test/mocks/MockPythLazer.sol`), built by
  Foundry 1.4.3 with solc 0.8.34 and Bazaar's `foundry.toml` (via-IR, 150 optimizer runs, cancun).
  The SDK's ABIs were synced from the same tree (`packages/sdk/src/abi/source.ts` records it as
  dirty). Regenerate both once those contracts are committed, and record the commit here.

## Regenerating

In a Bazaar checkout, build the contracts (`forge build`, which writes `out/`), then from this
repository:

```sh
node packages/keeper/test/e2e/fixtures/build.mjs <that checkout>
```

and run the e2e suite against a fresh Anvil:

```sh
anvil --port 8546 --block-time 1 --base-fee 10000000 --code-size-limit 100000
npx vitest run -c vitest.e2e.config.ts
```

Regenerate whenever Bazaar's contracts change, together with the SDK's ABIs (`npm run sync-abis`).
