/**
 * Turn revert data into a named error and a sentence an operator can act on.
 *
 * {@link KEEPER_HINTS} are written for someone running the keeper. Frontends show
 * `DecodedError.message`, which prefers the user-facing text in `errors/messages.ts` and falls back
 * to the hint, then to the error's name.
 */

import { type Hex, decodeAbiParameters } from "viem";
import { allErrors } from "./codec.js";

const ERROR_STRING = "0x08c379a0"; // Error(string)
const PANIC = "0x4e487b71"; // Panic(uint256)

/**
 * What each error means for a keeper, and what to do about it. Errors not listed decode to their name
 * and arguments alone.
 */
export const KEEPER_HINTS: Readonly<Record<string, string>> = {
  "BazaarPair__LiquidationPriceTooOld":
    "The market is closed and its last stored price is more than 10 minutes old, so it cannot be used to seize collateral. Liquidation resumes when the market reopens and a fresh print exists.",
  "BazaarPair__NoPriceUpdatesProvided":
    "No fresh price was available: Pyth's on-chain cache was stale and the call carried no update. Check the price endpoint.",
  "BazaarPair__InsufficientPythFee":
    "The call did not send enough ETH for the Pyth update fee.",
  "BazaarPair__TradingHalted":
    "The market is halted: an ADL window is open, it is terminated, or its settlement price is fixed.",
  "BazaarPair__PairScheduledForTermination":
    "The market is within 6 seconds of, or past, its scheduled cutoff; nothing trades until the termination settles it.",
  "BazaarPair__SweepWindowActive":
    "The market's settlement window is open: only settlement (liquidate in settlement mode), finalizeTermination and claims work until it is finalized.",
  "BazaarPair__AdlNotPending":
    "No ADL window is open on this market.",
  "BazaarPair__AlreadyTerminated":
    "The market is already terminated.",
  "BazaarPair__AdlPriceStale":
    "ADL needs a fresh price; the market is closed or the print was stale.",
  "BazaarPair__EmptyLiquidationList":
    "No accounts were given to liquidate.",
  "AdlLib__NoEligibleWinners":
    "None of the accounts submitted is eligible at the auction's current threshold, and there was nothing to net. The threshold falls over 10 minutes; try again with higher-scoring accounts.",
  "AdlLib__TooManyWinners":
    "Each winner list is capped at 25 accounts.",
  "AdlLib__NoPendingLiquidations":
    "The vault holds no inventory to deleverage.",
  "MatchingEngineLib__BlockedOracleStale":
    "Trigger execution needs a fresh price; the market is closed.",
  "MatchingEngineLib__InvalidTriggerBatch":
    "A trigger batch must hold between 1 and 20 orders.",
  "BazaarOracle__ConfidenceTooHigh":
    "Pyth's confidence interval for this print is wider than 2% of the price, so the pair refuses it. Wait for a tighter print.",
  "BazaarOracle__InvalidPrice":
    "Pyth reported a non-positive price for this feed.",
  "BazaarOracle__SampleCountMismatch":
    "The settlement prints do not hold one update per leg for each of the five chain-rule samples.",
  "BazaarPairTerminator__TerminationTimeNotReached":
    "The market's scheduled cutoff has not passed yet.",
  "BazaarPairTerminator__NoScheduledTermination":
    "The market has no scheduled cutoff.",
  "BazaarPairTerminator__AlreadyTerminated":
    "The market's settlement price is already fixed.",
  "BazaarPairTerminator__OracleNotStaleEnough":
    "The oracle has printed within the last 21 days.",
  "BazaarPairTerminator__InsurerScheduleSettlesPair":
    "A vote-set cutoff has passed, so this market settles through terminateScheduledPair.",
  "BazaarPairTerminator__InsurerVerdictPending":
    "The vote that set the cutoff is waiting for UMA's verdict on its claim.",
  "BazaarPairTerminator__InsurerThresholdNotMet":
    "The vote has not reached its threshold and is still open.",
  "BazaarPairTerminator__InsurerNoActiveProposal":
    "That insurer proposal does not exist or is already resolved.",
  "BazaarPairTerminator__InsufficientPythFee":
    "The call did not send enough ETH for the Pyth fee.",
  "Factory__DeploymentNotExpired":
    "The listing proposal cannot be released yet.",
  "Factory__IdentifierUpgradeNotExpired":
    "The identifier-upgrade proposal cannot be released yet.",
  "Factory__IdentifierUpgradeTimelocked":
    "The queued identifier upgrade cannot activate yet.",
  "Factory__NoQueuedIdentifierUpgrade":
    "No identifier upgrade is queued.",
  "Factory__NoPendingIdentifierUpgrade":
    "No identifier upgrade is pending.",
  "Factory__ProposalAlreadyResolved":
    "That proposal is already resolved.",
  "Factory__ProposalNotFound":
    "No proposal has that assertion id.",
};

const TIME_ARGS = new Set(["deadline", "effectiveTs", "expiryTs", "opensAt", "scheduledTs"]);

/** User-facing messages, registered by errors/messages.ts so this module stays small for the keeper. */
const userMessages = new Map<string, (args: Record<string, unknown>) => string>();

export function registerUserMessages(m: Readonly<Record<string, string | ((args: Record<string, unknown>) => string)>>): void {
  for (const [k, v] of Object.entries(m)) userMessages.set(k, typeof v === "string" ? () => v : v);
}

export class DecodedError {
  constructor(
    readonly name: string,
    readonly args: Record<string, unknown>,
    /** The operator-facing hint, or "". */
    readonly hint: string,
    readonly data: Hex,
  ) {}

  /** For a "too early" error, the time the call opens. */
  opensAt(): number | null {
    for (const [k, v] of Object.entries(this.args)) {
      if (TIME_ARGS.has(k) && (typeof v === "bigint" || typeof v === "number")) return Number(v);
    }
    return null;
  }

  /** The text to show an end user: a user message when one is registered, else the hint, else the name. */
  get message(): string {
    const m = userMessages.get(this.name);
    if (m) return m(this.args);
    return this.hint || this.name;
  }

  toString(): string {
    const args = Object.entries(this.args)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(", ");
    const head = args ? `${this.name}(${args})` : this.name;
    return this.hint ? `${head}: ${this.hint}` : head;
  }
}

export function decodeError(data: Hex | null | undefined): DecodedError {
  const d = (data ?? "0x").toLowerCase() as Hex;
  if (d.length < 10) {
    return new DecodedError("Reverted", {}, "The call reverted without a reason (often out of gas).", d);
  }
  const sel = d.slice(0, 10) as Hex;
  const body = ("0x" + d.slice(10)) as Hex;
  if (sel === ERROR_STRING) {
    let msg: string;
    try {
      msg = decodeAbiParameters([{ type: "string" }], body)[0];
    } catch {
      msg = body;
    }
    return new DecodedError("Error", { message: msg }, msg, d);
  }
  if (sel === PANIC) {
    let code = -1n;
    try {
      code = decodeAbiParameters([{ type: "uint256" }], body)[0];
    } catch {
      /* keep -1 */
    }
    return new DecodedError("Panic", { code }, `Solidity panic 0x${code.toString(16)}.`, d);
  }
  const spec = allErrors().get(sel);
  if (!spec) return new DecodedError(`Unknown(${sel})`, {}, "An error this package's ABIs do not declare.", d);
  let args: Record<string, unknown> = {};
  try {
    const raw = decodeAbiParameters(spec.inputs, body) as readonly unknown[];
    spec.inputs.forEach((p, i) => (args[p.name || `arg${i}`] = raw[i]));
  } catch {
    args = {};
  }
  return new DecodedError(spec.name, args, KEEPER_HINTS[spec.name] ?? "", d);
}
