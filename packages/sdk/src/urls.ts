/**
 * Credentials that providers put inside URLs: finding them, and hiding them before a URL is shown.
 *
 * Hosted RPCs, indexers and price services often carry the API key in the URL itself: Alchemy's
 * /v2/<key>, Infura's /v3/<id>, QuickNode's /<token>/, The Graph gateway's /api/<key>/, a ?key= or
 * ?dkey= query, or user:password@ before the host. The keeper's config loader refuses such a URL
 * written into the config file, and anything that prints or throws with a URL passes it through
 * {@link redactUrl} first.
 *
 * Keys come in too many shapes to be recognised by their look (a rule like that missed letters-only,
 * short, JWT, base64 and percent-encoded keys), so redaction goes by structure instead: it keeps only
 * the parts of a URL known not to be secret and masks everything else, whatever it looks like.
 *
 * - user name and password: always masked. Everything before the last `@` counts, even past a `/`,
 *   `?` or `#`, since a password may hold those.
 * - host: a label shorter than 16 characters is kept; a longer one only when it is lowercase words
 *   (and numbers) joined by `-`, such as `arbitrum-one-rpc` or `solitary-few-shard`. A port that is not
 *   a number masks the whole host.
 * - path: a segment is kept when it is empty, a well-known word ({@link PATH_WORDS}: `rpc`, `api`,
 *   `subgraphs`, `query`, `hermes`, `arbitrum`, ...), a version (`v2`, `v0.0.1`, `1.0.0`), a number of
 *   up to 8 digits, one or two letters or digits, or a name made of lowercase words (and numbers)
 *   joined by `-` or `_` (`bazaar-arbitrum-sepolia`, `price_feeds`). Every other segment is masked.
 * - query: every value is masked except, when plain (letters, digits, `_ . , -`), those of the
 *   parameters in {@link PUBLIC_PARAMS} (`network`, `chain`, `chainId`, and Hermes' own `ids[]`,
 *   `encoding`, `parsed`, ...). An empty value stays. A parameter without `=`, or whose name is not
 *   letters joined by `- _ .`, is masked whole.
 * - fragment: masked. A URL with a tab or line break inside (which fetch would drop) is printed without
 *   them, so it counts as changed.
 *
 * The scheme may be http, https, ws or wss in any case, followed by any number of `/` or `\` (as fetch
 * accepts it). Leading and trailing blanks and every kept part keep the input's own spelling.
 *
 * {@link urlCredential} applies the same rules: it reports a URL exactly when {@link redactUrl} masks
 * some part of it (so `redactUrl(url) !== url`, unless the URL already holds the mask text there).
 */

/** Path segments that are never secret (compared without case). */
export const PATH_WORDS: ReadonlySet<string> = new Set([
  "api", "rpc", "jsonrpc", "http", "https", "ws", "wss", "websocket", "evm", "ext", "nitro", "sequencer",
  "subgraphs", "subgraph", "id", "name", "query", "graphql", "gql", "public", "version", "versions", "latest",
  "hermes", "ogrpc", "updates", "price", "prices", "stream",
  "arbitrum", "arb", "arb1", "nova", "mainnet", "sepolia", "testnet", "eth", "ethereum", "anvil", "bazaar", "keeper",
]);

/** Query parameters whose (plain) values are never secret (compared without case). */
export const PUBLIC_PARAMS: ReadonlySet<string> = new Set([
  "network", "chain", "chainid", "chain_id",
  "ids[]", "ids%5b%5d", "encoding", "parsed", "ignore_invalid_price_ids", "benchmarks_only", "allow_unordered",
]);

const SHORT = /^[A-Za-z0-9]{1,2}$/;
const NUMBER = /^\d{1,8}$/;
const VERSION = /^(?:v\d{1,4}(?:\.\d{1,6}){0,3}|\d{1,4}(?:\.\d{1,6}){1,3})$/i;
const PATH_NAME = /^[a-z]{1,15}(?:[-_](?:[a-z]{1,15}|\d{1,8}))+$/;
const HOST_NAME = /^[a-z]{1,15}(?:-(?:[a-z]{1,15}|\d{1,8}))+$/;
const PARAM_NAME = /^[A-Za-z]{1,15}(?:[-_.][A-Za-z]{1,15})*(?:\[\])?$/;
const PLAIN_VALUE = /^[A-Za-z0-9_.,-]*$/;
const SCHEME = /^(?:https?|wss?):/i;
const BREAKS = /[\t\n\r]/g;

const isBlank = (c: number) => c <= 0x20 || /\s/.test(String.fromCharCode(c));

/** Whether `value` is an http(s) or ws(s) URL, as fetch would read it. */
export function isUrl(value: string): boolean {
  let i = 0;
  const v = value.replace(BREAKS, "");
  while (i < v.length && isBlank(v.charCodeAt(i))) i++;
  return SCHEME.test(v.slice(i, i + 6));
}

function publicSegment(seg: string): boolean {
  return (
    seg === "" || PATH_WORDS.has(seg.toLowerCase()) || SHORT.test(seg) || NUMBER.test(seg) || VERSION.test(seg) || PATH_NAME.test(seg)
  );
}

interface Redacted {
  text: string;
  /** where the first masked part was, as a phrase for an error message; null when nothing was */
  what: string | null;
}

/** The redaction and where it masked first: the one place both exported functions get their answer. */
function redact(url: string, mask: string): Redacted {
  if (!isUrl(url)) return { text: url, what: null };
  let what: string | null = null;
  const masked = (phrase: string) => {
    what ??= phrase;
    return mask;
  };
  const cleaned = url.replace(BREAKS, "");
  let start = 0;
  while (start < cleaned.length && isBlank(cleaned.charCodeAt(start))) start++;
  let end = cleaned.length;
  while (end > start && isBlank(cleaned.charCodeAt(end - 1))) end--;
  const lead = cleaned.slice(0, start);
  const trail = cleaned.slice(end);
  const body = cleaned.slice(start, end);
  const scheme = /^[A-Za-z]+:[/\\]*/.exec(body)![0];
  let rest = body.slice(scheme.length);

  let userinfo = "";
  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    const u = rest.slice(0, at);
    userinfo =
      (u === "" ? "" : masked(/[/\\?#]/.test(u) ? "an @ that makes part of it read as a user name or password" : "a user name or password before the host")) + "@";
    rest = rest.slice(at + 1);
  }
  const hostEnd = rest.search(/[/\\?#]/);
  const hostPort = hostEnd < 0 ? rest : rest.slice(0, hostEnd);
  rest = hostEnd < 0 ? "" : rest.slice(hostEnd);
  let host: string;
  const hp = /^(\[[^\]]*\]|[^:]*)(:\d*)?$/.exec(hostPort);
  if (!hp) host = masked("a key in its host name");
  else {
    const name = hp[1] ?? "";
    const labels = name.startsWith("[")
      ? /^\[[0-9A-Fa-f:.]*\]$/.test(name)
        ? name
        : masked("a key in its host name")
      : name
          .split(".")
          .map((l) => (l.length < 16 || HOST_NAME.test(l.toLowerCase()) ? l : masked("a key in its host name")))
          .join(".");
    host = labels + (hp[2] ?? "");
  }

  const fragAt = rest.indexOf("#");
  const fragment = fragAt < 0 ? null : rest.slice(fragAt + 1);
  if (fragAt >= 0) rest = rest.slice(0, fragAt);
  const queryAt = rest.indexOf("?");
  const query = queryAt < 0 ? null : rest.slice(queryAt + 1);
  const path = (queryAt < 0 ? rest : rest.slice(0, queryAt))
    .split(/([/\\])/)
    .map((seg, i) => (i % 2 === 1 || publicSegment(seg) ? seg : masked("a key in its path")))
    .join("");

  let q = "";
  if (query !== null) {
    const items = query.split("&").map((item) => {
      if (item === "") return item;
      const eq = item.indexOf("=");
      const name = eq < 0 ? item : item.slice(0, eq);
      const known = PUBLIC_PARAMS.has(name.toLowerCase());
      if (eq < 0) return known ? item : masked("a key in its query");
      if (!known && !PARAM_NAME.test(name)) return masked("a key in its query");
      const value = item.slice(eq + 1);
      if (value === "" || (known && PLAIN_VALUE.test(value))) return item;
      return `${name}=${masked(`a key in its ${name} parameter`)}`;
    });
    q = "?" + items.join("&");
  }
  const f = fragment === null ? "" : "#" + (fragment === "" ? "" : masked("a key in its fragment"));
  if (cleaned !== url) what ??= "a tab or line break inside it";
  return { text: lead + scheme + userinfo + host + path + q + f + trail, what };
}

/**
 * Where the URL may carry a credential, as a phrase that reads after "a URL with" (`a user name or
 * password before the host`, `a key in its host name / path / <name> parameter / query /
 * fragment`, `a tab or line break inside it`), or null when it carries none. Non-null exactly when
 * {@link redactUrl} would mask some part of it; null for values that are not URLs.
 */
export function urlCredential(url: string): string | null {
  return redact(url, "").what;
}

/**
 * The URL with every part not known to be public replaced by `mask`, safe to print or log (see the
 * module's rules). Values that are not URLs (keywords such as `sequencer` or `none`) are returned
 * unchanged. Redacting a redacted URL changes nothing more.
 */
export function redactUrl(url: string, mask = "***"): string {
  return redact(url, mask).text;
}
