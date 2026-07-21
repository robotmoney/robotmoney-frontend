// LIVE-path steady-state smoke assertions (issue #128 — originally closed the
// #101 CI gap in the nightly-only lane; issue #147 later removed DEMO_HERMETIC
// and the hermetic demo path entirely, so this script now runs on EVERY demo
// boot in CI — the required per-PR `e2e` gate AND the nightly
// demo-live-smoke-nightly.yml sweep both invoke it via the same
// scripts/lib/demo-main.ts CI path; no logic is duplicated between them).
//
// WHY THIS EXISTS
// Worker-lane starvation (#101), a dead external feed blocking a factor (#127),
// and LIVE-only provenance drift must not stay invisible while CI is green.
// This script runs after the committee driver + the frontend checks (issue
// #134, already asserts LIVE wallet provenance) + browser checks, while the
// LIVE stack is still up. It asserts the stack reached a healthy LIVE steady
// state:
//
//   (a) committee — >= LIVE_SMOKE_MIN_PUBLISHED_SESSIONS sessions reached state
//       'published' (the #101 single-worker starvation guard). The mcp e2e
//       driver publishes two sessions through the REAL worker job queue
//       (committee lane, per-state deadlines in mcp/src/e2e.ts), so a starved
//       lane already fails the driver; this re-asserts the published rows
//       actually landed and are served.
//   (b) regime — /api/dashboards/regime-snapshots reports staleness.stale ===
//       false: the LIVE analytics run landed a fresh snapshot. A dead feed
//       blocking a factor (the #127 MVRV-404 failure mode) leaves it stale → red.
//   (c) wallet — /api/dashboards/wallet-balances source === 'live' and every
//       holding provenance 'live'. Issue #120 shipped the smart-account NAV fix
//       (idle USDC + maintained-vault-list convertToAssets, both proven wallets
//       not ERC-4626 tokens) so ZYFAI-SS1/GIZA-SS1 now resolve 'live' like any
//       other leg; ALLOWED_STALE_LEGS stays as a documented, loud-logged
//       tolerance in case a transport blip degrades just those two legs, but a
//       'live' steady state no longer routes through it. Any non-live leg
//       outside that allowlist is NEW silent staleness and FAILS, naming the leg.
//   (d) allocation — /api/dashboards/vault-economics source === 'live' and
//       stale === false (the real eth_call reads succeeded).
//   (e) research — both research-signal keys serve a landed signal (a dead
//       research leg → null/404 → red).
//
// NEVER SKIPS: every failure exits non-zero and names the leg/feed that failed.
// LIVE upstreams are eventually consistent right after boot (e.g. the seed's
// cold-start wallet.sample_balances job — the demo's SCHEDULED sampler is
// hourly under DEMO_MODE, per-IP quota protection, so boot freshness
// rides on that one immediate enqueue), so the checks POLL until they all
// pass or the deadline lapses; the deadline derives from the demo's own
// schedule constants (scripts/lib/demo-schedule.ts), not magic numbers.
// DEMO_LIVE_SMOKE_DEADLINE_MS overrides it ONLY so the unit self-test
// (scripts/tests/demo-live-smoke.test.ts) can prove the red paths quickly.
import { ROUTES, path as routePath } from "@robotmoney/contract";
import { COMMITTEE_INTERVAL_MS } from "./lib/demo-schedule.ts";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8787";

/** Starvation guard (#101): the CI driver publishes exactly two sessions. */
export const LIVE_SMOKE_MIN_PUBLISHED_SESSIONS = 2;

/**
 * Documented-allowed stale wallet legs (issue #120, shipped): ZYFAI-SS1 /
 * GIZA-SS1 now value live via smart-account NAV (idle USDC + maintained-vault
 * convertToAssets), so a healthy LIVE boot resolves them 'live' like every
 * other leg. This allowlist remains ONLY as a documented, loud-logged
 * tolerance for a transient degrade of just these two legs; every other leg
 * must be 'live'. Do NOT grow this set to paper over NEW staleness.
 */
export const ALLOWED_STALE_LEGS: ReadonlySet<string> = new Set(["ZYFAI-SS1", "GIZA-SS1"]);

/** Degrade provenances a leg on the allowlist may carry (values never fabricated). */
const ALLOWED_DEGRADES = new Set(["stale", "seed"]);

export const RESEARCH_KEYS = ["channel-divergence", "late-cycle-signals"] as const;

/**
 * Overall poll deadline: two full committee cadences. The driver has already
 * published its sessions by the time this runs, so the budget is really for the
 * eventually-consistent LIVE legs (first successful scheduled wallet sample etc.).
 */
export const LIVE_SMOKE_DEADLINE_MS = 2 * COMMITTEE_INTERVAL_MS;

// ── Pure evaluators ─────────────────────────────────────────────────────────
// Each takes the parsed API payload (null ⇒ the fetch failed / non-2xx) and
// returns failure strings naming the leg/feed. Unit-tested directly in
// scripts/tests/demo-live-smoke.test.ts.

interface SessionRow { state?: string; date?: string; subjectId?: string }
export function evaluateSessions(body: { sessions?: SessionRow[] } | null): string[] {
  if (!body?.sessions) return ["committee: GET /api/committee/sessions returned no session list"];
  const published = body.sessions.filter((s) => s.state === "published");
  if (published.length < LIVE_SMOKE_MIN_PUBLISHED_SESSIONS) {
    return [
      `committee: only ${published.length}/${LIVE_SMOKE_MIN_PUBLISHED_SESSIONS} sessions published ` +
        `(states: ${body.sessions.map((s) => `${s.date}/${s.subjectId}=${s.state}`).join(", ") || "none"}) — ` +
        "worker-committee lane starvation (#101 failure mode) or a lifecycle stall",
    ];
  }
  return [];
}

interface RegimeStalenessDto { asof?: string | null; ageDays?: number | null; stale?: boolean; thresholdDays?: number }
export function evaluateRegime(body: { latest?: unknown; staleness?: RegimeStalenessDto } | null): string[] {
  if (!body) return ["regime: GET /api/dashboards/regime-snapshots failed"];
  const st = body.staleness;
  if (!st) return ["regime: regime-snapshots response carries no staleness object — cannot certify freshness"];
  if (st.stale !== false) {
    return [
      `regime: snapshot is STALE (asof ${st.asof ?? "none"}, age ${st.ageDays ?? "?"}d > ${st.thresholdDays ?? "?"}d) — ` +
        "the LIVE analytics run did not land a fresh snapshot (dead/blocked feed, e.g. the #127 MVRV-404 failure mode)",
    ];
  }
  return [];
}

interface WalletHolding { symbol?: string; provenance?: string }
export function evaluateWallet(
  body: { source?: string; holdings?: WalletHolding[] } | null,
  logDegrade: (msg: string) => void = console.log,
): string[] {
  if (!body) return ["wallet: GET /api/dashboards/wallet-balances failed"];
  const failures: string[] = [];
  if (body.source !== "live") {
    failures.push(`wallet: top-level source is "${body.source}" (expected "live") — the scheduled sampler has not landed a live sample`);
  }
  const holdings = body.holdings ?? [];
  if (holdings.length === 0) failures.push("wallet: no holdings served");
  for (const h of holdings) {
    const sym = h.symbol ?? "?";
    if (h.provenance === "live") continue;
    if (ALLOWED_STALE_LEGS.has(sym) && ALLOWED_DEGRADES.has(h.provenance ?? "")) {
      // Documented-allowed degrade (#120) — tolerated, but never silent.
      logDegrade(`  ! wallet leg ${sym}=${h.provenance} — documented-allowed degrade (issue #120), not a regression`);
      continue;
    }
    failures.push(
      `wallet: leg ${sym} provenance "${h.provenance}" (expected "live") — ` +
        "NEW silent staleness on the LIVE path (not in the #120 documented allowlist)",
    );
  }
  return failures;
}

export function evaluateVaultEconomics(body: { source?: string; stale?: boolean } | null): string[] {
  if (!body) return ["allocation: GET /api/dashboards/vault-economics failed"];
  const failures: string[] = [];
  if (body.source !== "live") {
    failures.push(`allocation: vault-economics source is "${body.source}" (expected "live") — stub provenance on a LIVE boot`);
  }
  if (body.stale !== false) {
    failures.push("allocation: vault-economics is stale — the live Base RPC eth_call reads did not succeed");
  }
  return failures;
}

export function evaluateResearch(
  signals: Record<string, { signalKey?: string } | null>,
): string[] {
  const failures: string[] = [];
  for (const key of RESEARCH_KEYS) {
    const sig = signals[key];
    if (!sig?.signalKey) {
      failures.push(`research: signal "${key}" not served (null/404) — the LIVE research.refresh leg has not landed`);
    }
  }
  return failures;
}

// ── Fetch + poll driver ─────────────────────────────────────────────────────
async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function collectFailures(backend: string): Promise<string[]> {
  const [sessions, regime, wallet, vault, ...research] = await Promise.all([
    getJson(`${backend}${ROUTES.committee.sessions}`),
    getJson(`${backend}${ROUTES.dashboards.regimeSnapshots}?range=1`),
    getJson(`${backend}${ROUTES.dashboards.walletBalances}`),
    getJson(`${backend}${ROUTES.dashboards.vaultEconomics}`),
    ...RESEARCH_KEYS.map((key) => getJson(`${backend}${routePath(ROUTES.dashboards.researchSignal, { key })}`)),
  ]);
  const signals = Object.fromEntries(RESEARCH_KEYS.map((key, i) => [key, research[i] as { signalKey?: string } | null]));
  return [
    ...evaluateSessions(sessions as Parameters<typeof evaluateSessions>[0]),
    ...evaluateRegime(regime as Parameters<typeof evaluateRegime>[0]),
    ...evaluateWallet(wallet as Parameters<typeof evaluateWallet>[0]),
    ...evaluateVaultEconomics(vault as Parameters<typeof evaluateVaultEconomics>[0]),
    ...evaluateResearch(signals),
  ];
}

async function main(): Promise<void> {
  console.log(`\n=== LIVE-path smoke assertions (${BACKEND}) — issue #128 ===\n`);

  const deadlineMs = Number(process.env.DEMO_LIVE_SMOKE_DEADLINE_MS ?? "") || LIVE_SMOKE_DEADLINE_MS;
  const deadline = Date.now() + deadlineMs;
  let failures = await collectFailures(BACKEND);
  while (failures.length > 0 && Date.now() < deadline) {
    console.log(`  … ${failures.length} check(s) not yet green, retrying (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    await new Promise((r) => setTimeout(r, 5_000));
    failures = await collectFailures(BACKEND);
  }

  if (failures.length > 0) {
    console.error(`\n✗ LIVE smoke FAILED after ${Math.round(deadlineMs / 1000)}s — the LIVE steady state was not reached:\n`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(
    `\n✓ LIVE smoke passed: >=${LIVE_SMOKE_MIN_PUBLISHED_SESSIONS} committee sessions published, ` +
      "regime snapshot fresh, wallet + vault-economics provenance live " +
      `(allowed #120 degrades logged above), research signals ${RESEARCH_KEYS.join(" + ")} served.\n`,
  );
}

// Import-safe (the unit test imports the evaluators without running the driver).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("demo-live-smoke error:", e);
    process.exit(1);
  });
}
