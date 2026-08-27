// WHAT `bun smoke` IS, as data — the pure half of the smoke boot (issue #537).
//
// `bun smoke` and `bun demo` use the same stack, cache policy, readiness,
// session engine, assertions boundary and cleanup. Only scenario initialization
// differs: demo seeds simulation schedules/projects/subjects/members; smoke
// restores the production archive and reconnects its committed IC identities.
//
// Every one of those is a DECISION, not I/O, so it lives here and is executed
// directly by scripts/tests/unit/smoke-mode.test.ts rather than grepped out of
// scripts/lib/demo-main.ts. demo-main.ts holds only the wiring.
//
// NOT in scope here (issue #537's "Out of scope"): the archive import pipeline,
// storage and read paths (#498/#499 own those), the production live-roster
// seed/prune contract (#529/#530 own that), and any database migration.
import { personaIdentity } from "./swarm/persona-keys.ts";
import { planAdoptions } from "./swarm/roster-plan.ts";
import type { RosterMember } from "./swarm/session.ts";
import { demoAttends } from "@robotmoney/contract";

/** The one argv flag that selects a smoke boot. */
export const SMOKE_MODE_FLAG = "--smoke";

/** Is this argv a smoke boot? (`bun smoke` → `bun scripts/demo.ts --smoke`.) */
export function isSmokeMode(argv: readonly string[]): boolean {
  return argv.includes(SMOKE_MODE_FLAG);
}

/**
 * The migrate/seed one-shot's extra env for a SMOKE boot: empty.
 *
 * A production-shaped boot must not carry the project seed switch. Frozen so
 * a caller cannot smuggle a key back in at runtime.
 *
 * The normal-demo counterpart stays spelled out at the `stack.up` call site in
 * scripts/lib/demo-main.ts (the wiring guard in
 * scripts/tests/integration/demo-compose-config.test.ts pins it there).
 */
export const SMOKE_MIGRATE_ENV: Readonly<Record<string, string>> = Object.freeze({});

/** Project seeding is the only normal-demo migration environment setting. */
export const DEMO_MIGRATE_ENV: Readonly<Record<string, string>> =
  Object.freeze({ DEMO_SEED_PROJECTS: "1" });

/** Demo schedules are an explicit migration action, not environment state. */
export const DEMO_MIGRATE_SCRIPT_ARGS: readonly string[] = Object.freeze(["--seed-demo-schedules"]);
export const SMOKE_MIGRATE_SCRIPT_ARGS: readonly string[] = Object.freeze([]);

export interface ScenarioSubject { id: string; name: string }
export interface ScenarioMember {
  memberId: string;
  name: string;
  lens: string;
  bias: number;
  present: boolean;
}
export type ScenarioInitializer = "simulation" | "archive";
export type ScenarioAssertion = "demo" | "archive-continuity";
export interface ScenarioPlan {
  kind: "demo" | "smoke";
  initializer: ScenarioInitializer;
  migrateEnv: Readonly<Record<string, string>>;
  migrateScriptArgs: readonly string[];
  subjects: readonly ScenarioSubject[];
  members: readonly ScenarioMember[];
  assertion: ScenarioAssertion;
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
]);

/** The boot-step names the TUI/step list carries, per mode. Smoke runs ONE
 *  bootstrap step (the production orchestrator); the demo runs its two. */
export function bootstrapStepNames(smoke: boolean): readonly string[] {
  return smoke ? ["archive restore"] : ["simulation seed"];
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
 * The three personas the archive restores, by public HANDLE and display name —
 * the ONLY members a smoke session may seat.
 *
 * This is an allowlist, not a cap: a persistent database can carry members from
 * an earlier demo boot or from a real onboarding, and a smoke boot must seat
 * NONE of them. Their names are the archive's own (the archive's `woon` is
 * displayed as "Noop analyst" after import), so the list is a fact about the
 * archive rather than a preference.
 *
 * HANDLE, NOT ID (issue #685). These used to be the ids `athena`, `robotmoney`
 * and `woon` — the archive's own slugs, which the importer wrote straight into
 * the primary key. Member ids are generated per deployment now
 * (`crypto.randomUUID()`), so a smoke boot has no way to know one in advance
 * and a hardcoded slug matches nothing: the allowlist has to name members by
 * the one key that IS stable across deployments. The handles are derived from
 * the display names by the single `slugifyMemberName` algorithm, which is why
 * "Robot Money" is `robot-money` and not `robotmoney`, and why the archive's
 * `woon` is `noop-analyst` — leaving the bare `woon` handle for the member
 * actually named Woon.
 */
export const SMOKE_MEMBERS: readonly { handle: string; name: string }[] = Object.freeze([
  Object.freeze({ handle: "athena", name: "Athena" }),
  Object.freeze({ handle: "robot-money", name: "Robot Money" }),
  Object.freeze({ handle: "noop-analyst", name: "Noop analyst" }),
]);

export function scenarioPlan(smoke: boolean): ScenarioPlan {
  return smoke
    ? {
        kind: "smoke",
        initializer: "archive",
        migrateEnv: SMOKE_MIGRATE_ENV,
        migrateScriptArgs: SMOKE_MIGRATE_SCRIPT_ARGS,
        subjects: SMOKE_SUBJECTS,
        members: [],
        assertion: "archive-continuity",
        runsNewcomerOnboarding: false,
      }
    : {
        kind: "demo",
        initializer: "simulation",
        migrateEnv: DEMO_MIGRATE_ENV,
        migrateScriptArgs: DEMO_MIGRATE_SCRIPT_ARGS,
        subjects: DEMO_SUBJECTS,
        members: DEMO_MEMBERS,
        assertion: "demo",
        runsNewcomerOnboarding: true,
      };
}

/** Lower-cased allowlisted persona names, the form the roster filter compares. */
export const SMOKE_MEMBER_NAMES: ReadonlySet<string> = Object.freeze(
  new Set(SMOKE_MEMBERS.map((m) => m.name.toLowerCase())),
) as ReadonlySet<string>;

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
 */
export function adoptionFilter(smoke: boolean): (name: string) => boolean {
  return (name: string) => {
    if (smoke && !SMOKE_MEMBER_NAMES.has(name.trim().toLowerCase())) return false;
    return Boolean(personaIdentity(name));
  };
}

/** Return a fresh roster for this run; never mutate module-global members. */
export function adoptRestoredRoster(
  plan: ScenarioPlan,
  roster: readonly RosterMember[],
  seated: readonly ScenarioMember[] = plan.members,
): ScenarioMember[] {
  const result = planAdoptions(
    [...roster],
    new Set(seated.map((m) => m.memberId)),
    adoptionFilter(plan.kind === "smoke"),
  );
  const adopted = result.adopt.map((m) => ({
    memberId: m.id,
    name: m.name,
    lens: m.lens ?? "restored member",
    bias: 0,
    present: true,
  }));
  if (plan.kind === "smoke") {
    // Compared by HANDLE (issue #685). The adopted rows carry whatever id this
    // deployment generated, so an id comparison could only ever be satisfied by
    // a seed that hardcoded slug ids — the thing this issue removes. The handle
    // is the stable public key, and `rosterMembers()` reads it off the admin
    // API's `handle` field alongside the id it seats members with.
    const expected = SMOKE_MEMBERS.map((m) => m.handle).sort().join(",");
    const actual = result.adopt.map((m) => m.handle ?? m.id).sort().join(",");
    if (actual !== expected) {
      throw new Error(`smoke initializer expected restored IC handles [${expected}], got [${actual || "none"}]`);
    }
  }
  return [...seated.map((m) => ({ ...m })), ...adopted];
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
 * not show. `bun demo` is unchanged.
 */
export function runsNewcomerOnboarding(smoke: boolean): boolean {
  return !smoke;
}
