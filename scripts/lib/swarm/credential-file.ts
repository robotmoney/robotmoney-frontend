// The credential file IS the roster (smoke-production-spec.md §6.1, issue
// #1026 W3.1). The types, the refusal taxonomy, and the contract written in
// these comments are the design; the bodies below implement it.
//
// ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
// Until now the in-house roster was assembled from three places that could
// disagree: a committed fixture of persona keys
// (scripts/lib/swarm/persona-keys.ts), a `--agents` flag listing handles, and
// per-agent lines in `~/.env`. That arrangement has three defects the spec
// closes at once:
//
//   1. A key committed to the repository is a key anyone with a clone can sign
//      with. Fine for a smoke character, disqualifying for production. Spec §3
//      is explicit: participant keys live in `credential.json`, NEVER in
//      `~/.env`, which holds the remote connection and the three runtime
//      database tokens (`rm_app`, `rm_worker`, `rm_readonly`) and nothing else.
//      Preflight check 4 (spec §7) enforces the other half of that rule.
//   2. An argv flag is a per-invocation statement, so "who is on this host"
//      could change with a typo in a shell history entry and leave no artifact
//      behind. The roster has to be a FILE, because the file is the thing an
//      operator provisions once (spec §9.2 step 1) and the thing a plan can
//      hash (spec §1.2 — the roster is part of the plan, and therefore part of
//      the plan id, so a roster change closes the journal rather than silently
//      resuming another operator's run).
//   3. Agents and judges were never distinguishable. Spec §6.1 gives them two
//      distinct namespaces with distinct keys precisely so that "this host runs
//      no agents but does run a judge" is expressible, and so that a judge's
//      key is never handed to an agent container. Each container receives only
//      its own key.
//
// ── WHAT BREAKS WITHOUT IT ──────────────────────────────────────────────────
// Without a single authoritative roster file there is no desired-state
// reconciliation, and without reconciliation a participant that was removed
// from the roster keeps running and keeps taking. The spec §10 W3 gate
// "configured credential file disappears while participants run: refuse,
// participants untouched" exists because the tempting implementation — treat a
// missing file as an empty roster — silently stops every participant on a host
// the moment an NFS mount blips or a path typo lands. A missing file is NEVER
// an instruction. Removing everyone is a thing an operator writes down, in the
// file, as `{ "agents": {}, "judges": {} }`.
//
// ── GOVERNING SPEC SECTIONS ─────────────────────────────────────────────────
// §6.1 (this module in full), §3 last line (keys are here, not in `~/.env`),
// §1.2 (the roster appears in the plan and feeds the plan id), §6.4 (the
// spoof-keys generation file must never be this path — see spoof-keys.ts),
// §10 W3 (acceptance gates).
//
// ── WHAT THIS MODULE MUST NOT DO ────────────────────────────────────────────
// It never starts or stops a container itself: it computes a desired-state
// plan and hands it to the caller (`smoke-main.ts`). It holds no database
// credential. A boot never writes the credential file — provisioning is an
// operator act (spec §9.2), not a side effect of a boot. Its one writer,
// writeCredentialBearer, is called only by the operator's production
// initialization step 6 (`bun scripts/prod-init.ts rebind-members`, §9.1).
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * A participant's signing identity: the Ed25519 public key the API holds and
 * the private JWK the participant signs with. It lives here, beside the file
 * that carries it; persona-keys.ts re-exports it for the smoke fixtures.
 */
export interface PersonaIdentity {
  /** Raw Ed25519 public key, base64 — the form /api/swarm/register takes. */
  publicKeyB64: string;
  /** Private key as a JWK, seeded into the member container's client keystore. */
  privateJwk: Record<string, unknown>;
}

/**
 * One `credential.json` entry (spec §6.1, D52 Decision 1): everything ONE
 * participant container needs, and nothing another container needs.
 *
 * ```json
 * { "memberId": "…", "publicKeyB64": "…", "privateJwk": { … },
 *   "bearer": "…", "modelKey": "…" }
 * ```
 *
 * All five fields are required and non-empty. D52 moved the bearer and the
 * model key out of `~/.env` and into the entry, so a container handed its entry
 * holds its own identity, its own API token and its own model key — and a
 * judge's model key never reaches an agent container, or the other way round.
 *
 * The member id is carried so the boot can check the entry against the
 * database's `swarm_members.role` (an `agents` entry must be role `member`, a
 * `judges` entry role `judge`) and refuse naming the entry on a mismatch.
 */
export interface CredentialEntry extends PersonaIdentity {
  /** The server-minted member id this entry signs and authenticates as. */
  memberId: string;
  /** This participant's API bearer token. Never another participant's. */
  bearer: string;
  /** This participant's model (inference) key. Delivered to its container only. */
  modelKey: string;
}

/**
 * The two namespaces of spec §6.1. They are distinct on purpose: a name may
 * legitimately appear in both (an operator may run `themis` as a judge on one
 * host and as an agent on a test host) and the two entries are then different
 * keys for different roles, not a duplicate.
 */
export type ParticipantKind = "agent" | "judge";

/**
 * The parsed contents of `credential.json`, spec §6.1:
 *
 * ```json
 * { "agents": { "athena": { … }, "noop-analyst": { … }, "robot-money": { … } },
 *   "judges": { "themis": { … } } }
 * ```
 *
 * Both keys are REQUIRED and both may be empty — `{ "agents": {}, "judges": {} }`
 * is the explicit empty roster, the only way to remove every participant.
 * Zero agents with several judges is valid; several judges are allowed.
 * Each value is a `CredentialEntry`: member id, signing key, bearer token and
 * model key (D52). No two entries may share a member id, a public key or a
 * bearer, in either namespace: one member cannot be both an agent and a judge,
 * and a judge's key is never an agent's key.
 */
export interface CredentialFile {
  agents: Record<string, CredentialEntry>;
  judges: Record<string, CredentialEntry>;
}

/**
 * One roster line, flattened out of the two namespaces. `name` is the stable
 * handle (the file's key) that containers and the plan are named by. The
 * server-minted member id travels inside `credential` (D52), because the boot
 * checks it against the database's role for this namespace.
 */
export interface RosterEntry {
  name: string;
  kind: ParticipantKind;
  /** The whole entry: this container's credential and no other's. */
  credential: CredentialEntry;
}

/**
 * How the path was configured. `flag` is `--credentials <path>`, `env` is
 * `RM_CREDENTIALS=<path>` from `~/.env`. Arg overrides env (spec §6.1). The
 * origin is carried because every refusal message must name WHICH setting
 * pointed at the path that failed — an operator debugging a refusal needs to
 * know whether to edit their shell command or their `~/.env`.
 */
export type CredentialPathOrigin = "flag" | "env";

/**
 * Path resolution has three outcomes, and "not configured" is a first-class
 * one rather than an empty string: with no path configured smoke proceeds with
 * NO participants only if none are running, and otherwise refuses naming them
 * (spec §6.1). That branch cannot be expressed if "unconfigured" and "empty
 * roster" collapse into the same value.
 */
export type CredentialPathResolution =
  | { configured: true; path: string; origin: CredentialPathOrigin }
  | { configured: false };

/**
 * Every way this module refuses. They are separate values, not one generic
 * error, because the operator action differs for each and because the §10 W3
 * gate tests assert the specific reason rather than "it threw":
 *
 * - `missing`            — a configured path does not exist. NOT an empty roster.
 * - `unreadable`         — it exists but cannot be read (permissions, I/O).
 * - `malformed`          — it read but is not JSON, or is missing `agents`/
 *                          `judges`, or an entry lacks one of the five
 *                          `CredentialEntry` fields.
 * - `duplicate-name`     — the same name appears twice within ONE namespace
 *                          (JSON allows it; the last-wins default would hand a
 *                          container a key its operator did not intend).
 * - `shared-identity`    — two entries carry the same member id, public key
 *                          or bearer, in one namespace or across the two. One
 *                          member is one participant with one role, so a
 *                          shared identity is a copy-paste mistake that would
 *                          hand one container another's credential.
 * - `unconfigured-with-running` — no path is configured but participants are
 *                          running. Refuse and name them; never interpret
 *                          absent configuration as "stop everyone".
 */
export type CredentialRefusalReason =
  | "missing"
  | "unreadable"
  | "malformed"
  | "duplicate-name"
  | "shared-identity"
  | "unconfigured-with-running";

/**
 * The refusal carried out of this module. Real (not a stub): callers match on
 * `reason`, and the §10 W3 gate asserts both the reason and that the running
 * participants were left untouched. `running` is populated only for
 * `unconfigured-with-running`, where the message must name what is running.
 */
export class CredentialFileRefusal extends Error {
  readonly reason: CredentialRefusalReason;
  readonly path: string | undefined;
  readonly running: readonly RunningParticipant[];

  constructor(
    reason: CredentialRefusalReason,
    message: string,
    options: { path?: string; running?: readonly RunningParticipant[] } = {},
  ) {
    super(message);
    this.name = "CredentialFileRefusal";
    this.reason = reason;
    this.path = options.path;
    this.running = options.running ?? [];
  }
}

/**
 * A participant container observed to be running right now, as reported by the
 * compose layer. This is deliberately a plain record rather than a Docker
 * object: reconciliation is pure, so the §10 W3 gates can drive it with a
 * fabricated "running" set and no daemon.
 *
 * `generation` is the spoof-keys generation id the container was started from
 * (spoof-keys.ts), or `undefined` for a container started from the credential
 * file. Step (3) of spec §6.4 stops every participant holding an OLDER
 * generation, which is a comparison this field exists to make possible.
 */
export interface RunningParticipant {
  name: string;
  kind: ParticipantKind;
  containerName: string;
  generation?: string;
}

/**
 * The desired-state reconciliation of spec §6.1: "A run makes the running
 * participants equal the file". Three disjoint sets, so the caller's execution
 * order is explicit and testable rather than implied by a diff routine.
 */
export interface ReconciliationPlan {
  /** On the roster, not running: start these. */
  start: RosterEntry[];
  /** On the roster and already running with a current key: leave alone. */
  keep: RosterEntry[];
  /** Running, not on the roster (or holding a superseded key): stop these. */
  stop: RunningParticipant[];
}

/**
 * Resolve the credential-file path from argv and the environment.
 *
 * Inputs: the parsed argv (a `--credentials <path>` value if present) and the
 * environment (`RM_CREDENTIALS`). Output: a `CredentialPathResolution`.
 *
 * Rules (spec §6.1): the flag overrides the environment; a flag present with
 * an empty or whitespace-only value is a `malformed` refusal, not an
 * "unconfigured" result, because an operator who typed the flag meant to point
 * somewhere; neither present yields `{ configured: false }`, which is a
 * legitimate state and not yet a refusal.
 *
 * Refusals: `malformed` for an empty flag value. Nothing else — a path that
 * does not exist is not this function's business, because the plan (spec §1.2)
 * prints the resolved path before any read is attempted.
 *
 * Gate (spec §10 W3): "`--spoof-keys` with `RM_CREDENTIALS` set writes
 * elsewhere" depends on this function resolving the same path spoof-keys
 * compares against.
 */
export function resolveCredentialPath(
  env: Record<string, string | undefined>,
  flagValue?: string,
): CredentialPathResolution {
  if (flagValue !== undefined) {
    const flag = flagValue.trim();
    if (flag === "") {
      throw new CredentialFileRefusal(
        "malformed",
        "--credentials was given an empty value; an operator who typed the flag meant to point somewhere",
      );
    }
    return { configured: true, path: flag, origin: "flag" };
  }
  const fromEnv = (env.RM_CREDENTIALS ?? "").trim();
  if (fromEnv === "") return { configured: false };
  return { configured: true, path: fromEnv, origin: "env" };
}

/**
 * Parse and validate the credential file's TEXT into a `CredentialFile`.
 *
 * Inputs: the raw file contents and the path it came from (for messages only).
 * Output: a validated `CredentialFile` with both namespaces present.
 *
 * Validation is total and strict: the top level must be an object carrying
 * exactly the `agents` and `judges` keys; each namespace must be an object;
 * each entry must carry a non-empty `memberId`, `publicKeyB64`, `bearer` and
 * `modelKey`, and a `privateJwk` object (D52). A namespace may be empty. An
 * unknown top-level key is `malformed` rather
 * than ignored — silently dropping a namespace an operator invented (say,
 * `"observers"`) would run a host with fewer participants than its file says.
 *
 * Refusals: `malformed` for any of the above; `duplicate-name` if a name
 * repeats within one namespace after normalization; `shared-identity` if two
 * entries share a member id, public key or bearer. A refusal names the entries
 * and the field, never the value: a bearer in an error message is a bearer in
 * a log.
 *
 * Gate (spec §10 W3): the "file disappears" gate needs `missing` and
 * `malformed` to be distinguishable at the call site, which starts here.
 */
export function parseCredentialFile(text: string, path: string): CredentialFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CredentialFileRefusal(
      "malformed",
      `${path} is not JSON: ${err instanceof Error ? err.message : String(err)}`,
      { path },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CredentialFileRefusal("malformed", `${path} must be a JSON object`, { path });
  }
  const top = parsed as Record<string, unknown>;
  for (const key of Object.keys(top)) {
    if (key !== "agents" && key !== "judges") {
      // Silently dropping an invented namespace would run the host with fewer
      // participants than its own file says it has.
      throw new CredentialFileRefusal(
        "malformed",
        `${path} carries an unknown top-level key "${key}"; the only namespaces are agents and judges`,
        { path },
      );
    }
  }
  const namespaces: Record<ParticipantKind, Record<string, CredentialEntry>> = {
    agent: {},
    judge: {},
  };
  for (const [namespace, kind] of [["agents", "agent"], ["judges", "judge"]] as const) {
    const raw = top[namespace];
    if (raw === undefined) {
      throw new CredentialFileRefusal(
        "malformed",
        `${path} is missing the required "${namespace}" namespace`,
        { path },
      );
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new CredentialFileRefusal(
        "malformed",
        `${path}: "${namespace}" must be an object`,
        { path },
      );
    }
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = value as Partial<CredentialEntry> | null;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new CredentialFileRefusal(
          "malformed",
          `${path}: ${namespace} entry "${name}" is not an object`,
          { path },
        );
      }
      // Every string field by NAME, so the refusal says which one is missing.
      for (const field of ENTRY_STRING_FIELDS) {
        const v = entry[field];
        if (typeof v !== "string" || v.trim() === "") {
          throw new CredentialFileRefusal(
            "malformed",
            `${path}: ${namespace} entry "${name}" has no usable ${field}; ${ENTRY_FIELD_PURPOSE[field]}`,
            { path },
          );
        }
      }
      if (
        entry.privateJwk === null
        || typeof entry.privateJwk !== "object"
        || Array.isArray(entry.privateJwk)
      ) {
        throw new CredentialFileRefusal(
          "malformed",
          `${path}: ${namespace} entry "${name}" has no privateJwk; a container cannot sign with a public key`,
          { path },
        );
      }
      namespaces[kind][name] = {
        memberId: (entry.memberId as string).trim(),
        publicKeyB64: entry.publicKeyB64 as string,
        privateJwk: entry.privateJwk,
        bearer: entry.bearer as string,
        modelKey: entry.modelKey as string,
      };
    }
  }
  // JSON.parse collapses a repeated key to the last value, so the file's TEXT
  // is the authority for "the same name twice in one namespace".
  const duplicate = firstDuplicateName(text);
  if (duplicate) {
    throw new CredentialFileRefusal(
      "duplicate-name",
      `${path}: "${duplicate.name}" appears twice in the ${duplicate.namespace} namespace`,
      { path },
    );
  }
  const file: CredentialFile = { agents: namespaces.agent, judges: namespaces.judge };
  const shared = firstSharedIdentity(file);
  if (shared) {
    throw new CredentialFileRefusal(
      "shared-identity",
      `${path}: ${shared.first} and ${shared.second} carry the same ${shared.field}; `
        + "each entry is one participant with its own identity, and one member cannot hold two roles",
      { path },
    );
  }
  return file;
}

/** The four string fields of a `CredentialEntry`, validated by name. */
const ENTRY_STRING_FIELDS = ["memberId", "publicKeyB64", "bearer", "modelKey"] as const;

/** Why each field is required, so a refusal tells the operator what it is for. */
const ENTRY_FIELD_PURPOSE: Record<(typeof ENTRY_STRING_FIELDS)[number], string> = {
  memberId: "the boot checks the entry's role against the member it names",
  publicKeyB64: "the API verifies this participant's signatures with it",
  bearer: "the participant authenticates to the API with it",
  modelKey: "the participant runs its model work on its own key (D52)",
};

/**
 * The first pair of entries sharing a member id, public key or bearer, across
 * both namespaces. A model key MAY be shared (one operator account can fund
 * several participants); an identity may not. Field names are reported, never
 * values.
 */
function firstSharedIdentity(
  file: CredentialFile,
): { first: string; second: string; field: "memberId" | "publicKeyB64" | "bearer" } | undefined {
  for (const field of ["memberId", "publicKeyB64", "bearer"] as const) {
    const seen = new Map<string, string>();
    for (const [namespace, entries] of [["agents", file.agents], ["judges", file.judges]] as const) {
      for (const [name, entry] of Object.entries(entries)) {
        const label = `${namespace} entry "${name}"`;
        const value = entry[field].trim();
        const prior = seen.get(value);
        if (prior !== undefined) return { first: prior, second: label, field };
        seen.set(value, label);
      }
    }
  }
  return undefined;
}

/**
 * The first name repeated within ONE namespace, read off the file's text.
 *
 * `JSON.parse` keeps only the last value for a repeated key, and two spellings
 * of one name ("Athena" and "athena") are two keys it keeps both of. Either
 * would hand a container a key its operator did not intend, so both are found
 * here: a minimal scanner that tracks object nesting and normalizes each key
 * the way the roster does.
 */
function firstDuplicateName(text: string): { namespace: string; name: string } | undefined {
  interface Frame {
    isObject: boolean;
    /** The key this frame's value was stored under, in its parent. */
    key: string | undefined;
    depth: number;
    expectKey: boolean;
    seen: Set<string>;
    pendingKey: string | undefined;
  }
  const stack: Frame[] = [];
  const top = (): Frame | undefined => stack[stack.length - 1];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      const parent = top();
      stack.push({
        isObject: ch === "{",
        key: parent?.pendingKey,
        depth: stack.length,
        expectKey: ch === "{",
        seen: new Set(),
        pendingKey: undefined,
      });
      i += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      i += 1;
      continue;
    }
    if (ch === ",") {
      const frame = top();
      if (frame?.isObject) frame.expectKey = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      const { value, next } = readJsonString(text, i);
      i = next;
      const frame = top();
      if (frame?.isObject && frame.expectKey) {
        frame.pendingKey = value;
        frame.expectKey = false;
        // A namespace frame sits one level under the root object.
        const isNamespace = frame.depth === 1 && (frame.key === "agents" || frame.key === "judges");
        if (isNamespace) {
          const normalized = value.trim().toLowerCase();
          if (frame.seen.has(normalized)) {
            return { namespace: frame.key === "judges" ? "judges" : "agents", name: normalized };
          }
          frame.seen.add(normalized);
        }
      }
      continue;
    }
    i += 1;
  }
  return undefined;
}

/** Read one JSON string starting at the opening quote; returns its value. */
function readJsonString(text: string, start: number): { value: string; next: number } {
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const escaped = text[i + 1] ?? "";
      if (escaped === "u") {
        out += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16) || 0);
        i += 6;
        continue;
      }
      const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
      out += simple[escaped] ?? escaped;
      i += 2;
      continue;
    }
    if (ch === '"') return { value: out, next: i + 1 };
    out += ch;
    i += 1;
  }
  return { value: out, next: i };
}

/**
 * Read a configured credential file from disk and validate it.
 *
 * Input: an absolute path. Output: a validated `CredentialFile`.
 *
 * Refusals, all of which leave running participants UNTOUCHED (the caller must
 * not have stopped anything before this returns — that ordering is the whole
 * point of the §10 W3 gate): `missing` when the path does not exist,
 * `unreadable` on any I/O or permission error, `malformed`/`duplicate-name`
 * from `parseCredentialFile`.
 *
 * There is deliberately no "default to empty on error" path and no
 * `try { … } catch { return EMPTY }` anywhere in this module's future body.
 *
 * Gate (spec §10 W3): "Configured credential file disappears while
 * participants run: refuse, participants untouched."
 */
export function loadCredentialFile(path: string): CredentialFile {
  try {
    statSync(path);
  } catch {
    // Missing is NOT an empty roster: it refuses, and the caller has stopped
    // nothing by the time it does.
    throw new CredentialFileRefusal(
      "missing",
      `credential file ${path} does not exist; a missing file is never an instruction to stop participants`,
      { path },
    );
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new CredentialFileRefusal(
      "unreadable",
      `credential file ${path} exists but could not be read: ${err instanceof Error ? err.message : String(err)}`,
      { path },
    );
  }
  return parseCredentialFile(text, path);
}

/**
 * Flatten a `CredentialFile` into roster entries, judges included.
 *
 * Input: a validated file. Output: one `RosterEntry` per entry across both
 * namespaces, in a stable order (kind then name) so that the plan's roster
 * section — and therefore the plan id (spec §1.2) — does not change when the
 * JSON object's key order does.
 *
 * Refusals: none; validation already happened. A file with zero entries yields
 * an empty array, which is the explicit empty roster and a legitimate desired
 * state.
 *
 * Gate (spec §10 W3): "Judge runs as a participant" — the judge is on this
 * list exactly like an agent, which is what makes W3.4 possible at all.
 */
export function rosterEntries(file: CredentialFile): RosterEntry[] {
  const entries: RosterEntry[] = [];
  for (const [kind, namespace] of [["agent", file.agents], ["judge", file.judges]] as const) {
    for (const name of Object.keys(namespace).sort()) {
      const credential = namespace[name];
      if (credential) entries.push({ name, kind, credential });
    }
  }
  return entries;
}

/**
 * Compute the desired-state plan: make the running participants equal the
 * roster (spec §6.1).
 *
 * Inputs:
 * - `desired` — the roster entries, or `null` meaning "no path configured".
 * - `running` — what is running right now.
 * - `currentGeneration` — the spoof-keys generation the caller intends
 *   containers to hold, or `undefined` when starting from the credential file.
 *   A running container whose `generation` differs must be stopped and
 *   restarted even though its name is on the roster: that is step (3) of spec
 *   §6.4, expressed here rather than duplicated in spoof-keys.ts.
 *
 * Output: a `ReconciliationPlan`. This function is PURE — no Docker, no
 * filesystem, no clock — so the gates can drive every overlap case directly.
 *
 * Refusals: `unconfigured-with-running` when `desired` is `null` and `running`
 * is non-empty; the error names every running participant. When `desired` is
 * `null` and nothing runs, the result is an empty plan, not a refusal.
 *
 * Gates (spec §10 W3): "Roster change with overlapping containers: one take"
 * (the overlap is bounded by this plan plus the idempotent submission of
 * take-runner.ts) and the "no path configured" branch of §6.1.
 */
export function reconcileRoster(
  desired: readonly RosterEntry[] | null,
  running: readonly RunningParticipant[],
  currentGeneration?: string,
): ReconciliationPlan {
  if (desired === null) {
    if (running.length === 0) return { start: [], keep: [], stop: [] };
    // Absent configuration is never read as "stop everyone": no plan is
    // produced at all, and the refusal names who was left alone.
    const named = running.map((p) => `${p.kind}:${p.name} (${p.containerName})`).join(", ");
    throw new CredentialFileRefusal(
      "unconfigured-with-running",
      `no credential file is configured while these participants are running and were left untouched: ${named}`,
      { running: [...running] },
    );
  }
  const key = (p: { name: string; kind: ParticipantKind }) => `${p.kind}:${p.name.trim().toLowerCase()}`;
  const byKey = new Map<string, RunningParticipant>();
  for (const p of running) byKey.set(key(p), p);

  const start: RosterEntry[] = [];
  const keep: RosterEntry[] = [];
  const stop: RunningParticipant[] = [];
  const claimed = new Set<string>();

  for (const entry of desired) {
    const k = key(entry);
    claimed.add(k);
    const live = byKey.get(k);
    if (!live) {
      start.push(entry);
      continue;
    }
    // Spec §6.4 step (3): a container holding a superseded generation is
    // replaced even though its name is on the roster.
    if (currentGeneration !== undefined && live.generation !== currentGeneration) {
      stop.push(live);
      start.push(entry);
      continue;
    }
    keep.push(entry);
  }
  for (const live of running) {
    if (!claimed.has(key(live))) stop.push(live);
  }
  return { start, keep, stop };
}

/**
 * The ONE composition a boot uses: path resolution → load → reconcile.
 *
 * Inputs: the resolved path, what is running, the loader (injectable so the
 * gates can observe whether it was called), and the spoof-keys generation, if
 * any. Output: a `ReconciliationPlan`.
 *
 * WHY THIS EXISTS AS A FUNCTION. `reconcileRoster` already refuses `null` with
 * participants running, but a caller decides what to pass it, and the natural
 * one-liner — `resolution.configured ? rosterEntries(load(path)) : []` — maps
 * "no path configured" to the EMPTY ROSTER, which is the explicit instruction
 * to stop everyone. Every pure test of `reconcileRoster` passes with that
 * caller in place, while it stops every participant on a host whose
 * `RM_CREDENTIALS` line went missing. So the mapping lives here, once, and
 * boot code calls only this (spec §6.1: "With no path configured, smoke
 * proceeds with no participants only if none are running; otherwise it
 * refuses and names them").
 *
 * An unconfigured resolution never calls `load`: there is no path to read,
 * and reading a default would invent configuration nobody wrote.
 *
 * Refusals: `unconfigured-with-running` from `reconcileRoster`; every load
 * refusal, rethrown with the setting that pointed at the path, so the operator
 * knows whether to fix a shell command or `~/.env`.
 */
export function planParticipants(
  resolution: CredentialPathResolution,
  running: readonly RunningParticipant[],
  load: (path: string) => CredentialFile = loadCredentialFile,
  currentGeneration?: string,
): ReconciliationPlan {
  if (!resolution.configured) return reconcileRoster(null, running, currentGeneration);
  let file: CredentialFile;
  try {
    file = load(resolution.path);
  } catch (err) {
    if (!(err instanceof CredentialFileRefusal)) throw err;
    const setting = resolution.origin === "flag" ? "--credentials" : "RM_CREDENTIALS in ~/.env";
    throw new CredentialFileRefusal(err.reason, `${err.message} (path set by ${setting})`, {
      path: resolution.path,
    });
  }
  return reconcileRoster(rosterEntries(file), running, currentGeneration);
}

/**
 * The redacted roster lines for the plan printout (spec §1.2).
 *
 * Input: roster entries. Output: one display line per entry, carrying name and
 * kind and NEVER any key material — not the private JWK, and not the public
 * key either, since a plan is pasted into issues and chat logs and a public key
 * is still an identity an onlooker can correlate.
 *
 * Refusals: none.
 *
 * Gate (spec §10 W1/W3): the plan is hashed into the plan id, and a roster
 * change must close the journal rather than resume it.
 */
export function rosterPlanLines(entries: readonly RosterEntry[]): string[] {
  // Name and kind only. A plan is pasted into issues and chat logs, and a
  // public key is still an identity an onlooker can correlate.
  return entries.map((e) => `${e.kind} ${e.name}`);
}

/**
 * Write one entry's API bearer into the credential file, atomically — the ONE
 * writer of this file, and not a boot's: production initialization step 6
 * (spec §9.1, `bun scripts/prod-init.ts rebind-members`) rotates each seated
 * member through the admin `rotate-key` route and records the bearer the route
 * returns "into that member's entry".
 *
 * Only `bearer` changes. The file is validated before the write (a malformed
 * file is refused, never rewritten into shape), every other field of every
 * entry is carried over as it was, and the new text is written to a temporary
 * file beside it — same mode as the original, synced — and renamed over it, so
 * a reader sees the old file or the new one and never a partial one. The new
 * text is validated again before the rename.
 *
 * Refusal cases: the file refuses to load; the named entry does not exist in
 * the named namespace; the bearer is empty.
 */
export function writeCredentialBearer(path: string, kind: ParticipantKind, name: string, bearer: string): void {
  if (bearer.trim() === "") throw new Error(`refusing to write an empty bearer for ${kind} "${name}" into ${path}`);
  const before = loadCredentialFile(path);
  const namespace = kind === "agent" ? "agents" : "judges";
  if (!(name in (kind === "agent" ? before.agents : before.judges))) {
    throw new Error(`${path} has no ${namespace} entry "${name}"; rebind writes only an entry the file already holds`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, Record<string, unknown>>>;
  raw[namespace]![name]!.bearer = bearer;
  const text = `${JSON.stringify(raw, null, 2)}\n`;
  parseCredentialFile(text, path);
  const mode = statSync(path).mode & 0o777;
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx", mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
