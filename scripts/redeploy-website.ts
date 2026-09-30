#!/usr/bin/env bun
// `bun run site:redeploy` — ship a new website to a RUNNING stack without touching anything else.
//
//   bun scripts/redeploy-website.ts --live /root/robotmoney-frontend --public https://robotmoney.network [--dry-run]
//   bun scripts/redeploy-website.ts --live /root/robotmoney-frontend --rollback /root/site-backups/<dir>
//
// Run it from a scratch clone of the release tag (as the runbook's baseline step runs prod:gate), never from the
// live checkout: the live checkout sits under the running host driver and must not move. The tool builds THIS
// tree's site into a side directory, checks it, backs up the live `_static/`, swaps the files in place, and then
// proves the site is live AND that no container was restarted. If any check after the swap fails it puts the old
// site back. Why a swap and not a rebuild, and why no container restarts: see scripts/lib/website-redeploy.ts.
//
// Exit 0: done. Exit 1: a check failed after the swap began (the old site was put back unless --no-auto-rollback).
// Exit 2: refused before changing anything.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  checkBuild, diffContainers, diffManifests, guardChangedFiles, manifestOf, parseSitemapRoutes, rsyncArgs, sameManifest,
  type ContainerState,
} from "./lib/website-redeploy.ts";

const repoRoot = resolve(import.meta.dir, "..");
const NAME = "site:redeploy";

interface Args {
  live: string;
  publicOrigin?: string;
  dryRun: boolean;
  rollback?: string;
  allowDirty: boolean;
  autoRollback: boolean;
  keep: number;
  buildDir?: string;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const live = get("--live") ?? process.env.RM_LIVE_CHECKOUT;
  if (!live) refuse("pass --live <the running stack's checkout>, or set RM_LIVE_CHECKOUT");
  return {
    live: resolve(live!),
    publicOrigin: get("--public"),
    dryRun: argv.includes("--dry-run"),
    rollback: get("--rollback"),
    allowDirty: argv.includes("--allow-dirty"),
    autoRollback: !argv.includes("--no-auto-rollback"),
    keep: Number(get("--keep") ?? 5),
    buildDir: get("--build-dir"),
    concurrency: Number(get("--concurrency") ?? 8),
  };
}

// ── small helpers ────────────────────────────────────────────────────────────
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const log = (line: string) => console.log(`[${NAME}] ${line}`);
const ok = (step: string, detail = "") => log(`PASS ${step}${detail ? ` — ${detail}` : ""}`);
const warn = (step: string, detail = "") => log(`WARN ${step}${detail ? ` — ${detail}` : ""}`);

function refuse(why: string): never {
  console.error(`[${NAME}] REFUSED — nothing was changed: ${why}`);
  process.exit(2);
}

function sh(cmd: string[], cwd?: string): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
}

function serviceContainers(project: string): ContainerState[] {
  // Service containers only: the driver starts and stops one-off containers (member agents, `compose run`) all the
  // time, and they are not what a website redeploy could disturb.
  const names = sh(["docker", "ps", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.oneoff=False", "--format", "{{.Names}}"]).out
    .split("\n").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return [];
  const inspected = JSON.parse(sh(["docker", "inspect", ...names]).out) as { Name: string; Id: string; State: { StartedAt: string } }[];
  return inspected.map((c) => ({ name: c.Name.replace(/^\//, ""), id: c.Id, startedAt: c.State.StartedAt })).sort((a, b) => a.name.localeCompare(b.name));
}

async function httpGet(url: string, tries = 3): Promise<{ status: number; body: string }> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
      return { status: res.status, body: await res.text() };
    } catch (e) {
      last = e;
      await Bun.sleep(300 * (i + 1));
    }
  }
  return { status: 0, body: String(last) };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

function liveCommit(staticDir: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(staticDir, "version.json"), "utf8")) as { commit?: string }).commit ?? null;
  } catch {
    return null;
  }
}

// ── the stack we are redeploying to ──────────────────────────────────────────
interface Live {
  project: string;
  webPort: number;
  staticDir: string;
  website: string;
  inode: number;
  containers: ContainerState[];
}

function inspectLive(live: string): Live {
  const statePath = join(live, ".agents", "smoke-state.json");
  if (!existsSync(statePath)) refuse(`${statePath} does not exist: ${live} is not a running stack's checkout`);
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { project?: string; webPort?: number };
  if (!state.project || !state.webPort) refuse(`${statePath} names no project or webPort`);
  const project = state.project!;
  const staticDir = join(live, "_static");
  if (!existsSync(staticDir)) refuse(`${staticDir} does not exist`);

  const containers = serviceContainers(project);
  const website = `${project}-website-server-1`;
  if (!containers.some((c) => c.name === website)) refuse(`${website} is not running: this tool changes files under a running website, it does not start one`);
  const health = sh(["docker", "inspect", "--format", "{{.State.Health.Status}}", website]).out.trim();
  if (health !== "healthy") refuse(`${website} is ${health}, not healthy: fix that first`);

  const mounts = sh(["docker", "inspect", "--format", "{{range .Mounts}}{{.Source}}|{{.Destination}}|{{.RW}}{{println}}{{end}}", website]).out.split("\n").filter(Boolean);
  const site = mounts.map((m) => m.split("|")).find(([, dest]) => dest === "/srv/frontend");
  if (!site) refuse(`${website} has no /srv/frontend mount: it does not serve a bind-mounted site`);
  if (realpathSync(site![0]!) !== realpathSync(staticDir)) refuse(`${website} serves ${site![0]}, not ${staticDir}: --live points at the wrong checkout`);
  if (site![2] !== "false") refuse(`${website} mounts its site read-write`);

  return { project, webPort: state.webPort!, staticDir, website, inode: statSync(staticDir).ino, containers };
}

// ── swap and verification ────────────────────────────────────────────────────
function swapIn(srcDir: string, l: Live, opts: { keepModes?: boolean } = {}) {
  const args = rsyncArgs(srcDir, l.staticDir, opts);
  const r = sh(args);
  if (r.code !== 0) throw new Error(`rsync failed (${r.code}): ${r.err.trim().slice(0, 300)}`);
}

/** Checks the live site after a swap. Returns problems; empty means the site is live and nothing else moved. */
async function verifyLive(l: Live, a: Args, expectDir: string, expectCommit: string, sitemapXml: string): Promise<string[]> {
  const problems: string[] = [];
  const base = `http://127.0.0.1:${l.webPort}`;

  if (statSync(l.staticDir).ino !== l.inode) problems.push(`${l.staticDir} is a different directory than before (inode changed): the container serves a stale one`);

  const liveManifest = manifestOf(l.staticDir);
  const want = manifestOf(expectDir);
  if (!sameManifest(liveManifest, want)) {
    const d = diffManifests(liveManifest, want);
    problems.push(`the live files are not the ones swapped in: ${d.added.length} missing, ${d.changed.length} different, ${d.removed.length} extra`);
  }

  const v = await httpGet(`${base}/version.json`);
  let served: string | undefined;
  try { served = (JSON.parse(v.body) as { commit?: string }).commit; } catch { /* reported below */ }
  if (v.status !== 200 || served !== expectCommit) problems.push(`${base}/version.json answers ${v.status} commit ${served ?? "(none)"}, expected ${expectCommit}`);

  const health = await httpGet(`${base}/health`);
  if (health.status !== 200) problems.push(`${base}/health answers ${health.status}: the api behind the website is not reachable through it`);

  const routes = parseSitemapRoutes(sitemapXml);
  const results = await mapLimit(routes, a.concurrency, async (r) => ({ r, res: await httpGet(`${base}${r}`) }));
  const bad = results.filter((x) => x.res.status !== 200 || x.res.body.length === 0);
  if (bad.length > 0) problems.push(`${bad.length} of ${routes.length} routes did not answer 200: ${bad.slice(0, 6).map((x) => `${x.r} (${x.res.status})`).join(", ")}`);

  problems.push(...diffContainers(l.containers, serviceContainers(l.project)));
  return problems;
}

// ── main ─────────────────────────────────────────────────────────────────────
const a = parseArgs(process.argv.slice(2));
const started = Date.now();
const receipt: Record<string, unknown> = { tool: NAME, startedAt: stamp(), live: a.live };

const l = inspectLive(a.live);
ok("the stack", `${l.project}: ${l.containers.length} service containers running, ${l.website} healthy, serving ${l.staticDir}`);
receipt.project = l.project;
receipt.containersBefore = l.containers;

// ── rollback mode ────────────────────────────────────────────────────────────
if (a.rollback) {
  const dir = resolve(a.rollback);
  const tar = existsSync(dir) ? readdirSync(dir).find((f) => /^_static-.*\.tar\.gz$/.test(f)) : undefined;
  if (!tar) refuse(`${dir} holds no _static-*.tar.gz backup`);
  const tmp = mkdtempSync(join(tmpdir(), "site-rollback-"));
  const x = sh(["tar", "-xzf", join(dir, tar!), "-C", tmp]);
  if (x.code !== 0) refuse(`cannot read ${tar}: ${x.err.trim()}`);
  const restoreCommit = liveCommit(tmp);
  if (!restoreCommit) refuse(`${tar} holds no version.json: it is not a backup of this site`);
  log(`rolling back to commit ${restoreCommit} from ${tar}`);
  swapIn(tmp, l, { keepModes: true });
  const sitemap = existsSync(join(tmp, "sitemap.xml")) ? readFileSync(join(tmp, "sitemap.xml"), "utf8") : "";
  const problems = await verifyLive(l, a, tmp, restoreCommit!, sitemap);
  rmSync(tmp, { recursive: true, force: true });
  if (problems.length > 0) {
    for (const p of problems) log(`FAIL ${p}`);
    process.exit(1);
  }
  ok("rolled back", `the site is commit ${restoreCommit}; no container moved`);
  process.exit(0);
}

// ── preflight on this tree ───────────────────────────────────────────────────
const head = sh(["git", "rev-parse", "HEAD"], repoRoot).out.trim();
if (!head) refuse(`${repoRoot} is not a git checkout`);
const headShort = head.slice(0, 8);
if (!a.allowDirty && sh(["git", "status", "--porcelain", "--untracked-files=no"], repoRoot).out.trim()) {
  refuse("this tree has uncommitted changes to tracked files: the site would not match any commit (--allow-dirty to override)");
}
if (resolve(repoRoot) === a.live) refuse("run this from a scratch clone of the release, not from the live checkout");
const from = liveCommit(l.staticDir);
ok("this tree", `commit ${headShort}; the live site is commit ${from ?? "(unknown)"}`);

if (from) {
  const changed = sh(["git", "diff", "--name-only", from, head, "--", "website-server", "docker-compose.yml", "docker-compose.smoke.yml", "docker-compose.stage.yml"], repoRoot);
  if (changed.code !== 0) {
    warn("changed-file guard", `cannot compare ${from} with ${headShort} (is the clone shallow?): ${changed.err.trim().slice(0, 120)}`);
  } else {
    const g = guardChangedFiles(changed.out.split("\n").filter(Boolean));
    if (g.blockers.length > 0) refuse(`the nginx image changed (${g.blockers.join(", ")}): a swap of files cannot ship that; the website container must be recreated`);
    if (g.warnings.length > 0) warn("compose files changed", `${g.warnings.join(", ")} differ from the live commit; they take effect only at the next full boot`);
    else ok("changed-file guard", "website-server/ and the compose files are unchanged since the live commit");
  }
}

const liveSizeKb = Number(sh(["du", "-sk", l.staticDir]).out.split("\t")[0] ?? 0);
const freeKb = Number(sh(["df", "-Pk", dirname(a.live)]).out.trim().split("\n").pop()?.split(/\s+/)[3] ?? 0);
if (freeKb < liveSizeKb * 4 + 200_000) refuse(`only ${(freeKb / 1024).toFixed(0)} MB free beside the live checkout; need about ${((liveSizeKb * 4 + 200_000) / 1024).toFixed(0)} MB for a build and a backup`);
ok("disk", `${(freeKb / 1024).toFixed(0)} MB free; the live site is ${(liveSizeKb / 1024).toFixed(0)} MB`);

// ── build aside ──────────────────────────────────────────────────────────────
const buildDir = resolve(a.buildDir ?? join(dirname(a.live), "site-builds", headShort));
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(dirname(buildDir), { recursive: true });
log(`building the site into ${buildDir} (the live site is untouched)…`);
const t0 = Date.now();
const built = sh(["bash", "scripts/static-assembly.sh", buildDir], repoRoot);
if (built.code !== 0) refuse(`the assembly failed (${built.code}); last output:\n${(built.out + built.err).split("\n").slice(-12).join("\n")}`);
ok("build", `${((Date.now() - t0) / 1000).toFixed(0)}s`);

const sitemapXml = readFileSync(join(repoRoot, "frontend/public/sitemap.xml"), "utf8");
const problems = checkBuild({ dir: buildDir, headSha: head, sitemapXml, liveEntryCount: readdirSync(l.staticDir).length });
if (problems.length > 0) refuse(`the build is not fit to ship (kept in ${buildDir}):\n  - ${problems.join("\n  - ")}`);
const routes = parseSitemapRoutes(sitemapXml);
ok("build checks", `${routes.length} routes prerendered, version.json = ${headShort}, every stylesheet stamp matches its file`);

const diff = diffManifests(manifestOf(l.staticDir), manifestOf(buildDir));
ok("what changes", `${diff.changed.length} changed, ${diff.added.length} added, ${diff.removed.length} removed`);
receipt.fromCommit = from;
receipt.toCommit = headShort;
receipt.diff = { changed: diff.changed.length, added: diff.added.length, removed: diff.removed.length, removedFiles: diff.removed.slice(0, 40) };

if (a.dryRun) {
  log(`DRY RUN — stopped before the backup and the swap. The build stays in ${buildDir}.`);
  process.exit(0);
}

// ── backup, swap, verify ─────────────────────────────────────────────────────
const backupDir = join(dirname(a.live), "site-backups", `${stamp().replace(/[:]/g, "")}-${from ?? "unknown"}`);
mkdirSync(backupDir, { recursive: true });
const tar = join(backupDir, `_static-${from ?? "unknown"}.tar.gz`);
const t = sh(["tar", "-czf", tar, "-C", l.staticDir, "."]);
if (t.code !== 0) refuse(`cannot back up the live site: ${t.err.trim()}`);
ok("backup", `${tar} (${(statSync(tar).size / 1024 / 1024).toFixed(1)} MB)`);
receipt.backup = tar;

const swapStart = Date.now();
let failure: string[] = [];
try {
  swapIn(buildDir, l);
  log(`swapped in ${((Date.now() - swapStart) / 1000).toFixed(1)}s`);
  failure = await verifyLive(l, a, buildDir, headShort, sitemapXml);
} catch (e) {
  failure = [String((e as Error).message ?? e)];
}

if (failure.length > 0) {
  for (const p of failure) log(`FAIL ${p}`);
  if (a.autoRollback) {
    log("putting the old site back…");
    const tmp = mkdtempSync(join(tmpdir(), "site-restore-"));
    sh(["tar", "-xzf", tar, "-C", tmp]);
    swapIn(tmp, l, { keepModes: true });
    const after = await verifyLive(l, a, tmp, from ?? "", sitemapXml);
    rmSync(tmp, { recursive: true, force: true });
    if (after.length > 0) for (const p of after) log(`FAIL after rollback: ${p}`);
    else ok("rolled back", `the site is commit ${from} again`);
  }
  receipt.result = "failed";
  receipt.failure = failure;
  writeFileSync(join(backupDir, "receipt.json"), JSON.stringify(receipt, null, 2));
  process.exit(1);
}

ok("live", `every one of ${routes.length} routes answers 200, version.json = ${headShort}, the directory is the same inode`);
ok("only the website moved", `${l.containers.length} service containers: same ids, same start times`);

if (a.publicOrigin) {
  const pv = await httpGet(`${a.publicOrigin.replace(/\/+$/, "")}/version.json`);
  let served: string | undefined;
  try { served = (JSON.parse(pv.body) as { commit?: string }).commit; } catch { /* warn below */ }
  if (served === headShort) ok("public site", `${a.publicOrigin} serves ${headShort}`);
  else warn("public site", `${a.publicOrigin} still serves ${served ?? `HTTP ${pv.status}`}: the edge caches static files for hours; purge Cloudflare (runbook) before calling this live`);
  receipt.publicServes = served ?? null;
}

receipt.result = "ok";
receipt.seconds = Math.round((Date.now() - started) / 1000);
receipt.containersAfter = serviceContainers(l.project);
writeFileSync(join(backupDir, "receipt.json"), JSON.stringify(receipt, null, 2));
rmSync(buildDir, { recursive: true, force: true });

// Keep the newest --keep backups.
const all = readdirSync(join(dirname(a.live), "site-backups")).sort();
for (const old of all.slice(0, Math.max(0, all.length - a.keep))) rmSync(join(dirname(a.live), "site-backups", old), { recursive: true, force: true });

log(`DONE in ${receipt.seconds}s — receipt ${join(backupDir, "receipt.json")}; to undo: bun scripts/redeploy-website.ts --live ${a.live} --rollback ${backupDir}`);
