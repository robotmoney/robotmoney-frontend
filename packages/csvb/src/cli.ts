#!/usr/bin/env bun
// csvb: make and read the format 1 backups (D72). It lives in robotmoney-frontend (packages/csvb, issue 1477, D80);
// the data lives in a separate checkout of robotmoney/csv-backups, named with --repo. A backup is never written
// inside a robotmoney-frontend checkout.
//
//   bun run csvb backup  [--repo DIR] [--part-mb 64] [--pause-ms 50] [--max-seconds 3600] [--statement-timeout-s 90]
//                        [--max-rss-mb 1500] [--only table,table] [--env-file PATH]
//   bun run csvb finish  [--repo DIR]     (verify and add a backup that was staged but not finished)
//   bun run csvb verify  [--repo DIR] [--backup ID]
//   bun run csvb list    [--repo DIR]
//   bun run csvb resolve --table T [--as-of latest|ID|DATE|DATETIME] [--where col=value]... [--limit N] [--repo DIR]
//   bun run csvb history --table T --where col=value [--where col=value]... [--repo DIR]
//   bun run csvb diff    --table T --from SPEC --to SPEC [--limit N] [--repo DIR]
//   bun run csvb audit   <runs|drift|revisions|replay|all> [--as-of SPEC] [--out DIR] [--sdk DIR] [--reference-js DIR] [--run ID] [--repo DIR]
//                        (--sdk defaults to ../analyst-sdk, the SDK package beside this one)
//                        writes a report (never committed) to --out, default <repo>/reports/<backup id>
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { ALL_TABLE_NAMES, APPEND_ONLY, REVISED } from "./config.ts";
import { defaultOptions, finishStaged, requestAbort, runBackup } from "./backup.ts";
import { homeEnvFilePath, redactedTarget, replicaUrlFromEnvFile } from "./env.ts";
import { describeAnomaly, diffBackups, historyOf, listBackups, parseWhere, resolveTable } from "./query.ts";
import type { BackupRecord } from "./model.ts";
import { loadRecords } from "./repo.ts";
import { openCtx } from "./audit/data.ts";
import { analyseDrift } from "./audit/drift.ts";
import { writeReport, type Outputs } from "./audit/report.ts";
import { replayRun } from "./audit/replay.ts";
import { analyseRevisions } from "./audit/revisions.ts";
import { analyseRuns, loadRuns } from "./audit/runs.ts";
import { verifyRepo } from "./verify.ts";

interface Args {
  cmd: string;
  flags: Map<string, string[]>;
}

function parse(argv: string[]): Args {
  const [cmd = "", ...rest] = argv;
  const flags = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const v = rest[++i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
    flags.set(a, [...(flags.get(a) ?? []), v]);
  }
  return { cmd, flags };
}

const one = (a: Args, f: string): string | undefined => a.flags.get(f)?.[0];
const num = (a: Args, f: string, dflt: number): number => {
  const v = one(a, f);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${f} must be a number`);
  return n;
};

function known(a: Args, allowed: string[]): void {
  for (const f of a.flags.keys()) if (!allowed.includes(f)) throw new Error(`unknown option ${f} for ${a.cmd}`);
}

/** Anomalies never stop a backup, but they must not go unnoticed: exit status 3. */
function reportAnomalies(recs: readonly BackupRecord[]): number {
  let n = 0;
  for (const rec of recs) {
    for (const an of rec.anomalies ?? []) console.error(`ANOMALY ${describeAnomaly(an)}`);
    if (rec.anomalies?.length) console.error(`backup ${rec.backup} was made, with ${rec.anomalies.length} anomal${rec.anomalies.length === 1 ? "y" : "ies"} recorded in its record`);
    n += rec.anomalies?.length ?? 0;
  }
  return n ? 3 : 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  // `audit` takes a positional part (runs, drift, ...): lift it out before the generic flag parser.
  let what = "";
  if (argv[0] === "audit" && argv[1] && !argv[1].startsWith("--")) what = argv.splice(1, 1)[0]!;
  const a = parse(argv);
  const repo = resolve(one(a, "--repo") ?? ".");
  const layout = { root: repo };
  switch (a.cmd) {
    case "backup": {
      known(a, ["--repo", "--part-mb", "--pause-ms", "--max-seconds", "--statement-timeout-s", "--max-rss-mb", "--only", "--env-file"]);
      const partMb = num(a, "--part-mb", 64);
      if (!(partMb >= 1 && partMb <= 90)) throw new Error("--part-mb must be 1..90 (GitHub rejects files over 100 MB)");
      const only = one(a, "--only")?.split(",").filter(Boolean);
      if (only) {
        const bad = only.filter((n) => !ALL_TABLE_NAMES.includes(n));
        if (bad.length) throw new Error(`--only names no table: ${bad.join(", ")}`);
      }
      let url = process.env.RM_REPLICA_URL;
      if (!url) {
        const r = replicaUrlFromEnvFile(one(a, "--env-file") ?? homeEnvFilePath());
        if ("refuse" in r) throw new Error(r.refuse);
        url = r.url;
      }
      console.log(`connecting as ${redactedTarget(url)}`);
      const sql = postgres(url, { max: 1, ssl: new URL(url).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => {}, connect_timeout: 20 });
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => requestAbort(sig));
      let commit: string | null = null;
      try {
        // The tool's own commit (robotmoney-frontend), not the data checkout's.
        commit = execFileSync("git", ["-C", import.meta.dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
      } catch {
        commit = null;
      }
      const o = defaultOptions(sql, repo);
      o.partBytes = partMb * 1024 * 1024;
      o.pauseMs = num(a, "--pause-ms", 50);
      o.maxSeconds = num(a, "--max-seconds", 3600);
      o.statementTimeoutS = num(a, "--statement-timeout-s", 90);
      o.maxRssMb = num(a, "--max-rss-mb", 1500);
      o.tool = { name: "csvb", commit };
      if (only) {
        o.appendOnly = APPEND_ONLY.filter((t) => only.includes(t.name));
        o.revised = REVISED.filter((t) => only.includes(t.name));
      }
      let recs;
      try {
        recs = await runBackup(o);
      } finally {
        await sql.end({ timeout: 5 });
      }
      return reportAnomalies(recs);
    }
    case "finish": {
      known(a, ["--repo"]);
      return reportAnomalies(await finishStaged(repo, (l) => console.log(l)));
    }
    case "verify": {
      known(a, ["--repo", "--backup"]);
      const problems = await verifyRepo(layout, { only: one(a, "--backup") });
      if (problems.length) {
        for (const p of problems) console.error(`  ${p}`);
        console.error(`${repo}: ${problems.length} problem(s)`);
        return 1;
      }
      console.log(`${repo}: every file, count, id range, watermark, database total and replayed state matches its backup record`);
      for (const r of loadRecords(layout)) for (const an of r.anomalies ?? []) console.log(`note (backup ${r.backup}): ${describeAnomaly(an)}`);
      return 0;
    }
    case "list":
      known(a, ["--repo"]);
      for (const l of listBackups(layout)) console.log(l);
      return 0;
    case "resolve": {
      known(a, ["--repo", "--table", "--as-of", "--where", "--limit"]);
      const table = one(a, "--table");
      if (!table) throw new Error("resolve needs --table");
      const r = await resolveTable(layout, table, one(a, "--as-of"), parseWhere(a.flags.get("--where") ?? []), (s) => process.stdout.write(s), num(a, "--limit", Infinity));
      console.error(`# ${table} (${r.kind}) as of backup ${r.backup}: ${r.rows} rows${r.kind === "revised" ? "" : " (rows added by every backup up to it)"}`);
      return 0;
    }
    case "history": {
      known(a, ["--repo", "--table", "--where"]);
      const table = one(a, "--table");
      if (!table) throw new Error("history needs --table");
      for (const l of await historyOf(layout, table, parseWhere(a.flags.get("--where") ?? []))) console.log(l);
      return 0;
    }
    case "audit": {
      const sub = a;
      known(sub, ["--repo", "--as-of", "--out", "--sdk", "--reference-js", "--run"]);
      if (!["runs", "drift", "revisions", "replay", "all"].includes(what)) throw new Error("audit needs one of: runs, drift, revisions, replay, all");
      const ctx = openCtx(resolve(one(sub, "--repo") ?? "."), one(sub, "--as-of"));
      const out = resolve(one(sub, "--out") ?? join(ctx.layout.root, "reports", ctx.asOf.backup));
      // The analyst SDK the replay runs: by default the package beside this one (packages/analyst-sdk).
      const sdk = one(sub, "--sdk") ?? process.env.ANALYST_SDK_DIR ?? join(import.meta.dir, "..", "..", "analyst-sdk");
      const ref = one(sub, "--reference-js") ?? process.env.REGIME_REFERENCE_JS_DIR;
      const o: Outputs = { skipped: [] };
      console.log(`auditing as of backup ${ctx.asOf.backup}`);
      if (what === "runs" || what === "all") {
        const runs = await loadRuns(ctx);
        o.runs = [...new Set(runs.map((r) => r.tool))].sort().map((tool) => analyseRuns(runs, tool));
        console.log("run ledger: done");
      }
      if (what === "drift" || what === "all") {
        o.drift = await analyseDrift(ctx);
        console.log("drift: done");
      }
      if (what === "revisions" || what === "all") {
        o.revisions = await analyseRevisions(ctx);
        console.log("revisions: done");
      }
      if (what === "replay" || what === "all") {
        o.replay = await replayRun(ctx, { sdkDir: sdk, referenceJsDir: ref, runId: one(sub, "--run") ? Number(one(sub, "--run")) : undefined });
        console.log("replay: done");
      }
      const files = writeReport(ctx, out, o);
      console.log(`wrote ${files.length} file(s) to ${out}: ${files.join(", ")}`);
      return 0;
    }
    case "diff": {
      known(a, ["--repo", "--table", "--from", "--to", "--limit"]);
      const table = one(a, "--table");
      if (!table) throw new Error("diff needs --table");
      for (const l of await diffBackups(layout, table, one(a, "--from") ?? "", one(a, "--to") ?? "latest", num(a, "--limit", 20))) console.log(l);
      return 0;
    }
    default:
      console.error("usage: csvb <backup|finish|verify|list|resolve|history|diff|audit> [options]  (see the header of src/cli.ts)");
      return a.cmd ? 2 : 0;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`csvb: ${(e as Error).message}`);
    process.exit(1);
  },
);
