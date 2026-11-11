// The frontend side of a gasless call: the user signs, the relayer sends.
import { Bazaar, OrderType, errorMessage, orders, parseUnits18, relay, signing } from "@liberta-labs/bazaar-sdk";
import type { Address, Hex } from "viem";

const FACTORY: Address = "0x0000000000000000000000000000000000000000";
const RELAYER_URL = "https://relayer.example.com/relay";

const bz = await Bazaar.connect({ transport: window.ethereum, factory: FACTORY, prices: { token: pythToken } });
const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
const eth = await bz.markets.getMarket("ETH/USD");
const show = (text: string) => console.log(text);

// ANCHOR: submit
/** POST a signed request to the relayer at once: it is valid for at most 10 seconds. */
async function submit(req: relay.RelayedRequest): Promise<Hex> {
  const res = await fetch(RELAYER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: relay.serializeRelayed(req),
  });
  const body = (await res.json()) as { hash?: Hex; error?: string };
  if (!res.ok || !body.hash) throw new Error(body.error ?? `the relayer answered ${res.status}`);
  return body.hash;
}
// ANCHOR_END: submit

// ANCHOR: sign-order
try {
  const block = await bz.ctx.chain.blockNumber();
  const req = await bz.relay.signRelayed(
    {
      action: "createOrder",
      order: {
        orderType: OrderType.Limit,
        isLong: true,
        size: parseUnits18("0.5"),
        limitPrice: parseUnits18("2950"),
        expirationBlock: block + orders.blocksIn(24 * 60 * 60),
      },
    },
    {
      wallet: window.ethereum,
      signer: user,
      pair: eth.address,
      relayerFee: parseUnits18("0.05"), // what this relayer charges, in USDC, at most $1
      permit: true, // sign a USDC permit for the fee too, unless the allowance already covers it
    },
  );
  const hash = await submit(req);
  await bz.waitForReceipt(hash);
} catch (e) {
  // A declined signature or a clock problem is a SigningError, whose message is the sentence to show.
  show(e instanceof signing.SigningError ? e.message : errorMessage(e));
}
// ANCHOR_END: sign-order

// ANCHOR: sign-deposit
// A first deposit with no ETH and no approval: the permit covers the deposit plus the fee.
const deposit = await bz.relay.signRelayed(
  { action: "depositCollateral", amount: parseUnits18("100") },
  { wallet: window.ethereum, signer: user, pair: eth.address, relayerFee: parseUnits18("0.05"), permit: true },
);
await submit(deposit);
// ANCHOR_END: sign-deposit

// ANCHOR: other-actions
const cancel = await bz.relay.signRelayed({ action: "cancelOrders", orderIds: [42n] }, { wallet: window.ethereum, signer: user, pair: eth.address });

const amend = await bz.relay.signRelayed(
  { action: "amendOrders", amendments: [{ orderId: 42n, limitPrice: parseUnits18("2960"), size: parseUnits18("0.5") }] },
  { wallet: window.ethereum, signer: user, pair: eth.address, relayerFee: parseUnits18("0.02"), permit: true },
);

const withdraw = await bz.relay.signRelayed(
  { action: "withdrawCollateral", amount: parseUnits18("50") }, // the fee comes out of the payout: no permit
  { wallet: window.ethereum, signer: user, pair: eth.address, relayerFee: parseUnits18("0.05") },
);
// ANCHOR_END: other-actions

// ANCHOR: sequence
// Two requests in a row: sign both against consecutive nonces, submit in nonce order.
const next = await bz.signing.readMetaTxNonce(eth.address, user);
const first = await bz.relay.signRelayed({ action: "cancelOrders", orderIds: [7n] }, { wallet: window.ethereum, signer: user, pair: eth.address, nonce: next });
const second = await bz.relay.signRelayed({ action: "cancelOrders", orderIds: [8n] }, { wallet: window.ethereum, signer: user, pair: eth.address, nonce: next + 1n });
await submit(first);
await submit(second);
// ANCHOR_END: sequence

export { cancel, amend, withdraw };
