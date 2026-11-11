/**
 * Logging: readable lines for people, JSON lines for machines.
 *
 * `getLogger(name)` hands out a named logger (e.g. "bazaar_sdk.exec"); `setup(level, format)`
 * configures them all at once. Until `setup` runs, warnings and errors go to stderr as bare messages
 * and everything else is dropped.
 *
 * Messages are plain strings (template literals), or printf-style `%s` / `%d` / `%r` / `%f` templates
 * filled from the arguments: an Error argument fills `%s` with its message. An Error passed after the
 * arguments the template consumes is the record's exception: its stack is
 * printed under the line, or put in the JSON line's `exc` field.
 *
 * Never pass a URL that may carry a key (use `redactUrl`) or any secret.
 */

import { inspect } from "node:util";
import pc from "picocolors";

export type LogLevel = "debug" | "info" | "warning" | "error";
export type LogFormat = "pretty" | "json";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warning: 30, error: 40 };

export interface Logger {
  readonly name: string;
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warning(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  /** At error level, with a trailing Error argument as the exception. */
  exception(msg: string, ...args: unknown[]): void;
  isEnabledFor(level: LogLevel): boolean;
}

interface State {
  level: number;
  /** null until setup(): the "last resort" output */
  format: LogFormat | null;
  write: (line: string) => void;
}

const state: State = {
  level: RANK.warning,
  format: null,
  write: (line) => process.stderr.write(line + "\n"),
};

/**
 * Configure every logger: the lowest level shown, and the output format. Lines go to stdout, or to
 * `write` when given (tests, embedding).
 */
export function setup(level: string = "info", fmt: LogFormat | string = "pretty", write?: (line: string) => void): void {
  const l = level.toLowerCase() as LogLevel | "warn";
  state.level = l === "warn" ? RANK.warning : (RANK[l as LogLevel] ?? RANK.info);
  state.format = fmt === "json" ? "json" : "pretty";
  state.write = write ?? ((line) => process.stdout.write(line + "\n"));
}

const loggers = new Map<string, Logger>();

export function getLogger(name: string): Logger {
  let lg = loggers.get(name);
  if (!lg) {
    lg = makeLogger(name);
    loggers.set(name, lg);
  }
  return lg;
}

function makeLogger(name: string): Logger {
  const at =
    (level: LogLevel) =>
    (msg: string, ...args: unknown[]): void => {
      if (RANK[level] >= state.level) emit(name, level, msg, args);
    };
  return {
    name,
    debug: at("debug"),
    info: at("info"),
    warning: at("warning"),
    error: at("error"),
    exception: at("error"),
    isEnabledFor: (level) => RANK[level] >= state.level,
  };
}

function render(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.message;
  if (v === null || v === undefined || typeof v !== "object") return String(v);
  return inspect(v, { depth: 4, breakLength: Infinity });
}

const PLACEHOLDER = /%([sdifr%])/g;

/** Fill a %-template; returns the text and the exception argument, if any. */
export function formatMessage(msg: string, args: readonly unknown[]): { text: string; exc: unknown } {
  if (!args.length) return { text: msg, exc: undefined };
  let i = 0;
  const text = msg.replace(PLACEHOLDER, (m, c: string) => {
    if (c === "%") return "%";
    if (i >= args.length) return m;
    const v = args[i++];
    switch (c) {
      case "d":
      case "i":
        return typeof v === "bigint" ? v.toString() : String(Math.trunc(Number(v)));
      case "f":
        return typeof v === "number" ? v.toFixed(6) : render(v);
      case "r":
        return typeof v === "string" ? JSON.stringify(v) : inspect(v, { depth: 4, breakLength: Infinity });
      default:
        return render(v);
    }
  });
  const rest = args.slice(i);
  let exc: unknown;
  if (rest.length && rest[rest.length - 1] instanceof Error) exc = rest.pop();
  return { text: rest.length ? `${text} ${rest.map(render).join(" ")}` : text, exc };
}

function excText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  let out = e.stack ?? `${e.name}: ${e.message}`;
  let cause = (e as { cause?: unknown }).cause;
  for (let depth = 0; cause !== undefined && depth < 3; depth++) {
    out += "\nCaused by: " + (cause instanceof Error ? (cause.stack ?? `${cause.name}: ${cause.message}`) : String(cause));
    cause = cause instanceof Error ? (cause as { cause?: unknown }).cause : undefined;
  }
  return out;
}

const LABEL: Record<LogLevel, string> = {
  debug: pc.dim("DEBUG   "),
  info: pc.cyan("INFO    "),
  warning: pc.yellow("WARNING "),
  error: pc.red(pc.bold("ERROR   ")),
};

const two = (n: number) => (n < 10 ? "0" + n : String(n));

function emit(name: string, level: LogLevel, msg: string, args: readonly unknown[]): void {
  const { text, exc } = formatMessage(msg, args);
  try {
    if (state.format === "json") {
      const out: Record<string, unknown> = { ts: Math.round(Date.now()) / 1000, level, logger: name, msg: text };
      if (exc !== undefined) out.exc = excText(exc);
      state.write(JSON.stringify(out));
    } else if (state.format === "pretty") {
      const d = new Date();
      const time = pc.dim(`${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`);
      state.write(`${time} ${LABEL[level]}${text}` + (exc !== undefined ? "\n" + excText(exc) : ""));
    } else {
      state.write(text + (exc !== undefined ? "\n" + excText(exc) : ""));
    }
  } catch {
    // A broken output stream must not break the keeper.
  }
}

// ---- untrusted text ----

// Control characters (C0, DEL, C1: terminal escapes, line breaks) and Unicode format characters
// (bidirectional overrides, zero-width joiners), which can rewrite what a terminal or a chat shows.
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
// What a shell, a YAML comment or a chat's mentions give a meaning to.
const META = /[`$\\;|&<>(){}[\]"'!*?~#@]/g;

/** `text` without control or format characters: safe to print to a terminal or post to a chat. */
export function printable(text: string): string {
  return text.replace(CONTROL, "");
}

/**
 * A name that came from outside (a market's label, built from the price endpoint's feed symbols or the
 * lister's description) as shown to people: no control or format characters, no shell metacharacters,
 * `#` or `@`, whitespace collapsed, at most `max` characters. Never paste it into a command: name a
 * market by its address there.
 */
export function safeLabel(text: string, max = 40): string {
  const clean = text.replace(CONTROL, " ").replace(META, "").replace(/\s+/g, " ").trim();
  return [...clean].slice(0, max).join("").trim();
}
