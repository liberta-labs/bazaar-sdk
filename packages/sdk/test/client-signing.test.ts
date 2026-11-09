import {
  type Abi,
  type Address,
  type Hex,
  bytesToHex,
  concat,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  hexToBytes,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
  toHex,
} from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bazaarPairAbi } from "../src/abi/index.js";
import { InputError } from "../src/client/calls.js";
import { LIMIT, STOP_LOSS } from "../src/constants.js";
import { CLOSE_POSITION, amendIdWord, buildOrderSpec } from "../src/client/orders.js";
import { checkPermit, decodePermitData, encodePermitData, permitTypedData, signPermit, usdcPermitDomain } from "../src/client/permits.js";
import { type RelayedRequest, encodeRelayed, parseRelayed, relayedPull, serializeRelayed, signRelayed, verifyRelayed } from "../src/client/relay.js";
import {
  BAZAAR_TYPES,
  ClockSkewError,
  MAX_RELAYER_FEE,
  type PrimaryType,
  SigningError,
  TYPE_STRINGS,
  chainDeadline,
  checkClockSkew,
  domainSeparator,
  floorRelayerFee,
  normalizeSignature,
  relayedDigest,
  typeHash,
  typedDataFor,
  verifyTypehashes,
} from "../src/client/signing.js";
import { FEED, INTEGRATOR, PAIR, USDC, Revert, alice, bob, bucket, fakeContext, mockUpdate, reviveTypedData, storedOrder } from "./client-writes-fake.js";

const E18 = 10n ** 18n;
const pairAbi = bazaarPairAbi as unknown as Abi;

// Deadlines are counted from min(chain time, this device's clock), which must agree within 2 min:
// run this device's clock at the fake chain's time (FakeChain.timestamp).
const FAKE_NOW = 1_700_000_000;
beforeEach(() => {
  vi.setSystemTime(FAKE_NOW * 1000);
});
afterEach(() => {
  vi.useRealTimers();
});

// Verbatim from docs/protocol/meta-transactions.md, "Type strings".
const DOC_TYPES: Record<PrimaryType, string> = {
  DepositCollateral: "DepositCollateral(uint256 amount,uint256 nonce,uint256 deadline,uint256 relayerFee)",
  WithdrawCollateral: "WithdrawCollateral(uint256 amount,uint256 nonce,uint256 deadline,uint256 relayerFee)",
  DepositToInsurance: "DepositToInsurance(uint256 amount,uint256 nonce,uint256 deadline,uint256 relayerFee)",
  RequestInsuranceWithdrawal: "RequestInsuranceWithdrawal(uint256 shareAmount,uint256 nonce,uint256 deadline,uint256 relayerFee)",
  ExecuteInsuranceWithdrawal: "ExecuteInsuranceWithdrawal(uint256 nonce,uint256 deadline,uint256 relayerFee)",
  CreateOrder:
    "CreateOrder(uint8 orderType,uint256 triggerPrice,uint256 limitPrice,uint256 maxSlippageBp,uint256 size,bool isLong,bool isPostOnly,uint8 tif,uint256 expirationBlock,address integrator,uint256 nonce,uint256 deadline,uint256 relayerFee)",
  CancelOrders: "CancelOrders(uint256[] orderIds,uint256 nonce,uint256 deadline,uint256 relayerFee)",
  AmendOrders: "AmendOrders(uint256[] amends,uint256 nonce,uint256 deadline,uint256 relayerFee)",
};
const th = (pt: PrimaryType) => keccak256(toBytes(DOC_TYPES[pt]));
const words = (types: string[], values: unknown[]) => encodeAbiParameters(types.map((type) => ({ type })), values);

/** The digest exactly as BazaarPair builds it: abi.encode of the typehash and fields, arrays as keccak(encodePacked). */
function contractDigest(chainId: number, pair: Address, structHash: Hex): Hex {
  const ds = keccak256(
    words(["bytes32", "bytes32", "bytes32", "uint256", "address"], [
      keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
      keccak256(toBytes("BazaarPair")),
      keccak256(toBytes("1")),
      BigInt(chainId),
      pair,
    ]),
  );
  return keccak256(concat(["0x1901", ds, structHash]));
}
const packed = (xs: bigint[]) => keccak256(concat(xs.map((x) => toHex(x, { size: 32 }))));

const meta = { nonce: 4n, deadline: 1_700_000_010, relayerFee: 25n * 10n ** 16n };
const spec = buildOrderSpec({ orderType: STOP_LOSS, isLong: false, size: CLOSE_POSITION, triggerPrice: 1900n * E18, bounty: E18, maxSlippageBp: 150n }, INTEGRATOR);

describe("EIP-712 typed data", () => {
  it("uses the type strings the docs list, and the field lists encode to them", () => {
    expect(TYPE_STRINGS).toEqual(DOC_TYPES);
    for (const pt of Object.keys(DOC_TYPES) as PrimaryType[]) {
      expect(typeHash(pt)).toBe(th(pt));
      const fields = BAZAAR_TYPES[pt].map((f) => `${f.type} ${f.name}`).join(",");
      expect(`${pt}(${fields})`).toBe(DOC_TYPES[pt]);
    }
  });

  it("derives each pair's domain separator", () => {
    const manual = keccak256(
      words(["bytes32", "bytes32", "bytes32", "uint256", "address"], [
        keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
        keccak256(toBytes("BazaarPair")),
        keccak256(toBytes("1")),
        42161n,
        PAIR,
      ]),
    );
    expect(domainSeparator(42161, PAIR)).toBe(manual);
    expect(domainSeparator(1, PAIR)).not.toBe(manual);
  });

  const cases: [string, Parameters<typeof typedDataFor>[2], Hex][] = [
    ["DepositCollateral", { action: "depositCollateral", amount: 7n * E18 }, keccak256(words(["bytes32", "uint256", "uint256", "uint256", "uint256"], [th("DepositCollateral"), 7n * E18, meta.nonce, BigInt(meta.deadline), meta.relayerFee]))],
    ["WithdrawCollateral", { action: "withdrawCollateral", amount: 7n * E18 }, keccak256(words(["bytes32", "uint256", "uint256", "uint256", "uint256"], [th("WithdrawCollateral"), 7n * E18, meta.nonce, BigInt(meta.deadline), meta.relayerFee]))],
    ["DepositToInsurance", { action: "depositToInsurance", amount: 9n * E18 }, keccak256(words(["bytes32", "uint256", "uint256", "uint256", "uint256"], [th("DepositToInsurance"), 9n * E18, meta.nonce, BigInt(meta.deadline), meta.relayerFee]))],
    ["RequestInsuranceWithdrawal", { action: "requestInsuranceWithdrawal", shareAmount: 3n }, keccak256(words(["bytes32", "uint256", "uint256", "uint256", "uint256"], [th("RequestInsuranceWithdrawal"), 3n, meta.nonce, BigInt(meta.deadline), meta.relayerFee]))],
    ["ExecuteInsuranceWithdrawal", { action: "executeInsuranceWithdrawal" }, keccak256(words(["bytes32", "uint256", "uint256", "uint256"], [th("ExecuteInsuranceWithdrawal"), meta.nonce, BigInt(meta.deadline), meta.relayerFee]))],
    [
      "CreateOrder",
      { action: "createOrder", spec },
      keccak256(
        words(["bytes32", "uint8", "uint256", "uint256", "uint256", "uint256", "bool", "bool", "uint8", "uint64", "address", "uint256", "uint256", "uint256"], [
          th("CreateOrder"),
          spec.orderType,
          spec.triggerPrice,
          spec.limitPrice,
          spec.maxSlippageBp,
          spec.size,
          spec.isLong,
          spec.isPostOnly,
          spec.tif,
          spec.expirationBlock,
          spec.integrator,
          meta.nonce,
          BigInt(meta.deadline),
          meta.relayerFee,
        ]),
      ),
    ],
    ["CancelOrders", { action: "cancelOrders", orderIds: [5n, 9n, 11n] }, keccak256(words(["bytes32", "bytes32", "uint256", "uint256", "uint256"], [th("CancelOrders"), packed([5n, 9n, 11n]), meta.nonce, BigInt(meta.deadline), meta.relayerFee]))],
    [
      "AmendOrders",
      { action: "amendOrders", amends: [amendIdWord(5n, 2n, 0n, true), 2000n * E18, 3n * E18] },
      keccak256(words(["bytes32", "bytes32", "uint256", "uint256", "uint256"], [th("AmendOrders"), packed([amendIdWord(5n, 2n, 0n, true), 2000n * E18, 3n * E18]), meta.nonce, BigInt(meta.deadline), meta.relayerFee])),
    ],
  ];
  for (const [name, fields, structHash] of cases) {
    it(`hashes ${name} as the pair does`, () => {
      const td = typedDataFor(42161, PAIR, fields, meta);
      expect(td.primaryType).toBe(name);
      expect(td.domain).toEqual({ name: "BazaarPair", version: "1", chainId: 42161, verifyingContract: PAIR });
      expect(relayedDigest(td)).toBe(contractDigest(42161, PAIR, structHash));
    });
  }
});

describe("fees, deadlines and signatures", () => {
  it("floors the relayer fee to USDC precision and caps it at $1", () => {
    expect(floorRelayerFee(5n * 10n ** 17n + 999_999_999_999n)).toBe(5n * 10n ** 17n);
    expect(floorRelayerFee(MAX_RELAYER_FEE)).toBe(E18);
    expect(floorRelayerFee(10n ** 12n - 1n)).toBe(0n);
    expect(() => floorRelayerFee(E18 + 1n)).toThrow(InputError);
    expect(() => floorRelayerFee(-1n)).toThrow(InputError);
  });

  it("stamps deadlines from chain time, at most 10 s out", async () => {
    const { fake, ctx } = fakeContext();
    expect(await chainDeadline(ctx)).toBe(fake.timestamp + 10);
    expect(await chainDeadline(ctx, 4)).toBe(fake.timestamp + 4);
    await expect(chainDeadline(ctx, 11)).rejects.toThrow(InputError);
  });

  it("never stamps past the deployment's own window", async () => {
    const { fake, ctx } = fakeContext();
    fake.lens("getEip712Constants", { domainTypehash: "0x" + "00".repeat(32), nameHash: "0x" + "00".repeat(32), versionHash: "0x" + "00".repeat(32), maxRelayerFee: E18 / 2n, maxDeadlineWindow: 5n });
    expect(await chainDeadline(ctx)).toBe(fake.timestamp + 5);
    await expect(chainDeadline(ctx, 6)).rejects.toThrow(/at most 5 seconds/);
    fake.pair("metaTxNonces", 0n);
    const e = await signRelayed(ctx, { action: "executeInsuranceWithdrawal" }, { wallet: fake, signer: alice.address, pair: PAIR, relayerFee: E18 }).catch((x) => x);
    expect(e).toBeInstanceOf(InputError);
    expect(e.field).toBe("relayerFee");
  });

  it("normalizes v, expands compact signatures and refuses high s", async () => {
    const td = typedDataFor(42161, PAIR, { action: "executeInsuranceWithdrawal" }, meta);
    const sig = await alice.signTypedData(td as never);
    const v0 = (sig.slice(0, -2) + (parseInt(sig.slice(-2), 16) - 27).toString(16).padStart(2, "0")) as Hex;
    expect(normalizeSignature(v0)).toBe(sig);
    const yParity = parseInt(sig.slice(-2), 16) - 27;
    const s = BigInt("0x" + sig.slice(66, 130)) | (BigInt(yParity) << 255n);
    const compact = (sig.slice(0, 66) + s.toString(16).padStart(64, "0")) as Hex;
    expect(normalizeSignature(compact)).toBe(sig);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const high = (sig.slice(0, 66) + (n - BigInt("0x" + sig.slice(66, 130))).toString(16).padStart(64, "0") + "1c") as Hex;
    expect(() => normalizeSignature(high)).toThrow(SigningError);
    expect(() => normalizeSignature("0x1234")).toThrow(SigningError);
  });
});

describe("verifyTypehashes", () => {
  function deployment(overrides: Partial<Record<string, Hex>> = {}) {
    const { fake, ctx } = fakeContext();
    fake.lens("getTypehashes", {
      depositCollateral: th("DepositCollateral"),
      withdrawCollateral: th("WithdrawCollateral"),
      depositToInsurance: th("DepositToInsurance"),
      executeInsuranceWithdrawal: th("ExecuteInsuranceWithdrawal"),
      createOrder: th("CreateOrder"),
      cancelOrders: th("CancelOrders"),
      requestInsuranceWithdrawal: th("RequestInsuranceWithdrawal"),
      amendOrders: th("AmendOrders"),
      ...overrides,
    });
    fake.lens("getEip712Constants", {
      domainTypehash: keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
      nameHash: keccak256(toBytes("BazaarPair")),
      versionHash: keccak256(toBytes("1")),
      maxRelayerFee: E18,
      maxDeadlineWindow: 10n,
    });
    fake.pair("DOMAIN_SEPARATOR", domainSeparator(fake.chainId, PAIR));
    return ctx;
  }

  it("confirms the SDK signs what the deployment verifies", async () => {
    const r = await verifyTypehashes(deployment(), PAIR);
    expect(r.mismatches).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.domain?.sdk).toBe(r.domain?.chain);
  });

  it("reports a mismatch", async () => {
    const r = await verifyTypehashes(deployment({ createOrder: keccak256(toBytes("CreateOrder(uint8 orderType)")) }));
    expect(r.ok).toBe(false);
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0]).toMatch(/^CreateOrder typehash/);
  });
});

function usdcToken(fake: ReturnType<typeof fakeContext>["fake"], version: string | null = "2") {
  fake.usdc("name", "USD Coin");
  fake.usdc("version", () => {
    if (version === null) throw new Revert();
    return version;
  });
  const domain = { name: "USD Coin", version: version ?? "1", chainId: fake.chainId, verifyingContract: USDC };
  fake.usdc(
    "DOMAIN_SEPARATOR",
    keccak256(
      words(["bytes32", "bytes32", "bytes32", "uint256", "address"], [
        keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
        keccak256(toBytes(domain.name)),
        keccak256(toBytes(domain.version)),
        BigInt(domain.chainId),
        USDC,
      ]),
    ),
  );
  fake.usdc("nonces", 0n);
  return domain;
}

describe("permits", () => {
  it("reads USDC's domain, version 2 or the fallback, and checks it against DOMAIN_SEPARATOR", async () => {
    const a = fakeContext();
    usdcToken(a.fake, "2");
    expect(await usdcPermitDomain(a.ctx)).toEqual({ name: "USD Coin", version: "2", chainId: 42161, verifyingContract: USDC });
    const b = fakeContext();
    usdcToken(b.fake, null);
    expect((await usdcPermitDomain(b.ctx)).version).toBe("1");
    const c = fakeContext();
    usdcToken(c.fake, "2");
    c.fake.usdc("version", "3");
    await expect(usdcPermitDomain(c.ctx)).rejects.toThrow(/DOMAIN_SEPARATOR/);
  });

  it("encodes permitData as abi.encode(value, deadline, v, r, s)", () => {
    const r = ("0x" + "11".repeat(32)) as Hex;
    const s = ("0x" + "22".repeat(32)) as Hex;
    const d = encodePermitData(5_000_000n, 99, 27, r, s);
    expect(d).toBe(words(["uint256", "uint256", "uint8", "bytes32", "bytes32"], [5_000_000n, 99n, 27, r, s]));
    expect(decodePermitData(d)).toEqual({ value: 5_000_000n, deadline: 99, v: 27, r, s });
  });
});

describe("signRelayed / verifyRelayed / encodeRelayed", () => {
  it("signs a deposit with a permit covering deposit plus fee, permit first", async () => {
    const { fake, ctx } = fakeContext();
    const domain = usdcToken(fake);
    fake.usdc("allowance", 100_249_999n); // one micro-USDC short of deposit + fee
    fake.pair("metaTxNonces", 3n);
    const req = await signRelayed(ctx, { action: "depositCollateral", amount: 100n * E18 + 5n }, { wallet: fake, signer: alice.address, pair: PAIR, relayerFee: 25n * 10n ** 16n + 7n, permit: true });
    expect(req).toMatchObject({ action: "depositCollateral", amount: 100n * E18, pair: PAIR, chainId: 42161, signer: alice.address, nonce: 3n, deadline: fake.timestamp + 10, relayerFee: 25n * 10n ** 16n });
    const signs = fake.requests.filter((r) => r.method === "eth_signTypedData_v4").map((r) => JSON.parse(r.params[1] as string).primaryType);
    expect(signs).toEqual(["Permit", "DepositCollateral"]);
    const p = decodePermitData(req.permitData);
    expect(p.value).toBe(100_250_000n);
    expect(p.deadline).toBe(fake.timestamp + 1800);
    const signature = `${p.r}${p.s.slice(2)}${p.v.toString(16)}` as Hex;
    const td = permitTypedData(domain, { owner: alice.address, spender: PAIR, value: p.value, nonce: 0n, deadline: p.deadline });
    expect(await recoverTypedDataAddress({ ...td, signature } as never)).toBe(alice.address);
    expect(await recoverTypedDataAddress({ ...typedDataFor(42161, PAIR, req, req), signature: req.signature } as never)).toBe(alice.address);

    const check = await verifyRelayed(ctx, req);
    expect(check).toMatchObject({ ok: true, signer: alice.address, problems: [], warnings: [], secondsLeft: 10 });

    const call = await encodeRelayed(ctx, req, { relayer: bob.address });
    expect(decodeFunctionData({ abi: pairAbi, data: call.data }).args).toEqual([100n * E18, 3n, BigInt(fake.timestamp + 10), 25n * 10n ** 16n, req.signature, req.permitData]);
    expect(call).toMatchObject({ action: "depositCollateral", to: PAIR, value: 0n, from: bob.address, pullsUsdc: 100n * E18 + 25n * 10n ** 16n });
  });

  it("skips the permit when the allowance already covers the pull", async () => {
    const { fake, ctx } = fakeContext();
    usdcToken(fake);
    fake.usdc("allowance", 100_250_000n);
    fake.pair("metaTxNonces", 0n);
    const opts = { wallet: fake, signer: alice.address, pair: PAIR, relayerFee: 25n * 10n ** 16n };
    expect((await signRelayed(ctx, { action: "depositCollateral", amount: 100n * E18 }, { ...opts, permit: true })).permitData).toBe("0x");
    expect((await signRelayed(ctx, { action: "depositCollateral", amount: 100n * E18 }, { ...opts, permit: { always: true } })).permitData).not.toBe("0x");
    // a zero-fee cancel pulls nothing, so it needs no permit at all
    expect((await signRelayed(ctx, { action: "cancelOrders", orderIds: [1n] }, { ...opts, relayerFee: 0n, permit: true })).permitData).toBe("0x");
  });

  it("finds what would make a request revert", async () => {
    const { fake, ctx } = fakeContext();
    fake.pair("metaTxNonces", 3n);
    const req = await signRelayed(ctx, { action: "cancelOrders", orderIds: [5n] }, { wallet: fake, signer: alice.address, pair: PAIR, relayerFee: 10n ** 16n });
    const tampered = await verifyRelayed(ctx, { ...req, orderIds: [6n] } as RelayedRequest);
    expect(tampered.problems.map((p) => p.field)).toEqual(["signature"]);
    fake.pair("metaTxNonces", 4n);
    expect((await verifyRelayed(ctx, req)).problems.map((p) => p.message)).toEqual([expect.stringMatching(/already used/)]);
    fake.pair("metaTxNonces", 3n);
    fake.timestamp += 11;
    const late = await verifyRelayed(ctx, req);
    expect(late.problems.map((p) => p.field)).toEqual(["deadline"]);
    expect(late.secondsLeft).toBe(-1);
    expect((await verifyRelayed(ctx, { ...req, chainId: 1 })).problems.map((p) => p.field)).toContain("chainId");
  });

  it("signs an order, then attaches fresh hints and a price at submission", async () => {
    const { fake, ctx } = fakeContext();
    fake.pair("metaTxNonces", 0n);
    fake.pair("positionBuckets", bucket());
    fake.lens("getUserActiveLimitOrders", { orderIds: [], count: 0n, longExposure: 0n, shortExposure: 0n });
    const order = { orderType: LIMIT, isLong: false, size: E18, limitPrice: 2010n * E18, expirationBlock: 9000 } as const;
    const req = await signRelayed(ctx, { action: "createOrder", order }, { wallet: fake, signer: alice.address, pair: PAIR, relayerFee: E18 / 10n });
    expect(req.action === "createOrder" && req.spec.integrator).toBe(INTEGRATOR);
    fake.lens("findPredecessor", { pred: 42n, found: true });
    const call = await encodeRelayed(ctx, req);
    const [s, hints, update, nonce, deadline, fee, sig, permit] = decodeFunctionData({ abi: pairAbi, data: call.data }).args as readonly unknown[];
    expect(s).toEqual(req.action === "createOrder" ? req.spec : null);
    expect(hints).toEqual({ pred: 42n, pred2: 0n, pred3: 0n, pred4: 0n, maxSteps: 0 });
    expect(update).toEqual([mockUpdate(FEED, 2000_00000000n, fake.timestamp)]);
    expect([nonce, deadline, fee, sig, permit]).toEqual([0n, BigInt(req.deadline), E18 / 10n, req.signature, "0x"]);
    expect(call.value).toBe(7n);
    expect(call.pullsUsdc).toBe(E18 / 10n);
    expect(call.from).toBeNull();
  });

  it("signs an amendment's hints into its words", async () => {
    const { fake, ctx } = fakeContext();
    fake.pair("metaTxNonces", 0n);
    fake.pair("orders", () => storedOrder({ limitPrice: 1990n * E18, prevInBook: 2 }));
    fake.pair("book", { bidHead: 11n, askHead: 0n, bidCount: 1n, askCount: 0n });
    fake.pair("positionBuckets", bucket());
    fake.pair("lastPairPrice", { spotPrice: 2000n * E18, emaVarianceBp: 0n, updateTs: 0n, lowPrice: 0n, highPrice: 0n });
    fake.lens("findPredecessor", { pred: 8n, found: true });
    const req = await signRelayed(ctx, { action: "amendOrders", amendments: [{ orderId: 11n, limitPrice: 1950n * E18, size: E18, bestEffort: true }] }, { wallet: fake, signer: alice.address, pair: PAIR });
    expect(req.action === "amendOrders" && req.amends).toEqual([amendIdWord(11n, 8n, 0n, true), 1950n * E18, E18]);
    const call = await encodeRelayed(ctx, req);
    expect((decodeFunctionData({ abi: pairAbi, data: call.data }).args as readonly unknown[])[0]).toEqual(req.action === "amendOrders" ? req.amends : null);
    expect(fake.callsTo("findPredecessor")).toHaveLength(1);
  });

  it("refuses what cannot be relayed", async () => {
    const { fake, ctx } = fakeContext();
    fake.pair("metaTxNonces", 0n);
    const opts = { wallet: fake, signer: alice.address, pair: PAIR };
    expect((await signRelayed(ctx, { action: "withdrawCollateral", amount: E18 }, { ...opts, permit: true }).catch((e) => e)).field).toBe("permit");
    expect((await signRelayed(ctx, { action: "depositCollateral", amount: 5n * E18 }, { ...opts, relayerFee: 5n * E18 }).catch((e) => e)).field).toBe("relayerFee");
    expect((await signRelayed(ctx, { action: "depositCollateral", amount: 6n * E18 }, { ...opts, relayerFee: 6n * 10n ** 17n + E18 }).catch((e) => e)).field).toBe("relayerFee");
    expect((await signRelayed(ctx, { action: "cancelOrders", orderIds: [] }, opts).catch((e) => e)).field).toBe("orderIds");
    expect((await signRelayed(ctx, { action: "executeInsuranceWithdrawal" }, { ...opts, deadlineWindow: 30 }).catch((e) => e)).field).toBe("deadline");
  });

  it("refuses a wallet that does not sign as the account, and a declined prompt", async () => {
    const { fake, ctx } = fakeContext();
    fake.pair("metaTxNonces", 0n);
    fake.signOverride = () => "0x" + "ab".repeat(65) as Hex;
    await expect(signRelayed(ctx, { action: "executeInsuranceWithdrawal" }, { wallet: fake, signer: alice.address, pair: PAIR })).rejects.toThrow(SigningError);
    const sig = await bob.signTypedData(typedDataFor(42161, PAIR, { action: "executeInsuranceWithdrawal" }, { nonce: 0n, deadline: fake.timestamp + 10, relayerFee: 0n }) as never);
    fake.signOverride = () => sig;
    await expect(signRelayed(ctx, { action: "executeInsuranceWithdrawal" }, { wallet: fake, signer: alice.address, pair: PAIR })).rejects.toThrow(/does not sign as a plain account/);
    fake.signOverride = () => {
      throw Object.assign(new Error("User rejected the request."), { code: 4001 });
    };
    await expect(signRelayed(ctx, { action: "executeInsuranceWithdrawal" }, { wallet: fake, signer: alice.address, pair: PAIR })).rejects.toThrow(/declined/);
  });

  it("round-trips through JSON", async () => {
    const { fake, ctx } = fakeContext();
    fake.pair("metaTxNonces", 12n);
    const req = await signRelayed(ctx, { action: "createOrder", spec }, { wallet: fake, signer: alice.address, pair: PAIR, relayerFee: 10n ** 15n });
    const json = serializeRelayed(req);
    expect(JSON.parse(json).spec.triggerPrice).toBe(spec.triggerPrice.toString());
    expect(parseRelayed(json)).toEqual(req);
    expect(() => parseRelayed({ ...JSON.parse(json), signer: "nope" })).toThrow(InputError);
    expect(() => parseRelayed({ ...JSON.parse(json), action: "claimFees" })).toThrow(InputError);
    void getAddress;
  });
});

describe("deadlines against this device's clock (an RPC cannot stretch them)", () => {
  it("refuses a chain time more than 2 minutes off the device's clock, before anything is signed", async () => {
    const { fake, ctx } = fakeContext();
    fake.pair("metaTxNonces", 0n);
    fake.timestamp = FAKE_NOW + 30 * 86_400; // the RPC claims a block 30 days ahead
    await expect(chainDeadline(ctx)).rejects.toThrow(ClockSkewError);
    const e = await signRelayed(ctx, { action: "cancelOrders", orderIds: [5n] }, { wallet: fake, signer: alice.address, pair: PAIR }).catch((x) => x);
    expect(e).toBeInstanceOf(ClockSkewError);
    expect(e.message).toMatch(/2592000 s ahead of this device's clock/);
    fake.timestamp = FAKE_NOW - 121;
    await expect(chainDeadline(ctx)).rejects.toThrow(/121 s behind this device's clock/);
    expect(fake.requests.some((r) => r.method === "eth_signTypedData_v4")).toBe(false);
  });

  it("counts from the lower of the two clocks, and refuses one that would arrive expired", async () => {
    const { fake, ctx } = fakeContext();
    fake.timestamp = FAKE_NOW - 60; // the chain's latest block lags the device
    expect(await chainDeadline(ctx)).toBe(FAKE_NOW - 50);
    fake.timestamp = FAKE_NOW + 4; // the device lags the chain, within the window
    expect(await chainDeadline(ctx)).toBe(FAKE_NOW + 10);
    fake.timestamp = FAKE_NOW + 60; // ... beyond it
    await expect(chainDeadline(ctx)).rejects.toThrow(/60 s behind the network's/);
    expect(checkClockSkew(FAKE_NOW + 120)).toBe(FAKE_NOW);
    expect(() => checkClockSkew(FAKE_NOW + 121)).toThrow(ClockSkewError);
    expect(checkClockSkew(5_000, 5_100.9)).toBe(5_000);
  });

  it("stamps a permit's default deadline the same way", async () => {
    const { fake, ctx } = fakeContext();
    usdcToken(fake);
    fake.timestamp = FAKE_NOW + 60;
    expect((await signPermit(ctx, fake, { owner: alice.address, spender: PAIR, value: 1_000_000n })).deadline).toBe(FAKE_NOW + 1800);
    fake.timestamp = FAKE_NOW + 30 * 86_400;
    await expect(signPermit(ctx, fake, { owner: alice.address, spender: PAIR, value: 1_000_000n })).rejects.toThrow(ClockSkewError);
  });

  it("lets a local dev chain (Anvil) run on its own warped clock", async () => {
    const { fake, ctx } = fakeContext();
    const anvil = { ...ctx, chainId: 31337 };
    fake.timestamp = FAKE_NOW + 13 * 86_400;
    expect(await chainDeadline(anvil)).toBe(fake.timestamp + 10);
    await expect(chainDeadline(ctx)).rejects.toThrow(ClockSkewError);
  });
});

describe("gasless calls name only the deployment's pairs", () => {
  const ATTACKER = getAddress("0x000000000000000000000000000000000000dead");

  it("refuses to sign a request or a permit for any other contract", async () => {
    const { fake, ctx } = fakeContext();
    usdcToken(fake);
    fake.usdc("allowance", 0n);
    const e = await signRelayed(ctx, { action: "depositCollateral", amount: 1000n * E18 }, { wallet: fake, signer: alice.address, pair: ATTACKER, nonce: 0n, permit: true }).catch((x) => x);
    expect(e).toBeInstanceOf(InputError);
    expect(e.field).toBe("pair");
    expect((await signPermit(ctx, fake, { owner: alice.address, spender: ATTACKER, value: 1000_000000n }).catch((x) => x)).field).toBe("pair");
    expect(fake.requests.some((r) => r.method === "eth_signTypedData_v4")).toBe(false);
  });

  it("verifyRelayed and encodeRelayed refuse a request naming another contract", async () => {
    const { fake, ctx } = fakeContext();
    fake.pair("metaTxNonces", 0n);
    const req = await signRelayed(ctx, { action: "cancelOrders", orderIds: [5n] }, { wallet: fake, signer: alice.address, pair: PAIR });
    // the same request, signed under the other contract's domain
    const forged = { ...req, pair: ATTACKER, signature: await alice.signTypedData(typedDataFor(42161, ATTACKER, req, req) as never) } as RelayedRequest;
    const check = await verifyRelayed(ctx, forged);
    expect(check.ok).toBe(false);
    expect(check.problems.map((p) => p.field)).toEqual(["pair"]);
    await expect(encodeRelayed(ctx, forged)).rejects.toMatchObject({ field: "pair" });
  });
});

describe("canonical signatures: what is verified is what is submitted", () => {
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  /** The same signature with v as 0/1, and in EIP-2098 compact form. */
  function variants(sig: Hex): Hex[] {
    const b = hexToBytes(sig);
    const v01 = new Uint8Array(b);
    v01[64] = v01[64]! - 27;
    const compact = new Uint8Array(b.subarray(0, 64));
    if (b[64] === 28) compact[32] = compact[32]! | 0x80;
    return [bytesToHex(v01), bytesToHex(compact)];
  }

  it("refuses a non-canonical signature in verifyRelayed and encodeRelayed; parseRelayed canonicalizes it", async () => {
    const { fake, ctx } = fakeContext();
    fake.pair("metaTxNonces", 3n);
    const req = await signRelayed(ctx, { action: "cancelOrders", orderIds: [5n] }, { wallet: fake, signer: alice.address, pair: PAIR, relayerFee: 10n ** 16n });
    for (const signature of variants(req.signature)) {
      const raw = { ...req, signature } as RelayedRequest;
      const check = await verifyRelayed(ctx, raw);
      expect(check.problems.map((p) => p.field)).toEqual(["signature"]);
      expect(check.problems[0]!.message).toMatch(/v 27 or 28/);
      await expect(encodeRelayed(ctx, raw)).rejects.toMatchObject({ field: "signature" });
      const parsed = parseRelayed(serializeRelayed(raw));
      expect(parsed.signature).toBe(req.signature);
      expect((await verifyRelayed(ctx, parsed)).ok).toBe(true);
      const sent = (decodeFunctionData({ abi: pairAbi, data: (await encodeRelayed(ctx, parsed)).data }).args as readonly unknown[])[4];
      expect(sent).toBe(req.signature);
    }
    const s = BigInt("0x" + req.signature.slice(66, 130));
    const high = (req.signature.slice(0, 66) + (N - s).toString(16).padStart(64, "0") + (req.signature.endsWith("1b") ? "1c" : "1b")) as Hex;
    expect(() => parseRelayed({ ...JSON.parse(serializeRelayed(req)), signature: high })).toThrow(InputError);
  });

  it("checkPermit refuses v 0/1 and a high s, which USDC's ecrecover refuses", async () => {
    const { fake, ctx } = fakeContext();
    usdcToken(fake);
    fake.usdc("allowance", 0n);
    fake.pair("metaTxNonces", 0n);
    const req = await signRelayed(ctx, { action: "depositCollateral", amount: 100n * E18 }, { wallet: fake, signer: alice.address, pair: PAIR, relayerFee: E18 / 4n, permit: true });
    const p = decodePermitData(req.permitData);
    const need = { owner: alice.address, spender: PAIR, needUsdc: p.value };
    expect(await checkPermit(ctx, req.permitData, need)).toMatchObject({ ok: true, problems: [] });
    const v01 = encodePermitData(p.value, p.deadline, p.v - 27, p.r, p.s);
    expect(await checkPermit(ctx, v01, need)).toMatchObject({ ok: false, problems: [`the permit's v is ${p.v - 27}; USDC accepts only 27 or 28`] });
    expect((await verifyRelayed(ctx, { ...req, permitData: v01 })).warnings.join(" ")).toMatch(/USDC accepts only 27 or 28/);
    const highS = encodePermitData(p.value, p.deadline, p.v === 27 ? 28 : 27, p.r, toHex(N - BigInt(p.s), { size: 32 }));
    expect((await checkPermit(ctx, highS, need)).problems).toContain("the permit's signature has a high s, which USDC refuses");
  });

  it("signPermit's permitData carries v 27/28 even from a wallet that returns 0/1", async () => {
    const { fake, ctx } = fakeContext();
    usdcToken(fake);
    fake.signOverride = ((_who: Address, json: string) =>
      alice.signTypedData(reviveTypedData(json) as never).then((sig) => {
        const b = hexToBytes(sig);
        b[64] = b[64]! - 27;
        return bytesToHex(b);
      })) as never;
    const p = await signPermit(ctx, fake, { owner: alice.address, spender: PAIR, value: 5_000_000n });
    expect([27, 28]).toContain(p.v);
    expect(decodePermitData(p.permitData).v).toBe(p.v);
    expect((await checkPermit(ctx, p.permitData, { owner: alice.address, spender: PAIR, needUsdc: 5_000_000n })).ok).toBe(true);
  });
});

describe("relayed withdrawals on a terminated pair", () => {
  const entitlement = (principalRatio: bigint) => ({ collateral: 10n * E18, registeredClaim: 0n, principalRatio, profitRatio: 0n, payout: 10n * principalRatio });

  it("judge the relayer fee against the payout (amount x principalRatio), not the amount", async () => {
    const { fake, ctx } = fakeContext();
    fake.pair("metaTxNonces", 0n);
    const opts = { wallet: fake, signer: alice.address, pair: PAIR, relayerFee: E18 };
    const signed = await signRelayed(ctx, { action: "withdrawCollateral", amount: 3n * E18 }, opts);
    expect((await verifyRelayed(ctx, signed)).ok).toBe(true);
    fake.pair("isPairTerminated", true);
    fake.lens("getTerminalEntitlement", entitlement(E18 / 4n)); // 3 USDC of collateral pays 0.75, under the $1 fee
    const e = await signRelayed(ctx, { action: "withdrawCollateral", amount: 3n * E18 }, opts).catch((x) => x);
    expect(e).toMatchObject({ field: "relayerFee" });
    expect(e.message).toMatch(/pays 0\.75 USDC/);
    expect((await verifyRelayed(ctx, signed)).problems.map((p) => p.field)).toEqual(["relayerFee"]);
    fake.lens("getTerminalEntitlement", entitlement(E18 / 2n)); // pays 1.5
    const call = await encodeRelayed(ctx, signed);
    expect(call.summary).toContain("withdraw 3 USDC collateral (the market is terminated: it pays 1.5 USDC, 50% of the amount) (fee 1 USDC)");
    expect(call.pullsUsdc).toBe(0n);
  });

  it("take the fee from the wallet when the payout is 0, and say so", async () => {
    const { fake, ctx } = fakeContext();
    fake.pair("metaTxNonces", 0n);
    const opts = { wallet: fake, signer: alice.address, pair: PAIR, relayerFee: E18 / 5n };
    const signed = await signRelayed(ctx, { action: "withdrawCollateral", amount: 3n * E18 }, opts);
    fake.pair("isPairTerminated", true);
    fake.lens("getTerminalEntitlement", entitlement(0n));
    expect((await signRelayed(ctx, { action: "withdrawCollateral", amount: 3n * E18 }, opts).catch((x) => x)).field).toBe("amount");
    const check = await verifyRelayed(ctx, signed);
    expect(check.ok).toBe(true);
    expect(check.warnings.join(" ")).toMatch(/pulled from the signer's wallet/);
    expect((await encodeRelayed(ctx, signed)).pullsUsdc).toBe(E18 / 5n);
    expect(await relayedPull(ctx, PAIR, alice.address, signed, E18 / 5n)).toBe(E18 / 5n);
  });
});
