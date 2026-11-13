// scripts/release/web-release-lib.ts — the web content release runbook (D81,
// docs/technical/release-runbooks.md §12, docs/technical/web-serving-architecture.md
// §5): its loader and validator, the content-only eligibility classifier, the
// twelve step kinds and the runner.
//
// The runbook is ./runbooks/web-content.yaml; ./web-release.ts is the CLI. It is
// modeled on ./sdk-release-lib.ts (whose CI polls it reuses) and keeps the
// platform runbook's conventions (Bun.YAML, step ids, `irreversible`, refusal
// of unknown keys). It reads the platform's target file (./target.ts) for where
// production lives and runs its host reads over ssh in the platform's shape
// (./steps.ts: `env -i`, BASE_ENV, shellQuote), with no new target key.
//
// A web content release ships the WEB_CONTENT_PATHS part (scripts/lib/
// website-release.ts) of named main commits, with their tests, as one signed
// bundle (issue 1630). The runner cherry-picks that part of each commit onto
// web/releases-A.B.x (created at the eligibility base: production's API commit,
// or the last web tag on it), carrying its tests and leaving out docs and
// comment-only edits (issue 1603), pushes it as a fast-forward, waits for
// web-client.yml and e2e-web.yml, then packs and signs the bundle on the
// control machine (W03). Stage gets production's serving bundle first, by name,
// so it holds a previous image, then this bundle through `bun smoke:web`'s image
// mode, and the live check passes there (W04 to W06). The pass is recorded for
// the bundle's digest: no step from W07 on writes without it, and W10 refuses
// any other digest. Then the tag, its guard, a read-only host check (W09), the
// swap on production, the live check (labels, served bytes against the
// manifest, the header table, the sitemap, an unchanged api) and the GitHub
// release with the bundle, its digest and its signature. A failed live check
// rolls the site back with `bun smoke:web --rollback`. The tag is never moved
// or deleted: the fix ships as web-vA.B.(C+1).
//
// Every git, gh, ssh, http and control-machine command goes through an injected
// Deps, so the unit tests run the steps against a local bare origin and stubs.
// Each step has a read-only done check, so a rerun reports the steps already
// done and continues at the first that is not; `--dry-run` runs only the
// preflight and the checks.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareSemver, SEMVER } from "../check-analyst-sdk-tag.ts";
import { checkWebTag, WEB_MANIFEST, WEB_RELEASE_BRANCH_GLOB, WEB_TAG_PREFIX } from "../check-web-tag.ts";
import { gunzipSync } from "node:zlib";
import { readTar } from "../lib/web-bundle.ts";
import { BUNDLE_MANIFEST_FILENAME, bundleFileName, parseBundleManifest, type BundleManifest } from "../lib/web-bundle-manifest.ts";
import { WEBSITE_ASSET_CACHE, WEBSITE_HTML_CACHE, WEBSITE_IMAGE_LABELS, WEBSITE_SECURITY_HEADERS } from "../lib/website-image.ts";
import { IMAGE_JOURNAL_FILE, INSTANCE_LABEL, SERVICE_LABEL, siteImageTag, WEB_CONTENT_PATHS, WEBSITE_SERVICE, type ImageReceipt } from "../lib/website-release.ts";
import { poll, readRun, type Deps as SdkDeps, type ExecResult, type StepResult } from "./sdk-release-lib.ts";
import { BASE_ENV, shellQuote } from "./steps.ts";
import type { ReleaseTarget } from "./target.ts";

export type { ExecResult, StepResult } from "./sdk-release-lib.ts";

/** The committed web content runbook. It sits outside templates/ and releases/, so ./runbook.ts never reads it. */
export const WEB_RUNBOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), "runbooks", "web-content.yaml");

/** The twelve kinds, in the one order the runbook holds them (web-serving-architecture.md §5.1). */
export const WEB_KINDS = [
  "preflight", "branch", "gate", "stage-up", "stage-deploy", "stage-check", "tag", "tag-guard", "host-ready", "deploy", "live-check", "release",
] as const;
export type WebStepKind = (typeof WEB_KINDS)[number];

/** The kinds that act on production or publish the release: none writes unless stage QA passed for the bundle's digest (owner, 2026-11-11; issue 1630). */
export const PRODUCTION_KINDS: readonly WebStepKind[] = Object.freeze(["tag", "tag-guard", "host-ready", "deploy", "live-check", "release"]);

/** Whether each kind writes to GitHub or switches what production serves. A step's `irreversible` must say the same (stage steps write only to the stage host). */
const KIND_IRREVERSIBLE: Readonly<Record<WebStepKind, boolean>> = Object.freeze({
  preflight: false, branch: true, gate: false, "stage-up": false, "stage-deploy": false, "stage-check": false,
  tag: true, "tag-guard": false, "host-ready": false, deploy: true, "live-check": false, release: true,
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

/** PURE. The host's server image for an instance: the platform's website-server/Dockerfile.caddy build every site image is built FROM. */
export const serverImageOf = (instance: string): string => `robotmoney-website-server:${instance}`;

/** Where the server image holds the allowed-signers file a host verifies bundles against (website-server/Dockerfile.caddy). */
export const HOST_ALLOWED_SIGNERS = "/etc/robotmoney/allowed-signers";

/** Where a web content release acts: the platform target's host, home, instance and origin, and the host's server image. */
export interface WebTarget {
  readonly name: string;
  readonly rmEnv: "stage" | "prod";
  readonly host: string;
  readonly home: string;
  readonly instance: string;
  readonly publicOrigin: string;
  /** The host's smoke state root: {home}/.local/state/robotmoney-smoke (scripts/lib/smoke-state.ts stateRoot). */
  readonly stateRoot: string;
  /** The server image every site image is built FROM (serverImageOf). */
  readonly serverImage: string;
  /** Variables added to every host command's `env -i` (none for a real target). */
  readonly env: Readonly<Record<string, string>>;
}

/** PURE. The web target for a platform target file: the same host, home, instance and origin; no new key. */
export function webTargetOf(t: ReleaseTarget): WebTarget {
  return {
    name: t.name, rmEnv: t.rmEnv, host: t.host, home: t.home, instance: t.instance, publicOrigin: t.publicOrigin,
    stateRoot: `${t.home}/.local/state/robotmoney-smoke`, serverImage: serverImageOf(t.instance), env: {},
  };
}

export interface HttpResult {
  readonly status: number;
  readonly body: string;
  /** The answer's headers, names lower-cased (the live check compares them with the header table). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Everything the steps touch outside their own memory. The CLI binds real processes; the tests bind stubs. */
export interface Deps extends SdkDeps {
  /** Run one shell command on a host; collect its output. */
  ssh(host: string, remote: string): Promise<ExecResult>;
  /** GET a URL. Throws when it cannot be reached. */
  http(url: string): Promise<HttpResult>;
  /** GET a URL as bytes (W11 hashes what is served). Throws when it cannot be reached. */
  httpBytes(url: string): Promise<{ readonly status: number; readonly bytes: Uint8Array }>;
  readFile(path: string): string | undefined;
  /** A file's bytes on the control machine (the bundle tarball), or undefined. */
  readBytes(path: string): Uint8Array | undefined;
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
  /** The control machine's bundle signing key (W03): an ed25519 private key whose public half the hosts' allowed-signers lists. */
  readonly signingKey: string;
  /** The control machine's smoke state root: `bun smoke:web` writes each instance's image receipts under <it>/web-image/<instance>/. */
  readonly controlStateRoot: string;
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
  /** What W01 read of production's website-server: the image a W11 rollback returns to is the one serving now. */
  readonly serving?: HostWeb;
}

/** An instance's website-server on its host: the serving container's image and labels, and the one previous image. */
export interface HostWeb {
  /** The running container's id; absent when none runs. */
  readonly container?: string;
  readonly image?: string;
  /** Its labels' web tag, commit and bundle digest; absent while nginx serves (a host's first rollout, issue 1632). */
  readonly tag?: string;
  readonly commit?: string;
  readonly digest?: string;
  /** `robotmoney-website:<instance>-previous`'s image id, when the host holds one. */
  readonly previous?: string;
  /** The container's `docker ps` status, with its healthcheck's state: `Up 3 minutes (healthy)`. */
  readonly status?: string;
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

/**
 * PURE. W04's, W05's and W10's control-machine command: `bun smoke:web`'s image mode deploys one signed
 * bundle (a file, or a `web-vA.B.C` release by name) on the target's host and checks it through the
 * target's origin (web-serving-architecture.md §4). It installs nothing on the host and builds no site there.
 */
export const deployArgv = (t: WebTarget, bundle: string): string[] =>
  ["bun", "run", "smoke:web", "--host", t.host, "--instance", t.instance, "--bundle", bundle, "--server-image", t.serverImage, "--origin", t.publicOrigin];

/** PURE. W11's rollback, from the control machine: the previous image, or on a first rollout the kept nginx container, goes back on the public port. */
export const rollbackArgv = (t: WebTarget): string[] =>
  ["bun", "run", "smoke:web", "--host", t.host, "--instance", t.instance, "--rollback", "--origin", t.publicOrigin];

const instanceDir = (t: WebTarget): string => `${t.stateRoot}/${t.instance}`;

/** PURE. Print a host file when it exists, nothing when it does not; any other exit means the host could not be read. */
const catIfPresent = (path: string): string => `if test -e ${shellQuote(path)}; then cat -- ${shellQuote(path)}; fi`;

/** PURE. Prefix every line a command prints with `<key>\t`, so one ssh call answers several reads. */
const tagged = (key: string, cmd: string): string => `${cmd} | while IFS= read -r l; do printf '${key}\\t%s\\n' "$l"; done`;

/**
 * PURE. Read-only: the instance's running website-server (id, image, and the web tag, commit and bundle
 * digest its labels name) and the image `robotmoney-website:<instance>-previous` names. W01, W04, W06,
 * W10 and W11 read it; nothing is started, built or installed.
 */
export function hostWebCommand(t: WebTarget): string {
  const L = WEBSITE_IMAGE_LABELS;
  const ps = envCommand(t, [
    "docker", "ps", "--no-trunc", "--filter", `label=${INSTANCE_LABEL}=${t.instance}`, "--filter", `label=${SERVICE_LABEL}=${WEBSITE_SERVICE}`,
    "--format", `{{.ID}}\t{{.Image}}\t{{.Label "${L.tag}"}}\t{{.Label "${L.commit}"}}\t{{.Label "${L.bundleSha256}"}}\t{{.Status}}`,
  ]);
  const previous = envCommand(t, ["docker", "image", "inspect", "--format", "{{.Id}}", siteImageTag(t.instance, "previous")]);
  return `${tagged("serving", ps)} && { if p=$(${previous} 2>/dev/null); then printf 'previous\\t%s\\n' "$p"; fi; }`;
}

/** PURE. The HostWeb a hostWebCommand's output names, or why it names none usable. */
export function parseHostWeb(stdout: string): { web: HostWeb } | { error: string } {
  const serving: string[][] = [];
  let previous: string | undefined;
  for (const l of stdout.split("\n")) {
    const [key, ...rest] = l.split("\t");
    if (key === "serving") serving.push(rest);
    else if (key === "previous" && rest[0]) previous = rest[0];
  }
  if (serving.length > 1) return { error: `${serving.length} website-server containers run for the instance, not one` };
  const [id, image, tag, commit, digest, status] = serving[0] ?? [];
  const web: Record<string, string> = {};
  for (const [k, v] of Object.entries({ container: id, image, tag, commit, digest, previous, status })) if (v) web[k] = v;
  return { web: web as HostWeb };
}

/** Read an instance's website-server (read only). */
export async function readHostWeb(t: WebTarget, deps: Deps): Promise<{ web: HostWeb } | { error: string }> {
  const r = await deps.ssh(t.host, hostWebCommand(t));
  if (r.status !== 0) return { error: `ssh ${t.host} could not read ${t.instance}'s website-server: ${errText(r)}` };
  const parsed = parseHostWeb(r.stdout);
  return "error" in parsed ? { error: `${t.host}: ${parsed.error}` } : parsed;
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

  // The rollback target: W10's swap keeps what serves now. A site image becomes the previous image; on a
  // host's first rollout the nginx container is kept, stopped, as <name>-first-rollout (spec §4, issue
  // 1632). So a running website-server is all W01 needs.
  const web = await readHostWeb(t, deps);
  if ("error" in web) return { errors: [web.error] };
  const noTarget = rollbackTargetProblem(t, web.web);
  if (noTarget !== undefined) return { errors: [noTarget] };
  if (tags.get(tag) === commit) {
    const rolled = rolledBack(inputs, tag, deps);
    if (rolled !== undefined) return { errors: [rolled] };
  }
  const admin = deps.gh(["api", "repos/{owner}/{repo}", "--jq", ".permissions.admin"]);
  if (admin.status !== 0) return { errors: [`gh api repos/{owner}/{repo} failed: ${errText(admin)}`] };
  if (admin.stdout.trim() !== "true") return { errors: ["the operator lacks the admin permission on the repository (the tag push needs it)"] };
  return { release: { version, commit, branch, tag, apiCommit: apiSha, base, changed, outside, serving: web.web } };
}

/**
 * PURE. Why production would have no rollback target after W10's swap: no website-server runs for the
 * instance. The swap keeps what serves now: a site image as the one previous image, or on a host's first
 * rollout the nginx container, stopped, as <name>-first-rollout (spec §4, issue 1632). So W01 needs a
 * serving container, not a previous image.
 */
export function rollbackTargetProblem(t: WebTarget, web: HostWeb): string | undefined {
  if (web.container !== undefined) return undefined;
  return `no website-server runs for ${t.instance} on ${t.host}, so W10's swap would keep no rollback target and a failed W11 could not roll back ` +
    "(bun smoke:web --rollback refuses with neither a previous image nor a first-rollout container). Bring the instance's stack up with its platform release first";
}

/** PURE. The run log's line for what a host's website-server serves. */
export function servingLine(t: Pick<WebTarget, "name">, web: HostWeb | undefined): string {
  if (web === undefined) return `[web-release] ${t.name}'s website-server: not read`;
  const now = web.tag !== undefined ? `${web.tag} (sha256 ${web.digest ?? "?"})` : `${web.image ?? "(nothing)"}, no signed bundle (first rollout: the swap keeps its container, stopped, as the rollback target, issue 1632)`;
  return `[web-release] ${t.name} serves ${now}; previous image ${web.previous ?? "(none)"}; after the swap a W11 rollback returns to what serves now`;
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

/** PURE. The control machine's image receipts directory for a target: `bun smoke:web` writes receipt.json and journal.jsonl there. */
export const imageReceiptDir = (inputs: Pick<Inputs, "controlStateRoot">, t: Pick<WebTarget, "instance">): string =>
  join(inputs.controlStateRoot, "web-image", t.instance);

/** The image receipts `bun smoke:web` journaled for a target on this control machine, oldest first. Unreadable lines are skipped. */
export function imageJournal(inputs: Pick<Inputs, "controlStateRoot">, t: Pick<WebTarget, "instance">, deps: Pick<Deps, "readFile">): ImageReceipt[] {
  const text = deps.readFile(join(imageReceiptDir(inputs, t), IMAGE_JOURNAL_FILE)) ?? "";
  return text.split("\n").flatMap((l) => { try { return l.trim() === "" ? [] : [JSON.parse(l) as ImageReceipt]; } catch { return []; } });
}

/**
 * PURE. Whether a tag was rolled back on a target: a deploy swapped its image onto the public port, and a
 * later rollback swapped that image off again.
 */
export function wasRolledBack(journal: readonly ImageReceipt[], tag: string): boolean {
  let image: string | undefined;
  for (const r of journal) {
    if (r.action === "deploy" && r.outcome === "swapped" && r.release?.tag === tag) image = r.newContainer?.image;
    else if (r.action === "rollback" && r.outcome === "swapped" && image !== undefined && r.oldContainer?.image === image) return true;
  }
  return false;
}

/** Why a rerun may not resume an existing tag: the control machine's image journal says W11 rolled it back on production. */
function rolledBack(inputs: Inputs, tag: string, deps: Deps): string | undefined {
  if (!wasRolledBack(imageJournal(inputs, inputs.target, deps), tag)) return undefined;
  return `${tag} was rolled back at W11 on ${inputs.target.host} (${join(imageReceiptDir(inputs, inputs.target), IMAGE_JOURNAL_FILE)}); ` +
    `the tag is never moved or cut again: ship the fix as ${WEB_TAG_PREFIX}${nextPatch(tag.slice(WEB_TAG_PREFIX.length))}`;
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

// ── W03: the signed bundle ───────────────────────────────────────────────────
//
// Once the gate passes, the runner packs and signs the release's bundle on the
// control machine (web-serving-architecture.md §3.1, R2): a scratch worktree at
// the release commit, a frozen install, scripts/static-assembly.sh, then
// scripts/lib/web-bundle.ts pack and sign. Stage and production get the same
// bytes (R13): W05 and W10 send this file, and the stage pass names its digest.

/** PURE. Where W03 leaves the bundle, its digest and its signature: stable across reruns. */
export const bundleDirOf = (inputs: Pick<Inputs, "workDir">, rel: Pick<Release, "tag">): string => join(inputs.workDir, `${rel.tag}-bundle`);

/** PURE. The bundle's path: robotmoney-web-<version>-<commit>.tar.gz in the bundle directory. */
export const bundlePathOf = (inputs: Pick<Inputs, "workDir">, rel: Pick<Release, "tag" | "version" | "commit">): string =>
  join(bundleDirOf(inputs, rel), bundleFileName({ version: rel.version, commit: rel.commit }));

/**
 * PURE. W03's commands on the control machine, in order: the release commit's tree in a scratch worktree,
 * its frozen install, the site assembly, then the pack and the signature, and the worktree removed.
 * Nothing here reaches a host.
 */
export function bundleCommands(inputs: Pick<Inputs, "workDir" | "signingKey">, rel: Pick<Release, "tag" | "version" | "commit">): string[][] {
  const dir = bundleDirOf(inputs, rel);
  const tree = join(dir, "tree");
  const site = join(dir, "site");
  return [
    ["rm", "-rf", tree, site],
    ["git", "worktree", "add", "--force", "--detach", tree, rel.commit],
    ["bun", "install", "--frozen-lockfile", "--cwd", tree],
    ["bash", join(tree, "scripts", "static-assembly.sh"), site],
    ["bun", join(tree, "scripts", "lib", "web-bundle.ts"), "pack", site, dir],
    ["bun", join(tree, "scripts", "lib", "web-bundle.ts"), "sign", bundlePathOf(inputs, rel), inputs.signingKey],
    ["git", "worktree", "remove", "--force", tree],
  ];
}

/** The packed bundle's sha256, read from its digest file; undefined unless the digest names the bundle and the signature exists. */
export function bundleDigest(inputs: Pick<Inputs, "workDir">, rel: Pick<Release, "tag" | "version" | "commit">, deps: Pick<Deps, "readFile">): string | undefined {
  const path = bundlePathOf(inputs, rel);
  const statement = deps.readFile(`${path}.sha256`);
  if (statement === undefined || deps.readFile(`${path}.sha256.sig`) === undefined) return undefined;
  const m = /^([0-9a-f]{64}) {2}(\S+)\n?$/.exec(statement);
  return m !== null && m[2] === bundleFileName({ version: rel.version, commit: rel.commit }) ? m[1] : undefined;
}

/** W03's done check: the gate passed and the signed bundle is packed. */
export function checkGate(rel: Release, inputs: Inputs, deps: Deps): StepResult {
  const gate = asCheck(readGate(rel, deps));
  if (gate.state !== "done") return gate;
  const digest = bundleDigest(inputs, rel, deps);
  return digest === undefined
    ? { state: "todo", detail: `${gate.detail}; the signed bundle is not packed yet (${bundlePathOf(inputs, rel)})` }
    : { state: "done", detail: `${gate.detail}; ${bundlePathOf(inputs, rel)} is signed, sha256 ${digest}` };
}

/** W03's write: the gate, then the bundle packed and signed on the control machine. */
export async function runGate(rel: Release, inputs: Inputs, deps: Deps, maxMinutes: number, id: string, rerun: string): Promise<StepResult> {
  const gate = await gateStep(rel, deps, maxMinutes, id, rerun);
  if (gate.state !== "done") return gate;
  for (const cmd of bundleCommands(inputs, rel)) {
    const r = deps.exec(cmd);
    if (r.status !== 0) return failed(`the gate passed, but packing the bundle failed: ${cmd.join(" ")} exited ${r.status}: ${errText(r)}`);
  }
  const digest = bundleDigest(inputs, rel, deps);
  if (digest === undefined) return failed(`the bundle commands ran, but ${bundlePathOf(inputs, rel)} has no digest naming it or no signature`);
  return { state: "done", detail: `${gate.detail}; packed and signed ${bundlePathOf(inputs, rel)}, sha256 ${digest}` };
}

/** The bundle's manifest, read from the tarball W03 packed (the live check compares every served file with it). */
export function bundleManifest(inputs: Pick<Inputs, "workDir">, rel: Pick<Release, "tag" | "version" | "commit">, deps: Pick<Deps, "readBytes">): BundleManifest | { error: string } {
  const path = bundlePathOf(inputs, rel);
  const bytes = deps.readBytes(path);
  if (bytes === undefined) return { error: `${path} is missing: W03 packs it` };
  try {
    const entry = readTar(gunzipSync(bytes)).find((f) => f.path === BUNDLE_MANIFEST_FILENAME);
    const manifest = entry === undefined ? null : parseBundleManifest(new TextDecoder().decode(entry.data));
    return manifest ?? { error: `${path} carries no valid ${BUNDLE_MANIFEST_FILENAME}` };
  } catch (e) {
    return { error: `${path} cannot be read: ${(e as Error).message}` };
  }
}

// ── W04 to W06: stage QA ─────────────────────────────────────────────────────
//
// Owner, 2026-11-11 (D81 amendment): "You already have the stage machine for
// doing QA as we do in the kitchen sink. Why would you use a different method
// when a good one exists?" Before any production step writes, the release runs
// on the kitchen-sink stage target (./stage-target.ts, docs/runbooks/
// stage-target.md): W04 brings it up at production's running commit from a
// fresh production dump (the kitchen sink's Q02-dump and Q03-stage-up) and
// deploys production's serving bundle there by name, so stage holds a previous
// image as production does; W05 sends this release's bundle with the same
// `bun smoke:web` W10 runs on production; W06 runs W11's live check against
// the stage origin. A pass is recorded for the bundle's digest and the stage
// target is torn down; W07 onward refuse to write without that record.

/** PURE. Where the runner records that stage QA passed for a release. */
export const stagePassPath = (inputs: Pick<Inputs, "workDir">, rel: Pick<Release, "tag">): string => join(inputs.workDir, `${rel.tag}-stage-pass.json`);

/** What the runner records when W06 passes. */
export interface StagePass {
  readonly commit: string;
  /** The sha256 of the bundle stage served: the one digest W07 onward accept. */
  readonly digest: string;
  readonly origin: string;
  readonly at: string;
  readonly summary: string;
}

/** The stage pass recorded for the release, whatever digest it names, or undefined. */
function recordedStagePass(rel: Release, inputs: Inputs, deps: Deps): StagePass | undefined {
  const text = deps.readFile(stagePassPath(inputs, rel));
  if (text === undefined) return undefined;
  try {
    const p = JSON.parse(text) as StagePass;
    return p.commit === rel.commit && typeof p.digest === "string" ? p : undefined;
  } catch {
    return undefined;
  }
}

/** The recorded stage pass for this release's bundle, or undefined. A pass for another commit or another digest does not count. */
export function stagePassed(rel: Release, inputs: Inputs, deps: Deps): StagePass | undefined {
  const p = recordedStagePass(rel, inputs, deps);
  const digest = bundleDigest(inputs, rel, deps);
  return p !== undefined && digest !== undefined && p.digest === digest ? p : undefined;
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

/**
 * PURE. W04's deploy of production's serving bundle to stage, by name, so stage holds a previous image
 * before W05's swap, as production will at W10. None while production serves no signed bundle (its first
 * rollout): W05's swap then keeps stage's nginx container, stopped, as <name>-first-rollout, the rollback
 * target, as production's W10 does (spec §4, issue 1632).
 */
export const stagePriorArgv = (inputs: Pick<Inputs, "stage">, rel: Pick<Release, "serving">): string[] | undefined =>
  rel.serving?.tag === undefined ? undefined : deployArgv(inputs.stage, rel.serving.tag);

/** W04's done check: stage QA already passed, or the stage stack runs production's API commit and serves production's bundle. */
export async function checkStageUp(rel: Release, inputs: Inputs, deps: Deps): Promise<StepResult> {
  const passed = stagePassed(rel, inputs, deps);
  if (passed !== undefined) return { state: "done", detail: `stage QA already passed for ${rel.tag}, sha256 ${passed.digest} (${passed.at})` };
  const api = await readApiVersion(inputs.stage, deps);
  if ("error" in api) return { state: "todo", detail: `the stage target is not up (${api.error}): bring it up from a fresh production dump` };
  if (api.body.commit !== rel.apiCommit) {
    return { state: "todo", detail: `the stage target runs ${String(api.body.commit).slice(0, 12)}, not production's API commit ${short(rel.apiCommit)}: rebuild it from a fresh production dump` };
  }
  const want = rel.serving?.tag;
  if (want === undefined) return { state: "done", detail: `the stage target runs production's API commit ${short(rel.apiCommit)}; production serves no signed bundle yet, so W05's swap keeps stage's nginx container as the rollback target` };
  const web = await readHostWeb(inputs.stage, deps);
  if ("error" in web) return failed(web.error);
  if (web.web.digest !== rel.serving?.digest) {
    return { state: "todo", detail: `stage serves ${web.web.tag ?? "no signed bundle"}, not production's ${want}: deploy ${want} there by name` };
  }
  return { state: "done", detail: `the stage target runs production's API commit ${short(rel.apiCommit)} and serves production's ${want}` };
}

/** W04's write: the stage target from a fresh production dump, at production's running commit, then production's serving bundle there by name. */
export async function runStageUp(rel: Release, inputs: Inputs, deps: Deps): Promise<StepResult> {
  const api = await readApiVersion(inputs.stage, deps);
  if ("error" in api || api.body.commit !== rel.apiCommit) {
    for (const cmd of STAGE_UP_COMMANDS) {
      deps.log(`[web-release] ${cmd.join(" ")} (the dump and the stage build take 15 to 45 minutes)`);
      const r = deps.exec(cmd as string[]);
      if (r.status !== 0) return failed(`${cmd.join(" ")} exited ${r.status}: ${errText(r)}`);
    }
  }
  const prior = stagePriorArgv(inputs, rel);
  if (prior !== undefined) {
    deps.log(`[web-release] ${prior.join(" ")} (production's serving bundle, so stage holds a previous image)`);
    const r = deps.exec(prior);
    if (r.status !== 0) return failed(`${prior.join(" ")} exited ${r.status}: ${errText(r)}`);
  }
  const after = await checkStageUp(rel, inputs, deps);
  return after.state === "done" ? after : failed(`after the stage build: ${after.detail}`);
}

/** W05's done check: stage QA already passed, or stage serves the bundle with W05's record of its api and workers. */
export async function checkStageDeploy(rel: Release, inputs: Inputs, deps: Deps): Promise<StepResult> {
  const passed = stagePassed(rel, inputs, deps);
  if (passed !== undefined) return { state: "done", detail: `stage QA already passed for ${rel.tag}, sha256 ${passed.digest} (${passed.at})` };
  return checkDeploy(rel, onStage(inputs), deps);
}

/** W05's write: the bundle to stage with `bun smoke:web`, exactly as W10 sends it to production. */
export async function runStageDeploy(rel: Release, inputs: Inputs, deps: Deps): Promise<StepResult> {
  return runDeploy(rel, onStage(inputs), deps);
}

/** W06's done check: a recorded stage pass for this bundle's digest. */
export function checkStageCheck(rel: Release, inputs: Inputs, deps: Deps): StepResult {
  const passed = stagePassed(rel, inputs, deps);
  return passed !== undefined
    ? { state: "done", detail: `stage QA passed for ${rel.tag}, sha256 ${passed.digest} (${passed.at}): ${passed.summary}` }
    : { state: "todo", detail: `stage QA has not passed for ${rel.tag}'s bundle${bundleDigest(inputs, rel, deps) === undefined ? "" : `, sha256 ${bundleDigest(inputs, rel, deps)}`}` };
}

/** W06's write: W11's live check against the stage origin; on a pass, record it for the digest and tear the stage target down. */
export async function runStageCheck(rel: Release, inputs: Inputs, deps: Deps): Promise<StepResult> {
  const s = inputs.stage;
  const digest = bundleDigest(inputs, rel, deps);
  if (digest === undefined) return failed(`${bundlePathOf(inputs, rel)} has no signed digest: W03 packs it`);
  const r = await liveResult(rel, onStage(inputs), deps);
  if (r.problems.length > 0) {
    return failed(`stage QA failed on ${s.publicOrigin}: ${r.problems.join("; ")}. Nothing reached production. The stage target is left up for inspection; ` +
      `fix the release on main and run again (stage-target.ts down removes it)`);
  }
  const pass: StagePass = { commit: rel.commit, digest, origin: s.publicOrigin, at: new Date(deps.clock()).toISOString(), summary: r.summary };
  deps.writeFile(stagePassPath(inputs, rel), `${JSON.stringify(pass, null, 2)}\n`);
  const down = deps.exec(STAGE_DOWN_COMMAND as string[]);
  if (down.status !== 0) {
    return failed(`stage QA passed and is recorded (${stagePassPath(inputs, rel)}), but ${STAGE_DOWN_COMMAND.join(" ")} exited ${down.status}: ${errText(down)}. Tear it down by hand; a rerun continues at W07`);
  }
  return { state: "done", detail: `stage QA passed on ${s.publicOrigin} for sha256 ${digest} (${r.summary}); recorded, and the stage target is torn down` };
}

/** PURE. Why a production step may not write: no stage pass is recorded for the release's bundle digest. */
export const stageGateProblem = (rel: Release, inputs: Inputs): string =>
  `stage QA (W04 to W06) has not passed for ${rel.tag}'s bundle: no production step writes before it does (${stagePassPath(inputs, rel)} is missing, or names another commit or another digest than ${bundlePathOf(inputs, rel)}.sha256)`;

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

// ── W09: host ready ──────────────────────────────────────────────────────────

/**
 * PURE. W09's one host command, read only: the server image's id, the allowed-signers file inside it, and
 * the instance's website-server (hostWebCommand). The `docker run` reads one file from the server image in
 * a throwaway container with no network. It runs no install, no build and no git on the host.
 */
export function hostReadyCommand(t: WebTarget): string {
  const server = envCommand(t, ["docker", "image", "inspect", "--format", "{{.Id}}", t.serverImage]);
  const signers = envCommand(t, ["docker", "run", "--rm", "--network", "none", "--entrypoint", "cat", t.serverImage, HOST_ALLOWED_SIGNERS]);
  return `{ if s=$(${server} 2>/dev/null); then printf 'server\\t%s\\n' "$s"; fi; } && { ${tagged("signers", `{ ${signers} 2>/dev/null || true; }`)}; } && ${hostWebCommand(t)}`;
}

/** PURE. What W09's output says is missing for a swap with a rollback target; empty when the host is ready. */
export function hostReadyProblems(t: WebTarget, stdout: string): string[] {
  const out: string[] = [];
  const server = stdout.split("\n").find((l) => l.startsWith("server\t"))?.slice("server\t".length);
  if (!server) out.push(`${t.host} holds no server image ${t.serverImage} (its platform release builds it)`);
  const signers = stdout.split("\n").filter((l) => l.startsWith("signers\t")).map((l) => l.slice("signers\t".length));
  if (server && !signers.some((l) => /namespaces="robotmoney-web-bundle@v1"/.test(l) && /\bssh-ed25519 \S+/.test(l))) {
    out.push(`${t.serverImage} on ${t.host} carries no allowed-signers line for the robotmoney-web-bundle@v1 namespace (${HOST_ALLOWED_SIGNERS})`);
  }
  const web = parseHostWeb(stdout);
  if ("error" in web) out.push(`${t.host}: ${web.error}`);
  else {
    const noTarget = rollbackTargetProblem(t, web.web);
    if (noTarget !== undefined) out.push(noTarget);
  }
  return out;
}

/** W09's check, which is its whole step: it writes nothing, so a host that is not ready fails it. */
export async function checkHostReady(t: WebTarget, deps: Deps): Promise<StepResult> {
  const r = await deps.ssh(t.host, hostReadyCommand(t));
  if (r.status !== 0) return failed(`ssh ${t.host} could not read its server image and website-server: ${errText(r)}`);
  const problems = hostReadyProblems(t, r.stdout);
  if (problems.length > 0) return failed(`${t.host} is not ready for the swap: ${problems.join("; ")}. W09 installs nothing: the platform release that runs there provides them`);
  const web = parseHostWeb(r.stdout);
  const serving = "web" in web ? (web.web.tag ?? web.web.image ?? "?") : "?";
  return { state: "done", detail: `${t.host} holds ${t.serverImage}, its allowed-signers file, and a rollback target (${serving} serves now)` };
}

// ── W10: deploy ──────────────────────────────────────────────────────────────

/** PURE. Where W10 (and W05, on stage) records what the target served beside the site before the deploy. */
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

/**
 * PURE-ish. Why W10 may not send the bundle to production: its digest is not the one stage passed. Read
 * just before the send, so a bundle repacked or replaced after W06 never reaches production.
 */
export function deployDigestProblem(rel: Release, inputs: Inputs, deps: Deps): string | undefined {
  const digest = bundleDigest(inputs, rel, deps);
  const pass = recordedStagePass(rel, inputs, deps);
  if (digest === undefined) return `${bundlePathOf(inputs, rel)} has no signed digest: W03 packs it`;
  if (pass === undefined) return stageGateProblem(rel, inputs);
  if (pass.digest !== digest) {
    return `refusing ${bundlePathOf(inputs, rel)}: its sha256 ${digest} is not the stage-passed sha256 ${pass.digest} (${stagePassPath(inputs, rel)}). ` +
      "Stage and production deploy the same bytes (R13): run W04 to W06 again for this bundle";
  }
  return undefined;
}

/** The deploy step's done check: the target serves the bundle (version.json and the container's digest label), and the record exists. */
export async function checkDeploy(rel: Release, inputs: Inputs, deps: Deps): Promise<StepResult> {
  const t = inputs.target;
  const live = await readLiveSite(t, deps);
  if ("error" in live) return { state: "todo", detail: `${live.error}: deploy ${rel.tag} on ${t.name}` };
  if (!liveIs(live, rel)) return { state: "todo", detail: `${t.publicOrigin} serves ${live.version}-${live.commit}: deploy ${rel.tag}` };
  const digest = bundleDigest(inputs, rel, deps);
  const web = await readHostWeb(t, deps);
  if ("error" in web) return failed(web.error);
  if (digest === undefined || web.web.digest !== digest) {
    return { state: "todo", detail: `${t.publicOrigin} names ${rel.tag}, but its website-server's bundle is sha256 ${web.web.digest ?? "(none)"}, not ${digest ?? "(no bundle packed)"}: deploy the bundle` };
  }
  if (readRecord(inputs, rel, deps) === undefined) {
    return failed(`${t.publicOrigin} already serves ${rel.tag}, but ${servingRecordPath(inputs, rel)} (the record of the api and workers) is missing, so the live check has nothing to compare: check the site by hand`);
  }
  return { state: "done", detail: `${t.publicOrigin} serves ${rel.tag}, sha256 ${digest}` };
}

/** The deploy step's write: record the api and worker containers and /api/version, then `bun smoke:web` with the bundle, from the control machine. */
export async function runDeploy(rel: Release, inputs: Inputs, deps: Deps): Promise<StepResult> {
  const t = inputs.target;
  const serving = await readServing(t, deps);
  if ("error" in serving) return failed(serving.error);
  deps.writeFile(servingRecordPath(inputs, rel), `${JSON.stringify(serving, null, 2)}\n`);
  const argv = deployArgv(t, bundlePathOf(inputs, rel));
  const r = deps.exec(argv);
  if (r.status !== 0) return failed(`${argv.join(" ")} exited ${r.status} (its receipt: ${join(imageReceiptDir(inputs, t), "receipt.json")}): ${errText(r)}`);
  return { state: "done", detail: `bun smoke:web swapped ${t.instance}'s website-server to ${rel.tag} on ${t.host}; api and workers recorded (${Object.keys(serving.containers).join(", ")})` };
}

// ── W11: live check ──────────────────────────────────────────────────────────
//
// W06 and W11 run the same check (web-serving-architecture.md §5.2), and W11
// rolls the site back on any failure:
//
//   1. {origin}/version.json names the release's version and commit;
//   2. the running website-server's labels name the bundle's tag, commit and
//      digest;
//   3. every file in the bundle's manifest is served through the origin with
//      the sha256 the manifest lists;
//   4. the header table (the platform's server config: the security headers on
//      every page, Cache-Control on pages and assets) holds through the origin,
//      unchanged by the web release;
//   5. every sitemap route answers 200;
//   6. the api and worker container ids and /api/version are unchanged;
//
// and that the running website-server's healthcheck, which the swap's
// container inherits from the one compose started (the overlay's run flags),
// reports healthy (issue 1630, the 1628 follow-up): W06 proves it on stage.

/** PURE. The URL a manifest path is served at: `index.html` at `/`, `<dir>/index.html` at `/<dir>` (the server's index fallback), any other file at its own path. */
export function manifestUrlPath(path: string): string {
  if (path === "index.html") return "/";
  if (path.endsWith("/index.html")) return `/${path.slice(0, -"/index.html".length)}`;
  return `/${path}`;
}

/** PURE. A URL path with each segment percent-encoded as a browser sends it. */
const encodePath = (p: string): string => p.split("/").map((s) => encodeURIComponent(s)).join("/");

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** PURE. Whether a URL path is an asset (a file extension other than .html), which the header table gives the asset Cache-Control. */
const isAssetPath = (path: string): boolean => /\.[a-z0-9]+$/i.test(path) && !/\.html$/i.test(path);

/**
 * PURE. Where an answer's headers differ from the platform's header table (web-serving-architecture.md
 * §3.3): every page carries the security headers and `Cache-Control: no-cache`; an asset carries the
 * asset Cache-Control. A missing header is a difference.
 */
export function headerProblems(path: string, headers: Readonly<Record<string, string>> | undefined): string[] {
  const got = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const want: Record<string, string> = isAssetPath(path) ? { "cache-control": WEBSITE_ASSET_CACHE } : { ...WEBSITE_SECURITY_HEADERS, "cache-control": WEBSITE_HTML_CACHE };
  return Object.entries(want).filter(([k, v]) => got[k] !== v).map(([k, v]) => `${path}: header ${k} is ${JSON.stringify(got[k] ?? null)}, not the platform's ${JSON.stringify(v)}`);
}

/** PURE. Where a running website-server's labels differ from the bundle's tag, commit and digest. */
export function labelProblems(t: Pick<WebTarget, "host" | "instance">, web: HostWeb, rel: Pick<Release, "tag" | "commit">, digest: string): string[] {
  const out: string[] = [];
  if (web.container === undefined) return [`no website-server runs for ${t.instance} on ${t.host}`];
  if (web.tag !== rel.tag) out.push(`the website-server's label ${WEBSITE_IMAGE_LABELS.tag} is ${web.tag ?? "(absent)"}, not ${rel.tag}`);
  if (web.commit !== rel.commit) out.push(`the website-server's label ${WEBSITE_IMAGE_LABELS.commit} is ${web.commit ?? "(absent)"}, not ${rel.commit}`);
  if (web.digest !== digest) out.push(`the website-server's label ${WEBSITE_IMAGE_LABELS.bundleSha256} is ${web.digest ?? "(absent)"}, not the bundle's ${digest}`);
  return out;
}

/** How long the live check waits for a swapped container's inherited healthcheck to leave `health: starting`. */
export const HEALTH_WAIT_MS = 90_000;
const HEALTH_POLL_MS = 5_000;

/** PURE. Why a container's status is not a passing inherited healthcheck: none ran, or it is unhealthy. Undefined when healthy; "starting" while it has not decided. */
export function healthProblem(status: string | undefined): string | "starting" | undefined {
  if (status === undefined) return "the website-server's status could not be read";
  if (/\(healthy\)/.test(status)) return undefined;
  if (/health: starting/.test(status)) return "starting";
  if (/\(unhealthy\)/.test(status)) return `the website-server's inherited healthcheck reports unhealthy (${status})`;
  return `the website-server runs with no healthcheck (${status}): the swap must keep the one compose gave it`;
}

/** The website-server once its inherited healthcheck has decided, polling while it is starting. */
async function settledHostWeb(t: WebTarget, deps: Deps): Promise<{ web: HostWeb } | { error: string }> {
  const deadline = deps.clock() + HEALTH_WAIT_MS;
  for (;;) {
    const web = await readHostWeb(t, deps);
    if ("error" in web || healthProblem(web.web.status) !== "starting" || deps.clock() >= deadline) return web;
    await deps.sleep(HEALTH_POLL_MS);
  }
}

/** Live check 3: every manifest file is served through the origin with its manifest sha256. Each URL carries a one-off query so no cache answers. */
export async function servedProblems(rel: Release, t: WebTarget, manifest: BundleManifest, deps: Deps): Promise<{ problems: string[]; compared: number }> {
  const problems: string[] = [];
  const bust = `rm-live-check=${short(rel.commit)}-${deps.clock()}`;
  let compared = 0;
  for (const f of manifest.files) {
    const url = manifestUrlPath(f.path);
    try {
      const got = await deps.httpBytes(`${t.publicOrigin}${encodePath(url)}?${bust}`);
      if (got.status !== 200) { problems.push(`GET ${url} answered ${got.status}, not the bundle's ${f.path}`); continue; }
      const sha = sha256(got.bytes);
      if (sha !== f.sha256) problems.push(`GET ${url} serves sha256 ${sha.slice(0, 16)}, not the manifest's ${f.path} (${f.sha256.slice(0, 16)})`);
      else compared++;
    } catch (e) {
      problems.push(`GET ${url} failed: ${(e as Error).message}`);
    }
  }
  return { problems, compared };
}

/** The sitemap's routes, or why it could not be read. */
async function sitemapRoutes(t: WebTarget, deps: Deps): Promise<{ routes: string[] } | { error: string }> {
  try {
    const sm = await deps.http(`${t.publicOrigin}/sitemap.xml`);
    if (sm.status !== 200) return { error: `GET ${t.publicOrigin}/sitemap.xml answered ${sm.status}` };
    const routes = [...sm.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].flatMap((m) => { try { const u = new URL(m[1]!); return [`${u.pathname}${u.search}`]; } catch { return []; } });
    if (routes.length === 0) return { error: `${t.publicOrigin}/sitemap.xml lists no route` };
    return { routes };
  } catch (e) {
    return { error: `GET ${t.publicOrigin}/sitemap.xml failed: ${(e as Error).message}` };
  }
}

/** PURE. The plan's lines for W06 and W11, from the bundle alone (no request). */
export function livePlanLines(manifest: BundleManifest | { error: string }): string[] {
  if ("error" in manifest) return [`served files: not planned (${manifest.error})`];
  return [
    `served files compared with the bundle's manifest: ${manifest.files.length}`,
    "labels compared with the bundle's tag, commit and digest; the header table checked on / and every sitemap route",
  ];
}

/** The dry run's plan for W06 and W11. */
export const livePlan = (rel: Release, inputs: Inputs, deps: Deps): string[] => livePlanLines(bundleManifest(inputs, rel, deps));

/** What the live check found: its problems, and what it checked when it passed. One W11 run judges the site once (runWebRelease hands this to runLive). */
export interface LiveResult {
  readonly problems: string[];
  readonly summary: string;
}

/** Every way the live site is not this bundle, served with the platform's headers beside an unchanged api: no problems when it is. */
export async function liveResult(rel: Release, inputs: Inputs, deps: Deps): Promise<LiveResult> {
  const t = inputs.target;
  const before = readRecord(inputs, rel, deps);
  if (before === undefined) return { problems: [`${servingRecordPath(inputs, rel)} (the deploy's record) is missing`], summary: "" };
  const out: string[] = [];
  // 1. version.json.
  const live = await readLiveSite(t, deps);
  if ("error" in live) out.push(live.error);
  else if (!liveIs(live, rel)) out.push(`${t.publicOrigin}/version.json reports ${live.version}-${live.commit}, not ${rel.version}-${short(rel.commit)}`);
  // A dry run reads no label and hashes no file, even when the deploy's record exists (a rerun after a deploy).
  if (inputs.dryRun) return { problems: [...out, "a dry run does not compare the served files"], summary: "" };
  // 2. The labels, and the inherited healthcheck.
  const digest = bundleDigest(inputs, rel, deps);
  const web = await settledHostWeb(t, deps);
  if ("error" in web) out.push(web.error);
  else {
    if (digest === undefined) out.push(`${bundlePathOf(inputs, rel)} has no signed digest`);
    else out.push(...labelProblems(t, web.web, rel, digest));
    const health = healthProblem(web.web.status);
    if (health === "starting") out.push(`the website-server's inherited healthcheck still reports starting after ${HEALTH_WAIT_MS / 1000} s (${web.web.status})`);
    else if (health !== undefined) out.push(health);
  }
  // 3. The served bytes against the manifest.
  const manifest = bundleManifest(inputs, rel, deps);
  let compared = 0;
  if ("error" in manifest) out.push(manifest.error);
  else {
    for (const l of livePlanLines(manifest)) deps.log(`[web-release] ${l}`);
    const served = await servedProblems(rel, t, manifest, deps);
    out.push(...served.problems);
    compared = served.compared;
  }
  // 4 and 5. The header table and the sitemap.
  const sm = await sitemapRoutes(t, deps);
  const routes = "routes" in sm ? sm.routes : [];
  if ("error" in sm) out.push(sm.error);
  for (const route of [...new Set(["/", ...routes])]) {
    try {
      const r = await deps.http(`${t.publicOrigin}${route}`);
      if (r.status !== 200) out.push(`GET ${route} answered ${r.status}`);
      out.push(...headerProblems(route, r.headers));
    } catch (e) {
      out.push(`GET ${route} failed: ${(e as Error).message}`);
    }
  }
  // 6. The backend.
  const now = await readServing(t, deps);
  if ("error" in now) out.push(now.error);
  else {
    if (JSON.stringify(now.containers) !== JSON.stringify(before.containers)) {
      out.push(`the api and worker containers changed: ${JSON.stringify(before.containers)} -> ${JSON.stringify(now.containers)}`);
    }
    if (now.apiVersion !== before.apiVersion) out.push(`/api/version changed: ${before.apiVersion} -> ${now.apiVersion}`);
  }
  const summary = `${t.publicOrigin} serves ${rel.tag} from a healthy website-server labelled sha256 ${digest}, ${compared} file(s) served as the manifest lists, ` +
    "the header table holds on / and every sitemap route (each 200), the api and workers are unchanged";
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
 * The live check: pass, or roll the site back with `bun smoke:web --rollback`
 * and fail. The tag stays. `judged` is the done check's result: the runner
 * judges the site once per W11, so a page never gets a second smoke to pass in.
 */
export async function runLive(rel: Release, inputs: Inputs, deps: Deps, judged?: LiveResult): Promise<StepResult> {
  const t = inputs.target;
  const { problems, summary } = judged ?? await liveResult(rel, inputs, deps);
  if (problems.length === 0) return { state: "done", detail: summary };
  const next = `${WEB_TAG_PREFIX}${nextPatch(rel.version)}`;
  deps.log(`[web-release] the live check failed: ${problems.join("; ")}; rolling back`);
  const argv = rollbackArgv(t);
  const r = deps.exec(argv);
  // Read back what production serves now, rather than trust the rollback's exit code.
  const after = await readLiveSite(t, deps);
  const serves = "error" in after ? `${t.publicOrigin}/version.json could not be read after it (${after.error})` : `${t.publicOrigin} now serves ${after.version}-${after.commit}`;
  const rolled = r.status === 0
    ? `rolled back (bun smoke:web --rollback: the previous image, or the first-rollout nginx container); ${serves}`
    : `THE ROLLBACK FAILED (exit ${r.status}: ${errText(r)}); ${serves}: run ${argv.join(" ")} from the control machine by hand`;
  return failed(`the live check failed: ${problems.join("; ")}. ${rolled}. ${rel.tag} stays where it is: ship the fix as ${next}`);
}

// ── W12: release ─────────────────────────────────────────────────────────────

/** PURE. The release notes: what the release is, its bundle, the commits it ships, and every changed content path. */
export function renderNotes(rel: Release, picks: readonly string[], digest?: string): string {
  const name = bundleFileName({ version: rel.version, commit: rel.commit });
  const out = [
    `## Web content release ${rel.tag}`, "",
    `- **Commit.** ${rel.commit} on \`${rel.branch}\`.`,
    `- **Bundle.** \`${name}\`, sha256 \`${digest ?? "?"}\`, with its digest (\`${name}.sha256\`) and its signature (\`${name}.sha256.sig\`, namespace \`robotmoney-web-bundle@v1\`) attached. Stage and production served these bytes.`,
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

/** PURE. The three files W12 attaches to the release: the bundle, its digest and its signature. */
export const releaseAssets = (inputs: Pick<Inputs, "workDir">, rel: Pick<Release, "tag" | "version" | "commit">): string[] => {
  const p = bundlePathOf(inputs, rel);
  return [p, `${p}.sha256`, `${p}.sha256.sig`];
};

/** W12's done check: the GitHub release exists and carries the bundle, its digest and its signature. */
export function checkReleaseStep(rel: Release, inputs: Inputs, deps: Deps): StepResult {
  const v = deps.gh(["release", "view", rel.tag, "--json", "tagName,assets"]);
  if (v.status !== 0) {
    if (/not found/i.test(v.stderr + v.stdout)) return { state: "todo", detail: `no GitHub release for ${rel.tag}: create it with the bundle, its digest and its signature` };
    return failed(`gh release view ${rel.tag} failed: ${errText(v)}`);
  }
  let names: string[] = [];
  try {
    names = ((JSON.parse(v.stdout) as { assets?: { name?: unknown }[] }).assets ?? []).map((a) => String(a.name));
  } catch {
    return failed(`gh release view ${rel.tag} gave no JSON`);
  }
  const missing = releaseAssets(inputs, rel).map((p) => p.slice(p.lastIndexOf("/") + 1)).filter((n) => !names.includes(n));
  if (missing.length > 0) return { state: "todo", detail: `the GitHub release ${rel.tag} lacks ${missing.join(", ")}: attach them` };
  return { state: "done", detail: `the GitHub release ${rel.tag} carries the bundle, its digest and its signature` };
}

/** W12's write: gh release create with the three files, never marked latest (the platform's release keeps that); an existing release gets the missing files. */
export function runReleaseStep(rel: Release, inputs: Inputs, deps: Deps): StepResult {
  const assets = releaseAssets(inputs, rel);
  if (deps.gh(["release", "view", rel.tag, "--json", "tagName"]).status === 0) {
    const u = deps.gh(["release", "upload", rel.tag, ...assets, "--clobber"]);
    if (u.status !== 0) return failed(`gh release upload ${rel.tag} failed: ${errText(u)}`);
    return { state: "done", detail: `attached the bundle, its digest and its signature to the GitHub release ${rel.tag}` };
  }
  const picks = inputs.commits.map((c) => {
    const s = deps.git(["log", "-1", "--format=%H %s", c]);
    return s.status === 0 ? s.stdout.trim() : c;
  });
  const path = join(inputs.workDir, `${rel.tag}-notes.md`);
  deps.writeFile(path, renderNotes(rel, picks, bundleDigest(inputs, rel, deps)));
  const c = deps.gh(["release", "create", rel.tag, ...assets, "--verify-tag", "--title", `web ${rel.version}`, "--notes-file", path, "--latest=false"]);
  if (c.status !== 0) return failed(`gh release create ${rel.tag} failed: ${errText(c)}`);
  return { state: "done", detail: `created the GitHub release ${rel.tag} with the bundle, its digest and its signature` };
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
  deps.log(servingLine(t, rel.serving));
  deps.log(`[${first!.id}] passed`);
  let live: LiveResult | undefined;
  for (const step of rest) {
    const check: StepResult =
      step.kind === "branch" ? checkBranch(rel, deps)
      : step.kind === "gate" ? checkGate(rel, inputs, deps)
      : step.kind === "stage-up" ? await checkStageUp(rel, inputs, deps)
      : step.kind === "stage-deploy" ? await checkStageDeploy(rel, inputs, deps)
      : step.kind === "stage-check" ? checkStageCheck(rel, inputs, deps)
      : step.kind === "tag" ? checkTagStep(rel, deps)
      : step.kind === "tag-guard" ? asCheck(readTagGuard(rel, deps))
      : step.kind === "host-ready" ? await checkHostReady(t, deps)
      : step.kind === "deploy" ? await checkDeploy(rel, inputs, deps)
      : step.kind === "live-check" ? liveState(live = await liveResult(rel, inputs, deps))
      : checkReleaseStep(rel, inputs, deps);
    if (check.state === "done") { deps.log(`[${step.id}] already done: ${check.detail}`); continue; }
    if (check.state === "failed") return stop(step.id, check.detail);
    const gated = PRODUCTION_KINDS.includes(step.kind) && stagePassed(rel, inputs, deps) === undefined;
    if (inputs.dryRun) {
      deps.log(`[${step.id}] not done${step.irreversible ? " (IRREVERSIBLE, would write)" : ""}: ${check.detail}${gated ? "; it refuses until stage QA passes for this bundle's digest" : ""}`);
      if (step.kind === "gate") for (const cmd of bundleCommands(inputs, rel)) deps.log(`[${step.id}] plan: ${cmd.join(" ")}`);
      if (step.kind === "stage-check" || step.kind === "live-check") {
        const at = step.kind === "stage-check" ? inputs.stage.publicOrigin : t.publicOrigin;
        deps.log(`[${step.id}] plan: version.json, the labels, the served files, the header table, every sitemap route and an unchanged api on ${at}`);
        for (const l of livePlan(rel, inputs, deps)) deps.log(`[${step.id}] plan: ${l}`);
      }
      continue;
    }
    // W10 names the digest it refuses: the bundle about to be sent against the one stage passed.
    if (step.kind === "deploy") {
      const refused = deployDigestProblem(rel, inputs, deps);
      if (refused !== undefined) return stop(step.id, refused);
    }
    if (gated) return stop(step.id, stageGateProblem(rel, inputs));
    const result: StepResult =
      step.kind === "branch" ? runBranch(rel, deps)
      : step.kind === "gate" ? await runGate(rel, inputs, deps, step.maxMinutes!, step.id, rerun)
      : step.kind === "stage-up" ? await runStageUp(rel, inputs, deps)
      : step.kind === "stage-deploy" ? await runStageDeploy(rel, inputs, deps)
      : step.kind === "stage-check" ? await runStageCheck(rel, inputs, deps)
      : step.kind === "tag" ? runTagStep(rel, deps)
      : step.kind === "tag-guard" ? await poll(() => readTagGuard(rel, deps), step.maxMinutes!, deps, step.id, rerun)
      : step.kind === "host-ready" ? check
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
