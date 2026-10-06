// The cumulative standing soak checks (scripts/standing-soak.ts, scripts/lib/gate/standing.ts), issue 1179.
//
// Every ported check has a RED CONTROL: a fixture that violates it and must turn that check's id FAIL
// (or WARN where the 0.5.x script only ever warned). A healthy fixture must produce no FAIL, so a
// check that can never fail cannot hide behind a green run.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHAIN_STATE_TABLES, LEDGER_GUARDS, LEGACY_JUDGE_MODELS, PINNED_JUDGE_MODEL, evalApiLogs, evalBuyback, evalCadence, evalConnections, evalDisk, evalErrorLike,
  evalGecko, evalGrants, evalGrowth, evalGuards, evalHealth, evalJudgeConfig, evalLedgerNoise, evalMigrations, evalOpenedAt, evalParity, evalPayloadsGone,
  evalProducerFailures, evalQuorum, evalRegimeDay, evalSessionsComplete, evalVintage, evalWebsite, evalWedged, expandCronSlots, unreadable, verdict,
  type StandingCheck,
} from "../../lib/gate/standing.ts";
import { DEFAULT_REGIME_CRON, DEFAULT_RESEARCH_CRON, parseSoakArgs, renderSoakReport, runStandingChecks, serviceOf, type StandingIo, type StandingOpts } from "../../standing-soak.ts";

const root = join(import.meta.dir, "../../..");
const status = (c: StandingCheck[], id: string): string[] => c.filter((x) => x.id === id).map((x) => x.status);

// ── a fake stack ────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-10-06T12:00:00Z");
const SINCE = "2026-10-05T12:00:00Z";
type Line = { ts: string | null; text: string };

interface Facts {
  regimeCron: string | undefined;
  producedSlot: (ts: number) => number;
  sizeMb: number;
  migrations: string[];
  noise: { n: number; unchanged: number; noise: number };
  parity: { ok: number; dead: number; p50: number; max: number };
  active: number;
  quorum: { published: number; bad_quorum: number };
  complete: { published: number; no_takes: number; no_judgement: number; no_receipt: number };
  wedged: number;
  guards: { found: number; armed: number };
  payloads: string;
  vintage: { id: string; member_count: string; covered: string } | null;
  resolved: string;
  conn: { idle_in_tx: number; total: number; visible: number };
  judge: { mode: string; model: string | null; third_party: boolean };
  grants: { worker_insert: boolean; who: string; readonly_seq: boolean };
  sessionId: string | null;
  ledgerKeyRows: number;
  disk: number | null;
  http: Record<string, number | null>;
  sessions: Array<{ state: string; openedAt: string | null; date: string }>;
  logs: Record<string, Line[]>;
  env: Record<string, Record<string, string> | null>;
  throwOn: string | null;
}

const L = (text: string, ts = "2026-10-06T01:00:00.000Z"): Line => ({ ts, text });

function healthy(): Facts {
  return {
    regimeCron: "30 */3 * * *",
    producedSlot: () => 1,
    sizeMb: 5100, migrations: ["0001_a.sql", "0002_b.sql"],
    noise: { n: 40, unchanged: 0, noise: 0 },
    parity: { ok: 20, dead: 0, p50: 90, max: 140 },
    active: 7, quorum: { published: 3, bad_quorum: 0 },
    complete: { published: 3, no_takes: 0, no_judgement: 0, no_receipt: 0 },
    wedged: 0, guards: { found: 11, armed: 11 }, payloads: "absent",
    vintage: { id: "9", member_count: "100", covered: "100" }, resolved: "100",
    conn: { idle_in_tx: 0, total: 9, visible: 4 },
    judge: { mode: "enforce", model: PINNED_JUDGE_MODEL, third_party: false },
    grants: { worker_insert: true, who: "rm_app", readonly_seq: true },
    sessionId: "11111111-1111-1111-1111-111111111111", ledgerKeyRows: 0, disk: 80,
    http: { "/health": 200, "/api/health": 200, "/api/swarm/sessions/11111111-1111-1111-1111-111111111111/judgements": 200 },
    sessions: [{ state: "published", openedAt: "2026-10-05T13:00:00Z", date: "2026-10-05" }],
    logs: {
      "analytics-producer": [L("[analytics] regime asof 2026-10-06: composite=1 regime=risk_on (200 rows)", "2026-10-06T00:00:05.000Z")],
      "website-server": [L('10.0.0.1 - - "GET / HTTP/1.1" 200 12')],
      api: [L("[api] listening")],
      "worker-analytics": [L("[gecko] regime via pro tier (pro-api.coingecko.com)")],
    },
    env: {
      "analytics-producer": { PRODUCER_REGIME_CRON: "30 */3 * * *", PRODUCER_RESEARCH_CRON: "0 */3 * * *" },
      "worker-analytics": { COINGECKO_API_KEY: "present" },
      api: { DATABASE_URL: "x" }, "website-server": { NGINX: "1" },
    },
    throwOn: null,
  };
}

function fakeIo(f: Facts, sqlSeen: string[] = []): StandingIo {
  const rules: Array<[string, () => unknown[]]> = [
    ["AS s(ts)", () => []],
    ["pg_database_size", () => [{ mb: f.sizeMb }]],
    ["FROM schema_migrations", () => f.migrations.map((name) => ({ name }))],
    ["source_value_versions s LEFT JOIN", () => [f.noise]],
    ["analytics.parity_sweep", () => [f.parity]],
    ["FROM swarm_members", () => [{ n: f.active }]],
    ["bad_quorum", () => [f.quorum]],
    ["no_takes", () => [f.complete]],
    ["state IN ('scheduled', 'collecting')", () => [{ n: f.wedged }]],
    ["pg_trigger", () => [f.guards]],
    ["to_regclass", () => [{ reg: f.payloads }]],
    ["generate_series", () => [{ n: f.resolved }]],
    ["FROM analytics_data_vintages", () => (f.vintage ? [f.vintage] : [])],
    ["pg_stat_activity", () => [f.conn]],
    ["FROM swarm_judge_config", () => [f.judge]],
    ["has_table_privilege", () => [f.grants]],
    ["ORDER BY published_at DESC", () => (f.sessionId ? [{ id: f.sessionId }] : [])],
    ["FROM source_fetches", () => [{ n: f.ledgerKeyRows }]],
  ];
  return {
    query: <T,>(sql: string, opts?: { timeoutMs?: number }): T[] => {
      sqlSeen.push(sql);
      if (f.throwOn && sql.includes(f.throwOn)) throw new Error("ERROR: relation does not exist");
      if (sql.includes("AS s(ts)")) {
        const slots = /ARRAY\[([\d,]*)\]/.exec(sql)![1]!.split(",").filter(Boolean).map(Number);
        return slots.map((ts) => ({ ts: String(ts), n: f.producedSlot(ts) })) as T[];
      }
      for (const [needle, rows] of rules) if (sql.includes(needle)) return rows() as T[];
      void opts;
      throw new Error(`fake io: no rule for ${sql.slice(0, 80)}`);
    },
    logs: (service) => f.logs[service] ?? null,
    workerServices: () => Object.keys(f.logs).filter((s) => s.startsWith("worker-")),
    env: (service) => f.env[service] ?? null,
    http: async (path) => (f.http[path] === undefined || f.http[path] === null
      ? (path.startsWith("/api/swarm/sessions?") ? { status: 200, body: JSON.stringify({ sessions: f.sessions }) } : null)
      : { status: f.http[path]!, body: "" }),
    diskFreeGb: () => f.disk,
    containerNames: () => Object.entries(f.logs).map(([service, logs]) => ({ service, logs })),
  };
}

function opts(f: Facts, over: Partial<StandingOpts> = {}): StandingOpts {
  return { since: SINCE, nowMs: NOW, full: false, dbMode: "external", openedAtFrom: "2026-09-22", baseline: { sizeMb: 5000, migrations: [...f.migrations], recordedAt: SINCE }, record: null, ...over };
}

const run = (f: Facts, over: Partial<StandingOpts> = {}) => runStandingChecks(fakeIo(f), opts(f, over));

// ── the healthy run, and the port table ─────────────────────────────────────────

const PORTED = ["R8.a", "R8.b", "R8.c", "R8.d", "R8.e", "R8.f", "R8.g", "R8.h", "R8.i", "R8.j", "R8.k", "R8.k2", "R8.l", "R8.m", "R8.n", "R8.p", "R8.q", "R8.r", "R8.s", "R8.t", "R8.u", "R8.u2", "R8.v", "R8.w", "R8.w2", "R8.w3", "R8.x", "R8.o"];

describe("a healthy stack", () => {
  test("every ported check runs and nothing fails", async () => {
    const c = await run(healthy(), { full: true });
    expect(c.filter((x) => x.status === "FAIL")).toEqual([]);
    for (const id of PORTED) expect(c.some((x) => x.id === id)).toBe(true);
    expect(verdict(c).fails).toBe(0);
  });

  test("every check issues only read statements", async () => {
    const seen: string[] = [];
    const f = healthy();
    await runStandingChecks(fakeIo(f, seen), opts(f, { full: true }));
    expect(seen.length).toBeGreaterThan(15);
    for (const sql of seen) {
      expect(sql.trim()).toMatch(/^(SELECT|WITH)\b/i);
      expect(sql.replace(/'[^']*'/g, "''")).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY)\b/i);
    }
  });

  test("the report renders every check with its result", async () => {
    const c = await run(healthy());
    const md = renderSoakReport({ instance: "i", project: "p", since: SINCE, finishedAt: "x", checks: c });
    expect(md).toContain("# Standing soak report — PASS");
    expect(md).toContain("| R8.k |");
  });
});

// ── red controls through the whole run ──────────────────────────────────────────

const RED: Array<[id: string, expected: "FAIL" | "WARN", mutate: (f: Facts) => void, opts?: Partial<StandingOpts>]> = [
  ["R8.a", "FAIL", (f) => { f.producedSlot = (ts) => (new Date(ts * 1000).getUTCHours() === 15 ? 0 : 1); }],
  ["R8.b", "FAIL", (f) => { f.producedSlot = () => 0; }],
  ["R8.c", "FAIL", (f) => { f.logs["analytics-producer"]!.push(L("[analytics-producer] regime failed: boom")); }],
  ["R8.d", "FAIL", (f) => { f.sizeMb = 9000; }],
  ["R8.e", "FAIL", (f) => { f.noise = { n: 40, unchanged: 3, noise: 0 }; }],
  ["R8.f", "FAIL", (f) => { f.parity = { ok: 5, dead: 2, p50: 90, max: 140 }; }],
  ["R8.g", "FAIL", (f) => { f.logs["website-server"] = Array.from({ length: 11 }, () => L('1.1.1.1 - - "GET /x HTTP/1.1" 502 0')); }],
  ["R8.h", "FAIL", (f) => { f.quorum = { published: 3, bad_quorum: 2 }; }],
  ["R8.i", "FAIL", (f) => { f.complete = { published: 3, no_takes: 0, no_judgement: 1, no_receipt: 0 }; }],
  ["R8.j", "FAIL", (f) => { f.wedged = 1; }],
  ["R8.k", "FAIL", (f) => { f.guards = { found: 11, armed: 10 }; }],
  ["R8.k2", "FAIL", (f) => { f.payloads = "source_payloads"; }],
  ["R8.l", "FAIL", (f) => { f.vintage = { id: "9", member_count: "100", covered: "99" }; }],
  ["R8.m", "FAIL", (f) => { f.conn = { idle_in_tx: 2, total: 9, visible: 4 }; }],
  ["R8.n", "FAIL", (f) => { f.disk = 1; }],
  ["R8.p", "FAIL", (f) => { f.migrations = [...f.migrations, "0099_surprise.sql"]; }, { baseline: { sizeMb: 5000, migrations: ["0001_a.sql", "0002_b.sql"], recordedAt: SINCE } }],
  ["R8.q", "FAIL", (f) => { f.judge = { mode: "off", model: PINNED_JUDGE_MODEL, third_party: false }; }],
  ["R8.r", "FAIL", (f) => { f.grants = { worker_insert: true, who: "doadmin", readonly_seq: true }; }],
  ["R8.s", "FAIL", (f) => { f.http["/health"] = 503; f.http["/api/health"] = 503; }],
  ["R8.t", "FAIL", (f) => { f.sessions = [{ state: "published", openedAt: null, date: "2026-10-05" }]; }],
  ["R8.u", "FAIL", (f) => { f.logs.api!.push(L("[api] GET /api/x timed out after 10s")); }],
  ["R8.u2", "WARN", (f) => { f.logs.api!.push(L("[api] slow request GET /api/analytics/sweep took 7s")); }],
  ["R8.v", "FAIL", (f) => { f.logs["worker-analytics"]!.push(L("[buybacks] live index failed: range refused")); }],
  ["R8.w", "FAIL", (f) => { f.env["worker-analytics"] = { COINGECKO_API_KEY: "" }; }],
  ["R8.w2", "FAIL", (f) => { f.logs["worker-analytics"]!.push(L("[gecko] pro-api.coingecko.com answered HTTP 429 for x")); }],
  ["R8.w3", "FAIL", (f) => { f.env.api = { COINGECKO_API_KEY: "leaked" }; }],
  ["R8.x", "FAIL", (f) => { f.logs["analytics-producer"] = [L("[analytics] regime asof 2026-10-04: composite=1", "2026-10-06T00:00:05.000Z")]; }],
];

describe("red controls: each check fails on a fixture that violates it", () => {
  for (const [id, expected, mutate, over] of RED) {
    test(`${id} turns ${expected}`, async () => {
      const f = healthy();
      mutate(f);
      const c = await run(f, over);
      expect(status(c, id)).toContain(expected);
    });
  }

  test("a query that errors is a FAIL of its own check, never a pass", async () => {
    const f = healthy();
    f.throwOn = "pg_trigger";
    const c = await run(f);
    expect(status(c, "R8.k")).toEqual(["FAIL"]);
    expect(c.find((x) => x.id === "R8.k")!.detail.join()).toContain("could not be read");
  });

  test("R8.o counts error-like lines per container and ignores telemetry", async () => {
    const f = healthy();
    f.logs.api!.push(L("fatal: x"), L("permission denied"), L("RM_TELEMETRY error=1"));
    const c = await run(f);
    expect(c.find((x) => x.id === "R8.o" && x.title === "api")!.detail[0]).toBe("2 error-like lines since T0");
    expect(c.find((x) => x.id === "R8.o" && x.title === "website-server")!.detail[0]).toBe("0 error-like lines since T0");
  });

  test("--record saves the facts as the baseline, and growth then reads zero", async () => {
    const f = healthy();
    let saved: { sizeMb: number; migrations: string[] } | null = null;
    const c = await run(f, { baseline: null, record: (b) => { saved = b; } });
    expect(saved).toMatchObject({ sizeMb: 5100, migrations: ["0001_a.sql", "0002_b.sql"] });
    expect(status(c, "R8.p")).toEqual(["PASS"]);
    expect(c.find((x) => x.id === "R8.d")!.detail[0]).toContain("+0 MB");
  });

  test("without a baseline R8.p FAILS and R8.d is unverified", async () => {
    const c = await run(healthy(), { baseline: null });
    expect(status(c, "R8.p")).toEqual(["FAIL"]);
    expect(status(c, "R8.d")).toEqual(["WARN"]);
  });

  test("--full runs the id join, and a short join fails R8.l", async () => {
    const f = healthy();
    f.resolved = "97";
    expect(status(await run(f, { full: false }), "R8.l")).toEqual(["PASS"]);
    expect(status(await run(f, { full: true }), "R8.l")).toEqual(["FAIL"]);
  });

  test("a twin stack is not graded for grants (its dump holds none)", async () => {
    const f = healthy();
    f.grants = { worker_insert: false, who: "doadmin", readonly_seq: false };
    const c = await run(f, { dbMode: "smoke-twin" });
    expect(status(c, "R8.r")).toEqual(["INFO"]);
  });

  test("a stack with no producer container leaves its log checks unverified, never passed", async () => {
    const f = healthy();
    delete f.logs["analytics-producer"];
    delete f.env["analytics-producer"];
    const c = await run(f);
    expect(status(c, "R8.c")).toEqual(["WARN"]);
    expect(status(c, "R8.x")).toEqual(["WARN"]);
  });
});

// ── the pure decisions ──────────────────────────────────────────────────────────

describe("expandCronSlots", () => {
  const from = Date.parse("2026-10-05T12:00:00Z");
  const to = Date.parse("2026-10-06T12:00:00Z");
  test("a 3 hour cron at :30 yields eight slots a day", () => {
    const s = expandCronSlots("30 */3 * * *", from, to)!;
    expect(s.length).toBe(8);
    expect(new Date(s[0]! * 1000).toISOString()).toBe("2026-10-05T12:30:00.000Z");
  });
  test("the compose default is one slot a day", () => {
    expect(expandCronSlots(DEFAULT_REGIME_CRON, from, to)!.map((t) => new Date(t * 1000).toISOString())).toEqual(["2026-10-05T22:30:00.000Z"]);
  });
  test("lists and ranges expand, a cron it cannot read is null (unverified)", () => {
    expect(expandCronSlots("0 1,5-6 * * *", from, to)!.length).toBe(3);
    expect(expandCronSlots("0 1 * * 1", from, to)).toBeNull();
    expect(expandCronSlots("nonsense", from, to)).toBeNull();
    expect(expandCronSlots("61 * * * *", from, to)).toBeNull();
  });
  test("an unreadable cron makes R8.a a WARN, never a pass", () => {
    expect(evalCadence("R8.a", "t", "0 1 * * 1", null, new Map()).status).toBe("WARN");
  });
});

describe("pure evaluators: pass and red control", () => {
  test("R8.d growth", () => {
    expect(evalGrowth(100, 100, 0).status).toBe("PASS");
    expect(evalGrowth(300, 100, 0).status).toBe("FAIL");
    expect(evalGrowth(300, 100, 12).status).toBe("PASS");
  });
  test("R8.e", () => {
    expect(evalLedgerNoise({ n: 5, unchanged: 0, noise: 0 }).status).toBe("PASS");
    expect(evalLedgerNoise({ n: 5, unchanged: 0, noise: 1 }).status).toBe("FAIL");
  });
  test("R8.f", () => {
    expect(evalParity({ ok: 3, dead: 0, p50: 100, max: 200 }).status).toBe("PASS");
    expect(evalParity({ ok: 3, dead: 0, p50: 200, max: 250 }).status).toBe("WARN");
    expect(evalParity({ ok: 3, dead: 0, p50: 100, max: 301 }).status).toBe("FAIL");
    expect(evalParity({ ok: 3, dead: 1, p50: 100, max: 200 }).status).toBe("FAIL");
  });
  test("R8.g warns up to 10 and fails beyond", () => {
    const l = (n: number) => Array.from({ length: n }, () => '- - "GET / HTTP/1.1" 500 0');
    expect(evalWebsite(l(0)).status).toBe("PASS");
    expect(evalWebsite(l(10)).status).toBe("WARN");
    expect(evalWebsite(l(11)).status).toBe("FAIL");
    expect(evalWebsite(["2026/10/06 [error] 7#7: upstream"]).status).toBe("WARN");
  });
  test("R8.h and R8.i say INFO with nothing published", () => {
    expect(evalQuorum({ published: 0, badQuorum: 0 }, 7).status).toBe("INFO");
    expect(evalQuorum({ published: 2, badQuorum: 0 }, 7).status).toBe("PASS");
    expect(evalSessionsComplete({ published: 0, noTakes: 0, noJudgement: 0, noReceipt: 0 }).status).toBe("INFO");
    expect(evalSessionsComplete({ published: 2, noTakes: 1, noJudgement: 0, noReceipt: 0 }).status).toBe("FAIL");
    expect(evalSessionsComplete({ published: 2, noTakes: 0, noJudgement: 0, noReceipt: 1 }).status).toBe("FAIL");
  });
  test("R8.j", () => {
    expect(evalWedged(0).status).toBe("PASS");
    expect(evalWedged(2).status).toBe("FAIL");
  });
  test("R8.k and R8.k2", () => {
    expect(evalGuards({ found: 11, armed: 11 }).status).toBe("PASS");
    expect(evalGuards({ found: 10, armed: 10 }).status).toBe("FAIL");
    expect(evalGuards({ found: 11, armed: 9 }).status).toBe("FAIL");
    expect(evalPayloadsGone("absent").status).toBe("PASS");
    expect(evalPayloadsGone("source_payloads").status).toBe("FAIL");
  });
  test("R8.l", () => {
    expect(evalVintage({ id: 1, memberCount: 5, covered: 5 }, null, false).status).toBe("PASS");
    expect(evalVintage({ id: 1, memberCount: 5, covered: 4 }, null, false).status).toBe("FAIL");
    expect(evalVintage(undefined, null, false).status).toBe("FAIL");
    expect(evalVintage({ id: 1, memberCount: 5, covered: 5 }, 4, true).status).toBe("FAIL");
    expect(evalVintage({ id: 1, memberCount: 5, covered: 5 }, 5, true).status).toBe("PASS");
  });
  test("R8.m names how much of the pool the api role can see", () => {
    expect(evalConnections({ idleInTx: 0, total: 9, visible: 3 }).detail.join()).toContain("3 of 9");
    expect(evalConnections({ idleInTx: 1, total: 9, visible: 3 }).status).toBe("FAIL");
  });
  test("R8.n thresholds", () => {
    expect(evalDisk(5).status).toBe("PASS");
    expect(evalDisk(4).status).toBe("WARN");
    expect(evalDisk(2).status).toBe("FAIL");
    expect(evalDisk(null).status).toBe("FAIL");
  });
  test("R8.p", () => {
    expect(evalMigrations(["a", "b"], ["a", "b"]).status).toBe("PASS");
    expect(evalMigrations(["a", "b"], ["a"]).status).toBe("FAIL");
    expect(evalMigrations(["a"], ["a", "c"]).status).toBe("FAIL");
    expect(evalMigrations(null, ["a"]).status).toBe("FAIL");
    expect(evalMigrations([], ["a"]).status).toBe("FAIL");
  });
  test("R8.q: the pin passes, a pre-0111 id warns, anything else fails", () => {
    const row = (model: string | null, mode = "enforce", thirdParty = false) => ({ mode, model, thirdParty });
    expect(evalJudgeConfig(row(PINNED_JUDGE_MODEL)).status).toBe("PASS");
    for (const m of [...LEGACY_JUDGE_MODELS, `opencode/${LEGACY_JUDGE_MODELS[0]}`]) expect(evalJudgeConfig(row(m)).status).toBe("WARN");
    expect(evalJudgeConfig(row("gpt-9")).status).toBe("FAIL");
    expect(evalJudgeConfig(row(null)).status).toBe("FAIL");
    expect(evalJudgeConfig(row(PINNED_JUDGE_MODEL, "off")).status).toBe("FAIL");
    expect(evalJudgeConfig(row(PINNED_JUDGE_MODEL, "enforce", true)).status).toBe("FAIL");
    expect(evalJudgeConfig(undefined).status).toBe("FAIL");
  });
  test("R8.r grades each of the three grants on an external stack", () => {
    const ok = { workerInsert: true, currentUser: "rm_app", readonlySeq: true };
    expect(evalGrants("external", ok).every((c) => c.status === "PASS")).toBe(true);
    expect(evalGrants("external", { ...ok, workerInsert: false }).map((c) => c.status)).toEqual(["FAIL", "PASS", "PASS"]);
    expect(evalGrants("external", { ...ok, currentUser: "postgres" }).map((c) => c.status)).toEqual(["PASS", "FAIL", "PASS"]);
    expect(evalGrants("external", { ...ok, readonlySeq: false }).map((c) => c.status)).toEqual(["PASS", "PASS", "FAIL"]);
  });
  test("R8.s", () => {
    expect(evalHealth(200, null, 200).status).toBe("PASS");
    expect(evalHealth(200, 200, 500).status).toBe("FAIL");
    expect(evalHealth(null, null, 200).status).toBe("FAIL");
    expect(evalHealth(200, 200, null).status).toBe("WARN");
  });
  test("R8.t ignores sessions before the cut-over date", () => {
    expect(evalOpenedAt([{ state: "published", openedAt: null, date: "2026-09-01" }], "2026-09-22").status).toBe("PASS");
    expect(evalOpenedAt([{ state: "published", openedAt: null, date: "2026-09-23" }], "2026-09-22").status).toBe("FAIL");
    expect(evalOpenedAt([{ state: "collecting", openedAt: null, date: "2026-09-23" }], "2026-09-22").status).toBe("PASS");
    expect(evalOpenedAt(null, "2026-09-22").status).toBe("FAIL");
  });
  test("R8.u and R8.u2", () => {
    expect(evalApiLogs(["ok"]).map((c) => c.status)).toEqual(["PASS", "PASS"]);
    expect(evalApiLogs(["x timed out after 10s"]).map((c) => c.status)).toEqual(["FAIL", "PASS"]);
    const w = evalApiLogs(["[api] slow request GET /api/a took 6s", "[api] request ran past POST /api/b"]);
    expect(w[1]!.status).toBe("WARN");
    expect(w[1]!.detail[0]).toContain("GET /api/a");
  });
  test("R8.v tolerates a 413 that was halved", () => {
    expect(evalBuyback(["answered HTTP 413, halving"]).status).toBe("PASS");
    expect(evalBuyback(["live index failed"]).status).toBe("FAIL");
  });
  test("R8.w: the tier must match the key", () => {
    const g = (hasKey: boolean, lines: string[]) => evalGecko({ hasKey, geckoLines: lines, unredactedLedgerRows: 0, keyEnvHits: 0 }).find((c) => c.id === "R8.w")!.status;
    expect(g(true, ["[gecko] x via pro tier (h)"])).toBe("PASS");
    expect(g(true, ["[gecko] x via free tier (h)"])).toBe("FAIL");
    expect(g(true, [])).toBe("INFO");
    expect(g(false, ["[gecko] x via free tier (h)"])).toBe("PASS");
    expect(g(false, ["[gecko] x via pro tier (h)"])).toBe("FAIL");
  });
  test("R8.w3 fails on an unredacted ledger row or an exposed variable", () => {
    const c = (rows: number | undefined, hits: number | null) => evalGecko({ hasKey: false, geckoLines: [], unredactedLedgerRows: rows, keyEnvHits: hits }).find((x) => x.id === "R8.w3")!.status;
    expect(c(0, 0)).toBe("PASS");
    expect(c(1, 0)).toBe("FAIL");
    expect(c(0, 1)).toBe("FAIL");
    expect(c(undefined, 0)).toBe("FAIL");
    expect(c(0, null)).toBe("FAIL");
  });
  test("R8.x compares each regime line with the UTC day it was written", () => {
    expect(evalRegimeDay([{ ts: "2026-10-06T00:00:05Z", text: "regime asof 2026-10-06:" }], 30).status).toBe("PASS");
    expect(evalRegimeDay([{ ts: "2026-10-06T00:00:05Z", text: "regime asof 2026-10-05:" }], 30).status).toBe("FAIL");
    expect(evalRegimeDay([], 3).status).toBe("INFO");
    expect(evalRegimeDay([], 30).status).toBe("WARN");
    expect(evalRegimeDay(null, 3).status).toBe("WARN");
  });
  test("R8.c", () => {
    expect(evalProducerFailures(["[analytics-producer] research failed: x"]).status).toBe("FAIL");
    expect(evalProducerFailures(["[analytics-producer] day-roll regime 2026-10-06 failed: x"]).status).toBe("FAIL");
    expect(evalProducerFailures(["fine"]).status).toBe("PASS");
  });
  test("R8.o is informational", () => {
    expect(evalErrorLike(new Map([["api", ["error x"]]]))[0]!.status).toBe("INFO");
  });
  test("unreadable is a FAIL", () => {
    expect(unreadable("R8.z", "t", new Error("no")).status).toBe("FAIL");
  });
});

// ── drift guards: the checks read what main actually has ────────────────────────

describe("drift guards against main", () => {
  const snapshot = readFileSync(join(root, "backend/schema/snapshot.sql"), "utf8");
  const src = readFileSync(join(root, "scripts/standing-soak.ts"), "utf8");

  test("every ledger guard trigger the check names exists in the schema snapshot", () => {
    for (const g of LEDGER_GUARDS) expect(snapshot).toContain(`CREATE TRIGGER ${g} `);
  });

  test("every table the checks read exists in the schema snapshot", () => {
    const tables = ["analytics_ledger_runs", "analytics_output_snapshots", "source_value_versions", "analytics_vintage_members", "analytics_data_vintages", "jobs", "swarm_members", "swarm_sessions", "swarm_recommendations", "swarm_session_judgements", "swarm_consensus_receipts", "swarm_judge_config", "source_fetches", "schema_migrations", ...CHAIN_STATE_TABLES];
    for (const t of tables) expect(snapshot).toContain(`CREATE TABLE public.${t} (`);
    for (const t of tables) expect(src.includes(t) || CHAIN_STATE_TABLES.includes(t as never)).toBe(true);
  });

  test("the producer cron defaults equal docker-compose.yml", () => {
    const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
    expect(compose).toContain(`PRODUCER_REGIME_CRON: \${PRODUCER_REGIME_CRON:-${DEFAULT_REGIME_CRON}}`);
    expect(compose).toContain(`PRODUCER_RESEARCH_CRON: \${PRODUCER_RESEARCH_CRON:-${DEFAULT_RESEARCH_CRON}}`);
  });

  test("the log strings the checks look for still exist in the code that writes them", () => {
    const has = (file: string, s: string) => expect(readFileSync(join(root, file), "utf8")).toContain(s);
    has("backend/src/api/request-timing.ts", "timed out after");
    has("backend/src/api/request-timing.ts", "[api] slow request");
    has("backend/src/api/request-timing.ts", "request ran past");
    has("backend/src/chain/buyback-logs.ts", "live index failed");
    has("backend/src/chain/gecko-endpoint.ts", "[gecko]");
    has("backend/src/chain/gecko-endpoint.ts", "answered HTTP");
    has("backend/src/analytics/index.ts", "regime asof");
    has("backend/src/producer/index.ts", "failed: ");
    has("backend/src/producer/index.ts", "analytics-producer] fatal:");
  });

  test("the script is wired as a package script and runs beside the gates, not inside them", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["soak:checks"]).toBe("bun scripts/standing-soak.ts");
    expect(existsSync(join(root, "scripts/standing-soak.ts"))).toBe(true);
  });
});

describe("serviceOf and parseSoakArgs", () => {
  test("serviceOf strips the project and the replica suffix", () => {
    expect(serviceOf("rm_prod", "rm_prod-worker-analytics-1")).toBe("worker-analytics");
    expect(serviceOf("rm_prod", "other-api-1")).toBe("other-api-1");
  });
  test("parseSoakArgs", () => {
    expect(parseSoakArgs([])).toMatchObject({ full: false, record: false, openedAtFrom: "2026-09-22" });
    expect(parseSoakArgs(["--instance", "rm_prod", "--full", "--record", "--since", "2026-10-05T12:00:00Z"])).toMatchObject({ full: true, record: true, since: "2026-10-05T12:00:00.000Z" });
    expect(parseSoakArgs(["--since", "nope"])).toHaveProperty("error");
    expect(parseSoakArgs(["--report", "x.txt"])).toHaveProperty("error");
    expect(parseSoakArgs(["--base-url", "ftp://x"])).toHaveProperty("error");
    expect(parseSoakArgs(["--opened-at-from", "yesterday"])).toHaveProperty("error");
    expect(parseSoakArgs(["--wat"])).toHaveProperty("error");
  });
});
