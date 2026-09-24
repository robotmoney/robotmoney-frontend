// `--spoof-keys [names]` — fresh keypairs for named in-house members so a
// production-shaped database can be driven without real keys
// (smoke-production-spec.md §6.4, issue #1026 W3.5). The types, the four
// guards, the four-step order and the recovery argument below are the design;
// the bodies implement it.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// It exists for TWINS. A twin is a production-shaped database restored from a
// `pg_dump` and used for rehearsal (spec §5). Its `swarm_members` rows carry
// the real members' real public keys, and nobody holds the matching private
// keys — correctly so, since those live in the production host's
// `credential.json` and nowhere else (spec §3, §6.1). A twin with real public
// keys therefore cannot run a session at all: every submission would be
// signed by a key the database does not know. Spoofing rebinds the named
// members to keypairs this run generates, so the rehearsal exercises the real
// code path with disposable identities.
//
// ── WHAT BREAKS WITHOUT IT ──────────────────────────────────────────────────
// Rehearsal on a production-shaped database becomes impossible, and the only
// remaining option is rehearsing against a blank database — which is exactly
// the class of rehearsal that has historically missed production-only defects,
// because blank databases have no history, no drift, and no seated members.
//
// ── THIS IS RECOVERABLE, NOT ATOMIC. HERE IS WHY THAT IS SAFE ───────────────
// The order (spec §6.4) is:
//
//   (1) write the generation to an INSTANCE-SCOPED file in the state
//       directory — `instancePaths(stateRoot, instance).spoofGenerationFile`
//       (smoke-state.ts), computed HERE and never supplied by the caller — and
//       never the `RM_CREDENTIALS` path; paths naming the same file refuse,
//       however they are spelled;
//   (2) rebind every named member's key in ONE fenced transaction, keyed by
//       MEMBER ID (not by name: names are display handles and two members can
//       share one after an onboarding, while the id is what the signature
//       check resolves);
//   (3) stop every running participant holding an OLDER generation;
//   (4) start them from the new file.
//
// There is no way to make (2) and (4) one atomic act: (2) is a database
// transaction and (4) is a container lifecycle operation, and no transaction
// spans both. So the design does not pretend to. Between (2) and (4) a
// container may still hold the old private key. It will sign with it, the
// server will resolve the member's CURRENT public key, verification will fail,
// and the submission is REFUSED. The worst case in the tolerated window is
// therefore a refused take on a rehearsal database — a visible, logged,
// harmless outcome. It is emphatically NOT a forged take: a superseded key
// never verifies, which is the property that makes the window safe rather than
// merely short.
//
// Recovery is a rerun. Step (1) persisted the generation, so a rerun after a
// crash reads it back, finds the database ALREADY at that generation, skips
// (1) and (2), and performs only (3) and (4). That is why the generation is
// written BEFORE the rebind rather than after: a generation written after a
// crashed rebind would leave the database holding keys no file records, and
// the members would be permanently unusable.
//
// Historical verification keys are preserved (spec §6.4): rebinding sets the
// member's current key, it does not delete the key history that past
// judgements and takes were verified against, so old receipts stay verifiable.
//
// Each spoofed member also gets a fresh BEARER (spec §6.4 "keypairs and bearer
// tokens"): a keypair alone cannot drive a twin, because the member's real
// bearer is as absent from the twin's host as its private key. The bearer is
// minted with the keypair in step (1), persisted in the same file, and issued
// server-side inside the same fenced transaction as the key in step (2).
//
// ── ROSTER PRECEDENCE (spec §6.4, D52) ──────────────────────────────────────
// While a generation exists for an instance, a later PLAIN boot must keep the
// spoofed members on the keys the database now accepts. `effectiveRoster`
// replaces those members' key and bearer from the generation file; without
// it, the next boot would read `RM_CREDENTIALS`, start them on keys the
// database no longer holds, and every one of their takes would be refused.
//
// ── GOVERNING SPEC SECTIONS ─────────────────────────────────────────────────
// §6.4 (this module in full), §2 (the fence — the rebind transaction takes
// `pg_advisory_xact_lock` on the same key as every other mutation), §4.3
// (rehearsal-only preparation), §6.1 (the credential path this must never
// collide with), §10 W3 (gates).
//
// ── WHAT THIS MODULE MUST NOT DO ────────────────────────────────────────────
// It never writes the `RM_CREDENTIALS` path — an equal path is a refusal, not
// an overwrite, because overwriting it on a mistargeted run would destroy the
// only copy of a host's real participant keys. It never runs on production:
// four independent guards below each refuse on their own.
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { instancePaths } from "../smoke-state.ts";
import type { PersonaIdentity } from "./persona-keys.ts";
import type { RunningParticipant } from "./credential-file.ts";

/**
 * One generated identity plus the member id it is bound to. The id is
 * resolved BEFORE the rebind and recorded here, because step (2) is keyed by
 * member id and a rerun after a crash must rebind exactly the same rows — a
 * name-to-id resolution performed twice could land on a different member if
 * the roster changed in between.
 */
export interface SpoofedMember {
  name: string;
  memberId: string;
  identity: PersonaIdentity;
  /**
   * The member's fresh bearer token, in the server's own `tok_<memberId>_<uuid>`
   * shape (swarm/admin.ts rotate-key). Minted per member: a shared bearer would
   * let any container holding it act as every spoofed member. Issued
   * server-side by `SpoofRebindDeps.issueMemberToken` inside the fence.
   */
  bearer: string;
}

/**
 * The instance-scoped generation file written by step (1). It is the unit of
 * recovery: a rerun reads it, compares `generationId` against what the
 * database holds, and resumes at the first unfinished step.
 */
export interface SpoofGeneration {
  /** Content-derived id recorded on the members and on the containers. */
  generationId: string;
  /** ISO timestamp, for operator-facing messages and stale-file diagnosis. */
  createdAt: string;
  /** The deployment instance (spec §1.1) this generation belongs to. */
  instance: string;
  /** Keyed by member name; the value carries the id the rebind uses. */
  members: Record<string, SpoofedMember>;
}

/**
 * The four guards of spec §6.4, plus the path-collision refusal. Each is a
 * separate value because each names a different operator mistake and the §10
 * W3 gates assert the specific one:
 *
 * - `rm_env_prod`             — `RM_ENV = prod`. Spoofing production keys is
 *                               never a thing a rehearsal flag may do.
 * - `identity_not_rehearsal`  — `deployment_identity ≠ rehearsal` (spec §4.2).
 *                               The env var is the operator's claim; the table
 *                               row is the target's own enrollment. Both must
 *                               agree, so a mistyped `RM_ENV` on a production
 *                               connection still refuses.
 * - `no_owner_credential`     — no `rm_owner` credential (generated by smoke
 *                               in local modes, typed at the terminal on a
 *                               remote connection). The rebind is an owner
 *                               mutation; without the credential it cannot
 *                               even be attempted, and discovering that
 *                               halfway through is worse than refusing first.
 * - `flag_not_explicit`       — `--spoof-keys` was not passed explicitly. It is
 *                               never implied by a mode, never defaulted on,
 *                               never inherited from a previous run's state.
 * - `credential_path_collision` — the generation path and the
 *                               `RM_CREDENTIALS`/`--credentials` path name the
 *                               same file. Compared as files, not strings: both
 *                               are `path.resolve`d, then realpath'd (the file,
 *                               or its nearest existing ancestor), and when both
 *                               exist their device and inode are compared, so a
 *                               `..`, relative, symlinked or hard-linked
 *                               spelling still refuses.
 */
export type SpoofRefusalReason =
  | "rm_env_prod"
  | "identity_not_rehearsal"
  | "no_owner_credential"
  | "flag_not_explicit"
  | "credential_path_collision";

/** Real (not a stub): the gates match on `reason`. */
export class SpoofKeysRefusal extends Error {
  readonly reason: SpoofRefusalReason;

  constructor(reason: SpoofRefusalReason, message: string) {
    super(message);
    this.name = "SpoofKeysRefusal";
    this.reason = reason;
  }
}

/**
 * Everything the guards need, gathered by the caller so this module reads no
 * ambient state. `deploymentIdentity` is the row read AFTER the target lock was
 * acquired and revalidated (spec §2), not a value cached from before.
 */
export interface SpoofGuardContext {
  /** `RM_ENV` as resolved by W1's environment module; `null` when unset. */
  rmEnv: "prod" | "stage" | null;
  /** The `deployment_identity.kind` row read under the target lock (spec §4.2). */
  deploymentIdentity: "production" | "rehearsal" | null;
  /** True when an `rm_owner` credential is in hand for this run. */
  hasOwnerCredential: boolean;
  /** True only when `--spoof-keys` appeared in argv. */
  flagExplicit: boolean;
  /** The resolved credential-file path, or `null` when none is configured. */
  credentialPath: string | null;
}

/**
 * Run all four guards plus the path-collision check, in that order, before
 * anything is generated or written.
 *
 * Inputs: the gathered context and the generation path `spoofKeys` computed
 * from the instance state directory. Output: nothing on success.
 *
 * Refusals: any `SpoofRefusalReason`, thrown as `SpoofKeysRefusal`. They are
 * checked independently and the FIRST failure refuses — there is no "any one
 * of these is enough" shortcut in the other direction: passing one guard never
 * excuses another.
 *
 * Gate (spec §10 W3): "`--spoof-keys` with `RM_CREDENTIALS` set writes
 * elsewhere" is this function's `credential_path_collision` plus the
 * instance-scoped path `spoofKeys` computes from `instancePaths`.
 */
export function assertSpoofKeysAllowed(context: SpoofGuardContext, generationPath: string): void {
  if (context.rmEnv === "prod") {
    throw new SpoofKeysRefusal(
      "rm_env_prod",
      "--spoof-keys refuses when RM_ENV = prod; spoofing production keys is never a rehearsal flag's business",
    );
  }
  if (context.deploymentIdentity !== "rehearsal") {
    // The env var is the operator's claim; the row is the target's own
    // enrollment. Unknown is not rehearsal.
    throw new SpoofKeysRefusal(
      "identity_not_rehearsal",
      `--spoof-keys refuses: the target's deployment_identity is ${context.deploymentIdentity ?? "unenrolled"}, not rehearsal`,
    );
  }
  if (!context.hasOwnerCredential) {
    throw new SpoofKeysRefusal(
      "no_owner_credential",
      "--spoof-keys refuses: no rm_owner credential is in hand, and the rebind is an owner mutation",
    );
  }
  if (!context.flagExplicit) {
    throw new SpoofKeysRefusal(
      "flag_not_explicit",
      "--spoof-keys refuses: the flag was not passed explicitly, and it is never implied, defaulted or inherited",
    );
  }
  if (context.credentialPath !== null && sameFile(context.credentialPath, generationPath)) {
    throw new SpoofKeysRefusal(
      "credential_path_collision",
      `--spoof-keys refuses: the generation ${generationPath} would be written over the credential file ${context.credentialPath}`,
    );
  }
}

/**
 * True when two spellings name the same file. A string comparison is not
 * enough: `RM_CREDENTIALS` is taken verbatim (credential-file.ts
 * `resolveCredentialPath`), so a `..` segment, a path relative to the working
 * directory, or a symlink into the state directory would all slip past `===`
 * and let step (1) overwrite the host's only copy of its real keys.
 */
function sameFile(a: string, b: string): boolean {
  const ca = canonicalPath(a);
  const cb = canonicalPath(b);
  if (ca === cb) return true;
  // A hard link, or the same directory reached through a bind mount, has two
  // canonical paths and one inode.
  try {
    const sa = statSync(ca);
    const sb = statSync(cb);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false; // at least one does not exist, so they are not one file
  }
}

/**
 * `path.resolve`, then `realpath` of the file itself when it exists, else of
 * its nearest existing ancestor with the missing tail re-appended. The
 * generation file usually does not exist yet on a first run, and its parent
 * may be the symlinked hop.
 */
function canonicalPath(p: string): string {
  const absolute = resolve(p);
  const missing: string[] = [];
  let probe = absolute;
  for (;;) {
    try {
      return join(realpathSync(probe), ...missing);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return absolute;
      missing.unshift(basename(probe));
      probe = parent;
    }
  }
}

/**
 * Step (1): generate fresh keypairs for the named members and persist them.
 *
 * Inputs: the members to spoof (name plus the member id resolved under the
 * target lock), the state root and the instance. The file is written to
 * `instancePaths(stateRoot, instance).spoofGenerationFile`, creating the
 * owner-only instance directory when it is missing; no caller chooses the
 * path. Output: the persisted `SpoofGeneration`.
 *
 * Each member gets its own keypair AND its own bearer token (spec §6.4).
 *
 * The default membership when no names are given is every member with
 * `operator = robotmoney` — the in-house members. A third party's member is
 * never spoofed: their key is theirs, and rebinding it would let this host
 * sign as them.
 *
 * The write is atomic (temp file then rename) and happens BEFORE the rebind,
 * for the recovery reason in this module's header.
 *
 * Refusals: none of the guard kind — `assertSpoofKeysAllowed` ran already. An
 * I/O failure propagates, and it propagates BEFORE the database is touched,
 * which is the whole point of this ordering.
 *
 * Gate (spec §10 W3): "crash after rebind commit before container replacement
 * recovers" requires this file to exist before the commit.
 */
export function writeSpoofGeneration(
  members: readonly { name: string; memberId: string }[],
  stateRoot: string,
  instance: string,
): SpoofGeneration {
  const outputPath = instancePaths(stateRoot, instance, { create: true }).spoofGenerationFile;
  const spoofed: Record<string, SpoofedMember> = {};
  for (const member of members) {
    // Each member gets its OWN keypair and bearer: sharing either would let
    // any container holding it act as any other spoofed member.
    spoofed[member.name] = {
      name: member.name,
      memberId: member.memberId,
      identity: freshIdentity(),
      bearer: `tok_${member.memberId}_${randomUUID()}`,
    };
  }
  const createdAt = new Date().toISOString();
  const generationId = `gen-${createHash("sha256")
    .update(JSON.stringify({ instance, createdAt, members: spoofed }))
    .digest("hex")
    .slice(0, 16)}`;
  const generation: SpoofGeneration = { generationId, createdAt, instance, members: spoofed };
  // Write-then-rename, and BEFORE the rebind: a generation written after a
  // crashed rebind would leave the database holding keys no file records.
  const temp = `${outputPath}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temp, `${JSON.stringify(generation, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, outputPath);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
  return generation;
}

/** One fresh Ed25519 identity, in the same shape the credential file carries. */
function freshIdentity(): PersonaIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" }) as { x?: string };
  const privateJwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  return {
    publicKeyB64: Buffer.from(publicJwk.x ?? "", "base64url").toString("base64"),
    privateJwk,
  };
}

/**
 * Read a previously persisted generation for this instance.
 *
 * Inputs: the state root and the instance; the file is
 * `instancePaths(stateRoot, instance).spoofGenerationFile`. Output: the
 * generation, or `null` when no file exists (a first run, or an instance that
 * was never spoofed — a plain boot then reads `RM_CREDENTIALS` unchanged).
 *
 * Refusals: a file that exists but is malformed REFUSES rather than returning
 * `null`. Treating a corrupt generation file as absent would generate a second
 * generation while the database may already hold the first, stranding the
 * members exactly the way the write-first ordering exists to prevent. The same
 * holds for a member entry missing its id, key or bearer, and for a file whose
 * `instance` names a different instance than the directory it sits in.
 *
 * Gate (spec §10 W3): "interrupted rebind then rerun".
 */
export function readSpoofGeneration(stateRoot: string, instance: string): SpoofGeneration | null {
  const generationPath = instancePaths(stateRoot, instance).spoofGenerationFile;
  if (!existsSync(generationPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(generationPath, "utf8"));
  } catch (err) {
    // A corrupt generation reported as absent would mint a SECOND generation
    // while the database may already hold the first.
    throw new Error(
      `${generationPath} is not readable JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const gen = parsed as Partial<SpoofGeneration> | null;
  if (!gen || typeof gen !== "object" || typeof gen.generationId !== "string" || gen.generationId === "") {
    throw new Error(`${generationPath} carries no generationId; it is not a spoof generation`);
  }
  if (!gen.members || typeof gen.members !== "object") {
    throw new Error(`${generationPath} carries no members; it is not a spoof generation`);
  }
  if (gen.instance !== instance) {
    // An instance-scoped file that names another instance was copied or
    // misplaced; applying it would rebind this target to someone else's keys.
    throw new Error(`${generationPath} belongs to instance ${String(gen.instance)}, not ${instance}`);
  }
  for (const [name, member] of Object.entries(gen.members as Record<string, Partial<SpoofedMember> | null>)) {
    const complete =
      member !== null &&
      typeof member === "object" &&
      typeof member.memberId === "string" &&
      member.memberId !== "" &&
      typeof member.bearer === "string" &&
      member.bearer !== "" &&
      typeof member.identity?.publicKeyB64 === "string" &&
      member.identity.publicKeyB64 !== "" &&
      typeof member.identity.privateJwk === "object" &&
      member.identity.privateJwk !== null;
    if (!complete) {
      // A plain boot would otherwise start this member with no key or bearer.
      throw new Error(`${generationPath} member ${name} lacks its member id, keypair or bearer`);
    }
  }
  return {
    generationId: gen.generationId,
    createdAt: typeof gen.createdAt === "string" ? gen.createdAt : "",
    instance,
    members: gen.members as Record<string, SpoofedMember>,
  };
}

/**
 * Roster precedence (spec §6.4, D52): the entries a boot reconciles against.
 *
 * Inputs: the credential file's roster entries and the instance's generation
 * (`readSpoofGeneration`), or `null` when none exists. Output: the same
 * entries, in the same order, except that every entry named in the generation
 * carries the generation's keypair and bearer instead of the file's.
 *
 * With no generation the file is returned unchanged. The generation never ADDS
 * a member: the credential file stays the roster (spec §6.1), and the
 * generation only decides which key and bearer a listed member boots with.
 * Names match the way `reconcileRoster` matches them (trimmed, case-folded).
 *
 * Refusals: none; `readSpoofGeneration` already refused a malformed file.
 */
export function effectiveRoster<E extends { name: string; identity: PersonaIdentity }>(
  fileEntries: readonly E[],
  generation: SpoofGeneration | null,
): (E & { bearer?: string })[] {
  if (generation === null) return [...fileEntries];
  const fold = (name: string) => name.trim().toLowerCase();
  const spoofed = new Map<string, SpoofedMember>();
  for (const member of Object.values(generation.members)) spoofed.set(fold(member.name), member);
  return fileEntries.map((entry) => {
    const member = spoofed.get(fold(entry.name));
    if (!member) return entry;
    return {
      ...entry,
      identity: { ...entry.identity, publicKeyB64: member.identity.publicKeyB64, privateJwk: member.identity.privateJwk },
      bearer: member.bearer,
    };
  });
}

/** What the caller supplies so this module performs no database access itself. */
export interface SpoofRebindDeps {
  /**
   * Run `fn` inside ONE transaction that first takes `pg_advisory_xact_lock`
   * on the target-lock key (spec §2). Every rebind is one call: partial
   * rebinds are not a state this design has, because a competitor that won the
   * session lock after a dead coordinator still blocks on the xact lock until
   * this commits or aborts.
   */
  withFencedTransaction<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Rebind one member's current public key BY MEMBER ID, preserving the
   * historical verification keys so past receipts stay verifiable.
   */
  rebindMemberKey(memberId: string, publicKeyB64: string, generationId: string): Promise<void>;
  /**
   * Issue the generation's bearer to the member BY MEMBER ID (the server stores
   * only its hash), superseding the member's previous bearer. Called inside the
   * same fence as `rebindMemberKey`, so a member never holds a new key with an
   * old bearer or the reverse.
   */
  issueMemberToken(memberId: string, bearer: string, generationId: string): Promise<void>;
  /** The generation id the database currently records, or `null`. */
  readInstalledGeneration(): Promise<string | null>;
}

/**
 * Step (2): rebind every named member in ONE fenced transaction, keyed by id.
 *
 * Inputs: the generation and the database dependencies. Output: nothing.
 *
 * If `readInstalledGeneration()` already equals this generation's id, this is
 * a RERUN after a crash between (2) and (4): the function returns without
 * rebinding, and the caller proceeds to (3) and (4). That check is what makes
 * the whole operation idempotent.
 *
 * Refusals: any database error aborts the transaction, so either every named
 * member moved to the new generation or none did.
 *
 * Gates (spec §10 W3): "interrupted rebind then rerun"; "crash after rebind
 * commit before container replacement recovers".
 */
export async function rebindSpoofedKeys(
  generation: SpoofGeneration,
  deps: SpoofRebindDeps,
): Promise<void> {
  const installed = await deps.readInstalledGeneration();
  // A rerun after a crash between (2) and (4): the database is already there,
  // so this step is a no-op and the caller proceeds to (3) and (4).
  if (installed === generation.generationId) return;
  await deps.withFencedTransaction(async () => {
    for (const member of Object.values(generation.members)) {
      await deps.rebindMemberKey(member.memberId, member.identity.publicKeyB64, generation.generationId);
      await deps.issueMemberToken(member.memberId, member.bearer, generation.generationId);
    }
  });
}

/** The container lifecycle the caller owns; this module only decides. */
export interface SpoofContainerDeps {
  stopParticipant(participant: RunningParticipant): Promise<void>;
  startParticipant(member: SpoofedMember, generationId: string): Promise<void>;
}

/**
 * Steps (3) and (4): stop every participant holding an older generation, then
 * start them from the new file.
 *
 * Inputs: the generation, what is running, and the lifecycle dependencies.
 * Output: nothing.
 *
 * Stop-then-start, never start-then-stop and never a rolling restart: two
 * containers for one member, one on each generation, would both poll for the
 * same session, and while the old one's submission would be REFUSED (its key
 * is superseded) it would still consume a take slot and log a failure that
 * looks like a real fault. One take in flight per participant (spec §6.2) is
 * easier to hold by not creating the overlap in the first place.
 *
 * A participant already on this generation is left alone, so a rerun does not
 * restart healthy containers.
 *
 * Refusals: none; a lifecycle failure propagates and the run refuses with the
 * generation still persisted, so the next rerun resumes here.
 */
export async function replaceSpoofedParticipants(
  generation: SpoofGeneration,
  running: readonly RunningParticipant[],
  deps: SpoofContainerDeps,
): Promise<void> {
  const plan = spoofReplacementPlan(generation, running);
  // Stop-then-start, never a rolling restart: two containers for one member
  // would both poll for the same session.
  for (const participant of plan.stop) await deps.stopParticipant(participant);
  for (const member of plan.start) await deps.startParticipant(member, generation.generationId);
}

/**
 * Which containers step (3) stops and which step (4) starts. Separated so
 * `spoofKeys` can report the restarted members without replaying the rule.
 */
function spoofReplacementPlan(
  generation: SpoofGeneration,
  running: readonly RunningParticipant[],
): { stop: RunningParticipant[]; start: SpoofedMember[] } {
  const stop: RunningParticipant[] = [];
  const start: SpoofedMember[] = [];
  for (const member of Object.values(generation.members)) {
    const live = running.find((p) => p.name === member.name);
    if (live && live.generation === generation.generationId) continue; // already current
    if (live) stop.push(live);
    start.push(member);
  }
  return { stop, start };
}

/** Everything one `--spoof-keys` invocation needs. */
export interface SpoofKeysOptions {
  guards: SpoofGuardContext;
  /**
   * The deployment instance and the state root (spec §1.1). The generation
   * file is `instancePaths(stateRoot, instance).spoofGenerationFile`; the
   * caller cannot point it anywhere else.
   */
  instance: string;
  stateRoot: string;
  /** Explicit names from `--spoof-keys a,b`; empty means every in-house member. */
  names: readonly string[];
  /** Resolved under the target lock, after revalidation (spec §2). */
  members: readonly { name: string; memberId: string; operator: string }[];
  running: readonly RunningParticipant[];
  db: SpoofRebindDeps;
  containers: SpoofContainerDeps;
}

/** What the run reports into the journal and the receipt (spec §1.3, §1.4). */
export interface SpoofKeysOutcome {
  generationId: string;
  generationPath: string;
  rebound: readonly string[];
  restarted: readonly string[];
  /** True when the rebind was skipped because the database was already there. */
  resumed: boolean;
}

/**
 * The whole operation: guards, then steps (1)–(4), in order, resumable.
 *
 * Input: `SpoofKeysOptions`. Output: a `SpoofKeysOutcome` for the journal.
 *
 * Refusals: every `SpoofRefusalReason`, before anything is generated.
 *
 * Gates (spec §10 W3): "`--spoof-keys` with `RM_CREDENTIALS` set writes
 * elsewhere; interrupted rebind then rerun; crash after rebind commit before
 * container replacement recovers."
 */
export async function spoofKeys(options: SpoofKeysOptions): Promise<SpoofKeysOutcome> {
  const generationPath = instancePaths(options.stateRoot, options.instance).spoofGenerationFile;
  assertSpoofKeysAllowed(options.guards, generationPath);
  const targets = selectSpoofTargets(options.names, options.members);

  // (1) A persisted generation is REUSED, never replaced: minting a second one
  // while the database may already hold the first strands the members.
  const persisted = readSpoofGeneration(options.stateRoot, options.instance);
  const generation = persisted
    ?? writeSpoofGeneration(
      targets.map((m) => ({ name: m.name, memberId: m.memberId })),
      options.stateRoot,
      options.instance,
    );

  // (2) One fenced transaction, keyed by member id — skipped when the database
  // already reports this generation.
  const installed = await options.db.readInstalledGeneration();
  const resumed = installed === generation.generationId;
  if (!resumed) await rebindSpoofedKeys(generation, options.db);

  // (3) and (4).
  const plan = spoofReplacementPlan(generation, options.running);
  await replaceSpoofedParticipants(generation, options.running, options.containers);

  return {
    generationId: generation.generationId,
    generationPath,
    rebound: resumed ? [] : Object.keys(generation.members),
    restarted: plan.start.map((m) => m.name),
    resumed,
  };
}

/**
 * The members this run spoofs: the explicit names, or every in-house member.
 *
 * A third party's member is NEVER spoofed, named or not — their key is theirs,
 * and rebinding it would let this host sign as them.
 */
function selectSpoofTargets(
  names: readonly string[],
  members: readonly { name: string; memberId: string; operator: string }[],
): { name: string; memberId: string; operator: string }[] {
  const inHouse = (m: { operator: string }) => m.operator === "robotmoney";
  if (names.length === 0) return members.filter(inHouse);
  return names.map((name) => {
    const member = members.find((m) => m.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (!member) throw new Error(`--spoof-keys names "${name}", which is not a member of this target`);
    if (!inHouse(member)) {
      throw new Error(
        `--spoof-keys refuses "${name}": it belongs to operator ${member.operator}, and a third party's key is theirs`,
      );
    }
    return member;
  });
}
