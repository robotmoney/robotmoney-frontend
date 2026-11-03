// The writer half of format 1 (issue 1477): the functions csvb (packages/csvb) and the public archive routes both
// write with. Pure: every case runs in memory. The two writers agreeing byte for byte on a real database is
// backend/tests/csvb-api-archive-parity.test.ts; this file pins the rules themselves.
import { describe, expect, test } from "bun:test";
import {
  APPEND_ONLY_TABLES,
  BACKUP_ID_RE,
  backupIdOfDay,
  backupInstantMs,
  DataFileNamer,
  dataFileName,
  DAY_CUT_ID_RE,
  DAY_MS,
  dbTimeText,
  encodeCsvRow,
  firstBoundaryMs,
  junctionApplies,
  lastSealedDayMs,
  MAX_PART_BYTES,
  parseCopyCsv,
  parseCsvRow,
  parseDbTime,
  planCuts,
  REVISED_TABLES,
  SETTLE_MS,
  splitCsv,
  stamp,
  startsNewPart,
  type Junction,
} from "../src/archive/format1.ts";
import { LEGACY_BACKUP_IDS, LEGACY_JUNCTION } from "../src/archive/format1-legacy.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("COPY CSV rows", () => {
  const values: (string | null)[] = [null, "", "plain", 'q"uote', "a,b", "line\nbreak", "cr\r\nlf", "é 😀", " sp ", "\\.", "null"];

  test("encode writes COPY's dialect: NULL bare, the empty string quoted, specials quoted with doubled quotes", () => {
    expect(encodeCsvRow(values)).toBe(',"",plain,"q""uote","a,b","line\nbreak","cr\r\nlf",é 😀, sp ,\\.,null\n');
    expect(encodeCsvRow([])).toBe("\n");
  });

  test("encode then parse round-trips every value, NULL and the empty string apart; the whole-document reader agrees", () => {
    expect(parseCsvRow(enc.encode(encodeCsvRow(values)))).toEqual(values);
    expect(parseCsvRow(enc.encode("a,"))).toEqual(["a", null]);
    const doc = encodeCsvRow(values.map((_, i) => `c${i}`)) + encodeCsvRow(values) + encodeCsvRow(values.slice().reverse());
    const parsed = parseCopyCsv(doc);
    expect(parsed.rows).toEqual([values, values.slice().reverse()]);
    expect(() => parseCsvRow(enc.encode('a"b'))).toThrow("a quote inside an unquoted field");
    expect(() => parseCsvRow(enc.encode('"open'))).toThrow("unterminated");
  });
});

describe("part splitting", () => {
  const header = encodeCsvRow(["id", "v"]);
  const rows = Array.from({ length: 40 }, (_, i) => encodeCsvRow([String(i + 1), i % 5 === 0 ? `multi\nline, "${i}"` : "x".repeat(i)]));

  async function split(max: number, chunk: number) {
    const all = enc.encode(header + rows.join(""));
    async function* source() {
      for (let i = 0; i < all.length; i += chunk) yield all.subarray(i, i + chunk);
    }
    const parts: string[] = [];
    const r = await splitCsv(source(), {
      maxPartBytes: max,
      openPart: () => {
        const bufs: Uint8Array[] = [];
        return {
          write: (b) => void bufs.push(b),
          close: async ({ dataRows }) => {
            parts.push(bufs.map((b) => dec.decode(b)).join(""));
            return dataRows;
          },
        };
      },
    });
    return { parts, r };
  }

  test("every part starts with the header, stays under the bound unless one row alone exceeds it, and rows are never cut", async () => {
    for (const chunk of [1, 7, 4096]) {
      const { parts, r } = await split(200, chunk);
      expect(r.rows).toBe(rows.length);
      expect(parts.length).toBeGreaterThan(3);
      for (const p of parts) {
        expect(p.startsWith(header)).toBe(true);
        const n = enc.encode(p).length;
        const one = p.slice(header.length);
        if (n > 200) expect(rows).toContain(one); // only a single oversize row exceeds the bound
      }
      expect(parts.map((p) => p.slice(header.length)).join("")).toBe(rows.join(""));
      expect(r.parts.reduce((a: number, b) => a + (b as number), 0)).toBe(rows.length);
    }
  });

  test("the streaming splitter and a writer's own loop cut at the same rows (startsNewPart)", async () => {
    const { parts } = await split(300, 13);
    // A writer that encodes rows itself (csvb's RangeWriter, the archive store) and applies the rule row by row.
    const mine: string[] = [];
    let cur = "";
    let partRows = 0;
    for (const row of rows) {
      const n = enc.encode(row).length;
      if (startsNewPart(partRows, enc.encode(cur).length, n, 300)) {
        mine.push(cur);
        cur = "";
        partRows = 0;
      }
      if (cur === "") cur = header;
      cur += row;
      partRows += 1;
    }
    mine.push(cur);
    expect(mine).toEqual(parts);
    expect(startsNewPart(0, 10, 10 ** 9, 100)).toBe(false); // a first row is always taken, however large
    expect(MAX_PART_BYTES).toBe(64 * 1024 * 1024);
  });
});

describe("names", () => {
  test("database times parse to the microsecond and stamp to the second, rounding down", () => {
    expect(parseDbTime("2026-09-21 01:59:32.748478+00")).toBe(BigInt(Date.UTC(2026, 8, 21, 1, 59, 32)) * 1000n + 748478n);
    expect(parseDbTime("2026-09-21T01:59:32Z")).toBe(BigInt(Date.UTC(2026, 8, 21, 1, 59, 32)) * 1000n);
    expect(stamp(parseDbTime("2026-09-21 01:59:32.999999+00"))).toBe("2026-09-21T015932Z");
    expect(() => parseDbTime("2026-09-21 01:59:32+02")).toThrow("not a UTC timestamp");
  });

  test("a data file is named by its rows' period, late rows say so, and a repeated name gets -2, -3", () => {
    expect(dataFileName("t", false, "2026-01-01 00:00:00+00", "2026-01-02 03:04:05.6+00")).toBe("t.2026-01-01T000000Z_2026-01-02T030405Z.csv.gz");
    expect(dataFileName("t", true, "2026-01-01 00:00:00+00", "2026-01-01 00:00:00+00", 2)).toBe("t.late.2026-01-01T000000Z_2026-01-01T000000Z-2.csv.gz");
    const namer = new DataFileNamer("t");
    const a = "2026-01-01 00:00:00+00";
    expect([namer.next(a, a), namer.next(a, a), namer.next(a, "2026-01-01 00:00:01+00"), namer.next(a, a)]).toEqual([
      "t.2026-01-01T000000Z_2026-01-01T000000Z.csv.gz",
      "t.2026-01-01T000000Z_2026-01-01T000000Z-2.csv.gz",
      "t.2026-01-01T000000Z_2026-01-01T000001Z.csv.gz",
      "t.2026-01-01T000000Z_2026-01-01T000000Z-3.csv.gz",
    ]);
  });

  test("backup ids: both shapes are format 1 ids; only midnights are day cuts", () => {
    for (const id of ["2026-10-19T202421Z", "2026-10-20T000000Z"]) expect(BACKUP_ID_RE.test(id)).toBe(true);
    expect(DAY_CUT_ID_RE.test("2026-10-20T000000Z")).toBe(true);
    expect(DAY_CUT_ID_RE.test("2026-10-19T202421Z")).toBe(false);
    expect(backupIdOfDay(Date.UTC(2026, 9, 20))).toBe("2026-10-20T000000Z");
    expect(backupInstantMs("2026-10-19T202421Z")).toBe(Date.UTC(2026, 9, 19, 20, 24, 21));
    expect(dbTimeText(backupInstantMs("2026-10-20T000000Z"))).toBe("2026-10-20 00:00:00+00");
  });
});

describe("the backup cut rule", () => {
  const D = (iso: string) => Date.parse(iso);

  test("a boundary is sealed one settle hour after it; the first boundary is the midnight after the earliest row", () => {
    expect(SETTLE_MS).toBe(3_600_000);
    expect(lastSealedDayMs(D("2026-10-20T00:59:59.999Z"))).toBe(D("2026-10-19T00:00:00Z"));
    expect(lastSealedDayMs(D("2026-10-20T01:00:00Z"))).toBe(D("2026-10-20T00:00:00Z"));
    expect(firstBoundaryMs(parseDbTime("2026-10-05 23:59:59.999999+00"))).toBe(D("2026-10-06T00:00:00Z"));
    expect(firstBoundaryMs(parseDbTime("2026-10-06 00:00:00+00"))).toBe(D("2026-10-07T00:00:00Z"));
  });

  test("every sealed day from the first, only those after the newest held, and none before any row exists", () => {
    const first = D("2026-10-17T00:00:00Z");
    const now = D("2026-10-20T05:00:00Z");
    const ids = (after?: string) => planCuts({ firstDayMs: first, nowMs: now, junction: null, rowsFollowJunction: false, after }).map((c) => c.id);
    expect(ids()).toEqual(["2026-10-17T000000Z", "2026-10-18T000000Z", "2026-10-19T000000Z", "2026-10-20T000000Z"]);
    expect(ids("2026-10-18T000000Z")).toEqual(["2026-10-19T000000Z", "2026-10-20T000000Z"]);
    expect(ids("2026-10-20T000000Z")).toEqual([]);
    expect(planCuts({ firstDayMs: null, nowMs: now, junction: null, rowsFollowJunction: true })).toEqual([]);
    const c = planCuts({ firstDayMs: first, nowMs: now, junction: null, rowsFollowJunction: false })[1]!;
    expect(c).toEqual({ id: "2026-10-18T000000Z", kind: "day", boundaryMs: D("2026-10-18T00:00:00Z") });
  });

  test("the junction is one extra cut in its place, only once a sealed day lies past it and rows follow it", () => {
    const j: Junction = { id: "2026-10-19T202421Z", watermarks: { t: "5" } };
    const first = D("2026-10-18T00:00:00Z");
    const plan = (now: string, follow: boolean, after?: string) => planCuts({ firstDayMs: first, nowMs: D(now), junction: j, rowsFollowJunction: follow, after }).map((c) => `${c.kind}:${c.id}`);
    expect(plan("2026-10-21T02:00:00Z", true)).toEqual(["day:2026-10-18T000000Z", "day:2026-10-19T000000Z", "junction:2026-10-19T202421Z", "day:2026-10-20T000000Z", "day:2026-10-21T000000Z"]);
    // Not yet past it (the next midnight is not sealed): no junction.
    expect(plan("2026-10-20T00:30:00Z", true)).toEqual(["day:2026-10-18T000000Z", "day:2026-10-19T000000Z"]);
    expect(junctionApplies(j, D("2026-10-20T00:30:00Z"), true)).toBe(false);
    expect(junctionApplies(j, D("2026-10-20T01:00:00Z"), true)).toBe(true);
    // No rows after it: a plain day-cut chain.
    expect(plan("2026-10-21T02:00:00Z", false)).toEqual(["day:2026-10-18T000000Z", "day:2026-10-19T000000Z", "day:2026-10-20T000000Z", "day:2026-10-21T000000Z"]);
    // A repo whose newest backup is the junction continues with the next day cut.
    expect(plan("2026-10-21T02:00:00Z", true, j.id)).toEqual(["day:2026-10-20T000000Z", "day:2026-10-21T000000Z"]);
    const cut = planCuts({ firstDayMs: first, nowMs: D("2026-10-21T02:00:00Z"), junction: j, rowsFollowJunction: true })[2]!;
    expect(cut).toEqual({ id: j.id, kind: "junction", watermarks: { t: "5" } });
    expect(DAY_MS).toBe(86_400_000);
  });
});

describe("the table catalog and the legacy junction", () => {
  test("the catalog names each table once, times every append-only table, and keys every revised table", () => {
    const names = [...APPEND_ONLY_TABLES.map((t) => t.name), ...REVISED_TABLES.map((t) => t.name)];
    expect(new Set(names).size).toBe(names.length);
    for (const t of APPEND_ONLY_TABLES) {
      const time = t.time;
      if ("lookup" in time) expect(APPEND_ONLY_TABLES.findIndex((x) => x.name === time.lookup.table)).toBeLessThan(APPEND_ONLY_TABLES.indexOf(t)); // its lookup is cut first
    }
    for (const t of REVISED_TABLES) expect(t.key.length).toBeGreaterThan(0);
    expect(APPEND_ONLY_TABLES.filter((t) => !t.served).map((t) => t.name)).toEqual(["analytics_ledger_run_events", "analytics_parity_observations"]);
  });

  test("the junction is the newest legacy id, every legacy id is a snapshot time, and it names a watermark for every append-only table", () => {
    expect(LEGACY_BACKUP_IDS.length).toBe(9);
    expect([...LEGACY_BACKUP_IDS].sort()).toEqual([...LEGACY_BACKUP_IDS]);
    for (const id of LEGACY_BACKUP_IDS) {
      expect(BACKUP_ID_RE.test(id)).toBe(true);
      expect(DAY_CUT_ID_RE.test(id)).toBe(false);
    }
    expect(LEGACY_JUNCTION.id as string).toBe(LEGACY_BACKUP_IDS[LEGACY_BACKUP_IDS.length - 1]!);
    expect(Object.keys(LEGACY_JUNCTION.watermarks).sort()).toEqual(APPEND_ONLY_TABLES.map((t) => t.name).sort());
    for (const wm of Object.values(LEGACY_JUNCTION.watermarks)) expect(wm).toMatch(/^[1-9]\d*$/);
  });
});
