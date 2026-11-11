/**
 * Output helpers for the `bazaar` command: colours, aligned tables, and the number and time formats
 * the CLI prints.
 *
 * Everything that prints an error passes it through {@link errorText} or {@link redactUrls}, so a URL
 * that carries a provider's key is masked even when it turns up inside some library's message.
 */

import { redactUrl } from "@liberta-labs/bazaar-sdk";
import pc from "picocolors";

export type Colors = ReturnType<typeof pc.createColors>;

/**
 * Whether to colour output, as Rich decided it: on a terminal, unless NO_COLOR is set (no-color.org)
 * or TERM is dumb; FORCE_COLOR turns it on anywhere. (picocolors alone colours every Windows console
 * and pipe, which would put escape codes into redirected output.)
 */
export function colorSupported(stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false") return true;
  return Boolean(stream.isTTY) && env.TERM !== "dumb";
}

/** The CLI's colours (identity functions when colour is off). */
export const c: Colors = pc.createColors(colorSupported());

export const OK = (): string => c.green("✔");
export const WARN = (): string => c.yellow("⚠");
export const FAIL = (): string => c.red("✘");

/** Where the CLI writes: one call per line. */
export interface Output {
  out(line?: string): void;
  err(line?: string): void;
}

export const consoleOutput: Output = {
  out: (line = "") => void process.stdout.write(line + "\n"),
  err: (line = "") => void process.stderr.write(line + "\n"),
};

/** Ends a command with an exit code, and a message for stderr when there is one. */
export class CliExit extends Error {
  override readonly name = "CliExit";
  constructor(
    readonly code: number,
    message = "",
  ) {
    super(message);
  }
}

// ---- text ----

// CSI sequences (colours) and OSC sequences (links).
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** Columns a string takes on screen: code points, colour codes excluded. */
export function visibleWidth(s: string): number {
  let n = 0;
  for (const _ of stripAnsi(s)) n++;
  return n;
}

const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s"'<>`]+/gi;
const TRAILING_PUNCT = /[.,;:!?)\]}]+$/;

/** `text` with every http(s)/ws(s) URL in it passed through `redactUrl`. */
export function redactUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (u) => {
    const tail = TRAILING_PUNCT.exec(u)?.[0] ?? "";
    return redactUrl(tail ? u.slice(0, -tail.length) : u) + tail;
  });
}

/**
 * An error as one line for a person: its message (or its name when it has none), with the cause's
 * code where the message alone says little (Node's fetch: "fetch failed (ECONNREFUSED)"), and any
 * URL in it redacted.
 */
export function errorText(e: unknown): string {
  if (!(e instanceof Error)) return redactUrls(String(e));
  let msg = e.message || e.name;
  const cause = (e as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    const detail = typeof code === "string" ? code : cause instanceof Error ? cause.message : "";
    if (detail && !msg.includes(detail)) msg += ` (${detail})`;
  }
  return redactUrls(msg);
}

// ---- tables ----

export interface Column {
  readonly header: string;
  readonly align?: "left" | "right";
}

/**
 * Rows under a bold header, in aligned columns two spaces apart, indented one space: Rich's
 * `Table(box=None)`. Cells may carry colour codes.
 */
export function table(columns: readonly (string | Column)[], rows: readonly (readonly string[])[]): string[] {
  const cols = columns.map((col): Column => (typeof col === "string" ? { header: col } : col));
  const widths = cols.map((col, i) => rows.reduce((w, r) => Math.max(w, visibleWidth(r[i] ?? "")), visibleWidth(col.header)));
  const line = (cells: readonly string[], style?: (s: string) => string): string =>
    (
      " " +
      cols
        .map((col, i) => {
          const cell = cells[i] ?? "";
          const pad = " ".repeat(widths[i]! - visibleWidth(cell));
          const shown = style ? style(cell) : cell;
          return col.align === "right" ? pad + shown : shown + pad;
        })
        .join("  ")
    ).trimEnd();
  return [line(cols.map((col) => col.header), c.bold), ...rows.map((r) => line(r))];
}

// ---- numbers and times ----

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** An integer with thousands separators: `1,234,567`. */
export function grouped(n: number | bigint): string {
  if (typeof n === "number" && !Number.isFinite(n)) return String(n);
  const s = typeof n === "bigint" ? n.toString() : Math.trunc(n).toString();
  return s.startsWith("-") ? "-" + group(s.slice(1)) : group(s);
}

/** `x` with exactly `digits` decimals; `nan`, `inf` or `-inf` when it is not finite. */
export function fixed(x: number, digits: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  return x.toFixed(digits);
}

/** {@link fixed}, with thousands separators in the integer part. */
export function groupedFixed(x: number, digits: number): string {
  const s = fixed(x, digits);
  const m = /^(-?)(\d+)(.*)$/.exec(s);
  return m ? m[1]! + group(m[2]!) + m[3]! : s;
}

/** Dollars with `digits` decimals: `usd(0.05, 4)` is `$0.0500`. */
export function usd(x: number, digits = 2): string {
  return "$" + fixed(x, digits);
}

/** Up to `precision` significant digits, trailing zeros dropped, in exponent form outside 1e-4..1e6. */
export function formatG(x: number, precision = 6): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const p = Math.max(1, precision);
  const [mant, expText] = x.toExponential(p - 1).split("e") as [string, string];
  const exp = Number(expText);
  const strip = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (exp < -4 || exp >= p) {
    const e = Math.abs(exp).toString().padStart(2, "0");
    return `${strip(mant)}e${exp < 0 ? "-" : "+"}${e}`;
  }
  return strip(x.toFixed(Math.max(0, p - 1 - exp)));
}

/** `time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(ts))`, or without seconds. */
export function utcTime(ts: number, seconds = true): string {
  const d = new Date(Math.floor(ts) * 1000);
  if (Number.isNaN(d.getTime())) return String(ts);
  const iso = d.toISOString(); // 2026-11-08T12:34:56.000Z
  return `${iso.slice(0, 10)} ${iso.slice(11, seconds ? 19 : 16)} UTC`;
}
