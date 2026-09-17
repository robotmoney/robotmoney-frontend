// The probe against COMMITTED evidence — the richer test rollout-probe-golden's
// header said could only exist once `repoRoot` became a parameter.
//
// The golden pins status derivation against receipts on a HOST. This pins it
// against receipts in a TREE, which is a different trust problem: a host-local
// receipts directory is written by whoever ran the step, while a committed one
// is written by whoever can open a pull request against a public repository. So
// the table below is mostly hostile input — a tampered receipt, an unsigned one,
// a garbage .sig, no allowed-signers file at all — and the assertion every row
// shares is that the probe grades it NO EVIDENCE and still exits 0. A verifier
// that crashed on a malformed signature would hand an attacker a denial of the
// state table at the moment an operator most needs it, and one that graded a
// bad signature as an absence would report the attack as innocence.
//
// It also pins the OPT-IN. v0.2.2 and v0.3.0 have already been executed; their
// evidence must keep resolving exactly where it did on the day it was written.
// The shipped-release cases below prove that by planting a perfectly valid
// committed receipt in the fabricated tree and asserting those releases do not
// see it — with a positive control on the same fixture, so the "missing" verdict
// is provably caused by the opt-out and not by a broken signature.
//
// Runs in the required `backend.yml` job. Real ssh-keygen keypairs and a real
// git repo in a mkdtemp dir: no network, no Docker, no database.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWhere } from "../scripts/lib/rollout-where.ts";
import type { WhereConfig } from "../scripts/lib/rollout-where.ts";
import {
  projectForCommit,
  receiptsDir,
  serialiseCommittedReceipt,
} from "../scripts/lib/rollout-receipt.ts";
import type { RolloutReceipt } from "../scripts/lib/rollout-receipt.ts";
import { EVIDENCE_DIR, signDetached } from "../scripts/lib/rollout-signing.ts";
import type { RolloutStep } from "../scripts/lib/rollout-manifest.ts";
import * as steps022 from "../scripts/upgrades/0.2.1-to-0.2.2/steps.ts";
import * as steps030 from "../scripts/upgrades/0.2.2-to-0.3.0/steps.ts";
import * as steps040 from "../scripts/upgrades/0.3.0-to-0.4.0/steps.ts";

const PRINCIPAL = "rollout-stage@test";
const RELEASE_DIR = "0.3.0-to-0.4.0";
const STEP_ID = "P4.preflight-live";

/**
 * An artifact-free, dependency-free step.
 *
 * Deliberately synthetic. Every non-derived step in a real manifest either
 * declares artifacts (absent from an empty $RM_BACKUP_DIR, so it grades
 * "artifact gone" before signature verification is ever reached) or requires an
 * earlier step (so it grades "blocked"). Either would mask the one axis this
 * file exists to test. The real manifests are exercised separately below.
 */
const STEP: RolloutStep = {
  id: STEP_ID,
  phase: "P4 preflight",
  section: "§3",
  title: "live database is safe to migrate",
  hostRole: "any",
  actor: "script",
  requires: [],
  dependsOn: [],
  verify: "bun preflight.ts --emit-receipt",
};

let root: string;
let repoRoot: string;
let backupDir: string;
let keyPath: string;
let allowedSigners: string;
let allowedSignersBody: string;
let savedReceiptsDirEnv: string | undefined;

function sh(cmd: string[], cwd?: string): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const dec = new TextDecoder();
  return { code: r.exitCode ?? -1, out: dec.decode(r.stdout), err: dec.decode(r.stderr) };
}

function receipt(over: Partial<RolloutReceipt> = {}): RolloutReceipt {
  return {
    step: STEP_ID,
    exit: 0,
    verdict: "SAFE TO UPGRADE",
    started_at: new Date(Date.now() - 120_000).toISOString(),
    at: new Date(Date.now() - 60_000).toISOString(),
    host: "rm-stage-1",
    host_role: "stage",
    repo_sha: "b".repeat(40),
    repo_branch: "releases-0.4.x",
    rc_tag: "v0.4.0-rc.3",
    repo_dirty: false,
    db: { server: "10.116.0.7", port: 25060, database: "defaultdb", user: "rm_readonly", in_recovery: true },
    artifacts: [],
    attested: false,
    ...over,
  };
}

/** Writes `<step>.json` and, unless told otherwise, its detached signature. */
function plant(
  releaseDir: string,
  r: RolloutReceipt,
  sig: "valid" | "none" | "garbage" | "empty" | "tamper-payload",
): void {
  const dir = join(repoRoot, EVIDENCE_DIR, releaseDir);
  mkdirSync(dir, { recursive: true });
  const payload = serialiseCommittedReceipt(projectForCommit(r));
  const jsonPath = join(dir, `${r.step}.json`);
  const sigPath = `${jsonPath}.sig`;
  const signature = signDetached(payload, keyPath);
  if (!signature) throw new Error("fixture could not sign — ssh-keygen unavailable");
  if (sig === "tamper-payload") {
    // Signature stays valid FOR THE ORIGINAL BYTES; the committed bytes change
    // by exactly one character. This is the on-disk shape of an edited receipt.
    writeFileSync(jsonPath, payload.replace('"exit": 0', '"exit": 9'));
    writeFileSync(sigPath, signature);
    return;
  }
  writeFileSync(jsonPath, payload);
  if (sig === "valid") writeFileSync(sigPath, signature);
  else if (sig === "garbage") writeFileSync(sigPath, "this is not an ssh signature\n");
  else if (sig === "empty") writeFileSync(sigPath, "");
  // "none": no .sig at all.
}

function clearEvidence(releaseDir: string): void {
  rmSync(join(repoRoot, EVIDENCE_DIR, releaseDir), { recursive: true, force: true });
}

interface ProbeStep {
  id: string;
  status: string;
  because: string;
  source: string | null;
  signer: string | null;
}
interface ProbeJson {
  release: { head_tag: string | null; head_tag_signer: string | null };
  evidence: { committed_dir: string; allowed_signers: string | null; rejected: Record<string, string> } | null;
  steps: ProbeStep[];
}

/**
 * Drives runWhere() in-process, `--json`, over the fabricated checkout.
 *
 * In-process rather than spawned so a THROW is visible as a throw rather than as
 * an exit code — "the probe never crashes" is half of what this file asserts,
 * and a subprocess would flatten it into the same non-zero exit as any other
 * failure.
 */
async function probe(cfg: Partial<WhereConfig> & { steps: RolloutStep[] }): Promise<{ exit: number; json: ProbeJson }> {
  const savedArgv = process.argv;
  const savedLog = console.log;
  const lines: string[] = [];
  process.argv = ["bun", "where", "--json", "--backup-dir", backupDir];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const exit = await runWhere({ repoRoot, tagGlob: "v0.4.0*", trackingIssue: 0, ...cfg });
    return { exit, json: JSON.parse(lines.join("\n")) as ProbeJson };
  } finally {
    process.argv = savedArgv;
    console.log = savedLog;
  }
}

function row(json: ProbeJson, id = STEP_ID): ProbeStep {
  const found = json.steps.find((s) => s.id === id);
  expect({ id, found: found !== undefined }).toEqual({ id, found: true });
  return found!;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rollout-repo-source-"));
  repoRoot = join(root, "checkout");
  backupDir = join(root, "backup");
  // An EMPTY backup dir, with an empty receipts dir inside it: the committed
  // tree is the only evidence in play, exactly as it is on a host that never ran
  // the step.
  mkdirSync(join(backupDir, "receipts"), { recursive: true });
  savedReceiptsDirEnv = process.env.ROLLOUT_RECEIPTS_DIR;
  process.env.ROLLOUT_RECEIPTS_DIR = join(backupDir, "receipts");

  keyPath = join(root, "stage");
  const kg = sh(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", PRINCIPAL, "-f", keyPath]);
  if (kg.code !== 0) throw new Error(`ssh-keygen unavailable: ${kg.err}`);
  const [type, blob] = readFileSync(`${keyPath}.pub`, "utf8").trim().split(/\s+/);

  // A fabricated checkout: a real git repo, so gitFacts()/changedSince() answer
  // against something the test owns rather than against the repository the suite
  // happens to be running in.
  mkdirSync(repoRoot, { recursive: true });
  const git = (...args: string[]) => {
    const r = sh(["git", ...args], repoRoot);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  };
  if (sh(["git", "init", "-q", repoRoot]).code !== 0) throw new Error("git init failed");
  git("config", "user.email", "rollout@invalid");
  git("config", "user.name", "rollout");
  writeFileSync(join(repoRoot, "README.md"), "fabricated checkout\n");
  git("add", "README.md");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "init");

  mkdirSync(join(repoRoot, EVIDENCE_DIR), { recursive: true });
  allowedSigners = join(repoRoot, EVIDENCE_DIR, "allowed-signers");
  allowedSignersBody = `${PRINCIPAL} ${type} ${blob}\n`;
  writeFileSync(allowedSigners, allowedSignersBody);
});

afterAll(() => {
  if (savedReceiptsDirEnv === undefined) delete process.env.ROLLOUT_RECEIPTS_DIR;
  else process.env.ROLLOUT_RECEIPTS_DIR = savedReceiptsDirEnv;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("committed receipts are believed only when their signature verifies", () => {
  test("a validly-signed committed receipt grades the step ok, and names its signer", async () => {
    clearEvidence(RELEASE_DIR);
    plant(RELEASE_DIR, receipt(), "valid");
    const { exit, json } = await probe({ steps: [STEP], committedEvidenceDir: RELEASE_DIR });
    const r = row(json);
    expect({ exit, status: r.status, source: r.source, signer: r.signer }).toEqual({
      exit: 0,
      status: "ok",
      source: "committed",
      signer: PRINCIPAL,
    });
    expect(json.evidence?.rejected).toEqual({});
  });

  // The whole hostile table, each row asserting the same two things: NO
  // EVIDENCE, and exit 0 without throwing.
  const REJECTED: [string, "none" | "garbage" | "empty" | "tamper-payload"][] = [
    ["the signature is broken by a one-character edit to the receipt", "tamper-payload"],
    ["the receipt is unsigned", "none"],
    ["the .sig is garbage", "garbage"],
    ["the .sig is empty", "empty"],
  ];
  for (const [name, sig] of REJECTED) {
    test(`${name} -> missing / "no evidence", exit 0`, async () => {
      clearEvidence(RELEASE_DIR);
      plant(RELEASE_DIR, receipt(), sig);
      const { exit, json } = await probe({ steps: [STEP], committedEvidenceDir: RELEASE_DIR });
      const r = row(json);
      expect({ name, exit, status: r.status, because: r.because, source: r.source }).toEqual({
        name,
        exit: 0,
        status: "missing",
        because: "no evidence",
        source: null,
      });
      // ...and the probe says WHY, rather than swallowing it.
      expect(Object.keys(json.evidence?.rejected ?? {})).toEqual([STEP_ID]);
    });
  }

  test("a missing allowed-signers file -> missing / \"no evidence\", exit 0", async () => {
    // The trust root is gone, so nothing can be trusted — including a signature
    // that is in every other way perfect.
    clearEvidence(RELEASE_DIR);
    plant(RELEASE_DIR, receipt(), "valid");
    rmSync(allowedSigners, { force: true });
    try {
      const { exit, json } = await probe({ steps: [STEP], committedEvidenceDir: RELEASE_DIR });
      const r = row(json);
      expect({ exit, status: r.status, because: r.because }).toEqual({
        exit: 0,
        status: "missing",
        because: "no evidence",
      });
      expect(json.evidence?.allowed_signers).toBeNull();
    } finally {
      writeFileSync(allowedSigners, allowedSignersBody);
    }
  });

  test("a signature by a key that is not listed -> missing / \"no evidence\"", async () => {
    clearEvidence(RELEASE_DIR);
    const stranger = join(root, "stranger");
    if (sh(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", stranger]).code !== 0) throw new Error("keygen failed");
    const dir = join(repoRoot, EVIDENCE_DIR, RELEASE_DIR);
    mkdirSync(dir, { recursive: true });
    const payload = serialiseCommittedReceipt(projectForCommit(receipt()));
    writeFileSync(join(dir, `${STEP_ID}.json`), payload);
    writeFileSync(join(dir, `${STEP_ID}.json.sig`), signDetached(payload, stranger)!);
    const { exit, json } = await probe({ steps: [STEP], committedEvidenceDir: RELEASE_DIR });
    const r = row(json);
    expect({ exit, status: r.status, because: r.because }).toEqual({ exit: 0, status: "missing", because: "no evidence" });
  });

  test("no committed receipt at all is \"no receipt\", NOT \"no evidence\"", async () => {
    // The distinction is the point: an absence is a step nobody has run; "no
    // evidence" is a step somebody claimed and could not prove.
    clearEvidence(RELEASE_DIR);
    const { exit, json } = await probe({ steps: [STEP], committedEvidenceDir: RELEASE_DIR });
    const r = row(json);
    expect({ exit, status: r.status, because: r.because }).toEqual({ exit: 0, status: "missing", because: "no receipt" });
  });

  test("host-local and committed receipts merge under the existing newest-wins rule", async () => {
    clearEvidence(RELEASE_DIR);
    const hostReceipts = join(backupDir, "receipts");
    const writeHostLocal = (at: string) =>
      writeFileSync(
        join(hostReceipts, `${STEP_ID}.json`),
        `${JSON.stringify(receipt({ at, verdict: "HOST LOCAL" }), null, 2)}\n`,
      );
    try {
      // Committed copy is NEWER -> committed wins.
      plant(RELEASE_DIR, receipt({ at: new Date(Date.now() - 60_000).toISOString() }), "valid");
      writeHostLocal(new Date(Date.now() - 600_000).toISOString());
      let json = (await probe({ steps: [STEP], committedEvidenceDir: RELEASE_DIR })).json;
      expect({ source: row(json).source, signer: row(json).signer }).toEqual({ source: "committed", signer: PRINCIPAL });

      // Host-local copy is NEWER -> host wins, and carries no signer.
      writeHostLocal(new Date().toISOString());
      json = (await probe({ steps: [STEP], committedEvidenceDir: RELEASE_DIR })).json;
      expect({ source: row(json).source, signer: row(json).signer }).toEqual({ source: "host", signer: null });
    } finally {
      rmSync(join(hostReceipts, `${STEP_ID}.json`), { force: true });
    }
  });
});

describe("the rc tag's signer is resolved and reported", () => {
  test("a tag signed by a listed key is reported; an unsigned tag reports no signer", async () => {
    clearEvidence(RELEASE_DIR);
    const git = (...args: string[]) => {
      const r = sh(["git", ...args], repoRoot);
      if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
    };
    git("-c", "gpg.format=ssh", "-c", `user.signingkey=${keyPath}.pub`, "tag", "-s", "-m", "rc", "v0.4.0-rc.7");
    try {
      const { json } = await probe({ steps: [STEP], committedEvidenceDir: RELEASE_DIR });
      expect({ tag: json.release.head_tag, signer: json.release.head_tag_signer }).toEqual({
        tag: "v0.4.0-rc.7",
        signer: PRINCIPAL,
      });
    } finally {
      git("tag", "-d", "v0.4.0-rc.7");
    }

    git("tag", "-a", "-m", "rc", "v0.4.0-rc.8");
    try {
      const { json } = await probe({ steps: [STEP], committedEvidenceDir: RELEASE_DIR });
      expect({ tag: json.release.head_tag, signer: json.release.head_tag_signer }).toEqual({
        tag: "v0.4.0-rc.8",
        signer: null,
      });
    } finally {
      git("tag", "-d", "v0.4.0-rc.8");
    }
  });

  test("REPORTED, never enforced: an unsigned tag still grades P2.rc-tag ok and exits 0", async () => {
    // Making the signer knowable is this change. Refusing to proceed when the
    // signer is wrong is a policy gate, and is deliberately somebody else's
    // issue — so an unsigned tag must not change any status.
    const rcTagStep: RolloutStep = {
      id: "P2.rc-tag", phase: "P2", section: "§1", title: "an RC tag points at HEAD",
      hostRole: "any", actor: "operator", requires: [], dependsOn: [], derived: true,
      verify: "git tag --points-at HEAD",
    };
    const git = (...args: string[]) => sh(["git", ...args], repoRoot);
    git("tag", "-a", "-m", "rc", "v0.4.0-rc.9");
    try {
      const { exit, json } = await probe({ steps: [rcTagStep], committedEvidenceDir: RELEASE_DIR });
      const r = row(json, "P2.rc-tag");
      expect({ exit, status: r.status, signer: json.release.head_tag_signer }).toEqual({
        exit: 0,
        status: "ok",
        signer: null,
      });
    } finally {
      git("tag", "-d", "v0.4.0-rc.9");
    }
  });
});

describe("shipped releases resolve their evidence exactly where they always did", () => {
  test("receiptsDir() is still $RM_BACKUP_DIR/receipts, byte for byte", () => {
    const saved = process.env.ROLLOUT_RECEIPTS_DIR;
    delete process.env.ROLLOUT_RECEIPTS_DIR;
    try {
      expect(receiptsDir("/srv/rm-backup-v040")).toBe(join("/srv/rm-backup-v040", "receipts"));
    } finally {
      if (saved === undefined) delete process.env.ROLLOUT_RECEIPTS_DIR;
      else process.env.ROLLOUT_RECEIPTS_DIR = saved;
    }
  });

  test("only 0.3.0-to-0.4.0 opts in — the two shipped manifests export no COMMITTED_EVIDENCE_DIR", () => {
    expect("COMMITTED_EVIDENCE_DIR" in steps022).toBe(false);
    expect("COMMITTED_EVIDENCE_DIR" in steps030).toBe(false);
    expect(steps040.COMMITTED_EVIDENCE_DIR).toBe(RELEASE_DIR);
  });

  test("v0.3.0's probe does not read the committed tree, even when a valid receipt is sitting in it", async () => {
    const id = "P1.phases-closed";
    clearEvidence("0.2.2-to-0.3.0");
    plant("0.2.2-to-0.3.0", receipt({ step: id, at: new Date().toISOString() }), "valid");

    // Opted out — which is how every already-executed release stays wired.
    const optedOut = await probe({ steps: steps030.STEPS, tagGlob: steps030.TAG_GLOB });
    expect({
      exit: optedOut.exit,
      status: row(optedOut.json, id).status,
      because: row(optedOut.json, id).because,
      evidence: optedOut.json.evidence,
    }).toEqual({ exit: 0, status: "missing", because: "no receipt", evidence: null });

    // POSITIVE CONTROL on the same fixture: the identical bytes DO grade ok once
    // a config opts in, so the verdict above is caused by the opt-out and not by
    // a fixture that never verified in the first place.
    const optedIn = await probe({
      steps: steps030.STEPS,
      tagGlob: steps030.TAG_GLOB,
      committedEvidenceDir: "0.2.2-to-0.3.0",
    });
    expect({ status: row(optedIn.json, id).status, signer: row(optedIn.json, id).signer }).toEqual({
      status: "ok",
      signer: PRINCIPAL,
    });
    clearEvidence("0.2.2-to-0.3.0");
  });
});
