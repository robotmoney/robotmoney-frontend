// Find the public Base endpoint's ACTUAL throttling ceiling, then measure what
// batching buys against it.
//
// WHY A SECOND SCRIPT. bench-rpc-batching.ts probed 80 sequential POSTs and was
// never throttled — at 32 req/s sustained, which is ~130x the 0.55 calls/s this
// repo paces to. Either the provider's limits moved since the #651 measurement
// (2026-08-10), or that figure came from a longer-window quota a 2.5-second
// burst never reaches. Designing a batching change against an unmeasured ceiling
// would just be replacing one guess with another, so this escalates until the
// endpoint actually says no.
//
// BOUNDED BY CONSTRUCTION. Every phase stops at the first sustained throttle or
// at its cap, whichever comes first, and the caps below are the whole budget
// this script will ever spend.
import { _resetRpcRateLimiterForTests } from "../src/chain/base-rpc-client.ts";

const RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const log = (m: string) => console.log(m);

process.env.BASE_RPC_MAX_CALLS_PER_SEC = "0";
process.env.BASE_RPC_MAX_RETRIES = "0";
_resetRpcRateLimiterForTests();

interface Outcome {
  status: number;
  throttled: boolean;
  ms: number;
}

const blockCall = (n: number, id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "eth_getBlockByNumber",
  params: ["0x" + n.toString(16), false],
});

async function post(payload: unknown): Promise<Outcome> {
  const t = Date.now();
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "robotmoney-rmpc/1.0" },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    const throttled =
      res.status === 429 || body.includes("-32016") || body.toLowerCase().includes("over rate limit");
    return { status: res.status, throttled, ms: Date.now() - t };
  } catch {
    return { status: 0, throttled: false, ms: Date.now() - t };
  }
}

/** Fire `total` POSTs with `conc` in flight at once. Stops early once
 *  `stopAfter` throttles have been seen. */
async function stampede(
  label: string,
  total: number,
  conc: number,
  make: (i: number) => unknown,
  stopAfter = 5,
): Promise<{ sent: number; ok: number; throttled: number; firstThrottleAt: number | null; elapsedMs: number }> {
  const started = Date.now();
  let sent = 0;
  let ok = 0;
  let throttled = 0;
  let firstThrottleAt: number | null = null;
  let next = 0;
  let stop = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stop) return;
      const i = next++;
      if (i >= total) return;
      const r = await post(make(i));
      sent++;
      if (r.throttled) {
        throttled++;
        if (firstThrottleAt === null) firstThrottleAt = sent;
        if (throttled >= stopAfter) stop = true;
      } else if (r.status === 200) ok++;
    }
  };

  await Promise.all(Array.from({ length: conc }, () => worker()));
  const elapsedMs = Date.now() - started;
  log(
    `  ${label.padEnd(28)} sent ${String(sent).padStart(4)}  ok ${String(ok).padStart(4)}  throttled ${String(throttled).padStart(3)}` +
      `  ${(sent / (elapsedMs / 1000)).toFixed(0).padStart(4)} POST/s  ${elapsedMs}ms` +
      `${firstThrottleAt === null ? "" : `  first throttle @ #${firstThrottleAt}`}`,
  );
  return { sent, ok, throttled, firstThrottleAt, elapsedMs };
}

const head = Number((await (await fetch(RPC, {
  method: "POST",
  headers: { "Content-Type": "application/json", "User-Agent": "robotmoney-rmpc/1.0" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
})).json() as { result: string }).result);

log(`head block ${head} — escalating until throttled\n`);

log("=== ESCALATION: single-call POSTs, rising concurrency ===");
for (const conc of [10, 25, 50, 100]) {
  const r = await stampede(`conc=${conc}, 300 POSTs`, 300, conc, (i) => blockCall(head - i, 1));
  if (r.throttled > 0) {
    log(`  → ceiling found at concurrency ${conc}\n`);
    break;
  }
  await Bun.sleep(2000);
}

log("\n=== BATCHED: same escalation, 100 sub-calls per POST ===");
for (const conc of [10, 25, 50]) {
  const r = await stampede(`conc=${conc}, 100 POSTs x100`, 100, conc, (i) =>
    Array.from({ length: 100 }, (_, j) => blockCall(head - i * 100 - j, j)),
  );
  log(`      = ${r.ok * 100} sub-calls in ${r.elapsedMs}ms = ${((r.ok * 100) / (r.elapsedMs / 1000)).toFixed(0)} sub-calls/s`);
  if (r.throttled > 0) {
    log(`  → ceiling found at concurrency ${conc}\n`);
    break;
  }
  await Bun.sleep(2000);
}
