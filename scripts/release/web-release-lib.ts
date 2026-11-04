// scripts/release/web-release-lib.ts — the web content release runbook (D81,
// docs/technical/release-runbooks.md §12): its loader and validator, the
// content-only eligibility classifier, the nine step kinds and the runner.
//
// The runbook is ./runbooks/web-content.yaml; ./web-release.ts is the CLI. It is
// modeled on ./sdk-release-lib.ts (whose CI polls it reuses) and keeps the
// platform runbook's conventions (Bun.YAML, step ids, `irreversible`, refusal
// of unknown keys). It reads the platform's target file (./target.ts) for where
// production lives and runs its host commands over ssh in the platform's shape
// (./steps.ts: `env -i`, BASE_ENV, shellQuote), with no new target key.
//
// A web content release ships main commits that touch only WEB_CONTENT_PATHS
// (scripts/lib/website-release.ts) to production's website-server through the
// existing `bun smoke:web`, with no database write, no migration and no api or
// worker restart. The runner cherry-picks the named main commits onto
// web/releases-A.B.x (created at the commit production's API runs), pushes it as
// a fast-forward, waits for web-client.yml, cuts the annotated web-vA.B.C tag,
// waits for web-tag-guard.yml, checks the tag out on the host, deploys, checks
// the live site and creates the GitHub release. A failed live check rolls the
// site back with `bun smoke:web --rollback`. The tag is never moved or deleted:
// the fix ships as web-vA.B.(C+1).
//
// Every git, gh, ssh and http call goes through an injected Deps, so the unit
// tests run the steps against a local bare origin and stubs. Each step has a
// read-only done check, so a rerun reports the steps already done and continues
// at the first that is not; `--dry-run` runs only the preflight and the checks.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareSemver, SEMVER } from "../check-analyst-sdk-tag.ts";
import { checkWebTag, WEB_MANIFEST, WEB_RELEASE_BRANCH_GLOB, WEB_TAG_PREFIX } from "../check-web-tag.ts";
import { WEB_CONTENT_PATHS } from "../lib/website-release.ts";
import { poll, readRun, type Deps as SdkDeps, type ExecResult, type StepResult } from "./sdk-release-lib.ts";
import { BASE_ENV, RELEASE_REPO_URL, shellQuote } from "./steps.ts";
import type { ReleaseTarget } from "./target.ts";

export type { ExecResult, StepResult } from "./sdk-release-lib.ts";

/** The committed web content runbook. It sits outside templates/ and releases/, so ./runbook.ts never reads it. */
export const WEB_RUNBOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), "runbooks", "web-content.yaml");

/** The nine kinds, in the one order the runbook holds them. */
export const WEB_KINDS = ["preflight", "branch", "gate", "tag", "tag-guard", "checkout", "deploy", "live-check", "release"] as const;
export type WebStepKind = (typeof WEB_KINDS)[number];

/** Whether each kind writes to GitHub or switches what production serves. A step's `irreversible` must say the same. */
const KIND_IRREVERSIBLE: Readonly<Record<WebStepKind, boolean>> = Object.freeze({
  preflight: false, branch: true, gate: false, tag: true, "tag-guard": false, checkout: false, deploy: true, "live-check": false, release: true,
});
const POLLING_KINDS: readonly WebStepKind[] = ["gate", "tag-guard"];

export interface WebStep {
  readonly id: string;
  readonly kind: WebStepKind;
  readonly description: string;
  readonly irreversible: boolean;
  /** gate and tag-guard: how long the step polls before it fails. */
  readonly maxMinutes?: number;
}

export interface WebRunbook {
  readonly steps: readonly WebStep[];
}

const TOP_KEYS = new Set(["runbook", "steps"]);
const STEP_KEYS = new Set(["id", "kind", "description", "irreversible", "maxMinutes"]);
const ID_RE = /^W\d{2}-[a-z][a-z0-9-]*$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** PURE. The web content runbook from its YAML text. Throws with every reason it is not one; each names its step. */
export function parseWebRunbook(text: string): WebRunbook {
  const doc = Bun.YAML.parse(text) as unknown;
  const errors: string[] = [];
  if (!isObject(doc)) throw new Error("web-content runbook: the file is a mapping with runbook and steps");
  for (const k of Object.keys(doc)) if (!TOP_KEYS.has(k)) errors.push(`web-content runbook: unknown key ${k}`);
  if (doc.runbook !== "web-content") errors.push("web-content runbook: runbook is web-content");
  if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
    errors.push("web-content runbook: steps is a non-empty list");
    throw new Error(errors.join("\n"));
  }
  const steps: WebStep[] = [];
  const seen = new Set<string>();
  for (const raw of doc.steps as unknown[]) {
    if (!isObject(raw)) { errors.push("web-content runbook: a step is a mapping"); continue; }
    const at = typeof raw.id === "string" && raw.id !== "" ? raw.id : "(no id)";
    const before = errors.length;
    for (const k of Object.keys(raw)) if (!STEP_KEYS.has(k)) errors.push(`${at}: unknown key ${k}`);
    if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) errors.push(`${at}: id is W<two digits>-<name>`);
    else if (seen.has(raw.id)) errors.push(`${at}: duplicate id`);
    else seen.add(raw.id);
    const kind = raw.kind as WebStepKind;
    const known = (WEB_KINDS as readonly string[]).includes(kind);
    if (!known) errors.push(`${at}: unknown kind ${String(raw.kind)} (one of ${WEB_KINDS.join(", ")})`);
    if (typeof raw.description !== "string" || raw.description.trim() === "") errors.push(`${at}: description is a non-empty string`);
    if (typeof raw.irreversible !== "boolean") errors.push(`${at}: irreversible is a boolean`);
    else if (known && raw.irreversible !== KIND_IRREVERSIBLE[kind]) errors.push(`${at}: a ${kind} step is irreversible: ${KIND_IRREVERSIBLE[kind]}`);
    if (POLLING_KINDS.includes(kind)) {
      if (!Number.isInteger(raw.maxMinutes) || (raw.maxMinutes as number) <= 0) errors.push(`${at}: a ${kind} step names maxMinutes, a positive integer`);
    } else if (raw.maxMinutes !== undefined) errors.push(`${at}: only a gate or tag-guard step carries maxMinutes`);
    if (errors.length > before) continue;
    const step: Record<string, unknown> = { id: raw.id, kind, description: raw.description, irreversible: raw.irreversible };
    if (raw.maxMinutes !== undefined) step.maxMinutes = raw.maxMinutes;
    steps.push(step as unknown as WebStep);
  }
  if (errors.length === 0) {
    const kinds = steps.map((s) => s.kind).join(",");
    if (kinds !== WEB_KINDS.join(",")) errors.push(`web-content runbook: the steps' kinds are ${kinds}, not ${WEB_KINDS.join(",")} (each once, in that order)`);
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return deepFreeze({ steps });
}

/** The committed web content runbook, validated. */
export function loadWebRunbook(path: string = WEB_RUNBOOK_PATH): WebRunbook {
  return parseWebRunbook(readFileSync(path, "utf8"));
}

// ── The content-only classifier ──────────────────────────────────────────────

/** PURE. Whether a repository path lies inside WEB_CONTENT_PATHS. */
export const isContentPath = (path: string): boolean =>
  WEB_CONTENT_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

/** PURE. A diff's paths: eligible when every one is a content path; otherwise every offending path, sorted. */
export function classifyContentDiff(paths: readonly string[]): { eligible: boolean; offending: string[] } {
  const offending = [...new Set(paths.filter((p) => !isContentPath(p)))].sort();
  return { eligible: offending.length === 0, offending };
}

// ── Target, Deps and inputs ──────────────────────────────────────────────────

/** Where a web content release acts: the platform target's host, home, instance and origin, and the runner's own checkout. */
export interface WebTarget {
  readonly name: string;
  readonly rmEnv: "stage" | "prod";
  readonly host: string;
  readonly home: string;
  readonly instance: string;
  readonly publicOrigin: string;
  /** The runner-owned checkout on the host: {home}/rm-web, never the platform release checkout. */
  readonly checkout: string;
  /** The host's smoke state root: {home}/.local/state/robotmoney-smoke (scripts/lib/smoke-state.ts stateRoot). */
  readonly stateRoot: string;
  readonly cloneFrom: string;
  /** Variables added to every host command's `env -i` (none for a real target; the integration test points them at its stack). */
  readonly env: Readonly<Record<string, string>>;
}

/** PURE. The web target for a platform target file: the same host, home, instance and origin; no new key. */
export function webTargetOf(t: ReleaseTarget): WebTarget {
  return {
    name: t.name, rmEnv: t.rmEnv, host: t.host, home: t.home, instance: t.instance, publicOrigin: t.publicOrigin,
    checkout: `${t.home}/rm-web`, stateRoot: `${t.home}/.local/state/robotmoney-smoke`, cloneFrom: RELEASE_REPO_URL, env: {},
  };
}

export interface HttpResult {
  readonly status: number;
  readonly body: string;
}

/** Everything the steps touch outside their own memory. The CLI binds real processes; the tests bind stubs. */
export interface Deps extends SdkDeps {
  /** Run one shell command on a host; collect its output. */
  ssh(host: string, remote: string): Promise<ExecResult>;
  /** GET a URL. Throws when it cannot be reached. */
  http(url: string): Promise<HttpResult>;
  readFile(path: string): string | undefined;
}

export interface Inputs {
  /** The main commits to ship, in the order they are cherry-picked. */
  readonly commits: readonly string[];
  readonly version?: string;
  readonly target: WebTarget;
  readonly dryRun: boolean;
  /** Where the runner keeps its scratch worktree, the W07 record and the notes. Stable across reruns. */
  readonly workDir: string;
}

/** What the preflight resolved: one web content release. */
export interface Release {
  readonly version: string;
  /** The release commit: the cherry-picked tip of the branch. */
  readonly commit: string;
  readonly branch: string;
  readonly tag: string;
  /** The commit production's API runs (/api/version). */
  readonly apiCommit: string;
  /** The eligibility base: the last web-v* tag when it descends from apiCommit, else apiCommit. */
  readonly base: string;
  /** The content paths the release changes since the base. */
  readonly changed: readonly string[];
}

export const GATE_WORKFLOW = "web-client.yml";
export const GATE_JOB = "web-client";
export const TAG_GUARD_WORKFLOW = "web-tag-guard.yml";

/** PURE. The release line's branch for a version: web/releases-A.B.x. */
export const webBranchOf = (version: string): string => `web/releases-${version.split(".").slice(0, 2).join(".")}.x`;

/** PURE. The rerun command for a run with these inputs. */
export function rerunCommand(inputs: Inputs): string {
  const parts = ["bun", "run", "release:web"];
  for (const c of inputs.commits) parts.push("--commit", c);
  if (inputs.target.name !== "prod") parts.push("--target", inputs.target.name);
  if (inputs.version) parts.push("--version", inputs.version);
  return parts.join(" ");
}

const lines = (s: string): string[] => s.split("\n").map((l) => l.trim()).filter(Boolean);
const failed = (detail: string): StepResult => ({ state: "failed", detail });
const errText = (r: ExecResult): string => (r.stderr.trim() || r.stdout.trim() || `exit ${r.status}`);
const short = (sha: string): string => sha.slice(0, 12);

/** The web client version in frontend/package.json at a revision, or undefined. */
function versionAt(deps: Deps, rev: string): string | undefined {
  const r = deps.git(["show", `${rev}:${WEB_MANIFEST}`]);
  if (r.status !== 0) return undefined;
  try {
    const v = (JSON.parse(r.stdout) as { version?: unknown }).version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The web-v* tags on origin, each with the commit it points at (peeled). Throws when origin cannot be read. */
export function remoteWebTags(deps: Deps): Map<string, string> {
  const r = deps.git(["ls-remote", "--tags", "origin", `refs/tags/${WEB_TAG_PREFIX}*`]);
  if (r.status !== 0) throw new Error(`git ls-remote --tags origin failed: ${errText(r)}`);
  const direct = new Map<string, string>();
  const peeled = new Map<string, string>();
  for (const l of lines(r.stdout)) {
    const [sha, ref] = l.split(/\s+/);
    if (!sha || !ref?.startsWith("refs/tags/")) continue;
    const name = ref.slice("refs/tags/".length);
    if (name.endsWith("^{}")) peeled.set(name.slice(0, -3), sha);
    else direct.set(name, sha);
  }
  const out = new Map<string, string>();
  for (const [name, sha] of direct) out.set(name, peeled.get(name) ?? sha);
  return out;
}

const isAncestor = (deps: Deps, a: string, b: string): boolean => deps.git(["merge-base", "--is-ancestor", a, b]).status === 0;

/** The paths a diff between two commits touches, both sides of a rename. */
function diffPaths(deps: Deps, from: string, to: string): string[] | { error: string } {
  const r = deps.git(["diff", "--name-only", "--no-renames", from, to]);
  if (r.status !== 0) return { error: `git diff ${short(from)} ${short(to)} failed: ${errText(r)}` };
  return lines(r.stdout);
}

// ── Host commands ────────────────────────────────────────────────────────────

/** PURE. One host command in the platform runner's shape: `env -i` with HOME, BASE_ENV, RM_ENV and the target's extras. */
export function envCommand(t: WebTarget, argv: readonly string[]): string {
  const env: Record<string, string> = { HOME: t.home, ...BASE_ENV, RM_ENV: t.rmEnv, ...t.env };
  const pairs = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  return `env -i ${pairs.join(" ")} ${argv.map(shellQuote).join(" ")}`;
}

/** PURE. W06's host command: clone {home}/rm-web when missing, fetch the tags, detach at the tag, install from the lockfile. */
export function checkoutCommand(t: WebTarget, tag: string): string {
  return [
    `{ test -e ${shellQuote(`${t.checkout}/.git`)} || ${envCommand(t, ["git", "clone", "--quiet", t.cloneFrom, t.checkout])}; }`,
    `cd ${shellQuote(t.checkout)}`,
    envCommand(t, ["git", "fetch", "--quiet", "--tags", "origin"]),
    envCommand(t, ["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", `refs/tags/${tag}`]),
    envCommand(t, ["bun", "install", "--frozen-lockfile"]),
  ].join(" && ");
}

/** PURE. W07's host command: `bun run smoke:web` from the runner's checkout. */
export const deployCommand = (t: WebTarget): string =>
  `cd ${shellQuote(t.checkout)} && ${envCommand(t, ["bun", "run", "smoke:web", "--instance", t.instance])}`;

/** PURE. W08's rollback: `bun run smoke:web --rollback` from the runner's checkout. */
export const rollbackCommand = (t: WebTarget): string =>
  `cd ${shellQuote(t.checkout)} && ${envCommand(t, ["bun", "run", "smoke:web", "--instance", t.instance, "--rollback"])}`;

const instanceDir = (t: WebTarget): string => `${t.stateRoot}/${t.instance}`;

/** PURE. Print a host file when it exists, nothing when it does not; any other exit means the host could not be read. */
const catIfPresent = (path: string): string => `if test -e ${shellQuote(path)}; then cat -- ${shellQuote(path)}; fi`;

/** PURE. Whether a site id (`<version>-<short commit>`, smoke-site.ts) names this version at this commit. */
export function siteIdIs(siteId: unknown, version: string, commit: string): boolean {
  if (typeof siteId !== "string" || !siteId.startsWith(`${version}-`)) return false;
  const c = siteId.slice(version.length + 1);
  return /^[0-9a-f]{7,40}$/.test(c) && commit.startsWith(c);
}

/** What production serves beside the site: the api and worker containers and the /api/version body. */
export interface Serving {
  readonly containers: Readonly<Record<string, string>>;
  readonly apiVersion: string;
}

/** Read the api and worker container ids (the instance's compose project) and /api/version. */
export async function readServing(t: WebTarget, deps: Deps): Promise<Serving | { error: string }> {
  const stack = await deps.ssh(t.host, catIfPresent(`${instanceDir(t)}/stack-state.json`));
  if (stack.status !== 0) return { error: `ssh ${t.host} could not read the stack record: ${errText(stack)}` };
  let project: unknown;
  try {
    project = (JSON.parse(stack.stdout) as { project?: unknown }).project;
  } catch {
    project = undefined;
  }
  if (typeof project !== "string" || project === "") return { error: `instance ${t.instance} on ${t.host} has no stack record naming its compose project` };
  const ps = await deps.ssh(t.host, envCommand(t, [
    "docker", "ps", "--no-trunc", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.oneoff=False",
    "--format", '{{.Label "com.docker.compose.service"}}\t{{.ID}}',
  ]));
  if (ps.status !== 0) return { error: `docker ps on ${t.host} failed: ${errText(ps)}` };
  const containers: Record<string, string> = {};
  for (const l of lines(ps.stdout)) {
    const [service = "", id = ""] = l.split("\t");
    if (service === "api" || service.startsWith("worker")) containers[service] = id;
  }
  if (containers.api === undefined) return { error: `no api container runs in project ${project} on ${t.host}` };
  const api = await readApiVersion(t, deps);
  if ("error" in api) return api;
  return { containers: Object.fromEntries(Object.entries(containers).sort()), apiVersion: JSON.stringify(api.body) };
}

async function readApiVersion(t: WebTarget, deps: Deps): Promise<{ body: { api?: unknown; commit?: unknown } } | { error: string }> {
  try {
    const r = await deps.http(`${t.publicOrigin}/api/version`);
    if (r.status !== 200) return { error: `GET ${t.publicOrigin}/api/version answered ${r.status}` };
    return { body: JSON.parse(r.body) as { api?: unknown; commit?: unknown } };
  } catch (e) {
    return { error: `GET ${t.publicOrigin}/api/version failed: ${(e as Error).message}` };
  }
}

/** What {publicOrigin}/version.json reports, or why it cannot be read. */
async function readLiveSite(t: WebTarget, deps: Deps): Promise<{ version: string; commit: string } | { error: string }> {
  try {
    const r = await deps.http(`${t.publicOrigin}/version.json`);
    if (r.status !== 200) return { error: `GET ${t.publicOrigin}/version.json answered ${r.status}` };
    const b = JSON.parse(r.body) as { version?: unknown; commit?: unknown };
    return { version: String(b.version), commit: String(b.commit) };
  } catch (e) {
    return { error: `GET ${t.publicOrigin}/version.json failed: ${(e as Error).message}` };
  }
}

const liveIs = (site: { version: string; commit: string }, rel: Release): boolean =>
  site.version === rel.version && /^[0-9a-f]{7,40}$/.test(site.commit) && rel.commit.startsWith(site.commit);

// ── W01: preflight ───────────────────────────────────────────────────────────

/**
 * The preflight (read only towards origin and the host): the release it
 * resolves, or every reason it refuses. It cherry-picks the named commits in a
 * scratch worktree of the operator's checkout, so the content-only check runs
 * on the tree W02 would push.
 */
export async function preflight(inputs: Inputs, deps: Deps): Promise<{ release: Release } | { errors: string[] }> {
  const t = inputs.target;
  if (inputs.commits.length === 0) return { errors: ["name the main commits to ship: --commit <sha> (repeatable)"] };
  const fetched = deps.git(["fetch", "--quiet", "--tags", "origin",
    "+refs/heads/main:refs/remotes/origin/main", "+refs/heads/web/*:refs/remotes/origin/web/*", "+refs/heads/releases-*:refs/remotes/origin/releases-*"]);
  if (fetched.status !== 0) return { errors: [`git fetch origin failed: ${errText(fetched)}`] };

  // Each named commit: on main, and content-only in its own diff.
  const errors: string[] = [];
  const commits: string[] = [];
  for (const c of inputs.commits) {
    const r = deps.git(["rev-parse", "--verify", "--quiet", `${c}^{commit}`]);
    if (r.status !== 0) { errors.push(`--commit ${c} is not a commit here`); continue; }
    const sha = r.stdout.trim();
    commits.push(sha);
    if (!isAncestor(deps, sha, "origin/main")) errors.push(`commit ${short(sha)} is not on origin/main (a web release ships main commits only)`);
    const own = diffPaths(deps, `${sha}^`, sha);
    if ("error" in own) { errors.push(own.error); continue; }
    const cls = classifyContentDiff(own);
    if (!cls.eligible) errors.push(`commit ${short(sha)} is not content-only; it touches ${cls.offending.join(", ")}: ship it with bun run release:run`);
  }
  if (errors.length > 0) return { errors };

  // Production's API commit.
  const api = await readApiVersion(t, deps);
  if ("error" in api) return { errors: [api.error] };
  const apiSha = typeof api.body.commit === "string" ? api.body.commit : "";
  if (!/^[0-9a-f]{40}$/.test(apiSha)) return { errors: [`${t.publicOrigin}/api/version reports commit ${JSON.stringify(api.body.commit)}, not a full commit sha`] };
  if (deps.git(["rev-parse", "--verify", "--quiet", `${apiSha}^{commit}`]).status !== 0) {
    return { errors: [`production's API commit ${short(apiSha)} is not in this checkout after git fetch origin`] };
  }

  // The version and its branch.
  const version = inputs.version ?? versionAt(deps, commits[commits.length - 1]!);
  if (version === undefined) return { errors: [`no version: pass --version, or ${WEB_MANIFEST} at ${short(commits[commits.length - 1]!)} names none`] };
  if (!SEMVER.test(version)) return { errors: [`version ${version} is not A.B.C`] };
  const branch = webBranchOf(version);
  const tag = `${WEB_TAG_PREFIX}${version}`;
  let tags: Map<string, string>;
  try {
    tags = remoteWebTags(deps);
  } catch (e) {
    return { errors: [(e as Error).message] };
  }

  // The eligibility base: the last web-v* tag below this version when it
  // descends from the API commit (production serves its content), else the API commit.
  const below = [...tags.keys()].map((n) => n.slice(WEB_TAG_PREFIX.length)).filter((v) => SEMVER.test(v) && compareSemver(v, version) < 0).sort(compareSemver);
  const lastTag = below.length > 0 ? `${WEB_TAG_PREFIX}${below[below.length - 1]}` : undefined;
  const lastTagCommit = lastTag ? tags.get(lastTag)! : undefined;
  const base = lastTagCommit !== undefined && isAncestor(deps, apiSha, lastTagCommit) ? lastTagCommit : apiSha;
  const baseName = base === apiSha ? "production's API commit" : lastTag!;

  // The candidate: the branch tip (or, for a new branch, the base) with each named commit cherry-picked, in order.
  const tipRead = deps.git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`]);
  const start = tipRead.status === 0 ? tipRead.stdout.trim() : base;
  const built = buildCandidate(deps, start, commits, inputs.workDir);
  if ("error" in built) return { errors: [built.error] };
  const commit = built.commit;
  const atCandidate = versionAt(deps, commit);
  if (atCandidate !== version) errors.push(`${WEB_MANIFEST} at the release commit ${short(commit)} says ${atCandidate ?? "nothing"}, not ${version}`);
  errors.push(...versionProblems(tags, version, tag, commit));

  let changed: string[] = [];
  if (!isAncestor(deps, base, commit)) {
    errors.push(`the release commit ${short(commit)} on ${branch} does not descend from the base ${short(base)} (${baseName}): ${branch} was cut from another release`);
  } else {
    const fromBase = diffPaths(deps, base, commit);
    const fromApi = diffPaths(deps, apiSha, commit);
    if ("error" in fromBase) errors.push(fromBase.error);
    else if ("error" in fromApi) errors.push(fromApi.error);
    else {
      const cls = classifyContentDiff([...fromBase, ...fromApi]);
      if (!cls.eligible) {
        errors.push(`the release tree differs from production's API commit ${short(apiSha)} outside the web content paths: ${cls.offending.join(", ")}. Ship it with bun run release:run`);
      }
      changed = [...new Set(fromBase)].sort();
    }
  }
  if (errors.length > 0) return { errors };
  if (tags.get(tag) === commit) {
    const rolled = await rolledBack(t, deps, version, tag, commit);
    if (rolled !== undefined) return { errors: [rolled] };
  }
  const admin = deps.gh(["api", "repos/{owner}/{repo}", "--jq", ".permissions.admin"]);
  if (admin.status !== 0) return { errors: [`gh api repos/{owner}/{repo} failed: ${errText(admin)}`] };
  if (admin.stdout.trim() !== "true") return { errors: ["the operator lacks the admin permission on the repository (the tag push needs it)"] };
  return { release: { version, commit, branch, tag, apiCommit: apiSha, base, changed } };
}

/** The candidate commit: `start` with each commit not already on it cherry-picked (-x), in a scratch worktree. */
function buildCandidate(deps: Deps, start: string, commits: readonly string[], workDir: string): { commit: string } | { error: string } {
  const log = deps.git(["log", "--format=%B", `refs/remotes/origin/main..${start}`]);
  if (log.status !== 0) return { error: `git log origin/main..${short(start)} failed: ${errText(log)}` };
  const picked = new Set([...log.stdout.matchAll(/\(cherry picked from commit ([0-9a-f]{40})\)/g)].map((m) => m[1]!));
  const todo = commits.filter((c) => !picked.has(c) && !isAncestor(deps, c, start));
  if (todo.length === 0) return { commit: start };
  const wt = join(workDir, `candidate-${deps.clock()}`);
  const add = deps.git(["worktree", "add", "--quiet", "--detach", wt, start]);
  if (add.status !== 0) return { error: `git worktree add ${wt} failed: ${errText(add)}` };
  const cleanup = () => { deps.git(["worktree", "remove", "--force", wt]); deps.git(["worktree", "prune"]); };
  for (const c of todo) {
    const r = deps.git(["-C", wt, "cherry-pick", "-x", c]);
    if (r.status !== 0) {
      deps.git(["-C", wt, "cherry-pick", "--abort"]);
      cleanup();
      return { error: `cherry-picking ${short(c)} onto ${short(start)} conflicts: ${errText(r)}. Nothing was pushed` };
    }
  }
  const head = deps.git(["-C", wt, "rev-parse", "HEAD"]);
  cleanup();
  if (head.status !== 0) return { error: `git rev-parse in ${wt} failed: ${errText(head)}` };
  return { commit: head.stdout.trim() };
}

/** PURE. Why the version cannot be tagged: not above every web-v* tag, or its tag exists at another commit. */
function versionProblems(tags: Map<string, string>, version: string, tag: string, commit: string): string[] {
  const out: string[] = [];
  for (const name of tags.keys()) {
    const v = name.slice(WEB_TAG_PREFIX.length);
    if (!SEMVER.test(v) || compareSemver(version, v) > 0) continue;
    if (v === version && tags.get(tag) === commit) continue;
    out.push(v === version
      ? `${tag} already exists at ${short(tags.get(tag)!)}, not at ${short(commit)}; a web tag is never moved: ship as the next version`
      : `version ${version} is not above the tag ${name}`);
  }
  return out;
}

/** PURE. The patch version after A.B.C. */
const nextPatch = (version: string): string => {
  const [a, b, c] = version.split(".").map(Number);
  return `${a}.${b}.${c! + 1}`;
};

/** Why a rerun may not resume an existing tag: the host's web receipt says W08 rolled it back. */
async function rolledBack(t: WebTarget, deps: Deps, version: string, tag: string, commit: string): Promise<string | undefined> {
  const receipt = await deps.ssh(t.host, catIfPresent(`${instanceDir(t)}/web/receipt.json`));
  if (receipt.status !== 0) return `ssh ${t.host} could not read the web receipt: ${errText(receipt)}`;
  if (receipt.stdout.trim() === "") return undefined;
  let r: { action?: unknown; previous?: unknown };
  try {
    r = JSON.parse(receipt.stdout) as typeof r;
  } catch {
    return `the web receipt on ${t.host} is not JSON`;
  }
  if (r.action === "rollback" && siteIdIs(r.previous, version, commit)) {
    return `${tag} was rolled back at W08 on ${t.host}; the tag is never moved or cut again: ship the fix as ${WEB_TAG_PREFIX}${nextPatch(version)}`;
  }
  return undefined;
}

// ── W02: branch ──────────────────────────────────────────────────────────────

function remoteBranchTip(deps: Deps, branch: string): string | undefined {
  const r = deps.git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
  if (r.status !== 0) throw new Error(`git ls-remote origin ${branch} failed: ${errText(r)}`);
  return lines(r.stdout)[0]?.split(/\s+/)[0];
}

/** The branch step's done check: done when the remote tip is the release commit; todo when absent or behind it. */
export function checkBranch(rel: Release, deps: Deps): StepResult {
  let tip: string | undefined;
  try {
    tip = remoteBranchTip(deps, rel.branch);
  } catch (e) {
    return failed((e as Error).message);
  }
  if (tip === undefined) return { state: "todo", detail: `origin/${rel.branch} is absent: create it at ${rel.commit}` };
  if (tip === rel.commit) return { state: "done", detail: `origin/${rel.branch} is at ${rel.commit}` };
  if (isAncestor(deps, tip, rel.commit)) return { state: "todo", detail: `origin/${rel.branch} is at ${tip}, an ancestor of ${rel.commit}: fast-forward it` };
  return failed(`origin/${rel.branch} is at ${tip}, not an ancestor of ${rel.commit}: the runner only fast-forwards (no force push)`);
}

/** The branch step's write: push the release commit to the branch, never forced. */
export function runBranch(rel: Release, deps: Deps): StepResult {
  const p = deps.git(["push", "origin", `${rel.commit}:refs/heads/${rel.branch}`]);
  if (p.status !== 0) return failed(`git push origin ${rel.branch} failed: ${errText(p)}`);
  const f = deps.git(["fetch", "--quiet", "origin", `+refs/heads/${rel.branch}:refs/remotes/origin/${rel.branch}`]);
  if (f.status !== 0) return failed(`git fetch origin ${rel.branch} failed: ${errText(f)}`);
  return { state: "done", detail: `pushed ${rel.commit} to origin/${rel.branch}` };
}

// ── W03 and W05: the polled CI reads ─────────────────────────────────────────

type Read = ReturnType<typeof readRun>;
const asCheck = (r: Read): StepResult => ({ state: r.state === "pass" ? "done" : r.state === "wait" ? "todo" : "failed", detail: r.detail });
export const readGate = (rel: Release, deps: Deps): Read => readRun(deps, GATE_WORKFLOW, rel.branch, rel.commit, GATE_JOB);
export const readTagGuard = (rel: Release, deps: Deps): Read => readRun(deps, TAG_GUARD_WORKFLOW, rel.tag, rel.commit);

// ── W04: tag ─────────────────────────────────────────────────────────────────

/** The tag step's done check: done when the tag on origin points at the commit, failed when at another. */
export function checkTagStep(rel: Release, deps: Deps): StepResult {
  let tags: Map<string, string>;
  try {
    tags = remoteWebTags(deps);
  } catch (e) {
    return failed((e as Error).message);
  }
  const at = tags.get(rel.tag);
  if (at === undefined) return { state: "todo", detail: `${rel.tag} is absent: tag ${rel.commit}` };
  if (at === rel.commit) return { state: "done", detail: `${rel.tag} is at ${rel.commit}` };
  return failed(`${rel.tag} exists at ${at}, not ${rel.commit}; a web tag is never moved`);
}

/** The tag step's write: checkWebTag on the computed inputs, then the annotated tag, pushed. */
export function runTagStep(rel: Release, deps: Deps): StepResult {
  const f = deps.git(["fetch", "--quiet", "origin", "+refs/heads/web/*:refs/remotes/origin/web/*"]);
  if (f.status !== 0) return failed(`git fetch origin failed: ${errText(f)}`);
  const b = deps.git(["branch", "-r", "--list", WEB_RELEASE_BRANCH_GLOB, "--contains", rel.commit]);
  if (b.status !== 0) return failed(`git branch -r --contains ${rel.commit} failed: ${errText(b)}`);
  let tags: Map<string, string>;
  try {
    tags = remoteWebTags(deps);
  } catch (e) {
    return failed((e as Error).message);
  }
  const reasons = checkWebTag({ tag: rel.tag, packageVersion: versionAt(deps, rel.commit) ?? "(none)", webTags: [...tags.keys()], branchesContainingCommit: lines(b.stdout) });
  if (reasons.length > 0) return failed(`checkWebTag refuses ${rel.tag}: ${reasons.join("; ")}`);
  const local = deps.git(["rev-parse", "--verify", "--quiet", `refs/tags/${rel.tag}^{commit}`]);
  if (local.status === 0) {
    const type = deps.git(["cat-file", "-t", `refs/tags/${rel.tag}`]).stdout.trim();
    if (local.stdout.trim() !== rel.commit || type !== "tag") {
      return failed(`a local tag ${rel.tag} (${type} at ${local.stdout.trim()}) is not an annotated tag of ${rel.commit}: delete it with git tag -d ${rel.tag}`);
    }
  } else {
    const t = deps.git(["tag", "-a", rel.tag, rel.commit, "-m", `web content release ${rel.version}`]);
    if (t.status !== 0) return failed(`git tag ${rel.tag} failed: ${errText(t)}`);
  }
  const p = deps.git(["push", "origin", `refs/tags/${rel.tag}`]);
  if (p.status !== 0) return failed(`git push origin ${rel.tag} failed: ${errText(p)}`);
  return { state: "done", detail: `pushed the annotated ${rel.tag} at ${rel.commit}` };
}

// ── W06: checkout ────────────────────────────────────────────────────────────

/** The checkout step's done check: {home}/rm-web is detached at the release commit with its dependencies installed. */
export async function checkCheckout(rel: Release, t: WebTarget, deps: Deps): Promise<StepResult> {
  const r = await deps.ssh(t.host, `if test -e ${shellQuote(`${t.checkout}/.git`)}; then cd ${shellQuote(t.checkout)} && ${envCommand(t, ["git", "rev-parse", "HEAD"])} && { test -d node_modules/@robotmoney/contract && echo installed || true; }; fi`);
  if (r.status !== 0) return failed(`ssh ${t.host} could not read ${t.checkout}: ${errText(r)}`);
  const [head, installed] = lines(r.stdout);
  if (head === undefined) return { state: "todo", detail: `${t.host}:${t.checkout} is absent: clone it` };
  if (head !== rel.commit) return { state: "todo", detail: `${t.host}:${t.checkout} is at ${short(head)}: detach it at ${rel.tag}` };
  if (installed !== "installed") return { state: "todo", detail: `${t.host}:${t.checkout} is at ${rel.tag} without its dependencies: install them` };
  return { state: "done", detail: `${t.host}:${t.checkout} is detached at ${rel.tag} (${short(rel.commit)}) and installed` };
}

export async function runCheckout(rel: Release, t: WebTarget, deps: Deps): Promise<StepResult> {
  const r = await deps.ssh(t.host, checkoutCommand(t, rel.tag));
  if (r.status !== 0) return failed(`the checkout on ${t.host} exited ${r.status}: ${errText(r)}`);
  const after = await checkCheckout(rel, t, deps);
  return after.state === "done" ? after : failed(`after the checkout: ${after.detail}`);
}

// ── W07: deploy ──────────────────────────────────────────────────────────────

/** PURE. Where W07 records what production served beside the site before the deploy. */
export const servingRecordPath = (inputs: Pick<Inputs, "workDir">, rel: Pick<Release, "tag">): string => join(inputs.workDir, `${rel.tag}-w07-serving.json`);

function readRecord(inputs: Inputs, rel: Release, deps: Deps): Serving | undefined {
  const text = deps.readFile(servingRecordPath(inputs, rel));
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as Serving;
  } catch {
    return undefined;
  }
}

/** The deploy step's done check: the live /version.json reports the release, and W07's record exists. */
export async function checkDeploy(rel: Release, inputs: Inputs, deps: Deps): Promise<StepResult> {
  const live = await readLiveSite(inputs.target, deps);
  if ("error" in live) return failed(live.error);
  if (!liveIs(live, rel)) return { state: "todo", detail: `${inputs.target.publicOrigin} serves ${live.version}-${live.commit}: deploy ${rel.tag}` };
  if (readRecord(inputs, rel, deps) === undefined) {
    return failed(`${inputs.target.publicOrigin} already serves ${rel.tag}, but ${servingRecordPath(inputs, rel)} (W07's record of the api and workers) is missing, so W08 has nothing to compare: check the site by hand`);
  }
  return { state: "done", detail: `${inputs.target.publicOrigin} serves ${rel.version}-${live.commit}` };
}

/** The deploy step's write: record the api and worker containers and /api/version, then `bun run smoke:web`. */
export async function runDeploy(rel: Release, inputs: Inputs, deps: Deps): Promise<StepResult> {
  const t = inputs.target;
  const serving = await readServing(t, deps);
  if ("error" in serving) return failed(serving.error);
  deps.writeFile(servingRecordPath(inputs, rel), `${JSON.stringify(serving, null, 2)}\n`);
  const r = await deps.ssh(t.host, deployCommand(t));
  if (r.status !== 0) return failed(`bun run smoke:web on ${t.host} exited ${r.status}: ${errText(r)}`);
  return { state: "done", detail: `bun run smoke:web switched ${t.instance}'s site to ${rel.tag}; api and workers recorded (${Object.keys(serving.containers).join(", ")})` };
}

// ── W08: live check ──────────────────────────────────────────────────────────

/** Every way the live site is not this release served beside an unchanged api: empty when it is. */
export async function liveProblems(rel: Release, inputs: Inputs, deps: Deps): Promise<string[]> {
  const t = inputs.target;
  const before = readRecord(inputs, rel, deps);
  if (before === undefined) return [`${servingRecordPath(inputs, rel)} (W07's record) is missing`];
  const out: string[] = [];
  const live = await readLiveSite(t, deps);
  if ("error" in live) out.push(live.error);
  else if (!liveIs(live, rel)) out.push(`${t.publicOrigin}/version.json reports ${live.version}-${live.commit}, not ${rel.version}-${short(rel.commit)}`);
  let routes: string[] = [];
  try {
    const sm = await deps.http(`${t.publicOrigin}/sitemap.xml`);
    if (sm.status !== 200) out.push(`GET ${t.publicOrigin}/sitemap.xml answered ${sm.status}`);
    else routes = [...sm.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => { const u = new URL(m[1]!); return `${u.pathname}${u.search}`; });
    if (sm.status === 200 && routes.length === 0) out.push(`${t.publicOrigin}/sitemap.xml lists no route`);
  } catch (e) {
    out.push(`GET ${t.publicOrigin}/sitemap.xml failed: ${(e as Error).message}`);
  }
  for (const route of routes) {
    try {
      const r = await deps.http(`${t.publicOrigin}${route}`);
      if (r.status !== 200) out.push(`GET ${route} answered ${r.status}`);
    } catch (e) {
      out.push(`GET ${route} failed: ${(e as Error).message}`);
    }
  }
  const now = await readServing(t, deps);
  if ("error" in now) out.push(now.error);
  else {
    if (JSON.stringify(now.containers) !== JSON.stringify(before.containers)) {
      out.push(`the api and worker containers changed: ${JSON.stringify(before.containers)} -> ${JSON.stringify(now.containers)}`);
    }
    if (now.apiVersion !== before.apiVersion) out.push(`/api/version changed: ${before.apiVersion} -> ${now.apiVersion}`);
  }
  return out;
}

export async function checkLive(rel: Release, inputs: Inputs, deps: Deps): Promise<StepResult> {
  const problems = await liveProblems(rel, inputs, deps);
  return problems.length === 0
    ? { state: "done", detail: `${inputs.target.publicOrigin} serves ${rel.tag}, every sitemap route answers 200, the api and workers are unchanged` }
    : { state: "todo", detail: problems.join("; ") };
}

/** The live check: pass, or roll the site back with `bun run smoke:web --rollback` and fail. The tag stays. */
export async function runLive(rel: Release, inputs: Inputs, deps: Deps): Promise<StepResult> {
  const t = inputs.target;
  const problems = await liveProblems(rel, inputs, deps);
  if (problems.length === 0) return { state: "done", detail: `${t.publicOrigin} serves ${rel.tag}, every sitemap route answers 200, the api and workers are unchanged` };
  const next = `${WEB_TAG_PREFIX}${nextPatch(rel.version)}`;
  deps.log(`[web-release] the live check failed: ${problems.join("; ")}; rolling back`);
  const r = await deps.ssh(t.host, rollbackCommand(t));
  const rolled = r.status === 0 ? "rolled back to the previous site (bun run smoke:web --rollback)" : `THE ROLLBACK FAILED (exit ${r.status}: ${errText(r)}): run bun run smoke:web --rollback --instance ${t.instance} on ${t.host} by hand`;
  return failed(`the live check failed: ${problems.join("; ")}. ${rolled}. ${rel.tag} stays where it is: ship the fix as ${next}`);
}

// ── W09: release ─────────────────────────────────────────────────────────────

/** PURE. The release notes: what the release is, the commits it ships, and every changed content path. */
export function renderNotes(rel: Release, picks: readonly string[]): string {
  const out = [
    `## Web content release ${rel.tag}`, "",
    `- **Commit.** ${rel.commit} on \`${rel.branch}\`.`,
    `- **API.** Production's API runs ${rel.apiCommit}. This release changes no path outside the web content paths (D81), so it ships with \`bun smoke:web\` alone: no migration, no database write, no api or worker restart.`,
    "", "## Main commits", "",
    ...picks.map((p) => `- ${p}`),
    "", `## Changed content paths since ${short(rel.base)}`, "",
    ...(rel.changed.length === 0 ? ["- (none)"] : rel.changed.map((p) => `- \`${p}\``)),
    "",
  ];
  return out.join("\n");
}

export function checkReleaseStep(rel: Release, deps: Deps): StepResult {
  const v = deps.gh(["release", "view", rel.tag, "--json", "tagName"]);
  if (v.status === 0) return { state: "done", detail: `the GitHub release ${rel.tag} exists` };
  if (/not found/i.test(v.stderr + v.stdout)) return { state: "todo", detail: `no GitHub release for ${rel.tag}: create it` };
  return failed(`gh release view ${rel.tag} failed: ${errText(v)}`);
}

/** The release step's write: gh release create, never marked latest (the platform's release keeps that). */
export function runReleaseStep(rel: Release, inputs: Inputs, deps: Deps): StepResult {
  const picks = inputs.commits.map((c) => {
    const s = deps.git(["log", "-1", "--format=%H %s", c]);
    return s.status === 0 ? s.stdout.trim() : c;
  });
  const path = join(inputs.workDir, `${rel.tag}-notes.md`);
  deps.writeFile(path, renderNotes(rel, picks));
  const c = deps.gh(["release", "create", rel.tag, "--verify-tag", "--title", `web ${rel.version}`, "--notes-file", path, "--latest=false"]);
  if (c.status !== 0) return failed(`gh release create ${rel.tag} failed: ${errText(c)}`);
  return { state: "done", detail: `created the GitHub release ${rel.tag}` };
}

// ── The runner ───────────────────────────────────────────────────────────────

/** PURE. The plan's lines: each step id with its kind and IRREVERSIBLE mark. */
export function planLines(runbook: WebRunbook): string[] {
  const w = Math.max(...runbook.steps.map((s) => s.id.length));
  return runbook.steps.map((s) => `  ${s.id.padEnd(w)}  ${s.kind}${s.irreversible ? "  IRREVERSIBLE" : ""}`);
}

/** Run the runbook: print the plan, run the preflight, then each step's done check and (unless done or a dry run) its write. Returns the exit code. */
export async function runWebRelease(runbook: WebRunbook, inputs: Inputs, deps: Deps): Promise<number> {
  const t = inputs.target;
  deps.log(`[web-release] web content release runbook, ${runbook.steps.length} steps, target ${t.name} (${t.host})${inputs.dryRun ? " (dry run: nothing is written)" : ""}`);
  for (const l of planLines(runbook)) deps.log(l);
  const rerun = rerunCommand(inputs);
  const stop = (id: string, reason: string): number => {
    deps.log(`[web-release] FAILED at ${id}: ${reason}`);
    deps.log(`[web-release] rerun: ${rerun}`);
    return 1;
  };
  const [first, ...rest] = runbook.steps;
  const pre = await preflight(inputs, deps);
  if ("errors" in pre) return stop(first!.id, pre.errors.join("; "));
  const rel = pre.release;
  deps.log(`[web-release] version ${rel.version}, commit ${rel.commit}, branch ${rel.branch}, tag ${rel.tag}, base ${rel.base}`);
  deps.log(`[web-release] content paths changed: ${rel.changed.length === 0 ? "(none)" : rel.changed.join(", ")}`);
  deps.log(`[${first!.id}] passed`);
  for (const step of rest) {
    const check: StepResult =
      step.kind === "branch" ? checkBranch(rel, deps)
      : step.kind === "gate" ? asCheck(readGate(rel, deps))
      : step.kind === "tag" ? checkTagStep(rel, deps)
      : step.kind === "tag-guard" ? asCheck(readTagGuard(rel, deps))
      : step.kind === "checkout" ? await checkCheckout(rel, t, deps)
      : step.kind === "deploy" ? await checkDeploy(rel, inputs, deps)
      : step.kind === "live-check" ? await checkLive(rel, inputs, deps)
      : checkReleaseStep(rel, deps);
    if (check.state === "done") { deps.log(`[${step.id}] already done: ${check.detail}`); continue; }
    if (check.state === "failed") return stop(step.id, check.detail);
    if (inputs.dryRun) { deps.log(`[${step.id}] not done${step.irreversible ? " (IRREVERSIBLE, would write)" : ""}: ${check.detail}`); continue; }
    const result: StepResult =
      step.kind === "branch" ? runBranch(rel, deps)
      : step.kind === "gate" ? await poll(() => readGate(rel, deps), step.maxMinutes!, deps, step.id, rerun)
      : step.kind === "tag" ? runTagStep(rel, deps)
      : step.kind === "tag-guard" ? await poll(() => readTagGuard(rel, deps), step.maxMinutes!, deps, step.id, rerun)
      : step.kind === "checkout" ? await runCheckout(rel, t, deps)
      : step.kind === "deploy" ? await runDeploy(rel, inputs, deps)
      : step.kind === "live-check" ? await runLive(rel, inputs, deps)
      : runReleaseStep(rel, inputs, deps);
    if (result.state !== "done") return stop(step.id, result.detail);
    deps.log(`[${step.id}] done: ${result.detail}`);
  }
  deps.log(inputs.dryRun ? "[web-release] dry run complete: nothing was written" : `[web-release] ${rel.tag} is live on ${t.publicOrigin}`);
  return 0;
}

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null) {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}
