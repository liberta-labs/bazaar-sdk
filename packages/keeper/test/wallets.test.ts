import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bytesToHex, parseTransaction, serializeTransaction } from "viem";
import { WalletConfig } from "../src/config/index.js";
import {
  LocalSigner,
  RemoteSigner,
  type TxRequest,
  WalletError,
  checkMnemonic,
  decryptKeystore,
  loadSigner,
  newKey,
  writeKeystore,
} from "../src/exec/wallets.js";

// Anvil's first test account, and keystores of it written by eth-account.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const PY_SCRYPT = {
  address: "f39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  crypto: {
    cipher: "aes-128-ctr",
    cipherparams: { iv: "fe84d100828425e96c71631e46402ffa" },
    ciphertext: "644c5dc04d680ec24e496ae78d8026ede6fd792c07c76d5a7f77860628ce5ddc",
    kdf: "scrypt",
    kdfparams: { dklen: 32, n: 262144, r: 8, p: 1, salt: "b7d994b41ee381573f6fd5c753e95820" },
    mac: "825834a8dff4522f1c003997047df65f2eb6ee833cd5731411013701714551ff",
  },
  id: "0b5b5527-1155-4095-a749-6663a4e9d178",
  version: 3,
};
const PY_PBKDF2 = {
  address: "f39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  crypto: {
    cipher: "aes-128-ctr",
    cipherparams: { iv: "1ea9dac8b1ceb5a4f47ab9a529ccd5a1" },
    ciphertext: "7bca5c036dd088beb9b10f61ea08e12c4851565226a4a35770f03e17d021419e",
    kdf: "pbkdf2",
    kdfparams: { c: 4096, dklen: 32, prf: "hmac-sha256", salt: "03bb9204222cafa88424509282af55a4" },
    mac: "67c02e216fe24d489484a3ed7cccf7a49c3c67c58d48ffe667657c18a898a3f3",
  },
  id: "266f3db3-6b3e-449b-963c-a44cc92dfe05",
  version: 3,
};
// eth-account's own documented example: scrypt with n = 2^18, r = 1, p = 8.
const ETH_ACCOUNT_DOC = {
  address: "5ce9454909639D2D17A3F753ce7d93fa0b9aB12E",
  crypto: {
    cipher: "aes-128-ctr",
    cipherparams: { iv: "482ef54775b0cc59f25717711286f5c8" },
    ciphertext: "cb636716a9fd46adbb31832d964df2082536edd5399a3393327dc89b0193a2be",
    kdf: "scrypt",
    kdfparams: { dklen: 32, n: 262144, p: 8, r: 1, salt: "d3c9a9945000fcb6c9df0f854266d573" },
    mac: "4f626ec5e7fea391b2229348a65bfef532c2a4e8372c0a6a814505a350a7689d",
  },
  id: "b812f3f9-78cc-462a-9e89-74418aa27cb0",
  version: 3,
};
// eth-account's sign_transaction of this transaction with KEY.
const TX: TxRequest = {
  type: "eip1559",
  chainId: 42161,
  nonce: 7,
  to: "0x1212121212121212121212121212121212121212",
  value: 0n,
  data: "0xdeadbeef",
  gas: 123456n,
  maxFeePerGas: 20_000_000n,
  maxPriorityFeePerGas: 0n,
};
const PY_RAW =
  "0x02f86d82a4b107808401312d008301e2409412121212121212121212121212121212121212128084deadbeefc001a05a67f207775634f773de0a7457eec3f971d1f41e78792dbb1b91f80445619951a064985589e4855d32c9b86d344afb01e3efc8bd066b2745c9681ab5a75be8444a";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bazaar-wallets-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const wallet = (w: Record<string, unknown>) => WalletConfig.parse(w);

describe("local signing", () => {
  it("signs EIP-1559 transactions byte for byte as eth-account does", async () => {
    const s = new LocalSigner(KEY);
    expect(s.address).toBe(ADDRESS);
    expect(await s.sign(TX)).toBe(PY_RAW);
    expect(new LocalSigner(KEY.slice(2)).address).toBe(ADDRESS); // with or without 0x
  });

  it("refuses bad keys without quoting them", () => {
    for (const bad of ["0x1234", "0x" + "00".repeat(32), "0x" + "ff".repeat(32), "zz" + KEY.slice(4)]) {
      let err: unknown;
      try {
        new LocalSigner(bad);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(WalletError);
      expect((err as Error).message).toMatch(/^not a valid private key/);
      expect((err as Error).message).not.toContain(bad.slice(4));
    }
  });

  it("makes new valid keys", () => {
    const a = newKey();
    const b = newKey();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(new LocalSigner(a).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe("keystores", () => {
  it("reads an eth-account scrypt keystore", async () => {
    expect(bytesToHex(await decryptKeystore(PY_SCRYPT, "correct horse"))).toBe(KEY);
    await expect(decryptKeystore(PY_SCRYPT, "wrong")).rejects.toThrow("wrong keystore password");
  });

  it("reads pbkdf2 keystores, and eth-account's documented example", async () => {
    expect(bytesToHex(await decryptKeystore(PY_PBKDF2, "battery staple"))).toBe(KEY);
    expect(bytesToHex(await decryptKeystore(ETH_ACCOUNT_DOC, "password"))).toBe(
      "0xb25c7db31feed9122727bf0939dc769a96564b2de4c4726d035b36ecf1e5b364",
    );
    // geth's capitalised "Crypto" key is read too
    const { crypto, ...rest } = PY_PBKDF2;
    expect(bytesToHex(await decryptKeystore({ ...rest, Crypto: crypto }, "battery staple"))).toBe(KEY);
  });

  it("refuses what it cannot read", async () => {
    await expect(decryptKeystore({ ...PY_PBKDF2, version: 4 }, "x")).rejects.toThrow(/version 4 is not supported/);
    await expect(decryptKeystore({ ...PY_PBKDF2, crypto: { ...PY_PBKDF2.crypto, kdf: "argon2" } }, "x")).rejects.toThrow(
      /key derivation "argon2"/,
    );
    await expect(decryptKeystore({ ...PY_PBKDF2, crypto: { ...PY_PBKDF2.crypto, cipher: "aes-128-cbc" } }, "x")).rejects.toThrow(
      /cipher "aes-128-cbc"/,
    );
  });

  it("writes a v3 keystore, owner-only, and never over an existing file", async () => {
    const path = join(dir, "keys", "default.json");
    expect(await writeKeystore(KEY, "pw", path)).toBe(ADDRESS);
    const text = readFileSync(path, "utf8");
    const data = JSON.parse(text);
    expect(Object.keys(data)).toEqual(["address", "crypto", "id", "version"]);
    expect(data.address).toBe(ADDRESS.slice(2));
    expect(data.version).toBe(3);
    expect(data.crypto.cipher).toBe("aes-128-ctr");
    expect(data.crypto.kdf).toBe("scrypt");
    expect(data.crypto.kdfparams).toMatchObject({ dklen: 32, n: 262144, r: 8, p: 1 });
    expect(data.crypto.kdfparams.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(data.crypto.cipherparams.iv).toMatch(/^[0-9a-f]{32}$/);
    expect(text.startsWith('{"address": "')).toBe(true); // json.dumps spacing
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(bytesToHex(await decryptKeystore(data, "pw"))).toBe(KEY);
    await expect(writeKeystore(KEY, "pw", path)).rejects.toThrow(/already exists/);
  });
});

describe("loadSigner", () => {
  it("loads keys, keystores and mnemonics", async () => {
    expect((await loadSigner("default", wallet({ type: "privateKey", key: KEY }))).address).toBe(ADDRESS);
    const path = join(dir, "k.json");
    writeFileSync(path, JSON.stringify(PY_PBKDF2));
    expect((await loadSigner("default", wallet({ type: "keystore", path, password: "battery staple" }))).address).toBe(ADDRESS);
    const anvil = "test test test test test test test test test test test junk";
    expect((await loadSigner("m", wallet({ type: "mnemonic", phrase: anvil }))).address).toBe(ADDRESS);
    const phrase = "abandon ".repeat(11) + "about";
    // eth-account's from_mnemonic(phrase, account_path="m/44'/60'/0'/0/3")
    expect((await loadSigner("m", wallet({ type: "mnemonic", phrase, index: 3 }))).address).toBe(
      "0xF3f50213C1d2e255e4B2bAD430F8A38EEF8D718E",
    );
  });

  it("explains a missing keystore password instead of prompting without a terminal", async () => {
    const path = join(dir, "k.json");
    writeFileSync(path, JSON.stringify(PY_PBKDF2));
    const isTTY = process.stdin.isTTY;
    try {
      (process.stdin as { isTTY?: boolean }).isTTY = false;
      await expect(loadSigner("fast", wallet({ type: "keystore", path }))).rejects.toThrow(
        /wallet fast \(k\.json\) needs a password: set wallets\.fast\.password: \$\{KEEPER_KEYSTORE_PASSWORD\}.*KEEPER_KEYSTORE_PASSWORD in \.env/,
      );
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = isTTY;
    }
  });

  it("names the wallet in errors and never the secret", async () => {
    await expect(loadSigner("fast", wallet({ type: "keystore", path: join(dir, "missing.json"), password: "x" }))).rejects.toThrow(
      /wallet fast: cannot read keystore .*missing\.json: No such file or directory/,
    );
    const path = join(dir, "k.json");
    writeFileSync(path, JSON.stringify(PY_PBKDF2));
    await expect(loadSigner("fast", wallet({ type: "keystore", path, password: "nope" }))).rejects.toThrow(
      "wallet fast: wrong keystore password",
    );
    // eth-account refuses both (and quotes the words; this does not)
    const bad = "junk " + "test ".repeat(11).trim();
    let err: unknown;
    try {
      await loadSigner("m", wallet({ type: "mnemonic", phrase: bad }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WalletError);
    expect((err as Error).message).toMatch(/^wallet m: the mnemonic's checksum does not match/);
    expect((err as Error).message).not.toContain("junk");
    expect(() => checkMnemonic("abandon ".repeat(12))).toThrow(/fit several languages' word lists/);
    expect(() => checkMnemonic("abandon about")).toThrow(/has 2 words/);
    expect(() => checkMnemonic("abandon ".repeat(11) + "notaword")).toThrow(/word 12 of the mnemonic is not in any BIP39 word list/);
  });
});

describe("RemoteSigner", () => {
  const URL_WITH_KEY = "https://signer.example/v1/AbCdEf1234567890XyZ/rpc";

  it("asks eth_signTransaction with hex quantities and the wallet as from", async () => {
    let body: { method: string; params: Record<string, string>[] } | null = null;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { raw: PY_RAW.toUpperCase().replace("0X", "0x"), tx: {} } }));
    }) as unknown as typeof fetch;
    const s = new RemoteSigner(URL_WITH_KEY, ADDRESS.toLowerCase(), { fetch: fetchFn });
    expect(s.address).toBe(ADDRESS);
    expect(await s.sign(TX)).toBe(PY_RAW);
    expect(body!.method).toBe("eth_signTransaction");
    expect(body!.params[0]).toEqual({
      type: "0x2",
      chainId: "0xa4b1",
      nonce: "0x7",
      to: TX.to,
      value: "0x0",
      data: "0xdeadbeef",
      gas: "0x1e240",
      maxFeePerGas: "0x1312d00",
      maxPriorityFeePerGas: "0x0",
      from: ADDRESS,
    });
    expect(parseTransaction(await s.sign(TX)).nonce).toBe(7);
  });

  it("never puts its URL's key in an error", async () => {
    const down = (async (url: string) => {
      throw new TypeError(`Failed to parse URL from ${url}`);
    }) as unknown as typeof fetch;
    const refused = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const said = (async () => new Response(JSON.stringify({ error: { message: "locked" } }))) as unknown as typeof fetch;
    for (const [f, re] of [
      [down, /did not answer/],
      [refused, /HTTP 401/],
      [said, /remote signer refused: locked/],
    ] as const) {
      let err: unknown;
      try {
        await new RemoteSigner(URL_WITH_KEY, ADDRESS, { fetch: f }).sign(TX);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(WalletError);
      expect((err as Error).message).toMatch(re);
      expect((err as Error).message).not.toContain("AbCdEf1234567890XyZ");
    }
    expect(new RemoteSigner(URL_WITH_KEY, ADDRESS).displayUrl).toBe("https://signer.example/v1/***/rpc");
  });

  it("refuses a signed transaction that is not the one asked for, or not signed by the wallet", async () => {
    const answering = (raw: string) =>
      (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: raw }))) as unknown as typeof fetch;
    const me = new LocalSigner(KEY);
    const other = new LocalSigner("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const unsigned = serializeTransaction({ ...TX, type: "eip1559" });
    for (const [raw, re] of [
      [await me.sign({ ...TX, to: "0x3434343434343434343434343434343434343434" }), /differs from the one asked for \(to\)/],
      [await me.sign({ ...TX, data: "0xdeadbeef00", value: 1n }), /differs from the one asked for \(value, data\)/],
      [await me.sign({ ...TX, nonce: 8, maxFeePerGas: 1n }), /\(nonce, maxFeePerGas\)/],
      [await me.sign({ ...TX, chainId: 1, gas: 21_000n }), /\(chainId, gas\)/],
      [await other.sign(TX), new RegExp(`signed by ${other.address}, not by the configured ${ADDRESS}`)],
      [unsigned, /an unsigned transaction/],
      ["0x02c0", /does not parse/],
    ] as const) {
      let err: unknown;
      try {
        await new RemoteSigner(URL_WITH_KEY, ADDRESS, { fetch: answering(raw) }).sign(TX);
      } catch (e) {
        err = e;
      }
      expect(err, raw).toBeInstanceOf(WalletError);
      expect((err as Error).message).toMatch(re);
      expect((err as Error).message).toMatch(/nothing was sent$/);
      expect((err as Error).message).not.toContain("AbCdEf1234567890XyZ");
    }
    // the very transaction, signed by the wallet, passes
    expect(await new RemoteSigner(URL_WITH_KEY, ADDRESS, { fetch: answering(PY_RAW) }).sign(TX)).toBe(PY_RAW);
  });

  it("never echoes a bad address", () => {
    let err: unknown;
    try {
      new RemoteSigner(URL_WITH_KEY, KEY);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WalletError);
    expect((err as Error).message).toBe("the remote signer's address is not an address (0x and 40 hex digits)");
  });
});
