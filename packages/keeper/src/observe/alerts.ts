/**
 * Alerts to Telegram, Discord or any webhook, with repeats suppressed.
 *
 * Webhook URLs and bot tokens are secrets: they never appear in a log line or an error. A failed
 * delivery is logged with the channel's name only.
 */

import type { AlertsConfig } from "../config/index.js";
import { getLogger, printable } from "./logs.js";

const log = getLogger("bazaar_sdk.alerts");

export interface AlerterOptions {
  /** per request; default 10 s */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface Sent {
  /** seconds since the epoch */
  at: number;
  repeatAfter: number;
}

export interface SendOptions {
  /** seconds within which the same alert is not sent again (default 600) */
  repeatAfter?: number;
}

/** How a failed request reads in a log line, with every secret it might quote masked. */
function describe(e: unknown, secrets: readonly string[]): string {
  let text: string;
  if (e instanceof Error) {
    const cause = (e as { cause?: { code?: unknown; message?: unknown } }).cause;
    const detail = cause && typeof cause === "object" ? (typeof cause.code === "string" ? cause.code : String(cause.message ?? "")) : "";
    text = detail ? `${e.message} (${detail})` : e.message;
  } else {
    text = String(e);
  }
  for (const s of secrets) if (s) text = text.split(s).join("***");
  return text;
}

export class Alerter {
  readonly cfg: AlertsConfig;
  readonly prefix: string;
  /** when each alert (kind:message) was last sent */
  readonly recent = new Map<string, Sent>();
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(cfg: AlertsConfig, prefix = "Bazaar keeper", opts: AlerterOptions = {}) {
    this.cfg = cfg;
    this.prefix = prefix;
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
  }

  get configured(): boolean {
    return Boolean(this.cfg.telegram || this.cfg.discord || this.cfg.webhook);
  }

  /** Nothing to release (each request is its own); kept so callers can close every service alike. */
  async close(): Promise<void> {}

  async send(kind: string, message: string, opts: SendOptions = {}): Promise<void> {
    const repeatAfter = opts.repeatAfter ?? 600;
    if (!(this.cfg.notify as readonly string[]).includes(kind)) return;
    const key = `${kind}:${message}`;
    const now = Date.now() / 1000;
    const last = this.recent.get(key);
    if (last && last.at > now - repeatAfter) return;
    this.recent.set(key, { at: now, repeatAfter });
    if (this.recent.size > 512) this.prune(now);
    // Messages carry names from outside (market labels): no control characters reach a chat or a log,
    // and Telegram gets plain text (no parse_mode).
    const shown = printable(message);
    const text = `${this.prefix}: ${shown}`;
    log.warning("alert (%s): %s", kind, shown);

    const posts: [channel: string, url: string, body: unknown, secrets: string[]][] = [];
    const { telegram, discord, webhook } = this.cfg;
    if (telegram) {
      const url = `https://api.telegram.org/bot${telegram.botToken}/sendMessage`;
      posts.push(["telegram", url, { chat_id: telegram.chatId, text }, [url, telegram.botToken]]);
    }
    // No @everyone, @here, role or user pings, whatever the text holds.
    if (discord) posts.push(["discord", discord.webhook, { content: text, allowed_mentions: { parse: [] } }, [discord.webhook]]);
    if (webhook) posts.push(["webhook", webhook.url, { kind, message: shown, ts: now }, [webhook.url]]);
    // Each channel on its own, so one that is down does not hold back the others.
    await Promise.all(posts.map(([channel, url, body, secrets]) => this.post(channel, url, body, secrets)));
  }

  private async post(channel: string, url: string, body: unknown, secrets: readonly string[]): Promise<void> {
    try {
      const r = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!r.ok) log.warning("could not deliver an alert to %s: HTTP %s", channel, r.status);
    } catch (e) {
      log.warning("could not deliver an alert to %s: %s", channel, describe(e, secrets));
    }
  }

  /** Forget alerts whose repeat window has passed, so the map does not grow with every distinct message. */
  private prune(now: number): void {
    for (const [k, s] of this.recent) if (s.at <= now - s.repeatAfter) this.recent.delete(k);
  }
}
