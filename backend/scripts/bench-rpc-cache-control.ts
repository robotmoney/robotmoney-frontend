// CONTROL for the batching measurement.
//
// docs/technical/data-self-healing.md §6.5.3 records the opposite of what the
// 2026-08-22 benchmark found: a structural cap of 10 calls per batch
// (`-32014 maximum 10 calls in 1 batch`) and a limiter that "meters per
// sub-call, not per HTTP request". Before amending a documented measurement, the
// obvious confound has to be ruled out: `eth_getBlockByNumber` on a historical
// block is trivially cacheable, so a batched arm that sailed through may simply
// have been served from an edge cache rather than actually metered differently.
//
// So this arm uses blocks NO earlier run touched, requests each exactly once,
// and interleaves the two shapes rather than running them in sequence — an
// interleave means a bucket that refills over the run cannot favour whichever
// arm went second.
const RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";

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

// A cold region: ~1.5M blocks back (≈35 days), stepping by a prime so no two
// requests in this run repeat a block and none collide with earlier benchmarks.
let cursor = head - 1_500_000;
const nextBlock = (): number => (cursor += 7919);

const call = (n: number, id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "eth_getBlockByNumber",
  params: ["0x" + n.toString(16), false],
});

async function post(p: unknown): Promise<{ throttled: boolean; status: number; note: string }> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "robotmoney-rmpc/1.0" },
    body: JSON.stringify(p),
  });
  const b = await r.text();
  const throttled = r.status === 429 || b.includes("-32016") || b.toLowerCase().includes("over rate limit");
  const capped = b.includes("-32014") || b.includes("maximum") ? " CAP-ERROR" : "";
  return { throttled, status: r.status, note: capped + (b.startsWith("[") ? "" : " NON-ARRAY") };
}

console.log(`head ${head}; cold region from ${cursor}, unique blocks only\n`);

// 1. Does the documented cap of 10 still exist?
console.log("=== cap check (doc §6.5.3 says: max 10 per batch, -32014 beyond) ===");
for (const size of [10, 11, 25, 100]) {
  const r = await post(Array.from({ length: size }, (_, j) => call(nextBlock(), j)));
  console.log(`  size ${String(size).padStart(4)}: HTTP ${r.status}${r.note}${r.throttled ? " THROTTLED" : ""}`);
}

// 2. Interleaved single vs batched, unique blocks, 20 rounds.
console.log("\n=== interleaved single vs batched, all-unique blocks ===");
let singleThrottled = 0;
let batchThrottled = 0;
let singleSent = 0;
let batchSent = 0;
for (let round = 0; round < 20; round++) {
  for (let k = 0; k < 10; k++) {
    const s = await post(call(nextBlock(), 1));
    singleSent++;
    if (s.throttled) singleThrottled++;
  }
  const b = await post(Array.from({ length: 10 }, (_, j) => call(nextBlock(), j)));
  batchSent++;
  if (b.throttled) batchThrottled++;
}
console.log(`  single : ${singleSent} POSTs (${singleSent} sub-calls), ${singleThrottled} throttled`);
console.log(`  batched: ${batchSent} POSTs (${batchSent * 10} sub-calls), ${batchThrottled} throttled`);
console.log(
  `\n  Same number of SUB-CALLS each (${singleSent} vs ${batchSent * 10}); the arms differ only in how many POSTs carried them.`,
);
