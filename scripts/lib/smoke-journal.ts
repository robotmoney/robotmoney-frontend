// The plan, the plan id, the phase journal, resume and interruption semantics,
// and the readiness receipt — spec §§1.2–1.4.
//
// STATUS. Implemented, unit-tested (scripts/tests/unit/smoke-journal.test.ts)
// and wired: `bun smoke` prints the plan, journals every phase and writes the
// receipt through it (scripts/lib/smoke-main.ts); `smoke:status` and
// `smoke:tui` read them back.
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
//   "A different plan id (roster, image source, or target changed) closes the old
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
//   §1.2  the redacted plan and the plan id (its content hash, over exactly the
//         fields D52 lists); the two locks.
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
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { InstancePaths } from "./smoke-state.ts";

/**
 * On-disk format version of the journal; an unknown one refuses.
 *
 * 2: the plan carries images as `{source, digest}`, the roster as members and
 * the target as kind/host/port or mode/volume, and expectations carry the
 * whole migration `ledger` instead of a `schemaHead`. A version-1 journal
 * refuses rather than parsing as the new type with those fields undefined.
 */
export const JOURNAL_FORMAT_VERSION = 2;
/**
 * On-disk format version of the receipt; an unknown one refuses.
 *
 * 2: the receipt gained `images` (the digests that ran) and carries the
 * version-2 plan shape. A version-1 receipt refuses rather than reaching
 * `receipt.images[name]` on an undefined `images`.
 */
export const RECEIPT_FORMAT_VERSION = 2;
/** A built image identity: a digest, never a tag. */
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** An image source identity: a Git tree id (SHA-1 or SHA-256 repository). */
const SOURCE_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** A roster key fingerprint, as {@link publicKeyFingerprint} makes one. */
const FINGERPRINT_PATTERN = /^fp:[0-9a-f]{16}$/;
/** A member name as the credential file keys it. */
const MEMBER_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A hostname or bracketed IPv6 literal — never userinfo, a path or a port. */
const HOST_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*\.?|\[[0-9A-Fa-f:.]+\])$/;
/** A Postgres database name as this repository uses them. */
const DBNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;
/** A Docker volume name. */
const VOLUME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** An image's service key: a compose service name. */
const SERVICE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A configuration key: an environment-variable name. */
const CONFIG_KEY = /^[A-Z][A-Z0-9_]*$/;
/**
 * Configuration keys that name a secret. The plan carries "every non-secret
 * configuration value" (§1.2), so a key of this shape is refused whatever its
 * value — `RM_CREDENTIALS` included: the plan carries the roster the file
 * holds, never the path to the keys.
 */
const SECRET_KEY_NAME = /PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|PRIVATE|BEARER|(?:^|_)(?:API_)?KEYS?(?:$|_)|DATABASE_URL|(?:^|_)DSN(?:$|_)/;

/** Canonical serialization: object keys sorted, arrays in their given order. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalize(inner)}`).join(",")}}`;
}

/**
 * Why a free-form string reads as a credential, or `null`. Used on every value
 * a typed field cannot constrain — configuration values above all.
 *
 * Shapes, not a list of known values: a Postgres URL; a PEM block; userinfo
 * (`user:pass@host`, with or without a scheme); an automation token (`rmat_`);
 * a hex run of 32 or more; and a RANDOM-looking base64 or base64url run. A run
 * is random-looking when it holds 16 or more letters and digits from at least
 * two of upper case, lower case and digits, and switches between those classes
 * at 35% or more of adjacent pairs inside its alphanumeric segments. Random
 * base64 switches at about 64%; words, camelCase and model ids
 * (`Qwen2.5-Coder-32B-Instruct` switches at 23%) stay well below, as do cron
 * strings, hostnames and paths. A run of 24 or more letters and digits in
 * which at least 70% of the characters are distinct is random-looking too,
 * which catches the random run whose cases happened to cluster.
 *
 * A human-chosen password has no shape. That is what the key-name rule
 * ({@link SECRET_KEY_NAME}) and the caller's `secrets` list are for.
 */
export function credentialShape(value: string): string | null {
  if (/postgres(?:ql)?:\/\//i.test(value)) return "a Postgres connection URL";
  if (/-----BEGIN|PRIVATE KEY/.test(value)) return "a PEM key block";
  if (/[^\s/@:]+:[^\s/@]+@/.test(value)) return "userinfo (user:password@host)";
  if (/rmat_[A-Za-z0-9_-]{8,}/.test(value)) return "an automation token";
  if (/[0-9a-fA-F]{32,}/.test(value)) return "a long hex string, the shape of a token or raw key";
  for (const run of value.match(/[A-Za-z0-9+/=_-]{16,}/g) ?? []) {
    if (looksRandom(run)) return "a random-looking string, the shape of a password, token or key";
  }
  return null;
}

/** See {@link credentialShape}: the class-switching test for one base64-alphabet run. */
function looksRandom(run: string): boolean {
  const alnum = run.replace(/[^A-Za-z0-9]/g, "");
  const classes = [/[A-Z]/, /[a-z]/, /[0-9]/].filter((pattern) => pattern.test(alnum)).length;
  if (alnum.length < 16 || classes < 2) return false;
  const classOf = (c: string): number => (c >= "A" && c <= "Z" ? 0 : c >= "a" && c <= "z" ? 1 : 2);
  let pairs = 0;
  let switches = 0;
  for (const segment of run.split(/[^A-Za-z0-9]+/)) {
    for (let i = 1; i < segment.length; i += 1) {
      pairs += 1;
      if (classOf(segment[i] as string) !== classOf(segment[i - 1] as string)) switches += 1;
    }
  }
  if (pairs > 0 && switches / pairs >= 0.35) return true;
  // A long run whose characters barely repeat is random even when chance
  // clustered its cases: 24 random base64 characters repeat few symbols, while
  // text reuses its letters.
  return alnum.length >= 24 && new Set(alnum).size / alnum.length >= 0.7;
}

/** Refuse `record` unless its keys are exactly `allowed`, naming the stray field. */
function assertExactKeys(record: object, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `Refusing: plan field ${path}.${key} is not one §1.2 lists; the plan carries exactly ${allowed.join(", ")} here.`,
      );
    }
  }
  for (const key of allowed) {
    if (!(key in record)) throw new Error(`Refusing: plan field ${path}.${key} is missing.`);
  }
}

function refuseField(path: string, why: string): never {
  // The value is NEVER echoed: a refusal about a credential must not print it.
  throw new Error(`Refusing: plan field ${path} ${why}; §1.2 requires a redacted plan.`);
}

/** Every string in `value`, with its path, for the caller-supplied secret check. */
function* stringsIn(value: unknown, path: string): Generator<[string, string]> {
  if (typeof value === "string") {
    yield [path, value];
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [index, inner] of value.entries()) yield* stringsIn(inner, `${path}[${index}]`);
    return;
  }
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    yield [`${path}.<key>`, key];
    yield* stringsIn(inner, `${path}.${key}`);
  }
}

/** Options every plan choke point accepts. */
export interface RedactionOptions {
  /**
   * The actual secret values this run holds — the role passwords, a typed
   * `rm_owner` password, the service tokens, the participants' keys and
   * bearers. None may appear anywhere in the plan. This is the check that
   * catches a secret with no recognisable shape.
   */
  readonly secrets?: readonly string[];
}

/**
 * The §1.2 redaction check: POSITIVE, by structure. Every field of the plan has
 * a type that cannot hold a credential — a hostname cannot hold `user:pass@`, a
 * fingerprint cannot hold a key, a source identity is a Git tree id — and the
 * one free-form field, `configuration`, is refused on a secret-shaped key or
 * value. A field the plan does not define is refused rather than carried,
 * because an unknown field is the easiest way for a secret to ride along.
 * Finally no string anywhere may contain one of the caller's `secrets`.
 *
 * Enforced at every choke point: {@link computePlanId}, {@link renderPlan},
 * {@link openJournal} and {@link writeReceipt}.
 */
export function assertPlanRedacted(plan: DeploymentPlan, options: RedactionOptions = {}): void {
  assertExactKeys(plan, ["instance", "target", "images", "roster", "configuration", "mutations"], "plan");
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(plan.instance)) refuseField("plan.instance", "is not a legal instance name");

  const target = plan.target;
  if (target.kind === "remote") {
    assertExactKeys(target, ["kind", "rmEnv", "identity", "host", "port", "dbname"], "plan.target");
    if (!HOST_PATTERN.test(target.host)) {
      refuseField("plan.target.host", "is not a bare hostname (no scheme, userinfo, port or path)");
    }
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
      refuseField("plan.target.port", "is not a TCP port");
    }
    if (!DBNAME_PATTERN.test(target.dbname)) refuseField("plan.target.dbname", "is not a database name");
  } else if (target.kind === "local") {
    assertExactKeys(target, ["kind", "rmEnv", "identity", "mode", "volume"], "plan.target");
    if (!["blank", "dump", "volume"].includes(target.mode)) refuseField("plan.target.mode", "is not a §5 local mode");
    if (!VOLUME_PATTERN.test(target.volume)) refuseField("plan.target.volume", "is not a Docker volume name");
    if (target.rmEnv !== "stage") refuseField("plan.target.rmEnv", "is not stage, and §4.3 refuses RM_ENV=prod locally");
  } else {
    refuseField("plan.target.kind", "is neither remote nor local");
  }
  if (target.rmEnv !== "prod" && target.rmEnv !== "stage") refuseField("plan.target.rmEnv", "is not prod or stage");
  if (target.identity !== "production" && target.identity !== "rehearsal") {
    refuseField("plan.target.identity", "is not a deployment_identity kind");
  }

  for (const [service, image] of Object.entries(plan.images)) {
    // The key is printed verbatim by renderPlan (`image: <service> ...`), so it
    // is shape-checked like every other free-form printed string. The value is
    // never echoed, so the path names the key's position, not the key.
    if (!SERVICE_NAME.test(service) || credentialShape(service) !== null) {
      refuseField("plan.images.<key>", "has a key that is not a compose service name");
    }
    const path = `plan.images.${service}`;
    assertExactKeys(image, ["source", "digest"], path);
    if (!SOURCE_PATTERN.test(image.source)) {
      refuseField(`${path}.source`, "is not a Git tree id (the source identity of the image's build context)");
    }
    if (image.digest !== null && !DIGEST_PATTERN.test(image.digest)) {
      refuseField(`${path}.digest`, "is a tag or other name, not a sha256 digest");
    }
  }

  assertExactKeys(plan.roster, ["agents", "judges"], "plan.roster");
  for (const [namespace, role] of [
    ["agents", "member"],
    ["judges", "judge"],
  ] as const) {
    for (const [index, member] of plan.roster[namespace].entries()) {
      const path = `plan.roster.${namespace}[${index}]`;
      assertExactKeys(member, ["name", "role", "keyFingerprint"], path);
      if (!MEMBER_NAME.test(member.name)) refuseField(`${path}.name`, "is not a member name");
      // §6.1: "An `agents` entry must be a member with role `member` and a
      // `judges` entry a member with role `judge`".
      if (member.role !== role) refuseField(`${path}.role`, `is not ${role}, the role §6.1 requires of ${namespace}`);
      if (!FINGERPRINT_PATTERN.test(member.keyFingerprint)) {
        refuseField(`${path}.keyFingerprint`, "is not a key fingerprint (fp: and 16 hex); a key is never carried");
      }
    }
  }

  for (const [key, value] of Object.entries(plan.configuration)) {
    const path = `plan.configuration.${key}`;
    if (!CONFIG_KEY.test(key)) refuseField(path, "has a key that is not an environment-variable name");
    if (SECRET_KEY_NAME.test(key)) refuseField(path, "is named like a secret, and the plan carries non-secret configuration only");
    if (typeof value !== "string") refuseField(path, "is not a string");
    const shape = credentialShape(value);
    if (shape !== null) refuseField(path, `carries ${shape}`);
  }

  for (const mutation of plan.mutations) {
    if (mutation !== "migrate" && mutation !== "seed" && mutation !== "spoof-keys") {
      refuseField("plan.mutations", "names a mutation §1.2 does not list");
    }
  }

  const secrets = (options.secrets ?? []).filter((secret) => secret.length >= 4);
  if (secrets.length > 0) {
    for (const [path, text] of stringsIn(plan, "plan")) {
      if (secrets.some((secret) => text.includes(secret))) refuseField(path, "contains one of this run's secrets");
    }
  }
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
 * The resolved target of §4, as the plan names it: its IDENTITY, never a way
 * to connect to it. A remote target is host, port and database name; a local
 * one is the §5 mode and the volume smoke owns. Either carries the `RM_ENV`
 * policy and the `deployment_identity` kind the plan was built against.
 */
export type PlanTarget =
  | {
      readonly kind: "remote";
      readonly rmEnv: "prod" | "stage";
      readonly identity: "production" | "rehearsal";
      /** A bare hostname: no scheme, no userinfo, no port, no path. */
      readonly host: string;
      readonly port: number;
      readonly dbname: string;
    }
  | {
      readonly kind: "local";
      /** §4.3: `prod` with `--local` refuses, and an unset `RM_ENV` runs as `stage`. */
      readonly rmEnv: "stage";
      readonly identity: "production" | "rehearsal";
      readonly mode: "blank" | "dump" | "volume";
      readonly volume: string;
    };

/** One image of the plan. */
export interface PlanImage {
  /**
   * The source identity: the Git tree hash of the image's build context
   * (scripts/stack/source-identity.ts). HASHED into the plan id.
   */
  readonly source: string;
  /**
   * The built digest, or `null` before a build. PRINTED, never hashed: "not its
   * built digest, which changes on every rebuild and is recorded in the
   * receipt instead" (§1.2).
   */
  readonly digest: string | null;
}

/** One roster member (§6.1): who, in which role, holding which public key. */
export interface RosterMember {
  readonly name: string;
  /** `member` for an `agents` entry, `judge` for a `judges` entry (§6.1). */
  readonly role: "member" | "judge";
  /** {@link publicKeyFingerprint} of the member's public key — never the key. */
  readonly keyFingerprint: string;
}

/**
 * The redacted plan of spec §1.2: "instance, resolved target (§4), image source
 * identities and digests, participant roster (§6), configuration, and every
 * mutation it intends (`--migrate`, `--seed`, `--spoof-keys`)."
 *
 * REDACTED is a hard requirement, not a style note. The plan is printed to a
 * terminal, hashed into an id that is written to disk, and carried into the
 * receipt that incident work reads — three places a credential must not reach.
 * So every field is typed so that it cannot hold one (see
 * {@link assertPlanRedacted}): the target is host/port/dbname, never a
 * connection string; the roster carries names, roles and key fingerprints,
 * never keys; `configuration` carries the values that change behaviour, never
 * the tokens.
 */
export interface DeploymentPlan {
  readonly instance: string;
  readonly target: PlanTarget;
  /** Per service: source identity (hashed) and built digest (printed). */
  readonly images: Readonly<Record<string, PlanImage>>;
  /** The participant roster (§6.1), from the credential file. */
  readonly roster: { readonly agents: readonly RosterMember[]; readonly judges: readonly RosterMember[] };
  /** Every non-secret, behaviour-affecting configuration value. */
  readonly configuration: Readonly<Record<string, string>>;
  /** Every mutation this run intends. An empty list is a valid, meaningful plan. */
  readonly mutations: readonly ("migrate" | "seed" | "spoof-keys")[];
}

/**
 * The fingerprint a roster member is planned under: `fp:` and the first 16 hex
 * characters of the SHA-256 of the public key's text as the credential file
 * carries it. Enough to see that a key changed; far too little to be one.
 */
export function publicKeyFingerprint(publicKey: string): string {
  if (publicKey.trim() === "") throw new Error("Refusing: an empty public key has no fingerprint.");
  return `fp:${createHash("sha256").update(publicKey.trim()).digest("hex").slice(0, 16)}`;
}

/**
 * The plan id: "The plan's content hash is the **plan id**" (§1.2).
 *
 * Opaque by type so no caller parses it or orders by it. Two runs are the same
 * intent exactly when their ids match; there is no "close enough".
 */
export type PlanId = string & { readonly __brand: "PlanId" };

/**
 * EXACTLY what the plan id hashes, per §1.2 as amended by D52: "the instance
 * name; the target's identity (host, port and database name, or the local mode
 * and volume name) and its `deployment_identity` kind; each image's source
 * identity …; the roster's names, roles and public-key fingerprints; every
 * non-secret configuration value; and the requested mutations. It excludes
 * secret values, timestamps, and any state a journaled phase itself changes,
 * such as the schema version a completed migration moved."
 *
 * Built field by field rather than by deleting from the plan, so a field added
 * to {@link DeploymentPlan} later is excluded until someone decides to hash it.
 * The built digest is left out on purpose. The roster and the mutations are
 * sets, so they are sorted: reordering the credential file or the flags is not
 * a different intent.
 */
export function planHashMaterial(plan: DeploymentPlan): unknown {
  const target =
    plan.target.kind === "remote"
      ? {
          kind: "remote",
          host: plan.target.host.toLowerCase(),
          port: plan.target.port,
          dbname: plan.target.dbname,
          identity: plan.target.identity,
          rmEnv: plan.target.rmEnv,
        }
      : {
          kind: "local",
          mode: plan.target.mode,
          volume: plan.target.volume,
          identity: plan.target.identity,
          rmEnv: plan.target.rmEnv,
        };
  const members = (list: readonly RosterMember[]) =>
    [...list]
      .map((member) => ({ name: member.name, role: member.role, keyFingerprint: member.keyFingerprint }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    instance: plan.instance,
    target,
    images: Object.fromEntries(Object.entries(plan.images).map(([service, image]) => [service, image.source])),
    roster: { agents: members(plan.roster.agents), judges: members(plan.roster.judges) },
    configuration: { ...plan.configuration },
    mutations: [...new Set(plan.mutations)].sort(),
  };
}

/**
 * Compute the plan id: SHA-256 over the canonical serialization of
 * {@link planHashMaterial}.
 *
 * Two runs of the same intent must produce the same id, or rule 1 ("resumes
 * only when the plan id matches") never fires and every rerun starts over — so
 * a rebuild from unchanged sources keeps the id. Conversely every field §1.3
 * names — "roster, image source, or target changed" — is inside the hash, or a
 * changed plan silently reuses completed phases, which rule 2 forbids.
 *
 * Refusal cases: any plan {@link assertPlanRedacted} refuses. This is the
 * choke point every plan passes on its way to the terminal, the journal and
 * the receipt.
 *
 * Serves spec §10 W1: "changed roster/image/target does not reuse completed
 * phases."
 */
export function computePlanId(plan: DeploymentPlan, options: RedactionOptions = {}): PlanId {
  assertPlanRedacted(plan, options);
  return createHash("sha256").update(canonicalize(planHashMaterial(plan))).digest("hex") as PlanId;
}

function renderTarget(target: PlanTarget): string {
  const policy = `RM_ENV=${target.rmEnv}, deployment_identity ${target.identity}`;
  return target.kind === "remote"
    ? `target: remote ${target.host}:${target.port}/${target.dbname} (${policy})`
    : `target: local ${target.mode} on volume ${target.volume} (${policy})`;
}

function renderMembers(label: "agent" | "judge", members: readonly RosterMember[]): string[] {
  if (members.length === 0) return [`${label}s: none`];
  return [...members]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((member) => `${label}: ${member.name} role ${member.role} key ${member.keyFingerprint}`);
}

/**
 * Render the plan for the terminal, exactly as §1.2 requires it to be printed
 * "before any mutation": every field of the plan, one fact per line.
 *
 * Deterministic order, plan id last. This is the artifact an operator reads to
 * decide whether to let the run proceed, and the artifact they compare against
 * when a later run refuses — so the ordering is part of the contract, not a
 * formatting preference. Each image line shows both the source identity (what
 * the id hashes) and the built digest (what will run).
 *
 * Refusal cases: any plan {@link assertPlanRedacted} refuses, with the same
 * `secrets`; and an `id` that is not this plan's.
 */
export function renderPlan(plan: DeploymentPlan, id: PlanId, options: RedactionOptions = {}): string {
  if (computePlanId(plan, options) !== id) {
    throw new Error(`Refusing: plan id ${id} is not this plan's content hash.`);
  }
  const lines = [
    `instance: ${plan.instance}`,
    renderTarget(plan.target),
    ...Object.keys(plan.images)
      .sort()
      .map((service) => {
        const image = plan.images[service] as PlanImage;
        return `image: ${service} source ${image.source} digest ${image.digest ?? "not built yet"}`;
      }),
    ...renderMembers("agent", plan.roster.agents),
    ...renderMembers("judge", plan.roster.judges),
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
 * refusal has to be able to say WHICH expectation failed ("the migration ledger
 * gained 0056 while this journal was stopped"), and a blob
 * comparison can only say "something changed".
 */
export interface StateExpectations {
  /**
   * EVERY applied migration filename at phase start, in filename order; `[]`
   * when the ledger is absent or empty. The whole list, never the head: spec
   * §8.1 makes the filename list the schema identity, and a migration with a
   * LOWER filename than the head can land while a journal is stopped and leave
   * the head unchanged. The same rule, for the same reason, as
   * `TargetState.ledger` in backend/src/db/target-lock.ts.
   */
  readonly ledger: readonly string[];
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
  /** Set when the journal was closed — by a superseding plan (rule 2) or explicitly — else `null`. */
  readonly closedAt: string | null;
  /**
   * Why it was closed: for a supersede, the report of "what it reached" that
   * rule 2 requires, kept with the journal it describes. `null` while open.
   */
  readonly closeReport: string | null;
  /** The plan id that superseded this journal, when that is how it closed. */
  readonly supersededBy: PlanId | null;
  readonly phases: readonly PhaseRecord[];
}

/** Write and fsync: a record still in a page cache is a record that did not exist. */
function writeDurably(file: string, text: string, flag: "w" | "wx" = "w"): void {
  writeFileSync(file, text, { flag, mode: 0o600 });
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

/** A journal read from disk, with the close fields present even on one written before they existed. */
function normalizeJournal(journal: Journal): Journal {
  return { ...journal, closeReport: journal.closeReport ?? null, supersededBy: journal.supersededBy ?? null };
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
  const journal = readVersioned<Journal>(paths.journalFile, JOURNAL_FORMAT_VERSION, "journal");
  return journal === null ? null : normalizeJournal(journal);
}

/**
 * Every journal this instance closed, oldest first — the record rule 2 keeps
 * of superseded plans and what each reached. Refuses on a malformed one, for
 * the same reason {@link readJournal} does.
 */
export function readArchivedJournals(paths: InstancePaths): readonly Journal[] {
  if (!existsSync(paths.journalArchiveDir)) return [];
  return readdirSync(paths.journalArchiveDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) =>
      normalizeJournal(
        readVersioned<Journal>(join(paths.journalArchiveDir, name), JOURNAL_FORMAT_VERSION, "archived journal") as Journal,
      ),
    );
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
 * The world as this journal believes it left it: the expectations the LATEST
 * phase recorded when it began, advanced by that phase's own outcome if it
 * committed one.
 *
 * Each phase records its expectations as observed when it began, so the latest
 * record already contains every earlier phase's committed work and anything
 * the run itself accepted between phases. Projecting from the FIRST record
 * instead would ignore everything recorded since. Rule 1's second sentence
 * lives here: work the journal itself committed is part of the expectation, not
 * a difference to refuse over.
 *
 * `null` for a journal with no phase yet: it has recorded no expectation, so
 * there is nothing to hold the world to.
 */
export function projectExpectations(journal: Journal): StateExpectations | null {
  const last = journal.phases.at(-1);
  if (last === undefined) return null;
  const base = last.expectations;
  const done = last.outcome;
  if (done === null) return base;
  const participants = new Set<string>(base.participants);
  for (const name of done.participantsStarted) participants.add(name);
  for (const name of done.participantsStopped) participants.delete(name);
  return {
    ledger: [...new Set([...base.ledger, ...done.migrationsApplied])].sort(),
    manifestHash: done.manifestPublished ?? base.manifestHash,
    identity: base.identity,
    participants: [...participants],
    services: { ...base.services, ...done.servicesReplaced },
    spoofGeneration: done.spoofGenerationWritten ?? base.spoofGeneration,
  };
}

/**
 * Compare observed state with what a journal expects, and name the first
 * difference, or return `null` when they agree. {@link decideResume} runs the
 * full check at open; this is for a run that could not observe the schema then
 * (the database was not running yet) and must hold the world to the journal
 * the moment it can, rather than never.
 */
export function expectationMismatch(
  expected: StateExpectations,
  observed: Pick<StateExpectations, "ledger" | "manifestHash">,
): string | null {
  const observedLedger = [...observed.ledger].sort();
  const same =
    observedLedger.length === expected.ledger.length &&
    observedLedger.every((name, index) => name === expected.ledger[index]);
  if (!same) {
    return `the migration ledger holds ${describeLedger(observedLedger)}, but this journal expects ${describeLedger(expected.ledger)}`;
  }
  if (observed.manifestHash !== expected.manifestHash) {
    return `the schema manifest hash is ${String(observed.manifestHash)}, but this journal expects ${String(expected.manifestHash)}`;
  }
  return null;
}

/** A ledger list, named by length and last file, for a refusal. */
function describeLedger(ledger: readonly string[]): string {
  const tail = ledger.at(-1);
  return `${ledger.length} file(s)${tail === undefined ? "" : ` ending ${tail}`}`;
}

/** The phase a rerun continues at: the open phase, or the one after the last committed. */
function nextPhaseAfter(journal: Journal): DeploymentPhase {
  const last = journal.phases.at(-1);
  if (last === undefined) return DEPLOYMENT_PHASES[0] as DeploymentPhase;
  if (last.status !== "committed") return last.phase;
  const index = DEPLOYMENT_PHASES.indexOf(last.phase);
  return DEPLOYMENT_PHASES[Math.min(index + 1, DEPLOYMENT_PHASES.length - 1)] as DeploymentPhase;
}

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
 * Rule 2 — "A different plan id (roster, image source, or target changed)
 * closes the old journal, reports what it reached, and starts a fresh
 * reconciliation from current state. Completed phases are never reused under a
 * different plan." The last sentence forbids the tempting optimization of
 * carrying a completed `prepare` across a plan change because "the migration is
 * the same anyway". {@link openJournal} performs the close.
 *
 * Rule 3 — "State changed by another operation fails the expectation check and
 * refuses." Refuse; do not reconcile. A difference this function cannot
 * attribute to the journal's own outcomes is, by definition, someone else's
 * work, and proceeding would interleave two deployments.
 *
 * Inputs: the existing journal (or `null`), the new run's plan id, and the
 * observed current state. Output: {@link ResumeDecision}.
 *
 * Refusal cases (the `refuse` arm), each reason naming the value the journal
 * expected AND the value observed: identity changed kind (the target was
 * re-enrolled underneath the journal); the applied-migration list differs in any
 * position, including below the head; manifest hash moved;
 * a spoofed-key generation nobody journaled; the running participants differ;
 * an expected service is not running; a service is on a digest neither the
 * journal nor the plan names.
 *
 * Serves spec §10 W1: "Resume after committed preparation under the same plan
 * id succeeds; changed roster/image/target does not reuse completed phases."
 */
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
    const last = journal.phases.at(-1);
    const report = [
      `The previous plan ${journal.planId} is superseded by ${planId}; its completed phases are not reused.`,
      last === undefined
        ? "It had begun no phase."
        : `It reached phase ${last.phase}${last.step === null ? "" : ` (${last.step})`}, ${last.status}; a rerun under it would have continued at ${nextPhaseAfter(journal)}.`,
      migrations.length === 0 ? "It applied no migrations." : `It applied migrations: ${migrations.join(", ")}.`,
    ].join("\n");
    return { kind: "supersede", previous: journal, report };
  }

  const expected = projectExpectations(journal);
  if (expected === null) return { kind: "resume", journal, nextPhase: nextPhaseAfter(journal) };

  const refuse = (reason: string): ResumeDecision => ({ kind: "refuse", reason });
  const unaccounted = "and no journaled outcome accounts for the difference.";
  if (observed.identity !== expected.identity) {
    return refuse(
      `the deployment identity is now ${observed.identity}, but this journal expects ${expected.identity}: the target was re-enrolled underneath it.`,
    );
  }
  const observedLedger = [...observed.ledger].sort();
  const sameLedger =
    observedLedger.length === expected.ledger.length &&
    observedLedger.every((name, index) => name === expected.ledger[index]);
  if (!sameLedger) {
    let index = 0;
    while (index < observedLedger.length && observedLedger[index] === expected.ledger[index]) index += 1;
    return refuse(
      `the migration ledger holds ${describeLedger(observedLedger)}, but this journal expects ` +
        `${describeLedger(expected.ledger)}; the first difference is at position ${index + 1}: ` +
        `${observedLedger[index] ?? "nothing"} where the journal expects ${expected.ledger[index] ?? "nothing"}, ${unaccounted}`,
    );
  }
  if (observed.manifestHash !== expected.manifestHash) {
    return refuse(
      `the schema manifest hash is ${String(observed.manifestHash)}, but this journal expects ${String(expected.manifestHash)}, ${unaccounted}`,
    );
  }
  if (observed.spoofGeneration !== expected.spoofGeneration) {
    return refuse(
      `the spoofed-key generation in force is ${String(observed.spoofGeneration)}, but this journal expects ${String(expected.spoofGeneration)}, ${unaccounted}`,
    );
  }
  const expectedParticipants = [...expected.participants].sort().join(",");
  const observedParticipants = [...observed.participants].sort().join(",");
  if (observedParticipants !== expectedParticipants) {
    return refuse(
      `the running participants are [${observedParticipants}], but this journal expects [${expectedParticipants}], ${unaccounted}`,
    );
  }
  for (const [service, digest] of Object.entries(expected.services)) {
    if (observed.services[service] === undefined) {
      return refuse(`service ${service} is not running, but this journal expects it on digest ${digest}, ${unaccounted}`);
    }
  }
  for (const [service, digest] of Object.entries(observed.services)) {
    if (expected.services[service] === digest) continue;
    if (journal.plan.images[service]?.digest === digest) continue;
    const want = expected.services[service] ?? "not running";
    const planned = journal.plan.images[service]?.digest ?? "none";
    return refuse(
      `service ${service} is on digest ${digest}, but this journal expects ${want} and the plan built ${planned}, ${unaccounted}`,
    );
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
  /**
   * Close THIS journal, recording why (an operator abandoning the plan). A
   * journal superseded by a new plan is closed by {@link openJournal} itself,
   * which is the only place that holds both plans.
   */
  close(reason: string): Promise<void>;
}

/** File the closed `journal` in the archive, never over an earlier one. */
function archiveJournal(paths: InstancePaths, journal: Journal): void {
  mkdirSync(paths.journalArchiveDir, { recursive: true, mode: 0o700 });
  const stamp = (journal.closedAt ?? journal.openedAt).replace(/[:.]/g, "-");
  const file = join(paths.journalArchiveDir, `${stamp}-${journal.planId.slice(0, 12)}.json`);
  writeDurably(file, JSON.stringify({ formatVersion: JOURNAL_FORMAT_VERSION, payload: journal }, null, 2), "wx");
}

/**
 * Open a journal writer for this run, creating or continuing the instance's
 * journal per a {@link ResumeDecision} already taken.
 *
 *  - `resume`: continues the journal on disk, which must be the one decided on
 *    and must carry THIS plan's id.
 *  - `supersede`: rule 2's "closes the old journal, reports what it reached".
 *    The previous journal is written to the archive with `closedAt`, the
 *    decision's report and the superseding plan id BEFORE the new journal
 *    replaces it, so the record of what it reached survives on disk rather
 *    than only in the decision. The new journal starts with zero phases:
 *    "Completed phases are never reused under a different plan."
 *  - `fresh-start`: starts a new journal. A closed journal still on disk is
 *    archived first; an OPEN one refuses (the caller decided without it).
 *
 * Refusal cases:
 *  - a decision of `refuse`: this function is not where that is re-litigated,
 *    and accepting one would let a caller bypass the check by ignoring the
 *    decision and opening anyway.
 *  - a `resume` whose journal's plan id is not `computePlanId(plan)`, or a
 *    decision about a journal that is no longer the one on disk: a decision
 *    about another journal is not a decision about this one.
 *  - a plan {@link assertPlanRedacted} refuses, including on any of the run's
 *    `options.secrets`: the journal is on disk.
 *  - the journal file is not writable, or the state directory is missing. A run
 *    that cannot journal must not mutate: the whole of §1.3's recoverability
 *    rests on the record existing, so an unjournalable run is a refusal, never
 *    a warning.
 */
export function openJournal(
  paths: InstancePaths,
  decision: ResumeDecision,
  plan: DeploymentPlan,
  options: RedactionOptions = {},
): JournalWriter {
  if (decision.kind === "refuse") {
    throw new Error(`Refusing to open a journal: ${decision.reason}`);
  }
  if (!existsSync(paths.dir)) {
    throw new Error(
      `Refusing: the state directory ${paths.dir} does not exist, so this run cannot be written to a journal and must not mutate.`,
    );
  }
  // The plan is persisted to disk below, so it gets the run's by-value secrets
  // check too: the shape rule alone misses a shapeless secret.
  const planId = computePlanId(plan, options);
  const onDisk = readJournal(paths);
  const same = (a: Journal | null, b: Journal): boolean =>
    a !== null && a.planId === b.planId && a.openedAt === b.openedAt && a.closedAt === null;
  const fresh = (): Journal => ({
    planId,
    plan,
    instance: plan.instance,
    openedAt: new Date().toISOString(),
    closedAt: null,
    closeReport: null,
    supersededBy: null,
    phases: [],
  });

  let journal: Journal;
  if (decision.kind === "resume") {
    if (decision.journal.planId !== planId) {
      throw new Error(
        `Refusing to resume: the journal is for plan ${decision.journal.planId}, but this run's plan is ${planId}. ` +
          "Only a matching plan id resumes (§1.3 rule 1).",
      );
    }
    if (onDisk === null || !same(onDisk, decision.journal)) {
      throw new Error("Refusing to resume: the journal on disk is no longer the one the resume decision was taken on.");
    }
    journal = onDisk;
  } else if (decision.kind === "supersede") {
    if (decision.previous.planId === planId) {
      throw new Error(`Refusing: a supersede needs a different plan id, and this run's plan is the journal's own (${planId}).`);
    }
    if (onDisk === null || !same(onDisk, decision.previous)) {
      throw new Error("Refusing to supersede: the journal on disk is no longer the one the decision was taken on.");
    }
    archiveJournal(paths, {
      ...onDisk,
      closedAt: new Date().toISOString(),
      closeReport: decision.report,
      supersededBy: planId,
    });
    journal = fresh();
  } else {
    if (onDisk !== null && onDisk.closedAt === null) {
      throw new Error(
        `Refusing a fresh start: an open journal for plan ${onDisk.planId} is on disk. Decide with it (decideResume) ` +
          "rather than overwrite it.",
      );
    }
    if (onDisk !== null) archiveJournal(paths, onDisk);
    journal = fresh();
  }

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
      journal = { ...journal, closedAt: new Date().toISOString(), closeReport: reason };
      persist();
      return Promise.resolve();
    },
  };
}

/**
 * Close the instance's open journal on disk, recording why, without a plan in
 * hand: the operator stopped the deployment it describes (`smoke:down`), or a
 * CI job tore its own stack down. Its expectations (services running on known
 * digests) are then false by the operator's own act, and a later run must
 * start from current state rather than refuse over it: §1.3 rule 3 is for
 * ANOTHER operation's changes, not for the stop the operator asked for.
 *
 * Output: `true` when an open journal was closed, `false` when there was none
 * or it was already closed. Refuses a malformed journal, as
 * {@link readJournal} does.
 */
export function closeOpenJournal(paths: InstancePaths, reason: string): boolean {
  const journal = readJournal(paths);
  if (journal === null || journal.closedAt !== null) return false;
  const closed: Journal = { ...journal, closedAt: new Date().toISOString(), closeReport: reason };
  writeDurably(paths.journalFile, JSON.stringify({ formatVersion: JOURNAL_FORMAT_VERSION, payload: closed }, null, 2));
  return true;
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
  /**
   * The built digest each service is running at readiness. The plan id hashes
   * source identities (§1.2), so this is where the bytes that actually ran are
   * recorded: "not its built digest, which changes on every rebuild and is
   * recorded in the receipt instead".
   */
  readonly images: Readonly<Record<string, string>>;
  /** Schema identity at readiness: manifest hash + the ledger's filename list. */
  readonly schema: { readonly manifestHash: string; readonly migrations: readonly string[] };
  /** Preflight results, per check of §7. */
  readonly preflight: readonly { readonly check: string; readonly pass: boolean; readonly detail: string }[];
  /**
   * Readiness results, per §6.3: scheduler readiness (authenticated, stream
   * synchronized, initial rebuild complete, every active subject holding a
   * `collecting` session), `api` health, the pipeline worker's startup checks,
   * and `analytics-producer`'s authentication and seed command.
   */
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
 *  - the plan id does not match the open journal's, or is not the receipt
 *    plan's own content hash — a receipt describing a different intent than
 *    the run that produced it.
 *  - the plan fails {@link assertPlanRedacted}, including on any of the run's
 *    `options.secrets`: the receipt is on disk.
 *  - a recorded image is not a digest, or is keyed by something that is not a
 *    compose service name.
 *  - the write cannot be made durable.
 *
 * Serves spec §10 W1: "Receipt read by `smoke:status`."
 */
export async function writeReceipt(
  paths: InstancePaths,
  receipt: Receipt,
  options: RedactionOptions = {},
): Promise<void> {
  const failed = receipt.readiness.filter((check) => !check.pass);
  if (failed.length > 0) {
    throw new Error(
      `Refusing: readiness did not pass (${failed.map((check) => check.check).join(", ")}), so there is no receipt to write.`,
    );
  }
  // The receipt persists the plan, so the run's by-value secrets check applies.
  if (computePlanId(receipt.plan, options) !== receipt.planId) {
    throw new Error(`Refusing: the receipt's plan id ${receipt.planId} is not the content hash of the plan it carries.`);
  }
  const journal = readJournal(paths);
  if (journal !== null && journal.planId !== receipt.planId) {
    throw new Error(
      `Refusing: the receipt's plan id ${receipt.planId} does not match the open journal's plan id ${journal.planId}.`,
    );
  }
  for (const [service, digest] of Object.entries(receipt.images)) {
    if (!SERVICE_NAME.test(service) || credentialShape(service) !== null) {
      throw new Error("Refusing: the receipt records an image under a key that is not a compose service name.");
    }
    if (!DIGEST_PATTERN.test(digest)) {
      throw new Error(`Refusing: the receipt records ${service} as ${digest}, which is not a sha256 digest.`);
    }
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
  if (receipt !== null) {
    return [
      `instance ${receipt.instance} reached readiness under plan ${receipt.planId} at ${receipt.writtenAt}.`,
      `schema: manifest ${receipt.schema.manifestHash}, migrations ${receipt.schema.migrations.join(", ")}`,
      ...Object.keys(receipt.images)
        .sort()
        .map((service) => `service ${service}: running ${receipt.images[service]}`),
      ...receipt.preflight.map((check) => `preflight ${check.check}: ${check.pass ? "pass" : "fail"} (${check.detail})`),
      ...receipt.readiness.map((check) => `readiness ${check.check}: ${check.pass ? "pass" : "fail"} (${check.detail})`),
    ].join("\n");
  }
  if (journal === null) {
    return "No receipt and no journal: this instance has no recorded run.";
  }

  const last = journal.phases.at(-1);
  const lines = [
    `instance ${journal.instance} under plan ${journal.planId}, opened ${journal.openedAt}.`,
    last === undefined
      ? "no phase has begun."
      : `phase ${last.phase}${last.step === null ? "" : ` (${last.step})`}: ${last.status}${last.reason === null ? "" : ` — ${last.reason}`}`,
  ];

  const migrations = journal.phases.flatMap((record) => record.outcome?.migrationsApplied ?? []);
  lines.push(
    migrations.length === 0
      ? "committed preparation: none"
      : `committed preparation: migrations ${migrations.join(", ")}`,
  );

  const before = journal.phases[0]?.expectations.services ?? {};
  const replaced: Record<string, string> = {};
  for (const record of journal.phases) {
    for (const [service, digest] of Object.entries(record.outcome?.servicesReplaced ?? {})) {
      replaced[service] = digest;
    }
  }
  for (const [service, digest] of Object.entries(replaced)) {
    lines.push(`service ${service}: new, on ${digest}`);
  }
  for (const [service, digest] of Object.entries(before)) {
    if (replaced[service] !== undefined) continue;
    lines.push(`service ${service}: not replaced, last seen on ${digest}, with no guarantee it survived`);
  }
  return lines.join("\n");
}
