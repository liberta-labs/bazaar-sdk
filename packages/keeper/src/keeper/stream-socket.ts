/**
 * The WebSocket the keeper streams prices on: the `ws` package's, with bounds the price client cannot
 * set through the standard constructor arguments it passes (a URL, then the subprotocol list or an
 * options object carrying the headers).
 *
 * Without them `ws` takes frames of up to 100 MiB and offers per-message compression, so a stream
 * endpoint (a custom one, a proxy, or anyone on the path of a plain `ws://` connection) could send a
 * small compressed frame that inflates to 100 MiB on every connection, all of it buffered before the
 * price client's own message cap sees it.
 */

import { MAX_STREAM_MESSAGE, type WebSocketConstructor } from "@liberta-labs/bazaar-sdk";
import WebSocket, { type ClientOptions } from "ws";

/**
 * The largest frame a stream connection accepts, in bytes. The price client caps a text message at
 * MAX_STREAM_MESSAGE UTF-16 code units, and a code unit takes at most three bytes of UTF-8, so no
 * message the client would take is refused here; a larger frame closes the connection (code 1009)
 * before its payload is read.
 */
export const MAX_STREAM_FRAME_BYTES = 3 * MAX_STREAM_MESSAGE;

/** Milliseconds a stream connection may take to open before it counts as failed. */
export const STREAM_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * What every stream connection is opened with, over whatever the price client passes: the frame
 * bound, no compression (so a frame's size on the wire is its size in memory), no redirects (a
 * redirect would carry the token's header to a host the endpoint names) and a handshake timeout.
 */
export const STREAM_SOCKET_OPTIONS: Readonly<ClientOptions> = Object.freeze({
  maxPayload: MAX_STREAM_FRAME_BYTES,
  perMessageDeflate: false,
  followRedirects: false,
  handshakeTimeout: STREAM_HANDSHAKE_TIMEOUT_MS,
});

/** `ws`'s WebSocket opened with {@link STREAM_SOCKET_OPTIONS}, which override any options passed. */
export class StreamSocket extends WebSocket {
  constructor(url: string | URL, protocolsOrOptions?: string | string[] | ClientOptions) {
    if (typeof protocolsOrOptions === "string" || Array.isArray(protocolsOrOptions)) {
      super(url, protocolsOrOptions, { ...STREAM_SOCKET_OPTIONS });
    } else {
      super(url, { ...protocolsOrOptions, ...STREAM_SOCKET_OPTIONS });
    }
  }
}

/** {@link StreamSocket} as the price client's WebSocket option takes it. */
export const streamSocket: WebSocketConstructor = StreamSocket as unknown as WebSocketConstructor;
