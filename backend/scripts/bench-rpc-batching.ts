// What JSON-RPC array batching is actually worth against the public Base node.
//
// EVERY RESPONSE IS VALIDATED, and that is the whole reason this script was
// rewritten. Its first draft counted HTTP 200 as success and measured batches of
// 100 as "working" at ~400x throughput. They were not working: the node caps a
// batch at 10 and rejects an oversized one with HTTP **200** carrying
// `{"error":{"code":-32014,"message":"maximum 10 calls in 1 batch"}}`. The
// benchmark was measuring the speed of being refused. A measurement that does
// not check what came back is not a measurement.
//
// So: unique blocks only (a historical header is trivially cacheable, and a
// cached arm would look faster for the wrong reason), interleaved arms (a bucket
// refilling over the run cannot favour whichever went second), and a delivered
// count that only rises when a real block header comes back.
const RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const CAP = 10; // measured 2026-08-22; see DEFAULT_MAX_BATCH_SIZE

const head = Number(
  (
    (await (
      await fetch(RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "robotmoney-rmpc/1.0" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      })
    ).json()) as { result: string }
  ).result,
);

// A cold region, stepped by a prime so no block repeats within or across runs.
let cursor = head - 2_000_000;
const nextBlock = (): number => (cursor += 7919);

const call = (n: number, id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "eth_getBlockByNumber",
  params: ["0x" + n.toString(16), false],
});

interface Post {
  /** Sub-calls that came back as a real block header. */
  delivered: number;
  throttled: boolean;
  capped: boolean;
}

async function post(payload: unknown[], single: boolean): Promise<Post> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "robotmoney-rmpc/1.0" },
    body: JSON.stringify(single ? payload[0] : payload),
  });
  const text = await res.text();
  if (res.status === 429) return { delivered: 0, throttled: true, capped: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { delivered: 0, throttled: false, capped: false };
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  let delivered = 0;
  let throttled = false;
  let capped = false;
  for (const e of entries as { result?: { timestamp?: string }; error?: { code?: number } }[]) {
    if (e.error?.code === -32016) throttled = true;
    else if (e.error?.code === -32014) capped = true;
    // DELIVERED means a real header came back — not merely "no error".
    else if (e.result?.timestamp) delivered += 1;
  }
  return { delivered, throttled, capped };
}

console.log(`head ${head}; cold region from ${cursor}; batch cap ${CAP}\n`);

// INTERLEAVED, and that is not a detail. Run the arms in sequence and the first
// drains the bucket for the second — an earlier draft did exactly that and made
// batching look like a 400x win in one ordering and a 0x loss in the other.
// Alternating means both arms see the same distribution of bucket states, so the
// comparison is of the arms and not of their running order.
const WINDOW_MS = 30_000;
const results: Record<string, { posts: number; delivered: number; throttled: number; capped: number; ms: number }> = {
  single: { posts: 0, delivered: 0, throttled: 0, capped: 0, ms: 0 },
  [`batched x${CAP}`]: { posts: 0, delivered: 0, throttled: 0, capped: 0, ms: 0 },
};

const t0 = Date.now();
while (Date.now() - t0 < WINDOW_MS) {
  for (const single of [true, false]) {
    const arm = single ? "single" : `batched x${CAP}`;
    const payload = Array.from({ length: single ? 1 : CAP }, (_, j) => call(nextBlock(), j));
    const r = await post(payload, single);
    const acc = results[arm]!;
    acc.posts++;
    acc.delivered += r.delivered;
    if (r.throttled) acc.throttled++;
    if (r.capped) acc.capped++;
  }
}
for (const k of Object.keys(results)) results[k]!.ms = Date.now() - t0;

console.log("arm            POSTs  delivered  throttled  capped   delivered/s   per-POST");
for (const [arm, r] of Object.entries(results)) {
  console.log(
    `${arm.padEnd(14)} ${String(r.posts).padStart(5)}  ${String(r.delivered).padStart(9)}  ` +
      `${String(r.throttled).padStart(9)}  ${String(r.capped).padStart(6)}   ` +
      `${(r.delivered / (r.ms / 1000)).toFixed(1).padStart(11)}   ${(r.delivered / r.posts).toFixed(2).padStart(8)}`,
  );
}

const s = results["single"]!;
const b = results[`batched x${CAP}`]!;
const ratio = b.delivered / (b.ms / 1000) / (s.delivered / (s.ms / 1000));
console.log(`\nthroughput ratio (batched / single): ${ratio.toFixed(2)}x`);
console.log(
  ratio > 3
    ? "  → the meter is closer to PER-POST: batching buys real throughput."
    : ratio > 1.2
      ? "  → partial: batching buys round trips and some throughput, well short of the cap ratio."
      : "  → the meter is closer to PER-SUB-CALL: batching buys round trips, NOT throughput.\n" +
        "    Multicall3 stays the real leverage — it collapses many reads into ONE sub-call.",
);
