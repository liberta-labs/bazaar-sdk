// A token endpoint, so a browser app can use Pyth Pro without shipping its API key: the server
// exchanges the key for a short-lived token and hands that to pages of your origin.
import { createServer } from "node:http";
import { type MintedToken, mintProToken } from "@liberta-labs/bazaar-sdk";

// ANCHOR: tokens
const KEY = process.env.PYTH_PRO_API_KEY ?? ""; // stays on the server
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "https://app.example.com";

// One token serves every visitor until a minute before it expires (Pyth's tokens live at most 15 minutes).
let held: MintedToken | null = null;
async function currentToken(): Promise<MintedToken> {
  const now = Date.now() / 1000;
  if (!held || (held.expiresAt ?? 0) - 60 < now) held = await mintProToken(KEY);
  return held;
}

createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", ALLOWED_ORIGIN);
  if (req.method !== "GET" || req.url !== "/api/pyth-token") {
    res.writeHead(404).end();
    return;
  }
  // Gate this like any endpoint of yours (a session, a rate limit): whoever is handed a token can
  // read prices on your key until it expires.
  try {
    const { token, expiresAt } = await currentToken();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ token, expiresAt }));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e); // the SDK's errors never hold the key
    res.writeHead(502).end();
  }
}).listen(8787);
// ANCHOR_END: tokens
