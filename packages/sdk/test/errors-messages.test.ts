import { type AbiParameter, type Hex, concatHex, encodeAbiParameters, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { allErrors } from "../src/chain/codec.js";
import { DecodedError, KEEPER_HINTS, VERIFIER_REASON_HINTS, decodeError } from "../src/chain/errors.js";
import { RpcError } from "../src/chain/rpc.js";
import { CallError, InputError } from "../src/client/calls.js";
import {
  REASON_MESSAGES,
  USER_MESSAGES,
  errorMessage,
  formatAmount,
  formatBp,
  formatDuration,
  formatPrice,
  formatTime,
  formatUsd,
  userMessage,
  walletErrorMessage,
} from "../src/errors/messages.js";

const E18 = 10n ** 18n;
const ALICE = getAddress("0x00000000000000000000000000000000000a11ce");

function sampleValue(p: AbiParameter): unknown {
  const t = p.type;
  if (t.endsWith("]")) return [];
  if (t === "address") return ALICE;
  if (t === "bool") return true;
  if (t.startsWith("bytes")) return ("0x" + "ab".repeat(t === "bytes" ? 4 : Number(t.slice(5)))) as Hex;
  if (t === "string") return "x";
  if (t.startsWith("uint")) {
    const bits = Number(t.slice(4) || 256);
    return bits <= 48 ? 7 : 1_700_000_000n;
  }
  if (t.startsWith("int")) {
    const bits = Number(t.slice(3) || 256);
    return bits <= 48 ? -7 : -12n;
  }
  return 0;
}

function revertData(name: string, values?: unknown[]): Hex {
  const spec = [...allErrors().values()].find((e) => e.name === name);
  if (!spec) throw new Error(`no error ${name}`);
  const vals = values ?? spec.inputs.map(sampleValue);
  return spec.inputs.length ? concatHex([spec.selector, encodeAbiParameters(spec.inputs, vals)]) : spec.selector;
}

describe("user messages", () => {
  it("covers every custom error the five ABIs declare", () => {
    const missing = [...allErrors().values()].map((e) => e.name).filter((n) => USER_MESSAGES[n] === undefined);
    expect(missing).toEqual([]);
  });

  it("has no message for an error the ABIs do not declare", () => {
    const declared = new Set([...allErrors().values()].map((e) => e.name));
    expect(Object.keys(USER_MESSAGES).filter((n) => !declared.has(n))).toEqual([]);
  });

  it("renders every error's message from decoded revert data, arguments formatted", () => {
    for (const spec of allErrors().values()) {
      const d = decodeError(revertData(spec.name));
      expect(d.name).toBe(spec.name);
      const m = d.message;
      expect(m, spec.name).not.toBe(spec.name);
      expect(m, spec.name).not.toMatch(/undefined|NaN|\[object/);
      expect(m.length, spec.name).toBeLessThan(400);
    }
  });

  it("is what DecodedError.message returns, ahead of the keeper hint", () => {
    const d = decodeError(revertData("BazaarPair__TradingHalted"));
    expect(KEEPER_HINTS["BazaarPair__TradingHalted"]).toBeTruthy();
    expect(d.message).toBe(USER_MESSAGES["BazaarPair__TradingHalted"]);
    expect(d.hint).toBe(KEEPER_HINTS["BazaarPair__TradingHalted"]);
  });

  it("formats amounts as dollars", () => {
    const d = decodeError(revertData("CollateralLib__LedgerShortfall", [150n * E18, 100n * E18 + E18 / 4n]));
    expect(d.message).toContain("$100.25 right now");
    expect(d.message).toContain("$150.00");
    const m = decodeError(revertData("OrderManagementLib__InsufficientMarginAfterOrder", [100n * E18, 303n * E18])).message;
    expect(m).toContain("needs $303.00 of collateral");
    expect(m).toContain("you have $100.00");
  });

  it("formats prices, bp and times", () => {
    const band = decodeError(
      revertData("OrderManagementLib__LimitPriceOutsidePlacementBand", [5000n * E18, 1500n * E18, 4500n * E18]),
    ).message;
    expect(band).toContain("between $1,500.00 and $4,500.00");
    expect(decodeError(revertData("OrderManagementLib__InvalidSlippage", [2000n])).message).toContain("(20% given)");
    const claim = decodeError(revertData("InsuranceVaultLib__ClaimNotOpen", [1_700_000_000n])).message;
    expect(claim).toContain("2023-11-14 22:13 UTC");
    const conf = decodeError(revertData("BazaarOracle__ConfidenceTooHigh", [3n * E18, 100n * E18])).message;
    expect(conf).toContain("±3%");
  });

  it("names the reason a vault is unhealthy", () => {
    expect(decodeError(revertData("InsuranceVaultLib__VaultUnhealthy", [4])).message).toContain("realized bad debt");
    expect(userMessage("InsuranceVaultLib__VaultUnhealthy", { reason: 9 })).toContain("the market is unhealthy");
  });

  it("falls back to the name for an unknown error", () => {
    expect(userMessage("Nope__Unknown")).toBe("Nope__Unknown");
  });

  it("explains what the oracle refuses about a Pyth Pro update", () => {
    const feed = ("0x" + "00".repeat(31) + "01") as Hex;
    const stale = decodeError(revertData("BazaarOracle__StalePrice", [feed, 1_700_000_000n]));
    // the decoder does not know the chain's time, so the generation time is given as it is, not relative to this machine's clock
    expect(stale.message).toMatch(/^The price in this transaction was generated at 2023-11-14 22:13:20 UTC, more than 3 seconds from the block's time when it ran\./);
    expect(stale.hint).toBe(KEEPER_HINTS["BazaarOracle__StalePrice"]);
    expect(decodeError(revertData("BazaarOracle__FeeMismatch", [1n, 2n * 10n ** 14n])).message).toContain("must equal Pyth's fee (0.0002 ETH)");
    expect(decodeError(revertData("BazaarOracle__SampleTooLate", [feed, 1_700_000_600n, 1_700_000_000n])).message).toMatch(/is for 2023-11-14 22:23 UTC .*after the latest time this settlement accepts \(2023-11-14 22:13 UTC/);
    expect(decodeError(revertData("BazaarOracle__SampleNotProven", [feed, 1_700_000_000n, 1_700_000_005n])).message).toMatch(/do not prove the price for 2023-11-14 22:13 UTC/);
    for (const name of ["BazaarOracle__FeedNotInUpdate", "BazaarOracle__IncompleteFeed", "BazaarOracle__WrongTick", "BazaarOracle__InvalidFeedId", "LazerPayloadLib__Malformed", "Factory__InvalidFeedId"]) {
      const d = decodeError(revertData(name));
      expect(d.message, name).toBe(USER_MESSAGES[name]);
      expect(d.hint, name).toBe(KEEPER_HINTS[name]);
      expect(d.hint, name).not.toBe("");
    }
    // errors the contracts do not declare have neither a message nor a hint
    for (const gone of ["Factory__FeedNotOnPyth", "BazaarOracle__SampleFeeMismatch"]) {
      expect(USER_MESSAGES[gone], gone).toBeUndefined();
      expect(KEEPER_HINTS[gone], gone).toBeUndefined();
    }
    expect(KEEPER_HINTS["BazaarPair__NoPriceUpdatesProvided"]).toMatch(/the pair's own stored price is more than 3 seconds old/);
  });

  it("explains the reason strings Pyth's verifier reverts with", () => {
    const reason = (msg: string): Hex => concatHex(["0x08c379a0", encodeAbiParameters([{ type: "string" }], [msg])]);
    expect(Object.keys(REASON_MESSAGES).sort()).toEqual(Object.keys(VERIFIER_REASON_HINTS).sort());
    expect(Object.keys(REASON_MESSAGES)).toEqual(["invalid signer", "invalid signature", "Insufficient fee provided", "input too short", "invalid evm magic"]);
    for (const [msg, text] of Object.entries(REASON_MESSAGES)) {
      const d = decodeError(reason(msg));
      expect([d.name, d.args.message]).toEqual(["Error", msg]);
      expect(d.message).toBe(text);
      expect(d.hint).toBe(VERIFIER_REASON_HINTS[msg]);
      expect(errorMessage(new RpcError(3, "execution reverted", reason(msg)))).toBe(text);
    }
    expect(decodeError(reason("invalid signer")).message).toBe("The price update was signed by a key Pyth no longer accepts. Rebuild the transaction with a current price update.");
    // any other reason string is shown as it is
    const other = decodeError(reason("ERC20: transfer amount exceeds balance"));
    expect([other.message, other.hint]).toEqual(["ERC20: transfer amount exceeds balance", "ERC20: transfer amount exceeds balance"]);
  });
});

describe("formatting", () => {
  it("formats dollars", () => {
    expect(formatUsd(1234n * E18 + E18 / 2n)).toBe("$1,234.50");
    expect(formatUsd(0n)).toBe("$0.00");
    expect(formatUsd(-5n * E18)).toBe("-$5.00");
    expect(formatUsd(E18 / 1000n)).toBe("$0.001");
    expect(formatUsd(1_000_000n * E18)).toBe("$1,000,000.00");
    expect(formatUsd(E18 + 999n * 10n ** 13n)).toBe("$1.00");
  });

  it("formats prices with their decimals", () => {
    expect(formatPrice(3012n * E18 + E18 / 2n)).toBe("$3,012.50");
    expect(formatPrice(108765n * 10n ** 13n)).toBe("$1.08765");
    expect(formatPrice(1234n * 10n ** 10n)).toBe("$0.00001234");
  });

  it("formats sizes, bp, durations and times", () => {
    expect(formatAmount(12_000n * E18 + E18 / 4n)).toBe("12,000.25");
    expect(formatBp(250n)).toBe("2.5%");
    expect(formatBp(1n)).toBe("0.01%");
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(13 * 86400)).toBe("13 days");
    expect(formatTime(1_700_000_000, 1_700_000_000 - 3 * 3600)).toBe("2023-11-14 22:13 UTC (in 3 h)");
    expect(formatTime(1_700_000_000, 1_700_000_000 + 300)).toBe("2023-11-14 22:13 UTC (5 min ago)");
    expect(formatTime(2n ** 64n - 1n)).toBe("an unknown time");
  });
});

describe("wallet errors", () => {
  it("explains the EIP-1193 codes", () => {
    expect(walletErrorMessage({ code: 4001, message: "User rejected the request." })).toMatch(/rejected the request/);
    expect(walletErrorMessage({ code: 4100 })).toMatch(/not authorized/);
    expect(walletErrorMessage({ code: 4200 })).toMatch(/does not support/);
    expect(walletErrorMessage({ code: 4900 })).toMatch(/disconnected/);
    expect(walletErrorMessage({ code: 4901 })).toMatch(/not connected to this network/);
    expect(walletErrorMessage({ code: 4902 })).toMatch(/not been added/);
    expect(walletErrorMessage({ code: -32002, message: "Request of type 'wallet_requestPermissions' already pending" })).toMatch(
      /already has a request waiting/,
    );
  });

  it("walks viem and ethers error chains", () => {
    const viemLike = { name: "TransactionExecutionError", message: "boom", cause: { name: "UserRejectedRequestError", code: 4001, message: "User rejected" } };
    expect(walletErrorMessage(viemLike)).toMatch(/rejected the request/);
    expect(walletErrorMessage({ code: "ACTION_REJECTED", message: "user rejected action" })).toMatch(/rejected the request/);
    expect(walletErrorMessage({ name: "ChainMismatchError", message: "The current chain of the wallet (id: 1) does not match the target chain" })).toMatch(
      /different network/,
    );
    expect(walletErrorMessage(new Error("does not match the target chain for the transaction"))).toMatch(/different network/);
  });

  it("recognises gas and nonce failures", () => {
    expect(walletErrorMessage({ code: -32000, message: "insufficient funds for gas * price + value" })).toMatch(/enough ETH for gas/);
    expect(walletErrorMessage(new Error("nonce too low: next nonce 5, tx nonce 4"))).toMatch(/transaction count/);
    expect(walletErrorMessage({ name: "InsufficientFundsError", message: "x" })).toMatch(/enough ETH/);
  });

  it("is null for anything else", () => {
    expect(walletErrorMessage(new Error("execution reverted"))).toBeNull();
    expect(walletErrorMessage("nope")).toBeNull();
    expect(walletErrorMessage(null)).toBeNull();
  });
});

describe("errorMessage", () => {
  it("decodes revert data carried by an RPC error", () => {
    const data = revertData("CollateralLib__InvalidDepositAmount", [E18, 5n * E18]);
    expect(errorMessage(new RpcError(3, "execution reverted", data))).toBe("Deposits must be at least $5.00.");
    expect(errorMessage({ code: 3, message: "execution reverted", data })).toBe("Deposits must be at least $5.00.");
  });

  it("uses the decoded error of a CallError and the text of an InputError", () => {
    const d = decodeError(revertData("OrderManagementLib__ZeroSize"));
    expect(errorMessage(new CallError("x", d))).toBe("Enter a size.");
    expect(errorMessage(d)).toBe("Enter a size.");
    expect(errorMessage(new InputError("size", "must be more than zero"))).toBe("size: must be more than zero");
    expect(errorMessage({ code: 4001 })).toMatch(/rejected/);
    expect(errorMessage(new Error("weird"))).toBe("Something went wrong. Please try again.");
    expect(d).toBeInstanceOf(DecodedError);
  });
});

describe("message tables", () => {
  it("are read by their own keys only, so a reason such as constructor stays text", () => {
    const errorString = (s: string) => `0x08c379a0${encodeAbiParameters([{ type: "string" }], [s]).slice(2)}` as Hex;
    for (const reason of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const d = decodeError(errorString(reason));
      expect(d.hint, reason).toBe(reason);
      expect(d.message, reason).toBe(reason);
      expect(userMessage(reason), reason).toBe(reason);
    }
  });
});
