/**
 * The WebSocket the keeper streams prices on: a frame above its bound closes the connection before it
 * is buffered, compression is never offered, redirects are not followed, and whatever the price
 * client passes (headers or subprotocols) is kept under the keeper's own bounds.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_STREAM_MESSAGE } from "@liberta-labs/bazaar-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket as PlainSocket, WebSocketServer } from "ws";
import { MAX_STREAM_FRAME_BYTES, StreamSocket } from "../src/keeper/stream-socket.js";
import { FEED, fake } from "./keeper-harness.js";

interface Peer {
  url: string;
  /** the upgrade requests the server saw */
  requests: IncomingMessage[];
  close(): Promise<void>;
}

/** A WebSocket server that sends `frame` to every connection as soon as it opens. */
async function peer(frame: string | null, opts: { deflate?: boolean } = {}): Promise<Peer> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ server, perMessageDeflate: opts.deflate ?? true, handleProtocols: (offered) => [...offered][0] ?? false });
  const requests: IncomingMessage[] = [];
  wss.on("connection", (ws, req) => {
    requests.push(req);
    if (frame !== null) ws.send(frame);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

interface Outcome {
  opened: boolean;
  messages: number;
  bytes: number;
  code: number | null;
  error: string | null;
}

/** Open `socket` and gather what happens until it closes or `ms` pass. */
function watch(socket: PlainSocket, ms = 5_000): Promise<Outcome> {
  const out: Outcome = { opened: false, messages: 0, bytes: 0, code: null, error: null };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.terminate();
      resolve(out);
    }, ms);
    socket.on("open", () => (out.opened = true));
    socket.on("message", (data: Buffer) => {
      out.messages += 1;
      out.bytes += data.length;
      socket.close();
    });
    socket.on("error", (e) => (out.error = e.message));
    socket.on("close", (code) => {
      clearTimeout(timer);
      out.code = code;
      resolve(out);
    });
  });
}

const peers: Peer[] = [];
afterEach(async () => {
  for (const p of peers.splice(0)) await p.close();
});

describe("the stream's WebSocket", () => {
  it("bounds a frame at three bytes per character of the price client's own cap", () => {
    expect(MAX_STREAM_FRAME_BYTES).toBe(3 * MAX_STREAM_MESSAGE);
  });

  it("closes on a frame above its bound before taking it, where ws's defaults would buffer it", async () => {
    const big = "a".repeat(MAX_STREAM_FRAME_BYTES + 1);
    const p = await peer(big);
    peers.push(p);
    const bounded = await watch(new StreamSocket(p.url));
    expect(bounded).toMatchObject({ opened: true, messages: 0 });
    expect(bounded.error).toMatch(/Max payload size exceeded/);
    // The same frame, through ws as it comes, is taken whole.
    const plain = await watch(new PlainSocket(p.url));
    expect([plain.messages, plain.bytes]).toEqual([1, big.length]);
    // A frame within the bound goes through.
    const fits = await peer("b".repeat(MAX_STREAM_FRAME_BYTES));
    peers.push(fits);
    expect(await watch(new StreamSocket(fits.url))).toMatchObject({ messages: 1, bytes: MAX_STREAM_FRAME_BYTES });
  });

  it("never offers compression, so no frame can inflate past its size on the wire", async () => {
    const p = await peer(null, { deflate: true });
    peers.push(p);
    await watch(new StreamSocket(p.url), 300);
    await watch(new PlainSocket(p.url), 300);
    expect(p.requests.map((r) => r.headers["sec-websocket-extensions"] ?? null)).toEqual([null, expect.stringContaining("permessage-deflate")]);
  });

  it("keeps the headers or the subprotocols the price client passes, under its own bounds", async () => {
    const p = await peer("c".repeat(MAX_STREAM_FRAME_BYTES + 1));
    peers.push(p);
    // Options that would loosen the bounds are overridden; the headers stay.
    const withHeaders = await watch(new StreamSocket(p.url, { headers: { Authorization: "Bearer made-up-token" }, maxPayload: 1 << 30, perMessageDeflate: true }));
    const withProtocols = await watch(new StreamSocket(p.url, ["pyth-lazer-auth", "made-up-token"]));
    for (const out of [withHeaders, withProtocols]) {
      expect(out).toMatchObject({ opened: true, messages: 0 });
      expect(out.error).toMatch(/Max payload size exceeded/);
    }
    expect(p.requests.map((r) => [r.headers.authorization ?? null, r.headers["sec-websocket-protocol"] ?? null, r.headers["sec-websocket-extensions"] ?? null])).toEqual([
      ["Bearer made-up-token", null, null],
      [null, "pyth-lazer-auth,made-up-token", null],
    ]);
  });

  it("does not follow a redirect to another host", async () => {
    const target = await peer("d");
    peers.push(target);
    const redirector = createServer();
    redirector.on("upgrade", (_req, socket) => {
      socket.end(`HTTP/1.1 302 Found\r\nLocation: ${target.url}\r\nContent-Length: 0\r\n\r\n`);
    });
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
    try {
      const url = `ws://127.0.0.1:${(redirector.address() as AddressInfo).port}`;
      const out = await watch(new StreamSocket(url, { headers: { Authorization: "Bearer made-up-token" } }));
      expect(out.opened).toBe(false);
      expect(out.error).toMatch(/Unexpected server response: 302/);
      expect(target.requests).toEqual([]); // the token's header never reached the other host
    } finally {
      await new Promise<void>((r) => redirector.close(() => r()));
    }
  });
});

describe("the keeper's price stream", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bazaar-socket-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs on the bounded socket: an oversized frame drops the endpoint before the price client reads it", async () => {
    // Two endpoints, so the stream keeps running on the quiet one while the other is dropped.
    const quiet = await peer(null);
    const bad = await peer("e".repeat(MAX_STREAM_FRAME_BYTES + 1));
    peers.push(quiet, bad);
    const f = fake(dir, {
      prices: { endpoint: quiet.url.replace(/^ws/, "http"), streamUrls: [`${quiet.url}/v1/stream`, `${bad.url}/v1/stream`], checkSigners: false },
    });
    const notices: string[] = [];
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1_500);
    try {
      for await (const _ of f.k.pro.stream([[FEED]], ctl.signal, { idleTimeout: 0, onNotice: (m) => notices.push(m) })) break;
    } catch {
      // the stream may give up once the endpoint keeps dropping: what matters is why it dropped
    } finally {
      clearTimeout(timer);
      await f.k.close();
    }
    expect(notices.length).toBeGreaterThan(0);
    // ws refused the frame: the price client's own cap, which reads the whole message, never ran.
    expect(notices[0]).toMatch(/^price stream endpoint ws:\/\/127\.0\.0\.1:\d+\/v1\/stream dropped \(Max payload size exceeded\): reconnecting$/);
    expect(notices.join("\n")).not.toMatch(/longer than/);
  });
});
