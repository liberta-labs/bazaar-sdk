/**
 * The check every write builder makes before it names a pair: that the address is one of this
 * deployment's pairs.
 *
 * A pair address reaches a frontend from a link, a query string, a subgraph row or a market list, so
 * it is untrusted. A builder that took it on faith would show "Deposit 1000 USDC" for a call to any
 * contract, approve it as a USDC spender, or have the user sign a permit or a gasless request for it.
 * {@link requirePair} asks the deployment's factory (`factory.isPair`), the one registry of its pairs,
 * and refuses anything else before a call is built or a signature is asked for.
 */

import { type Address, getAddress } from "viem";
import { factory as factoryCodec } from "../chain/codec.js";
import { InputError } from "./calls.js";
import type { BazaarContext } from "./context.js";

const confirmed = new WeakMap<BazaarContext, Map<Address, Promise<Address>>>();

/**
 * `pair`, checksummed, once the context's factory confirms it is one of its pairs
 * (`factory.isPair`); an {@link InputError} on `pair` otherwise. Cached per context: one read per
 * pair per connection, so repeated builds cost nothing. A refusal or a failed read is not cached,
 * so a pair listed later, or a read that failed for a moment, is asked again.
 */
export function requirePair(ctx: BazaarContext, pair: Address): Promise<Address> {
  let addr: Address;
  try {
    addr = getAddress(pair);
  } catch {
    return Promise.reject(new InputError("pair", "That is not a market address."));
  }
  let known = confirmed.get(ctx);
  if (!known) confirmed.set(ctx, (known = new Map()));
  const cached = known.get(addr);
  if (cached) return cached;
  const fc = factoryCodec();
  const check = ctx.chain.call(ctx.factory, fc.encode("isPair", addr)).then((data) => {
    if (fc.decode<boolean>("isPair", data) !== true) {
      throw new InputError("pair", `${addr} is not a market of this Bazaar deployment, so nothing will be built or signed for it. Check the link or the market you chose.`);
    }
    return addr;
  });
  const map = known;
  check.catch(() => {
    if (map.get(addr) === check) map.delete(addr);
  });
  map.set(addr, check);
  return check;
}
