/** The loader's secrets rule: ${NAME:-default} defaults, prices.headers, keyed URLs, and the shipped example. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config/index.js";

const FACTORY = "0x" + "12".repeat(20);
const KEY = "abcDEF123456ghiJKL789";
const PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const EXAMPLE = fileURLToPath(new URL("../../../bazaar-keeper.example.yaml", import.meta.url));

let dir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bazaar-loader-"));
  savedEnv = { ...process.env };
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  rmSync(dir, { recursive: true, force: true });
});

/** Write a config of these YAML lines and load it; the ConfigError's message, or null when it loads. */
function load(...lines: string[]): string | null {
  const f = join(dir, "k.yaml");
  writeFileSync(f, lines.join("\n") + "\n");
  try {
    loadConfig(f);
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
}

const HEAD = ["network: anvil", `factory: "${FACTORY}"`, "rpc:", "  http: http://127.0.0.1:8545"];

describe("the secrets rule", () => {
  it("checks a ${NAME:-default} default under a secret key like any literal, and never echoes it", () => {
    delete process.env.NOPE_KEY;
    const key = load(...HEAD, "prices: {endpoint: http://p}", "wallets:", "  default:", "    type: privateKey", `    key: \${NOPE_KEY:-${PRIVATE_KEY}}`);
    expect(key).toMatch(/^wallets\.default\.key holds a secret written into the file/);
    expect(key).not.toContain(PRIVATE_KEY.slice(2));
    const apiKey = load(...HEAD, "prices:", "  endpoint: http://p", `  apiKey: "\${NOPE_KEY:-${KEY}}"`);
    expect(apiKey).toMatch(/^prices\.apiKey holds a secret/);
    expect(apiKey).not.toContain(KEY);
    // A reference alone, or with an empty default, holds nothing.
    expect(load(...HEAD, "prices:", "  endpoint: http://p", '  apiKey: "${NOPE_KEY:-}"')).toBeNull();
    process.env.NOPE_KEY = "from-env";
    expect(load(...HEAD, "prices:", "  endpoint: http://p", '  apiKey: "${NOPE_KEY}"')).toBeNull();
  });

  it("checks a URL's ${NAME:-default} default for a key, whole or inside the URL", () => {
    delete process.env.NOPE_RPC;
    const keyed = `https://arb-mainnet.g.alchemy.com/v2/${KEY}`;
    for (const http of [`\${NOPE_RPC:-${keyed}}`, `https://arb-mainnet.g.alchemy.com/v2/\${NOPE_RPC:-${KEY}}`]) {
      const msg = load("network: anvil", `factory: "${FACTORY}"`, "rpc:", `  http: ${http}`, "prices: {endpoint: http://p}");
      expect(msg).toMatch(/^rpc\.http is a URL with a key in its path, written into the file\. Put the URL in \.env/);
      expect(msg).toContain("https://arb-mainnet.g.alchemy.com/v2/${NAME}");
      expect(msg).not.toContain(KEY);
    }
    // A default without a key is fine.
    expect(load("network: anvil", `factory: "${FACTORY}"`, "rpc:", "  http: ${NOPE_RPC:-http://127.0.0.1:8545}", "prices: {endpoint: http://p}")).toBeNull();
  });

  it("holds prices.headers values to the rule: a reference, optionally after an auth scheme", () => {
    delete process.env.HDR;
    const literal = load(...HEAD, "prices:", "  endpoint: http://p", `  headers: { x-api-key: ${KEY} }`);
    expect(literal).toMatch(/^prices\.headers\.x-api-key holds a value written into the file\. Header values usually carry a key/);
    expect(literal).not.toContain(KEY);
    for (const v of [`"Bearer ${KEY}"`, `"\${HDR:-${KEY}}"`, `"Bearer \${HDR:-${KEY}}"`, "short", `"\${HDR} ${KEY}"`]) {
      const msg = load(...HEAD, "prices:", "  endpoint: http://p", `  headers: { Authorization: ${v} }`);
      expect(msg, v).toMatch(/^prices\.headers\.Authorization holds a value written into the file/);
      expect(msg).not.toContain(KEY);
    }
    process.env.HDR = KEY;
    const f = join(dir, "h.yaml");
    writeFileSync(f, [...HEAD, "prices:", "  endpoint: http://p", '  headers: { Authorization: "Bearer ${HDR}", x-api-key: "${HDR}" }'].join("\n"));
    expect(loadConfig(f).prices.headers).toEqual({ Authorization: `Bearer ${KEY}`, "x-api-key": KEY });
  });

  it("still loads a URL that carries its key as a ${NAME}, in its path or its query", () => {
    process.env.ALCHEMY_KEY = KEY;
    process.env.Q_KEY = KEY;
    const f = join(dir, "u.yaml");
    writeFileSync(f, ["network: anvil", `factory: "${FACTORY}"`, "rpc:", "  http: https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}", "prices: {endpoint: http://p}"].join("\n"));
    expect(loadConfig(f).rpc.http).toBe(`https://arb-mainnet.g.alchemy.com/v2/${KEY}`);
  });

  it("loads the shipped example config, with its secrets in the environment", () => {
    process.env.RPC_HTTP_URL = `https://arb-sepolia.g.alchemy.com/v2/${KEY}`;
    process.env.PYTH_API_KEY = KEY;
    process.env.KEEPER_KEYSTORE_PASSWORD = "pw";
    const f = join(dir, "bazaar-keeper.yaml");
    // Its factory placeholder is the zero address: give it a real-looking one, as the comment asks.
    writeFileSync(f, readFileSync(EXAMPLE, "utf8").replace(/factory: "0x0{40}"/, `factory: "${FACTORY}"`));
    const cfg = loadConfig(f);
    expect(cfg.rpc.http).toBe(process.env.RPC_HTTP_URL);
    expect(cfg.prices).toMatchObject({ endpoint: "pyth", apiKey: KEY });
    expect(cfg.wallets.default).toMatchObject({ type: "keystore", password: "pw" });
  });
});
