// Quick start, frontend: src/main.ts of a plain Vite page (no framework). The page's HTML is on
// the quick-start page; this file is the whole script.
import {
  Bazaar,
  type account,
  allowance,
  CallError,
  OrderType,
  type PreparedCall,
  UnitError,
  cachedToken,
  errorMessage,
  formatUnits18,
  type markets,
  orders,
  parseUnits18,
} from "@liberta-labs/bazaar-sdk";
import { type Address, getAddress, toHex } from "viem";

// ANCHOR: config
const FACTORY: Address = "0x0000000000000000000000000000000000000000"; // from Bazaar's deployments page
const CHAIN_ID = 421614; // Arbitrum Sepolia
const TOKEN_URL = "/api/pyth-token"; // your backend mints short-lived Pyth Pro tokens: never a Pyth key in a bundle
const pythToken = cachedToken(() => fetch(TOKEN_URL).then((r) => r.json())); // answers { token, expiresAt }
// ANCHOR_END: config

// ANCHOR: helpers
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (text: string) => {
  el("status").textContent = text; // textContent, never innerHTML: chain and subgraph strings are untrusted
};

/** Run a click handler, showing any failure as one sentence for the user. */
function run(task: () => Promise<void>): void {
  task().catch((e: unknown) => {
    console.error(e);
    status(e instanceof UnitError ? "Enter amounts as plain numbers, like 12.5." : errorMessage(e));
  });
}

let bz: Bazaar;
let user: Address;
let market: markets.MarketInfo;
// ANCHOR_END: helpers

// ANCHOR: connect
async function connect(): Promise<void> {
  const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
  user = getAddress(accounts[0]!);
  // Ask the wallet for the right network first: connect() refuses any other chain.
  await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(CHAIN_ID) }] });
  bz = await Bazaar.connect({ transport: window.ethereum, factory: FACTORY, chainId: CHAIN_ID, prices: { token: pythToken } });
  status(`Connected as ${user}`);
}
// ANCHOR_END: connect

// ANCHOR: markets
async function showMarkets(): Promise<void> {
  const list = await bz.markets.listMarkets(); // every market the factory deployed, labelled; cached
  const snaps = await bz.markets.marketSnapshots(list); // their live state, read in one batch
  const select = el<HTMLSelectElement>("market");
  select.replaceChildren(
    ...list.map((m) => {
      const s = snaps.get(m.address);
      const price = s ? formatUnits18(s.price.spot, 2) : "?";
      return new Option(`${m.label}  ${price}  ${s?.status ?? ""}  (${m.hours})`, m.address);
    }),
  );
  market = list[0]!;
}
// ANCHOR_END: markets

// ANCHOR: position
async function showPosition(): Promise<void> {
  render(await bz.account.accountSnapshot(market, user)); // one market, one account, two batched reads
}

function render(me: account.AccountSnapshot): void {
  const p = me.position;
  const lines = [
    `${market.label}: ${me.status}`,
    `Collateral: ${formatUnits18(p.collateral, 2)} USDC (withdrawable now: ${formatUnits18(me.maxWithdrawable, 2)})`,
  ];
  if (me.hasPosition && me.health) {
    lines.push(
      `Position: ${p.isLong ? "long" : "short"} ${formatUnits18(p.size)} at ${formatUnits18(p.entryPrice, 2)}`,
      `PnL: ${formatUnits18(me.health.totalPnl, 2)} at ${formatUnits18(me.health.price, 2)}, margin ratio ${me.health.marginRatio.toFixed(2)}`,
    );
  } else {
    lines.push("No position");
  }
  for (const o of me.orders) {
    lines.push(`Order #${o.orderId}: ${o.typeName} ${o.isLong ? "buy" : "sell"} ${formatUnits18(o.remaining)} at ${formatUnits18(o.limitPrice, 2)}`);
  }
  if (me.withdrawalBlocked) lines.push(me.withdrawalBlocked);
  el("position").textContent = lines.join("\n");
}
// ANCHOR_END: position

// ANCHOR: send
/** Simulate as the user, then let the wallet sign and send, then wait for the receipt. */
async function simulateAndSend(call: PreparedCall): Promise<void> {
  const sim = await bz.simulate(call);
  if (!sim.ok) throw new CallError(sim.error!.message, sim.error); // errorMessage() shows its sentence
  status(`Confirm in your wallet: ${call.summary}`);
  const hash = await bz.send(window.ethereum, call);
  status(`Waiting for ${hash}...`);
  await bz.waitForReceipt(hash); // throws CallError if it reverted
  status(`Done: ${call.summary}`);
}
// ANCHOR_END: send

// ANCHOR: deposit
async function deposit(amountText: string): Promise<void> {
  const amount = parseUnits18(amountText); // dollars, 18 decimals
  const funding = await bz.allowance.usdcFunding(user, market.address, amount);
  if (!funding.enoughBalance) {
    const has = allowance.formatUsdcUnits(funding.balance); // USDC's own units: 6 decimals
    return status(`This wallet holds ${has} USDC; the deposit needs ${allowance.formatUsdcUnits(funding.needUsdc)}.`);
  }
  // Each market pulls its own collateral: approve exactly what this deposit needs, if the allowance is short.
  if (funding.approveUsdc > 0n) await simulateAndSend(await bz.allowance.approveUsdc(user, market.address, funding.approveUsdc));
  await simulateAndSend(await bz.trade.depositCollateral(market.address, user, amount));
}
// ANCHOR_END: deposit

// ANCHOR: order
async function placeLimitOrder(side: string, sizeText: string, priceText: string): Promise<void> {
  const order = {
    orderType: OrderType.Limit,
    isLong: side === "buy",
    size: parseUnits18(sizeText),
    limitPrice: parseUnits18(priceText),
    expirationBlock: (await bz.ctx.chain.blockNumber()) + orders.blocksIn(24 * 3600), // a day of L2 blocks
  };
  // createOrder checks the order as the pair will, and attaches a Pyth print the pair accepts for
  // 3 s: build it right before the wallet prompt, and rebuild it if simulating took too long.
  let call = await bz.trade.createOrder(market.address, user, order);
  const sim = await bz.simulate(call);
  if (!sim.ok) throw new CallError(sim.error!.message, sim.error);
  if (Date.now() / 1000 - (call.priceTime ?? 0) > 2) call = await bz.trade.createOrder(market.address, user, order);
  status(`Confirm in your wallet: ${call.summary}`);
  await bz.waitForReceipt(await bz.send(window.ethereum, call));
  status(`Placed: ${call.summary}`);
}
// ANCHOR_END: order

// ANCHOR: wire
const form = (id: string) => new FormData(el<HTMLFormElement>(id));

el("connect").addEventListener("click", () =>
  run(async () => {
    await connect();
    await showMarkets();
    await showPosition();
    follow();
  }),
);
el<HTMLSelectElement>("market").addEventListener("change", (e) =>
  run(async () => {
    market = await bz.markets.getMarket((e.target as HTMLSelectElement).value as Address);
    await showPosition();
    follow();
  }),
);
el<HTMLFormElement>("deposit").addEventListener("submit", (e) => {
  e.preventDefault();
  run(async () => {
    await deposit(String(form("deposit").get("amount")));
    await showPosition();
  });
});
el<HTMLFormElement>("order").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = form("order");
  run(async () => {
    await placeLimitOrder(String(f.get("side")), String(f.get("size")), String(f.get("price")));
    await showPosition();
  });
});
// ANCHOR_END: wire

// ANCHOR: watch
// Keep the position current. Events for this account (fills, orders, collateral) and a
// timer refresh both re-read the snapshot; call stop() when the view goes away.
let watch: { stop(): void } | null = null;
function follow(): void {
  watch?.stop();
  watch = bz.live.watchAccount(user, [market], (u) => {
    if (u.type === "account") render(u.snapshot);
    if (u.type === "error") console.warn("live updates:", u.error);
  });
}
// ANCHOR_END: watch
