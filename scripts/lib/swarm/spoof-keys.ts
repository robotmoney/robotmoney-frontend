// `--spoof-keys [names]` — fresh keypairs for named in-house members so a
// production-shaped database can be driven without real keys
// (smoke-production-spec.md §6.4, issue #1026 W3.5). STEP 1 STUB: every
// function throws NOT IMPLEMENTED; the types, the four guards, the four-step
// order and the recovery argument below are the deliverable of this step.
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
//       directory — never the `RM_CREDENTIALS` path; equal paths refuse;
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
 * - `credential_path_collision` — the resolved output path equals the resolved
 *                               `RM_CREDENTIALS`/`--credentials` path.
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
  /** Where the generation will be written (instance state directory). */
  outputPath: string;
  /** The resolved credential-file path, or `null` when none is configured. */
  credentialPath: string | null;
}

/**
 * Run all four guards plus the path-collision check, in that order, before
 * anything is generated or written.
 *
 * Input: the gathered context. Output: nothing on success.
 *
 * Refusals: any `SpoofRefusalReason`, thrown as `SpoofKeysRefusal`. They are
 * checked independently and the FIRST failure refuses — there is no "any one
 * of these is enough" shortcut in the other direction: passing one guard never
 * excuses another.
 *
 * Gate (spec §10 W3): "`--spoof-keys` with `RM_CREDENTIALS` set writes
 * elsewhere" is this function's `credential_path_collision` plus
 * `spoofGenerationPath` below.
 */
export function assertSpoofKeysAllowed(context: SpoofGuardContext): void {
  throw new Error(
    "NOT IMPLEMENTED: run the four --spoof-keys guards — spec §6.4, issue #1026 W3.5",
  );
}

/**
 * The instance-scoped path the generation is written to.
 *
 * Inputs: the instance's state directory (spec §1.1 — state directories are
 * scoped per instance, so two concurrent rehearsals cannot read each other's
 * generation) and the instance name. Output: an absolute path inside that
 * directory.
 *
 * Refusals: none here; collision with the credential path is
 * `assertSpoofKeysAllowed`'s job, so that the refusal happens before any write
 * rather than as a side effect of computing a name.
 */
export function spoofGenerationPath(stateDir: string, instance: string): string {
  throw new Error(
    "NOT IMPLEMENTED: resolve the instance-scoped generation path — spec §6.4, issue #1026 W3.5",
  );
}

/**
 * Step (1): generate fresh keypairs for the named members and persist them.
 *
 * Inputs: the members to spoof (name plus the member id resolved under the
 * target lock) and the output path. Output: the persisted `SpoofGeneration`.
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
  outputPath: string,
  instance: string,
): SpoofGeneration {
  throw new Error(
    "NOT IMPLEMENTED: generate keypairs and persist the generation file — spec §6.4, issue #1026 W3.5",
  );
}

/**
 * Read a previously persisted generation for this instance.
 *
 * Input: the generation path. Output: the generation, or `null` when no file
 * exists (a first run).
 *
 * Refusals: a file that exists but is malformed REFUSES rather than returning
 * `null`. Treating a corrupt generation file as absent would generate a second
 * generation while the database may already hold the first, stranding the
 * members exactly the way the write-first ordering exists to prevent.
 *
 * Gate (spec §10 W3): "interrupted rebind then rerun".
 */
export function readSpoofGeneration(generationPath: string): SpoofGeneration | null {
  throw new Error(
    "NOT IMPLEMENTED: read the persisted generation for retry — spec §6.4, issue #1026 W3.5",
  );
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
  throw new Error(
    "NOT IMPLEMENTED: rebind member keys in one fenced transaction — spec §6.4/§2, issue #1026 W3.5",
  );
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
  throw new Error(
    "NOT IMPLEMENTED: stop old-generation participants and start the new ones — spec §6.4, issue #1026 W3.5",
  );
}

/** Everything one `--spoof-keys` invocation needs. */
export interface SpoofKeysOptions {
  guards: SpoofGuardContext;
  /** The deployment instance and its state directory (spec §1.1). */
  instance: string;
  stateDir: string;
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
  throw new Error(
    "NOT IMPLEMENTED: run the four-step spoof-keys sequence — spec §6.4, issue #1026 W3.5",
  );
}
