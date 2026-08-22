// Live benchmark for JSON-RPC array batching against the public Base endpoint.
//
// Three questions, in order:
//   1. CORRECTNESS — does a batched read return exactly what N single reads do?
//   2. CAPACITY    — how many calls will one POST actually carry?
//   3. METERING    — the decisive one. Does the provider count a batch as ONE
//                    hit or as N sub-requests? Everything about whether this is
//                    a 40x win or a round-trip saving hangs on the answer.
//
// Phase 3 deliberately provokes 429s. It is bounded (MAX_PROBES per phase) and
// runs with the app's own limiter DISABLED, because the point is to measure the
// PROVIDER's ceiling, not ours.
import {
  rpcBatchRequest,
  ethGetBlockByNumberBatch,
  ethBlockNumber,
  ethGetBlockByNumber,
  _resetRpcRateLimiterForTests,
} from "../src/chain/base-rpc-client.ts";

const RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const OK = { rpcUrl: RPC, timeoutMs: 20_000 };
const MAX_PROBES = 80;
const log = (m: string) => console.log(m);

process.env.BASE_RPC_MAX_CALLS_PER_SEC = "0"; // measure THEIR limit, not ours
process.env.BASE_RPC_MAX_RETRIES = "0"; // never let a retry hide a 429
_resetRpcRateLimiterForTests();

// Raw POST, bypassing the transport entirely: phase 2/3 must observe the
// provider's raw answer with no retry, no pacing, no per-entry normalising.
async function rawPost(payload: unknown): Promise<{ status: number; body: string }> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "robotmoney-rmpc/1.0" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.text()).slice(0, 200) };
}

const blockCall = (n: number, id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "eth_getBlockByNumber",
  params: ["0x" + n.toString(16), false],
});

// Did this response carry a rate-limit signal, at either level?
function isThrottled(status: number, body: string): boolean {
  if (status === 429) return true;
  return body.includes("-32016") || body.toLowerCase().includes("over rate limit");
}

async function phase1Correctness(head: number): Promise<void> {
  log("\n=== PHASE 1 — correctness: batched vs single ===");
  const nums = Array.from({ length: 8 }, (_, i) => head - 43_200 * (i + 1));

  const singles: string[] = [];
  for (const n of nums) {
    const b = await ethGetBlockByNumber(n, OK);
    singles.push(`${parseInt(b.number, 16)}@${parseInt(b.timestamp, 16)}`);
  }

  const batched = (await ethGetBlockByNumberBatch(nums, OK)).map((r) =>
    r.ok ? `${parseInt(r.result.number, 16)}@${parseInt(r.result.timestamp, 16)}` : `ERR:${r.error.message}`,
  );

  const identical = JSON.stringify(singles) === JSON.stringify(batched);
  log(`  ${nums.length} blocks, ${singles.length} single POSTs vs 1 batched POST`);
  log(`  identical: ${identical ? "YES" : "NO"}`);
  if (!identical) {
    log(`  single : ${JSON.stringify(singles)}`);
    log(`  batched: ${JSON.stringify(batched)}`);
  }
  log(`  sample : ${batched[0]}`);
}

async function phase2Capacity(head: number): Promise<void> {
  log("\n=== PHASE 2 — capacity: how big can one POST be? ===");
  for (const size of [10, 50, 100, 250, 500, 1000]) {
    const payload = Array.from({ length: size }, (_, i) => blockCall(head - i, i));
    try {
      const { status, body } = await rawPost(payload);
      let n = -1;
      try {
        const parsed = JSON.parse(body.startsWith("[") ? body + (body.endsWith("]") ? "" : "]") : body);
        n = Array.isArray(parsed) ? parsed.length : -1;
      } catch {
        /* truncated body — only the status matters below */
      }
      const throttled = isThrottled(status, body);
      log(`  size ${String(size).padStart(4)}: HTTP ${status}${throttled ? " THROTTLED" : ""}${n >= 0 ? ` (parsed ${n})` : ""} ${status !== 200 ? body.slice(0, 80) : ""}`);
      if (status !== 200) break;
    } catch (e) {
      log(`  size ${String(size).padStart(4)}: threw — ${e instanceof Error ? e.message : String(e)}`);
      break;
    }
    await Bun.sleep(1500); // let the bucket recover between capacity probes
  }
}

// Fire `n` requests as fast as possible; report how many landed before the
// first throttle. `make(i)` builds each payload.
async function burst(
  label: string,
  n: number,
  make: (i: number) => unknown,
): Promise<{ ok: number; firstThrottleAt: number | null; elapsedMs: number }> {
  const started = Date.now();
  let ok = 0;
  let firstThrottleAt: number | null = null;
  for (let i = 0; i < n; i++) {
    const { status, body } = await rawPost(make(i));
    if (isThrottled(status, body)) {
      firstThrottleAt = i + 1;
      break;
    }
    if (status === 200) ok++;
    else {
      log(`  ${label}: unexpected HTTP ${status} at #${i + 1} — ${body.slice(0, 80)}`);
      break;
    }
  }
  return { ok, firstThrottleAt, elapsedMs: Date.now() - started };
}

async function phase3Metering(head: number): Promise<void> {
  log("\n=== PHASE 3 — metering: is a batch 1 hit or N sub-requests? ===");
  const B = 25; // sub-calls per batched POST

  log(`  (a) SINGLE calls, unpaced, until throttled (max ${MAX_PROBES})...`);
  const single = await burst("single", MAX_PROBES, (i) => blockCall(head - i, 1));
  log(
    `      landed ${single.ok} POSTs (= ${single.ok} sub-calls) in ${single.elapsedMs}ms` +
      `${single.firstThrottleAt ? `, first throttle at POST #${single.firstThrottleAt}` : ", never throttled"}`,
  );

  log(`  cooling down 30s for the bucket to refill...`);
  await Bun.sleep(30_000);

  log(`  (b) BATCHED POSTs of ${B}, unpaced, until throttled (max ${MAX_PROBES})...`);
  const batched = await burst("batched", MAX_PROBES, (i) =>
    Array.from({ length: B }, (_, j) => blockCall(head - i * B - j, j)),
  );
  log(
    `      landed ${batched.ok} POSTs (= ${batched.ok * B} sub-calls) in ${batched.elapsedMs}ms` +
      `${batched.firstThrottleAt ? `, first throttle at POST #${batched.firstThrottleAt}` : ", never throttled"}`,
  );

  log("\n  VERDICT:");
  if (single.firstThrottleAt === null && batched.firstThrottleAt === null) {
    log(`    Neither burst hit a limit within ${MAX_PROBES} requests — the ceiling is above this probe.`);
    log(`    Throughput: single ${(single.ok / (single.elapsedMs / 1000)).toFixed(1)} sub-calls/s vs ` +
        `batched ${((batched.ok * B) / (batched.elapsedMs / 1000)).toFixed(1)} sub-calls/s.`);
    return;
  }
  const singleSubcalls = single.firstThrottleAt ?? single.ok;
  const batchedSubcalls = (batched.firstThrottleAt ?? batched.ok) * B;
  const batchedPosts = batched.firstThrottleAt ?? batched.ok;
  log(`    sub-calls before throttle: single ${singleSubcalls} vs batched ${batchedSubcalls}`);
  log(`    POSTs      before throttle: single ${singleSubcalls} vs batched ${batchedPosts}`);
  if (batchedSubcalls > singleSubcalls * 2) {
    log(`    → METERED PER HIT. A batch of ${B} costs ~1. Batching is worth ~${(batchedSubcalls / singleSubcalls).toFixed(1)}x.`);
  } else if (Math.abs(batchedSubcalls - singleSubcalls) / singleSubcalls < 0.5) {
    log(`    → METERED PER SUB-REQUEST. Batching saves round trips only, not budget.`);
  } else {
    log(`    → INCONCLUSIVE / partial weighting. Re-run; the bucket may not have fully refilled.`);
  }
}

const head = await ethBlockNumber(OK);
log(`head block: ${head}  endpoint: ${RPC}`);
await phase1Correctness(head);
await phase2Capacity(head);
await phase3Metering(head);
