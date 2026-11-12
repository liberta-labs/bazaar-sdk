/**
 * A client for the Bazaar subgraph: GraphQL queries, the indexer's head, and paging pinned to a block.
 *
 * Browser-safe: it needs only `fetch`. Paging a whole entity at one block gives a consistent view of
 * what the chain held there, which is how the keeper bootstraps its index (its bootstrap lives in
 * @liberta-labs/bazaar-keeper). The subgraph lags the chain and cannot see state that changes without
 * an event, so treat what it returns as discovery and re-read from the chain before acting.
 */

import { type Address, type Hex, getAddress } from "viem";
import { ResponseTooLargeError, deadline, readTextCapped } from "../chain/rpc.js";
import { redactUrl } from "../urls.js";

/** Rows per page: the most a hosted graph-node returns for one `first:`. */
export const SUBGRAPH_PAGE = 1000;
/** {@link SubgraphOptions.maxPages}' default: a million rows of one entity. */
export const SUBGRAPH_MAX_PAGES = 1000;
const MAX_RESPONSE_BYTES = 16 * 1_048_576;
const BYTES_ID = /^0x[0-9a-fA-F]*$/;

export class SubgraphError extends Error {
  override readonly name = "SubgraphError";
}

export interface SubgraphOptions {
  /** Per request; 30 s by default. */
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** The most bytes one answer may hold; 16 MiB by default. A larger one throws SubgraphError. */
  maxResponseBytes?: number;
  /** The most pages {@link SubgraphClient.pages} reads for one entity; 1000 (a million rows) by default. */
  maxPages?: number;
}

/** The indexer's head: the block it has indexed, its hash, and whether it hit indexing errors. */
export type SubgraphMeta = readonly [block: number, hash: Hex | null, hasIndexingErrors: boolean];

const errorText = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? e.cause.message : "";
  return cause && cause !== e.message ? `${e.message}: ${cause}` : e.message;
};

export class SubgraphClient {
  // The URL, the key and the headers are private fields, which printing or serializing the client never shows.
  readonly #url: string;
  readonly #apiKey: string | null;
  readonly #headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly maxResponseBytes: number;
  private readonly maxPages: number;

  /** `apiKey`, when given, is sent as `Authorization: Bearer <key>`. */
  constructor(url: string, apiKey?: string | null, opts: SubgraphOptions = {}) {
    this.#url = url;
    this.#apiKey = apiKey || null;
    this.#headers = { "content-type": "application/json", ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}) };
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.maxResponseBytes = opts.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    this.maxPages = opts.maxPages ?? SUBGRAPH_MAX_PAGES;
  }

  /** The endpoint's URL as given. It may hold a key: print it through `redactUrl`. */
  get url(): string {
    return this.#url;
  }

  /** Nothing to release (fetch keeps no client); kept so callers can close every client alike. */
  async close(): Promise<void> {}

  /** Text fit for an error message: the URL redacted, the key masked. */
  private scrub(s: string): string {
    let out = s.split(this.#url).join(redactUrl(this.#url));
    if (this.#apiKey) out = out.split(this.#apiKey).join("***");
    return out;
  }

  /** One GraphQL query; its `data`. HTTP failures, GraphQL errors and unreadable answers throw SubgraphError. */
  async query<T = Record<string, unknown>>(q: string, variables: Record<string, unknown> = {}): Promise<T> {
    const limit = deadline(this.timeoutMs);
    let out: unknown;
    try {
      let r: Response;
      try {
        r = await limit.race(
          this.fetchFn(this.#url, {
            method: "POST",
            headers: this.#headers,
            body: JSON.stringify({ query: q, variables }),
            signal: limit.signal,
          }),
        );
      } catch (e) {
        throw new SubgraphError(`subgraph unreachable: ${this.scrub(errorText(e))}`);
      }
      if (r.status >= 400) {
        const text = await limit.race(readTextCapped(r, 65_536, "the subgraph")).catch(() => "");
        throw new SubgraphError(`subgraph returned HTTP ${r.status}: ${this.scrub(text.slice(0, 200))}`);
      }
      try {
        out = JSON.parse(await limit.race(readTextCapped(r, this.maxResponseBytes, "the subgraph")));
      } catch (e) {
        if (e instanceof ResponseTooLargeError) throw new SubgraphError(e.message);
        throw new SubgraphError(`subgraph returned an unreadable answer: ${this.scrub(errorText(e))}`);
      }
    } finally {
      limit.clear();
    }
    if (!out || typeof out !== "object") throw new SubgraphError("subgraph returned an unreadable answer");
    const o = out as { data?: unknown; errors?: unknown };
    if (Array.isArray(o.errors) && o.errors.length) {
      const msg = o.errors
        .map((e) => (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message : ""))
        .join("; ");
      throw new SubgraphError(this.scrub(msg.slice(0, 500)));
    }
    if (!o.data || typeof o.data !== "object") throw new SubgraphError("subgraph returned no data");
    return o.data as T;
  }

  async meta(): Promise<SubgraphMeta> {
    const d = await this.query<{ _meta?: { block?: { number: number | string; hash?: Hex | null }; hasIndexingErrors?: boolean } }>(
      "{ _meta { block { number hash } hasIndexingErrors } }",
    );
    const m = d._meta;
    if (!m || !m.block) throw new SubgraphError("subgraph returned no _meta");
    return [Number(m.block.number), m.block.hash ?? null, Boolean(m.hasIndexingErrors)];
  }

  /**
   * Every row of `entity` matching `where` (GraphQL filter text, may be empty) as of `block`, in id
   * order, 1000 rows a request. Every page is pinned to the same block, so the rows are consistent with
   * each other. `bytesId` for entities whose id is Bytes rather than ID (the cursor starts at "0x").
   *
   * Every row's id must be a string (hex for Bytes) greater than the one before it, the cursor
   * included, and at most `maxPages` pages are read: a subgraph that repeats or reorders rows, or
   * never stops, throws SubgraphError instead of paging forever.
   */
  async pages<T extends { id: string }>(entity: string, fields: string, where: string, block: number, bytesId = false): Promise<T[]> {
    if (!Number.isSafeInteger(block) || block < 0) throw new TypeError(`not a block number: ${block}`);
    // Cursor and block are written into the query rather than passed as variables: an id filter's
    // type is ID or Bytes depending on the entity, and a literal coerces to either. The cursor is the
    // subgraph's own text, so it goes in as a quoted literal (JSON's escapes are GraphQL's) and, for
    // Bytes, only once it is hex: an id cannot rewrite the query.
    const out: T[] = [];
    let last = bytesId ? "0x" : "";
    for (let page = 0; ; page++) {
      if (page >= this.maxPages) {
        throw new SubgraphError(`subgraph paging of ${entity} stopped after ${this.maxPages} pages (${out.length} rows); raise maxPages if it really holds more`);
      }
      const cond = `id_gt: ${JSON.stringify(last)}` + (where ? `, ${where}` : "");
      const q =
        `{ ${entity}(first: ${SUBGRAPH_PAGE}, orderBy: id, orderDirection: asc, block: {number: ${block}}, ` +
        `where: {${cond}}) { id ${fields} } }`;
      const rows = (await this.query<Record<string, unknown>>(q))[entity];
      if (!Array.isArray(rows)) throw new SubgraphError(`subgraph returned no ${entity}`);
      for (const r of rows) {
        const id: unknown = r && typeof r === "object" ? (r as { id?: unknown }).id : undefined;
        if (typeof id !== "string" || (bytesId && !BYTES_ID.test(id))) throw new SubgraphError(`subgraph returned ${entity} without a valid id`);
        const key = bytesId ? id.toLowerCase() : id;
        // id_gt asked for ids after the cursor, in order: anything else repeats rows or pages forever.
        if (!(key > last)) throw new SubgraphError(`subgraph returned ${entity} out of id order; refusing to page further`);
        last = key;
        out.push(r as T);
      }
      if (rows.length < SUBGRAPH_PAGE) return out;
    }
  }

  /** Each pair's listing description, by address. */
  async descriptions(block: number): Promise<Map<Address, string>> {
    const rows = await this.pages<{ id: string; description: string }>("pairs", "description", "", block, true);
    return new Map(rows.map((r) => [getAddress(r.id), r.description]));
  }

  /** Open governance items, for the opportunities view. */
  async proposals(): Promise<Record<string, Record<string, unknown>[]>> {
    const q = `{
      terminationProposals(first: 200, where: {status_in: [Pending, Disputed]}) {
        id pair { id } status disputed livenessEndsAt lastTradingTs }
      insurerProposals(first: 200, where: {status: Open}) { id pair { id } cutoffTs yesShares snapshotTotalShares }
      listingProposals(first: 200, where: {status_in: [Pending, Disputed]}) {
        id pairId description status disputed proposedAt livenessEndsAt }
      identifierUpgradeProposals(first: 50, where: {status_in: [Pending, Disputed, Queued]}) {
        id status disputed livenessEndsAt effectiveTs newIdentifier }
    }`;
    return this.query(q);
  }
}
