// The headline comparison, apples to apples: sustained grant rate for SINGLE
// vs BATCHED POSTs, each measured from a deliberately DRAINED bucket so both
// figures are refill rates rather than burst depth.
//
// This closes the asymmetry the earlier probes left open — single calls
// throttled at POST #149 while 400 batched POSTs (40,000 sub-calls) sailed
// through. Measuring both against the same drained starting condition is the
// only way to tell a real weighting difference from a warmer bucket.
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

const call = (n: number, id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "eth_getBlockByNumber",
  params: ["0x" + n.toString(16), false],
});

async function post(p: unknown): Promise<{ ok: boolean; throttled: boolean }> {
  try {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "robotmoney-rmpc/1.0" },
      body: JSON.stringify(p),
    });
    const b = await r.text();
    const throttled = r.status === 429 || b.includes("-32016");
    return { ok: r.status === 200 && !throttled, throttled };
  } catch {
    return { ok: false, throttled: false };
  }
}

console.log(`head ${head} — 30s sustained window per arm, each from a drained bucket\n`);

for (const B of [1, 100]) {
  for (let i = 0; i < 250; i++) {
    const r = await post(call(head - i, 1));
    if (r.throttled) break;
  }
  const t0 = Date.now();
  let ok = 0;
  let no = 0;
  while (Date.now() - t0 < 30_000) {
    const p =
      B === 1
        ? call(head - 2000 - ok - no, 1)
        : Array.from({ length: B }, (_, j) => call(head - 3000 - (ok + no) * B - j, j));
    const r = await post(p);
    if (r.throttled) no++;
    else if (r.ok) ok++;
  }
  const s = (Date.now() - t0) / 1000;
  console.log(
    `batch=${String(B).padStart(3)}  ${(ok / s).toFixed(2).padStart(6)} POST/s granted  ` +
      `${((ok * B) / s).toFixed(0).padStart(7)} sub-calls/s  (${ok} ok, ${no} throttled)`,
  );
}
