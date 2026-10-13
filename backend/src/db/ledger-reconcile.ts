// Reconcile the migration ledger with the migration files: three deterministic
// read-only checks and one JSON receipt (smoke-production-spec.md §8.1, §8.4,
// §9.1; D55 (5), (8); D66).
//
// WHY A SET CHECK, AND NOT A PER-RELEASE CONSTANT. `schema_migrations.name` is
// the primary key (./migrate.ts), so the ledger is a set of filenames. The
// release preflight used to compare that set against a hard-coded list of the
// previous release's filenames (SUPPORTED_RELEASES) with an exact match, which
// refused every healthy production database after every release until someone
// retyped the constant, and never looked at the SQL bytes that ran. These
// checks need no constant: the repository's migrations directory is the only
// list, and the release tag production reports is the only source of the bytes.
//
// THE THREE CHECKS. None reads a 4-digit prefix or an `applied_at` order, so a
// file applied out of number order (0032 after 0033, 0061 after 0062, 0056 to
// 0062 after 0081 at the v0.6.0 cutover) and the fourteen grandfathered
// duplicate prefixes (§8.1) pass.
//   1. Ledger subset: every name in the ledger exists in the migrations
//      directory. A name the repository lacks is `ledger-not-subset`.
//   2. Pending set: pending is exactly the directory minus the ledger. When
//      the caller passes the list the release intends to apply and the two
//      differ, `unexpected-pending` names the difference.
//   3. Applied bytes: for each applied name, the sha256 of the file in the
//      checked-out directory equals the sha256 of the same path at the pin
//      ref. A difference is `bytes-differ`, carrying both hashes; a name
//      absent at the pin ref is `unpinned` (reported under `bytes-differ`:
//      the bytes the tag holds are not the bytes that ran).
//
// THE PIN REF. The database records no release tag (schema_migrations,
// deployment_identity and schema_manifest hold none), so the caller passes
// `--pin-ref <tag|commit>`: the version production reports. It is resolved with
// `git rev-parse --verify` in the checkout; an absent ref is
// `pin-ref-unresolved`, never a silent fallback. Checks 1 and 2 run without a
// pin ref; check 3 only with one.
//
// The checks are pure functions over lists and hash maps (`reconcile`); the
// runner (`runReconcile`) does the reads: the ledger through one SELECT, the
// directory, the hashes, git. Callers: `bun run reconcile` (../../scripts/
// reconcile.ts), `bun run migrate`'s precondition (../../scripts/migrate-run.ts),
// and the release preflight's R1.2 and R2.3 (scripts/release/).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { on, registerQuery, type RegistryDb } from "./registry.ts";

export type FileVerdict = "match" | "bytes-differ" | "unpinned";

export type ReconcileVerdict = "ok" | "ledger-not-subset" | "unexpected-pending" | "bytes-differ" | "pin-ref-unresolved";

/** One applied file's byte check against the pin ref. */
export interface PerFileVerdict {
  readonly name: string;
  /** sha256 of the file in the checked-out migrations directory. */
  readonly sha256: string;
  /** sha256 of the same path at the pin ref; `null` when the ref lacks it. */
  readonly pinSha256: string | null;
  readonly verdict: FileVerdict;
}

/** The receipt. Every field is present on every verdict. */
export interface ReconcileReceipt {
  readonly readAt: string;
  readonly migrationsDir: string;
  readonly pinRef: string | null;
  readonly pinCommit: string | null;
  readonly ledgerSize: number;
  readonly repoSize: number;
  /** The directory minus the ledger, in filename order. */
  readonly pending: readonly string[];
  /** Ledger names the directory lacks (check 1), in filename order. */
  readonly missingFromRepo: readonly string[];
  /** Files the caller intended to apply that are not pending, and pending files
   *  it did not intend (check 2). Empty when no intended list was given. */
  readonly unexpectedPending: readonly string[];
  /** One entry per applied name when a pin ref was resolved; empty otherwise. */
  readonly perFile: readonly PerFileVerdict[];
  readonly verdict: ReconcileVerdict;
}

/** Check 1, pure: ledger names the repository lacks. */
export function ledgerNotInRepo(ledger: readonly string[], repo: readonly string[]): string[] {
  const present = new Set(repo);
  return [...new Set(ledger.filter((name) => !present.has(name)))].sort();
}

/** Check 2, pure: the pending set, and its difference from the intended list. */
export function pendingSet(
  ledger: readonly string[],
  repo: readonly string[],
  intended?: readonly string[],
): { pending: string[]; unexpected: string[] } {
  const applied = new Set(ledger);
  const pending = [...new Set(repo.filter((name) => !applied.has(name)))].sort();
  if (intended === undefined) return { pending, unexpected: [] };
  const wanted = new Set(intended);
  const isPending = new Set(pending);
  const unexpected = [
    ...pending.filter((name) => !wanted.has(name)),
    ...intended.filter((name) => !isPending.has(name)),
  ];
  return { pending, unexpected: [...new Set(unexpected)].sort() };
}

/** Check 3, pure: each applied name's checkout hash against its hash at the pin. */
export function appliedBytes(
  ledger: readonly string[],
  checkout: ReadonlyMap<string, string>,
  pinned: ReadonlyMap<string, string>,
): PerFileVerdict[] {
  return [...new Set(ledger)].sort().flatMap((name) => {
    const sha256 = checkout.get(name);
    if (sha256 === undefined) return [];
    const pinSha256 = pinned.get(name) ?? null;
    const verdict: FileVerdict = pinSha256 === null ? "unpinned" : pinSha256 === sha256 ? "match" : "bytes-differ";
    return [{ name, sha256, pinSha256, verdict }];
  });
}

/** What the pure reconciliation reads. The runner fills it; a test builds it by hand. */
export interface ReconcileInput {
  readonly readAt: Date;
  readonly migrationsDir: string;
  readonly ledger: readonly string[];
  /** filename → sha256 of every .sql file in the checked-out migrations directory. */
  readonly checkout: ReadonlyMap<string, string>;
  /** The list the release intends to apply, when the caller has one. */
  readonly intended?: readonly string[];
  /** The pin, or `null` when the caller passed none. */
  readonly pin: { readonly ref: string; readonly commit: string | null; readonly files: ReadonlyMap<string, string> } | null;
}

/** The three checks over read inputs, and the one verdict. PURE. */
export function reconcile(input: ReconcileInput): ReconcileReceipt {
  const repo = [...input.checkout.keys()].sort();
  const missingFromRepo = ledgerNotInRepo(input.ledger, repo);
  const { pending, unexpected } = pendingSet(input.ledger, repo, input.intended);
  const pinResolved = input.pin !== null && input.pin.commit !== null;
  const perFile = pinResolved ? appliedBytes(input.ledger, input.checkout, input.pin!.files) : [];
  const verdict: ReconcileVerdict =
    missingFromRepo.length > 0
      ? "ledger-not-subset"
      : unexpected.length > 0
        ? "unexpected-pending"
        : input.pin !== null && input.pin.commit === null
          ? "pin-ref-unresolved"
          : perFile.some((f) => f.verdict !== "match")
            ? "bytes-differ"
            : "ok";
  return {
    readAt: input.readAt.toISOString(),
    migrationsDir: input.migrationsDir,
    pinRef: input.pin?.ref ?? null,
    pinCommit: input.pin?.commit ?? null,
    ledgerSize: new Set(input.ledger).size,
    repoSize: repo.length,
    pending,
    missingFromRepo,
    unexpectedPending: unexpected,
    perFile,
    verdict,
  };
}

/** One operator-readable line per verdict, naming the files. */
export function describeReconcile(receipt: ReconcileReceipt): string {
  switch (receipt.verdict) {
    case "ok":
      return `ledger ${receipt.ledgerSize} names, repository ${receipt.repoSize} files, pending ${receipt.pending.length}` +
        (receipt.pinCommit ? `, ${receipt.perFile.length} applied files match ${receipt.pinRef} (${receipt.pinCommit.slice(0, 12)})` : "");
    case "ledger-not-subset":
      return `the ledger records ${receipt.missingFromRepo.join(", ")}, which ${receipt.migrationsDir} does not contain`;
    case "unexpected-pending":
      return `the pending set (${receipt.pending.join(", ") || "none"}) is not the intended list; the difference is ${receipt.unexpectedPending.join(", ")}`;
    case "pin-ref-unresolved":
      return `--pin-ref ${receipt.pinRef} does not resolve in this checkout (git rev-parse --verify), and nothing is assumed in its place`;
    case "bytes-differ": {
      const differ = receipt.perFile.filter((f) => f.verdict === "bytes-differ").map((f) => `${f.name} (checkout ${f.sha256.slice(0, 12)}, ${receipt.pinRef} ${f.pinSha256!.slice(0, 12)})`);
      const unpinned = receipt.perFile.filter((f) => f.verdict === "unpinned").map((f) => f.name);
      return [
        ...(differ.length ? [`applied files whose bytes differ from ${receipt.pinRef}: ${differ.join(", ")}`] : []),
        ...(unpinned.length ? [`applied files absent at ${receipt.pinRef}: ${unpinned.join(", ")}`] : []),
      ].join("; ");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The runner: the reads
// ─────────────────────────────────────────────────────────────────────────────

export const LEDGER_SQL = "SELECT name FROM schema_migrations ORDER BY name";

// The one statement the runner issues, declared (spec §7.1): a SELECT on the
// ledger as rm_readonly, the role every caller connects with for this read.
const qReadLedger = registerQuery({
  role: "rm_readonly",
  object: "schema_migrations",
  privileges: ["SELECT"],
  site: "src/db/ledger-reconcile:readLedger",
  purpose: "Read the ledger of applied migration filenames, read-only, to reconcile it with the migrations directory (D66).",
  callers: ["scripts/reconcile", "scripts/migrate-run"],
  probe: { statement: LEDGER_SQL },
});

/** The ledger's filenames in filename order, through the registered read. */
export async function readLedgerNames(db: RegistryDb): Promise<string[]> {
  const rows = (await on(db, qReadLedger)<{ name: string }>`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[];
  return rows.map((r) => r.name);
}

/** sha256 of every .sql file in a directory, by filename. */
export function hashMigrationsDir(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    out.set(name, createHash("sha256").update(readFileSync(resolve(dir, name))).digest("hex"));
  }
  return out;
}

function git(cwd: string, args: readonly string[], stdin?: string): { code: number; out: Buffer } {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, out: Buffer.from(proc.stdout) };
}

/** `git rev-parse --verify <ref>^{commit}` in the checkout holding `migrationsDir`; `null` when it does not resolve. */
export function resolvePinRef(migrationsDir: string, ref: string): string | null {
  if (!/^[A-Za-z0-9._\/-]+$/.test(ref) || ref.startsWith("-")) return null;
  const r = git(migrationsDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const commit = r.out.toString("utf8").trim();
  return r.code === 0 && /^[0-9a-f]{40}$/.test(commit) ? commit : null;
}

/**
 * filename → sha256 of every .sql file under `migrationsDir`'s path at
 * `commit`. The path is the directory's path relative to the checkout's top
 * level, so a temp repository and the real one read the same way. Bytes come
 * out of `git cat-file --batch`, one process for the whole tree.
 */
export function hashMigrationsAtCommit(migrationsDir: string, commit: string): Map<string, string> {
  const top = git(migrationsDir, ["rev-parse", "--show-toplevel"]).out.toString("utf8").trim();
  const rel = relative(top, resolve(migrationsDir)).split("\\").join("/");
  // Pathspecs are relative to git's cwd, so the listing runs at the top level.
  const tree = git(top, ["ls-tree", "-z", commit, ...(rel === "" ? [] : [`${rel}/`])]).out.toString("utf8");
  const entries: { oid: string; name: string }[] = [];
  for (const line of tree.split("\0").filter(Boolean)) {
    const m = /^\d+ blob ([0-9a-f]{40})\t(.*)$/.exec(line);
    if (!m) continue;
    const name = m[2]!.slice(m[2]!.lastIndexOf("/") + 1);
    if (name.endsWith(".sql")) entries.push({ oid: m[1]!, name });
  }
  const out = new Map<string, string>();
  if (entries.length === 0) return out;
  const batch = git(migrationsDir, ["cat-file", "--batch"], `${entries.map((e) => e.oid).join("\n")}\n`).out;
  let at = 0;
  for (const entry of entries) {
    const nl = batch.indexOf(0x0a, at);
    const header = batch.subarray(at, nl).toString("utf8");
    const size = Number(header.split(" ")[2]);
    const bytes = batch.subarray(nl + 1, nl + 1 + size);
    out.set(entry.name, createHash("sha256").update(bytes).digest("hex"));
    at = nl + 1 + size + 1;
  }
  return out;
}

export interface RunReconcileInput {
  readonly migrationsDir: string;
  /** The read-only session the one SELECT runs on (`rm_readonly`). */
  readonly db: RegistryDb;
  readonly pinRef?: string;
  readonly intended?: readonly string[];
  readonly now?: () => Date;
}

/** The runner: one SELECT, the directory, the hashes, git, then `reconcile`. Read-only. */
export async function runReconcile(input: RunReconcileInput): Promise<ReconcileReceipt> {
  const readAt = (input.now ?? (() => new Date()))();
  const ledger = await readLedgerNames(input.db);
  const migrationsDir = resolve(input.migrationsDir);
  const checkout = hashMigrationsDir(migrationsDir);
  let pin: ReconcileInput["pin"] = null;
  if (input.pinRef !== undefined) {
    const commit = resolvePinRef(migrationsDir, input.pinRef);
    pin = { ref: input.pinRef, commit, files: commit === null ? new Map() : hashMigrationsAtCommit(migrationsDir, commit) };
  }
  return reconcile({ readAt, migrationsDir, ledger, checkout, ...(input.intended ? { intended: input.intended } : {}), pin });
}
