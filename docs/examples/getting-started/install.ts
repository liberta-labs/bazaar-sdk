// Installation: the ways a project hands the SDK its chain connection.
import { Bazaar, toTransactionRequest } from "@liberta-labs/bazaar-sdk";
import { type Address, createPublicClient, createWalletClient, custom, http } from "viem";
import { arbitrumSepolia } from "viem/chains";

const FACTORY: Address = "0x0000000000000000000000000000000000000000";

// ANCHOR: plain
// No library at all: the wallet's own EIP-1193 provider in a browser...
const inBrowser = await Bazaar.connect({ transport: window.ethereum, factory: FACTORY });
// ...or a JSON-RPC URL in Node (the SDK's own HTTP client, with rate limiting and retries).
const inNode = await Bazaar.connect({ transport: "https://sepolia-rollup.arbitrum.io/rpc", factory: FACTORY });
// ANCHOR_END: plain

// ANCHOR: viem
// A viem client is an EIP-1193 transport too: reads go through it.
const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http() });
const bz = await Bazaar.connect({ transport: publicClient, factory: FACTORY });

// Writes come back as PreparedCalls; a viem WalletClient (or wagmi, which wraps one) sends them.
const walletClient = createWalletClient({ chain: arbitrumSepolia, transport: custom(window.ethereum) });
const [user] = await walletClient.requestAddresses();
const eth = await bz.markets.getMarket("ETH/USD");
const call = await bz.trade.claimFees(eth.address, user!);
const sim = await bz.simulate(call);
if (sim.ok) await walletClient.sendTransaction({ ...toTransactionRequest(call), account: user! });
// ANCHOR_END: viem

console.log(inBrowser.chainId, inNode.chainId);
