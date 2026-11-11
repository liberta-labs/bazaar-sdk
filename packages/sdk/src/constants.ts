/**
 * Protocol constants, each named after the Bazaar constant it copies.
 *
 * Units follow one rule across the SDK: protocol quantities (prices, sizes, notionals, collateral,
 * rewards, scores, funding indices, basis-point rates) are `bigint`; durations in seconds, block
 * numbers, counts and enum values are `number`. Amounts use BAZAAR precision, 1e18 = $1 or one unit,
 * unless a name says USDC (6 decimals).
 *
 * The keeper only schedules and pre-filters with these: every call is simulated against the chain
 * first, and the contract's own answer wins, so a drift costs a missed or wasted simulation, never a
 * bad transaction. Where the lens exposes a value, the SDK reads it from the chain instead.
 */

import type { Address, Hex } from "viem";

export const BAZAAR_SCALE = 10n ** 18n; // 1e18 is $1 or one unit
export const BP_SCALE = 10_000n;
export const EBP_SCALE = 1_000_000n;
export const USDC_DECIMALS = 6;
/** BAZAAR precision carries twelve more decimals than USDC. */
export const USDC_TO_BAZAAR = 10n ** 12n;

// ---- BazaarTypes ----
export const MAX_PRICE_STALENESS = 3; // seconds a print may sit from the block timestamp
export const LIMBO_LEAD = 2 * MAX_PRICE_STALENESS; // trading halts this long before a scheduled cutoff
export const MIN_ORDER_AMOUNT = 5n * BAZAAR_SCALE;
export const MIN_COLLATERAL_DEPOSIT = 5n * BAZAAR_SCALE;
export const MAX_WALK_STEPS = 32;
export const MAX_TRIGGER_EXECS_PER_CALL = 20;
export const LIQUIDATION_FEE_EBP = 200n; // 2 bp
export const MIN_LIQUIDATOR_REWARD = BAZAAR_SCALE / 20n;
export const TERMINAL_SETTLEMENT_TIP = BAZAAR_SCALE / 20n;
export const TERMINAL_SETTLEMENT_ESCAPE = 14 * 86_400;
export const UNLOAD_BOUNTY_MIN = BAZAAR_SCALE / 4n;
export const UNLOAD_BOUNTY_MIN_NOTIONAL = 1_250n * BAZAAR_SCALE;
export const UNLOAD_FLOOR_DECAY = 180;
export const ADL_AUCTION_DURATION = 600;
export const ADL_MAX_SCORE = 25n * BAZAAR_SCALE;
export const ADL_TERMINATION_GRACE = 1_800;

// ---- BazaarPair ----
export const MAX_LIQUIDATION_PRICE_AGE = 600;

// ---- VaultHealthLib / AdlLib ----
export const ADL_TIMEOUT_DURATION = 86_400;
export const MAX_ADL_WINNERS_PER_BATCH = 25;

// ---- RiskParamsLib (internal there, so copied rather than read) ----
export const REFRESH_BOUNTY = BAZAAR_SCALE / 10n;
export const REFRESH_BOUNTY_MIN_GAP = 300;
export const REFRESH_BOUNTY_HEARTBEAT = 86_400;
export const REFRESH_BOUNTY_FAST_MIN_INSURANCE = 5_000n * BAZAAR_SCALE;
export const REFRESH_BOUNTY_HEARTBEAT_MIN_INSURANCE = 1_000n * BAZAAR_SCALE;

// ---- BazaarOracle ----
export const MAX_CONFIDENCE_BP = 200n;
export const BAZAAR_EXPONENT = -18;

// ---- BazaarPairTerminator ----
export const ORACLE_DEAD_THRESHOLD = 21 * 86_400;
export const SETTLEMENT_SAMPLE_COUNT = 5;
export const SETTLEMENT_SAMPLE_SPACING = 600;
export const SETTLE_NOTHING = 0;
export const SETTLE_TICK = 1;
export const SETTLE_CHAIN = 2;
export const SETTLE_AWAIT_VERDICT = 3;

// ---- BazaarTypes.OrderType ----
export const OrderType = {
  Market: 0,
  Limit: 1,
  StopLimit: 2,
  TakeProfit: 3,
  StopLoss: 4,
} as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];
export const MARKET = OrderType.Market;
export const LIMIT = OrderType.Limit;
export const STOP_LIMIT = OrderType.StopLimit;
export const TAKE_PROFIT = OrderType.TakeProfit;
export const STOP_LOSS = OrderType.StopLoss;
export const TRIGGER_TYPES: readonly number[] = [STOP_LIMIT, TAKE_PROFIT, STOP_LOSS];
export const ORDER_TYPE_NAMES: Readonly<Record<number, string>> = {
  [MARKET]: "Market",
  [LIMIT]: "Limit",
  [STOP_LIMIT]: "StopLimit",
  [TAKE_PROFIT]: "TakeProfit",
  [STOP_LOSS]: "StopLoss",
};
/** An order's trigger price sits in the low 128 bits; its keeper bounty in the high 128. */
export const TRIGGER_PRICE_MASK = (1n << 128n) - 1n;

/** Pyth Pro ETH/USD (feed 2) as a bytes32 feed id, used to price gas. */
export const ETH_USD_FEED: Hex = "0x0000000000000000000000000000000000000000000000000000000000000002";

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
export const MAX_UINT256 = (1n << 256n) - 1n;
