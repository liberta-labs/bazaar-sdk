# End-to-end fixtures

What `../chain.ts` replays on a fresh Anvil, so the e2e run needs no Bazaar checkout and no compiler.

| File | What it is |
| --- | --- |
| `run-latest.json` | Foundry's broadcast record of Bazaar's anvil deployment (`broadcast/DeployBazaar.s.sol/31337/run-latest.json`), stripped to what the replay reads: per transaction `contractName`, `contractAddress` and `transaction.{from,to,gas,value,input,nonce}`. |
| `MockArbSys.json` | `out/MockArbSys.sol/MockArbSys.json`, stripped to `deployedBytecode.object`. The replay etches it at the ArbSys precompile (`0x…64`), where the pair reads its block number. |
| `strip.mjs` | Produces the two files above from a Bazaar checkout that ran the deployment. |

## Where they come from

- Bazaar commit `e48b93d9d311bda9e40251271c8be50d9f3ed234` (2026-11-08), with no uncommitted changes
  under `src/` or `script/`. Its contracts and `abi/` match `5a2f741`, the commit the SDK's ABIs
  were synced from (`packages/sdk/src/abi/source.ts`): the one commit between them only edits
  `AUDIT_SCOPE.md`.
- Foundry 1.4.3 (`fa9f934`), solc 0.8.34, `@pythnetwork/pyth-sdk-solidity` 4.2.0, Bazaar's
  `foundry.toml` (via-IR, 150 optimizer runs, cancun).
- 20 transactions from Anvil's account 0 (`0xf39F…2266`, nonces 0 to 19): the twelve external
  libraries through the deterministic CREATE2 deployer (`0x4e59…956C`, which Anvil predeploys),
  then `MockPyth`, `MockUSDC`, `MockOptimisticOracleV3` (HelperConfig's anvil mocks), `BazaarOracle`,
  the `BazaarPair` implementation, `BazaarPairLens`, `BazaarPairTerminator` and `BazaarFactory`
  (`0x3Aa5…443c`).

## Regenerating

From WSL (or any shell with Foundry), in a copy of the Bazaar checkout with its `lib/` submodules
and `node_modules/@pythnetwork/pyth-sdk-solidity` (the one npm package `foundry.toml` remaps):

```sh
# 1. Build what the deployment needs, plus the ArbSys mock.
forge build script/DeployBazaar.s.sol test/mocks/MockArbSys.sol

# 2. A fresh Anvil with the e2e flags.
anvil --port 8546 --block-time 1 --base-fee 10000000 --code-size-limit 100000

# 3. The `deploy-anvil` target's forge command (without `make`, which needs Bazaar's .env).
#    The key is Anvil's first default account from the public test mnemonic.
forge script script/DeployBazaar.s.sol --rpc-url http://127.0.0.1:8546 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --code-size-limit 100000
```

Then, from this repository, `node packages/keeper/test/e2e/fixtures/strip.mjs <that checkout>`,
stop the Anvil, update the commit above, and run the e2e suite against another fresh Anvil:

```sh
npx vitest run -c vitest.e2e.config.ts
```

Regenerate whenever Bazaar's contracts change, together with the SDK's ABIs (`npm run sync-abis`).
