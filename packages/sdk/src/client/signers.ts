/**
 * Whether Pyth trusts the signer of a price update, asked of the verifier contract a deployment
 * verifies its updates with.
 *
 * BazaarOracle has every update verified by Pyth's verifier (`pythLazer()`), which accepts one signed
 * by any signer in its current set. Asking the same contract before an update is used means the SDK
 * shows and acts on the prices a call could carry: an update signed by a key the verifier has never
 * trusted never becomes a print. Answers are cached, so a signer the verifier has just dropped is still
 * accepted until its "trusted" answer is refreshed (at most `maxAge` seconds); the chain refuses
 * whatever it signs meanwhile.
 */

import type { Abi, Address } from "viem";
import { getAddress } from "viem";
import type { Chain } from "../chain/client.js";
import { ContractCodec, oracle as oracleCodec } from "../chain/codec.js";
import type { SignerCheck } from "../prices/pro.js";

/** The verifier's signer view. It is not part of the interface BazaarOracle calls, so it is declared here. */
export const VERIFIER_SIGNER_ABI = [
  {
    type: "function",
    name: "isValidSigner",
    stateMutability: "view",
    inputs: [{ name: "signer", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

let verifierCodec: ContractCodec | null = null;
const V = () => (verifierCodec ??= new ContractCodec(VERIFIER_SIGNER_ABI as unknown as Abi));

export interface VerifierSignerCheckOptions {
  /** Seconds an answer is used before the verifier is asked again; default 60. */
  ttl?: number;
  /**
   * Seconds a "trusted" answer may still be used while it is being asked again; default 600. Within
   * it an update is not held up for the read, and a failed read changes nothing; past it the answer
   * must be confirmed before it is used. Pyth changes its signer set rarely, and a signer it has
   * since dropped is refused by the chain whatever this says.
   */
  maxAge?: number;
  /** The clock both ages are measured on, in seconds; default a monotonic one. */
  clock?: () => number;
}

/** How many signers' answers are kept: Pyth signs with a handful, and anything else is an endpoint misbehaving. */
const MAX_SIGNERS = 32;

interface Answer {
  ok: boolean;
  at: number;
  asking: Promise<boolean> | null;
}

/**
 * A {@link SignerCheck} that asks `oracle`'s verifier whether it trusts a signer (`isValidSigner`),
 * keeping each answer for `ttl` seconds. A "not trusted" answer is asked again once it is that old;
 * a "trusted" one is refreshed in the background (see `maxAge`). Rejects when the verifier cannot be
 * read and no usable answer is held: the caller then treats the update as unconfirmed, not as trusted.
 */
export function verifierSignerCheck(chain: Chain, oracle: Address, opts: VerifierSignerCheckOptions = {}): SignerCheck {
  const ttl = opts.ttl ?? 60;
  const maxAge = Math.max(ttl, opts.maxAge ?? 600);
  const clock = opts.clock ?? (() => performance.now() / 1000);
  const answers = new Map<Address, Answer>();
  let verifier: Promise<Address> | null = null;

  /** The verifier's address: immutable on the oracle, so read once (again after a failed read). */
  const verifierAddress = (): Promise<Address> => {
    if (verifier === null) {
      const oc = oracleCodec();
      const p = chain.call(oracle, oc.encode("pythLazer")).then((data) => getAddress(oc.decode<Address>("pythLazer", data)));
      p.catch(() => {
        if (verifier === p) verifier = null;
      });
      verifier = p;
    }
    return verifier;
  };

  const ask = (signer: Address, held: Answer | undefined): Promise<boolean> => {
    if (held?.asking) return held.asking;
    const p = (async () => {
      const to = await verifierAddress();
      return V().decode<boolean>("isValidSigner", await chain.call(to, V().encode("isValidSigner", signer))) === true;
    })();
    const entry: Answer = held ?? { ok: false, at: Number.NEGATIVE_INFINITY, asking: null };
    entry.asking = p;
    if (!held) {
      if (answers.size >= MAX_SIGNERS) answers.delete(answers.keys().next().value as Address);
      answers.set(signer, entry);
    }
    p.then(
      (ok) => {
        entry.ok = ok;
        entry.at = clock();
        entry.asking = null;
      },
      () => {
        entry.asking = null;
        if (entry.at === Number.NEGATIVE_INFINITY && answers.get(signer) === entry) answers.delete(signer);
      },
    );
    return p;
  };

  return (signer) => {
    const key = getAddress(signer);
    const held = answers.get(key);
    if (held === undefined) return ask(key, undefined);
    const age = clock() - held.at;
    if (age < ttl) return held.ok;
    if (held.ok && age < maxAge) {
      ask(key, held).catch(() => undefined); // refreshed in the background; a failed read keeps the held answer
      return true;
    }
    return ask(key, held);
  };
}
