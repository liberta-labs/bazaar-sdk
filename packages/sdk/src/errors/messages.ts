/**
 * Messages for traders and LPs: one for every custom error the five Bazaar contracts declare, saying
 * what happened and what to do, with the error's arguments formatted (BAZAAR-precision amounts as
 * dollars, prices with their decimals, basis points as percent, times as dates with a relative hint).
 *
 * Importing this module registers them with chain/errors.ts, so `DecodedError.message` returns them;
 * {@link installUserMessages} does the same explicitly (bundlers may drop a module imported only for
 * its side effect). {@link walletErrorMessage} explains failures the wallet raises before anything
 * reaches the chain, and {@link errorMessage} picks the right text for any error a call can throw.
 */

import { DecodedError, decodeError, registerUserMessages } from "../chain/errors.js";
import { toRpcError } from "../chain/rpc.js";
import { BAZAAR_SCALE } from "../constants.js";
import { formatDecimal } from "../client/units.js";

type Args = Record<string, unknown>;
type Message = string | ((a: Args) => string);

// =====================================================================================================
// Formatting
// =====================================================================================================

const big = (v: unknown): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
};
const groups = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A BAZAAR-precision amount as dollars: "$1,234.56"; amounts under a cent keep six decimals. */
export function formatUsd(v: unknown): string {
  const x = big(v);
  const neg = x < 0n;
  const a = neg ? -x : x;
  const small = a > 0n && a < BAZAAR_SCALE / 100n;
  const s = formatDecimal(a, 18, small ? 6 : 2);
  const [w = "0", f = ""] = s.split(".");
  const frac = small ? f : f.padEnd(2, "0");
  return `${neg ? "-" : ""}$${groups(w)}${frac ? "." + frac : ""}`;
}

/** A BAZAAR-precision price: "$3,012.5", "$1.08765", "$0.00001234". */
export function formatPrice(v: unknown): string {
  const x = big(v);
  const a = x < 0n ? -x : x;
  const dp = a >= 1000n * BAZAAR_SCALE ? 2 : a >= BAZAAR_SCALE ? 5 : 8;
  const [w = "0", f = ""] = formatDecimal(a, 18, dp).split(".");
  const frac = dp === 2 ? f.padEnd(2, "0") : f;
  return `${x < 0n ? "-" : ""}$${groups(w)}${frac ? "." + frac : ""}`;
}

/** A BAZAAR-precision quantity (size, shares): "1.25", "12,000". */
export function formatAmount(v: unknown, maxDecimals = 6): string {
  const s = formatDecimal(big(v), 18, maxDecimals);
  const [w = "0", f] = s.split(".");
  return `${groups(w)}${f ? "." + f : ""}`;
}

/** Basis points as percent: 250 -> "2.5%". */
export function formatBp(v: unknown): string {
  const x = big(v);
  return `${formatDecimal(x, 2, 2)}%`;
}

/** Wei as ETH: "0.0001 ETH". */
export function formatEth(v: unknown): string {
  return `${formatDecimal(big(v), 18, 8)} ETH`;
}

/** A duration in seconds, roughly: "45 s", "12 min", "3 h", "13 days". */
export function formatDuration(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

/** A Unix time (seconds) as "2026-11-08 14:00 UTC (in 3 h)". */
export function formatTime(v: unknown, now: number = Date.now() / 1000): string {
  const t = Number(big(v));
  if (!Number.isFinite(t) || t <= 0) return "an unknown time";
  const d = new Date(t * 1000);
  if (Number.isNaN(d.getTime())) return "an unknown time";
  const iso = d.toISOString();
  const abs = `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  const delta = t - now;
  const rel = Math.abs(delta) < 1 ? "now" : delta > 0 ? `in ${formatDuration(delta)}` : `${formatDuration(delta)} ago`;
  return `${abs} (${rel})`;
}

const usd = formatUsd;
const price = formatPrice;
const amount = formatAmount;
const pct = formatBp;
const when = (v: unknown) => formatTime(v);
const id = (v: unknown) => `#${big(v).toString()}`;
const short = (v: unknown) => {
  const s = String(v ?? "");
  return /^0x[0-9a-fA-F]{12,}$/.test(s) ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
};

const VAULT_REASONS: Readonly<Record<number, string>> = {
  1: "the fund's exposure to liquidated positions is larger than it can cover",
  2: "an auto-deleveraging ran past its timeout",
  3: "the market's USDC balance is short of its books",
  4: "the market has realized bad debt",
};

// =====================================================================================================
// The messages
// =====================================================================================================

const HALTED = "This market is paused: auto-deleveraging is in progress, or the market is closing or has been wound down. Trading and insurance deposits resume once it clears.";
const ADL_WITHDRAW_FREEZE =
  "While auto-deleveraging is in progress you cannot withdraw collateral from an open position. It reopens when the market recovers; if it does not within 24 hours, the market winds down and settles.";
const LIMBO = "This market is closing: trading, deposits and withdrawals stopped just before its scheduled closing time, and positions will settle at the final price.";
const SIGN_AGAIN = "The signature does not match this request. Sign it again.";
const OVERFLOW = "A number in this request is too large for the market to store. Use a smaller amount.";
const MATH = "The market could not complete a calculation for this request. Try a different amount, or try again after the next price update.";
const NOT_YOURS = "Only the Bazaar contracts themselves can make this call.";
const ZERO_ADDRESS = "A required address was empty.";

/** Every custom error's user-facing message, by error name. */
export const USER_MESSAGES: Readonly<Record<string, Message>> = {
  // ---- BazaarPair ----
  BazaarPair__AdlNotPending: "No auto-deleveraging is in progress on this market, so there is nothing to execute.",
  BazaarPair__AdlPriceStale: "Auto-deleveraging needs a fresh price and none was available (the market may be closed). Retry with a current price update.",
  BazaarPair__AlreadyTerminated: "This market's final price is already fixed, or it has been wound down.",
  BazaarPair__AmountLteRelayerFee: "The amount paid out would not cover the relayer's fee. Withdraw more, or send the transaction yourself.",
  BazaarPair__EmptyLiquidationList: "No accounts were given to liquidate.",
  BazaarPair__EthRefundFailed: "The market could not refund the unused ETH to the sender. Send exactly the price-update fee, or send from an address that accepts ETH.",
  BazaarPair__ExceedsMaxCancelsPerCall: "Cancel between 1 and 200 orders per transaction.",
  BazaarPair__InsufficientPythFee: "Not enough ETH was sent for the price update's fee. Rebuild the transaction so it carries the current fee.",
  BazaarPair__InsuranceDepositRequiresFreshPrice:
    "While the market holds liquidated positions, an insurance deposit needs a live price, and the market is closed. Try again when it reopens.",
  BazaarPair__InsuranceWithdrawalRequiresFreshPrice: "An insurance withdrawal needs a live price, and the market is closed. Try again when it reopens.",
  BazaarPair__LiquidationPriceTooOld:
    "The market is closed and its last price is more than 10 minutes old, so nobody can be liquidated on it. Liquidations resume when the market reopens.",
  BazaarPair__NoPriceUpdatesProvided: "No fresh price was available for this market. Rebuild the transaction with a current price update and send it right away.",
  BazaarPair__OnlyUma: "Only Bazaar's termination contract can do this.",
  BazaarPair__PairScheduledForTermination: LIMBO,
  BazaarPair__RelayerFeeExceedsDeposit: "The relayer's fee is as large as the deposit. Deposit more, or send the transaction yourself.",
  BazaarPair__RequestorIsNotOrderOwner: "You can only cancel your own orders.",
  BazaarPair__SeedBelowMinimum: "A new market needs at least $3,000 of insurance seed.",
  BazaarPair__SweepWindowActive:
    "This market's final price is fixed and its positions are being settled. Withdrawals, deposits and trading wait until settlement is finalized, within 14 days of the price being fixed.",
  BazaarPair__TerminationAlreadyScheduled: "This market already has a closing time scheduled, and the new one is not earlier.",
  BazaarPair__TradingFrozenAdlPending: HALTED,
  BazaarPair__TradingHalted: HALTED,
  BazaarPair__TransferFailed: "The transfer could not be made: an address was empty.",
  BazaarPair__UnauthorizedInsuranceCreditor: "Only Bazaar's termination contract can credit this insurance fund.",
  BazaarPair__WithdrawalsFrozenAdlPending: ADL_WITHDRAW_FREEZE,
  BazaarPair__ZeroAddress: ZERO_ADDRESS,
  InvalidInitialization: "This market is already set up.",
  NotInitializing: "This market is not being set up.",
  ReentrancyGuardReentrantCall: "The market refused a call made from inside another of its calls. Send it as its own transaction.",
  SafeERC20FailedOperation: "The USDC transfer failed. Check your USDC balance and that this market is approved to spend it (or sign a permit).",

  // ---- AdlLib ----
  AdlLib__EmptySubmission: "No accounts were given to deleverage.",
  AdlLib__NoEligibleWinners:
    "None of the accounts given can be deleveraged at the auction's current threshold, and there was nothing to net. The threshold falls over 10 minutes; try higher-scoring accounts or wait.",
  AdlLib__NoPendingLiquidations: "There are no liquidated positions left to deleverage.",
  AdlLib__TooManyWinners: (a) => `${big(a.count)} accounts were given for one side; a batch takes at most ${big(a.max)} per side.`,

  // ---- BazaarMathLib / SafeCast ----
  BazaarMathLib__DivisionByZero: MATH,
  BazaarMathLib__OperandTooSmall: MATH,
  BazaarMathLib__ResultOverflow: OVERFLOW,
  SafeCastOverflowedUintDowncast: OVERFLOW,
  SafeCastOverflowedUintToInt: OVERFLOW,
  SafeCastOverflowedIntDowncast: OVERFLOW,
  SafeCastOverflowedIntToUint: OVERFLOW,

  // ---- CollateralLib ----
  CollateralLib__ClaimTransferFailed: "The market could not send your claimable balance (USDC refused the transfer). Check that your address can receive USDC.",
  CollateralLib__DepositsAreBlocked: "This market has been wound down and takes no new deposits.",
  CollateralLib__InsolventPositionBucket: (a) =>
    `Your position is below its maintenance margin (equity ${usd(a.availableEquity)}, required ${usd(a.minRequiredCollateral)}), so nothing can be withdrawn. Add collateral or reduce the position.`,
  CollateralLib__InsufficientCollateral: (a) => `You asked for ${usd(a.amount)}, but only ${usd(a.available)} is available.`,
  CollateralLib__InsufficientMarginAfterWithdrawal: (a) =>
    `Withdrawing ${usd(a.amount)} would leave less than the ${usd(a.available)} of initial margin your position and open orders need. Withdraw less, or reduce the position or cancel orders first.`,
  CollateralLib__InvalidDepositAmount: (a) => `Deposits must be at least ${usd(a.minAmount)}.`,
  CollateralLib__LedgerShortfall: (a) =>
    `The market can pay out ${usd(a.available)} right now. The rest of the ${usd(a.amount)} you asked for frees up as the vault sells the positions it took over in liquidations. Withdraw ${usd(a.available)} now and the rest later.`,
  CollateralLib__MustRetainMinimumCollateral: (a) =>
    `With a position open you must keep ${usd(a.minimum)} of collateral (unrealized profit does not count); this withdrawal would leave ${usd(a.remaining)}. Withdraw less or reduce the position.`,
  CollateralLib__NoPriceUpdateDataProvided: "Withdrawing from an open position needs a current price. Rebuild the transaction with a price update.",
  CollateralLib__NothingToClaim: "You have nothing to claim on this market.",
  CollateralLib__PairScheduledForTermination: LIMBO,
  CollateralLib__WithdrawalBlockedVaultUnhealthy:
    "Withdrawals are paused: the market's books show a shortfall, so it will settle everyone together at one price instead of paying whoever withdraws first. Wait for the settlement.",
  CollateralLib__WithdrawalRequiresFreshPrice:
    "The market is closed, so collateral backing an open position cannot be withdrawn until it reopens. Deposits stay open, and accounts without a position are not affected.",
  CollateralLib__WithdrawalsFrozenAdlPending: ADL_WITHDRAW_FREEZE,
  CollateralLib__ZeroWithdrawalAmount: "Enter an amount to withdraw.",

  // ---- InsuranceVaultLib ----
  InsuranceVaultLib__AdlBlocking:
    "Insurance deposits and withdrawals are paused while the fund's losses on liquidated positions exceed what it can spare (auto-deleveraging is due or running). Try again once that clears.",
  InsuranceVaultLib__ClaimNotOpen: (a) => `Your insurance withdrawal is locked in; the payout opens ${when(a.claimOpensTs)}.`,
  InsuranceVaultLib__CooldownNotElapsed: "An insurance withdrawal can be executed 13 days after it was requested. Try again then.",
  InsuranceVaultLib__DepositAboveMaximum: (a) => `That deposit is larger than the ${usd(a.maximum)} maximum.`,
  InsuranceVaultLib__DepositBelowMinimum: (a) => `Insurance deposits must be at least ${usd(a.minimum)}.`,
  InsuranceVaultLib__DepositTooSmall: "That deposit is too small to buy any insurance shares. Deposit more.",
  InsuranceVaultLib__ExceedsShares: "You do not hold that many insurance shares.",
  InsuranceVaultLib__FundCommittedToInventory:
    "All of the insurance fund is committed to positions taken over in liquidations, so its shares cannot be priced right now. Try again once those are sold.",
  InsuranceVaultLib__LockTooLate: (a) =>
    `Your withdrawal window closes ${when(a.windowEndTs)}, before the payout could open (${when(a.claimOpensTs)}). File a new withdrawal request.`,
  InsuranceVaultLib__NoWithdrawalRequest: "Request an insurance withdrawal first; it can be executed after a 13-day cooldown.",
  InsuranceVaultLib__PairScheduledForTermination: (a) =>
    `This market closes ${when(a.scheduledTs)}; insurance deposits and withdrawals are paused until it has settled.`,
  InsuranceVaultLib__PairTerminated: "This market has been wound down and takes no new insurance deposits.",
  InsuranceVaultLib__RateLimitExceeded:
    "Insurance withdrawals on this market are rate-limited, and this period's allowance is used up. Withdraw less, or wait for the period to reset.",
  InsuranceVaultLib__SharesLockedForVoting: "Some of your shares back an open termination vote and stay locked until it resolves. Request fewer shares.",
  InsuranceVaultLib__SweepIncomplete: (a) =>
    `The market's positions are still being settled. Insurance redemptions open when they are, or ${when(a.releaseTs)} at the latest.`,
  InsuranceVaultLib__TooManyRecentInsuranceDeposits: (a) =>
    `You have made ${big(a.windowCount)} insurance deposits on this market in the last 4 days; the limit is ${big(a.cap)}. Wait, or make fewer, larger deposits.`,
  InsuranceVaultLib__VaultUnhealthy: (a) =>
    `Insurance withdrawals are paused because ${VAULT_REASONS[Number(big(a.reason))] ?? "the market is unhealthy"}. Try again once it recovers or settles.`,
  InsuranceVaultLib__WithdrawalRequestStaleEpoch: "Your withdrawal request predates a reset of the insurance fund and no longer applies. File a new one.",
  InsuranceVaultLib__WithdrawalWindowExpired: "The window to execute your insurance withdrawal has closed. File a new request (a new cooldown applies).",
  InsuranceVaultLib__ZeroDeposit: "Enter an amount to deposit.",
  InsuranceVaultLib__ZeroShares: "Enter a number of shares.",

  // ---- MatchingEngineLib / OrderBookLib ----
  MatchingEngineLib__BlockedOracleStale:
    "The market is closed: market, stop-loss and take-profit orders need a live price. Use a limit order, or wait for the market to reopen.",
  MatchingEngineLib__FillOrKillUnfilled: (a) =>
    `The book could not fill the whole order (${amount(a.remaining)} short), so nothing was traded. Try a smaller size or a wider price.`,
  MatchingEngineLib__InvalidTriggerBatch: (a) => `Execute between 1 and 20 trigger orders per call (${big(a.count)} given).`,
  OrderBookLib__AlreadyInBook: (a) => `Order ${id(a.orderId)} is already in the book.`,
  OrderBookLib__HintRepairExhausted: (a) =>
    `The book changed too much to place order ${id(a.orderId)} from the position hints given. Rebuild the transaction and try again.`,

  // ---- signatures ----
  ECDSAInvalidSignature: SIGN_AGAIN,
  ECDSAInvalidSignatureLength: SIGN_AGAIN,
  ECDSAInvalidSignatureS: SIGN_AGAIN,
  MetaTx__DeadlineTooFar: "The signature's deadline is too far ahead: it may be at most 10 seconds away. Sign again just before sending.",
  MetaTx__ExpiredDeadline: "The signature expired before the transaction landed. Sign again and send right away.",
  MetaTx__InvalidNonce: (a) => `This signature was already used or is out of order (the next nonce is ${big(a.expected)}). Sign the request again.`,
  MetaTx__InvalidSignature: SIGN_AGAIN,
  MetaTx__RelayerFeeExceedsMax: (a) => `The relayer fee of ${usd(a.fee)} is above the ${usd(a.max)} maximum.`,

  // ---- OrderManagementLib ----
  OrderManagementLib__AmendSizeNotAboveFilled: (a) => `Order ${id(a.orderId)} has already filled that much. Choose a larger size, or cancel the rest.`,
  OrderManagementLib__AmendTooCloseToExpiry: (a) =>
    `Order ${id(a.orderId)} expires too soon to be moved (block ${big(a.expiryBlock)}; it must live until at least block ${big(a.minExpiryBlock)}). Cancel it and place a new one.`,
  OrderManagementLib__AmendWouldCross: (a) =>
    `Moving order ${id(a.orderId)} to ${price(a.limitPrice)} would cross the best opposite order at ${price(a.oppositeBest)}. Choose a price that does not cross.`,
  OrderManagementLib__BountyNotWholeUsdc: "The keeper bounty must be a whole number of micro-USDC (six decimals).",
  OrderManagementLib__BountyOnUntriggeredType: "Only stop-limit, stop-loss and take-profit orders can carry a keeper bounty.",
  OrderManagementLib__InsufficientMarginAfterOrder: (a) =>
    `This order needs ${usd(a.required)} of collateral (initial margin on your position and open orders, plus what fills will cost); you have ${usd(a.marginRatio)}. Deposit more or reduce the size.`,
  OrderManagementLib__InvalidAmendBatch: "The amendment list is malformed: it must hold 1 to 32 orders, each with a valid id.",
  OrderManagementLib__InvalidOrderExpiration: "The order expires too soon: a resting order must live at least 240 blocks (about a minute).",
  OrderManagementLib__InvalidOrderType: "That is not an order type this market accepts.",
  OrderManagementLib__InvalidSlippage: (a) => `Set a slippage limit between 0.01% and 10% (${pct(a.maxSlippageBp)} given).`,
  OrderManagementLib__InvalidTimeInForce:
    "That time-in-force does not fit this order: IOC is for limit orders, FOK for limit and market orders, and neither combines with post-only.",
  OrderManagementLib__LimitPriceOutsidePlacementBand: (a) =>
    `A limit price must be within 50% of the market price: between ${price(a.minPrice)} and ${price(a.maxPrice)}.`,
  OrderManagementLib__NoPositionForTpSl: "Take-profit and stop-loss orders close an open position. Open one first.",
  OrderManagementLib__NotAmendable: (a) => `Only resting good-till-canceled limit orders can be amended. Cancel order ${id(a.orderId)} and place a new one.`,
  OrderManagementLib__NotionalBelowMinimum: (a) =>
    `Orders must be worth at least ${usd(a.minimum)} (this one is ${usd(a.notional)}). Closing your whole position is always allowed.`,
  OrderManagementLib__OrderAlreadyExpired: (a) => `Order ${id(a.orderId)} has already expired.`,
  OrderManagementLib__OrderIsNotActive: (a) => `Order ${id(a.orderId)} is no longer active: it was filled or canceled.`,
  OrderManagementLib__OrderNotFound: (a) => `There is no order ${id(a.orderId)} on this market.`,
  OrderManagementLib__PostOnlyNotAllowed: "Post-only applies to limit orders only.",
  OrderManagementLib__RequestorIsNotOrderOwner: (a) => `Order ${id(a.orderId)} is not yours.`,
  OrderManagementLib__StopLimitPriceOnWrongSide:
    "A stop-limit's limit price must be on the fillable side of its trigger: at or above it for a buy, at or below it for a sell.",
  OrderManagementLib__TooManyActiveLimitOrders: "You have the maximum of 32 open limit and stop-limit orders on this market. Cancel some first.",
  OrderManagementLib__TpSlMustBeOppositeDirection:
    "A take-profit or stop-loss must be on the other side of your position: sell to close a long, buy to close a short.",
  OrderManagementLib__TpSlOrderAlreadyExists: "This position already has an order of that kind (one take-profit and one stop-loss each). Cancel it before placing another.",
  OrderManagementLib__ZeroLimitPrice: "Enter a limit price.",
  OrderManagementLib__ZeroSize: "Enter a size.",
  OrderManagementLib__ZeroTriggerPrice: "Enter a trigger price.",

  // ---- TerminationLib / lens ----
  TerminationLib__BalanceOfFailed: "The market could not read its own USDC balance. Try again later.",
  TerminationLib__TerminationPriceRequired: "The market's final price has not been fixed yet.",
  BazaarPairLens__ZeroAddress: ZERO_ADDRESS,

  // ---- BazaarFactory ----
  Factory__BaseFeedAlreadyListed: (a) => `This asset already has a live market on Bazaar (${short(a.pair)}).`,
  Factory__CompositePairMustBeNonContinuous: "A market priced through an FX leg cannot trade 24/7. List it as a market with trading hours.",
  Factory__DeploymentNotExpired: (a) => `This listing proposal can be released ${when(a.expiryTs)}.`,
  Factory__DescriptionInvalid: "The description must be 1 to 200 characters: letters, digits, spaces and . , & / - only.",
  Factory__FeedNotOnPyth: "Pyth has no price feed with that id. Check the feed id.",
  Factory__IdentifierNotAssertTruth: "That UMA identifier cannot be used: Bazaar needs an ASSERT_TRUTH-style identifier.",
  Factory__IdentifierNotWhitelisted:
    "UMA does not currently accept that identifier. New listings are paused until an identifier upgrade moves Bazaar to one UMA accepts.",
  Factory__IdentifierUpgradeNoChange: "That identifier is already the one in use.",
  Factory__IdentifierUpgradeNotExpired: (a) => `This identifier-upgrade proposal can be released ${when(a.expiryTs)}.`,
  Factory__IdentifierUpgradeStillPending: "Another identifier upgrade is still pending or waiting out its timelock. Try again once it resolves.",
  Factory__IdentifierUpgradeTimelocked: (a) => `The approved identifier upgrade can be activated ${when(a.opensAt)}.`,
  Factory__InvalidIdentifier: "The identifier cannot be empty.",
  Factory__NoPendingDeployment: "There is no pending listing proposal for this market.",
  Factory__NoPendingIdentifierUpgrade: "No identifier upgrade is pending.",
  Factory__NoQueuedIdentifierUpgrade: "No identifier upgrade is waiting to activate.",
  Factory__NoSeedRefund: "You have no listing seed to claim back.",
  Factory__OnlyUmaOracle: "Only UMA's oracle can do this.",
  Factory__PairAlreadyExists: "A live market with this id already exists.",
  Factory__ProposalAlreadyPending: "Another listing proposal for this asset is still pending. Wait for it to resolve.",
  Factory__ProposalAlreadyResolved: "That proposal has already been resolved.",
  Factory__ProposalNotFound: "No proposal has that id.",
  Factory__SeedBelowMinimum: "A listing needs at least $4,000: UMA's bond ($1,000, or UMA's minimum if higher) plus at least $3,000 of insurance seed.",
  Factory__WiringMismatch: "The factory's contracts do not point at each other.",
  Factory__ZeroAddress: ZERO_ADDRESS,
  FailedDeployment: "Deploying the market failed.",
  InsufficientBalance: (a) => `The factory holds ${formatEth(a.balance)} but needs ${formatEth(a.needed)} for this.`,
  StringsInsufficientHexLength: "The listing text could not be formatted.",

  // ---- BazaarPairTerminator ----
  BazaarPairTerminator__AlreadyResolved: "That termination proposal has already been resolved.",
  BazaarPairTerminator__AlreadyTerminated: "This market's final price is already fixed, or it has been wound down.",
  BazaarPairTerminator__CutoffNotEarlier: (a) =>
    `A closing time of ${when(a.umaCutoff)} is already accepted for this market; a new proposal must close it earlier.`,
  BazaarPairTerminator__EthRefundFailed: "The unused ETH could not be refunded to the sender. Send from an address that accepts ETH.",
  BazaarPairTerminator__InsufficientPythFee: (a) =>
    `Not enough ETH for the Pyth fee: ${formatEth(a.provided)} sent, ${formatEth(a.required)} needed. Rebuild the transaction with the current fee.`,
  BazaarPairTerminator__InsurerActiveProposal: "You already opened a termination vote on this market a moment ago.",
  BazaarPairTerminator__InsurerCutoffNotEarlier: (a) => `This market already closes ${when(a.scheduledTs)}; a vote must propose an earlier time.`,
  BazaarPairTerminator__InsurerCutoffTooLate: (a) => `The proposed closing time must be within 14 days, by ${when(a.maxCutoffTs)}.`,
  BazaarPairTerminator__InsurerCutoffTooSoon: (a) => `The proposed closing time must be at least 2 hours away, after ${when(a.minCutoffTs)}.`,
  BazaarPairTerminator__InsurerInsufficientUnlockedShares: (a) =>
    `You can vote with ${amount(a.unlocked, 4)} shares (held since at least 4 days before voting opened, and not already voted); you asked for ${amount(a.requested, 4)}.`,
  BazaarPairTerminator__InsurerNoActiveProposal: "That vote is not open: it does not exist, has been resolved, or the market's settlement has begun.",
  BazaarPairTerminator__InsurerNoMatureShares: "Opening a termination vote needs insurance shares you have held for at least 4 days.",
  BazaarPairTerminator__InsurerScheduleSettlesPair:
    "A closing time set by an insurer vote has passed, so this market settles through the scheduled-termination path instead.",
  BazaarPairTerminator__InsurerThresholdNotMet: (a) =>
    `The vote has ${amount(a.yesShares, 4)} yes-shares of the ${amount(a.required, 4)} it needs, so it stays open.`,
  BazaarPairTerminator__InsurerTooManyLiveVotes: (a) => `You can back at most ${big(a.max)} open votes on one market at a time.`,
  BazaarPairTerminator__InsurerVerdictPending: (a) =>
    `UMA has not ruled yet on the claim behind this vote. It can be settled without the ruling ${when(a.deadline)}.`,
  BazaarPairTerminator__InsurerVoteNotOpen: (a) => `Voting opens ${when(a.windowOpenTs)}.`,
  BazaarPairTerminator__InsurerVotingClosed: "Voting has closed: it ends an hour before the proposed closing time.",
  BazaarPairTerminator__InsurerZeroVoteAmount: "Enter a number of shares to vote with.",
  BazaarPairTerminator__InvalidCategory: "Choose a termination category from 1 to 4.",
  BazaarPairTerminator__InvalidReason: (a) =>
    `The reason must be 1 to 1,000 characters of plain text (letters, digits, spaces, basic punctuation and links); ${big(a.length)} given.`,
  BazaarPairTerminator__LastTradingTsTooSoon: (a) => `The proposed closing time must be at least 2 hours away, after ${when(a.minimum)}.`,
  BazaarPairTerminator__NoScheduledTermination: "This market has no scheduled closing time.",
  BazaarPairTerminator__OnlyFactory: NOT_YOURS,
  BazaarPairTerminator__OnlyPair: NOT_YOURS,
  BazaarPairTerminator__OnlyUmaOracle: "Only UMA's oracle can do this.",
  BazaarPairTerminator__OracleBusy: "UMA's oracle is busy with this assertion inside the same transaction. Send this call on its own.",
  BazaarPairTerminator__OracleNotStaleEnough: (a) =>
    `This market's price last updated ${when(a.lastUpdate)}; a market can be closed as dead only after ${formatDuration(Number(big(a.threshold)))} without a price.`,
  BazaarPairTerminator__PairNotRegistered: "That address is not a Bazaar market.",
  BazaarPairTerminator__ScheduleOutOfGas: "Scheduling the market's closing ran out of gas. Retry with a higher gas limit.",
  BazaarPairTerminator__SettlementAlreadyFixed: "This market's final price is already fixed.",
  BazaarPairTerminator__TerminationTimeNotReached: (a) => `The market's closing time, ${when(a.scheduledTs)}, has not passed yet.`,
  BazaarPairTerminator__UmaIdentifierNotLive:
    "UMA does not currently accept Bazaar's identifier, so termination claims are paused until it is upgraded. Insurers can still vote to close a market.",
  BazaarPairTerminator__UnknownAssertion: "No termination proposal has that id.",
  BazaarPairTerminator__ZeroAddress: ZERO_ADDRESS,

  // ---- BazaarOracle ----
  BazaarOracle__ConfidenceTooHigh: (a) => {
    const p = big(a.price);
    const bp = p > 0n ? (big(a.confidence) * 10_000n) / p : 0n;
    return `Pyth's price is too uncertain right now (±${pct(bp)}; the limit is 2%). Try again in a moment.`;
  },
  BazaarOracle__InvalidCompositeLegs: "Those two feeds cannot be combined into a composite price.",
  BazaarOracle__InvalidPrice: "Pyth reported an invalid price for this feed. Try again shortly.",
  BazaarOracle__SampleCountMismatch: (a) => `The settlement needs ${big(a.expected)} price updates; ${big(a.updates)} were given.`,
  BazaarOracle__SampleFeeMismatch: (a) => `The ETH sent (${formatEth(a.supplied)}) must equal the Pyth fee (${formatEth(a.required)}).`,
  BazaarOracle__ZeroAddress: ZERO_ADDRESS,
};

let installed = false;

/** Register {@link USER_MESSAGES} so `DecodedError.message` returns them. Idempotent. */
export function installUserMessages(): void {
  if (installed) return;
  registerUserMessages(USER_MESSAGES);
  installed = true;
}
installUserMessages();

/** The user-facing message for a custom error by name, with its arguments; the name itself when unknown. */
export function userMessage(name: string, args: Args = {}): string {
  const m = USER_MESSAGES[name];
  if (m === undefined) return name;
  try {
    return typeof m === "string" ? m : m(args);
  } catch {
    return name;
  }
}

// =====================================================================================================
// Wallet-side failures
// =====================================================================================================

const WALLET_CODES: Readonly<Record<number, string>> = {
  4001: "You rejected the request in your wallet.",
  4100: "Your wallet has not authorized this site for that account. Connect the account in your wallet and try again.",
  4200: "Your wallet does not support this request.",
  4900: "Your wallet is disconnected. Reconnect it and try again.",
  4901: "Your wallet is not connected to this network. Switch networks in your wallet and try again.",
  4902: "This network has not been added to your wallet yet. Add it and try again.",
  [-32002]: "Your wallet already has a request waiting. Open your wallet to approve or reject it.",
};

const INSUFFICIENT_GAS = "Your wallet does not have enough ETH for gas (plus any ETH the call sends). Add ETH on this network and try again.";
const NONCE = "Your wallet's transaction count is out of date: another transaction already used it. Wait for pending transactions to confirm (or reset the account in your wallet) and try again.";
const CHAIN = "Your wallet is on a different network than this app. Switch networks in your wallet and try again.";

/**
 * A message for a failure the wallet raised rather than the contract: the EIP-1193 provider errors
 * (4001 rejected, 4100 unauthorized, 4200 unsupported, 4900/4901 disconnected, 4902 unknown chain,
 * -32002 a request already pending), insufficient funds for gas, a stale nonce, and a chain mismatch.
 * Walks `cause` chains (viem, ethers, raw providers). null when `e` is none of these.
 */
export function walletErrorMessage(e: unknown): string | null {
  let cur: unknown = e;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && cur && typeof cur === "object" && !seen.has(cur); depth++) {
    seen.add(cur);
    const o = cur as { code?: unknown; name?: unknown; message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown; error?: unknown; info?: unknown };
    if (typeof o.code === "number" && WALLET_CODES[o.code]) return WALLET_CODES[o.code]!;
    if (o.code === "ACTION_REJECTED" || o.name === "UserRejectedRequestError") return WALLET_CODES[4001]!;
    if (o.code === "INSUFFICIENT_FUNDS" || o.name === "InsufficientFundsError") return INSUFFICIENT_GAS;
    if (o.code === "NONCE_EXPIRED" || o.name === "NonceTooLowError") return NONCE;
    if (o.name === "ChainMismatchError" || o.name === "ChainDisconnectedError" || o.name === "SwitchChainError") {
      return o.name === "ChainDisconnectedError" ? WALLET_CODES[4901]! : CHAIN;
    }
    const text = [o.shortMessage, o.details, o.message].filter((x): x is string => typeof x === "string").join(" ");
    if (/user (rejected|denied|cancel)|rejected by user|request rejected/i.test(text)) return WALLET_CODES[4001]!;
    if (/insufficient funds/i.test(text)) return INSUFFICIENT_GAS;
    if (/nonce too low|nonce has already been used|nonce.*(expired|too old)/i.test(text)) return NONCE;
    if (/chain mismatch|does not match the target chain|wrong (network|chain)|chain ?id.{0,40}(mismatch|does not match)/i.test(text)) return CHAIN;
    const info = o.info as { error?: unknown } | undefined;
    cur = o.cause ?? o.error ?? info?.error;
  }
  return null;
}

/**
 * The text to show a user for any error a Bazaar call can throw: a wallet-side failure, a decoded
 * revert (from a `CallError`, a simulation's `DecodedError`, or revert data inside an RPC error), or an
 * input the SDK refused before building. Falls back to a generic sentence, never a raw URL.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof DecodedError) return e.message;
  if (e && typeof e === "object") {
    const o = e as { name?: unknown; message?: unknown; decoded?: unknown };
    if (o.name === "InputError" && typeof o.message === "string") return o.message;
    if (o.decoded instanceof DecodedError) return o.decoded.message;
  }
  const wallet = walletErrorMessage(e);
  if (wallet) return wallet;
  const rpc = toRpcError(e);
  const data = rpc?.revertData;
  if (data && data !== "0x") return decodeError(data).message;
  if (rpc && rpc.revertData === "0x") return decodeError("0x").message;
  return "Something went wrong. Please try again.";
}
