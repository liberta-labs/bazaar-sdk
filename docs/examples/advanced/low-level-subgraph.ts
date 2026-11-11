// SubgraphClient: raw GraphQL against Bazaar's subgraph, and consistent paging pinned to one block.
import { getAddress } from "viem";
import { SubgraphClient, SubgraphError, redactUrl, urlCredential } from "@liberta-labs/bazaar-sdk";

// ANCHOR: subgraph
const url = process.env.SUBGRAPH_URL!;
const sg = new SubgraphClient(url, process.env.SUBGRAPH_API_KEY ?? null, { timeoutMs: 20_000 });

try {
  const [block, , hasIndexingErrors] = await sg.meta();
  if (hasIndexingErrors) console.warn("the subgraph hit an indexing error");

  // Every open position at that block, 1000 rows a request, every page pinned to the same block.
  const rows = await sg.pages<{ id: string; account: { id: string }; size: string }>(
    "positions",
    "account { id } size",
    "isOpen: true",
    block,
  );
  for (const r of rows) console.log(getAddress(r.account.id), BigInt(r.size));

  // Any query of your own: its `data`.
  const d = await sg.query<{ pairs: { id: string; description: string }[] }>("{ pairs(first: 5) { id description } }");
  for (const p of d.pairs) console.log(p.id, p.description); // render descriptions as text, never HTML
} catch (e) {
  if (e instanceof SubgraphError) console.error(e.message); // the URL redacted, the key masked
  else throw e;
}
// ANCHOR_END: subgraph

// ANCHOR: urls
// Before printing a URL that may hold a key:
console.log(redactUrl("https://arb-mainnet.g.alchemy.com/v2/abcdef0123456789")); // https://arb-mainnet.g.alchemy.com/v2/***
console.log(urlCredential("https://example.com/rpc?key=abc")); // "a key in its key parameter"
console.log(urlCredential("https://arb1.arbitrum.io/rpc")); // null
// ANCHOR_END: urls
