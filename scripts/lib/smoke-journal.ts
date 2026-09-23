// The plan, the plan id, the phase journal, resume and interruption semantics,
// and the readiness receipt — spec §§1.2–1.4.
//
// STUB (issue #1026, W1 step 1). Signatures and types are real; every body
// throws. Nothing imports this module yet, and nothing may import it until the
// implementation lands — it is additive and behaviour-neutral by construction.
//
// ── The problem this module exists to solve ─────────────────────────────────
//
// A deployment is not one action; it is a sequence of partially-committed ones.
// A migration commits. A participant container is replaced. A manifest is
// written. Then Ctrl-C arrives, or the SSH session drops, or the lock
// connection dies. At that moment the system is in a state that no single
// source describes: the database has moved, some services are new and some are
// old, and the operator's memory of what they asked for is the only record of
// the intent.
//
// Everything that then goes wrong goes wrong the same way — someone reruns the
// command, and the rerun either redoes committed work or skips work it should
// not have skipped, because it inferred what had happened from the current
// state alone. Current state cannot distinguish "the migration I applied two
// minutes ago" from "a migration someone else applied while I was stopped".
//
// So the journal records three things separately, and §1.3 is explicit that
// they are three and not one:
//
//   the operator's DESIRED PLAN     — the plan id, what was asked for;
//   the STATE EXPECTATIONS          — what was true when a phase began;
//   the OUTCOMES                    — what that phase actually committed.
//
// With all three, a rerun can answer the only question that matters: is the
// world still the world my journal was describing? If yes, resume. If the
// operator asked for something else, close the journal and start over from
// current state. If someone ELSE moved the world, refuse.
//
// ── Rules quoted verbatim from spec §1.3, because paraphrase loses them ─────
//
//   "A rerun resumes a journal only when the plan id matches. The journal's own
//    committed work (a migration it applied, a manifest it wrote) never
//    invalidates its resume."
//
//   "A different plan id (roster, digest, or target changed) closes the old
//    journal, reports what it reached, and starts a fresh reconciliation from
//    current state. Completed phases are never reused under a different plan."
//
//   "State changed by another operation fails the expectation check and
//    refuses."
//
// The second sentence of the first rule is the subtle one and the easiest to
// implement backwards. A naive expectation check compares the world against
// what it looked like when the run started, sees the migration the run ITSELF
// applied, and refuses — turning every interrupted run into an unresumable one,
// which is precisely the situation the journal was built for. Expectations are
// recorded per phase and must account for the journal's own recorded outcomes.
//
// ── Interruption, spec §1.4 ─────────────────────────────────────────────────
//
// "Ctrl-C stops at the next phase boundary." Not immediately: a phase is the
// unit that can be described, and stopping inside one produces a state the
// journal cannot name.
//
//  - Before the *replace* phase: application services have not been replaced.
//    Preparation may already have changed the database and participant
//    containers; "those changes are journaled, not undone, and a rerun sees
//    them". Nothing is rolled back — a rollback would need a second, untested
//    code path executing under the exact conditions that just failed.
//  - After replacement began: "the stack stays in the journaled state with no
//    guarantee the old services survive." `smoke:status` reports the phase and
//    which services are new versus old; a rerun resumes; `smoke:down` stops
//    everything.
//
// ── Governing spec sections ─────────────────────────────────────────────────
//
//   §1.2  the redacted plan and the plan id (its content hash); the two locks.
//   §1.3  the phase list, the three-part journal, the three resume rules.
//   §1.4  interruption semantics and the receipt.
//   §2    connection loss is "detected at every phase boundary; the tool
//         journals the phase and exits non-zero".
//   §7    the boot order that the phase list mirrors.
//
// Acceptance gates served (spec §10, W1): "Ctrl-C before replace: services not
// replaced, committed preparation journaled not undone. Ctrl-C after: journal
// reported, rerun resumes", "Resume after committed preparation under the same
// plan id succeeds; changed roster/image/target does not reuse completed
// phases", "Receipt read by `smoke:status`".

import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";

import type { InstancePaths } from "./smoke-state.ts";

/** On-disk format version of the journal; an unknown one refuses. */
const JOURNAL_FORMAT_VERSION = 1;
/** On-disk format version of the receipt; an unknown one refuses. */
const RECEIPT_FORMAT_VERSION = 1;
/** An image identity: a digest, never a tag. */
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Canonical serialization: object keys sorted, arrays in their given order. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalize(inner)}`).join(",")}}`;
}

/** The §1.2 redaction check, enforced at the one choke point every plan passes. */
function assertRedacted(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (/postgres(ql)?:\/\//i.test(value) || /PRIVATE KEY/.test(value)) {
      throw new Error(`Refusing: plan field ${path} carries a credential; §1.2 requires a redacted plan.`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((inner, index) => assertRedacted(inner, `${path}[${index}]`));
    return;
  }
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    assertRedacted(inner, `${path}.${key}`);
  }
}

/** Write and fsync: a record still in a page cache is a record that did not exist. */
function writeDurably(file: string, text: string): void {
  writeFileSync(file, text);
  const fd = openSync(file, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Read a versioned JSON state file, refusing on malformed or unknown-version content. */
function readVersioned<T>(file: string, version: number, kind: string): T | null {
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`Refusing: the ${kind} at ${file} is malformed and cannot be parsed.`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`Refusing: the ${kind} at ${file} is malformed and cannot be parsed.`);
  }
  const record = parsed as { formatVersion?: unknown; payload?: unknown };
  if (record.formatVersion !== version) {
    throw new Error(`Refusing: the ${kind} at ${file} has an unknown format version: ${String(record.formatVersion)}.`);
  }
  return record.payload as T;
}

/**
 * The phases of spec §1.3, in order:
 * plan → prepare → preflight → replace → participants → readiness.
 *
 * `replace` is the watershed. Everything before it can be interrupted with the
 * application still serving the old version; everything after it cannot. The
 * type keeps them in one ordered union so "is this phase before replace?" is a
 * question about this list and not a string comparison scattered across call
 * sites.
 *
 * `prepare` covers every authorized preparation (`--migrate`, `--seed`,
 * `--spoof-keys`) and §1.3 requires "each committed preparation recorded
 * separately" — so one `prepare` phase entry per preparation, not one for the
 * group. A single grouped entry cannot say which of three preparations
 * committed before the interruption, which is the only fact a rerun needs.
 */
export type DeploymentPhase = "plan" | "prepare" | "preflight" | "replace" | "participants" | "readiness";

/** Ordered phase list; the source of "is this phase before `replace`". */
export const DEPLOYMENT_PHASES: readonly DeploymentPhase[] = [
  "plan",
  "prepare",
  "preflight",
  "replace",
  "participants",
  "readiness",
] as const;

/**
 * The redacted plan of spec §1.2: "instance, resolved target (§4), image
 * digests, participant roster (§6), configuration, and every mutation it
 * intends (`--migrate`, `--seed`, `--spoof-keys`)."
 *
 * REDACTED is a hard requirement, not a style note. The plan is printed to a
 * terminal, hashed into an id that is written to disk, and carried into the
 * receipt that incident work reads — three places a credential must not reach.
 * `target` therefore carries the database IDENTITY (the host/dbname pair that
 * names it), never a connection string; `roster` carries member names, never
 * their keys; `configuration` carries the values that change behaviour, never
 * the tokens.
 */
export interface DeploymentPlan {
  readonly instance: string;
  /** Resolved target per §4: the policy, the identity kind, and a redacted target name. */
  readonly target: {
    readonly rmEnv: "prod" | "stage";
    readonly identity: "production" | "rehearsal";
    /** A stable, non-secret name for the database, e.g. `host/dbname`. No credentials. */
    readonly database: string;
  };
  /** Image digests per service. A digest, not a tag: a tag is not an identity. */
  readonly images: Readonly<Record<string, string>>;
  /** The participant roster (§6.1): agent and judge names from the credential file. */
  readonly roster: { readonly agents: readonly string[]; readonly judges: readonly string[] };
  /** Behaviour-affecting configuration, already redacted. */
  readonly configuration: Readonly<Record<string, string>>;
  /** Every mutation this run intends. An empty list is a valid, meaningful plan. */
  readonly mutations: readonly ("migrate" | "seed" | "spoof-keys")[];
}

/**
 * The plan id: "The plan's content hash is the **plan id**" (§1.2).
 *
 * Opaque by type so no caller parses it or orders by it. Two runs are the same
 * intent exactly when their ids match; there is no "close enough".
 */
export type PlanId = string & { readonly __brand: "PlanId" };

/**
 * Compute the plan id.
 *
 * The hash must be over a CANONICAL serialization — keys sorted, arrays in a
 * defined order, no timestamps, no PIDs, no paths that vary per host. Two runs
 * of the same intent on the same host must produce the same id, or rule 1
 * ("resumes only when the plan id matches") never fires and every rerun starts
 * over. Conversely every field listed in §1.3's parenthesis — "roster, digest,
 * or target changed" — MUST be inside the hash, or a changed plan silently
 * reuses completed phases, which rule 2 forbids.
 *
 * Refusal cases:
 *  - a plan containing a value that looks like a credential (a `postgres://`
 *    URL, a private key, a token-shaped string) refuses. The redaction promise
 *    of §1.2 is enforced here because this is the choke point every plan passes
 *    through on its way to the terminal, the journal and the receipt.
 *  - a plan with an image entry that is a tag rather than a digest refuses: a
 *    tag that moved between two runs would produce the same plan id for two
 *    different deployments, and rule 1 would then resume a journal describing
 *    other bytes.
 *
 * Serves spec §10 W1: "changed roster/image/target does not reuse completed
 * phases."
 */
export function computePlanId(plan: DeploymentPlan): PlanId {
  assertRedacted(plan, "plan");
  for (const [service, image] of Object.entries(plan.images)) {
    if (!DIGEST_PATTERN.test(image)) {
      throw new Error(`Refusing: image for ${service} is a tag, not a digest: ${image}`);
    }
  }
  return createHash("sha256").update(canonicalize(plan)).digest("hex") as PlanId;
}

/**
 * Render the plan for the terminal, exactly as §1.2 requires it to be printed
 * "before any mutation".
 *
 * One fact per line, deterministic order, plan id last. This is the artifact an
 * operator reads to decide whether to let the run proceed, and the artifact
 * they compare against when a later run refuses — so the ordering is part of
 * the contract, not a formatting preference.
 */
export function renderPlan(plan: DeploymentPlan, id: PlanId): string {
  assertRedacted(plan, "plan");
  const lines = [
    `instance: ${plan.instance}`,
    `target: ${plan.target.rmEnv} (${plan.target.identity})`,
    `database: ${plan.target.database}`,
    ...Object.keys(plan.images)
      .sort()
      .map((service) => `image: ${service} ${plan.images[service]}`),
    `agents: ${plan.roster.agents.join(", ")}`,
    `judges: ${plan.roster.judges.join(", ")}`,
    ...Object.keys(plan.configuration)
      .sort()
      .map((key) => `config: ${key}=${plan.configuration[key]}`),
    `mutations: ${plan.mutations.length === 0 ? "none" : plan.mutations.join(", ")}`,
    `plan id: ${id}`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * What a phase asserted was true when it BEGAN. Spec §1.3's middle term.
 *
 * Deliberately a bag of named, comparable facts rather than a snapshot blob: a
 * refusal has to be able to say WHICH expectation failed ("the schema version
 * moved from 0054 to 0056 while this journal was stopped"), and a blob
 * comparison can only say "something changed".
 */
export interface StateExpectations {
  /** Installed schema version / migration ledger head at phase start. */
  readonly schemaHead: string | null;
  /** Content hash of the schema manifest (§8.3) at phase start. */
  readonly manifestHash: string | null;
  /** `deployment_identity.kind` at phase start. */
  readonly identity: "production" | "rehearsal";
  /** Running participant containers, by name, at phase start. */
  readonly participants: readonly string[];
  /** Running application services and the image digest each was on. */
  readonly services: Readonly<Record<string, string>>;
  /** The spoofed-key generation (§6.4) in force at phase start, if any. */
  readonly spoofGeneration: string | null;
}

/**
 * What a phase actually committed. Spec §1.3's third term, and the reason a
 * resume can tell its own work from someone else's.
 */
export interface PhaseOutcome {
  /** Migration filenames this phase applied, in order. */
  readonly migrationsApplied: readonly string[];
  /** Manifest hash this phase published, if it published one. */
  readonly manifestPublished: string | null;
  /** Participants this phase started and stopped. */
  readonly participantsStarted: readonly string[];
  readonly participantsStopped: readonly string[];
  /** Services replaced, and the digest each was moved to. */
  readonly servicesReplaced: Readonly<Record<string, string>>;
  /** A spoofed-key generation this phase wrote (§6.4 step 1) or rebound (step 2). */
  readonly spoofGenerationWritten: string | null;
}

/** How a phase ended. `interrupted` is a first-class ending, not a failure. */
export type PhaseStatus = "started" | "committed" | "interrupted" | "failed";

export interface PhaseRecord {
  readonly phase: DeploymentPhase;
  /**
   * Distinguishes the several `prepare` entries §1.3 requires to be "recorded
   * separately" — `migrate`, `seed`, `spoof-keys`. `null` for phases that occur
   * once.
   */
  readonly step: string | null;
  readonly status: PhaseStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly expectations: StateExpectations;
  /** `null` until the phase commits; a started-but-not-committed phase has no outcome. */
  readonly outcome: PhaseOutcome | null;
  /** Why it failed or was interrupted. `null` otherwise. */
  readonly reason: string | null;
}

/**
 * The journal on disk: one plan, one ordered list of phase records.
 *
 * "The journal is written before each phase and marked after" (§1.3). Both
 * writes matter. Without the before-write, a crash inside a phase leaves no
 * trace that the phase was attempted, and a rerun's expectation check sees a
 * world that moved for no journaled reason and refuses — an unrecoverable
 * state produced purely by bookkeeping. Without the after-write, committed work
 * is invisible to the resume.
 */
export interface Journal {
  readonly planId: PlanId;
  readonly plan: DeploymentPlan;
  readonly instance: string;
  readonly openedAt: string;
  /** Set when a different plan id closed this journal (rule 2), else `null`. */
  readonly closedAt: string | null;
  readonly phases: readonly PhaseRecord[];
}

/**
 * Read the journal for an instance, if one exists.
 *
 * Output: the journal, or `null` when the instance has never run.
 *
 * Refusal cases: a journal file that exists but is malformed, truncated or
 * carries an unknown format version refuses. It must NOT be treated as absent:
 * "no journal" means "start fresh and mutate freely", and reaching that
 * conclusion from an unparseable file is how a half-finished deployment gets
 * redone from the top.
 */
export function readJournal(paths: InstancePaths): Journal | null {
  return readVersioned<Journal>(paths.journalFile, JOURNAL_FORMAT_VERSION, "journal");
}

/** What a rerun should do with an existing journal. */
export type ResumeDecision =
  /** No journal, or a closed one: run every phase from current state. */
  | { readonly kind: "fresh-start"; readonly reason: string }
  /** Same plan id, expectations hold: continue at `nextPhase`. */
  | { readonly kind: "resume"; readonly journal: Journal; readonly nextPhase: DeploymentPhase }
  /**
   * Different plan id: close the old journal, REPORT WHAT IT REACHED, start a
   * fresh reconciliation from current state. `report` is the operator-facing
   * text; it is not optional, because the old journal's committed work is still
   * out there and the operator is about to act on a database that carries it.
   */
  | { readonly kind: "supersede"; readonly previous: Journal; readonly report: string }
  /** An expectation failed: someone else moved the world. Refuse. */
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * Apply spec §1.3's three resume rules and decide what a rerun does.
 *
 * Rule 1 — "A rerun resumes a journal only when the plan id matches. The
 * journal's own committed work (a migration it applied, a manifest it wrote)
 * never invalidates its resume." So the expectation check compares current
 * state against the journal's expectations AS ADVANCED BY the journal's own
 * recorded outcomes. Implement it that way round; comparing against the
 * ORIGINAL expectations makes every successful preparation self-blocking.
 *
 * Rule 2 — "A different plan id (roster, digest, or target changed) closes the
 * old journal, reports what it reached, and starts a fresh reconciliation from
 * current state. Completed phases are never reused under a different plan." The
 * last sentence forbids the tempting optimization of carrying a completed
 * `prepare` across a plan change because "the migration is the same anyway".
 *
 * Rule 3 — "State changed by another operation fails the expectation check and
 * refuses." Refuse; do not reconcile. A difference this function cannot
 * attribute to the journal's own outcomes is, by definition, someone else's
 * work, and proceeding would interleave two deployments.
 *
 * Inputs: the existing journal (or `null`), the new run's plan id, and the
 * observed current state. Output: {@link ResumeDecision}.
 *
 * Refusal cases (the `refuse` arm): schema head moved and the journal's
 * outcomes do not account for the move; manifest hash differs unaccountably;
 * `deployment_identity` changed kind — the target was re-enrolled underneath
 * the journal, which invalidates every policy decision the plan was built on;
 * an unknown spoofed-key generation is in force; a service is on a digest
 * neither the plan nor the journal names.
 *
 * Serves spec §10 W1: "Resume after committed preparation under the same plan
 * id succeeds; changed roster/image/target does not reuse completed phases."
 */
/**
 * The journal's own expectations ADVANCED BY its own recorded outcomes — the
 * world as this journal believes it left it. Rule 1's second sentence lives
 * here: work the journal itself committed is part of the expectation, not a
 * difference to refuse over.
 */
function projectExpectations(journal: Journal): StateExpectations {
  const first = journal.phases[0]?.expectations ?? null;
  let schemaHead = first?.schemaHead ?? null;
  let manifestHash = first?.manifestHash ?? null;
  let spoofGeneration = first?.spoofGeneration ?? null;
  const participants = new Set<string>(first?.participants ?? []);
  const services: Record<string, string> = { ...(first?.services ?? {}) };
  for (const record of journal.phases) {
    const done = record.outcome;
    if (done === null) continue;
    const lastMigration = done.migrationsApplied.at(-1);
    if (lastMigration !== undefined) schemaHead = lastMigration;
    if (done.manifestPublished !== null) manifestHash = done.manifestPublished;
    if (done.spoofGenerationWritten !== null) spoofGeneration = done.spoofGenerationWritten;
    for (const name of done.participantsStarted) participants.add(name);
    for (const name of done.participantsStopped) participants.delete(name);
    for (const [service, digest] of Object.entries(done.servicesReplaced)) services[service] = digest;
  }
  return {
    schemaHead,
    manifestHash,
    identity: first?.identity ?? "rehearsal",
    participants: [...participants],
    services,
    spoofGeneration,
  };
}

/** The phase a rerun continues at: the open phase, or the one after the last committed. */
function nextPhaseAfter(journal: Journal): DeploymentPhase {
  const last = journal.phases.at(-1);
  if (last === undefined) return DEPLOYMENT_PHASES[0] as DeploymentPhase;
  if (last.status !== "committed") return last.phase;
  const index = DEPLOYMENT_PHASES.indexOf(last.phase);
  return DEPLOYMENT_PHASES[Math.min(index + 1, DEPLOYMENT_PHASES.length - 1)] as DeploymentPhase;
}

export function decideResume(
  journal: Journal | null,
  planId: PlanId,
  observed: StateExpectations,
): ResumeDecision {
  if (journal === null) return { kind: "fresh-start", reason: "no journal for this instance" };
  if (journal.closedAt !== null) {
    return { kind: "fresh-start", reason: `the journal was closed at ${journal.closedAt}` };
  }

  if (journal.planId !== planId) {
    const migrations = journal.phases.flatMap((record) => record.outcome?.migrationsApplied ?? []);
    const report = [
      `The previous plan ${journal.planId} is superseded by ${planId}; its completed phases are not reused.`,
      `It reached phase ${nextPhaseAfter(journal)} before stopping.`,
      migrations.length === 0 ? "It applied no migrations." : `It applied migrations: ${migrations.join(", ")}.`,
    ].join("\n");
    return { kind: "supersede", previous: journal, report };
  }

  const expected = projectExpectations(journal);
  if (observed.identity !== expected.identity) {
    return {
      kind: "refuse",
      reason: `the deployment identity is now ${observed.identity}, not ${expected.identity}: the target was re-enrolled underneath this journal.`,
    };
  }
  if (observed.schemaHead !== expected.schemaHead) {
    return {
      kind: "refuse",
      reason: `the schema head is ${String(observed.schemaHead)}, not ${String(expected.schemaHead)}, and no journaled outcome accounts for the move.`,
    };
  }
  if (observed.manifestHash !== expected.manifestHash) {
    return {
      kind: "refuse",
      reason: `the schema manifest hash is ${String(observed.manifestHash)}, not ${String(expected.manifestHash)}, and no journaled outcome accounts for the move.`,
    };
  }
  if (observed.spoofGeneration !== expected.spoofGeneration) {
    return {
      kind: "refuse",
      reason: `the spoofed-key generation in force is ${String(observed.spoofGeneration)}, which no journaled outcome wrote.`,
    };
  }
  const expectedParticipants = [...expected.participants].sort().join(",");
  const observedParticipants = [...observed.participants].sort().join(",");
  if (observedParticipants !== expectedParticipants) {
    return {
      kind: "refuse",
      reason: `the running participants are [${observedParticipants}], not [${expectedParticipants}], and no journaled outcome accounts for the change.`,
    };
  }
  for (const [service, digest] of Object.entries(observed.services)) {
    if (expected.services[service] === digest) continue;
    if (journal.plan.images[service] === digest) continue;
    return {
      kind: "refuse",
      reason: `service ${service} is on digest ${digest}, which neither the plan nor this journal names.`,
    };
  }

  return { kind: "resume", journal, nextPhase: nextPhaseAfter(journal) };
}

/**
 * The live journal handle a run writes through. One object so the
 * before-write/after-write pairing of §1.3 is a method call rather than a
 * convention two call sites have to remember.
 */
export interface JournalWriter {
  readonly planId: PlanId;
  /**
   * Write the "phase beginning" record, capturing {@link StateExpectations} as
   * observed RIGHT NOW. Must be durable (fsync) before the phase acts: a record
   * still in a page cache when the machine dies is a record that did not exist.
   */
  beginPhase(phase: DeploymentPhase, step: string | null, expectations: StateExpectations): Promise<void>;
  /** Mark the open phase committed, recording exactly what it did. */
  commitPhase(outcome: PhaseOutcome): Promise<void>;
  /**
   * Mark the open phase interrupted (§1.4, Ctrl-C at a phase boundary) or
   * failed, with the reason — including the §2 case, "connection loss …
   * detected at every phase boundary; the tool journals the phase and exits
   * non-zero".
   */
  endPhase(status: "interrupted" | "failed", reason: string): Promise<void>;
  /** Close the journal after a superseding plan (rule 2). */
  close(reason: string): Promise<void>;
}

/**
 * Open a journal writer for this run, creating or continuing the instance's
 * journal per a {@link ResumeDecision} already taken.
 *
 * Refusal cases:
 *  - a decision of `refuse`: this function is not where that is re-litigated,
 *    and accepting one would let a caller bypass the check by ignoring the
 *    decision and opening anyway.
 *  - the journal file is not writable, or the state directory is missing. A run
 *    that cannot journal must not mutate: the whole of §1.3's recoverability
 *    rests on the record existing, so an unjournalable run is a refusal, never
 *    a warning.
 */
export function openJournal(paths: InstancePaths, decision: ResumeDecision, plan: DeploymentPlan): JournalWriter {
  if (decision.kind === "refuse") {
    throw new Error(`Refusing to open a journal: ${decision.reason}`);
  }
  if (!existsSync(paths.dir)) {
    throw new Error(
      `Refusing: the state directory ${paths.dir} does not exist, so this run cannot be written to a journal and must not mutate.`,
    );
  }
  const planId = computePlanId(plan);
  let journal: Journal =
    decision.kind === "resume"
      ? decision.journal
      : {
          planId,
          plan,
          instance: plan.instance,
          openedAt: new Date().toISOString(),
          closedAt: null,
          phases: [],
        };

  function persist(): void {
    writeDurably(paths.journalFile, JSON.stringify({ formatVersion: JOURNAL_FORMAT_VERSION, payload: journal }, null, 2));
  }

  function markOpenPhase(update: (record: PhaseRecord) => PhaseRecord): void {
    const last = journal.phases.at(-1);
    if (last === undefined) throw new Error("Refusing: there is no open phase to mark.");
    journal = { ...journal, phases: [...journal.phases.slice(0, -1), update(last)] };
    persist();
  }

  persist();

  return {
    planId,
    beginPhase(phase, step, expectations) {
      journal = {
        ...journal,
        phases: [
          ...journal.phases,
          {
            phase,
            step,
            status: "started",
            startedAt: new Date().toISOString(),
            endedAt: null,
            expectations,
            outcome: null,
            reason: null,
          },
        ],
      };
      persist();
      return Promise.resolve();
    },
    commitPhase(outcome) {
      markOpenPhase((record) => ({ ...record, status: "committed", endedAt: new Date().toISOString(), outcome }));
      return Promise.resolve();
    },
    endPhase(status, reason) {
      markOpenPhase((record) => ({ ...record, status, endedAt: new Date().toISOString(), reason }));
      return Promise.resolve();
    },
    close(reason) {
      journal = { ...journal, closedAt: new Date().toISOString() };
      void reason;
      persist();
      return Promise.resolve();
    },
  };
}

/**
 * Interruption handling for spec §1.4: "Ctrl-C stops at the next phase
 * boundary."
 *
 * Installs the signal handling and exposes the flag the phase loop consults. It
 * does NOT abort in-flight work: the §2 invariant — "Loss of the coordinating
 * lock never lets a competing tool overlap a mutation still executing. A
 * cancellation request is not evidence the mutation stopped." — applies here
 * with equal force. A Ctrl-C that killed a running migration would leave a
 * database whose state no journal describes.
 *
 * A SECOND Ctrl-C must not escalate to an immediate exit. That is the
 * conventional behaviour and it is wrong here for the same reason: the operator
 * pressing it again has no more information than the first time, and the thing
 * they would be killing is a transaction.
 */
export interface InterruptWatch {
  /** True once a stop has been requested; the phase loop stops at the next boundary. */
  requested(): boolean;
  /** Stop watching (run finished normally). */
  dispose(): void;
}

/**
 * Install the interrupt watch.
 *
 * Refusal cases: none — it must not be possible for installing the watch to
 * fail a run. Its only job is to make a stop request observable.
 *
 * Serves spec §10 W1: "Ctrl-C before replace: services not replaced, committed
 * preparation journaled not undone. Ctrl-C after: journal reported, rerun
 * resumes."
 */
export function watchForInterrupt(): InterruptWatch {
  let stopRequested = false;
  let disposed = false;
  const handler = (): void => {
    if (!disposed) stopRequested = true;
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return {
    requested: () => stopRequested,
    dispose: () => {
      disposed = true;
      process.removeListener("SIGINT", handler);
      process.removeListener("SIGTERM", handler);
    },
  };
}

/**
 * The readiness receipt of spec §1.4: "At readiness smoke writes a durable
 * receipt (resolved plan, schema identity, preflight and readiness results)
 * beside the journal."
 *
 * It is the artifact that outlives the run. "`smoke:status`, rollback, and
 * incident work read the receipt when present, the journal when not" — so its
 * contents are read by people under time pressure who were not present for the
 * deployment, and it must therefore be self-contained: a receipt that requires
 * the journal to interpret is a receipt that fails exactly when the journal has
 * been superseded.
 */
export interface Receipt {
  readonly planId: PlanId;
  readonly plan: DeploymentPlan;
  readonly instance: string;
  readonly writtenAt: string;
  /** Schema identity at readiness: manifest hash + the ledger's filename list. */
  readonly schema: { readonly manifestHash: string; readonly migrations: readonly string[] };
  /** Preflight results, per check of §7. */
  readonly preflight: readonly { readonly check: string; readonly pass: boolean; readonly detail: string }[];
  /** Readiness results, including the §6.3 enabled-schedule advance check. */
  readonly readiness: readonly { readonly check: string; readonly pass: boolean; readonly detail: string }[];
}

/**
 * Write the receipt, durably, beside the journal.
 *
 * Refusal cases:
 *  - readiness did not pass: there is no such thing as a receipt for a boot
 *    that did not reach readiness. The journal is the record in that case, and
 *    writing a receipt anyway would make §1.4's "read the receipt when present"
 *    rule actively misleading.
 *  - the plan id does not match the open journal's — a receipt describing a
 *    different intent than the run that produced it.
 *  - the write cannot be made durable.
 *
 * Serves spec §10 W1: "Receipt read by `smoke:status`."
 */
export async function writeReceipt(paths: InstancePaths, receipt: Receipt): Promise<void> {
  const failed = receipt.readiness.filter((check) => !check.pass);
  if (failed.length > 0) {
    throw new Error(
      `Refusing: readiness did not pass (${failed.map((check) => check.check).join(", ")}), so there is no receipt to write.`,
    );
  }
  const journal = readJournal(paths);
  if (journal !== null && journal.planId !== receipt.planId) {
    throw new Error(
      `Refusing: the receipt's plan id ${receipt.planId} does not match the open journal's plan id ${journal.planId}.`,
    );
  }
  writeDurably(paths.receiptFile, JSON.stringify({ formatVersion: RECEIPT_FORMAT_VERSION, payload: receipt }, null, 2));
  await Promise.resolve();
}

/**
 * Read the receipt for an instance.
 *
 * Output: the receipt, or `null` when none exists (the run never reached
 * readiness, or is still running).
 *
 * Refusal cases: a malformed or unknown-version receipt refuses rather than
 * returning `null`, for the same reason {@link readJournal} does — "no receipt"
 * routes the reader to the journal, and an unreadable receipt is not that.
 */
export function readReceipt(paths: InstancePaths): Receipt | null {
  return readVersioned<Receipt>(paths.receiptFile, RECEIPT_FORMAT_VERSION, "receipt");
}

/**
 * Summarize, for `smoke:status` and for the supersede report of rule 2, what a
 * run reached: the phase it is in or stopped at, which services are new versus
 * old (§1.4's explicit requirement after replacement began), and what
 * preparation committed.
 *
 * Reads the receipt when present and the journal when not, per §1.4. Must be
 * honest about the after-replace case: "the stack stays in the journaled state
 * with no guarantee the old services survive" — so an old service that is no
 * longer running is reported as gone, never as still serving.
 */
export function summarizeProgress(journal: Journal | null, receipt: Receipt | null): string {
  void journal;
  void receipt;
  throw new Error("NOT IMPLEMENTED: journal/receipt progress summary — spec §1.4, issue #1026 W1.6");
}
