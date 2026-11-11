// `csvb serve` and `csvb stale` (issue 1608): the scheduled backup, against a real Postgres in Docker and a bare git
// remote on disk (never the real robotmoney/csv-backups). The clock is injected (`nowMs`), the rows are stamped on a
// synthetic calendar, and a test database is a primary, so `requireReplica` is off except where a test proves the
// real default refuses a primary.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import type { AppendOnlyTable, RevisedTable } from "../src/config.ts";
import { rssMb } from "../src/backup.ts";
import { parseEnvFile, replicaUrlFromEnvFile } from "../src/env.ts";
import { health, MIN_INTERVAL_S, newestBackupId, nextDelayS, serveBackupOptions, serveLoop, serveOnce, SERVE_MAX_SECONDS, SERVE_PAUSE_MS, staleness, type LoopOptions, type LoopState, type ServeOptions } from "../src/serve.ts";
import { startPg, type TestPg } from "./pg.ts";

let pg: TestPg;
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "csvb-serve-"));
  dirs.push(d);
  return d;
};
const DAY = 86_400_000;
const HOUR = 3_600_000;
const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const D0 = Date.UTC(2026, 1, 1);
const idOf = (ms: number): string => `${new Date(ms).toISOString().slice(0, 10)}T000000Z`;

const tableOf = (name: string): { ao: AppendOnlyTable; rev: RevisedTable } => ({
  ao: {
    name,
    time: { column: "created_at" },
    select: "id, name, convert_from(payload_bytes, 'UTF8') AS payload_json, encode(sha256(payload_bytes), 'hex') AS payload_sha256, ok, created_at",
    pageRows: 50,
    hashed: [{ text: "payload_json", sha256: "payload_sha256" }],
  },
  rev: { name: `${name}_rev`, select: "*", key: ["k"], orderBy: "k" },
});
async function makeTables(name: string): Promise<void> {
  await pg.sql.unsafe(`
    CREATE TABLE ${name} (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, payload_bytes bytea NOT NULL, ok boolean, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE ${name}_rev (k text PRIMARY KEY, grp int, v text);
  `);
}
/** `n` rows stamped during the UTC day `dayMs`. */
async function addRows(name: string, dayMs: number, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await pg.sql.unsafe(`INSERT INTO ${name} (name, payload_bytes, ok, created_at) VALUES ($1, $2, $3, $4)`, [`n${i}`, Buffer.from(JSON.stringify({ day: dayMs, i }), "utf8"), i % 2 === 0, new Date(dayMs + 12 * HOUR + i * 1000).toISOString()]);
  }
}

/** A bare remote seeded with a README and stray tooling (a package.json and a script that would drop a marker if run). */
function bareRemote(): { remote: string; marker: string } {
  const root = tmp();
  const remote = join(root, "remote.git");
  const marker = join(root, "RAN-FROM-THE-CLONE");
  gitIn(root, "init", "--bare", "-b", "main", remote);
  const seed = join(root, "seed");
  gitIn(root, "clone", "--quiet", remote, seed);
  mkdirSync(join(seed, "src"));
  writeFileSync(join(seed, "README.md"), "data only\n");
  writeFileSync(join(seed, "package.json"), '{"name":"old-tooling","scripts":{"postinstall":"echo ran"}}\n');
  writeFileSync(join(seed, "src", "index.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  gitIn(seed, "add", "README.md", "package.json", "src/index.ts");
  gitIn(seed, "commit", "--quiet", "-m", "seed");
  gitIn(seed, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  return { remote, marker };
}

const remoteRef = (remote: string): string => gitIn(remote, "rev-parse", "refs/heads/main");
const remoteTree = (remote: string): string => gitIn(remote, "ls-tree", "-r", "main");
const csvIds = (repo: string): string[] => (existsSync(join(repo, "csv")) ? readdirSync(join(repo, "csv")).sort() : []);

interface Env {
  remote: string;
  marker: string;
  repo: string;
  opts: (nowMs: number, extra?: Partial<ServeOptions>) => ServeOptions;
}
function env(name: string): Env {
  const { remote, marker } = bareRemote();
  const repo = join(tmp(), "clone");
  const { ao, rev } = tableOf(name);
  return {
    remote,
    marker,
    repo,
    opts: (nowMs, extra = {}) => ({
      repo,
      remoteUrl: remote,
      sql: pg.sql,
      nowMs: () => nowMs,
      maxRssMb: 3000,
      backup: { appendOnly: [ao], revised: [rev], pauseMs: 0, maxSeconds: 120, statementTimeoutS: 30, requireReplica: false, junction: null },
      log: () => {},
      ...extra,
    }),
  };
}

beforeAll(async () => {
  pg = await startPg();
}, 120_000);
afterAll(async () => {
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("a serve wake", () => {
  const e = env("s_a");
  let afterFirst = "";

  test("cuts one backup per sealed UTC boundary after the newest, and the remote's tree equals the clone's", async () => {
    await makeTables("s_a");
    for (let k = 0; k < 3; k++) await addRows("s_a", D0 + k * DAY, 4);
    const before = remoteRef(e.remote);
    const r = await serveOnce(e.opts(D0 + 3 * DAY + 2 * HOUR));
    expect(r.ids).toEqual([idOf(D0 + DAY), idOf(D0 + 2 * DAY), idOf(D0 + 3 * DAY)]);
    expect(r.pushed).toBe(true);
    expect(csvIds(e.repo)).toEqual(r.ids);
    expect(remoteRef(e.remote)).not.toBe(before);
    expect(remoteRef(e.remote)).toBe(gitIn(e.repo, "rev-parse", "HEAD"));
    expect(remoteTree(e.remote)).toBe(gitIn(e.repo, "ls-tree", "-r", "HEAD"));
    afterFirst = remoteRef(e.remote);
  }, 120_000);

  test("csvb verify exits 0 on a fresh clone of the remote", () => {
    const fresh = join(tmp(), "fresh");
    gitIn(tmp(), "clone", "--quiet", e.remote, fresh);
    const p = spawnSync("bun", ["run", join(import.meta.dir, "..", "src", "cli.ts"), "verify", "--repo", fresh], { encoding: "utf8" });
    expect(p.status).toBe(0);
    expect(p.stdout).toContain("matches its backup record");
  }, 120_000);

  test("the commit touches only paths under csv/, and the stray tooling in the clone is neither run nor staged", async () => {
    expect(gitIn(e.repo, "show", "--name-only", "--format=", "HEAD").split("\n").every((p) => p.startsWith("csv/"))).toBe(true);
    expect(existsSync(e.marker)).toBe(false);
    // A local edit to a tracked stray file stays unstaged and out of the next commit.
    writeFileSync(join(e.repo, "package.json"), '{"name":"edited"}\n');
    await addRows("s_a", D0 + 3 * DAY, 2);
    const r = await serveOnce(e.opts(D0 + 4 * DAY + 2 * HOUR));
    expect(r.ids).toEqual([idOf(D0 + 4 * DAY)]);
    const files = gitIn(e.repo, "show", "--name-only", "--format=", "HEAD").split("\n");
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((p) => p.startsWith("csv/"))).toBe(true);
    expect(gitIn(e.repo, "diff", "--name-only")).toBe("package.json"); // modified, and not staged
    expect(gitIn(e.repo, "diff", "--cached", "--name-only")).toBe("");
    expect(existsSync(e.marker)).toBe(false);
    gitIn(e.repo, "checkout", "--", "package.json");
    afterFirst = remoteRef(e.remote);
  }, 120_000);

  test("a boundary less than an hour old is not cut, and a wake with nothing sealed leaves the remote ref unchanged", async () => {
    await addRows("s_a", D0 + 4 * DAY, 2);
    const r = await serveOnce(e.opts(D0 + 5 * DAY + 30 * 60_000)); // the boundary is 30 minutes old
    expect(r).toEqual({ ids: [], pushed: false });
    expect(await serveOnce(e.opts(D0 + 5 * DAY + 30 * 60_000))).toEqual({ ids: [], pushed: false });
    expect(remoteRef(e.remote)).toBe(afterFirst);
    expect(csvIds(e.repo)).not.toContain(idOf(D0 + 5 * DAY));
  }, 120_000);

  test("a run whose database is not a replica adds nothing and leaves the remote unchanged", async () => {
    const now = D0 + 5 * DAY + 2 * HOUR;
    const ids = csvIds(e.repo);
    await expect(serveOnce(e.opts(now, { backup: { ...e.opts(now).backup, requireReplica: true } }))).rejects.toThrow("not a replica");
    expect(remoteRef(e.remote)).toBe(afterFirst);
    expect(csvIds(e.repo)).toEqual(ids);
    expect(gitIn(e.repo, "status", "--porcelain", "--", "csv")).toBe("");
  }, 120_000);

  test("a run over its rss cap adds nothing and leaves the remote unchanged", async () => {
    const now = D0 + 5 * DAY + 2 * HOUR;
    const ids = csvIds(e.repo);
    await expect(serveOnce(e.opts(now, { maxRssMb: 1 }))).rejects.toThrow("memory budget exceeded");
    expect(remoteRef(e.remote)).toBe(afterFirst);
    expect(csvIds(e.repo)).toEqual(ids);
    expect(gitIn(e.repo, "status", "--porcelain", "--", "csv")).toBe("");
  }, 120_000);

  test("a run whose files fail verification adds nothing, restores the clone and leaves the remote unchanged", async () => {
    const now = D0 + 5 * DAY + 2 * HOUR;
    const ids = csvIds(e.repo);
    const victim = join(e.repo, "csv", ids[0]!, "backup.json");
    writeFileSync(victim, statSync(victim).size > 0 ? "{ \"tampered\": true }\n" : "");
    await expect(serveOnce(e.opts(now))).rejects.toThrow();
    expect(remoteRef(e.remote)).toBe(afterFirst);
    expect(csvIds(e.repo)).toEqual(ids);
    expect(gitIn(e.repo, "status", "--porcelain", "--", "csv")).toBe("");
  }, 120_000);

  test("a push the remote refuses rolls the clone back and leaves the remote unchanged", async () => {
    const now = D0 + 5 * DAY + 2 * HOUR;
    const ids = csvIds(e.repo);
    const hook = join(e.repo, ".git", "hooks", "pre-push");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await expect(serveOnce(e.opts(now))).rejects.toThrow();
    rmSync(hook);
    expect(remoteRef(e.remote)).toBe(afterFirst);
    expect(csvIds(e.repo)).toEqual(ids);
    expect(gitIn(e.repo, "rev-parse", "HEAD")).toBe(afterFirst);
    expect(gitIn(e.repo, "status", "--porcelain", "--", "csv")).toBe("");
  }, 120_000);

  test("when the remote moved, the clone fast-forwards first and the remote loses no commit", async () => {
    const other = join(tmp(), "other");
    gitIn(tmp(), "clone", "--quiet", e.remote, other);
    writeFileSync(join(other, "NOTE.md"), "someone else pushed\n");
    gitIn(other, "add", "NOTE.md");
    gitIn(other, "commit", "--quiet", "-m", "note");
    gitIn(other, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    const theirs = remoteRef(e.remote);
    const r = await serveOnce(e.opts(D0 + 5 * DAY + 2 * HOUR));
    expect(r.ids).toEqual([idOf(D0 + 5 * DAY)]);
    expect(gitIn(e.remote, "merge-base", "--is-ancestor", theirs, "main")).toBe("");
    expect(gitIn(e.remote, "show", "main:NOTE.md")).toBe("someone else pushed");
    expect(remoteTree(e.remote)).toBe(gitIn(e.repo, "ls-tree", "-r", "HEAD"));
  }, 120_000);

  test("a clone that cannot fast-forward exits non-zero without a force push", async () => {
    writeFileSync(join(e.repo, "LOCAL.md"), "local only\n");
    gitIn(e.repo, "add", "LOCAL.md");
    gitIn(e.repo, "commit", "--quiet", "-m", "local only");
    const before = remoteRef(e.remote);
    await addRows("s_a", D0 + 5 * DAY, 2);
    await expect(serveOnce(e.opts(D0 + 6 * DAY + 2 * HOUR))).rejects.toThrow("no force push");
    expect(remoteRef(e.remote)).toBe(before);
  }, 120_000);
});

describe("a catch-up", () => {
  test("14 sealed boundaries are cut in one run under the serve default cap, each file under 90 MB", async () => {
    await makeTables("s_c");
    for (let k = 0; k < 14; k++) await addRows("s_c", D0 + k * DAY, 3);
    const e = env("s_c");
    const r = await serveOnce(e.opts(D0 + 14 * DAY + 2 * HOUR)); // maxRssMb: 3000, the CLI default (CSVB_MAX_RSS_MB)
    expect(r.ids.length).toBe(14);
    expect(r.pushed).toBe(true);
    expect(rssMb()).toBeLessThan(3000);
    const onRemote = gitIn(e.remote, "ls-tree", "--name-only", "main", "csv/").split("\n").map((p) => p.replace("csv/", ""));
    expect(onRemote.sort()).toEqual(r.ids);
    for (const f of readdirSync(join(e.repo, "csv"), { recursive: true, withFileTypes: true })) {
      if (f.isFile()) expect(statSync(join(f.parentPath, f.name)).size).toBeLessThan(90 * 1024 * 1024);
    }
  }, 240_000);
});

describe("the stale alarm", () => {
  const repo = join(tmp(), "stale");
  const newest = "2026-03-10T000000Z";
  const at = Date.UTC(2026, 2, 10);
  mkdirSync(join(repo, "csv", newest), { recursive: true });
  writeFileSync(join(repo, "csv", newest, "backup.json"), "{}");
  mkdirSync(join(repo, "csv", "2026-03-09T000000Z"), { recursive: true });
  writeFileSync(join(repo, "csv", "2026-03-09T000000Z", "backup.json"), "{}");

  test("the newest backup id is the newest directory holding a record", () => {
    expect(newestBackupId(repo)).toBe(newest);
    expect(newestBackupId(join(tmp(), "empty"))).toBeNull();
  });

  test("older than the stale window is stale and names the id and its age, with health 503; inside it is 200", () => {
    const old = staleness(repo, 3, at + 3 * DAY + DAY);
    expect(old.stale).toBe(true);
    expect(old.message).toContain(newest);
    expect(old.message).toContain("4.0 days");
    expect(health(repo, 3, at + 3 * DAY + DAY, null).status).toBe(503);
    expect(staleness(repo, 3, at + 3 * DAY - DAY).stale).toBe(false);
    const ok = health(repo, 3, at + 3 * DAY - DAY, null);
    expect(ok.status).toBe(200);
    expect(ok.body).toContain(newest);
  });

  test("an unprovisioned instance and a first wake in progress are held at 200 even when the clone is stale", () => {
    const stale = at + 30 * DAY;
    expect(health(repo, 3, stale, null).status).toBe(503);
    const held = health(repo, 3, stale, null, "not provisioned: no replica.env; nothing is backed up by this instance");
    expect(held.status).toBe(200);
    expect(held.body).toContain("not provisioned");
  });

  test("a clone with no backup is stale", () => {
    expect(health(join(tmp(), "none"), 3, at, null).status).toBe(503);
  });

  test("`csvb stale --max-days N` exits 0 inside the window and non-zero naming the id outside it", () => {
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const fresh = join(tmp(), "fresh");
    const today = idOf(Date.now());
    mkdirSync(join(fresh, "csv", today), { recursive: true });
    writeFileSync(join(fresh, "csv", today, "backup.json"), "{}");
    expect(spawnSync("bun", ["run", cli, "stale", "--repo", fresh, "--max-days", "3"], { encoding: "utf8" }).status).toBe(0);
    const p = spawnSync("bun", ["run", cli, "stale", "--repo", repo, "--max-days", "3"], { encoding: "utf8" });
    expect(p.status).toBe(1);
    expect(p.stderr).toContain(newest);
  });
});

describe("the scheduled backup's credential and its command", () => {
  test("the connection file holds the rm_readonly line and tokens only: csvb's reader refuses rm_owner, rm_app and doadmin lines", () => {
    const dir = tmp();
    const base = "host=replica.example\nport=25060\ndatabase=defaultdb\nsslmode=require\nrm_readonly=s3cret\n";
    const ok = join(dir, "ok.env");
    writeFileSync(ok, base);
    const good = replicaUrlFromEnvFile(ok, { strict: true });
    expect("url" in good && good.url).toContain("rm_readonly:s3cret@replica.example:25060");
    for (const line of ["rm_owner=x", "rm_app=x", "doadmin=x"]) {
      const f = join(dir, `${line.split("=")[0]}.env`);
      writeFileSync(f, base + line + "\n");
      const r = replicaUrlFromEnvFile(f, { strict: true });
      expect("refuse" in r && r.refuse).toContain(line.split("=")[0]!);
      expect(parseEnvFile(base + line)).toHaveProperty(line.split("=")[0]!);
    }
    // A hand run reads the whole ~/.env, which may hold an rm_app line.
    const hand = join(dir, "hand.env");
    writeFileSync(hand, base + "rm_app=x\n");
    expect("url" in replicaUrlFromEnvFile(hand)).toBe(true);
  });

  test("`csvb serve --once` against a primary exits non-zero, and the remote is unchanged", () => {
    const e = env("s_a");
    const before = remoteRef(e.remote);
    const p = spawnSync("bun", ["run", join(import.meta.dir, "..", "src", "cli.ts"), "serve", "--once", "--repo", e.repo, "--remote", e.remote], {
      encoding: "utf8",
      env: { ...process.env, RM_REPLICA_URL: `${pg.url}?sslmode=disable` },
    });
    expect(p.status).toBe(1);
    expect(p.stderr).toContain("not a replica");
    expect(remoteRef(e.remote)).toBe(before);
  }, 120_000);
});

// The scheduled backup is OPTIONAL and NON-GATING (D82): nothing a wake does may end the loop, crash the container
// or hurt the database. A failed backup, verify or push is caught, leaves the clone clean and is retried later.
describe("the wake loop never ends and never hurts", () => {
  test("a failed backup, then a failed verify, then a failed push: the loop survives, stays healthy-idle, retries with a bounded wait and recovers", async () => {
    await makeTables("s_l");
    for (let k = 0; k < 3; k++) await addRows("s_l", D0 + k * DAY, 3);
    const e = env("s_l");
    let clock = D0 + 3 * DAY + 2 * HOUR;
    const base = e.opts(clock);
    const loop: LoopOptions = {
      ...base,
      nowMs: () => clock,
      connect: () => postgres(pg.url, { max: 1, onnotice: () => {} }),
      provisioned: () => null,
      staleDays: 36500,
      intervalS: 1,
      healthPort: 0,
      backup: { ...base.backup, requireReplica: true }, // wake 1 refuses this primary
    };
    const state: LoopState = { lastError: null, hold: "starting: the first wake has not finished", failures: 0 };
    const delays: number[] = [];
    const refs = (): string => remoteRef(e.remote);
    let ref0 = refs();
    let wakes = 0;
    const clean = (): void => expect(gitIn(e.repo, "status", "--porcelain", "--", "csv")).toBe("");
    const after: Array<() => Promise<void> | void> = [
      // wake 1: not a replica
      () => {
        expect(state.lastError).toContain("not a replica");
        expect(refs()).toBe(ref0);
        loop.backup = { ...base.backup, requireReplica: false };
      },
      // wake 2: succeeds, pushes the 3 backups
      async () => {
        expect(state.lastError).toBeNull();
        expect(refs()).not.toBe(ref0);
        ref0 = refs();
        await addRows("s_l", D0 + 3 * DAY, 2);
        clock = D0 + 4 * DAY + 2 * HOUR;
        const victim = join(e.repo, "csv", csvIds(e.repo)[0]!, "backup.json");
        writeFileSync(victim, '{ "tampered": true }\n'); // wake 3: verify fails
      },
      // wake 3
      () => {
        expect(state.lastError).not.toBeNull();
        expect(refs()).toBe(ref0);
        clean();
        writeFileSync(join(e.repo, ".git", "hooks", "pre-push"), "#!/bin/sh\nexit 1\n", { mode: 0o755 }); // wake 4: push fails
      },
      // wake 4
      () => {
        expect(state.lastError).not.toBeNull();
        expect(refs()).toBe(ref0);
        expect(gitIn(e.repo, "rev-parse", "HEAD")).toBe(ref0);
        clean();
        rmSync(join(e.repo, ".git", "hooks", "pre-push")); // wake 5: recovers
      },
      // wake 5
      () => {
        expect(state.lastError).toBeNull();
        expect(refs()).not.toBe(ref0);
        expect(csvIds(e.repo)).toContain(idOf(D0 + 4 * DAY));
      },
    ];
    await serveLoop(loop, state, {
      stopped: () => wakes >= after.length,
      sleep: async (ms) => {
        delays.push(ms / 1000);
        const h = health(e.repo, 36500, clock, state.lastError, state.hold);
        // A failed wake never turns the container unhealthy by itself: only the stale window does (an empty clone is
        // stale, so wake 1, which cut nothing, is the one exception).
        if (wakes >= 1) expect(h.status).toBe(200);
        await after[wakes++]!();
      },
    });
    expect(wakes).toBe(5);
    // minimum interval, doubling per consecutive failure, back to the base after a success
    expect(delays).toEqual([120, 60, 120, 240, 60]);
  }, 240_000);

  test("the wait never drops under the minimum interval and never grows past the bound", () => {
    expect(nextDelayS(1, 0)).toBe(MIN_INTERVAL_S);
    expect(nextDelayS(0, 3)).toBe(MIN_INTERVAL_S * 8);
    expect(nextDelayS(3600, 1)).toBe(7200);
    expect(nextDelayS(3600, 50)).toBe(6 * 3600);
  });

  test("a wake runs on the replica only, on one connection, with a statement timeout, a real pause and a time budget; a primary is refused", async () => {
    const e = env("s_l");
    const opts = serveBackupOptions({ sql: pg.sql, repo: e.repo, maxRssMb: 3000, log: () => {} }, Date.now());
    expect(opts.requireReplica).toBe(true);
    expect(opts.pauseMs).toBe(SERVE_PAUSE_MS);
    expect(opts.pauseMs).toBeGreaterThan(0);
    expect(opts.maxSeconds).toBe(SERVE_MAX_SECONDS);
    expect(opts.maxSeconds).toBeLessThan(3600);
    expect(opts.statementTimeoutS).toBeGreaterThan(0);
    // The loop opens one connection per wake, one at a time, and a primary fails the wake without ending the loop.
    const maxes: number[] = [];
    const state: LoopState = { lastError: null, hold: null, failures: 0 };
    let wakes = 0;
    const loop: LoopOptions = {
      repo: e.repo, remoteUrl: e.remote, nowMs: () => Date.now(), maxRssMb: 3000, log: () => {},
      connect: () => {
        const s = postgres(`${pg.url}`, { max: 1, onnotice: () => {} });
        maxes.push(s.options.max as number);
        return s;
      },
      provisioned: () => null, staleDays: 3, intervalS: 1, healthPort: 0,
    };
    const delays: number[] = [];
    await serveLoop(loop, state, { stopped: () => wakes >= 2, sleep: async (ms) => { delays.push(ms / 1000); wakes++; } });
    expect(maxes).toEqual([1, 1]);
    expect(state.lastError).toContain("not a replica");
    expect(delays.every((d) => d >= MIN_INTERVAL_S)).toBe(true);
    expect(remoteRef(e.remote)).toBe(gitIn(e.remote, "rev-parse", "main"));
  }, 120_000);

  test("an instance with no credential files is idle and healthy: it connects to nothing and the loop goes on", async () => {
    const e = env("s_l");
    const state: LoopState = { lastError: null, hold: "starting", failures: 0 };
    let wakes = 0;
    const loop: LoopOptions = {
      repo: e.repo, remoteUrl: e.remote, nowMs: () => Date.now(), maxRssMb: 3000, log: () => {},
      connect: () => { throw new Error("must not connect while unprovisioned"); },
      provisioned: () => "no replica.env and no push-key", staleDays: 3, intervalS: 3600, healthPort: 0,
    };
    await serveLoop(loop, state, { stopped: () => wakes >= 2, sleep: async () => { wakes++; } });
    expect(state.lastError).toBeNull();
    expect(health(e.repo, 3, Date.now(), state.lastError, state.hold).status).toBe(200);
    expect(existsSync(e.repo)).toBe(false); // not even cloned
  });

  test("wakes never overlap: a second wake while one holds the lock does nothing and fails loudly", async () => {
    const e = env("s_l");
    mkdirSync(join(e.repo, ".."), { recursive: true });
    writeFileSync(`${e.repo}.lock`, String(process.pid)); // this process is alive: the lock is held
    await expect(serveOnce(e.opts(D0 + 3 * DAY + 2 * HOUR))).rejects.toThrow("another wake holds the lock");
    expect(existsSync(e.repo)).toBe(false);
    writeFileSync(`${e.repo}.lock`, "2147483646"); // a dead holder is taken over
    const r = await serveOnce(e.opts(D0 + 3 * DAY + 2 * HOUR));
    expect(r.pushed).toBe(true);
    expect(existsSync(`${e.repo}.lock`)).toBe(false);
  }, 120_000);
});
