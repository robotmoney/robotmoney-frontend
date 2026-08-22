// The rollout position probe, once, for every release.
//
// This file was `upgrades/<from>-to-<to>/where.ts`, copied verbatim into each
// release directory: 423 lines, 97% identical between v0.2.2 and v0.3.0. The
// entire non-comment difference was ONE version literal used in three places —
// so ~420 lines of duplication were guarding a constant that release.ts already
// exports as TAG_GLOB.
//
// WHY IT WAS WORTH A SAFETY NET FIRST. This probe is what tells an operator
// mid-cutover which gates still count. A lift that quietly changed one status
// would be worse than the duplication it removed, so
// backend/tests/rollout-probe-golden.test.ts pinned the full status table —
// against the copies, before they moved — and the same table has to hold after.
//
// WHAT IS RELEASE-SPECIFIC, AND WHERE IT COMES FROM. Only `WhereConfig`: the
// manifest, the tag glob, the tracking issue, and the repo root. The three
// version literals are derived rather than restated:
//   - the rc-tag step names TAG_GLOB directly;
//   - the final tag is TAG_GLOB minus its trailing `*` (`v0.3.0*` -> `v0.3.0`);
//   - the runbook section that step cites is the step's own `section` field.
// All three used to be spelled out in the copy and could disagree with the
// manifest; none of them can now.
//
// `repoRoot` is a parameter rather than a resolution off `import.meta.url`,
// which is what lets a test drive this against a fabricated checkout — the
// richer test the golden's header says can only exist after this lift.
//
// SIDE-EFFECT FREE by default: no database connection, no network, no docker.
// Running it costs nothing and can never damage a rollout, which is what makes
// it safe to make the mandatory first step.
//
// Exit codes: 0 = printed (any state), 2 = could not run (bad step id, no git).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_BACKUP_DIR,
  changedSince,
  deriveHostRole,
  emitReceipt,
  gitFacts,
  readReceipts,
  receiptsDir,
  sha256File,
} from "./rollout-receipt.ts";
import type { RolloutReceipt } from "./rollout-receipt.ts";
import { stepById } from "./rollout-manifest.ts";
import type { RolloutStep } from "./rollout-manifest.ts";

/** Everything the probe needs to know about which release it is probing. */
export interface WhereConfig {
  /** Absolute path to the repo root. A parameter, not a derivation, so a test
   *  can point the probe at a checkout it built. */
  repoRoot: string;
  /** This release's step manifest, in display order. */
  steps: RolloutStep[];
  /** Selects this release's tags and no others, e.g. `v0.3.0*`. */
  tagGlob: string;
  /** The release tracking issue, echoed in `--json` for the caller. */
  trackingIssue: number;
}

type Status = "ok" | "expired" | "invalid" | "failed" | "missing" | "unverifiable" | "blocked";

interface Evaluated {
  step: RolloutStep;
  status: Status;
  /** Human-readable evidence line: what makes it this status. */
  because: string;
  /** false when this host cannot execute the step at all (rollout-procedure.md's host split). */
  runnableHere: boolean;
  receipt?: RolloutReceipt;
  /** Set on a `blocked` step: the requires that are not themselves `ok`. */
  blockedBy?: { id: string; status: Status }[];
  /** True when a blocker is RED rather than merely stale — drives the glyph. */
  redBlocked?: boolean;
}

const MARK: Record<Status, string> = {
  ok: "✔",
  expired: "⚠",
  invalid: "✖",
  failed: "✖",
  missing: "✖",
  unverifiable: "⚠",
  blocked: "⚠",
};

/** Which statuses are RED — a step that is wrong, as against one that is merely
 *  stale. The distinction is what keeps expiry "amber, never red" intact under
 *  propagation: a blocked step inherits its worst blocker's severity rather than
 *  escalating it. */
const RED: ReadonlySet<Status> = new Set<Status>(["invalid", "failed", "missing"]);

/**
 * Second pass: a step whose `requires` are not all satisfied is `blocked`.
 *
 * WHY THIS EXISTS. evaluate() grades every step in ISOLATION, and until this
 * function existed `requires` was decorative — read in exactly one place, as a
 * "held by" annotation on the NEXT line, and absent from --json entirely. The
 * consequence was not theoretical: v0.3.0's P3.gate-c expires at 48h, and every
 * step built on it read `✔` for as long as its own TTL lasted, so an expired
 * dump proof never reached the cutover decision by any path. A runbook's §3
 * calls its gates blocking; this is the code that makes them so.
 *
 * ONE FORWARD PASS SUFFICES because `requires` always point BACKWARDS in
 * manifest order — an invariant the per-release manifest tests enforce. Those
 * tests are load-bearing for this function, not merely tidy.
 *
 * A step's OWN complaint always wins: only a step that is otherwise `ok` can be
 * blocked. And `next` cannot move, because a blocker is always earlier in
 * manifest order and is itself not-ok, so the first not-ok row is at or before
 * any blocked row.
 */
function propagateBlocked(rows: Evaluated[]): Evaluated[] {
  const byId = new Map<string, Evaluated>();
  const out: Evaluated[] = [];
  for (const e of rows) {
    if (e.status !== "ok" || e.step.requires.length === 0) {
      byId.set(e.step.id, e);
      out.push(e);
      continue;
    }
    const blockers = e.step.requires
      .map((id) => byId.get(id))
      .filter((r): r is Evaluated => r !== undefined && r.status !== "ok");

    if (blockers.length === 0) {
      byId.set(e.step.id, e);
      out.push(e);
      continue;
    }
    // Severity is TRANSITIVE. A blocker whose own status is `blocked` carries
    // the severity of whatever blocked IT — otherwise a red cause two links up
    // fades to amber on the way down, and the chain that most needs to be loud
    // is the quietest.
    const redBlocked = blockers.some((r) => RED.has(r.status) || r.redBlocked === true);
    const next: Evaluated = {
      ...e,
      status: "blocked",
      blockedBy: blockers.map((r) => ({ id: r.step.id, status: r.status })),
      because: `requires ${blockers.map((r) => `${r.step.id} (${r.status})`).join(", ")}`,
      redBlocked,
    };
    byId.set(e.step.id, next);
    out.push(next);
  }
  return out;
}

/**
 * The bare release tag, from the glob that selects its rcs: `v0.3.0*` -> `v0.3.0`.
 *
 * Derived rather than configured because release.ts already exports TAG_GLOB,
 * and a second field naming the same version is a fact with two homes — the
 * exact bug the manifest header warns about. Anything not ending in `*` is
 * returned unchanged, so a release that spells its glob differently degrades to
 * "look for this literally" rather than to a silently truncated tag.
 */
export function releaseTag(tagGlob: string): string {
  return tagGlob.endsWith("*") ? tagGlob.slice(0, -1) : tagGlob;
}

function arg(name: string): string | undefined {
  const withEq = process.argv.find((a) => a.startsWith(`${name}=`));
  if (withEq) return withEq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function ageHours(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

function shortAge(iso: string): string {
  const h = ageHours(iso);
  if (h < 1) return `${Math.round(h * 60)}m ago`;
  if (h < 48) return `${h.toFixed(1)}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** `.last-stamp` — written by rollout-procedure.md §5.1, the key every backup artifact is named by. */
function lastStamp(backupDir: string): string | null {
  const f = join(backupDir, ".last-stamp");
  return existsSync(f) ? readFileSync(f, "utf8").trim() : null;
}

/** Resolves a step's declared artifact patterns against the backup directory.
 *  Existence here is authority: a receipt naming a file that is gone describes
 *  a step whose evidence no longer exists. */
function findArtifacts(step: RolloutStep, backupDir: string): { pattern: string; hit: string | null }[] {
  if (!step.artifacts?.length || !existsSync(backupDir)) {
    return (step.artifacts ?? []).map((pattern) => ({ pattern, hit: null }));
  }
  const stamp = lastStamp(backupDir);
  const entries = readdirSync(backupDir);
  return step.artifacts.map((pattern) => {
    const expanded = stamp ? pattern.replace("<STAMP>", stamp) : pattern;
    const glob = new Bun.Glob(expanded);
    // Newest match wins, so a re-run's artifact supersedes an older one.
    const hits = entries.filter((e) => glob.match(e)).sort();
    return { pattern: expanded, hit: hits.length ? join(backupDir, hits[hits.length - 1]!) : null };
  });
}

function matchesAny(file: string, globs: string[]): string | null {
  for (const g of globs) {
    if (new Bun.Glob(g).match(file)) return g;
  }
  return null;
}

function evaluate(step: RolloutStep, receipts: Map<string, RolloutReceipt>, ctx: Ctx): Evaluated {
  const runnableHere = step.hostRole === "any" || step.hostRole === ctx.hostRole;
  const base = { step, runnableHere };

  // Derived steps carry no receipt — git is the record.
  if (step.derived) {
    if (step.id === "P2.rc-tag") {
      return ctx.headTag
        ? { ...base, status: "ok", because: `${ctx.headTag} points at HEAD` }
        : { ...base, status: "missing", because: `HEAD (${ctx.sha.slice(0, 7)}) carries no ${ctx.tagGlob} tag` };
    }
    if (step.id === "P9.tag") {
      const tag = releaseTag(ctx.tagGlob);
      const exists = ctx.tags.includes(tag);
      return exists
        ? { ...base, status: "ok", because: `${tag} exists` }
        : { ...base, status: "missing", because: `${tag} not cut — correct until ${step.section} is clean` };
    }
  }

  const r = receipts.get(step.id);
  if (!r) return { ...base, status: "missing", because: "no receipt" };

  if (r.exit !== 0) {
    return { ...base, status: "failed", because: `exit ${r.exit} · ${r.verdict} · ${shortAge(r.at)}`, receipt: r };
  }

  // 1. Artifacts. Checked before anything else: no file, no evidence.
  for (const a of findArtifacts(step, ctx.backupDir)) {
    if (!a.hit) {
      return { ...base, status: "missing", because: `artifact gone: ${a.pattern}`, receipt: r };
    }
  }
  for (const recorded of r.artifacts) {
    const now = sha256File(recorded.path);
    if (!now) return { ...base, status: "missing", because: `artifact gone: ${recorded.path}`, receipt: r };
    if (now.sha256 !== recorded.sha256) {
      return { ...base, status: "invalid", because: `artifact changed since the run: ${recorded.path}`, receipt: r };
    }
  }

  // 2. A receipt written against the wrong kind of database is not what it says.
  if (r.db && step.expectInRecovery !== undefined && r.db.in_recovery !== step.expectInRecovery) {
    const wanted = step.expectInRecovery ? "the read replica" : "the primary";
    return {
      ...base,
      status: "invalid",
      because: `receipt records in_recovery=${r.db.in_recovery} on ${r.db.server}:${r.db.port} — that was not ${wanted}`,
      receipt: r,
    };
  }

  // 3. Code drift — the axis that makes a new rc answerable without redoing
  //    everything. Only the step's OWN declared inputs count.
  if (step.dependsOn.length > 0) {
    const diff = changedSince(ctx.repoRoot, r.repo_sha);
    if (!diff.known) {
      return { ...base, status: "unverifiable", because: `${r.repo_sha.slice(0, 7)} is not in this checkout`, receipt: r };
    }
    const hits = diff.files.map((f) => ({ f, g: matchesAny(f, step.dependsOn) })).filter((h) => h.g !== null);
    if (hits.length > 0) {
      const shown = hits.slice(0, 3).map((h) => h.f).join(", ");
      return {
        ...base,
        status: "invalid",
        because: `changed since ${r.rc_tag ?? r.repo_sha.slice(0, 7)}: ${shown}${hits.length > 3 ? ` +${hits.length - 3}` : ""}`,
        receipt: r,
      };
    }
  }

  // 4. Clock. Amber, never red: an expired step was right when it ran.
  if (step.ttlHours && ageHours(r.at) > step.ttlHours) {
    return { ...base, status: "expired", because: `${shortAge(r.at)} · TTL ${step.ttlHours}h`, receipt: r };
  }

  const carried = r.rc_tag && r.rc_tag !== ctx.headTag ? ` (carried from ${r.rc_tag})` : "";
  return {
    ...base,
    status: "ok",
    because: `${shortAge(r.at)}${r.attested ? " · attested" : ""}${carried}`,
    receipt: r,
  };
}

interface Ctx {
  /** Carried on the context so every derivation reads the same root the caller
   *  named, rather than re-resolving one from this file's own location. */
  repoRoot: string;
  tagGlob: string;
  hostRole: "stage" | "cutover";
  hostWhy: string;
  hostname: string;
  sha: string;
  branch: string;
  dirty: boolean;
  headTag: string | null;
  tags: string[];
  newestRc: { tag: string; sha: string } | null;
  commitsSinceRc: number;
  changedSinceRc: string[];
  backupDir: string;
  replica: string | null;
}

function git(repoRoot: string, args: string[]): string {
  return new TextDecoder().decode(Bun.spawnSync(["git", ...args], { cwd: repoRoot, stderr: "pipe" }).stdout).trim();
}

/** Read-only identity from .env.readonly — presence and target, never the
 *  password, and deliberately without connecting (see the header: this probe
 *  has no side effects). "configured" is an honest claim; "reachable" would
 *  not be. */
function replicaTarget(repoRoot: string): string | null {
  const f = join(repoRoot, ".env.readonly");
  if (!existsSync(f)) return null;
  const get = (k: string) =>
    readFileSync(f, "utf8").match(new RegExp(`^\\s*${k}\\s*=\\s*(.+)$`, "m"))?.[1]?.trim() ?? "?";
  return `${get("username")}@${get("host")}:${get("port")}/${get("database")}`;
}

function collectCtx(cfg: WhereConfig, backupDir: string): Ctx {
  const { repoRoot, tagGlob } = cfg;
  const host = deriveHostRole(repoRoot);
  const g = gitFacts(repoRoot, tagGlob);
  const tags = git(repoRoot, ["tag", "-l", tagGlob]).split("\n").filter(Boolean);
  // Highest rc by numeric suffix — string sort puts rc.10 before rc.6.
  const rcs = tags
    .map((t) => ({ tag: t, n: Number(t.match(/-rc\.(\d+)$/)?.[1] ?? NaN) }))
    .filter((t) => Number.isFinite(t.n))
    .sort((a, b) => a.n - b.n);
  const newest = rcs.length ? rcs[rcs.length - 1]! : null;
  const newestRc = newest ? { tag: newest.tag, sha: git(repoRoot, ["rev-list", "-n1", newest.tag]) } : null;
  const since = newestRc ? changedSince(repoRoot, newestRc.sha) : { known: false, files: [] };
  return {
    repoRoot,
    tagGlob,
    hostRole: host.role,
    hostWhy: host.why,
    hostname: new TextDecoder().decode(Bun.spawnSync(["hostname"]).stdout).trim(),
    sha: g.sha,
    branch: g.branch,
    dirty: g.dirty,
    headTag: g.tag,
    tags,
    newestRc,
    commitsSinceRc: newestRc ? Number(git(repoRoot, ["rev-list", "--count", `${newestRc.sha}..HEAD`]) || 0) : 0,
    changedSinceRc: since.files,
    backupDir,
    replica: replicaTarget(repoRoot),
  };
}

function printState(ctx: Ctx, rows: Evaluated[]): void {
  const p = (s: string) => console.log(s);
  p("");
  p(`HOST     ${ctx.hostname}${" ".repeat(Math.max(1, 22 - ctx.hostname.length))}role=${ctx.hostRole.toUpperCase()}`);
  p(`         ${ctx.hostWhy}`);
  p(`         replica: ${ctx.replica ?? "not configured (.env.readonly absent)"}`);
  p(`         receipts: ${receiptsDir(ctx.backupDir)}`);
  p("");
  p(`RELEASE  ${ctx.branch} @ ${ctx.sha.slice(0, 7)}${ctx.dirty ? "  ⚠ DIRTY TREE" : ""}`);
  // THE ONE LINE THE LIFT CHANGED, and it is deliberate. The two copies had
  // drifted apart here: v0.2.2's read "(none — §7.2 has not been run at this
  // commit)", v0.3.0's the release-agnostic wording below. Deriving the section
  // from the manifest — the trick that resolves the P9.tag literals — is wrong
  // here: v0.2.2's P2.rc-tag is filed at §7.2, but v0.3.0's is filed at §1, the
  // "read this first" section, which never cut a tag. So the neutral wording
  // wins, and v0.2.2's probe loses a pointer into docs/archive/v0-2-2-rollout.md
  // — a section reference in a runbook that has already been archived.
  p(`         HEAD tag: ${ctx.headTag ?? "(none — no rc cut at this commit)"}`);
  if (ctx.newestRc) {
    p(`         newest rc: ${ctx.newestRc.tag} = ${ctx.newestRc.sha.slice(0, 7)} · ${ctx.commitsSinceRc} commit(s) behind HEAD`);
  } else {
    p("         newest rc: (none)");
  }
  p("");
  let phase = "";
  for (const e of rows) {
    if (e.step.phase !== phase) {
      phase = e.step.phase;
      p(`  ${phase}`);
    }
    const blocked = !e.runnableHere && e.status !== "ok";
    const mark = blocked ? "⛔" : e.redBlocked ? "✖" : MARK[e.status];
    const id = e.step.id.padEnd(20);
    const title = e.step.title.length > 46 ? `${e.step.title.slice(0, 45)}…` : e.step.title.padEnd(46);
    const because = blocked ? `needs role=${e.step.hostRole} — ${e.because}` : e.because;
    p(`    ${mark} ${id} ${e.step.section.padEnd(6)} ${title}  ${because}`);
  }
  p("");

  const next = rows.find((e) => e.status !== "ok");
  if (!next) {
    p("NEXT     nothing outstanding — every step is complete and still valid.");
    p("");
    return;
  }
  const heldBy = next.step.requires.filter((req) => rows.find((r) => r.step.id === req)?.status !== "ok");
  p(`NEXT     ${next.step.id}  (${next.step.section})  ${next.step.title}`);
  if (heldBy.length) p(`         held by: ${heldBy.join(", ")}`);
  if (!next.runnableHere) {
    p(`         ⛔ NOT EXECUTABLE HERE — needs role=${next.step.hostRole}, this is role=${ctx.hostRole}.`);
    const doable = rows.filter((e) => e.status !== "ok" && e.runnableHere);
    p(
      doable.length
        ? `         still doable on this host: ${doable.map((e) => e.step.id).join(", ")}`
        : "         nothing further can be done on this host.",
    );
  } else {
    p(`         ${next.step.verify}`);
  }
  if (next.step.note) p(`         note: ${next.step.note}`);
  p("");
}

function record(cfg: WhereConfig, stepId: string, ctx: Ctx): number {
  const step = stepById(cfg.steps, stepId);
  if (!step) {
    console.error(`unknown step: ${stepId}`);
    console.error(`known steps: ${cfg.steps.map((s) => s.id).join(", ")}`);
    return 2;
  }
  if (step.derived) {
    console.error(`${stepId} is derived from git — it cannot be recorded, only performed.`);
    console.error(`  ${step.verify}`);
    return 2;
  }
  if (step.actor === "script") {
    console.error(`${stepId} is a script step — run it with --emit-receipt instead of attesting it:`);
    console.error(`  ${step.verify}`);
    return 2;
  }
  const artifactPaths = findArtifacts(step, ctx.backupDir)
    .map((a) => a.hit)
    .filter((h): h is string => h !== null);
  const missing = findArtifacts(step, ctx.backupDir).filter((a) => !a.hit);
  if (missing.length) {
    console.error(`refusing to record ${stepId}: declared artifact(s) not found in ${ctx.backupDir}:`);
    for (const m of missing) console.error(`  ${m.pattern}`);
    return 2;
  }
  const exit = Number(arg("--exit") ?? 0);
  const { path, receipt } = emitReceipt({
    step: stepId,
    exit,
    verdict: arg("--verdict") ?? (exit === 0 ? "attested by operator" : "attested FAILED"),
    startedAt: new Date().toISOString(),
    repoRoot: cfg.repoRoot,
    tagGlob: cfg.tagGlob,
    hostRole: ctx.hostRole,
    backupDir: ctx.backupDir,
    artifactPaths,
    attested: true,
    note: arg("--note"),
  });
  console.log(`recorded ${stepId} → ${path}`);
  console.log(`  sha ${receipt.repo_sha.slice(0, 7)}${receipt.rc_tag ? ` (${receipt.rc_tag})` : ""} · host ${receipt.host} · ${receipt.artifacts.length} artifact(s)`);
  if (receipt.repo_dirty) console.log("  ⚠ tree is dirty — this receipt does not describe a committed state");
  return 0;
}

/** The probe. Returns the process exit code; prints to stdout/stderr. */
export async function runWhere(cfg: WhereConfig): Promise<number> {
  const backupDir = arg("--backup-dir") ?? DEFAULT_BACKUP_DIR;
  const ctx = collectCtx(cfg, backupDir);
  if (!ctx.sha) {
    console.error("not a git checkout (or git unavailable) — this probe derives release identity from git");
    return 2;
  }

  const recordId = arg("--record");
  if (recordId) return record(cfg, recordId, ctx);

  const receipts = readReceipts(backupDir);
  const rows = propagateBlocked(cfg.steps.map((s) => evaluate(s, receipts, ctx)));

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          host: { name: ctx.hostname, role: ctx.hostRole, why: ctx.hostWhy, replica: ctx.replica },
          release: {
            branch: ctx.branch,
            sha: ctx.sha,
            dirty: ctx.dirty,
            head_tag: ctx.headTag,
            newest_rc: ctx.newestRc,
            commits_since_rc: ctx.commitsSinceRc,
            changed_since_rc: ctx.changedSinceRc,
          },
          steps: rows.map((e) => ({
            id: e.step.id,
            phase: e.step.phase,
            section: e.step.section,
            gate: e.step.gate ?? null,
            status: e.status,
            because: e.because,
            runnable_here: e.runnableHere,
            blocked_by: e.blockedBy ?? null,
            verify: e.step.verify,
          })),
          next: rows.find((e) => e.status !== "ok")?.step.id ?? null,
          tracking_issue: cfg.trackingIssue,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  printState(ctx, rows);
  return 0;
}

/**
 * The whole of a release's `where.ts`: wire the config in and run.
 *
 * Kept here so the per-release entry points stay a header comment plus a call,
 * and so the exit-code and fatal-error handling cannot drift between them.
 */
export function mainWhere(cfg: WhereConfig): void {
  runWhere(cfg)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(`[rollout-where] fatal: ${e instanceof Error ? e.message : e}`);
      process.exitCode = 2;
    });
}
