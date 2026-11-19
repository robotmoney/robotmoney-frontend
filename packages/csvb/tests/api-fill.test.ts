// `csvb backup --source api` (issue 1436) against a fake public archive that replays the recording of the real
// routes (packages/analyst-sdk/tests/fixtures/archive/api-recorded/). No database, no network: the fill gets an
// in-process fetch and a fake clock, except the command-line cases, which spawn the CLI against a local HTTP server.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  PUBLIC_ANALYTICS_BYTES_PER_MINUTE,
  PUBLIC_ANALYTICS_HEAVY_COST,
  PUBLIC_ANALYTICS_LIST_COST,
  PUBLIC_ANALYTICS_TOKENS_PER_MINUTE,
} from "../../../contract/src/public-analytics.js";
import pkg from "../package.json" with { type: "json" };
import { apiFill, MAX_RETRIES, Pacer, TMP_DIR, USER_AGENT, type ApiFillOptions } from "../src/api-fill.ts";
import { verifyRepo } from "../src/verify.ts";

const RECORDING = join(import.meta.dir, "../../analyst-sdk/tests/fixtures/archive/api-recorded");
const CLI = join(import.meta.dir, "../src/cli.ts");
const PREFIX = "/api/public/analytics/archive/";
const B1 = "2001-01-02T000000Z";
const B2 = "2001-01-03T000000Z";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true }); // the directories this suite made, never a parent
});
const newRepo = (): string => {
  const d = mkdtempSync(join(tmpdir(), "csvb-api-fill-"));
  dirs.push(d);
  return join(d, "repo");
};

/** Every file of the recording, relative to it (backups.json excluded). */
function recordedFiles(): string[] {
  return (readdirSync(join(RECORDING, "csv"), { recursive: true }) as string[]).map((f) => `csv/${f}`).filter((f) => /\.(gz|json)$/.test(f)).sort();
}
const repoFiles = (repo: string): string[] => (existsSync(join(repo, "csv")) ? (readdirSync(join(repo, "csv"), { recursive: true }) as string[]).map((f) => `csv/${f}`).filter((f) => /\.(gz|json)$/.test(f)).sort() : []);
const filesOfBackup = (id: string): string[] => recordedFiles().filter((f) => f.startsWith(`csv/${id}/data/`));

interface Req {
  path: string;
  at: number;
  ua: string | null;
}

/** A fake clock: `sleep` advances it. Records every sleep. */
function fakeClock(start = Date.UTC(2026, 10, 19)) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

/**
 * The fake archive: the recording's list, records and files. `plant(path, n)` may answer the n-th request (from 1)
 * for a path instead; `record(id, rec)` may rewrite a record before it is served.
 */
function fakeArchive(clock: ReturnType<typeof fakeClock>, opts: { plant?: (path: string, n: number) => Response | Error | undefined; record?: (rec: any) => void; latencyMs?: number } = {}) {
  const requests: Req[] = [];
  const seen = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const path = u.pathname + u.search;
    requests.push({ path, at: clock.now(), ua: new Headers(init.headers).get("user-agent") });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (opts.latencyMs) clock.advance(opts.latencyMs);
      await Promise.resolve();
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const n = (seen.get(u.pathname) ?? 0) + 1;
      seen.set(u.pathname, n);
      const planted = opts.plant?.(u.pathname, n);
      if (planted instanceof Error) throw planted;
      if (planted) return planted;
      if (!u.pathname.startsWith(PREFIX)) return new Response("not found", { status: 404 });
      const rel = u.pathname.slice(PREFIX.length);
      if (rel === "backups") return new Response(readFileSync(join(RECORDING, "backups.json")), { headers: { "Content-Type": "application/json" } });
      const file = join(RECORDING, rel);
      if (rel.includes("..") || !existsSync(file)) return new Response("not found", { status: 404 });
      if (rel.endsWith("backup.json") && opts.record) {
        const rec = JSON.parse(readFileSync(file, "utf8"));
        opts.record(rec);
        return new Response(JSON.stringify(rec), { headers: { "Content-Type": "application/json" } });
      }
      return new Response(readFileSync(file));
    } finally {
      inFlight -= 1;
    }
  };
  return { fetch, requests, maxInFlight: () => maxInFlight, bodies: () => requests.filter((r) => r.path.endsWith(".csv.gz") || r.path.endsWith("backup.json")) };
}

function fill(repo: string, clock: ReturnType<typeof fakeClock>, server: ReturnType<typeof fakeArchive>, extra: Partial<ApiFillOptions> = {}) {
  return apiFill({ repo, api: "http://archive.test", fetch: server.fetch, now: clock.now, sleep: clock.sleep, random: () => 0.5, log: () => {}, ...extra });
}

const sameAsRecording = (repo: string, files: string[]) => {
  for (const f of files) expect(readFileSync(join(repo, f)).equals(readFileSync(join(RECORDING, f))), f).toBe(true);
};

describe("csvb backup --source api: the command line", () => {
  const run = (args: string[], env: Record<string, string> = {}) => {
    const p = Bun.spawnSync(["bun", CLI, "backup", ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  };

  test("--source api refuses each replica-only option, and --source db refuses --max-requests, with exit 2 naming the option", () => {
    const repo = newRepo();
    for (const [f, v] of [["--env-file", "x.env"], ["--statement-timeout-s", "9"], ["--part-mb", "4"], ["--only", "analytics_ledger_runs"]]) {
      const r = run(["--source", "api", "--repo", repo, f!, v!]);
      expect(r.code, `${f}: ${r.stderr}`).toBe(2);
      expect(r.stderr).toContain(f!);
    }
    const db = run(["--source", "db", "--repo", repo, "--max-requests", "5"]);
    expect(db.code).toBe(2);
    expect(db.stderr).toContain("--max-requests");
    const bad = run(["--source", "ftp", "--repo", repo]);
    expect(bad.code).toBe(2);
    expect(existsSync(repo)).toBe(false);
  });

  test("csvb backup without --source is the database backup: it connects to the replica and touches no API", () => {
    const repo = newRepo();
    // A closed port: the database backup announces its connection, then fails to connect (exit 1).
    const r = run(["--repo", repo], { RM_REPLICA_URL: "postgres://rm_readonly:x@127.0.0.1:9/robotmoney?sslmode=disable" });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("connecting as");
    expect(r.stdout + r.stderr).not.toContain("archive");
    expect(existsSync(join(repo, "csv"))).toBe(false);
  });

  test("every request carries the User-Agent csvb/<package version>, and the request cap exits 3 through the CLI", async () => {
    expect(USER_AGENT).toBe(`csvb/${pkg.version}`);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    const agents: (string | null)[] = [];
    const clock = fakeClock();
    const archive = fakeArchive(clock);
    const srv = Bun.serve({
      port: 0,
      async fetch(req) {
        agents.push(req.headers.get("user-agent"));
        const u = new URL(req.url);
        return archive.fetch(`http://archive.test${u.pathname}${u.search}`, { headers: req.headers });
      },
    });
    try {
      const repo = newRepo();
      const p = Bun.spawn(["bun", CLI, "backup", "--source", "api", "--repo", repo, "--api", `http://127.0.0.1:${srv.port}`, "--max-requests", "3"], { stdout: "pipe", stderr: "pipe" });
      const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      expect(code, out).toBe(3);
      expect(out).toContain("remain");
      expect(agents.length).toBe(3);
      for (const a of agents) expect(a).toBe(`csvb/${pkg.version}`);
      expect(existsSync(join(repo, TMP_DIR))).toBe(false);
    } finally {
      srv.stop(true);
    }
    // The in-process fill sends it on every request too, retries included.
    const c2 = fakeClock();
    const a2 = fakeArchive(c2, { plant: (p, n) => (p.endsWith("backup.json") && n === 1 ? new Response("busy", { status: 503, headers: { "Retry-After": "2" } }) : undefined) });
    await fill(newRepo(), c2, a2);
    expect(a2.requests.length).toBeGreaterThan(recordedFiles().length);
    for (const r of a2.requests) expect(r.ua).toBe(USER_AGENT);
  }, 60_000);
});

describe("csvb backup --source api: what it fetches", () => {
  test("an empty repo fills every listed backup, byte for byte, and csvb verify passes", async () => {
    const repo = newRepo();
    const clock = fakeClock();
    const archive = fakeArchive(clock);
    const r = await fill(repo, clock, archive);
    expect(r).toEqual({ added: [B1, B2], status: "complete", remaining: 0 });
    expect(repoFiles(repo)).toEqual(recordedFiles());
    sameAsRecording(repo, recordedFiles());
    expect(await verifyRepo({ root: repo })).toEqual([]);
    // Only the two archive routes: the list once, each record once, each file once.
    expect(archive.requests.map((q) => q.path)).toEqual([`${PREFIX}backups?limit=1000`, ...[B1, B2].flatMap((id) => [`${PREFIX}csv/${id}/backup.json`, ...orderedFiles(id).map((f) => `${PREFIX}${f}`)])]);
    expect(existsSync(join(repo, TMP_DIR))).toBe(false);
    // A second run fetches nothing but the list.
    const again = fakeArchive(clock);
    expect((await fill(repo, clock, again)).added).toEqual([]);
    expect(again.requests.map((q) => q.path)).toEqual([`${PREFIX}backups?limit=1000`]);
  });

  test("the list is paged by nextCursor, oldest first", async () => {
    const repo = newRepo();
    const clock = fakeClock();
    const archive = fakeArchive(clock);
    // Serve the list in two pages.
    const paged = async (url: string, init: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === `${PREFIX}backups`) {
        archive.requests.push({ path: u.pathname + u.search, at: clock.now(), ua: null });
        const cursor = u.searchParams.get("cursor");
        const page = cursor === null ? { backups: [{ backup: B1, record: `csv/${B1}/backup.json` }], nextCursor: B1 } : { backups: [{ backup: B2, record: `csv/${B2}/backup.json` }], nextCursor: null };
        return Response.json({ schemaVersion: 1, limit: 1000, format: 1, ...page });
      }
      return archive.fetch(url, init);
    };
    const r = await fill(repo, clock, archive, { fetch: paged });
    expect(r.added).toEqual([B1, B2]);
    expect(archive.requests.slice(0, 2).map((q) => q.path)).toEqual([`${PREFIX}backups?limit=1000`, `${PREFIX}backups?limit=1000&cursor=${B1}`]);
    expect(await verifyRepo({ root: repo })).toEqual([]);
  });

  test("a repo holding the first backup fetches only the later ones", async () => {
    const repo = newRepo();
    mkdirSync(join(repo, "csv"), { recursive: true });
    cpSync(join(RECORDING, "csv", B1), join(repo, "csv", B1), { recursive: true });
    const clock = fakeClock();
    const archive = fakeArchive(clock);
    expect((await fill(repo, clock, archive)).added).toEqual([B2]);
    expect(archive.requests.filter((q) => q.path.includes(B1))).toEqual([]);
    expect(archive.requests.filter((q) => q.path.includes(`${B2}/data/`)).length).toBe(filesOfBackup(B2).length);
    expect(repoFiles(repo)).toEqual(recordedFiles());
    expect(await verifyRepo({ root: repo })).toEqual([]);
  });

  test("a repo holding a backup id the list lacks exits 1 naming that id, with zero body requests", async () => {
    const repo = newRepo();
    mkdirSync(join(repo, "csv"), { recursive: true });
    cpSync(join(RECORDING, "csv", B1), join(repo, "csv", "2000-12-31T000000Z"), { recursive: true });
    const clock = fakeClock();
    const archive = fakeArchive(clock);
    await expect(fill(repo, clock, archive)).rejects.toThrow("2000-12-31T000000Z");
    expect(archive.bodies()).toEqual([]);
    expect(archive.requests.map((q) => q.path)).toEqual([`${PREFIX}backups?limit=1000`]);
    expect(existsSync(join(repo, "csv", B1))).toBe(false);
  });

  test("the fill refuses a --repo inside a robotmoney-frontend checkout", async () => {
    const clock = fakeClock();
    const archive = fakeArchive(clock);
    await expect(fill(join(import.meta.dir, "no-such-repo"), clock, archive)).rejects.toThrow(/inside the robotmoney-frontend checkout/);
    expect(archive.requests).toEqual([]);
  });

  test("a record path that leaves its backup is refused before any file is fetched", async () => {
    const clock = fakeClock();
    const archive = fakeArchive(clock, {
      record: (rec) => {
        rec.append_only.source_value_versions.files[0].path = `csv/${B1}/data/../../escaped.csv.gz`;
      },
    });
    const repo = newRepo();
    await expect(fill(repo, clock, archive)).rejects.toThrow(/bad path/);
    expect(archive.requests.filter((q) => q.path.endsWith(".csv.gz"))).toEqual([]);
    expect(existsSync(join(repo, "csv", B1))).toBe(false);
  });
});

/** The data files of a backup in the order its record lists them. */
function orderedFiles(id: string): string[] {
  const rec = JSON.parse(readFileSync(join(RECORDING, `csv/${id}/backup.json`), "utf8"));
  return [...Object.values(rec.append_only as Record<string, { files: { path: string }[] }>).flatMap((t) => t.files.map((f) => f.path)), ...Object.values(rec.revisions as Record<string, { file: { path: string } | null }>).flatMap((t) => (t.file ? [t.file.path] : []))];
}

describe("csvb backup --source api: verification and atomic writes", () => {
  const target = () => orderedFiles(B2)[1]!;

  for (const [name, edit] of [
    ["sha256_raw", (f: any) => (f.sha256_raw = "0".repeat(64))],
    ["bytes_raw", (f: any) => (f.bytes_raw -= 1)],
    ["bytes_gz", (f: any) => (f.bytes_gz = 7)],
    ["rows", (f: any) => (f.rows += 1)],
  ] as const) {
    test(`a file whose ${name} does not match is refetched; after ${MAX_RETRIES} failed retries the run fails, with no directory for that backup and earlier backups intact`, async () => {
      const repo = newRepo();
      const clock = fakeClock();
      const archive = fakeArchive(clock, {
        record: (rec) => {
          if (rec.backup !== B2) return;
          for (const t of Object.values(rec.append_only) as { files: { path: string }[] }[]) for (const f of t.files) if (f.path === target()) edit(f);
        },
      });
      await expect(fill(repo, clock, archive)).rejects.toThrow(target());
      expect(archive.requests.filter((q) => q.path === `${PREFIX}${target()}`).length).toBe(MAX_RETRIES + 1);
      expect(existsSync(join(repo, "csv", B2))).toBe(false);
      expect(existsSync(join(repo, TMP_DIR))).toBe(false);
      expect(repoFiles(repo)).toEqual(recordedFiles().filter((f) => f.startsWith(`csv/${B1}/`)));
      expect(await verifyRepo({ root: repo })).toEqual([]);
    });
  }

  test("a corrupt body that is served right on a retry is kept", async () => {
    const repo = newRepo();
    const clock = fakeClock();
    const bad = gzipSync(Buffer.from("not the file\n"));
    const archive = fakeArchive(clock, { plant: (p, n) => (p === `${PREFIX}${target()}` && n <= 2 ? new Response(bad) : undefined) });
    expect((await fill(repo, clock, archive)).added).toEqual([B1, B2]);
    expect(archive.requests.filter((q) => q.path === `${PREFIX}${target()}`).length).toBe(3);
    sameAsRecording(repo, recordedFiles());
    expect(await verifyRepo({ root: repo })).toEqual([]);
  });

  test("an interrupt during a backup leaves no temporary or partial directory, and a rerun completes it", async () => {
    const repo = newRepo();
    const clock = fakeClock();
    const ac = new AbortController();
    const second = orderedFiles(B1)[1]!;
    const archive = fakeArchive(clock, {
      plant: (p) => {
        if (p === `${PREFIX}${second}`) ac.abort("SIGINT");
        return undefined;
      },
    });
    await expect(fill(repo, clock, archive, { signal: ac.signal })).rejects.toThrow(/interrupted/);
    expect(existsSync(join(repo, TMP_DIR))).toBe(false);
    expect(repoFiles(repo)).toEqual([]);
    const again = fakeArchive(clock);
    expect((await fill(repo, clock, again)).added).toEqual([B1, B2]);
    expect(repoFiles(repo)).toEqual(recordedFiles());
    expect(await verifyRepo({ root: repo })).toEqual([]);
  });
});

describe("csvb backup --source api: pacing and retries", () => {
  test("under a fake clock: one request in flight, starts at least 1 s apart, budgets never exceeded in any minute", async () => {
    const repo = newRepo();
    const clock = fakeClock();
    const archive = fakeArchive(clock, { latencyMs: 300 });
    await fill(repo, clock, archive);
    expect(archive.maxInFlight()).toBe(1);
    const starts = archive.requests.map((r) => r.at);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(1000);
    const cost = (p: string) => (p.endsWith(".csv.gz") ? PUBLIC_ANALYTICS_HEAVY_COST : PUBLIC_ANALYTICS_LIST_COST);
    for (const r of archive.requests) {
      const inMinute = archive.requests.filter((q) => q.at > r.at - 60_000 && q.at <= r.at);
      expect(inMinute.reduce((n, q) => n + cost(q.path), 0)).toBeLessThanOrEqual(PUBLIC_ANALYTICS_TOKENS_PER_MINUTE);
    }
  });

  test("the pacer holds the token and byte budgets of @robotmoney/contract in every sliding minute", async () => {
    const clock = fakeClock();
    const pacer = new Pacer(clock.now, clock.sleep);
    const log: { at: number; tokens: number; bytes: number }[] = [];
    // 40 archives of 20 MB (bytes bind), then 150 list requests (tokens bind), then heavy ones (tokens bind).
    const plan = [...Array.from({ length: 40 }, () => [PUBLIC_ANALYTICS_HEAVY_COST, 20 * 1024 * 1024]), ...Array.from({ length: 150 }, () => [PUBLIC_ANALYTICS_LIST_COST, 0]), ...Array.from({ length: 30 }, () => [PUBLIC_ANALYTICS_HEAVY_COST, 1000])] as const;
    for (const [tokens, bytes] of plan) {
      const c = await pacer.before(tokens, bytes, () => false);
      log.push({ ...c });
      clock.advance(50);
    }
    let tokenBound = false;
    let byteBound = false;
    for (const e of log) {
      const win = log.filter((q) => q.at > e.at - 60_000 && q.at <= e.at);
      const tokens = win.reduce((n, q) => n + q.tokens, 0);
      const bytes = win.reduce((n, q) => n + q.bytes, 0);
      expect(tokens).toBeLessThanOrEqual(PUBLIC_ANALYTICS_TOKENS_PER_MINUTE);
      expect(bytes).toBeLessThanOrEqual(PUBLIC_ANALYTICS_BYTES_PER_MINUTE);
      if (tokens + PUBLIC_ANALYTICS_HEAVY_COST > PUBLIC_ANALYTICS_TOKENS_PER_MINUTE) tokenBound = true;
      if (bytes + 20 * 1024 * 1024 > PUBLIC_ANALYTICS_BYTES_PER_MINUTE) byteBound = true;
    }
    for (let i = 1; i < log.length; i++) expect(log[i]!.at - log[i - 1]!.at).toBeGreaterThanOrEqual(1000);
    // Red control: both budgets actually constrained the schedule.
    expect(tokenBound && byteBound).toBe(true);
  });

  const statusCase = (status: number, headers: Record<string, string> = {}) => (p: string, n: number) =>
    p.endsWith(`${B1}/backup.json`) && n === 1 ? new Response("x", { status, headers }) : undefined;

  test("a 429 or 503 waits its Retry-After, then retries", async () => {
    for (const [status, after] of [[429, "17"], [503, "5"]] as const) {
      const clock = fakeClock();
      const archive = fakeArchive(clock, { plant: statusCase(status, { "Retry-After": after }) });
      expect((await fill(newRepo(), clock, archive)).added).toEqual([B1, B2]);
      expect(clock.sleeps).toContain(Number(after) * 1000);
      const recs = archive.requests.filter((q) => q.path.endsWith(`${B1}/backup.json`));
      expect(recs.length).toBe(2);
      expect(recs[1]!.at - recs[0]!.at).toBeGreaterThanOrEqual(Number(after) * 1000);
    }
  });

  test("a 500 or a network error waits between 1 and 60 seconds, then retries", async () => {
    for (const plant of [statusCase(500), (p: string, n: number) => (p.endsWith(`${B1}/backup.json`) && n === 1 ? new TypeError("connection reset") : undefined)]) {
      for (const random of [0, 0.5, 0.999]) {
        const clock = fakeClock();
        const archive = fakeArchive(clock, { plant });
        expect((await fill(newRepo(), clock, archive, { random: () => random })).added).toEqual([B1, B2]);
        const recs = archive.requests.filter((q) => q.path.endsWith(`${B1}/backup.json`));
        expect(recs.length).toBe(2);
        const gap = recs[1]!.at - recs[0]!.at;
        expect(gap).toBeGreaterThanOrEqual(1000);
        expect(gap).toBeLessThanOrEqual(60_000);
      }
    }
    // Repeated failures back off further, never past 60 s.
    const clock = fakeClock();
    const archive = fakeArchive(clock, { plant: (p, n) => (p.endsWith(`${B1}/backup.json`) && n <= MAX_RETRIES ? new Response("x", { status: 502 }) : undefined) });
    await fill(newRepo(), clock, archive, { random: () => 0.999 });
    const backoffs = clock.sleeps.filter((s) => s > 1000);
    expect(backoffs.length).toBe(MAX_RETRIES);
    for (const s of backoffs) expect(s).toBeLessThanOrEqual(60_000);
    expect(Math.max(...backoffs)).toBeGreaterThan(30_000);
  });

  test("a 404 fails at once", async () => {
    const clock = fakeClock();
    const archive = fakeArchive(clock, { plant: statusCase(404) });
    const repo = newRepo();
    await expect(fill(repo, clock, archive)).rejects.toThrow(/HTTP 404/);
    expect(archive.requests.filter((q) => q.path.endsWith(`${B1}/backup.json`)).length).toBe(1);
    expect(repoFiles(repo)).toEqual([]);
  });

  test("a sixth consecutive failure fails the run", async () => {
    const clock = fakeClock();
    const archive = fakeArchive(clock, { plant: (p) => (p.endsWith(`${B2}/backup.json`) ? new Response("x", { status: 503, headers: { "Retry-After": "1" } }) : undefined) });
    const repo = newRepo();
    await expect(fill(repo, clock, archive)).rejects.toThrow(/failed 6 times/);
    expect(archive.requests.filter((q) => q.path.endsWith(`${B2}/backup.json`)).length).toBe(MAX_RETRIES + 1);
    expect(repoFiles(repo)).toEqual(recordedFiles().filter((f) => f.startsWith(`csv/${B1}/`)));
    // Five failures then a success is not a failure.
    const c2 = fakeClock();
    const a2 = fakeArchive(c2, { plant: (p, n) => (p.endsWith(`${B2}/backup.json`) && n <= MAX_RETRIES ? new Response("x", { status: 503, headers: { "Retry-After": "1" } }) : undefined) });
    expect((await fill(newRepo(), c2, a2)).added).toEqual([B1, B2]);
  });
});

describe("csvb backup --source api: the request cap", () => {
  test("below what the fill needs: no request past the cap (retries included), complete backups kept, no temporary directory, capped; a second run completes", async () => {
    const total = 1 + recordedFiles().length; // the list, each record, each file
    // The list, the record (one 503 then a 200), every file of B1, then the record of B2: B1 completes, B2 does not.
    const cap = 1 + 2 + filesOfBackup(B1).length + 1;
    const repo = newRepo();
    const clock = fakeClock();
    const archive = fakeArchive(clock, { plant: (p, n) => (p.endsWith(`${B1}/backup.json`) && n === 1 ? new Response("x", { status: 503, headers: { "Retry-After": "1" } }) : undefined) });
    const r = await fill(repo, clock, archive, { maxRequests: cap });
    expect(archive.requests.length).toBe(cap);
    expect(r).toEqual({ added: [B1], status: "capped", remaining: 1 });
    expect(existsSync(join(repo, TMP_DIR))).toBe(false);
    expect(repoFiles(repo)).toEqual(recordedFiles().filter((f) => f.startsWith(`csv/${B1}/`)));

    // A cap reached inside a backup: nothing of it is kept.
    const mid = fakeArchive(clock);
    expect(await fill(repo, clock, mid, { maxRequests: 3 })).toEqual({ added: [], status: "capped", remaining: 1 });
    expect(mid.requests.length).toBe(3);
    expect(existsSync(join(repo, TMP_DIR))).toBe(false);
    expect(existsSync(join(repo, "csv", B2))).toBe(false);

    const again = fakeArchive(clock);
    expect(await fill(repo, clock, again, { maxRequests: total })).toEqual({ added: [B2], status: "complete", remaining: 0 });
    expect(again.requests.filter((q) => q.path.includes(B1))).toEqual([]);
    expect(repoFiles(repo)).toEqual(recordedFiles());
    expect(await verifyRepo({ root: repo })).toEqual([]);
  });
});
