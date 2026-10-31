// scripts/release/sdk-release-lib.ts — the analyst SDK release runbook (D77,
// docs/technical/release-runbooks.md §11): its loader and validator, the
// planner, the six step kinds plus `cmd`, and the release-notes renderer.
//
// The runbook is ./runbooks/analyst-sdk.yaml; ./sdk-release.ts is the CLI. It
// keeps the platform runbook's conventions (Bun.YAML, step ids, `irreversible`,
// argv `cmds`, refusal of unknown keys) without the platform's phases, targets,
// hosts or go file, which an SDK release has none of (D77 (1)). The version and
// branch rule is scripts/check-analyst-sdk-tag.ts's checkTag, reused here.
//
// Every git and gh call goes through an injected Deps, so the unit tests run
// the steps against a gh stub and a local bare git origin. Each step has a
// read-only done check, so a rerun of the same command reports the steps
// already done and continues at the first that is not; `--dry-run` runs only
// the preflight and those checks and writes nothing.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTag, compareSemver, MANIFEST, RELEASE_BRANCH_GLOB, SEMVER, TAG_PREFIX } from "../check-analyst-sdk-tag.ts";

/** The committed SDK runbook. It sits outside templates/ and releases/, so ./runbook.ts never reads it. */
export const SDK_RUNBOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), "runbooks", "analyst-sdk.yaml");

/** The six built-in kinds, in the one order a runbook may hold them. */
export const BUILT_IN_KINDS = ["preflight", "branch", "gate", "tag", "tag-guard", "release"] as const;
export type BuiltInKind = (typeof BUILT_IN_KINDS)[number];
export type SdkStepKind = BuiltInKind | "cmd";

/** Whether each built-in kind writes to GitHub. A step's `irreversible` must say the same. */
const KIND_WRITES: Readonly<Record<BuiltInKind, boolean>> = Object.freeze({
  preflight: false, branch: true, gate: false, tag: true, "tag-guard": false, release: true,
});
/** The kinds that poll, and so carry `maxMinutes`. */
const POLLING_KINDS: readonly SdkStepKind[] = ["gate", "tag-guard"];

export interface SdkStep {
  readonly id: string;
  readonly kind: SdkStepKind;
  readonly description: string;
  readonly irreversible: boolean;
  /** gate and tag-guard: how long the step polls before it fails. */
  readonly maxMinutes?: number;
  /** cmd only: argv lists, with {version}, {commit}, {branch} and {tag} filled in. */
  readonly cmds?: readonly (readonly string[])[];
}

export interface SdkRunbook {
  readonly steps: readonly SdkStep[];
}

const TOP_KEYS = new Set(["runbook", "steps"]);
const STEP_KEYS = new Set(["id", "kind", "description", "irreversible", "maxMinutes", "cmds"]);
const ID_RE = /^S\d{2}-[a-z][a-z0-9-]*$/;
const KINDS: readonly SdkStepKind[] = [...BUILT_IN_KINDS, "cmd"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** PURE. The SDK runbook from its YAML text. Throws with every reason it is not one; each names its step. */
export function parseSdkRunbook(text: string): SdkRunbook {
  const doc = Bun.YAML.parse(text) as unknown;
  const errors: string[] = [];
  if (!isObject(doc)) throw new Error("analyst-sdk runbook: the file is a mapping with runbook and steps");
  for (const k of Object.keys(doc)) if (!TOP_KEYS.has(k)) errors.push(`analyst-sdk runbook: unknown key ${k}`);
  if (doc.runbook !== "analyst-sdk") errors.push("analyst-sdk runbook: runbook is analyst-sdk");
  if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
    errors.push("analyst-sdk runbook: steps is a non-empty list");
    throw new Error(errors.join("\n"));
  }
  const steps: SdkStep[] = [];
  const seen = new Set<string>();
  for (const raw of doc.steps as unknown[]) {
    if (!isObject(raw)) { errors.push("analyst-sdk runbook: a step is a mapping"); continue; }
    const at = typeof raw.id === "string" && raw.id !== "" ? raw.id : "(no id)";
    const before = errors.length;
    for (const k of Object.keys(raw)) if (!STEP_KEYS.has(k)) errors.push(`${at}: unknown key ${k}`);
    if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) errors.push(`${at}: id is S<two digits>-<name>`);
    else if (seen.has(raw.id)) errors.push(`${at}: duplicate id`);
    else seen.add(raw.id);
    const kind = raw.kind as SdkStepKind;
    if (!KINDS.includes(kind)) errors.push(`${at}: unknown kind ${String(raw.kind)} (one of ${KINDS.join(", ")})`);
    if (typeof raw.description !== "string" || raw.description.trim() === "") errors.push(`${at}: description is a non-empty string`);
    if (typeof raw.irreversible !== "boolean") errors.push(`${at}: irreversible is a boolean`);
    else if (kind === "cmd" && raw.irreversible) errors.push(`${at}: a cmd step has no done check, so it is read only: irreversible: false`);
    else if (kind !== "cmd" && KINDS.includes(kind) && raw.irreversible !== KIND_WRITES[kind as BuiltInKind]) {
      errors.push(`${at}: a ${kind} step is irreversible: ${KIND_WRITES[kind as BuiltInKind]}`);
    }
    if (POLLING_KINDS.includes(kind)) {
      if (!Number.isInteger(raw.maxMinutes) || (raw.maxMinutes as number) <= 0) errors.push(`${at}: a ${kind} step names maxMinutes, a positive integer`);
    } else if (raw.maxMinutes !== undefined) errors.push(`${at}: only a gate or tag-guard step carries maxMinutes`);
    if (kind === "cmd") {
      if (!Array.isArray(raw.cmds) || raw.cmds.length === 0 || !raw.cmds.every((c) => isStringArray(c) && c.length > 0)) {
        errors.push(`${at}: cmds is a non-empty list of argv lists`);
      }
    } else if (raw.cmds !== undefined) errors.push(`${at}: only a cmd step carries cmds`);
    if (errors.length > before) continue;
    const step: Record<string, unknown> = { id: raw.id, kind, description: raw.description, irreversible: raw.irreversible };
    if (raw.maxMinutes !== undefined) step.maxMinutes = raw.maxMinutes;
    if (raw.cmds !== undefined) step.cmds = raw.cmds;
    steps.push(step as unknown as SdkStep);
  }
  errors.push(...orderProblems(steps));
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return deepFreeze({ steps });
}

/** PURE. Why the built-in kinds are not each present once, preflight first, in BUILT_IN_KINDS order. */
function orderProblems(steps: readonly SdkStep[]): string[] {
  const out: string[] = [];
  const first = new Map<BuiltInKind, { id: string; at: number }>();
  steps.forEach((s, at) => {
    if (s.kind === "cmd") return;
    const prior = first.get(s.kind);
    if (prior) out.push(`${s.id}: a second ${s.kind} step (the first is ${prior.id})`);
    else first.set(s.kind, { id: s.id, at });
  });
  for (const k of BUILT_IN_KINDS) if (!first.has(k)) out.push(`analyst-sdk runbook: no ${k} step (kind: ${k})`);
  if (steps.length > 0 && steps[0]!.kind !== "preflight") out.push(`${steps[0]!.id}: the first step is the preflight step`);
  for (let i = 1; i < BUILT_IN_KINDS.length; i++) {
    const a = first.get(BUILT_IN_KINDS[i - 1]!);
    const b = first.get(BUILT_IN_KINDS[i]!);
    if (a && b && b.at < a.at) out.push(`${b.id}: the ${BUILT_IN_KINDS[i]} step sits before the ${BUILT_IN_KINDS[i - 1]} step ${a.id}`);
  }
  return out;
}

/** The committed SDK runbook, validated. */
export function loadSdkRunbook(path: string = SDK_RUNBOOK_PATH): SdkRunbook {
  return parseSdkRunbook(readFileSync(path, "utf8"));
}

// ── Deps and inputs ──────────────────────────────────────────────────────────

export interface ExecResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Everything the steps touch outside their own memory. The CLI binds real processes; the tests bind stubs. */
export interface Deps {
  git(args: string[]): ExecResult;
  gh(args: string[]): ExecResult;
  /** A cmd step's argv. */
  exec(argv: string[]): ExecResult;
  /** Milliseconds. */
  clock(): number;
  sleep(ms: number): Promise<void>;
  writeFile(path: string, text: string): void;
  log(line: string): void;
}

export interface Inputs {
  readonly version?: string;
  readonly commit?: string;
  readonly dryRun: boolean;
  /** The --notes-file path, for the rerun command. */
  readonly notesFile?: string;
  /** The --notes-file text, put before the change list. */
  readonly notesProse?: string;
  /** Where the rendered notes file is written. */
  readonly workDir: string;
}

/** What the preflight resolved: one release of the SDK. */
export interface Release {
  readonly version: string;
  readonly commit: string;
  readonly branch: string;
  readonly tag: string;
}

export type StepState = "done" | "todo" | "failed";
export interface StepResult {
  readonly state: StepState;
  readonly detail: string;
}

/** The analyst-sdk.yml and backend.yml jobs the gate reads, and the step whose success proves the backend's SDK proofs ran. */
export const PROOFS_STEP = "Analyst SDK proofs ran (issue 1404)";
export const GATE_RUNS: readonly { workflow: string; job: string; step?: string }[] = Object.freeze([
  { workflow: "analyst-sdk.yml", job: "analyst-sdk" },
  { workflow: "backend.yml", job: "backend", step: PROOFS_STEP },
]);
export const TAG_GUARD_WORKFLOW = "analyst-sdk-tag-guard.yml";
/** How long a polling step waits between reads. */
export const POLL_MS = 30_000;

const SDK_SRC = "packages/analyst-sdk/src";
const PLATFORM_TAG_RE = /^v\d+\.\d+\.\d+$/;

/** PURE. The release line's branch for a version: analyst-sdk/releases-A.B.x. */
export const releaseBranchOf = (version: string): string => `analyst-sdk/releases-${version.split(".").slice(0, 2).join(".")}.x`;

/** PURE. The rerun command for a run with these inputs (resolved values where the preflight found them). */
export function rerunCommand(inputs: Inputs, release?: Release): string {
  const parts = ["bun", "--no-env-file", "scripts/release/sdk-release.ts"];
  const version = release?.version ?? inputs.version;
  const commit = release?.commit ?? inputs.commit;
  if (version) parts.push("--version", version);
  if (commit) parts.push("--commit", commit);
  if (inputs.notesFile) parts.push("--notes-file", inputs.notesFile);
  return parts.join(" ");
}

const lines = (s: string): string[] => s.split("\n").map((l) => l.trim()).filter(Boolean);
const failed = (detail: string): StepResult => ({ state: "failed", detail });
const errText = (r: ExecResult): string => (r.stderr.trim() || r.stdout.trim() || `exit ${r.status}`);

/** The SDK version in packages/analyst-sdk/package.json at a revision, or undefined. */
function versionAt(deps: Deps, rev: string): string | undefined {
  const r = deps.git(["show", `${rev}:${MANIFEST}`]);
  if (r.status !== 0) return undefined;
  try {
    const v = (JSON.parse(r.stdout) as { version?: unknown }).version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The analyst-sdk-v* tags on origin, each with the commit it points at (peeled). Throws when origin cannot be read. */
export function remoteSdkTags(deps: Deps): Map<string, string> {
  const r = deps.git(["ls-remote", "--tags", "origin", `refs/tags/${TAG_PREFIX}*`]);
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

/** PURE. The A.B.C versions among SDK tag names. */
const sdkVersions = (tags: Iterable<string>): string[] =>
  [...tags].filter((t) => t.startsWith(TAG_PREFIX)).map((t) => t.slice(TAG_PREFIX.length)).filter((v) => SEMVER.test(v));

// ── S01: preflight ───────────────────────────────────────────────────────────

/** The preflight (read only): the release it resolves, or every reason it refuses. */
export function preflight(inputs: Inputs, deps: Deps): { release: Release } | { errors: string[] } {
  const fetch = deps.git(["fetch", "--quiet", "--tags", "origin", "+refs/heads/main:refs/remotes/origin/main", "+refs/heads/analyst-sdk/*:refs/remotes/origin/analyst-sdk/*"]);
  if (fetch.status !== 0) return { errors: [`git fetch origin failed: ${errText(fetch)}`] };
  const version = inputs.version ?? versionAt(deps, "origin/main");
  if (version === undefined) return { errors: [`no version: pass --version, or ${MANIFEST} at origin/main names none`] };
  const errors: string[] = [];
  if (!SEMVER.test(version)) errors.push(`version ${version} is not A.B.C`);
  const rev = deps.git(["rev-parse", "--verify", "--quiet", `${inputs.commit ?? "origin/main"}^{commit}`]);
  if (rev.status !== 0) return { errors: [...errors, `${inputs.commit ?? "origin/main"} is not a commit here`] };
  const commit = rev.stdout.trim();
  const onMain = deps.git(["merge-base", "--is-ancestor", commit, "origin/main"]);
  if (onMain.status !== 0) errors.push(`commit ${commit} is not on origin/main (§2: an SDK release branch is cut from main)`);
  const atCommit = versionAt(deps, commit);
  if (atCommit !== version) errors.push(`${MANIFEST} at ${commit.slice(0, 12)} says ${atCommit ?? "nothing"}, not ${version}`);
  const tag = `${TAG_PREFIX}${version}`;
  if (SEMVER.test(version)) {
    let tags: Map<string, string>;
    try {
      tags = remoteSdkTags(deps);
    } catch (e) {
      return { errors: [...errors, (e as Error).message] };
    }
    const resume = tags.get(tag) === commit;
    for (const v of sdkVersions(tags.keys())) {
      if (compareSemver(version, v) > 0) continue;
      if (v === version && resume) continue;
      errors.push(v === version
        ? `${tag} already exists at ${tags.get(tag)!.slice(0, 12)}, not at ${commit.slice(0, 12)}`
        : `version ${version} is not greater than the tag ${TAG_PREFIX}${v}`);
    }
  }
  const admin = deps.gh(["api", "repos/{owner}/{repo}", "--jq", ".permissions.admin"]);
  if (admin.status !== 0) errors.push(`gh api repos/{owner}/{repo} failed: ${errText(admin)}`);
  else if (admin.stdout.trim() !== "true") errors.push("the operator lacks the admin permission on the repository (the tag push needs it)");
  if (errors.length > 0) return { errors };
  return { release: { version, commit, branch: releaseBranchOf(version), tag } };
}

// ── S02: branch ──────────────────────────────────────────────────────────────

function remoteBranchTip(deps: Deps, branch: string): string | undefined {
  const r = deps.git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
  if (r.status !== 0) throw new Error(`git ls-remote origin ${branch} failed: ${errText(r)}`);
  return lines(r.stdout)[0]?.split(/\s+/)[0];
}

/** The branch step's done check: done when the remote tip is the commit; todo when absent or behind it. */
export function checkBranch(rel: Release, deps: Deps): StepResult {
  let tip: string | undefined;
  try {
    tip = remoteBranchTip(deps, rel.branch);
  } catch (e) {
    return failed((e as Error).message);
  }
  if (tip === undefined) return { state: "todo", detail: `origin/${rel.branch} is absent: create it at ${rel.commit}` };
  if (tip === rel.commit) return { state: "done", detail: `origin/${rel.branch} is at ${rel.commit}` };
  const f = deps.git(["fetch", "--quiet", "origin", `+refs/heads/${rel.branch}:refs/remotes/origin/${rel.branch}`]);
  if (f.status !== 0) return failed(`git fetch origin ${rel.branch} failed: ${errText(f)}`);
  const anc = deps.git(["merge-base", "--is-ancestor", tip, rel.commit]);
  if (anc.status === 0) return { state: "todo", detail: `origin/${rel.branch} is at ${tip}, an ancestor of ${rel.commit}: fast-forward it` };
  if (anc.status === 1) {
    return failed(`origin/${rel.branch} is at ${tip}, not an ancestor of ${rel.commit}: the runner only fast-forwards (no force push; a merge or cherry-pick goes by pull request)`);
  }
  return failed(`git merge-base --is-ancestor failed: ${errText(anc)}`);
}

/** The branch step's write: push the commit to the branch, never forced. */
export function runBranch(rel: Release, deps: Deps): StepResult {
  const p = deps.git(["push", "origin", `${rel.commit}:refs/heads/${rel.branch}`]);
  if (p.status !== 0) return failed(`git push origin ${rel.branch} failed: ${errText(p)}`);
  const f = deps.git(["fetch", "--quiet", "origin", `+refs/heads/${rel.branch}:refs/remotes/origin/${rel.branch}`]);
  if (f.status !== 0) return failed(`git fetch origin ${rel.branch} failed: ${errText(f)}`);
  return { state: "done", detail: `pushed ${rel.commit} to origin/${rel.branch}` };
}

// ── S03 and S05: the polled CI reads ─────────────────────────────────────────

type Read = { state: "pass" | "fail" | "wait"; detail: string };

interface RunRow { databaseId: number; headSha: string; status: string; conclusion: string }
interface JobRow { name: string; status: string; conclusion: string; steps?: { name: string; status: string; conclusion: string }[] }

/** One read of the newest push run of a workflow on a ref at the commit, and (when named) one job and one step of it. */
export function readRun(deps: Deps, workflow: string, ref: string, commit: string, job?: string, step?: string): Read {
  const l = deps.gh(["run", "list", "--workflow", workflow, "--branch", ref, "--commit", commit, "--event", "push", "--json", "databaseId,headSha,status,conclusion", "--limit", "1"]);
  if (l.status !== 0) return { state: "fail", detail: `gh run list --workflow ${workflow} failed: ${errText(l)}` };
  let runs: RunRow[];
  try {
    runs = JSON.parse(l.stdout) as RunRow[];
  } catch {
    return { state: "fail", detail: `gh run list --workflow ${workflow} gave no JSON` };
  }
  const run = runs[0];
  if (run === undefined) return { state: "wait", detail: `no push run of ${workflow} on ${ref} at ${commit.slice(0, 12)} yet` };
  if (run.headSha !== commit) return { state: "fail", detail: `${workflow} run ${run.databaseId} is at ${run.headSha}, not ${commit}` };
  if (run.status !== "completed") return { state: "wait", detail: `${workflow} run ${run.databaseId} is ${run.status}` };
  if (run.conclusion !== "success") return { state: "fail", detail: `${workflow} run ${run.databaseId} concluded ${run.conclusion}` };
  if (job === undefined) return { state: "pass", detail: `${workflow} run ${run.databaseId} concluded success` };
  const v = deps.gh(["run", "view", String(run.databaseId), "--json", "jobs"]);
  if (v.status !== 0) return { state: "fail", detail: `gh run view ${run.databaseId} failed: ${errText(v)}` };
  let jobs: JobRow[];
  try {
    jobs = (JSON.parse(v.stdout) as { jobs: JobRow[] }).jobs ?? [];
  } catch {
    return { state: "fail", detail: `gh run view ${run.databaseId} gave no JSON` };
  }
  const j = jobs.find((x) => x.name === job);
  if (j === undefined) return { state: "fail", detail: `${workflow} run ${run.databaseId} has no job ${job}` };
  // A skipped job leaves its run green, so only the job's own success counts.
  if (j.conclusion !== "success") return { state: "fail", detail: `${workflow} job ${job} concluded ${j.conclusion || j.status}, not success` };
  if (step !== undefined) {
    const s = (j.steps ?? []).find((x) => x.name === step);
    if (s === undefined) return { state: "fail", detail: `${workflow} job ${job} has no step '${step}'` };
    if (s.conclusion !== "success") return { state: "fail", detail: `${workflow} step '${step}' concluded ${s.conclusion || s.status}, not success` };
  }
  return { state: "pass", detail: `${workflow} job ${job}${step ? ` and step '${step}'` : ""} concluded success in run ${run.databaseId}` };
}

/** One read of the gate: every GATE_RUNS entry. A failure anywhere fails it; otherwise any wait waits. */
export function readGate(rel: Release, deps: Deps): Read {
  const reads = GATE_RUNS.map((g) => readRun(deps, g.workflow, rel.branch, rel.commit, g.job, g.step));
  const fail = reads.filter((r) => r.state === "fail");
  if (fail.length > 0) return { state: "fail", detail: fail.map((r) => r.detail).join("; ") };
  const wait = reads.filter((r) => r.state === "wait");
  if (wait.length > 0) return { state: "wait", detail: wait.map((r) => r.detail).join("; ") };
  return { state: "pass", detail: reads.map((r) => r.detail).join("; ") };
}

/** One read of the tag guard run for the tag at the commit. */
export const readTagGuard = (rel: Release, deps: Deps): Read => readRun(deps, TAG_GUARD_WORKFLOW, rel.tag, rel.commit);

/** A polled read as a done check: pass is done, wait is todo, fail is failed. */
const asCheck = (r: Read): StepResult => ({ state: r.state === "pass" ? "done" : r.state === "wait" ? "todo" : "failed", detail: r.detail });

/** Poll a read every POLL_MS until it passes or fails, or maxMinutes pass on the clock. */
export async function poll(read: () => Read, maxMinutes: number, deps: Deps, id: string, rerun: string): Promise<StepResult> {
  const start = deps.clock();
  for (;;) {
    const r = read();
    if (r.state === "pass") return { state: "done", detail: r.detail };
    if (r.state === "fail") return failed(r.detail);
    if (deps.clock() - start >= maxMinutes * 60_000) return failed(`still waiting after ${maxMinutes} minutes: ${r.detail}; rerun: ${rerun}`);
    deps.log(`[${id}] waiting: ${r.detail}`);
    await deps.sleep(POLL_MS);
  }
}

// ── S04: tag ─────────────────────────────────────────────────────────────────

/** The tag step's done check: done when the tag on origin points at the commit, failed when at another. */
export function checkTagStep(rel: Release, deps: Deps): StepResult {
  let tags: Map<string, string>;
  try {
    tags = remoteSdkTags(deps);
  } catch (e) {
    return failed((e as Error).message);
  }
  const at = tags.get(rel.tag);
  if (at === undefined) return { state: "todo", detail: `${rel.tag} is absent: tag ${rel.commit}` };
  if (at === rel.commit) return { state: "done", detail: `${rel.tag} is at ${rel.commit}` };
  return failed(`${rel.tag} exists at ${at}, not ${rel.commit}`);
}

/** The tag step's write: checkTag on the computed inputs, then the annotated tag, pushed. */
export function runTagStep(rel: Release, deps: Deps): StepResult {
  const f = deps.git(["fetch", "--quiet", "origin", "+refs/heads/analyst-sdk/*:refs/remotes/origin/analyst-sdk/*"]);
  if (f.status !== 0) return failed(`git fetch origin failed: ${errText(f)}`);
  const b = deps.git(["branch", "-r", "--list", RELEASE_BRANCH_GLOB, "--contains", rel.commit]);
  if (b.status !== 0) return failed(`git branch -r --contains ${rel.commit} failed: ${errText(b)}`);
  const reasons = checkTag({ tag: rel.tag, packageVersion: versionAt(deps, rel.commit) ?? "(none)", branchesContainingCommit: lines(b.stdout) });
  if (reasons.length > 0) return failed(`checkTag refuses ${rel.tag}: ${reasons.join("; ")}`);
  const local = deps.git(["rev-parse", "--verify", "--quiet", `refs/tags/${rel.tag}^{commit}`]);
  if (local.status === 0) {
    const type = deps.git(["cat-file", "-t", `refs/tags/${rel.tag}`]).stdout.trim();
    if (local.stdout.trim() !== rel.commit || type !== "tag") {
      return failed(`a local tag ${rel.tag} (${type} at ${local.stdout.trim()}) is not an annotated tag of ${rel.commit}: delete it with git tag -d ${rel.tag}`);
    }
  } else {
    const t = deps.git(["tag", "-a", rel.tag, rel.commit, "-m", `tag analyst SDK ${rel.version}`]);
    if (t.status !== 0) return failed(`git tag ${rel.tag} failed: ${errText(t)}`);
  }
  const p = deps.git(["push", "origin", `refs/tags/${rel.tag}`]);
  if (p.status !== 0) return failed(`git push origin ${rel.tag} failed: ${errText(p)}`);
  return { state: "done", detail: `pushed the annotated ${rel.tag} at ${rel.commit}` };
}

// ── S06: release ─────────────────────────────────────────────────────────────

/** The three D77 (3) items an SDK release's notes carry, each with the test that finds it. */
export const NOTES_ITEMS: readonly { item: number; what: string; has: (body: string) => boolean }[] = Object.freeze([
  { item: 1, what: "the archive format it reads (format 1)", has: (b: string) => b.includes("format 1") },
  { item: 2, what: "the replay statement (byte for byte, earlier payloads up to rounding)", has: (b: string) => b.includes("byte for byte") && b.includes("up to rounding") },
  { item: 3, what: "the matching platform tag, or that none matches", has: (b: string) => /platform tag/i.test(b) },
]);

export interface NotesInput {
  readonly version: string;
  readonly tag: string;
  /** The newest platform tag v* whose packages/analyst-sdk/src tree equals the commit's. */
  readonly platformTag?: string;
  /** The SDK tag before this one, which the change list starts after. */
  readonly previousTag?: string;
  /** Subjects of the commits touching packages/analyst-sdk since previousTag. */
  readonly changes: readonly string[];
  /** --notes-file prose, put before the change list. */
  readonly prose?: string;
}

export const NO_PLATFORM_MATCH = "No platform tag matches this release's analytics code yet.";

/** PURE. The release notes: the three D77 (3) items, any operator prose, the change list, the install block. */
export function renderNotes(n: NotesInput): string {
  const out: string[] = [];
  out.push("## What this release reads and replays", "");
  out.push("- **Archive format.** It reads archive format 1 (D72).");
  out.push("- **Replay.** It replays report payloads computed with its own arithmetic byte for byte. Payloads published before D78 replay up to rounding: the same structure, labels and nulls, with numbers that differ only in their last bits.");
  out.push(n.platformTag
    ? `- **Platform.** Its analytics code matches platform tag ${n.platformTag}: the two trees at ${SDK_SRC} are identical (D57).`
    : `- **Platform.** ${NO_PLATFORM_MATCH}`);
  out.push("");
  if (n.prose !== undefined && n.prose.trim() !== "") out.push(n.prose.trim(), "");
  out.push(`## Changes${n.previousTag ? ` since ${n.previousTag}` : ""}`, "");
  if (n.changes.length === 0) out.push("- (no commit touched packages/analyst-sdk)");
  for (const c of n.changes) out.push(`- ${c}`);
  out.push("", "## Install", "", "```sh");
  out.push(`git clone --branch ${n.tag} --depth 1 --filter=blob:none --sparse https://github.com/robotmoney/robotmoney-frontend.git`);
  out.push("cd robotmoney-frontend", "git sparse-checkout set packages/analyst-sdk", "```", "");
  return out.join("\n");
}

/** The newest platform tag vA.B.C whose packages/analyst-sdk/src tree equals the commit's, or undefined. */
export function matchingPlatformTag(deps: Deps, commit: string): string | undefined {
  const mine = deps.git(["rev-parse", "--verify", "--quiet", `${commit}:${SDK_SRC}`]);
  if (mine.status !== 0) return undefined;
  const tags = lines(deps.git(["tag", "--list", "v*"]).stdout).filter((t) => PLATFORM_TAG_RE.test(t));
  tags.sort((a, b) => compareSemver(b.slice(1), a.slice(1)));
  for (const t of tags) {
    const tree = deps.git(["rev-parse", "--verify", "--quiet", `refs/tags/${t}:${SDK_SRC}`]);
    if (tree.status === 0 && tree.stdout.trim() === mine.stdout.trim()) return t;
  }
  return undefined;
}

/** The release step's done check: done when the release exists with all three items; failed when one lacks an item (never edited). */
export function checkReleaseStep(rel: Release, deps: Deps): StepResult {
  const v = deps.gh(["release", "view", rel.tag, "--json", "body"]);
  if (v.status !== 0) {
    if (/not found/i.test(v.stderr + v.stdout)) return { state: "todo", detail: `no GitHub release for ${rel.tag}: create it` };
    return failed(`gh release view ${rel.tag} failed: ${errText(v)}`);
  }
  let body: string;
  try {
    body = String((JSON.parse(v.stdout) as { body?: unknown }).body ?? "");
  } catch {
    return failed(`gh release view ${rel.tag} gave no JSON`);
  }
  const missing = NOTES_ITEMS.filter((i) => !i.has(body));
  if (missing.length === 0) return { state: "done", detail: `the GitHub release ${rel.tag} exists with the three D77 (3) items` };
  return failed(`the GitHub release ${rel.tag} lacks ${missing.map((i) => `item ${i.item} (${i.what})`).join(", ")}; the runner never edits a release: fix its notes by hand`);
}

/** The release step's write: render the notes, then gh release create, --latest only for the highest SDK version. */
export function runReleaseStep(rel: Release, inputs: Inputs, deps: Deps): StepResult {
  let tags: Map<string, string>;
  try {
    tags = remoteSdkTags(deps);
  } catch (e) {
    return failed((e as Error).message);
  }
  const versions = sdkVersions(tags.keys());
  const earlier = versions.filter((v) => compareSemver(v, rel.version) < 0).sort(compareSemver);
  const previous = earlier.length > 0 ? `${TAG_PREFIX}${earlier[earlier.length - 1]}` : undefined;
  const latest = versions.every((v) => compareSemver(v, rel.version) <= 0);
  const log = deps.git(["log", "--format=%s", previous ? `refs/tags/${previous}..${rel.commit}` : rel.commit, "--", "packages/analyst-sdk"]);
  if (log.status !== 0) return failed(`git log since ${previous ?? "the start"} failed: ${errText(log)}`);
  const notes = renderNotes({
    version: rel.version, tag: rel.tag, platformTag: matchingPlatformTag(deps, rel.commit), previousTag: previous,
    changes: lines(log.stdout), prose: inputs.notesProse,
  });
  const path = join(inputs.workDir, `${rel.tag}-notes.md`);
  deps.writeFile(path, notes);
  const c = deps.gh(["release", "create", rel.tag, "--verify-tag", "--title", `analyst SDK ${rel.version}`, "--notes-file", path, latest ? "--latest" : "--latest=false"]);
  if (c.status !== 0) return failed(`gh release create ${rel.tag} failed: ${errText(c)}`);
  return { state: "done", detail: `created the GitHub release ${rel.tag}${latest ? " (latest)" : ""}` };
}

// ── cmd ──────────────────────────────────────────────────────────────────────

/** PURE. A cmd argv with {version}, {commit}, {branch} and {tag} filled in. */
export const fillArgv = (argv: readonly string[], rel: Release): string[] =>
  argv.map((a) => a.replace(/\{(version|commit|branch|tag)\}/g, (_, k: keyof Release) => rel[k]));

function runCmd(step: SdkStep, rel: Release, deps: Deps): StepResult {
  for (const argv of step.cmds ?? []) {
    const filled = fillArgv(argv, rel);
    const r = deps.exec(filled);
    if (r.status !== 0) return failed(`${filled.join(" ")} exited ${r.status}: ${errText(r)}`);
  }
  return { state: "done", detail: `ran ${(step.cmds ?? []).length} command(s)` };
}

// ── The runner ───────────────────────────────────────────────────────────────

/** PURE. The plan's lines: each step id with its kind and IRREVERSIBLE mark. */
export function planLines(runbook: SdkRunbook): string[] {
  const w = Math.max(...runbook.steps.map((s) => s.id.length));
  return runbook.steps.map((s) => `  ${s.id.padEnd(w)}  ${s.kind}${s.irreversible ? "  IRREVERSIBLE" : ""}`);
}

/** Run the runbook: print the plan, run the preflight, then each step's done check and (unless done or a dry run) its write. Returns the exit code. */
export async function runSdkRelease(runbook: SdkRunbook, inputs: Inputs, deps: Deps): Promise<number> {
  deps.log(`[sdk-release] analyst SDK release runbook, ${runbook.steps.length} steps${inputs.dryRun ? " (dry run: nothing is written)" : ""}`);
  for (const l of planLines(runbook)) deps.log(l);
  const [first, ...rest] = runbook.steps;
  const stop = (id: string, reason: string, rel?: Release): number => {
    deps.log(`[sdk-release] FAILED at ${id}: ${reason}`);
    deps.log(`[sdk-release] rerun: ${rerunCommand(inputs, rel)}`);
    return 1;
  };
  const pre = preflight(inputs, deps);
  if ("errors" in pre) return stop(first!.id, pre.errors.join("; "));
  const rel = pre.release;
  deps.log(`[sdk-release] version ${rel.version}, commit ${rel.commit}, branch ${rel.branch}, tag ${rel.tag}`);
  deps.log(`[${first!.id}] passed`);
  const rerun = rerunCommand(inputs, rel);
  for (const step of rest) {
    const check: StepResult =
      step.kind === "branch" ? checkBranch(rel, deps)
      : step.kind === "gate" ? asCheck(readGate(rel, deps))
      : step.kind === "tag" ? checkTagStep(rel, deps)
      : step.kind === "tag-guard" ? asCheck(readTagGuard(rel, deps))
      : step.kind === "release" ? checkReleaseStep(rel, deps)
      : { state: "todo", detail: `runs ${(step.cmds ?? []).map((c) => fillArgv(c, rel).join(" ")).join("; ")}` };
    if (check.state === "done") { deps.log(`[${step.id}] already done: ${check.detail}`); continue; }
    if (check.state === "failed") return stop(step.id, check.detail, rel);
    if (inputs.dryRun) { deps.log(`[${step.id}] not done${step.irreversible ? " (IRREVERSIBLE, would write)" : ""}: ${check.detail}`); continue; }
    const result: StepResult =
      step.kind === "branch" ? runBranch(rel, deps)
      : step.kind === "gate" ? await poll(() => readGate(rel, deps), step.maxMinutes!, deps, step.id, rerun)
      : step.kind === "tag" ? runTagStep(rel, deps)
      : step.kind === "tag-guard" ? await poll(() => readTagGuard(rel, deps), step.maxMinutes!, deps, step.id, rerun)
      : step.kind === "release" ? runReleaseStep(rel, inputs, deps)
      : runCmd(step, rel, deps);
    if (result.state !== "done") return stop(step.id, result.detail, rel);
    deps.log(`[${step.id}] done: ${result.detail}`);
  }
  deps.log(inputs.dryRun ? "[sdk-release] dry run complete: nothing was written" : `[sdk-release] ${rel.tag} released`);
  return 0;
}

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null) {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}
