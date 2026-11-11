// Sending a PreparedCall from Node with a local private key (a bot or a service).
import { Bazaar, OrderType, errorMessage, parseUnits18 } from "@liberta-labs/bazaar-sdk";
import { type Address, type Hex, createWalletClient, http, nonceManager } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const FACTORY = (process.env.BAZAAR_FACTORY ?? "0x0000000000000000000000000000000000000000") as Address;

// ANCHOR: local-key
const account = privateKeyToAccount(process.env.BOT_PRIVATE_KEY as Hex, { nonceManager });
const wallet = createWalletClient({ account, chain: arbitrum, transport: http(RPC_URL) });

const bz = await Bazaar.connect({
  transport: RPC_URL, // reads go through the SDK's own JSON-RPC client
  factory: FACTORY,
  chainId: arbitrum.id,
  prices: { token: process.env.PYTH_PRO_API_KEY }, // a server may hold the Pyth Pro key itself
});
const eth = await bz.markets.getMarket("ETH/USD");

const call = await bz.trade.createOrder(eth.address, account.address, {
  orderType: OrderType.Market,
  isLong: false,
  size: parseUnits18("0.1"),
  maxSlippageBp: 30n,
});

const sim = await bz.simulate(call);
if (!sim.ok) throw new Error(`would revert: ${sim.error!.message}`);

try {
  // Not toTransactionRequest(call): its `account` is the bare address, which would make viem ask the
  // node to sign (eth_sendTransaction). Leave `account` to the client's local account.
  const hash = await wallet.sendTransaction({ to: call.to, data: call.data, value: call.value });
  const receipt = await bz.waitForReceipt(hash);
  console.log(`${call.summary}: ${receipt.status} in block ${receipt.blockNumber}`);
} catch (e) {
  console.error(errorMessage(e));
}
// ANCHOR_END: local-key
