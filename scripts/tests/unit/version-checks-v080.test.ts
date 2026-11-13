import { describe, expect, test } from "bun:test";
import { LEGACY_JUNCTION } from "../../../packages/analyst-sdk/src/archive/format1-legacy.ts";
import { sha256Hex } from "../../release/public-analytics-read.ts";
import { loadReleaseRunbook, stepNameOf } from "../../release/runbook.ts";
import { archiveProblems, archiveRecords, BUDGET_MS, chosenBackups, type Answer, type ArchiveDeps } from "../../release/version-checks/v0.8.0/archive-records.ts";
import { noJitProblems, parseResult, RESULT_MARKER } from "../../release/version-checks/v0.8.0/no-jit.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));

const ROOT = join(import.meta.dir, "..", "..", "..");
const read = (container: string, code: number, result: unknown) => ({ container, code, stdout: `${RESULT_MARKER}${JSON.stringify(result)}\n`, stderr: "" });

describe("v0.8.0 no-jit check (PR 1595)", () => {
  test("green: the api's pool is off on a server whose default is on", () => {
    expect(noJitProblems([read("rm_smoke_stack_x-api-1", 0, { pool: "off", serverDefault: "on" })])).toEqual([]);
  });

  test("red: v0.7.3's pool runs with the server default", () => {
    expect(noJitProblems([read("api-1", 0, { pool: "on", serverDefault: "on" })]).join()).toContain("runs with jit on, not off");
  });

  test("red: no api container, a failed exec and output with no result line", () => {
    expect(noJitProblems([])).toEqual(["no running api container in the instance's compose project"]);
    expect(noJitProblems([{ container: "api-1", code: 1, stdout: "", stderr: "boom" }]).join()).toContain("did not run (exit 1): boom");
    expect(noJitProblems([{ container: "api-1", code: 0, stdout: "hello\n", stderr: "" }]).join()).toContain("did not run (exit 0)");
    expect(parseResult(`${RESULT_MARKER}{"pool":1}`)).toBeNull();
  });
});

describe("Q34b-archive-records/C22a-archive-records (1524, 1526)", () => {
  const ids = ["2026-09-22T000000Z", "2026-10-28T000000Z", LEGACY_JUNCTION.id, "2026-10-29T000000Z"];
  const record = enc({ format: 1, backup: "x" });
  const answer = (status: number, bytes: Uint8Array = enc(""), extra: Partial<Answer> = {}): Answer => ({ status, ms: 120, retryAfter: status === 503 ? "10" : null, xsha: status === 200 ? sha256Hex(bytes) : null, bytes, ...extra });
  const fake = (opts: { firstListing?: Answer; building?: number; recordStatus?: number; slowRecord?: boolean; listed?: string[] } = {}) => {
    const clock = { t: 0 };
    const seen = new Map<string, number>();
    let listings = 0;
    const deps: ArchiveDeps = {
      async get(path) {
        if (path.includes("/archive/backups")) {
          listings++;
          if (listings === 1 && opts.firstListing) return opts.firstListing;
          return answer(200, enc({ format: 1, backups: (opts.listed ?? ids).map((backup) => ({ backup })), nextCursor: null }));
        }
        const n = (seen.get(path) ?? 0) + 1;
        seen.set(path, n);
        if (opts.recordStatus) return answer(opts.recordStatus);
        if (n <= (opts.building ?? 1)) return answer(503, enc(""), { ms: 4_010 });
        return answer(200, record, opts.slowRecord ? { ms: BUDGET_MS + 1 } : {});
      },
      now: () => clock.t,
      sleep: async (ms) => { clock.t += ms; },
      log: () => {},
      recordWaitMs: 60_000,
    };
    return deps;
  };

  test("it builds the first, the junction and the newest record", () => {
    expect(chosenBackups(ids)).toEqual(["2026-09-22T000000Z", LEGACY_JUNCTION.id, "2026-10-29T000000Z"]);
    expect(chosenBackups(["2026-09-22T000000Z"])).toEqual(["2026-09-22T000000Z"]);
  });
  test("passes: a 200 listing under budget and three records that build after a 503 each", async () => {
    const r = await archiveRecords(fake());
    expect(archiveProblems(r)).toEqual([]);
    expect(r.records.map((x) => x.attempts.length)).toEqual([2, 2, 2]);
    expect(r.junctionListed).toBe(true);
  });
  test("red: a first listing the junction check failed, a slow request, a record that never builds, a refused record, a wrong hash, no junction", async () => {
    expect(archiveProblems(await archiveRecords(fake({ firstListing: answer(503, enc(""), { ms: 4_200 }) }))).join()).toContain("the junction check");
    expect(archiveProblems(await archiveRecords(fake({ firstListing: answer(200, enc({ backups: ids.map((backup) => ({ backup })), nextCursor: null }), { ms: 6_000 }) }))).join()).toContain("at or over the 5000 ms budget");
    expect(archiveProblems(await archiveRecords(fake({ slowRecord: true }))).join()).toContain("at or over the 5000 ms budget");
    expect(archiveProblems(await archiveRecords(fake({ building: 1_000 }))).join()).toContain("did not answer 200 within");
    expect(archiveProblems(await archiveRecords(fake({ recordStatus: 500 }))).join()).toContain("answered 500, neither 200 nor a 503");
    expect(archiveProblems(await archiveRecords(fake({ listed: ids.filter((i) => i !== LEGACY_JUNCTION.id) }))).join()).toContain(`legacy junction backup ${LEGACY_JUNCTION.id} is not listed`);
    const r = await archiveRecords(fake());
    const bad = { ...r, records: r.records.map((x) => ({ ...x, built: { ...x.built!, shaMatches: false, format: 2 } })) };
    expect(archiveProblems(bad).join()).toContain("carries format 2, not 1");
    expect(archiveProblems(bad).join()).toContain("is not the sha256 of the bytes");
  });
});

describe("every v0.8.0 version check loads as version-check.ts runs it", () => {
  for (const name of ["archive-records", "no-jit"]) {
    test(name, async () => {
      const mod = await import(`../../release/version-checks/v0.8.0/${name}.ts`);
      expect(typeof mod.default).toBe("function");
    });
  }
});

describe("the v0.8.0 runbook", () => {
  const runbook = loadReleaseRunbook("v0.8.0");
  const added = runbook.steps.filter((s) => s.added === "v0.8.0");
  test("it adds the archive-records and no-jit checks, each with a production twin and a check file", () => {
    expect(added.map((s) => s.id)).toEqual(["Q34b-archive-records", "Q39-no-jit", "C22a-archive-records", "C27-no-jit"]);
    for (const s of added) {
      const name = stepNameOf(s.id);
      expect(s.cmds[0]).toContain(name);
      expect(s.receipts[0]!.pattern).toBe(`version-check-${name}.json`);
      expect(readFileSync(join(import.meta.dir, "../../release/version-checks/v0.8.0", `${name}.ts`), "utf8")).toContain("satisfies VersionCheck");
    }
  });
  test("the archive records run before the SDK's archive routes", () => {
    const ids = runbook.steps.map((s) => s.id);
    expect(ids.indexOf("Q35-archive-routes")).toBe(ids.indexOf("Q34b-archive-records") + 1);
    expect(ids.indexOf("C23-archive-routes")).toBe(ids.indexOf("C22a-archive-records") + 1);
  });
  test("no migration is breaking; every scope check is a step of the runbook", () => {
    expect(runbook.breaking).toBeUndefined();
    const ids = new Set(runbook.steps.map((s) => s.id));
    for (const e of runbook.scope) if (e.check) expect(ids.has(e.check)).toBe(true);
  });
});
