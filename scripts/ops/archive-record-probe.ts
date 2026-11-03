#!/usr/bin/env bun
// scripts/ops/archive-record-probe.ts — build public archive records against a
// throwaway restore of a production dump (issue 1514, archive record timeout).
//
//   bun scripts/ops/archive-record-probe.ts --dump <capture dir> [backup id ...]
//
// The stage-2 reproduction of 2026-10-28, committed. It restores the capture
// into a THROWAWAY local Postgres container through the repo's one restore path
// (scripts/lib/restore-container.ts, withSmokeTwinContainer: loopback bind,
// generated password, always torn down), has Postgres log every statement over
// 500 ms, then times this checkout's own recordFor for the named backups (the
// first and the newest sealed backup when none is named). Every statement of a
// build runs under publicRead's 5 s timeout, as on the api. It prints one JSON
// result on stdout: each build's time, size and SHA-256 or its error, and the
// slow or cancelled statement lines. It touches no database but its own
// container.
//
// Exit codes: 0 every build succeeded; 1 a build failed (or there is no sealed
// backup to build); 2 the probe could not run (missing files, a failed restore).
import { withSmokeTwinContainer } from "../lib/restore-container.ts";

/** What the probe needs of backend/src/analytics/store/public-archive-store.ts. */
export interface ProbeStore {
  listBackupIds(): Promise<string[]>;
  recordFor(id: string): Promise<{ bytes: Uint8Array; sha256: string }>;
}

export type ProbeBuild =
  | { backup: string; ok: true; ms: number; bytes: number; sha256: string }
  | { backup: string; ok: false; ms: number; error: string };

export interface ProbeReport {
  ok: boolean;
  backups: number;
  first: string | null;
  last: string | null;
  builds: ProbeBuild[];
  slowStatements: string[];
}

export interface ProbeDeps {
  store: ProbeStore;
  /** Backups to build; empty means the first and the newest sealed backup. */
  ids: readonly string[];
  log: (m: string) => void;
  /** The slow or cancelled statement lines the server logged, read once the builds end. */
  slowStatements: () => string[];
  now?: () => number;
}

/** Build each named record once, in order, and report what happened. A failed build never stops the next one. */
export async function probeRecords(deps: ProbeDeps): Promise<ProbeReport> {
  const now = deps.now ?? (() => Date.now());
  const all = await deps.store.listBackupIds();
  deps.log(`${all.length} sealed backups${all.length ? `: ${all[0]} .. ${all.at(-1)}` : ""}`);
  const want = deps.ids.length ? [...deps.ids] : [...new Set([all[0], all.at(-1)].filter((x): x is string => !!x))];
  const builds: ProbeBuild[] = [];
  for (const backup of want) {
    const t0 = now();
    try {
      const built = await deps.store.recordFor(backup);
      builds.push({ backup, ok: true, ms: now() - t0, bytes: built.bytes.length, sha256: built.sha256 });
    } catch (err) {
      builds.push({ backup, ok: false, ms: now() - t0, error: (err as Error).message });
    }
    deps.log(`${backup}: ${JSON.stringify(builds.at(-1))}`);
  }
  return {
    ok: builds.length > 0 && builds.every((b) => b.ok),
    backups: all.length,
    first: all[0] ?? null,
    last: all.at(-1) ?? null,
    builds,
    slowStatements: deps.slowStatements(),
  };
}

/** Run the probe, print its JSON result through `write`, and return the exit code. */
export async function runProbe(deps: ProbeDeps & { write: (text: string) => void }): Promise<number> {
  const report = await probeRecords(deps);
  deps.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

/** A server log line that names a statement over log_min_duration_statement, or a cancelled one. */
export function slowStatementLines(logText: string): string[] {
  return logText
    .split("\n")
    .filter((l) => /duration: \d/.test(l) || /canceling statement/.test(l))
    .map((l) => l.replace(/\s+/g, " ").slice(0, 600));
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

async function main(argv: readonly string[]): Promise<number> {
  const dump = flag(argv, "--dump");
  if (!dump) {
    console.error("usage: bun scripts/ops/archive-record-probe.ts --dump <capture dir> [backup id ...]");
    return 2;
  }
  const ids = argv.filter((a, i) => a !== "--dump" && argv[i - 1] !== "--dump");
  // Logs go to stderr: stdout carries only the JSON result.
  const log = (m: string) => console.error(`[archive-record-probe ${new Date().toISOString().slice(11, 19)}] ${m}`);
  const result = await withSmokeTwinContainer({ backupDir: dump, log }, async (r) => {
    const psql = (q: string) =>
      Bun.spawnSync(["docker", "exec", r.container, "psql", "-U", r.username, "-d", r.database, "-Atc", q]);
    for (const q of ["ALTER SYSTEM SET log_min_duration_statement = 500", "SELECT pg_reload_conf()", "ANALYZE"]) {
      const out = psql(q);
      if (out.exitCode !== 0) throw new Error(`${q}: ${out.stderr.toString().trim()}`);
    }
    log("statements over 500 ms are logged; statistics analyzed");
    // The store's pool reads DATABASE_URL when it is first imported.
    process.env.DATABASE_URL = `postgres://${encodeURIComponent(r.username)}:${encodeURIComponent(r.password)}@${r.host}:${r.port}/${r.database}`;
    const storeModule = new URL("../../backend/src/analytics/store/public-archive-store.ts", import.meta.url).href;
    const store = (await import(storeModule)) as ProbeStore;
    return runProbe({
      store,
      ids,
      log,
      write: (text) => process.stdout.write(text),
      slowStatements: () => {
        const logs = Bun.spawnSync(["docker", "logs", r.container]);
        return slowStatementLines(`${logs.stdout.toString()}\n${logs.stderr.toString()}`);
      },
    });
  });
  if (typeof result === "number") return result;
  process.stdout.write(`${JSON.stringify({ ok: false, error: result.error }, null, 2)}\n`);
  return result.code;
}

// The store's pool keeps the process alive, so leave with the code explicitly.
if (import.meta.main) process.exit(await main(process.argv.slice(2)));
