/**
 * The keeper's bootstrap from the subgraph: open positions, and live or bounty-holding orders, into
 * the Store, as of one block.
 *
 * Every page is pinned to that block, so the snapshot is what the chain held there. The keeper then
 * tails logs from the next block and re-reads candidates from the chain before acting, so a lagging
 * or wrong subgraph costs a wasted simulation, never a bad transaction.
 */

import { type Order, OrderType, type Position, type SubgraphClient, SubgraphError, TRIGGER_PRICE_MASK } from "@liberta-labs/bazaar-sdk";
import { type Address, getAddress } from "viem";
import type { Store } from "../state/store.js";

const POSITION_FIELDS = "pair { id } account { id } isLong size entryValue collateral entryFundingIndex";
const ORDER_FIELDS =
  "pair { id } orderId owner { id } orderType isLong size filledSize triggerPrice limitPrice expiryBlock status inBook bountyHeld";

interface PositionRow {
  id: string;
  pair: { id: string };
  account: { id: string };
  isLong: boolean;
  size: string;
  entryValue: string;
  collateral: string;
  entryFundingIndex: string;
}

interface OrderRow {
  id: string;
  pair: { id: string };
  orderId: string;
  owner: { id: string };
  orderType: string;
  isLong: boolean;
  size: string;
  filledSize: string;
  triggerPrice: string;
  limitPrice: string;
  expiryBlock: string;
  status: string;
  inBook: boolean | null;
  bountyHeld: string;
}

/** The subgraph's OrderType enum names are the contract's: Market, Limit, StopLimit, TakeProfit, StopLoss. */
function orderType(name: string): number {
  if (!Object.hasOwn(OrderType, name)) throw new SubgraphError(`the subgraph reports an unknown order type ${name}`);
  return OrderType[name as keyof typeof OrderType];
}

/**
 * Load open positions and live orders as of `block` into the store, for the markets it holds, and
 * return how many of each it loaded. Every query runs before anything is written, so a subgraph that
 * fails part-way (SubgraphError) leaves the store as it was.
 */
export async function bootstrap(
  subgraph: Pick<SubgraphClient, "pages">,
  store: Store,
  block: number,
): Promise<[positions: number, orders: number]> {
  const positions = await subgraph.pages<PositionRow>("positions", POSITION_FIELDS, "isOpen: true", block);
  const live = await subgraph.pages<OrderRow>("orders", ORDER_FIELDS, "status_in: [Waiting, Fired, Resting]", block);
  const held = await subgraph.pages<OrderRow>("orders", ORDER_FIELDS, 'status_in: [Filled, Canceled], bountyHeld_gt: "0"', block);

  // Checksumming costs a keccak; the same few pair ids repeat on every row.
  const pairs = new Map<string, Address>();
  const market = (id: string): Address | null => {
    let a = pairs.get(id);
    if (a === undefined) {
      a = getAddress(id);
      pairs.set(id, a);
    }
    return store.markets.has(a) ? a : null;
  };

  const newPositions: [Address, Position][] = [];
  const newOrders: [Address, Order][] = [];
  try {
    for (const r of positions) {
      const m = market(r.pair.id);
      if (m === null) continue;
      const account = getAddress(r.account.id);
      newPositions.push([
        m,
        {
          account,
          isLong: Boolean(r.isLong),
          size: BigInt(r.size),
          entryValue: BigInt(r.entryValue),
          collateral: BigInt(r.collateral),
          entryFundingIndex: BigInt(r.entryFundingIndex),
          block,
        },
      ]);
    }
    for (const r of [...live, ...held]) {
      const m = market(r.pair.id);
      if (m === null) continue;
      const terminal = r.status === "Filled" || r.status === "Canceled";
      newOrders.push([
        m,
        {
          orderId: BigInt(r.orderId),
          owner: getAddress(r.owner.id),
          orderType: orderType(r.orderType),
          isLong: Boolean(r.isLong),
          size: BigInt(r.size),
          filled: BigInt(r.filledSize),
          triggerPrice: BigInt(r.triggerPrice) & TRIGGER_PRICE_MASK,
          limitPrice: BigInt(r.limitPrice),
          expiryBlock: Number(BigInt(r.expiryBlock)),
          terminal,
          inBook: Boolean(r.inBook),
          bounty: BigInt(r.bountyHeld),
          block,
          known: true,
        },
      ]);
    }
  } catch (e) {
    if (e instanceof SubgraphError) throw e;
    throw new SubgraphError(`the subgraph returned a row the keeper cannot read: ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const [m, p] of newPositions) store.positionsOf(m).set(p.account, p);
  for (const [m, o] of newOrders) store.ordersOf(m).set(o.orderId, o);
  return [newPositions.length, newOrders.length];
}
