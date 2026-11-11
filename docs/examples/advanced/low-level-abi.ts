// The typed ABIs with viem directly.
import { type Address, createPublicClient, http } from "viem";
import { arbitrum } from "viem/chains";
import { ABI_SOURCE, ABIS, CONTRACT_NAMES, bazaarPairAbi, bazaarPairLensAbi } from "@liberta-labs/bazaar-sdk";

const PAIR: Address = "0x0000000000000000000000000000000000000003";
const LENS: Address = "0x0000000000000000000000000000000000000004";
const user: Address = "0x0000000000000000000000000000000000000001";

// ANCHOR: abi
const client = createPublicClient({ chain: arbitrum, transport: http(process.env.RPC_HTTP_URL) });

// `as const` ABIs: viem infers argument and return types from them.
const [spotPrice, , updateTs] = await client.readContract({ address: PAIR, abi: bazaarPairAbi, functionName: "lastPairPrice" });
const owed = await client.readContract({ address: LENS, abi: bazaarPairLensAbi, functionName: "getClaimableFeesAll", args: [user] });
console.log(spotPrice, updateTs, owed);

// The pair's ABI includes its linked libraries' events, which carry the pair's address.
const trades = await client.getContractEvents({ address: PAIR, abi: bazaarPairAbi, eventName: "Trade", fromBlock: (await client.getBlockNumber()) - 1_000n });
for (const t of trades) console.log(t.args.maker, t.args.fillSize, t.args.price);

console.log(CONTRACT_NAMES, Object.keys(ABIS)); // BazaarFactory, BazaarOracle, BazaarPair, BazaarPairLens, BazaarPairTerminator
console.log(`ABIs from Bazaar commit ${ABI_SOURCE.commit} (${ABI_SOURCE.date})`);
// ANCHOR_END: abi
