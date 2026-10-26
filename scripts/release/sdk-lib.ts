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
import { getWithRetry, latestReport, listReports, noRunMessage, PUBLIC_API, sha256Hex, type Net } from "./public-analytics-read.ts";

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
  readonly prepareSdk: (commit: string, scratch: string) => Promise<{ sdkDir: string } | { problem: string }>;
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
 * A sparse clone of `repoUrl` at `commit`, with `packages/analyst-sdk`
 * installed frozen: the install of the README (§11), for the release commit.
 */
export function sparseCloneSdk(repoUrl: string, run: Runner): SdkDeps["prepareSdk"] {
  return async (commit, scratch) => {
    if (!/^[0-9a-f]{40}$/.test(commit)) return { problem: `the release commit "${commit}" is not a 40-hex sha` };
    const dir = join(scratch, "clone");
    const steps: string[][] = [
      ["git", "clone", "--quiet", "--no-checkout", "--filter=blob:none", repoUrl, dir],
      ["git", "-C", dir, "sparse-checkout", "set", "packages/analyst-sdk"],
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
}

/** The latest published run, or the problem that says there is none. */
export async function latestRun(net: Net, what: string): Promise<{ run: { run_key: string; asof: string; checksum: string } } | { problem: string }> {
  const { reports, problems } = await listReports(net);
  if (problems.length > 0) return { problem: problems.join("; ") };
  const latest = latestReport(reports);
  return latest === undefined ? { problem: noRunMessage(what) } : { run: latest };
}

/**
 * Q36/C24: the SDK quickstart from a sparse clone of the release commit against the
 * target. `fill`, then `bun run inputs --archive <copy> --run <latest run>`,
 * then `bun run regime <inputs.csv> --replay --asof <date>` (it must run), then
 * scripts/release/replay-row.ts: the SDK's as-of row for the run is compared,
 * field by field and by the sha256 of its canonical JSON, with the as-of row of
 * the run's published `regime_snapshots` artifact (the comparison of PR 1448).
 * The published report (`/reports?run=`) is {asof, toolId, results}, which the
 * CLI never prints, so it is not compared byte for byte.
 */
export async function quickstartCheck(deps: SdkDeps, commit: string): Promise<CheckResult> {
  const found: Record<string, unknown> = { commit };
  const latest = await latestRun(deps.net, "the SDK quickstart");
  if ("problem" in latest) return { found, problems: [latest.problem] };
  const { run_key, asof } = latest.run;
  Object.assign(found, { run_key, asof });
  const sdk = await deps.prepareSdk(commit, deps.scratch());
  if ("problem" in sdk) return { found, problems: [sdk.problem] };
  const filled = await fillInto(deps, sdk.sdkDir, "api-copy");
  if (filled !== null) return { found, problems: [filled] };
  const out = join(sdk.sdkDir, "api-fill");
  const inputs = await deps.run(["bun", "run", "inputs", "--archive", "api-copy", "--run", run_key, "--out", out], { cwd: sdk.sdkDir });
  if (inputs.code !== 0) return { found, problems: [`bun run inputs --run ${run_key} exited ${inputs.code}: ${tail(inputs.stderr)}`] };
  const regime = await deps.run(["bun", "run", "regime", join(out, "inputs.csv"), "--replay", "--asof", asof], { cwd: sdk.sdkDir });
  if (regime.code !== 0) return { found, problems: [`bun run regime --replay --asof ${asof} exited ${regime.code}: ${tail(regime.stderr)}`] };
  const cmp = await deps.run(
    ["bun", join(import.meta.dir, "replay-row.ts"), "--sdk", sdk.sdkDir, "--archive", join(sdk.sdkDir, "api-copy"), "--run", run_key, "--inputs", join(out, "inputs.csv")],
    { cwd: sdk.sdkDir },
  );
  let body: { problems?: string[]; publishedSha256?: string | null; replaySha256?: string; differing?: string[] } = {};
  try { body = JSON.parse(text(cmp.stdout)); } catch { /* reported below */ }
  Object.assign(found, { publishedRowSha256: body.publishedSha256 ?? null, sdkRowSha256: body.replaySha256 ?? null });
  if (cmp.code === 0 && body.problems?.length === 0) return { found, problems: [] };
  return { found, problems: body.problems?.length ? body.problems : [`the as-of row comparison exited ${cmp.code}: ${tail(cmp.stderr || text(cmp.stdout))}`] };
}

/** Q37/C25: the SDK package's own tests pass at the release commit. */
export async function packageTestsCheck(deps: SdkDeps, commit: string): Promise<CheckResult> {
  const found: Record<string, unknown> = { commit };
  const sdk = await deps.prepareSdk(commit, deps.scratch());
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
    const res = await getWithRetry(net, path);
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
