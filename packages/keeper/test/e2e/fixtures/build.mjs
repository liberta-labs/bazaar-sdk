// Write the deployment the e2e replay in ../chain.ts sends, from a built Bazaar checkout's artifacts:
// the transactions script/DeployBazaar.s.sol broadcasts on Anvil, computed here without a chain or a
// compiler, and the ArbSys mock's runtime code. See README.md.
//
//   node packages/keeper/test/e2e/fixtures/build.mjs <bazaar checkout with out/ built>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeDeployData, encodeFunctionData, getContractAddress, keccak256, maxUint256, stringToHex, toHex } from "viem";
import { privateKeyToAddress } from "viem/accounts";

const root = process.argv[2];
if (!root) {
  console.error("usage: node build.mjs <bazaar checkout with out/ built>");
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const artifact = (name) => JSON.parse(fs.readFileSync(path.join(root, "out", `${name}.sol`, `${name}.json`), "utf8"));

// Anvil's first account (the public test mnemonic), which sends every transaction.
const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// The deterministic CREATE2 deployer Anvil predeploys, through which forge deploys external libraries.
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const SALT = `0x${"00".repeat(32)}`;
// LazerUpdate.signer(): the address of the public test key, keccak256 of this label.
const TEST_SIGNER = privateKeyToAddress(keccak256(stringToHex("bazaar.test.pyth-lazer-signer")));
// DeployBazaar.UMA_IDENTIFIER, and HelperConfig.getOrCreateAnvilConfig's mock OOv3 liveness.
const UMA_IDENTIFIER = stringToHex("ASSERT_TRUTH2", { size: 32 });
const OO_LIVENESS = 7200n;
// LinkedLibraries._libNames(): the externally linked library set.
const LIBRARIES = [
  "InsuranceVaultLib",
  "LiquidationLib",
  "OrderManagementLib",
  "AdlLib",
  "MatchingEngineLib",
  "CollateralLib",
  "RiskParamsLib",
  "FundingLib",
  "TerminationLib",
  "MetaTxLib",
  "VaultHealthLib",
  "ClaimTextLib",
];
// The largest gas a transaction may ask for under EIP-7825 (Osaka), so the replay runs on any hardfork.
const MAX_TX_GAS = 16_000_000;

/** `bytecode` (an artifact's object) with every library it links replaced by its address in `linked`; null while one is missing. */
function link(bytecode, refs, linked) {
  let hex = bytecode.object.slice(2);
  for (const [file, names] of Object.entries(refs ?? {})) {
    for (const [name, spots] of Object.entries(names)) {
      const at = linked.get(`${file}:${name}`);
      if (at === undefined) return null;
      for (const { start, length } of spots) hex = hex.slice(0, start * 2) + at.slice(2).toLowerCase() + hex.slice((start + length) * 2);
    }
  }
  if (hex.includes("__$")) throw new Error("an unlinked library placeholder is left");
  return `0x${hex}`;
}

/** Calldata gas: 16 per non-zero byte, 4 per zero byte. */
function calldataGas(hex) {
  let gas = 0;
  for (let i = 2; i < hex.length; i += 2) gas += hex.slice(i, i + 2) === "00" ? 4 : 16;
  return gas;
}

/**
 * A gas limit for a transaction that creates `runtimeBytes` of code from `input`, with `work` for its
 * constructor: the intrinsic cost, the init code's word cost and the code deposit, with room to spare.
 * Unused gas is refunded, so the room costs nothing but block space.
 */
function creationGas(input, runtimeBytes, work = 1_500_000) {
  const gas = 21_000 + 32_000 + calldataGas(input) + 8 * Math.ceil((input.length - 2) / 64) + 200 * runtimeBytes + work;
  return Math.min(MAX_TX_GAS, Math.ceil(gas * 1.25));
}

const transactions = [];
let nonce = 0;
const record = (contractName, contractAddress, tx) => {
  transactions.push({ contractName, contractAddress, transaction: { from: DEPLOYER, ...tx, nonce: toHex(nonce) } });
  nonce += 1;
};

// 1. The libraries, each once every library it links has an address, through the CREATE2 deployer.
const linked = new Map();
const pending = [...LIBRARIES];
while (pending.length) {
  const before = pending.length;
  for (const name of [...pending]) {
    const a = artifact(name);
    const initcode = link(a.bytecode, a.bytecode.linkReferences, linked);
    if (initcode === null) continue;
    const address = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt: SALT, bytecode: initcode });
    linked.set(`src/libraries/${name}.sol:${name}`, address);
    const input = `${SALT}${initcode.slice(2)}`;
    record(name, address.toLowerCase(), { to: CREATE2_DEPLOYER, gas: toHex(creationGas(input, (a.deployedBytecode.object.length - 2) / 2)), input });
    pending.splice(pending.indexOf(name), 1);
  }
  if (pending.length === before) throw new Error(`cannot link ${pending.join(", ")}: a library they need is not in the set`);
}

/** Record a CREATE of `name` with constructor `args`; returns its address. */
function create(name, args = [], work) {
  const a = artifact(name);
  const bytecode = link(a.bytecode, a.bytecode.linkReferences, linked);
  if (bytecode === null) throw new Error(`${name} links a library outside the set`);
  const input = encodeDeployData({ abi: a.abi, bytecode, args });
  const address = getContractAddress({ opcode: "CREATE", from: DEPLOYER, nonce: BigInt(nonce) });
  record(name, address.toLowerCase(), { gas: toHex(creationGas(input, (a.deployedBytecode.object.length - 2) / 2, work)), input });
  return address;
}

// 2. HelperConfig.getOrCreateAnvilConfig: the mock verifier (fee 0) trusting the test signer for good,
//    the mock USDC, and the mock OOv3 bonding in it.
const pythLazer = create("MockPythLazer", [0n]);
record(null, null, {
  to: pythLazer.toLowerCase(),
  gas: toHex(100_000),
  input: encodeFunctionData({ abi: artifact("MockPythLazer").abi, functionName: "updateTrustedSigner", args: [TEST_SIGNER, maxUint256] }),
});
const usdc = create("MockUSDC");
const oo = create("MockOptimisticOracleV3", [usdc, OO_LIVENESS]);

// 3. DeployBazaar.deploy: the oracle, the pair implementation, the lens and the terminator against the
//    factory's CREATE address (two nonces after the lens's), then the factory, with the deployer as
//    the bug-bounty address as on Anvil.
const oracle = create("BazaarOracle", [pythLazer]);
const pair = create("BazaarPair");
const factoryAt = getContractAddress({ opcode: "CREATE", from: DEPLOYER, nonce: BigInt(nonce + 2) });
const lens = create("BazaarPairLens", [factoryAt]);
const terminator = create("BazaarPairTerminator", [factoryAt]);
const factory = create("BazaarFactory", [usdc, oracle, lens, DEPLOYER, oo, pair, terminator, UMA_IDENTIFIER], 4_000_000);
if (factory !== factoryAt) throw new Error("the factory's address prediction does not hold");

fs.writeFileSync(path.join(here, "deployment.json"), JSON.stringify({ transactions }, null, 1) + "\n");
const arbsys = artifact("MockArbSys");
fs.writeFileSync(path.join(here, "MockArbSys.json"), JSON.stringify({ deployedBytecode: { object: arbsys.deployedBytecode.object } }, null, 1) + "\n");
console.log(`${transactions.length} transactions; factory ${factory}; verifier ${pythLazer} trusting ${TEST_SIGNER}`);
