// scripts/release/sdk-lib.ts — what the SDK release checks share (issue 1476):
// the Q35 to Q37 (C23 to C25) steps of the template's soak (scripts/release/sdk-check.ts)
// and the v0.7.0 SDK 0.2.0 version checks (version-checks/v0.7.0/sdk-*.ts).
//
// The SDK runs from a sparse clone of the release commit, the way an analyst
// installs it (docs/technical/release-runbooks.md §11), against the target's
// public API. It only reads the target: the README's `fill` is a set of GETs.
// Everything outside the process (git, bun, bash, the API, the scratch
// folder) comes in through `SdkDeps`, so a unit test runs the real commands on
// a local copy of the package and a fake API.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import { getWithRetry, latestReport, listReports, noRunMessage, PUBLIC_API, sha256Hex, type Net, type ReportRow } from "./public-analytics-read.ts";

export interface RunResult {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}
export type Runner = (cmd: readonly string[], opts: { cwd?: string; env?: Record<string, string> }) => Promise<RunResult>;

export interface SdkDeps {
  readonly net: Net;
  readonly run: Runner;
  /** A fresh empty folder for one check (under ~/tmp). */
  readonly scratch: () => string;
  /** The folder holding `packages/analyst-sdk` at `commit`; the default makes a sparse clone. */
  readonly prepareSdk: (commit: string, scratch: string, withRepoFiles?: boolean) => Promise<{ sdkDir: string } | { problem: string }>;
}

export const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const tail = (s: string, n = 600): string => (s.length > n ? `…${s.slice(-n)}` : s).trim();

/** The real runner: Bun.spawn with the caller's environment plus `env`. */
export const spawnRunner: Runner = async (cmd, { cwd, env }) => {
  const p = Bun.spawn([...cmd], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout: new Uint8Array(out), stderr: err };
};

/** A scratch folder under ~/tmp. */
export function homeScratch(prefix = "sdk-check-"): string {
  const base = join(process.env.HOME ?? homedir(), "tmp");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

/**
 * The repository folders the package's own tests read outside the package (universe.test.ts imports
 * backend/src/analytics/source-tolerance.ts; originals-provenance.test.ts checks that the fixtures'
 * producers, backend/scripts/capture-analytics-originals.ts among them, exist). Only Q37/C25 add them:
 * the quickstart still runs from the package alone, the way an analyst installs it.
 */
export const TEST_REPO_DIRS = ["backend/src/analytics", "backend/scripts"] as const;

/**
 * A sparse clone of `repoUrl` at `commit`, with `packages/analyst-sdk`
 * installed frozen: the install of the README (§11), for the release commit.
 */
export function sparseCloneSdk(repoUrl: string, run: Runner): SdkDeps["prepareSdk"] {
  return async (commit, scratch, withRepoFiles = false) => {
    if (!/^[0-9a-f]{40}$/.test(commit)) return { problem: `the release commit "${commit}" is not a 40-hex sha` };
    const dir = join(scratch, "clone");
    const steps: string[][] = [
      ["git", "clone", "--quiet", "--no-checkout", "--filter=blob:none", repoUrl, dir],
      ["git", "-C", dir, "sparse-checkout", "set", "packages/analyst-sdk", ...(withRepoFiles ? TEST_REPO_DIRS : [])],
    ];
    for (const s of steps) {
      const r = await run(s, {});
      if (r.code !== 0) return { problem: `${s.slice(0, 3).join(" ")} failed: ${tail(r.stderr)}` };
    }
    await run(["git", "-C", dir, "fetch", "--quiet", "origin", commit], {}); // a QA commit may not be on a cloned branch
    const co = await run(["git", "-C", dir, "checkout", "--quiet", commit], {});
    if (co.code !== 0) return { problem: `git checkout ${commit} failed: ${tail(co.stderr)}` };
    const head = text((await run(["git", "-C", dir, "rev-parse", "HEAD"], {})).stdout).trim();
    if (head !== commit) return { problem: `the clone is at ${head}, not the release commit ${commit}` };
    const sdkDir = join(dir, "packages", "analyst-sdk");
    const inst = await run(["bun", "install", "--frozen-lockfile"], { cwd: sdkDir });
    if (inst.code !== 0) return { problem: `bun install --frozen-lockfile in the SDK failed: ${tail(inst.stderr)}` };
    return { sdkDir };
  };
}

/** PURE. The README's acquisition blocks (`<!-- readme-test: acquire -->`), in order. */
export function acquireBlocks(readme: string): string[] {
  return [...readme.matchAll(/<!-- readme-test: acquire -->\s*\n```sh\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

/** PURE. The first acquisition block (the API-only fill) with its final call aimed at `folder`, or undefined when the README has changed shape. */
export function fillScript(readme: string, folder: string): string | undefined {
  const block = acquireBlocks(readme)[0];
  if (block === undefined || !/^fill api-copy$/m.test(block) || !/^fill\(\) \{$/m.test(block)) return undefined;
  return block.replace(/^fill api-copy$/m, `fill ${folder}`);
}

/** The README quickstart's `fill` into `folder` (relative to the SDK folder) against the target's API. */
export async function fillInto(deps: SdkDeps, sdkDir: string, folder: string): Promise<string | null> {
  const readme = readFileSync(join(sdkDir, "README.md"), "utf8");
  const script = fillScript(readme, folder);
  if (script === undefined) return "the SDK README at this commit no longer has the API-only `fill` block (<!-- readme-test: acquire -->) the check runs";
  const r = await deps.run(["bash", "-euo", "pipefail", "-c", script], { cwd: sdkDir, env: { API: `${deps.net.origin}${PUBLIC_API}` } });
  return r.code === 0 ? null : `fill ${folder} exited ${r.code}: ${tail(r.stderr)}`;
}

/** Every file under `dir` with its sha256, keyed by relative path. */
export function treeHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = sha256Hex(readFileSync(p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** PURE. Why two local copies are not the same copy; empty when they are. */
export function copyDifferences(a: Record<string, string>, b: Record<string, string>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(a)) {
    if (!(k in b)) out.push(`${k} is only in the API-only copy`);
    else if (a[k] !== b[k]) out.push(`${k} differs between the two copies`);
  }
  for (const k of Object.keys(b)) if (!(k in a)) out.push(`${k} is only in the copy that started from the first backup`);
  if (Object.keys(a).length === 0) out.push("the API-only fill produced an empty copy");
  return out;
}

export interface CheckResult {
  readonly found: Record<string, unknown>;
  readonly problems: string[];
  /** Printed, never a failure: what the check did not assert and where it is asserted instead. */
  readonly notes?: string[];
}

/** The latest published run, or the problem that says there is none. */
export async function latestRun(net: Net, what: string): Promise<{ run: { run_key: string; asof: string; checksum: string } } | { problem: string }> {
  const { reports, problems } = await listReports(net);
  if (problems.length > 0) return { problem: problems.join("; ") };
  const latest = latestReport(reports);
  return latest === undefined ? { problem: noRunMessage(what) } : { run: latest };
}

/**
 * A run's build identity says whether the fixed producer made it. Before this release it was a package
 * label (`pkg:0.1.0+bun:1.4.4`); since PR 1445 it is the image's commit, and the same release carries issue
 * 1421's fix (PR 1427). A run with a package label computed from freshly fetched source values that the
 * ledger stored only to a relative tolerance (D56), so its numbers differ from what it published by about
 * 1e-6 (regime-engine.md 8.1.1) and its replay is not exactly equal; a run with a commit identity replays
 * every field exactly. (The merge instant of the fix is no marker: production ran the old build after it.)
 */
export const isFixedProducer = (buildIdentity: string): boolean => buildIdentity !== "" && !buildIdentity.startsWith("pkg:");

export interface ArchivedRun {
  readonly created: string;
  readonly buildIdentity: string;
}

/** The runs (by key) in a filled archive copy's run ledger (every csv/<backup>/data/analytics_ledger_runs.*.csv.gz). */
export function archivedRuns(copyDir: string): Map<string, ArchivedRun> {
  const runs = new Map<string, ArchivedRun>();
  const csv = join(copyDir, "csv");
  if (!existsSync(csv)) return runs;
  for (const backup of readdirSync(csv)) {
    const data = join(csv, backup, "data");
    if (!existsSync(data)) continue;
    for (const f of readdirSync(data)) {
      if (!/^analytics_ledger_runs\..*\.csv\.gz$/.test(f)) continue;
      // id,run_key,asof,tool_id,source_label,methodology_version_id,build_identity,job_id,created_at
      for (const line of gunzipSync(readFileSync(join(data, f))).toString("utf8").split("\n")) {
        const c = line.split(",");
        if (c.length === 9 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(c[1]!)) runs.set(c[1]!, { created: c[8]!, buildIdentity: c[6]! });
      }
    }
  }
  return runs;
}

/** PURE. The newest published report (highest report id) whose run is in the archive copy, or undefined. */
export function newestArchivedReport(reports: readonly ReportRow[], archived: ReadonlyMap<string, ArchivedRun>): ReportRow | undefined {
  return latestReport(reports.filter((r) => archived.has(r.run_key)));
}

type Format1 = typeof import("../../packages/analyst-sdk/src/archive/format1.ts");

/** The record of the newest backup a listing names, or why the listing does not name one. */
function newestListed(body: unknown): { backup: string; record: string } | string {
  const b = body as { format?: unknown; backups?: { backup?: unknown; record?: unknown }[]; nextCursor?: unknown } | null;
  if (b?.format !== 1) return `carries format ${JSON.stringify(b?.format)}, not 1`;
  if (!Array.isArray(b.backups) || b.backups.length === 0) return "lists no sealed backup";
  if (b.nextCursor !== null && b.nextCursor !== undefined) return "lists more than 1000 backups: the newest is not on the first page";
  const newest = [...b.backups].sort((x, y) => String(x.backup).localeCompare(String(y.backup))).at(-1)!;
  const { backup, record } = newest;
  if (typeof backup !== "string" || typeof record !== "string" || record !== `csv/${backup}/backup.json` || !/^[A-Za-z0-9._-]+$/.test(backup)) {
    return `names a newest backup that is not csv/<backup id>/backup.json (${JSON.stringify(newest)})`;
  }
  return { backup, record };
}

/**
 * PURE. One backup record parsed by the SDK's own format 1 reader (selectBackups). The
 * reader checks that a copy's watermark chain starts at none; the smoke fetches only the newest backup, so
 * the record's chain start is cleared before the reader sees it. Every other check of the reader applies.
 */
export function parseOneRecord(f1: Format1, backup: string, recordText: string): ReturnType<Format1["selectBackups"]>[number] {
  let text = recordText;
  try {
    const rec = JSON.parse(recordText) as { append_only?: unknown };
    if (rec && typeof rec.append_only === "object" && rec.append_only !== null) {
      for (const t of Object.values(rec.append_only as Record<string, { watermark_before?: unknown } | null>)) if (t && typeof t === "object") t.watermark_before = null;
      text = JSON.stringify(rec);
    }
  } catch { /* the reader names the parse error */ }
  return f1.selectBackups({ [backup]: text })[0]!;
}

/**
 * Q36/C24: a minimal contract smoke of the SDK against the target's advertised public routes (owner,
 * 2026-11-03: the SDK must minimally work with the APIs we advertise; issue 1566). It parses and verifies
 * with the SDK's own format 1 code (packages/analyst-sdk/src/archive/format1.ts) from a sparse clone of the
 * release commit, and calls each route the quickstart uses once, in order:
 *   1. archive/backups (the listing, format 1);
 *   2. the newest backup's backup.json, parsed as a format 1 record (selectBackups);
 *   3. every file that record lists, inflated within its bytes_raw (inflateBounded) and checked against its
 *      sha256_raw (verifyFile);
 *   4. reports (the listing), newest published run picked;
 *   5. reports?run=<run>, whose bytes hash to the listing's checksum;
 *   6. vintages?run_key=<run>, at least one vintage, its tool_id taken;
 *   7. vintages?run_key=<run>&tool_id=<tool_id>&include=members, at least one member (the route refuses
 *      include=members without both keys).
 * The first route that fails to answer, parse or verify is the one problem. It fetches one backup, never
 * the whole archive, and runs no replay: the full-archive replay is the post-seal report (postSealCheck).
 * A target with no published run fails.
 */
export async function quickstartCheck(deps: SdkDeps, commit: string): Promise<CheckResult> {
  const found: Record<string, unknown> = { commit };
  const fail = (problem: string): CheckResult => ({ found, problems: [problem] });
  const sdk = await deps.prepareSdk(commit, deps.scratch());
  if ("problem" in sdk) return fail(sdk.problem);
  const f1 = (await import(join(sdk.sdkDir, "src", "archive", "format1.ts"))) as Format1;
  const json = async (path: string): Promise<{ status: number; body: unknown }> => {
    const res = await getWithRetry(deps.net, path, undefined, 15); // a sealed backup's record answers 503 + Retry-After until it is built
    let body: unknown;
    try { body = res.status === 200 ? await res.json() : null; } catch { body = undefined; }
    return { status: res.status, body };
  };
  const bad = (path: string, r: { status: number; body: unknown }): string | null =>
    r.status !== 200 ? `GET ${path} answered ${r.status}, not 200` : r.body === undefined ? `GET ${path} is not JSON` : null;

  // 1. The backup listing.
  const listPath = `${PUBLIC_API}/archive/backups?limit=1000`;
  const list = await json(listPath);
  const listBad = bad(listPath, list);
  if (listBad) return fail(listBad);
  const newest = newestListed(list.body);
  if (typeof newest === "string") return fail(`GET ${listPath} ${newest}`);
  found.backup = newest.backup;

  // 2. The newest backup's record, as format 1.
  const recPath = `${PUBLIC_API}/archive/${newest.record}`;
  const recRes = await getWithRetry(deps.net, recPath, undefined, 15);
  if (recRes.status !== 200) return fail(`GET ${recPath} answered ${recRes.status}, not 200`);
  let record: ReturnType<Format1["selectBackups"]>[number];
  try { record = parseOneRecord(f1, newest.backup, await recRes.text()); } catch (e) { return fail(`GET ${recPath} is not a format 1 record: ${(e as Error).message}`); }

  // 3. Every file the record lists, inflated within bytes_raw and hashed against sha256_raw.
  const files = f1.listedFiles([record]);
  for (const f of files) {
    const path = `${PUBLIC_API}/archive/${f.path}`;
    const res = await getWithRetry(deps.net, path, undefined, 15);
    if (res.status !== 200) return fail(`GET ${path} answered ${res.status}, not 200`);
    try {
      const raw = f1.inflateBounded(new Uint8Array(await res.arrayBuffer()), f.bytes_raw, f.path);
      f1.verifyFile(f, { sha256_raw: sha256Hex(raw) });
    } catch (e) {
      return fail(`GET ${path} does not verify: ${(e as Error).message}`);
    }
  }
  found.files = files.length;

  // 4. The reports listing, newest published run.
  const listed = await listReports(deps.net);
  if (listed.problems.length > 0) return fail(listed.problems.join("; "));
  const run = latestReport(listed.reports);
  if (run === undefined) return fail(noRunMessage("the SDK quickstart"));
  Object.assign(found, { run_key: run.run_key, asof: run.asof });

  // 5. The run's report bytes hash to the listing's checksum.
  const reportPath = `${PUBLIC_API}/reports?run=${encodeURIComponent(run.run_key)}`;
  const report = await getWithRetry(deps.net, reportPath);
  if (report.status !== 200) return fail(`GET ${reportPath} answered ${report.status}, not 200`);
  const reportSha = sha256Hex(new Uint8Array(await report.arrayBuffer()));
  if (reportSha !== run.checksum) return fail(`GET ${reportPath}: the body's sha256 ${reportSha} is not the listing's checksum ${run.checksum}`);

  // 6. The run's vintage, and its tool.
  const vPath = `${PUBLIC_API}/vintages?run_key=${encodeURIComponent(run.run_key)}`;
  const v = await json(vPath);
  const vBad = bad(vPath, v);
  if (vBad) return fail(vBad);
  const vintage = (v.body as { vintages?: { tool_id?: unknown }[] } | null)?.vintages?.[0];
  if (vintage === undefined) return fail(`GET ${vPath} lists no vintage for run ${run.run_key}`);
  if (typeof vintage.tool_id !== "string" || vintage.tool_id === "") return fail(`GET ${vPath}: the vintage names no tool_id`);
  found.tool_id = vintage.tool_id;

  // 7. That vintage's members: the run's committed inputs.
  const mPath = `${PUBLIC_API}/vintages?run_key=${encodeURIComponent(run.run_key)}&tool_id=${encodeURIComponent(vintage.tool_id)}&include=members`;
  const m = await json(mPath);
  const mBad = bad(mPath, m);
  if (mBad) return fail(mBad);
  const rows = (m.body as { vintages?: { members?: { rows?: unknown[] } }[] } | null)?.vintages?.[0]?.members?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return fail(`GET ${mPath} lists no member for the vintage`);
  found.members = rows.length;
  return { found, problems: [], notes: ["a contract smoke of the advertised routes: the full-archive replay is not run here; it is the post-seal report (bun scripts/release/sdk-check.ts --check post-seal)"] };
}

/**
 * The post-seal check, run on its own after the UTC day a fixed-release run ran in is sealed (never a
 * cutover step): the README quickstart's `fill` of the whole archive, `bun run inputs --run <run>`, `bun run
 * regime --replay`, then scripts/release/replay-row.ts. The newest archived published run must have been
 * made at or after the fix, and its whole as-of row must equal the as-of row of the run's published
 * regime_snapshots artifact (the comparison of PR 1448), else the check fails naming the missing sealed day.
 */
export async function postSealCheck(deps: SdkDeps, commit: string): Promise<CheckResult> {
  const found: Record<string, unknown> = { commit, mode: "post-seal" };
  const listed = await listReports(deps.net);
  if (listed.problems.length > 0) return { found, problems: [listed.problems.join("; ")] };
  const newest = latestReport(listed.reports);
  if (newest === undefined) return { found, problems: [noRunMessage("the post-seal check")] };
  const sdk = await deps.prepareSdk(commit, deps.scratch());
  if ("problem" in sdk) return { found, problems: [sdk.problem] };
  const filled = await fillInto(deps, sdk.sdkDir, "api-copy");
  if (filled !== null) return { found, problems: [filled] };
  // The archive is sealed a UTC day at a time, so the newest published run may postdate the newest sealed backup.
  const archived = archivedRuns(join(sdk.sdkDir, "api-copy"));
  const run = newestArchivedReport(listed.reports, archived);
  Object.assign(found, { newestPublishedRun: newest.run_key, newestPublishedAsof: newest.asof });
  if (run === undefined) return { found, problems: [`none of the ${listed.reports.length} published run(s) is in the filled archive copy (${archived.size} run(s) in its ledger): no sealed backup holds a published run yet`] };
  const { run_key, asof } = run;
  const { created, buildIdentity } = archived.get(run_key)!;
  const fixed = isFixedProducer(buildIdentity);
  Object.assign(found, { run_key, asof, created, buildIdentity, fixedProducer: fixed });
  if (!fixed) {
    const sealedThrough = [...readdirSync(join(sdk.sdkDir, "api-copy", "csv"))].sort().at(-1) ?? "none";
    return { found, problems: [`the newest archived run (${run_key}, made ${created}) was made by the old producer (build identity ${buildIdentity}, before issue 1421's fix): the sealed backups run through ${sealedThrough}, none holds a run of the fixed release; a day is sealed one hour after its UTC midnight: rerun this check once the day a v0.7.0 run was made in is sealed`] };
  }
  const out = join(sdk.sdkDir, "api-fill");
  const inputs = await deps.run(["bun", "run", "inputs", "--archive", "api-copy", "--run", run_key, "--out", out], { cwd: sdk.sdkDir });
  if (inputs.code !== 0) return { found, problems: [`bun run inputs --run ${run_key} exited ${inputs.code}: ${tail(inputs.stderr)}`] };
  const regime = await deps.run(["bun", "run", "regime", join(out, "inputs.csv"), "--replay", "--asof", asof], { cwd: sdk.sdkDir });
  if (regime.code !== 0) return { found, problems: [`bun run regime --replay --asof ${asof} exited ${regime.code}: ${tail(regime.stderr)}`] };
  const tier = "full";
  const cmp = await deps.run(
    ["bun", join(import.meta.dir, "replay-row.ts"), "--sdk", sdk.sdkDir, "--archive", join(sdk.sdkDir, "api-copy"), "--run", run_key, "--inputs", join(out, "inputs.csv"), "--tier", tier],
    { cwd: sdk.sdkDir },
  );
  let body: { problems?: string[]; publishedSha256?: string | null; replaySha256?: string; differing?: string[] } = {};
  try { body = JSON.parse(text(cmp.stdout)); } catch { /* reported below */ }
  Object.assign(found, { tier, publishedRowSha256: body.publishedSha256 ?? null, sdkRowSha256: body.replaySha256 ?? null, differingFields: body.differing ?? null });
  if (!(cmp.code === 0 && body.problems?.length === 0)) {
    return { found, problems: body.problems?.length ? body.problems : [`the as-of row comparison exited ${cmp.code}: ${tail(cmp.stderr || text(cmp.stdout))}`] };
  }
  return { found, problems: [] };
}

/** Q37/C25: the SDK package's own tests pass at the release commit. */
export async function packageTestsCheck(deps: SdkDeps, commit: string): Promise<CheckResult> {
  const found: Record<string, unknown> = { commit };
  const sdk = await deps.prepareSdk(commit, deps.scratch(), true);
  if ("problem" in sdk) return { found, problems: [sdk.problem] };
  const r = await deps.run(["bun", "test"], { cwd: sdk.sdkDir });
  found.exit = r.code;
  return { found, problems: r.code === 0 ? [] : [`bun test in packages/analyst-sdk exited ${r.code}: ${tail(r.stderr)}`] };
}

/** PURE. Why the archive routes do not answer as format 1; empty when they do. */
export function archiveRouteProblems(list: { status: number; body: unknown }, record: { status: number; body: unknown } | null): string[] {
  const out: string[] = [];
  const format = (b: unknown) => (typeof b === "object" && b !== null ? (b as { format?: unknown }).format : undefined);
  if (list.status !== 200) out.push(`GET ${PUBLIC_API}/archive/backups answered ${list.status}, not 200`);
  else {
    if (format(list.body) !== 1) out.push(`GET ${PUBLIC_API}/archive/backups carries format ${JSON.stringify(format(list.body))}, not 1`);
    const backups = (list.body as { backups?: unknown }).backups;
    if (!Array.isArray(backups) || backups.length === 0) out.push(`GET ${PUBLIC_API}/archive/backups lists no sealed backup`);
  }
  if (record !== null) {
    if (record.status !== 200) out.push(`the first backup's record answered ${record.status}, not 200`);
    else if (format(record.body) !== 1) out.push(`the first backup's record carries format ${JSON.stringify(format(record.body))}, not 1`);
  }
  return out;
}

/** Q35/C23: the public archive routes answer 200 with format 1. */
export async function archiveRoutesCheck(net: Net): Promise<CheckResult> {
  const json = async (path: string) => {
    // A sealed backup's record is built on first request after a boot and answers 503 + Retry-After until it is: wait longer than the default.
    const res = await getWithRetry(net, path, undefined, 15);
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  };
  const list = await json(`${PUBLIC_API}/archive/backups?limit=1`);
  const first = (list.body as { backups?: { record?: string }[] } | null)?.backups?.[0]?.record;
  const record = list.status === 200 && typeof first === "string" && /^csv\/[A-Za-z0-9._-]+\/backup\.json$/.test(first) ? await json(`${PUBLIC_API}/archive/${first}`) : null;
  return { found: { listStatus: list.status, recordStatus: record?.status ?? null, firstRecord: first ?? null }, problems: archiveRouteProblems(list, record) };
}

/**
 * SDK 0.2.0: the README's `fill` into a fresh folder, and a fill that starts
 * from the first recorded backup, give the same local copy.
 */
export async function fillParityCheck(deps: SdkDeps, commit: string): Promise<CheckResult> {
  const found: Record<string, unknown> = { commit };
  const list = await getWithRetry(deps.net, `${PUBLIC_API}/archive/backups?limit=1`);
  if (list.status !== 200) return { found, problems: [`GET ${PUBLIC_API}/archive/backups answered ${list.status}`] };
  const firstId = ((await list.json()) as { backups?: { backup?: string }[] }).backups?.[0]?.backup;
  if (typeof firstId !== "string" || !/^[A-Za-z0-9._-]+$/.test(firstId)) return { found, problems: [`${PUBLIC_API}/archive/backups names no first backup`] };
  found.firstBackup = firstId;
  const sdk = await deps.prepareSdk(commit, deps.scratch());
  if ("problem" in sdk) return { found, problems: [sdk.problem] };
  const api = await fillInto(deps, sdk.sdkDir, "api-copy");
  if (api !== null) return { found, problems: [api] };
  await copyFromFirstBackup(sdk.sdkDir, firstId);
  const repo = await fillInto(deps, sdk.sdkDir, "repo-copy");
  if (repo !== null) return { found, problems: [repo] };
  const [a, b] = [treeHashes(join(sdk.sdkDir, "api-copy")), treeHashes(join(sdk.sdkDir, "repo-copy"))];
  found.files = Object.keys(a).length;
  return { found, problems: copyDifferences(a, b) };
}

/** The stand-in clone of the README: the first recorded backup copied into `repo-copy`. */
export async function copyFromFirstBackup(sdkDir: string, firstBackupId: string): Promise<void> {
  mkdirSync(join(sdkDir, "repo-copy", "csv"), { recursive: true });
  cpSync(join(sdkDir, "api-copy", "csv", firstBackupId), join(sdkDir, "repo-copy", "csv", firstBackupId), { recursive: true });
}

/** The real dependencies of an SDK check: the target's origin, the real commands, and a sparse clone of this checkout's origin. */
export async function realSdkDeps(origin: string, net: Net, repoUrl?: string): Promise<SdkDeps> {
  const url = repoUrl ?? text((await spawnRunner(["git", "remote", "get-url", "origin"], {})).stdout).trim();
  if (!url) throw new Error("this checkout has no origin remote to clone the SDK from");
  return { net, run: spawnRunner, scratch: () => homeScratch(), prepareSdk: sparseCloneSdk(url, spawnRunner) };
}
