// The cumulative standing soak checks (runbook IDs R8.a to R8.y), as PURE decisions. No IO.
//
// WHY THIS EXISTS. `backend/scripts/upgrades/0.5.3-to-0.5.4/soak-checks.sh` ran these read-only
// invariants beside `twin:gate` and `prod:gate` at every 0.5.x gate. It never reached main, so the
// 0.6 line had no tool for standing-runbook rows SR.7 and SW.2 (issue 1179). The facts are read by
// scripts/standing-soak.ts (through the api container, container logs and `docker inspect`); this
// file only grades them, so every check can be driven red by a fixture that violates it
// (scripts/tests/unit/standing-soak.test.ts).
//
// RULE. The checks are cumulative: a release adds checks and never drops one without a recorded
// owner decision (docs/runbooks/release-standing-runbook.md section 6).
//
// Exit rule for every check: a WARN is not a pass, and a check with nothing to assert is
// unverified (WARN or FAIL), never PASS.

export type StandingStatus = "PASS" | "FAIL" | "WARN" | "INFO";
export interface StandingCheck { id: string; title: string; status: StandingStatus; detail: string[] }

import { PINNED_JUDGE_MODEL } from "../../../backend/src/swarm/judge-model-policy.ts";

const mk = (id: string, title: string, status: StandingStatus, ...detail: string[]): StandingCheck => ({ id, title, status, detail });

// ── cadence (R8.a, R8.b) ────────────────────────────────────────────────────────

function parseField(f: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of f.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) return null;
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      const [a, b] = m[1]!.split("-");
      lo = Number(a);
      hi = b === undefined ? (m[2] === undefined ? lo : max) : Number(b);
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((x, y) => x - y);
}

/**
 * PURE. The UTC instants (epoch seconds) a five-field cron fires at inside [fromMs, toMs].
 * Supports lists, ranges and steps in the minute and hour fields. Day, month and weekday must be `*`
 * (the producer's crons are daily or every N hours). Anything else returns null, which the caller
 * reports as unverified, never as a pass.
 */
export function expandCronSlots(cron: string, fromMs: number, toMs: number, maxDays = 31): number[] | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5 || f[2] !== "*" || f[3] !== "*" || f[4] !== "*") return null;
  const minutes = parseField(f[0]!, 0, 59);
  const hours = parseField(f[1]!, 0, 23);
  if (!minutes || !hours) return null;
  const out: number[] = [];
  const day0 = Date.UTC(new Date(fromMs).getUTCFullYear(), new Date(fromMs).getUTCMonth(), new Date(fromMs).getUTCDate());
  for (let d = 0; d <= maxDays; d++) {
    const dayStart = day0 + d * 86_400_000;
    if (dayStart > toMs) break;
    for (const h of hours) for (const m of minutes) {
      const t = dayStart + h * 3_600_000 + m * 60_000;
      if (t >= fromMs && t <= toMs) out.push(t / 1000);
    }
  }
  return out;
}

/** R8.a / R8.b. Every cron slot that has elapsed (plus a 20 min grace) produced its output artifact. */
export function evalCadence(id: string, title: string, cron: string, slots: number[] | null, produced: ReadonlyMap<number, number>): StandingCheck {
  if (slots === null) return mk(id, title, "WARN", `cron "${cron}" cannot be expanded here (only minute/hour lists, ranges and steps): UNVERIFIED`);
  if (slots.length === 0) return mk(id, title, "INFO", `no scheduled slot of "${cron}" has elapsed since T0 yet`);
  const missing = slots.filter((s) => !((produced.get(s) ?? 0) >= 1));
  const ok = slots.length - missing.length;
  if (missing.length === 0) return mk(id, title, "PASS", `${ok} of ${slots.length} scheduled runs (cron "${cron}") produced their output`);
  return mk(id, title, "FAIL", `${ok} of ${slots.length} scheduled runs (cron "${cron}") produced output; missing slots (UTC): ${missing.map((s) => new Date(s * 1000).toISOString().slice(0, 16)).join(", ")}`);
}

export const PRODUCER_FAILURE = /(regime|research) failed|analytics-producer\] fatal:|catch-up for .* failed|day-roll regime .* failed/;

/** R8.c. No producer failure line since T0. */
export function evalProducerFailures(lines: readonly string[] | null): StandingCheck {
  const title = "producer failure lines since T0";
  if (lines === null) return mk("R8.c", title, "WARN", "no analytics-producer container: UNVERIFIED");
  const n = lines.filter((l) => PRODUCER_FAILURE.test(l)).length;
  return n === 0 ? mk("R8.c", title, "PASS", "0") : mk("R8.c", title, "FAIL", `${n} (regime/research failed, fatal, day-roll, or catch-up failed)`);
}

// ── ledger and data (R8.d, R8.e, R8.f, R8.k, R8.l) ──────────────────────────────

/** R8.d. Database growth stays inside 100 MB per started 6 h since the recorded baseline. */
export function evalGrowth(sizeMb: number, baseMb: number | null, hours: number): StandingCheck {
  const title = "database size";
  if (baseMb === null) return mk("R8.d", title, "WARN", `${sizeMb} MB, but no baseline is recorded (run once with --record): growth UNVERIFIED`);
  const grow = sizeMb - baseMb;
  const allow = 100 * (Math.floor(hours / 6) + 1);
  const d = `${sizeMb} MB (${grow >= 0 ? "+" : ""}${grow} MB since the baseline ${baseMb} MB; limit ${allow} MB)`;
  return grow <= allow ? mk("R8.d", title, "PASS", d) : mk("R8.d", title, "FAIL", d);
}

/** R8.e. Writers record only real changes: no `unchanged` rows and no noise-only revisions since T0. */
export function evalLedgerNoise(r: { n: number; unchanged: number; noise: number } | undefined): StandingCheck {
  const title = "ledger versions written since T0";
  if (!r) return mk("R8.e", title, "FAIL", "the query returned no row");
  const d = `${r.n} rows; unchanged=${r.unchanged} noise-only=${r.noise}`;
  return r.unchanged === 0 && r.noise === 0 ? mk("R8.e", title, "PASS", d) : mk("R8.e", title, "FAIL", d);
}

export const PARITY_P50_BASELINE_S = 126;
export const API_STATEMENT_TIMEOUT_S = 300;

/** R8.f. Parity sweeps: none dead, longest under the api statement timeout, p50 at or under the baseline. */
export function evalParity(r: { ok: number; dead: number; p50: number; max: number } | undefined): StandingCheck {
  const title = "parity sweeps";
  if (!r) return mk("R8.f", title, "FAIL", "the query returned no row");
  if (r.dead !== 0) return mk("R8.f", title, "FAIL", `${r.dead} dead, ${r.ok} succeeded`);
  if (r.max > API_STATEMENT_TIMEOUT_S) return mk("R8.f", title, "FAIL", `max duration ${r.max}s exceeds the api's ${API_STATEMENT_TIMEOUT_S}s statement timeout`);
  if (r.p50 > PARITY_P50_BASELINE_S) return mk("R8.f", title, "WARN", `${r.ok} succeeded, p50 ${r.p50}s is above the baseline ${PARITY_P50_BASELINE_S} s`);
  return mk("R8.f", title, "PASS", `${r.ok} succeeded, 0 dead, p50 ${r.p50}s, max ${r.max}s (baseline p50 ${PARITY_P50_BASELINE_S} s)`);
}

export const LEDGER_GUARDS = [
  "source_value_versions_immutable", "source_value_versions_immutable_row",
  "analytics_vintage_members_immutable", "analytics_vintage_members_immutable_row",
  "analytics_overwrite_events_append_only", "analytics_overwrite_events_append_only_row",
  "analytics_overwrite_events_immutable", "analytics_overwrite_events_immutable_row",
  "raw_indicator_history_capture_overwrite",
  "analytics_data_vintages_immutable", "analytics_data_vintages_immutable_row",
] as const;

/** R8.k. Every ledger guard trigger exists and is ENABLE ALWAYS (`tgenabled = 'A'`). */
export function evalGuards(r: { found: number; armed: number } | undefined): StandingCheck {
  const title = "ledger guards";
  const want = LEDGER_GUARDS.length;
  if (!r) return mk("R8.k", title, "FAIL", "the query returned no row");
  return r.found === want && r.armed === want ? mk("R8.k", title, "PASS", `${want} of ${want} triggers ENABLE ALWAYS`) : mk("R8.k", title, "FAIL", `${r.armed} armed of ${r.found} found (expected ${want} of ${want})`);
}

/** R8.k2. The old raw payload table stays gone (issue 1035). */
export function evalPayloadsGone(reg: string | undefined): StandingCheck {
  return reg === "absent" ? mk("R8.k2", "source_payloads", "PASS", "absent") : mk("R8.k2", "source_payloads", "FAIL", `present or unreadable: ${reg ?? "no row"}`);
}

/** R8.l. The newest vintage's run lengths add up to its member_count; at --full the id join must resolve every id too. */
export function evalVintage(r: { id: number; memberCount: number; covered: number } | undefined, resolved: number | null, full: boolean): StandingCheck {
  const title = "newest vintage integrity";
  if (!r || ![r.id, r.memberCount, r.covered].every(Number.isFinite)) return mk("R8.l", title, "FAIL", "the newest vintage could not be read");
  if (r.memberCount !== r.covered) return mk("R8.l", title, "FAIL", `vintage ${r.id}: member_count ${r.memberCount} but its runs cover ${r.covered} ids`);
  if (!full) return mk("R8.l", title, "PASS", `vintage ${r.id}: runs add up to ${r.covered} = member_count (the full id join runs with --full)`);
  if (resolved === null || !Number.isFinite(resolved)) return mk("R8.l", title, "FAIL", "the full id join could not be read");
  return resolved === r.memberCount
    ? mk("R8.l", title, "PASS", `vintage ${r.id}: all ${resolved} ids resolve under their key = member_count`)
    : mk("R8.l", title, "FAIL", `vintage ${r.id}: member_count ${r.memberCount}, only ${resolved} ids resolve under their key`);
}

// ── sessions (R8.h, R8.i, R8.j, R8.q, R8.t) ─────────────────────────────────────

/** R8.h. The quorum of every session published since T0 counts the active analysts, never the judge. */
export function evalQuorum(r: { published: number; badQuorum: number } | undefined, active: number): StandingCheck {
  const title = "quorum vs analysts";
  if (!r) return mk("R8.h", title, "FAIL", "the query returned no row");
  if (r.published === 0) return mk("R8.h", title, "INFO", `no session published since T0 yet (${active} active analysts)`);
  return r.badQuorum === 0 ? mk("R8.h", title, "PASS", `${r.published} published session(s) show quorum = ${active} active analysts`) : mk("R8.h", title, "FAIL", `${r.badQuorum} of ${r.published} published session(s) have quorum <> ${active}`);
}

/** R8.i. Every session published since T0 has takes, a judgement and a receipt. */
export function evalSessionsComplete(r: { published: number; noTakes: number; noJudgement: number; noReceipt: number } | undefined): StandingCheck {
  const title = "published sessions complete";
  if (!r) return mk("R8.i", title, "FAIL", "the query returned no row");
  if (r.published === 0) return mk("R8.i", title, "INFO", "none published since T0 yet");
  return r.noTakes + r.noJudgement + r.noReceipt === 0
    ? mk("R8.i", title, "PASS", `all ${r.published} have takes, a judgement and a receipt`)
    : mk("R8.i", title, "FAIL", `of ${r.published}: ${r.noTakes} without takes, ${r.noJudgement} without a judgement, ${r.noReceipt} without a receipt`);
}

/** R8.j. No session is still open past its window plus a 30 min grace. */
export function evalWedged(n: number | undefined): StandingCheck {
  const title = "no wedged session";
  if (n === undefined || !Number.isFinite(n)) return mk("R8.j", title, "FAIL", "the query returned no row");
  return n === 0 ? mk("R8.j", title, "PASS", "0 open past their window + 30 min") : mk("R8.j", title, "FAIL", `${n} open past their window + 30 min`);
}

/** The judge model the code pins: the backend's own constant, so the check can never drift from it. */
export { PINNED_JUDGE_MODEL };
/** Ids production held before migration 0111 renamed the model. Valid only until that migration applies. */
export const LEGACY_JUDGE_MODELS: readonly string[] = ["deepseek-v4-flash"];
/** True for a pre-0111 id, with or without the provider prefix production used to store. */
export const isLegacyJudgeModel = (model: string): boolean => LEGACY_JUDGE_MODELS.includes(model.replace(/^opencode\//, ""));

/** R8.q. Judge config: enforce, the pinned model, third parties off. */
export function evalJudgeConfig(r: { mode: string; model: string | null; thirdParty: boolean } | undefined): StandingCheck {
  const title = "judge config";
  if (!r) return mk("R8.q", title, "FAIL", "swarm_judge_config has no row");
  const d = `mode=${r.mode} model=${r.model ?? "NULL"} third_party_enabled=${r.thirdParty}`;
  if (r.mode !== "enforce" || r.thirdParty || r.model === null) return mk("R8.q", title, "FAIL", d, "expected enforce, the pinned model, third_party_enabled false");
  if (r.model === PINNED_JUDGE_MODEL) return mk("R8.q", title, "PASS", d);
  if (isLegacyJudgeModel(r.model)) return mk("R8.q", title, "WARN", d, `a pre-0111 model id: valid only until migration 0111 renames it to ${PINNED_JUDGE_MODEL}`);
  return mk("R8.q", title, "FAIL", d, `not the pinned model ${PINNED_JUDGE_MODEL}`);
}

/** R8.t. Every published session dated on or after `fromDate` carries `openedAt`. `sessions` null means the route was unreadable. */
export function evalOpenedAt(sessions: ReadonlyArray<{ state?: string; openedAt?: string | null; date?: string }> | null, fromDate: string): StandingCheck {
  const title = "openedAt";
  if (sessions === null) return mk("R8.t", title, "FAIL", "/api/swarm/sessions could not be read");
  const missing = sessions.filter((s) => s.state === "published" && !s.openedAt && (s.date ?? "") >= fromDate).length;
  return missing === 0
    ? mk("R8.t", title, "PASS", `0 of the ${sessions.length} newest sessions dated ${fromDate} or later lack it (older sessions have no brief revision to read)`)
    : mk("R8.t", title, "FAIL", `${missing} published session(s) dated ${fromDate} or later lack openedAt`);
}

// ── host, database health, grants, schema (R8.m, R8.n, R8.p, R8.r, R8.s) ────────

/** R8.m. No connection-pool starvation: sessions idle in a transaction over 60 s. Counts only the sessions this role can see. */
export function evalConnections(r: { idleInTx: number; total: number; visible: number } | undefined): StandingCheck {
  const title = "connections";
  if (!r) return mk("R8.m", title, "FAIL", "the query returned no row");
  const scope = `${r.visible} of ${r.total} open session(s) are visible to the api's role (pg_stat_activity hides the rest)`;
  return r.idleInTx === 0 ? mk("R8.m", title, "PASS", `0 idle in a transaction over 60 s; ${scope}`) : mk("R8.m", title, "FAIL", `${r.idleInTx} idle in a transaction over 60 s; ${scope}`);
}

/** R8.n. Host disk: 5 GB passes, 3 GB warns, less fails. */
export function evalDisk(freeGb: number | null): StandingCheck {
  const title = "host disk free";
  if (freeGb === null || !Number.isFinite(freeGb)) return mk("R8.n", title, "FAIL", "df could not be read");
  const d = `${freeGb} GB`;
  return freeGb >= 5 ? mk("R8.n", title, "PASS", d) : freeGb >= 3 ? mk("R8.n", title, "WARN", d) : mk("R8.n", title, "FAIL", d);
}

/** R8.p. schema_migrations equals the baseline recorded at READY (this release's migrations are in it, so any drift is a surprise). */
export function evalMigrations(base: readonly string[] | null, now: readonly string[]): StandingCheck {
  const title = "schema_migrations";
  if (base === null || base.length === 0) return mk("R8.p", title, "FAIL", "no baseline recorded (run once with --record, at READY)");
  const a = new Set(base);
  const b = new Set(now);
  const removed = base.filter((x) => !b.has(x));
  const added = now.filter((x) => !a.has(x));
  if (removed.length === 0 && added.length === 0) return mk("R8.p", title, "PASS", `${now.length} rows, identical to the baseline`);
  return mk("R8.p", title, "FAIL", `differs from the baseline: ${added.length} added${added.length ? ` (${added.slice(0, 5).join(", ")})` : ""}, ${removed.length} removed${removed.length ? ` (${removed.slice(0, 5).join(", ")})` : ""}`);
}

export const CHAIN_STATE_TABLES = ["wallet_backfill_state", "chain_day_blocks", "chain_address_floors"] as const;

/**
 * R8.r. Role and grant integrity: rm_worker INSERTs on the chain-state tables, the api connects as
 * rm_app (never a superuser), rm_readonly reads every public sequence. A twin holds no grants (its
 * dump is taken with --no-privileges), so it is not graded there.
 */
export function evalGrants(dbMode: string, r: { workerInsert: boolean | null; currentUser: string | null; readonlySeq: boolean | null } | undefined): StandingCheck[] {
  if (dbMode !== "external") return [mk("R8.r", "grants", "INFO", `not checked on a ${dbMode} stack: a restored dump carries no grants. Production is checked at SP.3 and SV.5`)];
  if (!r) return [mk("R8.r", "grants", "FAIL", "the query returned no row")];
  return [
    r.workerInsert === true ? mk("R8.r", "rm_worker grants", "PASS", `INSERT on the ${CHAIN_STATE_TABLES.length} chain-state tables`) : mk("R8.r", "rm_worker grants", "FAIL", `rm_worker lacks INSERT on a chain-state table (${String(r.workerInsert)})`),
    r.currentUser === "rm_app" ? mk("R8.r", "api role", "PASS", "rm_app (never doadmin)") : mk("R8.r", "api role", "FAIL", `the api connects as ${r.currentUser ?? "?"}, expected rm_app`),
    r.readonlySeq === true ? mk("R8.r", "rm_readonly sequences", "PASS", "SELECT on every public sequence") : mk("R8.r", "rm_readonly sequences", "FAIL", String(r.readonlySeq)),
  ];
}

/** R8.s. /health (or /api/health) and the newest published session's judgements route answer 200. */
export function evalHealth(h: number | null, h2: number | null, judgements: number | null): StandingCheck {
  const title = "health and judgements";
  const d = `/health ${h ?? "unreachable"}, /api/health ${h2 ?? "unreachable"}, judgements ${judgements ?? "not probed (no published session)"}`;
  if (judgements === null) return mk("R8.s", title, "WARN", d, "UNVERIFIED: no published session to probe");
  return (h === 200 || h2 === 200) && judgements === 200 ? mk("R8.s", title, "PASS", d) : mk("R8.s", title, "FAIL", d);
}

// ── logs (R8.g, R8.u, R8.v, R8.w, R8.x, R8.o) ───────────────────────────────────

/** R8.g. Website server errors: 0 passes, up to 10 warns. */
export function evalWebsite(lines: readonly string[] | null): StandingCheck {
  const title = "website 5xx and [error] since T0";
  if (lines === null) return mk("R8.g", title, "WARN", "no website-server container: UNVERIFIED");
  const n5 = lines.filter((l) => /" 5\d\d /.test(l)).length;
  const ne = lines.filter((l) => l.includes("[error]")).length;
  const d = `5xx=${n5} [error]=${ne}`;
  return n5 === 0 && ne === 0 ? mk("R8.g", title, "PASS", "0") : n5 <= 10 ? mk("R8.g", title, "WARN", d) : mk("R8.g", title, "FAIL", d);
}

/** R8.u / R8.u2. The api: no cut-off at the request limit, and every slow request is listed. */
export function evalApiLogs(lines: readonly string[] | null): StandingCheck[] {
  if (lines === null) return [mk("R8.u", "api cut-offs", "WARN", "no api container: UNVERIFIED")];
  const to = lines.filter((l) => l.includes("timed out after")).length;
  const slow = lines.filter((l) => l.includes("[api] slow request"));
  const past = lines.filter((l) => l.includes("[api] request ran past"));
  const out: StandingCheck[] = [to === 0 ? mk("R8.u", "api cut-offs", "PASS", "0 'timed out after'") : mk("R8.u", "api cut-offs", "FAIL", `${to} 'timed out after' line(s)`)];
  if (slow.length + past.length === 0) out.push(mk("R8.u2", "api slow requests", "PASS", "0 over 5 s"));
  else {
    const paths = new Map<string, number>();
    for (const l of [...slow, ...past]) { const m = /(GET|POST|PUT|PATCH|DELETE) \/[^ ]+/.exec(l); if (m) paths.set(m[0], (paths.get(m[0]) ?? 0) + 1); }
    const top = [...paths].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([p, n]) => `${n} ${p}`).join("; ");
    out.push(mk("R8.u2", "api slow requests", "WARN", `${slow.length} slow (over 5 s), ${past.length} ran past the limit; paths: ${top}`));
  }
  return out;
}

/** R8.v. The buyback scan never fails on a refused range (a 413 is halved, never a failure). */
export function evalBuyback(lines: readonly string[] | null): StandingCheck {
  const title = "buyback";
  if (lines === null) return mk("R8.v", title, "WARN", "no worker container: UNVERIFIED");
  const bad = lines.filter((l) => l.includes("live index failed")).length;
  const b413 = lines.filter((l) => l.includes("HTTP 413")).length;
  return bad === 0 ? mk("R8.v", title, "PASS", `0 'live index failed' (${b413} HTTP 413 answers, each halved)`) : mk("R8.v", title, "FAIL", `${bad} 'live index failed'`);
}

/** R8.w, R8.w2, R8.w3. Gecko: the tier matches the key, no 429/401/403, and the key is in no ledger row or api/website environment. */
export function evalGecko(i: { hasKey: boolean | null; geckoLines: readonly string[] | null; unredactedLedgerRows: number | undefined; keyEnvHits: number | null }): StandingCheck[] {
  const out: StandingCheck[] = [];
  const tier = "gecko tier";
  if (i.geckoLines === null || i.hasKey === null) out.push(mk("R8.w", tier, "WARN", "no worker or producer container to read: UNVERIFIED"));
  else {
    const pro = i.geckoLines.filter((l) => l.includes("[gecko]") && l.includes("pro tier")).length;
    const free = i.geckoLines.filter((l) => l.includes("[gecko]") && l.includes("free tier")).length;
    if (i.hasKey && pro + free === 0) out.push(mk("R8.w", tier, "INFO", "key set; no [gecko] line yet (a worker or the producer logs one when its sweep runs)"));
    else if (i.hasKey) out.push(pro >= 1 && free === 0 ? mk("R8.w", tier, "PASS", `key set: ${pro} line(s) via the pro tier, 0 via free`) : mk("R8.w", tier, "FAIL", `key set but pro=${pro} free=${free}`));
    else out.push(pro === 0 ? mk("R8.w", tier, "PASS", `no key: ${free} line(s) via the free tier`) : mk("R8.w", tier, "FAIL", `no key set but ${pro} line(s) via pro`));
  }
  const rej = (i.geckoLines ?? []).filter((l) => /answered HTTP 40[13]|Gecko.*HTTP 429|\[gecko\].*429/.test(l)).length;
  out.push(i.geckoLines === null ? mk("R8.w2", "gecko errors", "WARN", "no logs: UNVERIFIED") : rej === 0 ? mk("R8.w2", "gecko errors", "PASS", "0 lines of HTTP 429/401/403") : mk("R8.w2", "gecko errors", "FAIL", `${rej} lines of HTTP 429/401/403`));
  const kl = i.unredactedLedgerRows;
  if (kl === undefined || i.keyEnvHits === null) out.push(mk("R8.w3", "key containment", "FAIL", "the ledger or the container environment could not be read"));
  else out.push(kl === 0 && i.keyEnvHits === 0 ? mk("R8.w3", "key containment", "PASS", "0 unredacted ledger rows; 0 COINGECKO variables in the api and the website") : mk("R8.w3", "key containment", "FAIL", `ledger rows=${kl} api+website vars=${i.keyEnvHits}`));
  return out;
}

/**
 * R8.x. The regime day (issue 1058, 1108): every `regime asof D` line names the UTC day it was written.
 * Main logs that line from the analytics-producer container (the 0.5.x driver no longer exists), so each
 * line is compared with its own Docker timestamp.
 */
export function evalRegimeDay(lines: ReadonlyArray<{ ts: string | null; text: string }> | null, hoursSinceT0: number): StandingCheck {
  const title = "regime day";
  if (lines === null) return mk("R8.x", title, "WARN", "no analytics-producer container: UNVERIFIED");
  const regime = lines.filter((l) => /regime asof \d{4}-\d{2}-\d{2}/.test(l.text));
  if (regime.length === 0) return hoursSinceT0 >= 24 ? mk("R8.x", title, "WARN", "no `regime asof` line in 24 h or more: UNVERIFIED") : mk("R8.x", title, "INFO", "no regime line yet");
  const bad = regime.filter((l) => {
    const day = /regime asof (\d{4}-\d{2}-\d{2})/.exec(l.text)![1]!;
    return l.ts === null || l.ts.slice(0, 10) !== day;
  });
  return bad.length === 0
    ? mk("R8.x", title, "PASS", `${regime.length} regime line(s), each dated the UTC day it was written`)
    : mk("R8.x", title, "FAIL", `${bad.length} of ${regime.length} regime line(s) name a day other than the UTC day they were written (${bad[0]!.text.slice(0, 80)})`);
}

/** R8.o. Informational: error-like lines per container since T0 (the gates classify them; this is the raw count). */
export function evalErrorLike(perContainer: ReadonlyMap<string, readonly string[]>): StandingCheck[] {
  return [...perContainer].map(([name, lines]) =>
    mk("R8.o", name, "INFO", `${lines.filter((l) => !l.includes("RM_TELEMETRY") && /error|fatal|refus|denied|timed out|exception|panic/i.test(l)).length} error-like lines since T0`));
}

/** A fact that could not be read is a failure of the check that needed it, never a pass. */
export function unreadable(id: string, title: string, err: unknown): StandingCheck {
  return mk(id, title, "FAIL", `query could not be read: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
}

export function verdict(checks: readonly StandingCheck[]): { fails: number; warns: number } {
  return { fails: checks.filter((c) => c.status === "FAIL").length, warns: checks.filter((c) => c.status === "WARN").length };
}
