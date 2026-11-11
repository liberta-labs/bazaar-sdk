/**
 * Signers: a local key (from the environment, a keystore or a mnemonic) or a remote signer.
 *
 * Keystores are Ethereum's JSON keystore, version 3, as geth and eth-account read and write them:
 * scrypt or PBKDF2-HMAC-SHA256 for the key, AES-128-CTR for the private key, and
 * mac = keccak256(derivedKey[16..32] ++ ciphertext). New keystores use scrypt n = 2^18, r = 8, p = 1
 * and a 16-byte salt, so those tools open them too.
 *
 * Keys, passwords and phrases never appear in an error or a log line; a remote signer's URL appears
 * only through `redactUrl`.
 */

import { webcrypto, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { redactUrl } from "@liberta-labs/bazaar-sdk";
import { ctr } from "@noble/ciphers/aes.js";
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import {
  type Address,
  type Hex,
  type TransactionSerializedEIP1559,
  bytesToHex,
  getAddress,
  hexToBytes,
  isAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
} from "viem";
import {
  type PrivateKeyAccount,
  czech,
  english,
  french,
  italian,
  japanese,
  korean,
  mnemonicToAccount,
  portuguese,
  privateKeyToAccount,
  simplifiedChinese,
  spanish,
  traditionalChinese,
} from "viem/accounts";
import { type WalletConfig, expandHome } from "../config/index.js";

/** Where `bazaar wallet new` puts keystores (expand with `expandHome`). */
export const KEYS_DIR = "~/.bazaar/keys";

export class WalletError extends Error {
  override readonly name = "WalletError";
}

/** An EIP-1559 (type 2) transaction, as the executor builds it. */
export interface TxRequest {
  readonly type: "eip1559";
  readonly chainId: number;
  readonly nonce: number;
  readonly to: Address;
  readonly value: bigint;
  readonly data: Hex;
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

export interface Signer {
  readonly address: Address;
  /** The signed, serialized transaction, ready for eth_sendRawTransaction. */
  sign(tx: TxRequest): Promise<Hex>;
}

// ---- local keys ----

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function keyHex(key: Hex | string | Uint8Array): Hex {
  let hex: string;
  if (key instanceof Uint8Array) {
    if (key.length !== 32) throw new WalletError("not a valid private key: it must be 32 bytes");
    hex = bytesToHex(key);
  } else {
    const s = String(key).trim();
    hex = s.startsWith("0x") || s.startsWith("0X") ? "0x" + s.slice(2) : "0x" + s;
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new WalletError("not a valid private key: it must be 32 bytes of hex");
    hex = hex.toLowerCase();
  }
  const k = BigInt(hex);
  if (k === 0n || k >= SECP256K1_N) throw new WalletError("not a valid private key: it is outside the secp256k1 range");
  return hex as Hex;
}

/** Signs with a key held in this process. */
export class LocalSigner implements Signer {
  readonly address: Address;
  readonly #account: PrivateKeyAccount;

  constructor(key: Hex | string | Uint8Array) {
    const hex = keyHex(key);
    try {
      this.#account = privateKeyToAccount(hex);
    } catch (e) {
      throw new WalletError(`not a valid private key: ${(e as Error).name}`);
    }
    this.address = this.#account.address;
  }

  sign(tx: TxRequest): Promise<Hex> {
    return this.#account.signTransaction({
      type: "eip1559",
      chainId: tx.chainId,
      nonce: tx.nonce,
      to: tx.to,
      value: tx.value,
      data: tx.data,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    });
  }
}

// ---- remote signers ----

export interface RemoteSignerOptions {
  /** default 15 s */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: { code?: unknown; message?: unknown } }).cause;
  const detail = cause && typeof cause === "object" ? (typeof cause.code === "string" ? cause.code : String(cause.message ?? "")) : "";
  return detail ? `${e.message} (${detail})` : e.message;
}

/** Any signer that answers eth_signTransaction over JSON-RPC (Web3Signer, a KMS bridge). */
export class RemoteSigner implements Signer {
  readonly address: Address;
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(url: string, address: string, opts: RemoteSignerOptions = {}) {
    // Never the value itself: a key pasted into the wrong field must not reach a terminal or a log.
    if (!isAddress(address, { strict: false })) throw new WalletError("the remote signer's address is not an address (0x and 40 hex digits)");
    this.#url = url;
    this.address = getAddress(address);
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** The URL as it may be printed: with any key in it masked. */
  get displayUrl(): string {
    return redactUrl(this.#url);
  }

  #scrub(text: string): string {
    return text.split(this.#url).join(this.displayUrl);
  }

  async sign(tx: TxRequest): Promise<Hex> {
    const params = {
      type: "0x2",
      chainId: toHex(tx.chainId),
      nonce: toHex(tx.nonce),
      to: tx.to,
      value: toHex(tx.value),
      data: tx.data,
      gas: toHex(tx.gas),
      maxFeePerGas: toHex(tx.maxFeePerGas),
      maxPriorityFeePerGas: toHex(tx.maxPriorityFeePerGas),
      from: this.address,
    };
    let out: { result?: unknown; error?: { message?: unknown } };
    try {
      const r = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_signTransaction", params: [params] }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!r.ok) throw new WalletError(`remote signer ${this.displayUrl} answered HTTP ${r.status}`);
      out = (await r.json()) as typeof out;
    } catch (e) {
      if (e instanceof WalletError) throw e;
      throw new WalletError(`remote signer ${this.displayUrl} did not answer: ${this.#scrub(errorText(e))}`);
    }
    if (out && out.error) throw new WalletError(`remote signer refused: ${this.#scrub(String(out.error.message ?? "no reason given"))}`);
    const res = out?.result;
    const raw = res && typeof res === "object" ? (res as { raw?: unknown }).raw : res;
    if (typeof raw !== "string") throw new WalletError(`remote signer ${this.displayUrl} returned no signed transaction`);
    const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2) {
      throw new WalletError(`remote signer ${this.displayUrl} returned a signed transaction that is not hex`);
    }
    const signed: Hex = `0x${hex.toLowerCase()}`;
    await this.#check(signed, tx);
    return signed;
  }

  /**
   * The signed transaction must be exactly the one asked for, signed by this wallet's key: a signer
   * that changes the recipient, the calldata, the value, the nonce, the gas or the fees (or signs with
   * another key) is refused, and nothing is sent.
   */
  async #check(signed: Hex, tx: TxRequest): Promise<void> {
    const refuse = (why: string): never => {
      throw new WalletError(`remote signer ${this.displayUrl} returned ${why}; nothing was sent`);
    };
    let p: ReturnType<typeof parseTransaction>;
    try {
      p = parseTransaction(signed);
    } catch {
      return refuse("a signed transaction that does not parse");
    }
    if (p.type !== "eip1559") return refuse(`a ${String(p.type)} transaction, not the EIP-1559 one asked for`);
    const differ: string[] = [];
    if (p.chainId !== tx.chainId) differ.push("chainId");
    if (p.nonce !== tx.nonce) differ.push("nonce");
    if ((p.to ?? "").toLowerCase() !== tx.to.toLowerCase()) differ.push("to");
    if ((p.value ?? 0n) !== tx.value) differ.push("value");
    if ((p.data ?? "0x").toLowerCase() !== tx.data.toLowerCase()) differ.push("data");
    if ((p.gas ?? 0n) !== tx.gas) differ.push("gas");
    if ((p.maxFeePerGas ?? 0n) !== tx.maxFeePerGas) differ.push("maxFeePerGas");
    if ((p.maxPriorityFeePerGas ?? 0n) !== tx.maxPriorityFeePerGas) differ.push("maxPriorityFeePerGas");
    if (p.accessList && p.accessList.length > 0) differ.push("accessList");
    if (differ.length) return refuse(`a transaction that differs from the one asked for (${differ.join(", ")})`);
    if (p.r === undefined || p.s === undefined || (p.yParity === undefined && p.v === undefined)) {
      return refuse("an unsigned transaction");
    }
    let from: Address;
    try {
      from = await recoverTransactionAddress({ serializedTransaction: signed as TransactionSerializedEIP1559 });
    } catch {
      return refuse("a transaction whose signature does not recover");
    }
    if (from.toLowerCase() !== this.address.toLowerCase()) return refuse(`a transaction signed by ${from}, not by the configured ${this.address}`);
  }
}

// ---- keystores (JSON keystore v3) ----

export interface KeystoreV3 {
  address: string;
  crypto: {
    cipher: "aes-128-ctr";
    cipherparams: { iv: string };
    ciphertext: string;
    kdf: "scrypt" | "pbkdf2";
    kdfparams: Record<string, string | number>;
    mac: string;
  };
  id: string;
  version: 3;
}

/** Parameters for new keystores: geth's standard scrypt settings. */
const SCRYPT_N = 262_144;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const DKLEN = 32;

const utf8 = (s: string) => new TextEncoder().encode(s);

function random(n: number): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(n));
}

function bytesOf(v: unknown, what: string): Uint8Array {
  if (typeof v !== "string") throw new WalletError(`the keystore has no ${what}`);
  const s = v.startsWith("0x") || v.startsWith("0X") ? v.slice(2) : v;
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2) throw new WalletError(`the keystore's ${what} is not hex`);
  return hexToBytes(`0x${s}`);
}

function intOf(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new WalletError(`the keystore's ${what} is not a positive integer`);
  return v;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Constant-time equality (the lengths are not secret). */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/** Keys compared case-insensitively, as eth-keyfile does ("Crypto" in old geth files). */
function lowerKeys(v: unknown): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k.toLowerCase()] = lowerKeys(x);
  return out;
}

async function deriveKey(kdf: unknown, params: Record<string, unknown>, password: string): Promise<Uint8Array> {
  const salt = bytesOf(params.salt, "kdfparams.salt");
  const dkLen = intOf(params.dklen, "kdfparams.dklen");
  if (dkLen < 32) throw new WalletError("the keystore's kdfparams.dklen is below 32");
  try {
    if (kdf === "scrypt") {
      const N = intOf(params.n, "kdfparams.n");
      const r = intOf(params.r, "kdfparams.r");
      const p = intOf(params.p, "kdfparams.p");
      return await scryptAsync(utf8(password), salt, { N, r, p, dkLen });
    }
    if (kdf === "pbkdf2") {
      const c = intOf(params.c, "kdfparams.c");
      const prf = typeof params.prf === "string" ? params.prf.toLowerCase() : "hmac-sha256";
      const hash = prf === "hmac-sha256" ? sha256 : prf === "hmac-sha512" ? sha512 : null;
      if (!hash) throw new WalletError(`the keystore's PBKDF2 uses ${JSON.stringify(params.prf)}, which is not supported`);
      return await pbkdf2Async(hash, utf8(password), salt, { c, dkLen });
    }
  } catch (e) {
    if (e instanceof WalletError) throw e;
    throw new WalletError(`the keystore's ${String(kdf)} parameters are not usable: ${(e as Error).message}`);
  }
  throw new WalletError(`the keystore uses the key derivation ${JSON.stringify(kdf)}, which is not supported (scrypt or pbkdf2)`);
}

/**
 * The private key in a v3 keystore. A wrong password throws `WalletError("wrong keystore password")`;
 * the MAC is checked in constant time before anything is decrypted.
 */
export async function decryptKeystore(keyfile: unknown, password: string): Promise<Uint8Array> {
  const k = lowerKeys(keyfile) as Record<string, unknown> | null;
  if (!k || typeof k !== "object") throw new WalletError("not a JSON keystore");
  if (k.version !== 3) throw new WalletError(`keystore version ${JSON.stringify(k.version ?? null)} is not supported (only version 3)`);
  const c = k.crypto as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object") throw new WalletError("the keystore has no crypto section");
  if (typeof c.cipher !== "string" || c.cipher.toLowerCase() !== "aes-128-ctr") {
    throw new WalletError(`the keystore's cipher ${JSON.stringify(c.cipher ?? null)} is not supported (aes-128-ctr)`);
  }
  const params = c.kdfparams as Record<string, unknown> | undefined;
  if (!params || typeof params !== "object") throw new WalletError("the keystore has no kdfparams");
  const ciphertext = bytesOf(c.ciphertext, "ciphertext");
  const mac = bytesOf(c.mac, "mac");
  const ivRaw = bytesOf((c.cipherparams as Record<string, unknown> | undefined)?.iv, "cipherparams.iv");
  if (ivRaw.length > 16) throw new WalletError("the keystore's iv is longer than 16 bytes");
  // eth-keyfile reads the iv as a 128-bit counter, so a short one is left-padded.
  const iv = new Uint8Array(16);
  iv.set(ivRaw, 16 - ivRaw.length);

  const derived = await deriveKey(c.kdf, params, password);
  const expected = keccak256(concatBytes(derived.subarray(16, 32), ciphertext), "bytes");
  if (!equalBytes(expected, mac)) throw new WalletError("wrong keystore password");
  return ctr(derived.slice(0, 16), iv).decrypt(ciphertext);
}

/** A v3 keystore for `key`, with the parameters above. */
export async function encryptKeystore(key: Hex | string | Uint8Array, password: string): Promise<KeystoreV3> {
  const hex = keyHex(key);
  const address = privateKeyToAccount(hex).address;
  const salt = random(16);
  const iv = random(16);
  const derived = await scryptAsync(utf8(password), salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, dkLen: DKLEN });
  const ciphertext = ctr(derived.slice(0, 16), iv).encrypt(hexToBytes(hex));
  const mac = keccak256(concatBytes(derived.subarray(16, 32), ciphertext));
  return {
    address: address.slice(2),
    crypto: {
      cipher: "aes-128-ctr",
      cipherparams: { iv: bytesToHex(iv).slice(2) },
      ciphertext: bytesToHex(ciphertext).slice(2),
      kdf: "scrypt",
      kdfparams: { dklen: DKLEN, n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: bytesToHex(salt).slice(2) },
      mac: mac.slice(2),
    },
    id: randomUUID(),
    version: 3,
  };
}

/** JSON with `": "` and `", "` separators. */
function pyJson(v: unknown): string {
  if (v && typeof v === "object") {
    return "{" + Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyJson(x)}`).join(", ") + "}";
  }
  return JSON.stringify(v);
}

/**
 * Encrypt `key` to a JSON keystore at `path` (owner-only permissions where the OS has them); returns
 * the address. Refuses to overwrite an existing file.
 */
export async function writeKeystore(key: Hex | string | Uint8Array, password: string, path: string): Promise<Address> {
  const file = expandHome(path);
  if (existsSync(file)) throw new WalletError(`${file} already exists`);
  const data = await encryptKeystore(key, password);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    // "wx": created here and now, never over a file that appeared meanwhile; 0600 from the first byte.
    await writeFile(file, pyJson(data), { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new WalletError(`${file} already exists`);
    throw new WalletError(`cannot write ${file}: ${strerror(e)}`);
  }
  try {
    await chmod(file, 0o600);
  } catch {
    // not every filesystem has POSIX permissions
  }
  return getAddress("0x" + data.address);
}

/** A new random private key. */
export function newKey(): Hex {
  for (;;) {
    const k = random(32);
    const n = BigInt(bytesToHex(k));
    if (n !== 0n && n < SECP256K1_N) return bytesToHex(k);
  }
}

// ---- mnemonics (BIP39, the word lists eth-account knows) ----

const WORDLISTS: Readonly<Record<string, readonly string[]>> = {
  english,
  czech,
  french,
  italian,
  japanese,
  korean,
  portuguese,
  spanish,
  chinese_simplified: simplifiedChinese,
  chinese_traditional: traditionalChinese,
};
let indexes: Map<string, Map<string, number>> | null = null;

function wordIndexes(): Map<string, Map<string, number>> {
  if (!indexes) {
    indexes = new Map();
    for (const [lang, list] of Object.entries(WORDLISTS)) {
      indexes.set(lang, new Map(list.map((w, i) => [w.normalize("NFKD"), i])));
    }
  }
  return indexes;
}

/**
 * The phrase, normalized, after the checks eth-account makes: a known word count, every word from one
 * language's list, and a matching checksum. Throws a WalletError that names no word.
 */
export function checkMnemonic(phrase: string): string {
  const words = phrase.normalize("NFKD").trim().split(/\s+/).filter(Boolean);
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    throw new WalletError(`the mnemonic has ${words.length} words; a BIP39 phrase has 12, 15, 18, 21 or 24`);
  }
  const lists = wordIndexes();
  let langs = [...lists.keys()].filter((lang) => words.every((w) => lists.get(lang)!.has(w)));
  if (langs.length === 2 && langs.every((l) => l.startsWith("chinese"))) langs = ["chinese_simplified"];
  if (langs.length === 0) {
    const bad = words.findIndex((w) => ![...lists.values()].some((m) => m.has(w)));
    throw new WalletError(
      bad >= 0
        ? `word ${bad + 1} of the mnemonic is not in any BIP39 word list`
        : "the mnemonic mixes words from different languages' word lists",
    );
  }
  if (langs.length > 1) throw new WalletError("the mnemonic's words fit several languages' word lists");
  const list = lists.get(langs[0]!)!;
  let acc = 0n;
  for (const w of words) acc = (acc << 11n) | BigInt(list.get(w)!);
  const csBits = BigInt((words.length * 11) / 33);
  const entBytes = (words.length * 4) / 3;
  const entropy = hexToBytes(toHex(acc >> csBits, { size: entBytes }));
  const expected = BigInt(sha256(entropy)[0]!) >> (8n - csBits);
  if ((acc & ((1n << csBits) - 1n)) !== expected) {
    throw new WalletError("the mnemonic's checksum does not match: check the words and their order");
  }
  return words.join(" ");
}

// ---- loading the configured wallets ----

const STRERROR: Record<string, string> = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EPERM: "Operation not permitted",
  EISDIR: "Is a directory",
  ENOTDIR: "Not a directory",
};

function strerror(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return (code && STRERROR[code]) || code || (e as Error)?.message || String(e);
}

async function password(given: string | null | undefined, what: string, field: string): Promise<string> {
  if (given) return given;
  if (process.stdin.isTTY) {
    const { password: ask } = await import("@inquirer/prompts");
    try {
      return await ask({ message: `Password for ${what}:` });
    } catch {
      throw new WalletError(`${what}: no password given`);
    }
  }
  throw new WalletError(
    `${what} needs a password: set ${field}: \${KEEPER_KEYSTORE_PASSWORD} in the config and ` +
      "KEEPER_KEYSTORE_PASSWORD in .env or the environment, or start the keeper in a terminal to be asked for it",
  );
}

/**
 * The signer for one configured wallet. Async because a keystore's key derivation runs off the event
 * loop's critical path, and a missing keystore password is asked for when stdin is a terminal.
 */
export async function loadSigner(name: string, cfg: WalletConfig): Promise<Signer> {
  const named = (e: unknown): never => {
    if (e instanceof WalletError) throw new WalletError(`wallet ${name}: ${e.message}`);
    throw e;
  };
  switch (cfg.type) {
    case "privateKey":
      try {
        return new LocalSigner(cfg.key ?? "");
      } catch (e) {
        return named(e);
      }
    case "keystore": {
      const path = expandHome(cfg.path ?? "");
      let keyfile: unknown;
      try {
        keyfile = JSON.parse(await readFile(path, "utf8"));
      } catch (e) {
        if (e instanceof SyntaxError) throw new WalletError(`wallet ${name}: ${path} is not a JSON keystore`);
        throw new WalletError(`wallet ${name}: cannot read keystore ${path}: ${strerror(e)}`);
      }
      const pw = await password(cfg.password, `wallet ${name} (${basename(path)})`, `wallets.${name}.password`);
      let key: Uint8Array;
      try {
        key = await decryptKeystore(keyfile, pw);
      } catch (e) {
        return named(e);
      }
      try {
        return new LocalSigner(key);
      } catch (e) {
        return named(e);
      }
    }
    case "mnemonic": {
      let phrase: string;
      try {
        phrase = checkMnemonic(cfg.phrase ?? "");
      } catch (e) {
        return named(e);
      }
      // The standard Ethereum path, m/44'/60'/0'/0/{index}.
      const pk = mnemonicToAccount(phrase, { addressIndex: cfg.index }).getHdKey().privateKey;
      if (!pk) throw new WalletError(`wallet ${name}: the mnemonic did not derive a key`);
      return new LocalSigner(pk);
    }
    case "remote":
      try {
        return new RemoteSigner(cfg.url ?? "", cfg.address ?? "");
      } catch (e) {
        return named(e);
      }
    default:
      throw new WalletError(`unknown wallet type ${String((cfg as { type?: unknown }).type)}`);
  }
}
