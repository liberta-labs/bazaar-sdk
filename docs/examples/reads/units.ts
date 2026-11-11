// Units: conversions between people, the pair (18 decimals) and USDC (6 decimals).
import {
  BAZAAR_SCALE,
  MIN_ORDER_AMOUNT,
  ORDER_TYPE_NAMES,
  OrderType,
  UnitError,
  bpToFraction,
  floorToUsdc,
  format,
  formatDecimal,
  formatUnits18,
  fromUsdcUnits,
  orders,
  parseDecimal,
  parseUnits18,
  toNumber18,
  toUsdcUnits,
  toUsdcUnitsCeil,
} from "@liberta-labs/bazaar-sdk";

// ANCHOR: parse
parseUnits18("12.5"); // 12500000000000000000n
parseUnits18("-0.75"); // -750000000000000000n
parseDecimal("2.5", 6); // 2500000n: any number of decimals
try {
  parseUnits18("1e-3"); // exponents, commas, "+", and more than 18 decimals are refused
} catch (e) {
  if (e instanceof UnitError) console.log(e.message); // "\"1e-3\" is not a decimal number"
}
// ANCHOR_END: parse

// ANCHOR: format
formatUnits18(12_345_678_900_000_000_000n); // "12.3456789"
formatUnits18(12_345_678_900_000_000_000n, 2); // "12.34": cut toward zero, never rounded up
formatDecimal(2_500_000n, 6); // "2.5"
toNumber18(parseUnits18("0.1")); // 0.1, for charts and arithmetic on screen only
bpToFraction(250n); // 0.025

format.formatUsd(parseUnits18("1234.5")); // "$1,234.50"
format.formatPrice(parseUnits18("1.08765")); // "$1.08765"
format.formatBp(250n); // "2.5%"
format.formatDuration(3000); // "50 min"
// ANCHOR_END: format

// ANCHOR: usdc
const amount = parseUnits18("10.0000005"); // more precision than USDC has
floorToUsdc(amount); // 10000000000000000000n: what the pair actually moves (whole micro-USDC)
toUsdcUnits(amount); // 10000000n: floored, as the pair floors it
toUsdcUnitsCeil(amount); // 10000001n: rounded up, for an allowance or a permit that must cover it
fromUsdcUnits(10_000_000n); // 10000000000000000000n
// ANCHOR_END: usdc

// ANCHOR: orders
OrderType.Limit; // 1
ORDER_TYPE_NAMES[OrderType.StopLoss]; // "StopLoss"
orders.TimeInForce.FOK; // 2
orders.TIF_NAMES[orders.TimeInForce.IOC]; // "IOC"
orders.CLOSE_POSITION; // a TakeProfit or StopLoss of this size closes the whole position
const notional = (parseUnits18("0.002") * parseUnits18("2400")) / BAZAAR_SCALE; // $4.80
notional >= MIN_ORDER_AMOUNT; // false: the minimum is $5
// ANCHOR_END: orders
