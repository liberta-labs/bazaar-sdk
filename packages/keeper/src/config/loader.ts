/** Load the YAML config: .env, ${VAR} interpolation, the secrets rule, and readable errors. */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { redactUrl, urlCredential } from "@liberta-labs/bazaar-sdk";
import { config as loadDotenv } from "dotenv";
import { parse as parseYaml } from "yaml";
import type { ZodError, ZodIssue } from "zod";
import { KeeperConfig, PRICES_API_KEY_MESSAGE } from "./schema.js";

export const DEFAULT_CONFIG = "bazaar-keeper.yaml";
const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const VAR_ONLY = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}$/;

/**
 * Keys whose values are secrets. They must come from the environment (${NAME}) or be left out to be
 * prompted for, so a config file can be shared or committed without leaking anything. A URL that
 * carries a key (Alchemy's /v2/<key>, a ?key= query) is a secret under any key, and must come from the
 * environment whole or with its key as a ${NAME} inside it. prices.headers values are held to the same
 * rule, and so is the default of a ${NAME:-default} reference.
 */
export const SECRET_KEYS = new Set(["key", "password", "phrase", "apiKey", "token", "botToken", "webhook"]);

/** A configuration problem, phrased for the person fixing it. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") || p.startsWith("~\\") ? join(homedir(), p.slice(2)) : p;
}

function interpolate(value: unknown, path: string): unknown {
  if (Array.isArray(value)) return value.map((v, i) => interpolate(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, path ? `${path}.${k}` : k);
    return out;
  }
  if (typeof value !== "string") return value;
  return value.replace(VAR, (_m, name: string, def: string | undefined) => {
    const env = process.env[name];
    if (env !== undefined) return env;
    if (def !== undefined) return def;
    throw new ConfigError(`${path}: environment variable ${name} is not set (add it to .env or export it)`);
  });
}

/** Whether `v` is one ${NAME} reference whose default, if it has one, is empty: no literal secret in it. */
function onlyReference(v: string): boolean {
  const m = VAR_ONLY.exec(v.trim());
  return m !== null && (m[2] ?? "").trim() === "";
}

/** A header value may keep an auth scheme before its reference: `Bearer ${NAME}`. */
const SCHEME_AND_REFERENCE = /^[A-Za-z][A-Za-z-]*\s+(\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\})$/;

/**
 * prices.headers values go to the price endpoint with every request and usually carry its key, so each
 * one is held to the secrets rule: a ${NAME} reference, optionally after an auth scheme.
 */
function checkHeaders(headers: object, path: string): void {
  for (const [name, v] of Object.entries(headers)) {
    if (typeof v !== "string" || !v.trim()) continue;
    const ref = SCHEME_AND_REFERENCE.exec(v.trim())?.[1];
    if (onlyReference(ref ?? v)) continue;
    throw new ConfigError(
      `${path}.${name} holds a value written into the file. Header values usually carry a key: put the value in .env ` +
        `as a variable and write ${name}: \${NAME} here instead (an auth scheme may stay, as in Bearer \${NAME})`,
    );
  }
}

function checkSecrets(value: unknown, path = ""): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkSecrets(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const here = path ? `${path}.${k}` : k;
      // A ${NAME:-default} default is text in the file like any other: it must not be the secret.
      if (SECRET_KEYS.has(k) && typeof v === "string" && v && !onlyReference(v)) {
        throw new ConfigError(
          `${here} holds a secret written into the file (a \${NAME:-default} default counts). Put it in .env as a ` +
            `variable and write ${k}: \${NAME} here instead`,
        );
      }
      if (here === "prices.headers" && v && typeof v === "object" && !Array.isArray(v)) checkHeaders(v, here);
      checkSecrets(v, here);
    }
    return;
  }
  if (typeof value === "string") {
    // ${NAME} references are filled from the environment, so the text checked is the literal text, with
    // each reference's default in its place: a default is written into the file too.
    const what = urlCredential(value.replace(VAR, (_m, _name: string, def: string | undefined) => def ?? ""));
    if (what) {
      // Shown with each default in place (and masked), never as written, so a default's key is not echoed.
      const shown = value.replace(VAR, (m: string, _name: string, def: string | undefined) => (def ? def : m));
      throw new ConfigError(
        `${path} is a URL with ${what}, written into the file. Put the URL in .env as a variable and write \${NAME} here ` +
          `instead, or put only the key in .env and write ${redactUrl(shown, "${NAME}")}`,
      );
    }
  }
}

/** For a key the schema refuses whose value belongs under another key: where it goes. */
function misplaced(e: ZodIssue): string {
  if (e.code === "unrecognized_keys" && e.path.join(".") === "prices" && e.keys.includes("apiKey")) return ` (${PRICES_API_KEY_MESSAGE})`;
  return "";
}

/**
 * Refuse a file that still holds `prices.apiKey`, before any `${NAME}` in it is filled: an operator
 * whose old variable is gone is told what the setting is now, not that the variable is unset. The
 * value is neither read nor shown.
 */
function checkRenamed(raw: object): void {
  const prices = (raw as Record<string, unknown>).prices;
  if (prices !== null && typeof prices === "object" && !Array.isArray(prices) && Object.hasOwn(prices, "apiKey")) {
    throw new ConfigError(PRICES_API_KEY_MESSAGE);
  }
}

function format(err: ZodError): string {
  const lines = err.issues.map((e) => `  ${e.path.join(".") || "config"}: ${e.message}${misplaced(e)}`);
  return "the config is not valid:\n" + lines.join("\n");
}

/** Validate an already-interpolated config object. */
export function parseConfig(data: unknown): KeeperConfig {
  const r = KeeperConfig.safeParse(data);
  if (!r.success) throw new ConfigError(format(r.error));
  return r.data;
}

/** Read a config file, its sibling .env, and the environment. */
export function loadConfig(path?: string | null): KeeperConfig {
  const file = resolve(expandHome(path || DEFAULT_CONFIG));
  if (!existsSync(file)) throw new ConfigError(`no config at ${file}; run \`bazaar keeper init\` to create one`);
  loadDotenv({ path: join(dirname(file), ".env"), override: false, quiet: true } as Parameters<typeof loadDotenv>[0]);
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, "utf8")) ?? {};
  } catch (e) {
    throw new ConfigError(`${file} is not valid YAML: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`${file} must be a YAML mapping`);
  checkRenamed(raw);
  checkSecrets(raw);
  return parseConfig(interpolate(raw, ""));
}
