// THE SAFETY NET FOR THE where.ts LIFT.
//
// where.ts is copied verbatim into every release directory and is about to be
// collapsed into one shared module. The lift is worthless if it changes what an
// operator is told, so this pins the ONE thing that must not move: for a fixed
// set of receipts and artifacts on disk, which status does each step get, and
// why.
//
// WHAT IS PINNED, AND WHAT DELIBERATELY IS NOT. The probe mixes two kinds of
// input: receipts and artifacts, which this test owns completely, and git/host
// facts, which it cannot own — `repoRoot` is resolved from where.ts's own file
// location, the branch and SHA move with every commit, and `deriveHostRole()`
// reads the repo-root `.env`, which is present on any machine that has run the
// stack and absent in CI. So the fixture drives the first kind and this test
// NORMALISES the second: ages, SHAs and drifted filenames become placeholders.
// A golden that pinned them would fail on the second machine that ran it, and
// the usual fix for that — loosening it until it passes — is how a safety net
// becomes decoration.
//
// The richer test, with an injected repoRoot and a fabricated git history, can
// only exist AFTER the lift makes repoRoot a parameter. This one has to work
// BEFORE, against the code as it stands, or it proves nothing about the move.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROBE = "scripts/upgrades/runbook.ts";
const STAMP = "20260101T000000Z";

let fixture: string;
let probe: { steps: { id: string; status: string; because: string }[]; next: string | null };

/**
 * A commit guaranteed to differ from HEAD in every path, on any checkout.
 *
 * The obvious choice — the root commit — is wrong, and wrong only off this
 * machine. `actions/checkout` clones at depth 1 by default, so in CI the repo
 * has exactly ONE commit: `rev-list --max-parents=0 HEAD` answers HEAD itself,
 * the receipt records the sha it is compared against, and the drift row comes
 * back `ok`. Green locally, and the one row this golden exists to hold gone
 * silently in CI.
 *
 * So the fixture owns the commit instead of borrowing one from history: an
 * empty tree, committed with `commit-tree`. It differs from HEAD in every path
 * by construction, and `changedSince()` resolves it — `cat-file -e` and `diff`
 * both read the object database, which has it because we just wrote it there,
 * with no ref and no history required. The identity and dates are pinned so
 * the object hashes the same every run: repeated runs reuse one dangling
 * object rather than accumulating one per run, and `git gc` reclaims it.
 */
function emptyTreeCommit(): string {
  const run = (args: string[]) => {
    const out = Bun.spawnSync(["git", ...args], {
      cwd: repoRoot,
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "rollout-probe-golden",
        GIT_AUTHOR_EMAIL: "rollout-probe-golden@invalid",
        GIT_COMMITTER_NAME: "rollout-probe-golden",
        GIT_COMMITTER_EMAIL: "rollout-probe-golden@invalid",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    });
    if (out.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr).trim()}`);
    }
    return new TextDecoder().decode(out.stdout).trim();
  };
  const emptyTree = run(["hash-object", "-t", "tree", "--stdin", "-w"]);
  return run(["commit-tree", emptyTree, "-m", "rollout-probe-golden drift fixture"]);
}
function headSha(): string {
  return new TextDecoder().decode(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout).trim();
}

function receipt(over: Record<string, unknown>): Record<string, unknown> {
  return {
    exit: 0,
    verdict: "OK",
    started_at: new Date(Date.now() - 60_000).toISOString(),
    at: new Date(Date.now() - 60_000).toISOString(),
    host: "fixture",
    host_role: "stage",
    repo_sha: headSha(),
    repo_branch: "fixture",
    rc_tag: null,
    repo_dirty: false,
    artifacts: [],
    attested: false,
    ...over,
  };
}

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), "rm-probe-golden-"));
  mkdirSync(join(fixture, "receipts"), { recursive: true });
  writeFileSync(join(fixture, ".last-stamp"), STAMP);

  // Artifacts the manifest expects. P3.baseline's is deliberately ABSENT so its
  // "artifact gone" branch fires; P3.schedules' is present so it can reach ok.
  writeFileSync(join(fixture, "rm-swarm-schedules-1.txt"), "schedules\n");
  writeFileSync(join(fixture, `rm-preupgrade-${STAMP}.dump.gpg`), "dump\n");
  writeFileSync(join(fixture, `rm-globals-${STAMP}.sql.gpg`), "globals\n");

  const put = (id: string, over: Record<string, unknown>) =>
    writeFileSync(join(fixture, "receipts", `${id}.json`), JSON.stringify(receipt({ step: id, ...over }), null, 2));

  put("P1.phases-closed", {});                                   // -> ok
  put("P1.config-decided", { exit: 1, verdict: "BLOCKED" });      // -> failed
  put("P3.baseline", {});                                         // -> missing (artifact gone)
  put("P3.schedules", {});                                        // -> ok (artifact present)
  put("P3.backup", {                                              // -> invalid (artifact changed)
    artifacts: [{ path: join(fixture, `rm-preupgrade-${STAMP}.dump.gpg`), sha256: "0".repeat(64), bytes: 5 }],
  });
  put("P3.gate-c", { repo_sha: "f".repeat(40) });                 // -> unverifiable
  put("P4.preflight-live", {                                      // -> expired (ttl 12h)
    at: new Date(Date.now() - 40 * 3600_000).toISOString(),
  });
  put("P4.postflight-dryrun", { repo_sha: emptyTreeCommit() });   // -> invalid (code drift)
  // Every other step gets no receipt at all -> missing ("no receipt").

  // Pin the release this golden was written for: runbook.ts auto-selects the
  // LATEST upgrade dir by string sort, so the v0.3.0 golden would silently
  // drift to the v0.4.0 step table the moment 0.3.0-to-0.4.0 lands.
  const run = Bun.spawnSync(["bun", PROBE, "--version", "0.2.2-to-0.3.0", "--json", "--backup-dir", fixture], {
    cwd: join(repoRoot, "backend"),
    env: { ...process.env, ROLLOUT_RECEIPTS_DIR: join(fixture, "receipts") },
  });
  const stdout = new TextDecoder().decode(run.stdout);
  if (run.exitCode !== 0) {
    throw new Error(`probe exited ${run.exitCode}: ${new TextDecoder().decode(run.stderr)}`);
  }
  probe = JSON.parse(stdout);
});

afterAll(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

/** Collapse everything that legitimately varies by machine, clock and commit. */
function normalise(because: string): string {
  return because
    .replace(/^changed since [^:]+: .*$/, "changed since <rc>: <files>")
    .replace(/\b\d+(?:\.\d+)?[smhd] ago\b/g, "<age>")
    .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>")
    .replace(new RegExp(fixture.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "<fixture>")
    .replace(/carries no v[\d.]+\* tag/, "carries no <tagglob> tag");
}

// The table. Any change to it in a diff is a change an operator would see.
const EXPECTED: [string, string, string][] = [
  ["P1.phases-closed", "ok", "<age>"],
  ["P1.config-decided", "failed", "exit 1 · BLOCKED · <age>"],
  ["P3.baseline", "missing", "artifact gone: pre-upgrade-baseline-*.txt"],
  ["P3.backup", "invalid", "artifact changed since the run: <fixture>/rm-preupgrade-20260101T000000Z.dump.gpg"],
  ["P3.schedules", "ok", "<age>"],
  ["P3.gate-c", "unverifiable", "<sha> is not in this checkout"],
  // 12h -> 2h: this step carries Gate E (blocking-xacts), a condition that goes
  // stale by the minute, and P7.cutover now requires it — so the short TTL is
  // what forces a fresh preflight immediately before the irreversible step.
  ["P4.preflight-live", "expired", "<age> · TTL 2h"],
  ["P4.postflight-dryrun", "invalid", "changed since <rc>: <files>"],
  ["P5.rehearsal-boot", "missing", "no receipt"],
  ["P5.postflight-smoke-twin", "missing", "no receipt"],
  ["P6.report", "missing", "no receipt"],
  ["P7.cutover", "missing", "no receipt"],
  ["P8.postflight-prod", "missing", "no receipt"],
  ["P8.acceptance", "missing", "no receipt"],
  ["P9.report", "missing", "no receipt"],
];

describe("where.ts probe — status derivation golden", () => {
  test.each(EXPECTED)("%s -> %s", (id, status, because) => {
    const row = probe.steps.find((s) => s.id === id);
    expect({ id, found: row !== undefined }).toEqual({ id, found: true });
    expect({ id, status: row!.status, because: normalise(row!.because) }).toEqual({ id, status, because });
  });

  // The two derived steps read git tags, which this fixture cannot control.
  // Their STATUS is therefore not pinned — but the fact that they are derived,
  // and never consult a receipt, is.
  test("the derived steps answer from git, not from receipts", () => {
    for (const id of ["P2.rc-tag", "P9.tag"]) {
      const row = probe.steps.find((s) => s.id === id);
      expect({ id, found: row !== undefined }).toEqual({ id, found: true });
      expect({ id, because: row!.because }).not.toEqual({ id, because: "no receipt" });
    }
  });

  // Guards the golden against going vacuous: if a future edit makes every row
  // "missing", the table above would still be internally consistent.
  test("the fixture exercises every status the probe can emit for this release", () => {
    const seen = new Set(EXPECTED.map(([, s]) => s));
    expect([...seen].sort()).toEqual(["expired", "failed", "invalid", "missing", "ok", "unverifiable"]);
  });

  test("`next` is the first step that is not ok", () => {
    expect(probe.next).toBe("P1.config-decided");
  });
});
