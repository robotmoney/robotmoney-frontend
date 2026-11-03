// Issue 1514: the archive record probe's reporting, with a fake store in place
// of the restored production copy. No Docker, no database.
import { describe, expect, test } from "bun:test";
import { runProbe, slowStatementLines, type ProbeStore } from "../../ops/archive-record-probe.ts";

const enc = new TextEncoder();

function fakeStore(ids: string[], failing: Record<string, string> = {}): ProbeStore & { built: string[] } {
  const built: string[] = [];
  return {
    built,
    listBackupIds: async () => ids,
    recordFor: async (id) => {
      built.push(id);
      if (failing[id]) throw new Error(failing[id]);
      return { bytes: enc.encode(`{"backup":"${id}"}\n`), sha256: `sha-${id}` };
    },
  };
}

async function run(store: ProbeStore, ids: string[] = [], slow: string[] = []) {
  let out = "";
  let t = 0;
  const code = await runProbe({
    store,
    ids,
    log: () => {},
    write: (text) => {
      out += text;
    },
    slowStatements: () => slow,
    now: () => (t += 100),
  });
  return { code, report: JSON.parse(out) };
}

describe("archive-record-probe (issue 1514)", () => {
  test("every build succeeds: exit 0 and one JSON result naming each build's size and SHA-256", async () => {
    const store = fakeStore(["2026-09-22T000000Z", "2026-10-01T000000Z", "2026-10-28T000000Z"]);
    const { code, report } = await run(store, [], ["LOG: duration: 812.3 ms statement: SELECT 1"]);
    expect(code).toBe(0);
    // No backup named: the first and the newest.
    expect(store.built).toEqual(["2026-09-22T000000Z", "2026-10-28T000000Z"]);
    expect(report).toEqual({
      ok: true,
      backups: 3,
      first: "2026-09-22T000000Z",
      last: "2026-10-28T000000Z",
      builds: [
        { backup: "2026-09-22T000000Z", ok: true, ms: 100, bytes: 32, sha256: "sha-2026-09-22T000000Z" },
        { backup: "2026-10-28T000000Z", ok: true, ms: 100, bytes: 32, sha256: "sha-2026-10-28T000000Z" },
      ],
      slowStatements: ["LOG: duration: 812.3 ms statement: SELECT 1"],
    });
  });

  test("a failed build: exit non-zero, its error in the JSON, and the next named backup is still built", async () => {
    const store = fakeStore(["2026-09-22T000000Z", "2026-10-01T000000Z"], {
      "2026-09-22T000000Z": "canceling statement due to statement timeout",
    });
    const { code, report } = await run(store, ["2026-09-22T000000Z", "2026-10-01T000000Z"]);
    expect(code).not.toBe(0);
    expect(report.ok).toBe(false);
    expect(report.builds).toEqual([
      { backup: "2026-09-22T000000Z", ok: false, ms: 100, error: "canceling statement due to statement timeout" },
      { backup: "2026-10-01T000000Z", ok: true, ms: 100, bytes: 32, sha256: "sha-2026-10-01T000000Z" },
    ]);
  });

  test("no sealed backup to build is a failure, not a green run", async () => {
    const { code, report } = await run(fakeStore([]));
    expect(code).not.toBe(0);
    expect(report).toMatchObject({ ok: false, backups: 0, first: null, last: null, builds: [] });
  });

  test("slow-statement lines: durations and cancellations only, whitespace folded", () => {
    const log = [
      "2026-10-28 18:00:01 UTC [61] LOG:  duration: 3912.114 ms  execute s1: WITH w AS (\n",
      "2026-10-28 18:00:02 UTC [61] LOG:  checkpoint starting: time",
      "2026-10-28 18:00:09 UTC [62] ERROR:  canceling statement due to statement timeout",
    ].join("\n");
    expect(slowStatementLines(log)).toEqual([
      "2026-10-28 18:00:01 UTC [61] LOG: duration: 3912.114 ms execute s1: WITH w AS (",
      "2026-10-28 18:00:09 UTC [62] ERROR: canceling statement due to statement timeout",
    ]);
  });
});
