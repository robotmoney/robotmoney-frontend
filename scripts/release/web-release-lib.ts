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
// A web content release ships the WEB_CONTENT_PATHS part (scripts/lib/
// website-release.ts) of named main commits, with their tests, to production's website-server
// through the existing `bun smoke:web`, with no database write, no migration
// and no api or worker restart. The runner cherry-picks that part of each
// commit onto web/releases-A.B.x (created at the eligibility base: production's
// API commit, or the last web tag on it), carrying its tests and leaving out
// docs and comment-only edits (issue 1603), pushes it as a fast-forward, waits for
// web-client.yml and e2e-web.yml, cuts the annotated web-vA.B.C tag,
// waits for web-tag-guard.yml, checks the tag out on the host, deploys, checks
// the live site (the served bytes against the host's web/current, and a
// headless browser against production's data: ./web-browser-smoke.ts) and
// creates the GitHub release. A failed live check rolls the site back with
// `bun smoke:web --rollback`; W01 refuses when the host has no site to roll
// back to. The tag is never moved or deleted:
// the fix ships as web-vA.B.(C+1).
//
// Every git, gh, ssh and http call goes through an injected Deps, so the unit
// tests run the steps against a local bare origin and stubs. Each step has a
// read-only done check, so a rerun reports the steps already done and continues
// at the first that is not; `--dry-run` runs only the preflight and the checks.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareSemver, SEMVER } from "../check-analyst-sdk-tag.ts";
import { checkWebTag, WEB_MANIFEST, WEB_RELEASE_BRANCH_GLOB, WEB_TAG_PREFIX } from "../check-web-tag.ts";
import { WEB_CONTENT_PATHS } from "../lib/website-release.ts";
import { poll, readRun, type Deps as SdkDeps, type ExecResult, type StepResult } from "./sdk-release-lib.ts";
import { BASE_ENV, RELEASE_REPO_URL, shellQuote } from "./steps.ts";
import type { ReleaseTarget } from "./target.ts";
import { stageBrowserProblem } from "./stage-browser-lib.ts";
import type { BrowserSmoke, PageReport } from "./web-browser-smoke.ts";

export type { ExecResult, StepResult } from "./sdk-release-lib.ts";
export type { BrowserSmoke, PageReport } from "./web-browser-smoke.ts";

/** The committed web content runbook. It sits outside templates/ and releases/, so ./runbook.ts never reads it. */
export const WEB_RUNBOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), "runbooks", "web-content.yaml");

/** The nine kinds, in the one order the runbook holds them. */
export const WEB_KINDS = [
  "preflight", "branch", "gate", "stage-up", "stage-deploy", "stage-check", "tag", "tag-guard", "checkout", "deploy", "live-check", "release",
] as const;
export type WebStepKind = (typeof WEB_KINDS)[number];

/** The kinds that act on production or publish the release: none writes unless stage QA passed on the release commit (owner, 2026-11-11). */
export const PRODUCTION_KINDS: readonly WebStepKind[] = Object.freeze(["tag", "tag-guard", "checkout", "deploy", "live-check", "release"]);

/** Whether each kind writes to GitHub or switches what production serves. A step's `irreversible` must say the same (stage steps write only to the stage host). */
const KIND_IRREVERSIBLE: Readonly<Record<WebStepKind, boolean>> = Object.freeze({
  preflight: false, branch: true, gate: false, "stage-up": false, "stage-deploy": false, "stage-check": false,
  tag: true, "tag-guard": false, checkout: false, deploy: true, "live-check": false, release: true,
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

// ── What a named commit carries outside the content paths ────────────────────
//
// A main commit often carries a test or a doc beside its web content, and now
// and then a comment edit in backend code (PR 1590). W01 cherry-picks the
// WEB_CONTENT_PATHS part of each named commit and its test paths (scripts/tests/), and leaves
// the rest out. So the release tree equals production's API commit outside the
// content and test paths, byte for byte: production's backend is untouched and
// the served site equals the tag. Tests ride along because they deploy nothing
// and the web client's own gate runs them (frontend/test/unit.list names files
// under scripts/tests/unit; leaving one out fails W03 or runs a stale one).
// What W01 leaves out must be something the content cannot depend on, or the
// site would ship expecting a backend change production does not run: a doc,
// or a comment-only edit. Any other path refuses the release (issue 1603, D81
// amendment).

/** A path outside WEB_CONTENT_PATHS: a test (carried), a doc or a comment-only edit (both left out). */
export type OutsideKind = "test" | "doc" | "comment-only";

export interface OutsidePath {
  readonly commit: string;
  readonly path: string;
  readonly kind: OutsideKind;
}

/**
 * PURE. A carried test path: under scripts/tests/, the root the web-client
 * gate runs from (frontend/test/unit.list). Nothing deployed reads it: no
 * image copies scripts/ wholesale, and scripts/checks/check-no-test-imports-
 * in-runtime.sh refuses a runtime import of it. Other test directories are
 * not carried: backend/tests/fixtures/regime/* is runtime seed data the
 * backend image reads (floor-seed.ts, edgar-seed.ts), so a backend test path
 * counts as runtime and refuses the release.
 */
export const isTestPath = (path: string): boolean => path.startsWith("scripts/tests/");

/** PURE. A doc path, which no deploy reads: docs/. */
export const isDocPath = (path: string): boolean => path.startsWith("docs/");

/** PURE. Whether W01 carries an outside path into the release tree (a test) rather than leaving it out. */
export const isCarried = (o: Pick<OutsidePath, "kind">): boolean => o.kind === "test";

/** PURE. A release tree diff's paths that make it a platform release: outside both the content and the test paths. */
export const platformPaths = (paths: readonly string[]): string[] => classifyContentDiff(paths).offending.filter((p) => !isTestPath(p));

const TRANSPILE_LOADERS: Readonly<Record<string, "ts" | "tsx" | "js" | "jsx">> = {
  ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx",
};

/**
 * PURE. Whether two versions of a JS/TS file differ only in comments and
 * whitespace: Bun's transpiler, which drops comments, gives the same output
 * for both. False for any other file type, for source that does not parse,
 * and for source with a macro import (never run).
 */
export function isCommentOnlyChange(path: string, before: string, after: string): boolean {
  const ext = /\.[a-z]+$/.exec(path)?.[0] ?? "";
  const loader = TRANSPILE_LOADERS[ext];
  if (loader === undefined) return false;
  try {
    // macro: false: a `with { type: "macro" }` import would otherwise run code
    // from the commit on the operator's machine. Disabled, it throws, which
    // counts as "not comment-only" and refuses the path. (bun-types types
    // `macro` as a MacroMap only; Bun 1.4 also takes false.)
    const t = new Bun.Transpiler({ loader, minifyWhitespace: true, macro: false } as unknown as ConstructorParameters<typeof Bun.Transpiler>[0]);
    return t.transformSync(before) === t.transformSync(after);
  } catch {
    return false;
  }
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
  /** GET a URL as bytes (W11 hashes what is served). Throws when it cannot be reached. */
  httpBytes(url: string): Promise<{ readonly status: number; readonly bytes: Uint8Array }>;
  /** W11's headless browser (./web-browser-smoke.ts runBrowserSmoke); with no routes it only proves the browser launches (W01). */
  browser: BrowserSmoke;
  readFile(path: string): string | undefined;
}

export interface Inputs {
  /** The main commits to ship, in the order they are cherry-picked. */
  readonly commits: readonly string[];
  readonly version?: string;
  readonly target: WebTarget;
  readonly dryRun: boolean;
  /** Where the runner keeps its scratch worktree, the W10 record and the notes. Stable across reruns. */
  readonly workDir: string;
  /** The stage target (targets/stage.json): W04 to W06 QA the release there before any production step writes. */
  readonly stage: WebTarget;
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
  /** Each named commit's paths outside WEB_CONTENT_PATHS: tests carried, docs and comment-only edits left out. */
  readonly outside: readonly OutsidePath[];
  /** What W01 read of the host's web/current and web/previous: the site a W11 rollback returns to is `current`. */
  readonly sites?: HostSites;
  /** How many changed views W01 mapped to a route W11's browser loads (every one, or W01 refuses). */
  readonly viewsMapped?: number;
}

/** The instance's web/current and web/previous links on the host, as the site ids they name. */
export interface HostSites {
  readonly current?: string;
  readonly previous?: string;
}

/**
 * W03's runs: every one must conclude success at the release commit. web-client
 * builds the site and runs the view specs against goldens. e2e-web boots a live
 * stack from the release tree, whose backend is production's API commit, and
 * runs the specs that need a real api: the only check of the new content
 * against the backend it will be served beside (issue 1603).
 *
 * GitHub reads a workflow's triggers from the commit it runs on, and the
 * release tree carries production's .github/ (it is outside the content and
 * test paths). Production's web-client.yml (since 1561) runs on a push to
 * web/releases-*; its e2e-web.yml does not, but it has `workflow_dispatch`. So
 * W03 dispatches e2e-web on the release branch, and W01 refuses up front when
 * the release tree's workflow files cannot run the gate ({@link gateTriggerProblems}).
 */
export interface GateRun {
  readonly workflow: string;
  readonly job: string;
  readonly event: "push" | "workflow_dispatch";
}
export const GATE_RUNS: readonly GateRun[] = Object.freeze([
  { workflow: "web-client.yml", job: "web-client", event: "push" },
  { workflow: "e2e-web.yml", job: "e2e-web", event: "workflow_dispatch" },
]);
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

/** PURE. W09's host command: clone {home}/rm-web when missing, fetch the tags, detach at the tag, install from the lockfile. */
export function checkoutCommand(t: WebTarget, tag: string): string {
  return [
    `{ test -e ${shellQuote(`${t.checkout}/.git`)} || ${envCommand(t, ["git", "clone", "--quiet", t.cloneFrom, t.checkout])}; }`,
    `cd ${shellQuote(t.checkout)}`,
    envCommand(t, ["git", "fetch", "--quiet", "--tags", "origin"]),
    envCommand(t, ["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", `refs/tags/${tag}`]),
    envCommand(t, ["bun", "install", "--frozen-lockfile"]),
  ].join(" && ");
}

/** PURE. W05's stage host command: clone {home}/rm-web when missing, fetch the web release branches, detach at the release commit (no tag exists yet), install from the lockfile. */
export function checkoutCommitCommand(t: WebTarget, commit: string): string {
  return [
    `{ test -e ${shellQuote(`${t.checkout}/.git`)} || ${envCommand(t, ["git", "clone", "--quiet", t.cloneFrom, t.checkout])}; }`,
    `cd ${shellQuote(t.checkout)}`,
    envCommand(t, ["git", "fetch", "--quiet", "origin", "+refs/heads/web/*:refs/remotes/origin/web/*"]),
    envCommand(t, ["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", commit]),
    envCommand(t, ["bun", "install", "--frozen-lockfile"]),
  ].join(" && ");
}

/** PURE. W10's host command: `bun run smoke:web` from the runner's checkout. */
export const deployCommand = (t: WebTarget): string =>
  `cd ${shellQuote(t.checkout)} && ${envCommand(t, ["bun", "run", "smoke:web", "--instance", t.instance])}`;

/** PURE. W11's rollback: `bun run smoke:web --rollback` from the runner's checkout. */
export const rollbackCommand = (t: WebTarget): string =>
  `cd ${shellQuote(t.checkout)} && ${envCommand(t, ["bun", "run", "smoke:web", "--instance", t.instance, "--rollback"])}`;

const instanceDir = (t: WebTarget): string => `${t.stateRoot}/${t.instance}`;

/** PURE. Print a host file when it exists, nothing when it does not; any other exit means the host could not be read. */
const catIfPresent = (path: string): string => `if test -e ${shellQuote(path)}; then cat -- ${shellQuote(path)}; fi`;

/**
 * PURE. Whether a site id names this version at this commit: `<version>-<short
 * commit>`, or with the `-<12 hex>` digest suffix smoke-site.ts installSite adds
 * when that version and commit were already installed with other bytes.
 */
export function siteIdIs(siteId: unknown, version: string, commit: string): boolean {
  if (typeof siteId !== "string" || !siteId.startsWith(`${version}-`)) return false;
  const m = /^([0-9a-f]{7,40})(-[0-9a-f]{12})?$/.exec(siteId.slice(version.length + 1));
  return m !== null && commit.startsWith(m[1]!);
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

  // Each named commit: on main, with web content, and nothing outside it the content could depend on.
  const errors: string[] = [];
  const commits: string[] = [];
  const outside: OutsidePath[] = [];
  for (const c of inputs.commits) {
    const r = deps.git(["rev-parse", "--verify", "--quiet", `${c}^{commit}`]);
    if (r.status !== 0) { errors.push(`--commit ${c} is not a commit here`); continue; }
    const sha = r.stdout.trim();
    commits.push(sha);
    if (!isAncestor(deps, sha, "origin/main")) errors.push(`commit ${short(sha)} is not on origin/main (a web release ships main commits only)`);
    const own = outsideOf(deps, sha);
    if ("error" in own) errors.push(own.error);
    else outside.push(...own.outside);
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
  const built = buildCandidate(deps, start, commits, outside, inputs.workDir);
  if ("error" in built) return { errors: [built.error] };
  const commit = built.commit;
  const atCandidate = versionAt(deps, commit);
  if (atCandidate !== version) errors.push(`${WEB_MANIFEST} at the release commit ${short(commit)} says ${atCandidate ?? "nothing"}, not ${version}`);
  errors.push(...versionProblems(tags, version, tag, commit));
  errors.push(...gateTriggerProblems(deps, commit));

  let changed: string[] = [];
  if (!isAncestor(deps, base, commit)) {
    errors.push(
      `the release commit ${short(commit)} on ${branch} does not descend from the base ${short(base)} (${baseName}): ${branch} was cut from another release, ` +
        `most likely before production's last platform release. Ship on a new line: bump A.B in ${WEB_MANIFEST} on main and name that commit too`,
    );
  } else {
    const fromBase = diffPaths(deps, base, commit);
    const fromApi = diffPaths(deps, apiSha, commit);
    if ("error" in fromBase) errors.push(fromBase.error);
    else if ("error" in fromApi) errors.push(fromApi.error);
    else {
      const offending = platformPaths([...fromBase, ...fromApi]);
      if (offending.length > 0) {
        errors.push(`the release tree differs from production's API commit ${short(apiSha)} outside the web content and test paths: ${offending.join(", ")}. Ship it with bun run release:run`);
      }
      changed = [...new Set(fromBase)].sort();
    }
  }
  if (errors.length > 0) return { errors };

  // The rollback target: after W10's switch, web/previous names what web/current names now.
  const sites = await readHostSites(t, deps);
  if ("error" in sites) return { errors: [sites.error] };
  const noTarget = rollbackTargetProblem(t, sites.sites);
  if (noTarget !== undefined) return { errors: [noTarget] };
  // W11's browser plan: every changed view must map to a route the browser loads.
  const bp = await browserPlan({ version, commit, branch, tag, apiCommit: apiSha, base, changed, outside }, t, deps);
  deps.log(`[web-release] changed views mapped to a browser route: ${bp.views.length - bp.unmapped.length} of ${bp.views.length}${bp.views.length > 0 ? ` (${bp.views.join("; ")})` : ""}`);
  const planProblems = browserPlanProblems(bp);
  if (planProblems.length > 0) return { errors: planProblems };
  // W11's browser must launch on this machine, with the options W11 uses; finding out after the deploy would roll back a good site.
  try {
    await deps.browser(t.publicOrigin, [], BROWSER_BUDGET_MS);
  } catch (e) {
    return { errors: [stageBrowserProblem((e as Error).message)] };
  }
  if (tags.get(tag) === commit) {
    const rolled = await rolledBack(t, deps, version, tag, commit);
    if (rolled !== undefined) return { errors: [rolled] };
  }
  const admin = deps.gh(["api", "repos/{owner}/{repo}", "--jq", ".permissions.admin"]);
  if (admin.status !== 0) return { errors: [`gh api repos/{owner}/{repo} failed: ${errText(admin)}`] };
  if (admin.stdout.trim() !== "true") return { errors: ["the operator lacks the admin permission on the repository (the tag push needs it)"] };
  return { release: { version, commit, branch, tag, apiCommit: apiSha, base, changed, outside, sites: sites.sites, viewsMapped: bp.views.length } };
}

const webDirOf = (t: WebTarget): string => `${instanceDir(t)}/web`;

/** PURE. W01's read of web/current and web/previous: each link's site id, and "dangling" when it names no directory. */
export function hostSitesCommand(t: WebTarget): string {
  const d = shellQuote(webDirOf(t));
  return `for l in current previous; do if test -L ${d}/"$l"; then s=$(readlink -- ${d}/"$l"); if test -d ${d}/"$l"/; then printf '%s\\t%s\\n' "$l" "$s"; else printf '%s\\t%s\\tdangling\\n' "$l" "$s"; fi; fi; done`;
}

/** Read the host's web/current and web/previous (read only). A dangling link is reported as absent with its name. */
export async function readHostSites(t: WebTarget, deps: Deps): Promise<{ sites: HostSites & { dangling?: string[] } } | { error: string }> {
  const r = await deps.ssh(t.host, hostSitesCommand(t));
  if (r.status !== 0) return { error: `ssh ${t.host} could not read ${webDirOf(t)}/current and previous: ${errText(r)}` };
  const out: { current?: string; previous?: string; dangling?: string[] } = {};
  for (const l of lines(r.stdout)) {
    const [name, site = "", flag] = l.split("\t");
    if (name !== "current" && name !== "previous") continue;
    if (flag === "dangling") (out.dangling ??= []).push(`${name} -> ${site}`);
    else out[name] = site;
  }
  return { sites: out };
}

/** PURE. Why production would have no site to roll back to after W10's switch: web/current is absent or dangling. */
export function rollbackTargetProblem(t: WebTarget, sites: HostSites & { dangling?: string[] }): string | undefined {
  if (sites.current !== undefined) return undefined;
  const why = sites.dangling?.some((d) => d.startsWith("current ")) ? `names no site directory (${sites.dangling.join(", ")})` : "is absent";
  return `${t.host}:${webDirOf(t)}/current ${why}, so after W10's switch web/previous would name no site and a failed W11 could not roll back ` +
    `(bun smoke:web --rollback refuses with no previous site). Put a site in place with bun smoke:web --instance ${t.instance} by hand first`;
}

/** PURE. The run log's line for the host's sites. */
export function sitesLine(sites: HostSites | undefined): string {
  if (sites === undefined) return "[web-release] web/current and web/previous: not read";
  return `[web-release] production serves web/current -> ${sites.current ?? "(absent)"}; web/previous -> ${sites.previous ?? "(absent)"}; ` +
    `after the switch a W11 rollback returns to ${sites.current ?? "(nothing)"}`;
}

/**
 * One named commit's paths outside WEB_CONTENT_PATHS, each with its kind.
 * Refuses a commit with no content path, and any outside path that is neither
 * a test or doc path nor a comment-only edit of a JS/TS file that exists on
 * both sides.
 */
function outsideOf(deps: Deps, sha: string): { outside: OutsidePath[] } | { error: string } {
  const own = diffPaths(deps, `${sha}^`, sha);
  if ("error" in own) return own;
  const paths = classifyContentDiff(own).offending;
  if (paths.length === new Set(own).size) {
    return { error: `commit ${short(sha)} touches no web content path (${paths.join(", ")}): there is nothing to ship; ship it with bun run release:run` };
  }
  const outside: OutsidePath[] = [];
  const runtime: string[] = [];
  for (const path of paths) {
    if (isTestPath(path)) { outside.push({ commit: sha, path, kind: "test" }); continue; }
    if (isDocPath(path)) { outside.push({ commit: sha, path, kind: "doc" }); continue; }
    const before = deps.git(["show", `${sha}^:${path}`]);
    const after = deps.git(["show", `${sha}:${path}`]);
    if (before.status === 0 && after.status === 0 && isCommentOnlyChange(path, before.stdout, after.stdout)) {
      outside.push({ commit: sha, path, kind: "comment-only" });
    } else runtime.push(path);
  }
  if (runtime.length > 0) {
    return {
      error: `commit ${short(sha)} changes ${runtime.join(", ")} outside the web content paths, and that change is not a test, a doc or a comment-only edit, ` +
        "so the content may depend on it: ship it with bun run release:run",
    };
  }
  return { outside };
}

/** PURE. The run log's lines for the outside paths, one per path. */
export function outsideLines(outside: readonly OutsidePath[]): string[] {
  return outside.map((o) => `${short(o.commit)} ${o.path} (${o.kind}: ${isCarried(o) ? "carried" : "left out"})`);
}

/**
 * The candidate commit: `start` with each commit not already on it
 * cherry-picked (-x) in a scratch worktree, keeping its WEB_CONTENT_PATHS and
 * test part. A doc or comment-only path is put back to `start`'s state,
 * including after a conflict there; a conflict in a content or test path stops
 * the run.
 */
function buildCandidate(
  deps: Deps, start: string, commits: readonly string[], outside: readonly OutsidePath[], workDir: string,
): { commit: string } | { error: string } {
  const log = deps.git(["log", "--format=%B", `refs/remotes/origin/main..${start}`]);
  if (log.status !== 0) return { error: `git log origin/main..${short(start)} failed: ${errText(log)}` };
  const picked = new Set([...log.stdout.matchAll(/\(cherry picked from commit ([0-9a-f]{40})\)/g)].map((m) => m[1]!));
  const todo = commits.filter((c) => !picked.has(c) && !isAncestor(deps, c, start));
  if (todo.length === 0) return { commit: start };
  const wt = join(workDir, `candidate-${deps.clock()}`);
  const add = deps.git(["worktree", "add", "--quiet", "--detach", wt, start]);
  if (add.status !== 0) return { error: `git worktree add ${wt} failed: ${errText(add)}` };
  const cleanup = () => { deps.git(["worktree", "remove", "--force", wt]); deps.git(["worktree", "prune"]); };
  const abort = (detail: string): { error: string } => {
    deps.git(["-C", wt, "cherry-pick", "--abort"]);
    cleanup();
    return { error: `${detail}. Nothing was pushed` };
  };
  for (const c of todo) {
    const drop = outside.filter((o) => o.commit === c && !isCarried(o)).map((o) => o.path);
    const r = deps.git(["-C", wt, "cherry-pick", "-x", "--no-commit", c]);
    if (r.status !== 0) {
      const u = deps.git(["-C", wt, "diff", "--name-only", "--diff-filter=U"]);
      const unmerged = u.status === 0 ? lines(u.stdout) : [];
      const kept = unmerged.filter((p) => !drop.includes(p));
      if (u.status !== 0 || unmerged.length === 0 || kept.length > 0) {
        return abort(`cherry-picking ${short(c)} onto ${short(start)} conflicts${kept.length > 0 ? ` in ${kept.join(", ")}` : ""}: ${errText(r)}`);
      }
    }
    if (drop.length > 0) {
      const back = deps.git(["-C", wt, "restore", "--source=HEAD", "--staged", "--worktree", "--", ...drop]);
      if (back.status !== 0) return abort(`leaving ${drop.join(", ")} out of ${short(c)} failed: ${errText(back)}`);
    }
    const meta = deps.git(["log", "-1", "--format=%an <%ae>%x00%aI%x00%B", c]);
    if (meta.status !== 0) return abort(`git log ${short(c)} failed: ${errText(meta)}`);
    const [author = "", date = "", body = ""] = meta.stdout.split("\0");
    const note = drop.length > 0 ? `\nWeb content release: left out ${drop.join(", ")}.` : "";
    const message = `${body.trimEnd()}\n\n(cherry picked from commit ${c})${note}\n`;
    const commit = deps.git(["-C", wt, "commit", "--quiet", "--no-verify", "--allow-empty", `--author=${author}`, `--date=${date}`, "-m", message]);
    if (commit.status !== 0) return abort(`committing the web content of ${short(c)} failed: ${errText(commit)}`);
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

/** Why a rerun may not resume an existing tag: the host's web receipt says W11 rolled it back. */
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
    return `${tag} was rolled back at W11 on ${t.host}; the tag is never moved or cut again: ship the fix as ${WEB_TAG_PREFIX}${nextPatch(version)}`;
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

// ── W03 and W08: the polled CI reads ─────────────────────────────────────────

type Read = ReturnType<typeof readRun>;
const asCheck = (r: Read): StepResult => ({ state: r.state === "pass" ? "done" : r.state === "wait" ? "todo" : "failed", detail: r.detail });
/** One read of the gate: every GATE_RUNS entry. A failure anywhere fails it; otherwise any wait waits. */
export function readGate(rel: Release, deps: Deps): Read {
  const reads = GATE_RUNS.map((g) => readRun(deps, g.workflow, rel.branch, rel.commit, g.job, undefined, g.event));
  const fail = reads.filter((r) => r.state === "fail");
  if (fail.length > 0) return { state: "fail", detail: fail.map((r) => r.detail).join("; ") };
  const wait = reads.filter((r) => r.state === "wait");
  if (wait.length > 0) return { state: "wait", detail: wait.map((r) => r.detail).join("; ") };
  return { state: "pass", detail: reads.map((r) => r.detail).join("; ") };
}
export const readTagGuard = (rel: Release, deps: Deps): Read => readRun(deps, TAG_GUARD_WORKFLOW, rel.tag, rel.commit);

/**
 * W03's write: dispatch each workflow_dispatch gate run that has no run on the
 * branch at the commit yet. The dispatched run checks out the branch tip, which
 * W02 just made the release commit; readRun then requires that run's head sha
 * to equal it. A run that exists (in progress, failed or passed) is never
 * dispatched again: a failed one is rerun by hand (gh run rerun).
 */
export function dispatchGate(rel: Release, deps: Deps): StepResult {
  const sent: string[] = [];
  for (const g of GATE_RUNS.filter((x) => x.event === "workflow_dispatch")) {
    const l = deps.gh(["run", "list", "--workflow", g.workflow, "--branch", rel.branch, "--commit", rel.commit, "--event", g.event, "--json", "databaseId", "--limit", "1"]);
    if (l.status !== 0) return failed(`gh run list --workflow ${g.workflow} failed: ${errText(l)}`);
    let runs: unknown[];
    try {
      runs = JSON.parse(l.stdout) as unknown[];
    } catch {
      return failed(`gh run list --workflow ${g.workflow} gave no JSON`);
    }
    if (runs.length > 0) continue;
    const tip = deps.git(["ls-remote", "--heads", "origin", `refs/heads/${rel.branch}`]);
    if (tip.status !== 0 || lines(tip.stdout)[0]?.split(/\s+/)[0] !== rel.commit) {
      return failed(`origin/${rel.branch} is not at ${rel.commit}, so a dispatch of ${g.workflow} would test another commit`);
    }
    const d = deps.gh(["workflow", "run", g.workflow, "--ref", rel.branch]);
    if (d.status !== 0) return failed(`gh workflow run ${g.workflow} --ref ${rel.branch} failed: ${errText(d)}`);
    sent.push(g.workflow);
  }
  return { state: "done", detail: sent.length === 0 ? "nothing to dispatch" : `dispatched ${sent.join(", ")} on ${rel.branch}` };
}

/** The workflow files W03 and W08 need, and the trigger each must declare at the release commit. */
export const GATE_TRIGGERS: readonly { readonly workflow: string; readonly why: string; readonly ok: (on: Record<string, unknown>) => boolean }[] = Object.freeze([
  {
    workflow: "web-client.yml", why: "a push trigger on web/releases-* (W03)",
    ok: (on) => listOf((on.push as Record<string, unknown> | undefined)?.branches).includes("web/releases-*"),
  },
  { workflow: "e2e-web.yml", why: "a workflow_dispatch trigger (W03 dispatches it)", ok: (on) => "workflow_dispatch" in on },
  {
    workflow: TAG_GUARD_WORKFLOW, why: "a push trigger on web-v* tags (W08)",
    ok: (on) => listOf((on.push as Record<string, unknown> | undefined)?.tags).includes("web-v*"),
  },
]);

const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);

/**
 * Why the release commit's own workflow files cannot run W03 or W08: GitHub
 * reads a workflow's triggers from the commit it runs on, and the release tree
 * carries production's .github/. Empty when every gate can trigger.
 */
export function gateTriggerProblems(deps: Deps, commit: string): string[] {
  const out: string[] = [];
  for (const g of GATE_TRIGGERS) {
    const r = deps.git(["show", `${commit}:.github/workflows/${g.workflow}`]);
    let on: unknown;
    try {
      on = r.status === 0 ? (Bun.YAML.parse(r.stdout) as { on?: unknown }).on : undefined;
    } catch {
      on = undefined;
    }
    const map = typeof on === "object" && on !== null && !Array.isArray(on) ? (on as Record<string, unknown>) : {};
    if (!g.ok(map)) {
      out.push(`.github/workflows/${g.workflow} at the release commit ${short(commit)} (production's copy) lacks ${g.why}, so the gate could never run: ship the workflow change in a platform release first`);
    }
  }
  return out;
}

/** W03's write: dispatch what has no run yet, then poll every gate run. */
async function gateStep(rel: Release, deps: Deps, maxMinutes: number, id: string, rerun: string): Promise<StepResult> {
  const d = dispatchGate(rel, deps);
  if (d.state !== "done") return d;
  deps.log(`[${id}] ${d.detail}`);
  return poll(() => readGate(rel, deps), maxMinutes, deps, id, rerun);
}

// ── W04 to W06: stage QA ─────────────────────────────────────────────────────
//
// Owner, 2026-11-11 (D81 amendment): "You already have the stage machine for
// doing QA as we do in the kitchen sink. Why would you use a different method
// when a good one exists?" Before any production step writes, the release runs
// on the kitchen-sink stage target (./stage-target.ts, docs/runbooks/
// stage-target.md): W04 brings it up at production's running commit from a
// fresh production dump (the kitchen sink's Q02-dump and Q03-stage-up), W05
// deploys the release tree there with the same `bun run smoke:web` W10 runs on
// production, and W06 runs W11's live check against the stage origin. A pass
// is recorded for the release commit and the stage target is torn down; W07
// onward refuse to write without that record.

/** PURE. Where the runner records that stage QA passed for a release commit. */
export const stagePassPath = (inputs: Pick<Inputs, "workDir">, rel: Pick<Release, "tag">): string => join(inputs.workDir, `${rel.tag}-stage-pass.json`);

/** What the runner records when W06 passes. */
export interface StagePass {
  readonly commit: string;
  readonly origin: string;
  readonly at: string;
  readonly summary: string;
}

/** The recorded stage pass for this release commit, or undefined. A pass for another commit does not count. */
export function stagePassed(rel: Release, inputs: Inputs, deps: Deps): StagePass | undefined {
  const text = deps.readFile(stagePassPath(inputs, rel));
  if (text === undefined) return undefined;
  try {
    const p = JSON.parse(text) as StagePass;
    return p.commit === rel.commit ? p : undefined;
  } catch {
    return undefined;
  }
}

/** The run's inputs aimed at the stage target. */
const onStage = (inputs: Inputs): Inputs => ({ ...inputs, target: inputs.stage });

/** W04's commands, run from the control machine as the kitchen sink's Q02-dump and Q03-stage-up run them. */
export const STAGE_UP_COMMANDS: readonly (readonly string[])[] = Object.freeze([
  ["bun", "scripts/release/stage-target.ts", "dump"],
  ["bun", "scripts/release/stage-target.ts", "up", "--dump", "newest", "--replace"],
]);
/** W06's teardown after a pass (the kitchen-sink policy: stage is torn down once QA passed). */
export const STAGE_DOWN_COMMAND: readonly string[] = Object.freeze(["bun", "scripts/release/stage-target.ts", "down"]);

/** W04's done check: stage QA already passed on this commit, or the stage stack runs production's API commit. */
export async function checkStageUp(rel: Release, inputs: Inputs, deps: Deps): Promise<StepResult> {
  const passed = stagePassed(rel, inputs, deps);
  if (passed !== undefined) return { state: "done", detail: `stage QA already passed on ${short(rel.commit)} (${passed.at})` };
  const api = await readApiVersion(inputs.stage, deps);
  if ("error" in api) return { state: "todo", detail: `the stage target is not up (${api.error}): bring it up from a fresh production dump` };
  if (api.body.commit !== rel.apiCommit) {
    return { state: "todo", detail: `the stage target runs ${String(api.body.commit).slice(0, 12)}, not production's API commit ${short(rel.apiCommit)}: rebuild it from a fresh production dump` };
  }
  return { state: "done", detail: `the stage target runs production's API commit ${short(rel.apiCommit)}` };
}

/** W04's write: the stage target from a fresh production dump, at production's running commit. */
export async function runStageUp(rel: Release, inputs: Inputs, deps: Deps): Promise<StepResult> {
  for (const cmd of STAGE_UP_COMMANDS) {
    deps.log(`[web-release] ${cmd.join(" ")} (the dump and the stage build take 15 to 45 minutes)`);
    const r = deps.exec(cmd as string[]);
    if (r.status !== 0) return failed(`${cmd.join(" ")} exited ${r.status}: ${errText(r)}`);
  }
  const after = await checkStageUp(rel, inputs, deps);
  return after.state === "done" ? after : failed(`after the stage build: ${after.detail}`);
}

/** W05's done check: stage QA already passed, or stage serves the release with W05's record of its api and workers. */
export async function checkStageDeploy(rel: Release, inputs: Inputs, deps: Deps): Promise<StepResult> {
  const passed = stagePassed(rel, inputs, deps);
  if (passed !== undefined) return { state: "done", detail: `stage QA already passed on ${short(rel.commit)} (${passed.at})` };
  const live = await readLiveSite(inputs.stage, deps);
  if ("error" in live) return { state: "todo", detail: `the stage site cannot be read (${live.error}): deploy ${short(rel.commit)} there` };
  return checkDeploy(rel, onStage(inputs), deps);
}

/** W05's write: check the release commit out on the stage host, then smoke:web there, exactly as W09 and W10 do on production. */
export async function runStageDeploy(rel: Release, inputs: Inputs, deps: Deps): Promise<StepResult> {
  const s = inputs.stage;
  const r = await deps.ssh(s.host, checkoutCommitCommand(s, rel.commit));
  if (r.status !== 0) return failed(`the checkout on ${s.host} exited ${r.status}: ${errText(r)}`);
  const co = await checkCheckout(rel, s, deps);
  if (co.state !== "done") return failed(`after the stage checkout: ${co.detail}`);
  return runDeploy(rel, onStage(inputs), deps);
}

/** W06's done check: a recorded stage pass on this commit. */
export function checkStageCheck(rel: Release, inputs: Inputs, deps: Deps): StepResult {
  const passed = stagePassed(rel, inputs, deps);
  return passed !== undefined
    ? { state: "done", detail: `stage QA passed on ${short(rel.commit)} (${passed.at}): ${passed.summary}` }
    : { state: "todo", detail: `stage QA has not passed on ${short(rel.commit)}` };
}

/** W06's write: W11's live check against the stage origin; on a pass, record it and tear the stage target down. */
export async function runStageCheck(rel: Release, inputs: Inputs, deps: Deps): Promise<StepResult> {
  const s = inputs.stage;
  const r = await liveResult(rel, onStage(inputs), deps);
  if (r.problems.length > 0) {
    return failed(`stage QA failed on ${s.publicOrigin}: ${r.problems.join("; ")}. Nothing reached production. The stage target is left up for inspection; ` +
      `fix the release on main and run again (stage-target.ts down removes it)`);
  }
  const pass: StagePass = { commit: rel.commit, origin: s.publicOrigin, at: new Date(deps.clock()).toISOString(), summary: r.summary };
  deps.writeFile(stagePassPath(inputs, rel), `${JSON.stringify(pass, null, 2)}\n`);
  const down = deps.exec(STAGE_DOWN_COMMAND as string[]);
  if (down.status !== 0) {
    return failed(`stage QA passed and is recorded (${stagePassPath(inputs, rel)}), but ${STAGE_DOWN_COMMAND.join(" ")} exited ${down.status}: ${errText(down)}. Tear it down by hand; a rerun continues at W07`);
  }
  return { state: "done", detail: `stage QA passed on ${s.publicOrigin} (${r.summary}); recorded, and the stage target is torn down` };
}

/** PURE. Why a production step may not write: no stage pass is recorded for the release commit. */
export const stageGateProblem = (rel: Release, inputs: Inputs): string =>
  `stage QA (W04 to W06) has not passed on ${short(rel.commit)}: no production step writes before it does (${stagePassPath(inputs, rel)} is missing or names another commit)`;

// ── W07: tag ─────────────────────────────────────────────────────────────────

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

// ── W09: checkout ────────────────────────────────────────────────────────────

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

// ── W10: deploy ──────────────────────────────────────────────────────────────

/** PURE. Where W10 records what production served beside the site before the deploy. */
export const servingRecordPath = (inputs: Pick<Inputs, "workDir" | "target">, rel: Pick<Release, "tag">): string => join(inputs.workDir, `${rel.tag}-${inputs.target.name}-serving.json`);

function readRecord(inputs: Inputs, rel: Release, deps: Deps): Serving | undefined {
  const text = deps.readFile(servingRecordPath(inputs, rel));
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as Serving;
  } catch {
    return undefined;
  }
}

/** The deploy step's done check: the live /version.json reports the release, and W10's record exists. */
export async function checkDeploy(rel: Release, inputs: Inputs, deps: Deps): Promise<StepResult> {
  const live = await readLiveSite(inputs.target, deps);
  if ("error" in live) return failed(live.error);
  if (!liveIs(live, rel)) return { state: "todo", detail: `${inputs.target.publicOrigin} serves ${live.version}-${live.commit}: deploy ${rel.tag}` };
  if (readRecord(inputs, rel, deps) === undefined) {
    return failed(`${inputs.target.publicOrigin} already serves ${rel.tag}, but ${servingRecordPath(inputs, rel)} (W10's record of the api and workers) is missing, so W11 has nothing to compare: check the site by hand`);
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

// ── W11: live check ──────────────────────────────────────────────────────────
//
// W11 proves four things, in order, and rolls the site back on any failure:
//
//   1. {publicOrigin}/version.json names the release (the site switched);
//   2. every changed file the site serves is served byte for byte as the host
//      holds it in web/current (the release's own bytes reach a visitor, past
//      Cloudflare and nginx). The host's copy, not git's, is the reference:
//      the assembly stamps imports with ?v= and prerenders routes, so a served
//      file differs from its source by design;
//   3. every sitemap route answers 200 (weak on its own: nginx answers an
//      unknown path with the SPA shell, 200);
//   4. a headless browser loads the base routes, one swarm member page and the
//      route of every changed view against production's data, with no page
//      error, console.error or failed same-origin request, each reaching the
//      router's ready signal (./web-browser-smoke.ts);
//
// and that the api and worker containers and /api/version are unchanged.

/** The directory a site is served from: frontend/public/X is served at /X. */
export const SERVED_ROOT = "frontend/public/";

/** PURE. The URL path a repository path is served at, or undefined when the site does not serve it (a build input, a test). */
export const servedUrlPath = (path: string): string | undefined =>
  path.startsWith(SERVED_ROOT) && path.length > SERVED_ROOT.length ? `/${path.slice(SERVED_ROOT.length)}` : undefined;

/** What W11 compares: each served changed file, each removed one, and the changed paths the site does not serve. */
export interface ServedPlan {
  /** Served files: the path inside the site directory and the URL path. */
  readonly compare: readonly { readonly path: string; readonly file: string; readonly url: string }[];
  /** Served paths the release removes: absent from web/current. */
  readonly removed: readonly { readonly path: string; readonly file: string }[];
  /** Changed paths the site does not serve (build scripts, tests, the manifest): listed, not compared. */
  readonly skipped: readonly string[];
}

/** PURE. The served plan for the release's changed paths; `exists` says whether a path is in the release tree. */
export function servedPlan(changed: readonly string[], exists: (path: string) => boolean): ServedPlan {
  const compare: { path: string; file: string; url: string }[] = [];
  const removed: { path: string; file: string }[] = [];
  const skipped: string[] = [];
  for (const path of [...new Set(changed)].sort()) {
    const url = servedUrlPath(path);
    if (url === undefined) { skipped.push(path); continue; }
    const file = url.slice(1);
    if (exists(path)) compare.push({ path, file, url });
    else removed.push({ path, file });
  }
  return { compare, removed, skipped };
}

const servedPlanOf = (rel: Release, deps: Deps): ServedPlan =>
  servedPlan(rel.changed, (p) => deps.git(["cat-file", "-e", `${rel.commit}:${p}`]).status === 0);

/** PURE. The host command that names web/current's site and hashes (or proves absent) each file inside it. */
export function servedHashCommand(t: WebTarget, plan: ServedPlan): string {
  const files = [...plan.compare.map((c) => c.file), ...plan.removed.map((r) => r.file)].map(shellQuote).join(" ");
  const d = shellQuote(webDirOf(t));
  return `cd ${d} && printf 'site\\t%s\\n' "$(readlink -- current)" && cd current/ && for f in ${files}; do ` +
    `if test -f "$f"; then printf 'sha\\t%s\\t%s\\n' "$(sha256sum < "$f" | cut -d ' ' -f 1)" "$f"; else printf 'missing\\t%s\\n' "$f"; fi; done`;
}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** PURE. A URL path with each segment percent-encoded as a browser sends it. */
const encodePath = (p: string): string => p.split("/").map((s) => encodeURIComponent(s)).join("/");

/**
 * W11 (2): every served changed file is served as web/current holds it, and
 * web/current is this release's site. Each URL carries a one-off query so a
 * cache in front of nginx cannot answer with an older copy.
 */
export async function servedProblems(rel: Release, t: WebTarget, deps: Deps, plan: ServedPlan = servedPlanOf(rel, deps)): Promise<{ problems: string[]; compared: number }> {
  if (plan.compare.length === 0 && plan.removed.length === 0) return { problems: [], compared: 0 };
  const r = await deps.ssh(t.host, servedHashCommand(t, plan));
  if (r.status !== 0) return { problems: [`ssh ${t.host} could not hash the served files in ${webDirOf(t)}/current: ${errText(r)}`], compared: 0 };
  let site = "";
  const host = new Map<string, string | null>();
  for (const l of r.stdout.split("\n")) {
    const [k, a = "", b = ""] = l.split("\t");
    if (k === "site") site = a;
    else if (k === "sha") host.set(b, a);
    else if (k === "missing") host.set(a, null);
  }
  const problems: string[] = [];
  if (!siteIdIs(site, rel.version, rel.commit)) {
    return { problems: [`${webDirOf(t)}/current on ${t.host} names ${site || "nothing"}, not ${rel.version}-${short(rel.commit)}`], compared: 0 };
  }
  for (const rm of plan.removed) {
    if (host.get(rm.file) !== null) problems.push(`${rm.path} is removed by ${rel.tag} but ${site}/${rm.file} exists on ${t.host}`);
  }
  const bust = `rm-live-check=${short(rel.commit)}-${deps.clock()}`;
  let compared = 0;
  for (const c of plan.compare) {
    const want = host.get(c.file);
    if (want === undefined || want === null) { problems.push(`${c.path} is in ${rel.tag} but ${site}/${c.file} is missing on ${t.host}`); continue; }
    const url = `${t.publicOrigin}${encodePath(c.url)}?${bust}`;
    try {
      const got = await deps.httpBytes(url);
      if (got.status !== 200) { problems.push(`GET ${c.url} answered ${got.status}, not the deployed ${c.file}`); continue; }
      const sha = sha256(got.bytes);
      if (sha !== want) problems.push(`GET ${c.url} serves sha256 ${sha.slice(0, 16)}, not the deployed ${site}/${c.file} (${want.slice(0, 16)})`);
      else compared++;
    } catch (e) {
      problems.push(`GET ${c.url} failed: ${(e as Error).message}`);
    }
  }
  return { problems, compared };
}

/** The routes a browser always loads; a swarm member page is discovered and added after /regime. */
export const BROWSER_BASE_ROUTES: readonly string[] = Object.freeze(["/", "/regime", "/early-access"]);
/** The browser smoke's whole budget. A route it does not reach fails W11. */
export const BROWSER_BUDGET_MS = 180_000;

type Get = (url: string) => Promise<HttpResult>;

async function getJson(http: Get, url: string): Promise<{ body: unknown } | { error: string }> {
  try {
    const r = await http(url);
    if (r.status !== 200) return { error: `GET ${url} answered ${r.status}` };
    return { body: JSON.parse(r.body) as unknown };
  } catch (e) {
    return { error: `GET ${url} failed: ${(e as Error).message}` };
  }
}

/** One swarm member's public page, from GET /api/swarm/members (an active member first). */
export async function discoverMemberRoute(origin: string, http: Get): Promise<{ route: string } | { note: string } | { error: string }> {
  const r = await getJson(http, `${origin}/api/swarm/members`);
  if ("error" in r) return r;
  const members = ((r.body as { members?: unknown }).members ?? []) as { id?: unknown; handle?: unknown; status?: unknown }[];
  if (!Array.isArray(members)) return { error: `GET ${origin}/api/swarm/members gave no members list` };
  const m = members.find((x) => x.status === "active") ?? members[0];
  const ref = m === undefined ? undefined : typeof m.handle === "string" && m.handle !== "" ? m.handle : typeof m.id === "string" ? m.id : undefined;
  if (ref === undefined) return { note: `${origin}/api/swarm/members lists no member, so no member page is loaded` };
  return { route: `/swarm/members/${encodeURIComponent(ref)}` };
}

/** One swarm session (a published one first), from GET /api/swarm/sessions: its page and its subject's. */
async function discoverSessionRoutes(origin: string, http: Get): Promise<{ routes: string[] } | { error: string }> {
  const r = await getJson(http, `${origin}/api/swarm/sessions?limit=10`);
  if ("error" in r) return r;
  const sessions = ((r.body as { sessions?: unknown }).sessions ?? []) as { id?: unknown; subjectId?: unknown; publishedAt?: unknown }[];
  if (!Array.isArray(sessions)) return { error: `GET ${origin}/api/swarm/sessions gave no sessions list` };
  const s = sessions.find((x) => typeof x.publishedAt === "string") ?? sessions[0];
  const out: string[] = [];
  if (typeof s?.id === "string") out.push(`/swarm/sessions/${encodeURIComponent(s.id)}`);
  if (typeof s?.subjectId === "string") out.push(`/swarm/subjects/${encodeURIComponent(s.subjectId)}`);
  return { routes: out };
}

/** PURE. A changed view file's fragment path as routes.js names it: frontend/public/views/x.html -> /views/x.html. */
export const viewFragmentOf = (path: string): string | undefined =>
  /^frontend\/public\/views\/.+\.html$/.test(path) ? path.slice("frontend/public".length) : undefined;

/**
 * routes.js viewFor at the release commit: the router's own map from a route to
 * the view fragment it renders, so a changed view maps to the route that shows
 * it. routes.js imports nothing; it is loaded from a data: URL.
 */
async function releaseViewFor(rel: Release, deps: Deps): Promise<((p: string) => string) | { error: string }> {
  const r = deps.git(["show", `${rel.commit}:frontend/public/assets/js/app/routes.js`]);
  if (r.status !== 0) return { error: `routes.js at ${short(rel.commit)} could not be read: ${errText(r)}` };
  try {
    const m = (await import(`data:text/javascript;base64,${Buffer.from(r.stdout).toString("base64")}`)) as { viewFor?: unknown };
    if (typeof m.viewFor !== "function") return { error: `routes.js at ${short(rel.commit)} exports no viewFor` };
    return m.viewFor as (p: string) => string;
  } catch (e) {
    return { error: `routes.js at ${short(rel.commit)} does not load on its own (${(e as Error).message})` };
  }
}

/** The browser's routes: the base routes, a member page, and one route per changed view; plus notes and errors from discovering them. */
export interface BrowserPlan {
  readonly routes: readonly string[];
  /** The routes that show a changed view: a page among them that is never judged fails W11. */
  readonly changedRoutes: readonly string[];
  /** Changed views with the route that shows each. */
  readonly views: readonly string[];
  /** Changed views no candidate route shows (and not in UNROUTED_VIEWS): W01 refuses them. */
  readonly unmapped: readonly string[];
  readonly notes: readonly string[];
  readonly errors: readonly string[];
}

/**
 * View files the router never renders as a page of their own, so a change to
 * one maps to no route: the dashboard layout, injected around every /list,
 * /agents ... page (routes.js DASH_LAYOUT_VIEW). A change to any other view
 * with no route refuses the release at W01, since the browser could not load it.
 */
export const UNROUTED_VIEWS: readonly string[] = Object.freeze(["/views/dash/_layout.html"]);

/**
 * PURE. The route for each changed view: the first candidate whose viewFor is
 * that view. Candidates are tried in order, so a base route wins.
 */
export function routesForViews(views: readonly string[], candidates: readonly string[], viewFor: (p: string) => string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const v of views) out.set(v, candidates.find((c) => { try { return viewFor(c) === v; } catch { return false; } }));
  return out;
}

/** PURE. The routes a sitemap lists (path and query), from its XML. */
export const sitemapLocs = (xml: string): string[] =>
  [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].flatMap((m) => { try { const u = new URL(m[1]!); return [`${u.pathname}${u.search}`]; } catch { return []; } });

/**
 * W11 (4)'s plan, which W01 also builds to refuse an unmapped changed view.
 * GETs only: the public API for a member and a session, nothing else. The
 * candidate routes for a changed view are the base routes, the member page,
 * the release tree's own sitemap, a session and its subject, then the
 * catch-all route routes.js resolves /views/X.html from (/X).
 */
export async function browserPlan(rel: Release, t: WebTarget, deps: Deps): Promise<BrowserPlan> {
  const notes: string[] = [];
  const errors: string[] = [];
  const routes = [...BROWSER_BASE_ROUTES];
  const member = await discoverMemberRoute(t.publicOrigin, deps.http);
  if ("route" in member) routes.splice(2, 0, member.route);
  else if ("note" in member) notes.push(member.note);
  else errors.push(member.error);
  const views = [...new Set(rel.changed.map(viewFragmentOf).filter((v): v is string => v !== undefined))].filter((v) => !UNROUTED_VIEWS.includes(v)).sort();
  const viewLines: string[] = [];
  const unmapped: string[] = [];
  const changedRoutes: string[] = [];
  if (views.length > 0) {
    const viewFor = await releaseViewFor(rel, deps);
    if (typeof viewFor !== "function") errors.push(`${viewFor.error}, so the changed views ${views.join(", ")} cannot be mapped to routes`);
    else {
      const sm = deps.git(["show", `${rel.commit}:frontend/public/sitemap.xml`]);
      const catchAll = views.map((v) => v.slice("/views".length, -".html".length));
      // The catch-all /X comes last: a param view (a session, a member) needs a real id, not /swarm/session.
      const candidates = [...routes, ...(sm.status === 0 ? sitemapLocs(sm.stdout) : [])];
      let mapped = routesForViews(views, candidates, viewFor);
      if ([...mapped.values()].some((r) => r === undefined)) {
        const s = await discoverSessionRoutes(t.publicOrigin, deps.http);
        if ("error" in s) errors.push(`${s.error}: session and subject pages cannot be found`);
        else candidates.push(...s.routes);
        mapped = routesForViews(views, [...candidates, ...catchAll], viewFor);
      }
      for (const [v, r] of mapped) {
        if (r === undefined) { unmapped.push(v); viewLines.push(`${v} -> (none)`); continue; }
        viewLines.push(`${v} -> ${r}`);
        if (!routes.includes(r)) routes.push(r);
        if (!changedRoutes.includes(r)) changedRoutes.push(r);
      }
    }
  }
  return { routes, changedRoutes, views: viewLines, unmapped, notes, errors };
}

/** PURE. Why W01 refuses the plan: a changed view with no route, or discovery that failed. */
export function browserPlanProblems(bp: BrowserPlan): string[] {
  return [
    ...bp.errors.map((e) => `W11's browser plan cannot be built: ${e}`),
    ...(bp.unmapped.length > 0
      ? [`no route shows the changed view(s) ${bp.unmapped.join(", ")}, so W11's browser could not load them: add a route, or name the view in UNROUTED_VIEWS (scripts/release/web-release-lib.ts) when no page renders it`]
      : []),
  ];
}

/** What one page load says: the problems that fail the page, and the /api/ requests that answered 503. */
export interface LoadVerdict {
  readonly problems: string[];
  /** Same-origin /api/ paths that answered 503: the api was unavailable for this load. */
  readonly unavailable: string[];
}

/** The path prefix of the static archive a swarm page falls back to when its live /api/ read fails (static-views.js loadArchiveMember). */
const ARCHIVE_FALLBACK = "/data/swarm/manifests/";

/**
 * PURE. Judge one load. Everything counts, except:
 *
 * - a same-origin /api/ request that answered 503 (the api's own "unavailable":
 *   its pool gate's db_saturated, a statement timeout), Chrome's "Failed to load
 *   resource" line for it, and the archive-manifest 404 its page falls back to.
 *   Seen on production on 2026-11-11: GET /api/swarm/members/<handle> hit
 *   Postgres' statement timeout now and then, and the member page read
 *   /data/swarm/manifests/members/<handle>.json (404). The 503 never hides a
 *   page error, another console.error, the not-found view or a missed ready
 *   signal on the same load;
 * - a cross-origin request's failure and its console line (the release ships
 *   only same-origin files);
 * - a media request the browser aborts itself (net::ERR_ABORTED on a video or
 *   audio preload, seen on /changelog's mp4). Any other aborted same-origin
 *   request counts.
 */
export function judgeLoad(origin: string, r: PageReport): LoadVerdict {
  const at = `browser ${r.route}`;
  const same = (url: string): URL | undefined => { try { const u = new URL(url); return u.origin === origin ? u : undefined; } catch { return undefined; } };
  const unavailable = r.failedRequests.filter((f) => f.status === 503 && same(f.url)?.pathname.startsWith("/api/")).map((f) => f.url);
  const excused = new Set(unavailable);
  if (unavailable.length > 0) {
    for (const f of r.failedRequests) if (f.status === 404 && same(f.url)?.pathname.startsWith(ARCHIVE_FALLBACK)) excused.add(f.url);
  }
  const ignored = new Set(excused);
  for (const f of r.failedRequests) {
    if (same(f.url) === undefined) ignored.add(f.url);
    else if (f.status === undefined && f.failure === "net::ERR_ABORTED" && f.resourceType === "media") ignored.add(f.url);
  }
  const problems: string[] = [];
  if (!r.ready) problems.push(`${at}: never reached the router's ready signal (<html data-routed>): ${r.readyDetail ?? "timed out"}`);
  if (r.notFoundView) problems.push(`${at}: the router rendered the not-found view`);
  for (const e of r.pageErrors) problems.push(`${at}: uncaught page error: ${e.split("\n")[0]}`);
  for (const e of r.consoleErrors) {
    // Chrome's "Failed to load resource: ... (<url>:<line>)" line goes with the request it names.
    const url = e.startsWith("Failed to load resource:") ? /\((\S+):\d+\)$/.exec(e)?.[1] : undefined;
    if (url !== undefined && ignored.has(url)) continue;
    problems.push(`${at}: console.error: ${e}`);
  }
  for (const f of r.failedRequests) {
    if (ignored.has(f.url)) continue;
    const u = same(f.url)!;
    problems.push(`${at}: ${f.method} ${u.pathname}${u.search} ${f.status !== undefined ? `answered ${f.status}` : `failed (${f.failure ?? "network"})`}`);
  }
  return { problems, unavailable: [...new Set(unavailable.map((u) => new URL(u).pathname))] };
}

/** PURE. Why one browser load fails W11: empty when it passed (an /api/ 503 alone does not fail it). */
export const pageProblems = (origin: string, r: PageReport): string[] => judgeLoad(origin, r).problems;

/** What the browser smoke found. */
export interface SmokeResult {
  readonly problems: string[];
  /** Each route's last load. */
  readonly reports: readonly PageReport[];
  /** One line per inconclusive load that was loaded again. */
  readonly retried: string[];
  /** Unchanged routes never judged (an /api/ 503 on every load). They do not fail W11. */
  readonly warnings: string[];
}

/** How many times a page whose loads are inconclusive is loaded at most. */
export const PAGE_LOADS = 3;

/**
 * Load every route once. A load with any problem fails its page at once: a
 * page is never loaded again to get past a failure. A load whose only fault is
 * an /api/ 503 (judgeLoad) is inconclusive, and the page is loaded again, up
 * to PAGE_LOADS in all and inside the budget. A page with a clean load passes.
 * A page inconclusive on every load fails when it shows a changed view
 * (`changedRoutes`: the release's own surface was never seen working), and is
 * a warning otherwise. A route the browser never reported fails.
 */
export async function smokePages(
  origin: string, routes: readonly string[], changedRoutes: readonly string[], browser: BrowserSmoke, clock: () => number, budgetMs: number = BROWSER_BUDGET_MS,
): Promise<SmokeResult> {
  const t0 = clock();
  const loads = new Map<string, PageReport[]>();
  const record = (rs: readonly PageReport[]) => { for (const r of rs) loads.set(r.route, [...(loads.get(r.route) ?? []), r]); };
  record(await browser(origin, routes, budgetMs));
  const isInconclusive = (r: PageReport): boolean => { const v = judgeLoad(origin, r); return v.problems.length === 0 && v.unavailable.length > 0; };
  const retried: string[] = [];
  for (let n = 1; n < PAGE_LOADS; n++) {
    const again = routes.filter((route) => { const l = loads.get(route); return l !== undefined && isInconclusive(l[l.length - 1]!); });
    const left = budgetMs - (clock() - t0);
    if (again.length === 0 || left <= 1_000) break;
    for (const route of again) retried.push(`${route} load ${n} was inconclusive (the api answered 503 for ${judgeLoad(origin, loads.get(route)!.at(-1)!).unavailable.join(", ")}); loaded again`);
    record(await browser(origin, again, left));
  }
  const problems: string[] = [];
  const warnings: string[] = [];
  const reports: PageReport[] = [];
  for (const route of routes) {
    const l = loads.get(route);
    if (l === undefined) { problems.push(`browser ${route}: no report`); continue; }
    reports.push(l[l.length - 1]!);
    const failing = l.find((r) => judgeLoad(origin, r).problems.length > 0);
    if (failing !== undefined) { problems.push(...judgeLoad(origin, failing).problems); continue; }
    if (l.some((r) => !isInconclusive(r))) continue;
    const why = `the api answered 503 on all ${l.length} load(s) (${[...new Set(l.flatMap((r) => judgeLoad(origin, r).unavailable))].join(", ")})`;
    if (changedRoutes.includes(route)) problems.push(`browser ${route}: shows a changed view but was never judged: ${why}`);
    else warnings.push(`browser ${route}: not judged: ${why}; it shows no changed view`);
  }
  return { problems, reports, retried, warnings };
}

/** The sitemap's routes, or why it could not be read. */
async function sitemapRoutes(t: WebTarget, deps: Deps): Promise<{ routes: string[] } | { error: string }> {
  try {
    const sm = await deps.http(`${t.publicOrigin}/sitemap.xml`);
    if (sm.status !== 200) return { error: `GET ${t.publicOrigin}/sitemap.xml answered ${sm.status}` };
    const routes = sitemapLocs(sm.body);
    if (routes.length === 0) return { error: `${t.publicOrigin}/sitemap.xml lists no route` };
    return { routes };
  } catch (e) {
    return { error: `GET ${t.publicOrigin}/sitemap.xml failed: ${(e as Error).message}` };
  }
}

/** PURE. The plan's lines for W11: what (2) compares and skips, and what (4) loads. */
export function livePlanLines(served: ServedPlan, browser: BrowserPlan): string[] {
  return [
    `served files compared with web/current: ${served.compare.length === 0 ? "(none)" : served.compare.map((c) => c.url).join(", ")}`,
    ...(served.removed.length > 0 ? [`removed, must be absent from web/current: ${served.removed.map((r) => r.file).join(", ")}`] : []),
    `not served (skipped): ${served.skipped.length === 0 ? "(none)" : served.skipped.join(", ")}`,
    `browser routes: ${browser.routes.join(", ")}`,
    ...(browser.views.length > 0 ? [`changed views (${browser.views.length - browser.unmapped.length} of ${browser.views.length} mapped): ${browser.views.join("; ")}`] : []),
    ...browser.notes.map((n) => `note: ${n}`),
    ...browser.errors.map((e) => `discovery failed: ${e}`),
  ];
}

/** The dry run's W11 plan: the served comparison and the browser routes, discovered with GETs only. */
export async function livePlan(rel: Release, inputs: Inputs, deps: Deps): Promise<string[]> {
  return livePlanLines(servedPlanOf(rel, deps), await browserPlan(rel, inputs.target, deps));
}

/** What W11 found: its problems, and what it checked when it passed. One W11 run judges the site once (runWebRelease hands this to runLive). */
export interface LiveResult {
  readonly problems: string[];
  readonly summary: string;
}

/** Every way the live site is not this release served beside an unchanged api: no problems when it is. */
export async function liveResult(rel: Release, inputs: Inputs, deps: Deps): Promise<LiveResult> {
  const t = inputs.target;
  const before = readRecord(inputs, rel, deps);
  if (before === undefined) return { problems: [`${servingRecordPath(inputs, rel)} (W10's record) is missing`], summary: "" };
  const out: string[] = [];
  const live = await readLiveSite(t, deps);
  if ("error" in live) out.push(live.error);
  else if (!liveIs(live, rel)) out.push(`${t.publicOrigin}/version.json reports ${live.version}-${live.commit}, not ${rel.version}-${short(rel.commit)}`);

  const plan = servedPlanOf(rel, deps);
  // A dry run loads no page and hashes no file, even when W10's record exists (a rerun after a deploy).
  if (inputs.dryRun) return { problems: [...out, "a dry run does not compare the served files or load the browser"], summary: "" };
  const served = await servedProblems(rel, t, deps, plan);
  out.push(...served.problems);

  const sm = await sitemapRoutes(t, deps);
  const routes = "routes" in sm ? sm.routes : [];
  if ("error" in sm) out.push(sm.error);
  for (const route of routes) {
    try {
      const r = await deps.http(`${t.publicOrigin}${route}`);
      if (r.status !== 200) out.push(`GET ${route} answered ${r.status}`);
    } catch (e) {
      out.push(`GET ${route} failed: ${(e as Error).message}`);
    }
  }

  let pages = 0;
  if (out.length > 0) deps.log("[web-release] browser smoke skipped: the checks above already failed");
  else {
    const bp = await browserPlan(rel, t, deps);
    for (const l of livePlanLines(plan, bp)) deps.log(`[web-release] ${l}`);
    out.push(...browserPlanProblems(bp));
    try {
      const smoke = await smokePages(t.publicOrigin, bp.routes, bp.changedRoutes, deps.browser, deps.clock);
      out.push(...smoke.problems);
      for (const l of smoke.retried) deps.log(`[web-release] browser ${l}`);
      for (const w of smoke.warnings) deps.log(`[web-release] WARNING ${w}`);
      for (const r of smoke.reports) {
        if (r.blocked.length > 0) deps.log(`[web-release] browser ${r.route}: answered ${r.blocked.length} non-GET request(s) inside the browser (read only): ${r.blocked.join(", ")}`);
      }
      pages = smoke.reports.length;
    } catch (e) {
      out.push(`the browser smoke could not run: ${(e as Error).message.split("\n")[0]}`);
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
  const summary = `${t.publicOrigin} serves ${rel.tag}, ${served.compared} changed file(s) are served as deployed (${plan.skipped.length} not served), ` +
    `every sitemap route answers 200, the browser smoke passed on ${pages} page(s), the api and workers are unchanged`;
  return { problems: out, summary };
}

/** Every way the live site is not this release served beside an unchanged api: empty when it is. */
export async function liveProblems(rel: Release, inputs: Inputs, deps: Deps): Promise<string[]> {
  return (await liveResult(rel, inputs, deps)).problems;
}

/** PURE. The live check's done state from a judged result. */
export const liveState = (r: LiveResult): StepResult =>
  r.problems.length === 0 ? { state: "done", detail: r.summary } : { state: "todo", detail: r.problems.join("; ") };

export async function checkLive(rel: Release, inputs: Inputs, deps: Deps): Promise<StepResult> {
  return liveState(await liveResult(rel, inputs, deps));
}

/**
 * The live check: pass, or roll the site back with `bun run smoke:web
 * --rollback` and fail. The tag stays. `judged` is the done check's result:
 * the runner judges the site once per W11, so a page never gets a second
 * smoke to pass in.
 */
export async function runLive(rel: Release, inputs: Inputs, deps: Deps, judged?: LiveResult): Promise<StepResult> {
  const t = inputs.target;
  const { problems, summary } = judged ?? await liveResult(rel, inputs, deps);
  if (problems.length === 0) return { state: "done", detail: summary };
  const next = `${WEB_TAG_PREFIX}${nextPatch(rel.version)}`;
  deps.log(`[web-release] the live check failed: ${problems.join("; ")}; rolling back`);
  const r = await deps.ssh(t.host, rollbackCommand(t));
  // Read back what production serves now, rather than trust the rollback's exit code.
  const after = await readLiveSite(t, deps);
  const serves = "error" in after ? `${t.publicOrigin}/version.json could not be read after it (${after.error})` : `${t.publicOrigin} now serves ${after.version}-${after.commit}`;
  const rolled = r.status === 0
    ? `rolled back to the previous site (bun run smoke:web --rollback); ${serves}`
    : `THE ROLLBACK FAILED (exit ${r.status}: ${errText(r)}); ${serves}: run bun run smoke:web --rollback --instance ${t.instance} on ${t.host} by hand`;
  return failed(`the live check failed: ${problems.join("; ")}. ${rolled}. ${rel.tag} stays where it is: ship the fix as ${next}`);
}

// ── W12: release ─────────────────────────────────────────────────────────────

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
    "", "## Outside the web content paths", "",
    "Paths the main commits touch outside the web content paths. Tests are carried (they deploy nothing, and the gate runs them); docs and comment-only edits are left out.", "",
    ...(rel.outside.length === 0 ? ["- (none)"] : rel.outside.map((o) => `- ${short(o.commit)} \`${o.path}\` (${o.kind}: ${isCarried(o) ? "carried" : "left out"})`)),
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
  deps.log(`[web-release] outside the web content paths: ${rel.outside.length === 0 ? "(none)" : "tests carried, docs and comment-only edits left out"}`);
  for (const l of outsideLines(rel.outside)) deps.log(`  ${l}`);
  deps.log(sitesLine(rel.sites));
  deps.log(`[${first!.id}] passed`);
  let live: LiveResult | undefined;
  for (const step of rest) {
    const check: StepResult =
      step.kind === "branch" ? checkBranch(rel, deps)
      : step.kind === "gate" ? asCheck(readGate(rel, deps))
      : step.kind === "stage-up" ? await checkStageUp(rel, inputs, deps)
      : step.kind === "stage-deploy" ? await checkStageDeploy(rel, inputs, deps)
      : step.kind === "stage-check" ? checkStageCheck(rel, inputs, deps)
      : step.kind === "tag" ? checkTagStep(rel, deps)
      : step.kind === "tag-guard" ? asCheck(readTagGuard(rel, deps))
      : step.kind === "checkout" ? await checkCheckout(rel, t, deps)
      : step.kind === "deploy" ? await checkDeploy(rel, inputs, deps)
      : step.kind === "live-check" ? liveState(live = await liveResult(rel, inputs, deps))
      : checkReleaseStep(rel, deps);
    if (check.state === "done") { deps.log(`[${step.id}] already done: ${check.detail}`); continue; }
    if (check.state === "failed") return stop(step.id, check.detail);
    const gated = PRODUCTION_KINDS.includes(step.kind) && stagePassed(rel, inputs, deps) === undefined;
    if (inputs.dryRun) {
      deps.log(`[${step.id}] not done${step.irreversible ? " (IRREVERSIBLE, would write)" : ""}: ${check.detail}${gated ? "; it refuses until stage QA passes on this commit" : ""}`);
      if (step.kind === "stage-check") deps.log(`[${step.id}] plan: W11's checks against ${inputs.stage.publicOrigin}, the browser on ${inputs.stage.host}`);
      if (step.kind === "live-check") for (const l of await livePlan(rel, inputs, deps)) deps.log(`[${step.id}] plan: ${l}`);
      continue;
    }
    if (gated) return stop(step.id, stageGateProblem(rel, inputs));
    const result: StepResult =
      step.kind === "branch" ? runBranch(rel, deps)
      : step.kind === "gate" ? await gateStep(rel, deps, step.maxMinutes!, step.id, rerun)
      : step.kind === "stage-up" ? await runStageUp(rel, inputs, deps)
      : step.kind === "stage-deploy" ? await runStageDeploy(rel, inputs, deps)
      : step.kind === "stage-check" ? await runStageCheck(rel, inputs, deps)
      : step.kind === "tag" ? runTagStep(rel, deps)
      : step.kind === "tag-guard" ? await poll(() => readTagGuard(rel, deps), step.maxMinutes!, deps, step.id, rerun)
      : step.kind === "checkout" ? await runCheckout(rel, t, deps)
      : step.kind === "deploy" ? await runDeploy(rel, inputs, deps)
      : step.kind === "live-check" ? await runLive(rel, inputs, deps, live)
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
