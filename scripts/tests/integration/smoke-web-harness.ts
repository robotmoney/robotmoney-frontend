// Shared by the `bun smoke:web` integration tests (issue #1026 W7, criteria 161
// and 164): a second source tree to build a second site version from, and the
// command itself run as an operator runs it.
//
// WHY A COPY OF THE TREE. `bun smoke:web` builds the site from the checkout it
// runs in (scripts/static-assembly.sh cds to its own repository root), and a
// test must not edit this checkout: other tests read it concurrently. So a
// second version is this checkout's source — tracked files plus untracked ones
// .gitignore keeps, exactly what the site's source identity covers — copied to
// a temporary directory, with frontend/package.json's `version` (and, for a
// refusal, `apiRange`) changed, committed into a throwaway Git repository so
// the site has a commit and a source identity of its own. Dependencies are the
// checkout's own, symlinked: the copy builds with the same installed contract.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BootHarness } from "./smoke-boot-harness.ts";

export const repoRoot = join(import.meta.dir, "..", "..", "..");

export interface VariantTree {
  readonly dir: string;
  /** The site id the variant's assembly gets: `<version>-<short commit>`. */
  readonly siteId: string;
  readonly version: string;
  dispose(): void;
}

function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=smoke-web-test", "-c", "user.email=smoke-web-test@invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** A copy of this checkout's source whose web client is `version` with `apiRange`. */
export function variantTree(version: string, apiRange: string): VariantTree {
  const dir = mkdtempSync(join(tmpdir(), "rm-smoke-web-variant-"));
  const files = Bun.spawnSync(["git", "ls-files", "-co", "--exclude-standard", "-z"], { cwd: repoRoot, stdout: "pipe" })
    .stdout.toString()
    .split("\0")
    .filter((f) => f !== "");
  for (const file of files) {
    const from = join(repoRoot, file);
    const to = join(dir, file);
    mkdirSync(dirname(to), { recursive: true });
    try {
      cpSync(from, to, { verbatimSymlinks: true });
    } catch {
      // A file listed by the index but deleted in the working tree is not source.
    }
  }
  for (const modules of ["node_modules", "backend/node_modules"]) symlinkSync(join(repoRoot, modules), join(dir, modules));
  const pkgPath = join(dir, "frontend", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  writeFileSync(pkgPath, `${JSON.stringify({ ...pkg, version, apiRange }, null, 2)}\n`);
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", `smoke:web test variant ${version}`]);
  const commit = git(dir, ["rev-parse", "--short", "HEAD"]);
  return { dir, version, siteId: `${version}-${commit}`, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Run `bun smoke:web` from `tree` (this checkout by default) against the harness's instance. */
export async function smokeWeb(
  h: BootHarness,
  args: readonly string[] = [],
  tree: string = repoRoot,
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "--no-env-file", "scripts/smoke-web.ts", "--instance", h.instance, ...args], {
    cwd: tree,
    env: h.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: `${out}${err}` };
}

export interface ServiceContainer {
  readonly id: string;
  readonly startedAt: string;
  readonly restartCount: number;
}

/**
 * Each compose service's container in `project`: its id (a recreate changes
 * it), its start time and Docker's restart count (a restart moves both).
 */
export function serviceContainers(project: string): Record<string, ServiceContainer> {
  const ids = Bun.spawnSync(
    ["docker", "ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.oneoff=False"],
    { stdout: "pipe", stderr: "pipe" },
  ).stdout.toString().split("\n").map((l) => l.trim()).filter(Boolean);
  const out: Record<string, ServiceContainer> = {};
  if (ids.length === 0) return out;
  const inspect = Bun.spawnSync(
    ["docker", "inspect", "--format", '{{index .Config.Labels "com.docker.compose.service"}}\t{{.Id}}\t{{.State.StartedAt}}\t{{.RestartCount}}', ...ids],
    { stdout: "pipe", stderr: "pipe" },
  ).stdout.toString();
  for (const line of inspect.split("\n")) {
    const [service = "", id = "", startedAt = "", restarts = "0"] = line.trim().split("\t");
    if (service) out[service] = { id, startedAt, restartCount: Number(restarts) };
  }
  return out;
}

/**
 * What changed between two snapshots, as readable lines; `[]` when nothing did.
 *
 * Every service keeps its container id: nothing was recreated. Every service
 * keeps its start time and restart count too, except one Docker was ALREADY
 * restarting on its own before the operation began (restart count above zero
 * in `before`): its later restarts are its own loop, not the operation's, and
 * only its id is compared. `restartingBefore` lists those services, so a test
 * can say which it relaxed.
 */
export function containerChanges(
  before: Record<string, ServiceContainer>,
  after: Record<string, ServiceContainer>,
): { changes: string[]; restartingBefore: string[] } {
  const changes: string[] = [];
  const restartingBefore: string[] = [];
  for (const [service, was] of Object.entries(before)) {
    const now = after[service];
    if (now === undefined) {
      changes.push(`${service}: container gone`);
      continue;
    }
    if (now.id !== was.id) changes.push(`${service}: recreated (${was.id.slice(0, 12)} -> ${now.id.slice(0, 12)})`);
    if (was.restartCount > 0) {
      restartingBefore.push(service);
      continue;
    }
    if (now.startedAt !== was.startedAt || now.restartCount !== was.restartCount) {
      changes.push(`${service}: restarted (started ${was.startedAt} -> ${now.startedAt}, restarts ${was.restartCount} -> ${now.restartCount})`);
    }
  }
  for (const service of Object.keys(after)) if (!(service in before)) changes.push(`${service}: new container`);
  return { changes, restartingBefore };
}

/** What website-server serves as `/version.json` right now. */
export async function servedSite(webPort: number): Promise<{ version: string; commit: string; apiRange: string | null }> {
  const res = await fetch(`http://127.0.0.1:${webPort}/version.json`);
  return (await res.json()) as { version: string; commit: string; apiRange: string | null };
}
