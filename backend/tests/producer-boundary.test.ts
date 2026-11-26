import { expect, spyOn, test } from "bun:test";
import { hermeticDataSource } from "../src/analytics/access/hermetic-source.ts";
import type { AnalyticsPersistence } from "../src/analytics/persistence.ts";
import type { AnalyticsDataSource } from "../src/analytics/access/data-source.ts";
import { runAnalytics, RESEARCH_TOOL_GROUP } from "../src/analytics/index.ts";
import { noopTelemetrySink } from "../src/analytics/telemetry.ts";
import { requireProducerApiConfig, runProducerCommand, runProducerOnce, startProducerSchedules } from "../src/producer/index.ts";
import { writeTokenFile } from "./support/automation-auth.ts";

const persistence = {} as AnalyticsPersistence;

// An in-memory AnalyticsPersistence: the tool-selection assertion below is
// about WHICH tools one runAnalytics call executes, not about persistence, so
// this keeps the check free of SQL/HTTP without mocking away the subject.
function recordingPersistence(): AnalyticsPersistence {
  return {
    async beginRun() { return { runId: "0", methodologyVersionId: "0", replayed: false }; },
    async appendRunEvent() {},
    async freezeVintage() {
      return {
        vintageId: "0",
        manifest: {
          methodologyVersionId: "0", buildIdentity: "test", knowledgeTimeCutoff: "", marketTimeCutoff: "",
          seriesCount: 0, memberCount: 0, seriesFingerprints: {}, manifestDigest: "",
        },
        memberCount: 0,
        replayed: false,
      };
    },
    async submitTerminalRunPackage() { return { outputSnapshots: [], reportSnapshotId: null, replayed: false }; },
    async loadRawHistory() { return {}; },
    async saveRawHistory() {},
    async seedRawHistory() { return { seededPoints: 0, existingPoints: 0, indicators: 0 }; },
    async loadResearchSignalDates() { return []; },
    async loadRawHistoryGapDates() { return []; },
  };
}

// Issue 1765 (phase 3): an in-memory ledger that records every persistence
// call of a regime tick, in order, labelled with its run's methodology. The
// tick's order and isolation are about which calls it makes, not about SQL.
// Its floor reads empty and keeps nothing; the hermetic source records no
// acquisition, so each model computes from the floor the extract built. A
// model that keeps its history finds its kept-days read refused, so the beside
// run (v5) fails fast inside its own compute instead of walking every day.
function tickLedger(opts: { refuseBeginOf?: string; failFreezeOf?: string } = {}) {
  const calls: string[] = [];
  const labels = new Map<string, string>();
  const persistence: AnalyticsPersistence = {
    async beginRun(input) {
      const label = input.methodology.versionLabel;
      calls.push(`beginRun ${label}`);
      if (label === opts.refuseBeginOf) throw new Error(`beginRun refused for ${label}`);
      const runId = String(labels.size + 1);
      labels.set(runId, label);
      return { runId, methodologyVersionId: runId, replayed: false };
    },
    async appendRunEvent(runId, event) {
      calls.push(`${event} ${labels.get(runId)}`);
    },
    async freezeVintage(input) {
      calls.push(`freezeVintage ${labels.get(input.runId)}`);
      if (labels.get(input.runId) === opts.failFreezeOf) throw new Error(`freeze failed for ${opts.failFreezeOf}`);
      return recordingPersistence().freezeVintage(input);
    },
    async submitTerminalRunPackage(input) {
      calls.push(`package ${input.status} ${labels.get(input.runId)}`);
      return { outputSnapshots: [], reportSnapshotId: null, replayed: false };
    },
    async loadKeptRegimeDays(methodology) {
      calls.push(`loadKeptRegimeDays ${methodology}`);
      throw new Error("no kept days in this test");
    },
    async loadRawHistory() {
      calls.push("loadRawHistory");
      return {};
    },
    async saveRawHistory() {
      calls.push("saveRawHistory");
    },
    async seedRawHistory() { return { seededPoints: 0, existingPoints: 0, indicators: 0 }; },
    async loadResearchSignalDates() { return []; },
    async loadRawHistoryGapDates() { return []; },
  };
  return { calls, persistence };
}

// The hermetic source behind a run-scoped source, every call recorded in the
// same list as the ledger's, so one list shows the tick's whole order.
function recordingSource(calls: string[]): AnalyticsDataSource {
  const scoped: AnalyticsDataSource = {
    fetchIndicators: (...a) => { calls.push("fetchIndicators"); return hermeticDataSource.fetchIndicators(...a); },
    fetchBacktestExtras: (...a) => { calls.push("fetchBacktestExtras"); return hermeticDataSource.fetchBacktestExtras(...a); },
    fetchResearchInputs: (...a) => { calls.push("fetchResearchInputs"); return hermeticDataSource.fetchResearchInputs(...a); },
  };
  return { ...scoped, forRun: () => { calls.push("forRun"); return scoped; } };
}

// Console capture for the tick tests: the beside failure is logged, never thrown.
async function capturingErrors<T>(run: () => Promise<T>): Promise<{ value: T | null; error: unknown; errors: string[] }> {
  const errors: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
  try {
    return { value: await run(), error: null, errors };
  } catch (error) {
    return { value: null, error, errors };
  } finally {
    spy.mockRestore();
  }
}

const TICK = { telemetry: noopTelemetrySink, now: new Date("2031-01-02T23:59:00Z") };
const finished = (label: string) => new RegExp(`^(succeeded|degraded) ${label}$`);

// Issue 1765: one regime tick begins every model's ledger run (main line
// first) before any source call, extracts ONCE through one run-scoped source,
// and then computes and publishes each model on its own, main line first. The
// tick's result is the main-line run's; the beside run's failure is logged.
test("a regime tick begins each model's run before its one extract, then computes and publishes each model, main line first", async () => {
  const { calls, persistence: store } = tickLedger();
  const { value, error, errors } = await capturingErrors(() => runProducerOnce("regime", "2031-01-02", { source: recordingSource(calls), persistence: store, tick: TICK }));
  expect(error).toBeNull();
  expect(calls.slice(0, 9)).toEqual([
    "beginRun v4", "started v4", "beginRun v5", "started v5",
    // One extract for both models: one run-scoped source, one floor read, one registry fetch, one floor write, one extras fetch.
    "forRun", "loadRawHistory", "fetchIndicators", "saveRawHistory", "fetchBacktestExtras",
  ]);
  // The main line computes and publishes first, then the beside model.
  expect(calls[9]).toBe("freezeVintage v4");
  expect(calls[10]).toMatch(finished("v4"));
  expect(calls.slice(11)).toEqual(["package succeeded v4", "loadKeptRegimeDays v5", "failed v5", "package failed v5"]);
  // The tick answers with the main-line run, and logs the beside failure.
  expect(Object.keys(value!)).toEqual(["regime"]);
  expect((value as any).regime.methodology).toBeUndefined();
  expect(errors.filter((e) => e.includes("regime failed for methodology v5") && e.includes("no kept days in this test")).length).toBe(1);
}, 120_000);

// Issue 1753, kept by the shared tick: a failed main-line run does not stop the
// beside run, a beside run that cannot begin is dropped and never reaches the
// main-line run, and the tick's error is the main-line run's.
test("a regime tick isolates its runs: a failed main-line run does not stop the beside run, and a beside run that cannot begin is dropped", async () => {
  const failingMain = tickLedger({ failFreezeOf: "v4" });
  const failed = await capturingErrors(() => runProducerOnce("regime", "2031-01-02", { source: recordingSource(failingMain.calls), persistence: failingMain.persistence, tick: TICK }));
  expect((failed.error as Error).message).toBe("freeze failed for v4");
  expect(failingMain.calls.filter((c) => c.startsWith("fetch"))).toEqual(["fetchIndicators", "fetchBacktestExtras"]);
  expect(failingMain.calls.slice(-6)).toEqual(["freezeVintage v4", "failed v4", "package failed v4", "loadKeptRegimeDays v5", "failed v5", "package failed v5"]);

  const refused = tickLedger({ refuseBeginOf: "v5" });
  const main = await capturingErrors(() => runProducerOnce("regime", "2031-01-02", { source: recordingSource(refused.calls), persistence: refused.persistence, tick: TICK }));
  expect(main.error).toBeNull();
  expect(refused.calls.slice(0, 4)).toEqual(["beginRun v4", "started v4", "beginRun v5", "forRun"]);
  expect(refused.calls.filter((c) => c.endsWith(" v5"))).toEqual(["beginRun v5"]);
  expect(refused.calls.at(-1)).toBe("package succeeded v4");
  expect((main.value as any).regime).toBeDefined();
  expect(main.errors.filter((e) => e.includes("regime failed for methodology v5") && e.includes("beginRun refused for v5")).length).toBe(1);
}, 120_000);

// Issue 1753, kept by the one tick path (issue 1765): the models of a regime
// tick share one run-scoped source, so the tick makes one provider request per
// series. A failed beside run never fails or changes the main-line run: the
// main line's calls and result equal those of a tick without the beside model.
// A regime tick has one path, runRegimeTick: an injected runner is refused.
test("a regime tick's models share one run-scoped source, and a failed beside run never changes the main-line run: its result equals a tick of the main line alone", async () => {
  const both = tickLedger();
  const withBeside = await capturingErrors(() => runProducerOnce("regime", "2031-01-02", { source: recordingSource(both.calls), persistence: both.persistence, tick: TICK }));
  const alone = tickLedger();
  const mainOnly = await capturingErrors(() => runProducerOnce("regime", "2031-01-02", { source: recordingSource(alone.calls), persistence: alone.persistence, tick: { ...TICK, versions: ["v4"] } }));
  expect(withBeside.error).toBeNull();
  expect(mainOnly.error).toBeNull();
  // One run-scoped source for the whole tick, each fetch made once through it.
  expect(both.calls.filter((c) => c === "forRun")).toEqual(["forRun"]);
  expect(both.calls.filter((c) => c.startsWith("fetch"))).toEqual(["fetchIndicators", "fetchBacktestExtras"]);
  // The beside run failed alone, and was logged.
  expect(both.calls.slice(-3)).toEqual(["loadKeptRegimeDays v5", "failed v5", "package failed v5"]);
  expect(withBeside.errors.filter((e) => e.includes("regime failed for methodology v5")).length).toBe(1);
  // The main line's calls and result are those of a tick without the beside model.
  expect(both.calls.filter((c) => !c.endsWith(" v5"))).toEqual(alone.calls);
  expect(alone.calls.some((c) => c.endsWith(" v5"))).toBe(false);
  expect(withBeside.value).toEqual(mainOnly.value);
  expect((withBeside.value as any).regime.asof).toBe("2031-01-02");
  // A regime tick has one path: a runner is refused before any call.
  const refused: string[] = [];
  await expect(runProducerOnce("regime", "2031-01-02", {
    source: recordingSource(refused),
    persistence,
    runner: async () => {
      refused.push("runner");
      return {};
    },
  })).rejects.toThrow(/regime tick takes no runner/);
  expect(refused).toEqual([]);
}, 120_000);

// Issue #509: the research producer must invoke the orchestrator ONCE per
// scheduled run, not once per research tool. Both signals share a single
// fetchResearchInputs call — and therefore a single live EDGAR sweep — so the
// old per-tool loop paid for that sweep twice every cycle (up to ~400 EDGAR
// requests and 2×15min on a full-sweep day) and discarded the first result
// entirely, since only the late-cycle-signals branch persists it.
test("independent research producer runs the orchestrator ONCE for both research tools, never once per tool", async () => {
  const calls: string[] = [];
  const out = await runProducerOnce("research", "2031-01-02", {
    source: hermeticDataSource,
    persistence,
    runner: async (_asof, tool) => {
      calls.push(tool);
      return { "channel-divergence": true, "late-cycle-signals": true };
    },
  });
  expect(calls).toEqual([RESEARCH_TOOL_GROUP]); // exactly one invocation
  expect(calls).not.toContain("regime");
  // ...and both signals still come back from that single run.
  expect(Object.keys(out).sort()).toEqual(["channel-divergence", "late-cycle-signals"]);
});

test("the research tool group selects exactly the two research signals inside one runAnalytics call — never regime, never the whole suite", async () => {
  const results = await runAnalytics("2031-01-02", RESEARCH_TOOL_GROUP, hermeticDataSource, recordingPersistence(), noopTelemetrySink);
  expect(Object.keys(results).sort()).toEqual(["channel-divergence", "late-cycle-signals"]);
  expect(results.regime).toBeUndefined();
});

test("producer refuses to reach readiness without an analytics credential", async () => {
  let readinessChecked = false;
  await expect(runProducerCommand("regime", "2031-01-02", {
    env: { ANALYTICS_API_URL: "http://api:8787" },
    waitUntilReady: async () => { readinessChecked = true; },
  })).rejects.toThrow("requires ANALYTICS_TOKEN_FILE");
  expect(readinessChecked).toBe(false);
  // D52 (1): a token-valued env var is not a credential source any more — the
  // producer reads its store-issued token from the file and nowhere else.
  expect(() => requireProducerApiConfig({ ANALYTICS_TOKEN: "producer-secret" })).toThrow("requires ANALYTICS_TOKEN_FILE");
  expect(() => requireProducerApiConfig({ ANALYTICS_TOKEN_FILE: writeTokenFile("  ") })).toThrow("empty token file");
});

test("serve validates the credential with the API before arming either schedule", async () => {
  const expectedToken = "correct-producer-secret";
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      requests.push(`${url.pathname}:${req.headers.get("authorization") ?? "none"}`);
      if (url.pathname === "/health") return Response.json({ status: "ok" });
      if (url.pathname === "/api/analytics/readiness") {
        return req.headers.get("authorization") === `Bearer ${expectedToken}`
          ? Response.json({ ok: true, role: "analytics-provider" })
          : Response.json({ error: "analytics-provider role required" }, { status: 403 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const baseEnv = { ANALYTICS_API_URL: `http://127.0.0.1:${server.port}` };
  try {
    const rejectedSchedules: string[] = [];
    await expect(startProducerSchedules({
      env: { ...baseEnv, ANALYTICS_TOKEN_FILE: writeTokenFile("wrong-non-empty-secret") },
      scheduleKind: (kind) => { rejectedSchedules.push(kind); },
    })).rejects.toThrow("credential was rejected");
    expect(rejectedSchedules).toEqual([]);

    const acceptedSchedules: string[] = [];
    await startProducerSchedules({
      env: { ...baseEnv, ANALYTICS_TOKEN_FILE: writeTokenFile(expectedToken) },
      scheduleKind: (kind, cron) => { acceptedSchedules.push(`${kind}:${cron}`); },
    });
    expect(acceptedSchedules).toEqual([
      "regime:30 22 * * *",
      "research:0 23 * * *",
    ]);
    expect(requests).toContain("/api/analytics/readiness:Bearer wrong-non-empty-secret");
    expect(requests).toContain(`/api/analytics/readiness:Bearer ${expectedToken}`);
  } finally {
    server.stop(true);
  }
});

test("seed waits for the API, seeds raw history, then produces both research signals", async () => {
  const events: string[] = [];
  await runProducerCommand("seed", "2031-01-02", {
    env: { ANALYTICS_API_URL: "http://api:8787", ANALYTICS_TOKEN_FILE: writeTokenFile("producer-secret") },
    waitUntilReady: async (cfg) => {
      expect(cfg.baseUrl).toBe("http://api:8787");
      expect(cfg.token).toBe("producer-secret");
      events.push("ready");
    },
    bootstrapSeed: async () => { events.push("seed"); },
    source: hermeticDataSource,
    persistence,
    runner: async (_asof, tool, _source, store) => {
      expect(store).toBe(persistence);
      events.push(tool);
      return { "channel-divergence": true, "late-cycle-signals": true };
    },
  });
  // One research invocation, not one per tool (issue #509) — still producing
  // both signals, still strictly after readiness and seeding.
  expect(events).toEqual(["ready", "seed", RESEARCH_TOOL_GROUP]);
});
