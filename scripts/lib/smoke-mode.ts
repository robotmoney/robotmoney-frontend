// WHAT `bun smoke` IS, as data — the pure half of the smoke boot (issue #537).
//
// `bun smoke` and `bun smoke` use the same stack, cache policy, readiness,
// session engine, assertions boundary and cleanup. Only scenario initialization
// differs: smoke seeds simulation schedules/projects/subjects/members; smoke
// restores the production archive and reconnects its committed IC identities.
//
// Every one of those is a DECISION, not I/O, so it lives here and is executed
// directly by  rather than grepped out of
// scripts/lib/smoke-main.ts. smoke-main.ts holds only the wiring.
//
// NOT in scope here (issue #537's "Out of scope"): the archive import pipeline,
// storage and read paths (#498/#499 own those), the production live-roster
// seed/prune contract (#529/#530 own that), and any database migration.
import { ownsData, type DbMode } from "./smoke-db-mode.ts";
import { personaIdentity } from "./swarm/persona-keys.ts";
import { planAdoptions } from "./swarm/roster-plan.ts";
import type { RosterMember } from "./swarm/session.ts";
import { demoAttends } from "@robotmoney/contract";

/** The one argv flag that selects a smoke boot. */
export const SMOKE_MODE_FLAG = "--smoke";

/** Is this argv a smoke boot? (`bun smoke` → `bun scripts/smoke.ts --smoke`.) */
export function isSmokeMode(argv: readonly string[]): boolean {
  return argv.includes(SMOKE_MODE_FLAG);
}

/**
 * The migrate/seed one-shot's extra env for a SMOKE boot: empty.
 *
 * A production-shaped boot must not carry the project seed switch. Frozen so
 * a caller cannot smuggle a key back in at runtime.
 *
 * The normal-smoke counterpart stays spelled out at the `stack.up` call site in
 * scripts/lib/smoke-main.ts (the wiring guard in
 * scripts/tests/integration/smoke-compose-config.test.ts pins it there).
 */
export const SMOKE_MIGRATE_ENV: Readonly<Record<string, string>> = Object.freeze({});

/** Project seeding is the only normal-smoke migration environment setting. */
export const DEMO_MIGRATE_ENV: Readonly<Record<string, string>> =
  Object.freeze({ SMOKE_SEED_PROJECTS: "1" });

/** Demo schedules are an explicit migration action, not environment state. */
export const DEMO_MIGRATE_SCRIPT_ARGS: readonly string[] = Object.freeze(["--seed-smoke-schedules"]);
export const SMOKE_MIGRATE_SCRIPT_ARGS: readonly string[] = Object.freeze([]);

export interface ScenarioSubject { id: string; name: string }
export interface ScenarioMember {
  memberId: string;
  name: string;
  lens: string;
  bias: number;
  present: boolean;
}
export interface ScenarioPlan {
  // C-26. This union WAS collapsed to `"smoke" | "smoke"` by the blind
  // demo→smoke literal rename, which made `plan.kind === "smoke"` true for a
  // plain simulation boot as well and ran the archive-continuity check against
  // a roster nothing had restored. The two boots are genuinely different
  // scenarios and the type has to say so: `"smoke"` is the production-shaped
  // `--smoke` boot that restores a roster, `"simulation"` is the seeded demo
  // boot that does not. Restored 2026-09-23 after the merge dropped the
  // upstream fix (which spelled the same distinction
  // `"simulation" | "archive-restore"`).
  kind: "smoke" | "simulation";
  migrateEnv: Readonly<Record<string, string>>;
  migrateScriptArgs: readonly string[];
  subjects: readonly ScenarioSubject[];
  members: readonly ScenarioMember[];
  runsNewcomerOnboarding: boolean;
}

export const DEMO_SUBJECTS: readonly ScenarioSubject[] = Object.freeze([
  Object.freeze({ id: "woon", name: "Woon Treasury" }),
  Object.freeze({ id: "mav", name: "Mav Holdings" }),
]);
export const DEMO_MEMBERS: readonly ScenarioMember[] = Object.freeze([
  Object.freeze({ memberId: "athena", name: "Athena", lens: "macro risk", bias: -0.1, present: demoAttends("athena") }),
  Object.freeze({ memberId: "boreas", name: "Boreas", lens: "on-chain flows", bias: 0, present: demoAttends("boreas") }),
  Object.freeze({ memberId: "cygnus", name: "Cygnus", lens: "momentum", bias: 0.15, present: demoAttends("cygnus") }),
  Object.freeze({ memberId: "draco", name: "Draco", lens: "contrarian", bias: 0, present: demoAttends("draco") }),
  // Issue #922: the smoke-local named-judge persona. Handle 'themis' (derived
  // from this display name by the same slugifyMemberName algorithm every other
  // member's handle goes through) so #918's judgeSessionAdmin — which resolves
  // its judgeMemberId by looking up the HANDLE 'themis', not by role — actually
  // finds her. Absent by the shared DEMO_NO_SHOWS rule, same as draco: a
  // judge-role member cannot hold a take in the session it judges.
  Object.freeze({ memberId: "themis", name: "Themis", lens: "consensus judge", bias: 0, present: demoAttends("themis") }),
]);

/** The boot-step names the TUI/step list carries, per mode: a twin (`smoke`)
 *  starts its requested agents; everything else runs the simulation seed. */
export function bootstrapStepNames(smoke: boolean): readonly string[] {
  return smoke ? ["start agents"] : ["simulation seed"];
}

/**
 * The four subjects `backend/seed-data/v0-committee-archive.json.gz` restores,
 * under their RELEASE names (backend/scripts/v0-seed-bootstrap.ts maps two of
 * them on import). Ids are stable v0 identifiers and must never change — see
 * issue #537's "Out of scope".
 */
export const SMOKE_SUBJECTS: readonly { id: string; name: string }[] = Object.freeze([
  Object.freeze({ id: "robotmoney-allocation", name: "Robot Money Allocation" }),
  Object.freeze({ id: "robotmoney-treasury", name: "RM Protocol Labs Treasury" }),
  Object.freeze({ id: "robotmoney-vault", name: "Robot Money Vault" }),
  Object.freeze({ id: "woon", name: "Woon Treasury" }),
]);

/**
 * The four in-house committee agents — the ONLY members a twin session may
 * seat by name, and the only names `--agents` accepts (see
 * scripts/lib/smoke-db-mode.ts's AGENTS_FLAG). Every other real committee
 * member runs their own agent independently; smoke never seats or starts one
 * on their behalf.
 *
 * Three of the four (`athena`, `robot-money`, `themis`) are
 * `backend/src/swarm/roster-seed.ts`'s `LIVE_ROSTER`, every one `operator:
 * "robotmoney"`. `noop-analyst` is NOT a smoke-only fixture or an archive
 * leftover to retire: it is `woon`, one of the four subjects/personas the
 * (now-retired) v0 archive import wrote into REAL production as a permanent
 * row, and it has been a real, currently-active in-house committee member
 * ever since — production runs it same as the other three.
 *
 * This is an allowlist, not a cap: a persistent database can carry members
 * from an earlier boot or from a real onboarding, and a twin session must
 * seat NONE of them by this name — only the four named here.
 *
 * HANDLE, NOT ID (issue #685). Member ids are generated per deployment
 * (`crypto.randomUUID()`), so a boot has no way to know one in advance and a
 * hardcoded id matches nothing: the allowlist has to name members by the one
 * key that IS stable across deployments. Handles are derived from display
 * names by the single `slugifyMemberName` algorithm, which is why "Robot
 * Money" is `robot-money` and not `robotmoney`, and why the archive's `woon`
 * is `noop-analyst` — leaving the bare `woon` handle for the member actually
 * named Woon.
 */
export const SMOKE_MEMBERS: readonly { handle: string; name: string }[] = Object.freeze([
  Object.freeze({ handle: "athena", name: "Athena" }),
  Object.freeze({ handle: "robot-money", name: "Robot Money" }),
  Object.freeze({ handle: "noop-analyst", name: "Noop analyst" }),
  Object.freeze({ handle: "themis", name: "Themis" }),
]);

export function scenarioPlan(smoke: boolean): ScenarioPlan {
  return smoke
    ? {
        kind: "smoke",
        migrateEnv: SMOKE_MIGRATE_ENV,
        migrateScriptArgs: SMOKE_MIGRATE_SCRIPT_ARGS,
        subjects: SMOKE_SUBJECTS,
        members: [],
        runsNewcomerOnboarding: false,
      }
    : {
        kind: "simulation",
        migrateEnv: DEMO_MIGRATE_ENV,
        migrateScriptArgs: DEMO_MIGRATE_SCRIPT_ARGS,
        subjects: DEMO_SUBJECTS,
        members: DEMO_MEMBERS,
        runsNewcomerOnboarding: true,
      };
}

/** Lower-cased allowlisted persona names, the form the roster filter compares. */
export const SMOKE_MEMBER_NAMES: ReadonlySet<string> = Object.freeze(
  new Set(SMOKE_MEMBERS.map((m) => m.name.toLowerCase())),
) as ReadonlySet<string>;

export interface RosterAdoptionOpts {
  /**
   * Seat EVERY active restored member, not only the three committed personas.
   * True for a production-shaped (--smoke) boot on the pinned tunnel port or
   * the smoke-twin data path: those boots hold a throwaway copy of production,
   * so re-keying a restored member at enrollment is free (register rebinds by
   * member id), and seating the full committee is what makes its IC sessions
   * realistic. Never true for a plain simulation boot.
   */
  seatAllActive: boolean;
}

/**
 * Whether THIS boot may seat the full restored committee — the one place that
 * decides it, so the claim can be asserted rather than read off a module body
 * (the same reason resolveSmokeCadenceForBoot() exists).
 *
 * `ownsData()` is the load-bearing term. Seat-all makes adoptionFilter return
 * `() => true`, which drops the three-persona allowlist AND the
 * `personaIdentity()` check that issue #537 added, and enrollment then rebinds
 * every seated member's key and mints a fresh token. `--static-port` is only a
 * CLI flag — stagePreflight() checks nothing but that the port is free — so
 * `--smoke --static-port --db external`, which printResumeHint() itself suggests,
 * would have re-keyed every active member of a REAL restored server. `external`
 * is the one mode this boot does not own and cannot throw away, so it never
 * qualifies however the other flags are set.
 */
export function resolveSeatAllRestored(boot: {
  smoke: boolean;
  stage: boolean;
  dataPath: { kind: DbMode };
}): boolean {
  if (!boot.smoke) return false;
  if (!ownsData(boot.dataPath)) return false;
  return boot.stage || boot.dataPath.kind === "smoke-twin";
}

/**
 * The `hasCommittedIdentity` predicate handed to planAdoptions().
 *
 * Under a smoke boot it is the allowlist AND the committed-identity check: a
 * member outside the three restored personas is refused even if somebody
 * committed a key under their name, and an allowlisted name with no committed
 * key is refused too (adoption seats a member that must be able to SIGN).
 *
 * It NEVER creates or rotates a credential: it answers a question about the
 * committed fixture and returns a boolean. Adoption re-binds an already
 * committed key; minting one for a member the fixture does not know is exactly
 * the duplicate-making behaviour issue #537 keeps out.
 *
 * `opts.seatAllActive` is the twin/stage exception — a production-shaped boot
 * on the pinned port restores members with NO committed fixture, and seating
 * them all (and rotating their keys at enrollment) is the capability that
 * exception exists for. Never set outside that gate.
 */
export function adoptionFilter(
  smoke: boolean,
  // TWO SPELLINGS OF ONE QUESTION, both accepted. `true` is the twin's own
  // shorthand (`adoptionFilter(smoke, twin)`); `{ seatAllActive }` is the
  // generalized boot-level gate resolveSeatAllRestored() answers, which covers
  // the pinned-port stage boot as well as the twin. They mean the same thing
  // here and are deliberately not two behaviours.
  opts: boolean | Partial<RosterAdoptionOpts> = false,
): (name: string) => boolean {
  const seatAll = opts === true || (typeof opts === "object" && opts.seatAllActive === true);
  // A TWIN (or a pinned-port production-shaped boot) seats the WHOLE restored
  // roster, fixture or not.
  //
  // Both rules above exist to protect a PERSISTENT database: a member whose key
  // the smoke invented would be a real member re-keyed by us, and a per-boot
  // container key cannot sign again after a restart. A `--twin` boot has
  // neither hazard. Its database is a throwaway copy of production, restored
  // fresh for this boot and thrown away with it (legacy boot behavior), so
  // nothing we re-key here outlives the boot and nothing we write can
  // reach the real member. What the old rules bought there was a session with 3
  // seats on a roster of 7 — the twin silently exercising less than half the
  // swarm it exists to rehearse.
  //
  // So: under seat-all, every ACTIVE restored member is adoptable. The three
  // with committed keys still sign as themselves; everyone else signs with a key
  // their container generates for this boot alone, which the harness registers
  // through the same privileged shortcut adoption already uses. That is a
  // SIMULATED member — real name, real lens, real history, a signature that is
  // ours and not theirs — and `simulatedSigners()` below is what makes the boot
  // say so out loud rather than leaving it to be inferred from a roster count.
  if (seatAll) return () => true;
  return (name: string) => {
    if (smoke && !SMOKE_MEMBER_NAMES.has(name.trim().toLowerCase())) return false;
    return Boolean(personaIdentity(name));
  };
}

/**
 * Of the members about to be seated, which will sign with a key this boot
 * invented rather than with their own committed identity.
 *
 * Pure, and deliberately name-based: it answers the question the session page
 * cannot ("is this take really theirs?"), so the boot can print it.
 */
export function simulatedSigners(members: readonly { name: string }[]): string[] {
  return members.filter((m) => !personaIdentity(m.name)).map((m) => m.name);
}

/**
 * Active characters on `roster` that nobody is seating — the twin's invariant,
 * as a value rather than as an inline check.
 *
 * A twin exists to rehearse the swarm it restored, so a seat count below the
 * roster count is a defect, and a SILENT one: a session that runs with three of
 * seven members is indistinguishable, on the page, from a session where four
 * members had nothing to say. That is exactly how a 3-of-7 twin ran unnoticed.
 *
 * Distinct by NAME, matching planAdoptions: several active rows for one
 * character are the duplicate-admission residue, and seating that character
 * once covers all of them.
 */
export function unseatedActiveCharacters(
  roster: readonly { name: string; status: string }[],
  seated: readonly { name: string }[],
): string[] {
  const covered = new Set(seated.map((m) => m.name.trim().toLowerCase()));
  const missing = new Map<string, string>();
  for (const m of roster) {
    if (m.status !== "active") continue;
    const key = m.name.trim().toLowerCase();
    if (covered.has(key) || missing.has(key)) continue;
    missing.set(key, m.name);
  }
  return [...missing.values()];
}

/** Return a fresh roster for this run; never mutate module-global members. */
export function adoptRestoredRoster(
  plan: ScenarioPlan,
  roster: readonly RosterMember[],
  seated: readonly ScenarioMember[] = plan.members,
  opts: { twin?: boolean } & Partial<RosterAdoptionOpts> = {},
): ScenarioMember[] {
  const seatAll = opts.twin === true || opts.seatAllActive === true;
  const result = planAdoptions(
    [...roster],
    new Set(seated.map((m) => m.memberId)),
    adoptionFilter(plan.kind === "smoke", { seatAllActive: seatAll }),
  );
  const adopted = result.adopt.map((m) => ({
    memberId: m.id,
    name: m.name,
    lens: m.lens ?? "restored member",
    bias: 0,
    present: true,
  }));
  if (seatAll) {
    const missing = unseatedActiveCharacters(roster, [...seated, ...adopted]);
    if (missing.length) {
      throw new Error(`twin boot left ${missing.length} active roster character(s) unseated: ${missing.join(", ")}`);
    }
  }
  if (plan.kind === "smoke") {
    // Compared by HANDLE (issue #685). The adopted rows carry whatever id this
    // deployment generated, so an id comparison could only ever be satisfied by
    // a seed that hardcoded slug ids — the thing this issue removes. The handle
    // is the stable public key, and `rosterMembers()` reads it off the admin
    // API's `handle` field alongside the id it seats members with. seat-all
    // relents from "exactly these handles" to "these three ARE present": other
    // active restored members are legitimately seated and re-keyed too.
    //
    // ADOPTABLE, not merely allowlisted. Without seat-all, adoptionFilter()
    // refuses any persona with no committed key in
    // scripts/lib/swarm/fixtures/persona-keys.json — `themis`, the judge
    // persona added to the allowlist by issue #922, is one. Comparing the
    // adopted handles against the WHOLE allowlist therefore asserted a set the
    // filter can never produce, so every plain smoke restore threw. The
    // seat-all branch keeps the full list: it seats everyone active, so all
    // four committed personas really must be in the restore.
    const adoptable = SMOKE_MEMBERS.filter((m) => Boolean(personaIdentity(m.name)));
    const expected = adoptable.map((m) => m.handle).sort().join(",");
    const actualSet = new Set(result.adopt.map((m) => m.handle ?? m.id));
    const missing = SMOKE_MEMBERS.filter((m) => !actualSet.has(m.handle)).map((m) => m.handle);
    if (seatAll) {
      if (missing.length > 0) {
        throw new Error(
          `smoke initializer restored no '${missing.join(", ")}' persona(s) (issue #538) — ` +
            `active handles: ${result.adopt.map((m) => m.handle ?? m.id).join(", ") || "none"}`,
        );
      }
    } else {
      const actual = result.adopt.map((m) => m.handle ?? m.id).sort().join(",");
      if (actual !== expected) {
        throw new Error(`smoke initializer expected restored IC handles [${expected}], got [${actual || "none"}]`);
      }
    }
  }
  return [...seated.map((m) => ({ ...m })), ...adopted];
}

// ── Judge role live-stack coverage on a `--twin` boot (issue #845) ──────────
// `--twin` implies its own scenario, so smoke-main.ts's `process.env.CI &&
// dataPath.kind === "smoke-twin"` branch — not scripts/lib/swarm/session.ts's
// `main()` — is what a twin boot actually runs. `noop-analyst` is granted the
// role for this coverage exercise specifically — it is NOT production's real
// standing judge (that is `themis`, SMOKE_MEMBERS) — chosen because it is
// guaranteed present and is not otherwise scheduled to hold the role, so
// exercising grant/flip/assert/restore here never collides with `themis`'s
// real assignment. Selected by its stable HANDLE (never by roster position,
// which the DB query does not promise).

/** The persona granted the judge role for issue #845's smoke-twin coverage —
 *  a coverage-exercise choice, not production's real standing judge. */
export const JUDGE_COVERAGE_HANDLE = "noop-analyst";

/** The restored persona to grant the judge role to; throws on a stale/mismatched restore rather than silently skipping. */
export function judgeCoverageCandidate(roster: readonly RosterMember[]): RosterMember {
  const found = roster.find((m) => m.handle === JUDGE_COVERAGE_HANDLE);
  if (!found) {
    throw new Error(
      `smoke initializer restored no '${JUDGE_COVERAGE_HANDLE}' persona to grant the judge role to (issue #845) — ` +
        `roster handles: ${roster.map((m) => m.handle).join(", ")}`,
    );
  }
  return found;
}

/** `members` with `candidateId` marked absent — a local copy; never mutates the shared array. */
export function withMemberAbsent(members: readonly ScenarioMember[], candidateId: string): ScenarioMember[] {
  return members.map((m) => (m.memberId === candidateId ? { ...m, present: false } : m));
}

export interface ScenarioLifecycleHooks<Context, SessionResult> {
  up(plan: ScenarioPlan, initialize: () => Promise<void>): Promise<Context>;
  initialize(plan: ScenarioPlan): Promise<void>;
  ready(context: Context, plan: ScenarioPlan): Promise<void>;
  session(context: Context, plan: ScenarioPlan): Promise<SessionResult>;
  assert(context: Context, plan: ScenarioPlan, result: SessionResult): Promise<void>;
  cleanup(context: Context | undefined, plan: ScenarioPlan): Promise<void>;
}

/** Shared bounded lifecycle. Stack.up executes initialize before reporting ready. */
export async function runScenarioLifecycle<Context, SessionResult>(
  plan: ScenarioPlan,
  hooks: ScenarioLifecycleHooks<Context, SessionResult>,
): Promise<SessionResult> {
  let context: Context | undefined;
  try {
    context = await hooks.up(plan, () => hooks.initialize(plan));
    await hooks.ready(context, plan);
    const result = await hooks.session(context, plan);
    await hooks.assert(context, plan, result);
    return result;
  } finally {
    await hooks.cleanup(context, plan);
  }
}

/**
 * Does this boot run the scripted newcomer-onboarding driver?
 *
 * Never under smoke: the release topology shows the RESTORED committee, and an
 * invented newcomer joining it is the one thing a production-shaped boot must
 * not show. `bun smoke` is unchanged.
 */
export function runsNewcomerOnboarding(smoke: boolean): boolean {
  return !smoke;
}
