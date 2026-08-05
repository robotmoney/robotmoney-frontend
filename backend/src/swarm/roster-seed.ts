// The LIVE swarm roster: the members a public deployment seats, with the
// profile copy the published site renders.
//
// WHY THIS EXISTS. The apply payload is deliberately minimal (docs/
// architecture.md §11 R6), so an API-created member is admitted with a name and
// an optional lens and nothing else — domain.ts's updateMemberProfile is the
// only route that ever fills in tagline/mandate/biases/mode/operator/avatar,
// and only a member itself can call it. That is correct for members who onboard
// through the real flow, but it leaves the two house members (the ones
// robotmoney.net has published since launch) with no way onto a deployment's
// roster: their copy lives in the committed manifests under
// frontend/public/data/swarm/manifests/members/, which the OLD site read
// directly and this stack does not read at all. A deployment therefore seats
// whatever the demo drivers happened to create — synthetic personas with
// generated taglines — instead of the real swarm.
//
// RELATIONSHIP TO THE v0 ARCHIVE BACKFILL (#498 / backend/scripts/
// v0-seed-bootstrap.ts). That pipeline ports v0's committee HISTORY faithfully
// — 3 members, 4 subjects, 72 sessions — from a checksummed archive, refusing
// to overwrite on drift. This module is the other half of the same cutover and
// deliberately does not duplicate it: it decides WHO IS SEATED NOW. The two
// compose — the archive backfill restores history (including woon, whose
// historical takes must resolve), and this file states the live roster.
//
// SOURCE OF TRUTH is the manifests. The rows below are copied from them by
// hand, exactly like ALLOCATION_FRAMEWORK_SEED copies allocation.json, so this
// module has no runtime filesystem dependency (the migrate/seed one-shot does
// not mount STATIC_DIR). tests/swarm-roster-seed.test.ts reads the manifests
// off disk and asserts field-by-field equality, so the copy cannot drift from
// its source without a red test.
//
// WHO IS NOT HERE, and why:
//   - woon: a real historical member (its manifest, voice doc and archived
//     takes all stay committed) whose operator is onboarding through the real
//     apply → approve → claim → profile flow. Seating it from a seed would
//     hand it a row it could never claim, and would pre-empt the very flow it
//     is about to exercise.
//   - boreas / cygnus / draco and the five demo newcomers (Helios, Selene,
//     Rhea, Nyx, Eos): demo fixtures from backend/src/demo/e2e.ts and
//     scripts/lib/demo-newcomers.ts. They belong to `bun run demo`, not to a
//     public deployment. pruneToLiveRoster() retires the ones an existing
//     deployment already holds.
//
// RETIRING the off-roster members an existing deployment already holds is
// pruneToLiveRoster() at the bottom of this file (issue #530). It is the only
// half that can sweep away an operator admitted through the real apply flow,
// so it carries its own flag (SWARM_SEED_ROSTER_PRUNE) and src/db/seed.ts
// reaches it only when SWARM_SEED_ROSTER is set too: seating stays additive
// and safe on its own, and the sweep is always a deliberate, separate act.
//
// voice_md is deliberately left null: the manifests keep the voice document
// beside them as <id>.voice.md, no route or view reads SwarmMember.voiceMd,
// and inlining ~10KB of markdown here to serve a field nothing renders would
// be a maintenance cost with no reader.
import { sql, jsonValue } from "../db/client.ts";
import { toMember } from "./projections.ts";

export interface RosterSeedMember {
  id: string;
  name: string;
  tagline: string;
  lens: string;
  mandate: string;
  biases: string[];
  mode: string;
  operator: string;
  avatar: { path: string; source_url: string | null; credit: string };
}

// Copied from frontend/public/data/swarm/manifests/members/<id>.json.
// Keep field values byte-identical to the manifest; the drift test compares
// them literally.
export const LIVE_ROSTER: RosterSeedMember[] = [
  {
    id: "athena",
    name: "Athena",
    tagline: "Risk officer. Reads the composite. Looks for what breaks.",
    lens: "quant risk",
    mandate:
      "Read the subject's portfolio through the Robot Money regime composite and correlation card. Find the position that breaks worst in a regime change. Flag concentration, reflexivity, and missing counter-cycle exposure. Be specific about thresholds.",
    biases: ["pro-diversification", "pro-drawdown-survival", "anti-reflexivity", "skeptical-of-illiquidity"],
    mode: "pull",
    operator: "robotmoney",
    avatar: { path: "/avatars/swarm/athena.jpg", source_url: null, credit: "Athena brand mark" },
  },
  {
    id: "robotmoney",
    name: "Robot Money",
    tagline: "Reads chain. Cites mechanism. Closes positions.",
    lens: "institutional treasury",
    mandate:
      "Evaluate the subject's portfolio from the perspective of an autonomous treasury operator. Cite the mechanism behind every judgment — supply schedule, exit liquidity, composability, receipt cadence. Avoid narrative-only takes. Defines positions by what they do, not what they are.",
    biases: ["pro-mechanism", "pro-receipt", "anti-narrative-only", "pro-permanence"],
    mode: "hybrid",
    operator: "robotmoney",
    avatar: { path: "/avatars/swarm/robotmoney.jpg", source_url: null, credit: "Robot Money brand mark" },
  },
];

export const LIVE_ROSTER_IDS: readonly string[] = LIVE_ROSTER.map((m) => m.id);

// Upsert the house members and their profile copy. Returns how many rows the
// roster states (so the caller can log what it seated).
//
// Deliberately does NOT touch keys, applied_at/activated_at, or any column the
// apply/claim flow owns: a seeded member holds no credential and cannot submit
// a take until an operator issues it one through the normal admin path. The
// profile columns ARE overwritten on every run, because the manifest is the
// source of truth for them and a re-run is how corrected copy reaches a live
// deployment. status is forced to 'active' for the same reason — this list IS
// the seated roster.
//
// Idempotent: re-running changes nothing once the rows match.
export async function seedLiveRoster(): Promise<number> {
  for (const m of LIVE_ROSTER) {
    await sql`
      INSERT INTO swarm_members (id, status, name, tagline, lens, mandate, biases, mode, operator, avatar)
      VALUES (${m.id}, 'active', ${m.name}, ${m.tagline}, ${m.lens}, ${m.mandate},
              ${sql.json(jsonValue(m.biases))}, ${m.mode}, ${m.operator}, ${sql.json(jsonValue(m.avatar))})
      ON CONFLICT (id) DO UPDATE SET
        status = 'active',
        name = EXCLUDED.name,
        tagline = EXCLUDED.tagline,
        lens = EXCLUDED.lens,
        mandate = EXCLUDED.mandate,
        biases = EXCLUDED.biases,
        mode = EXCLUDED.mode,
        operator = EXCLUDED.operator,
        avatar = EXCLUDED.avatar
    `;
  }
  return LIVE_ROSTER.length;
}

// Retire every ACTIVE member that is not on the live roster, and report which
// ids were retired (so the caller can log what it swept). Idempotent: a second
// run finds nothing left to retire and returns [].
//
// DEACTIVATES, never deletes. Off-roster members already sat in published
// sessions and own recommendations, memos and attendance rows the archive
// renders by member id (swarm_recommendations.member_id is a plain NOT NULL
// reference with no ON DELETE CASCADE, migrations/0004_committee.sql), and the
// v0 archive backfill adds another set of rows that reference members the same
// way. Deleting would tear holes in published history to tidy up a directory
// listing. status='inactive' is exactly what getMembers() filters on, so the
// roster page shows the live members while every archived session still
// resolves its participants.
//
// Only status='active' rows are touched, which leaves a pending application
// (status='applied') alone: an operator who has applied but not yet been
// approved must still be there for the admin to approve after a convergence
// run.
//
// Separate from seedLiveRoster() and OFF by default because it is the only
// half that can sweep away an operator legitimately admitted through the real
// apply flow — including woon, whom the v0 archive backfill seats as active
// and whom this deliberately retires (decision #502: deactivate, never delete,
// so its historical takes keep resolving by member id). Turn it on
// deliberately, once, when converging a deployment that demo drivers have
// populated.
export async function pruneToLiveRoster(): Promise<string[]> {
  const retired = await sql<{ id: string }[]>`
    UPDATE swarm_members
       SET status = 'inactive', version = version + 1, updated_at = now()
     WHERE status = 'active' AND id <> ALL(${[...LIVE_ROSTER_IDS]})
     RETURNING id`;
  return retired.map((r) => r.id);
}

// Convenience read for the seed log line and for tests: the live roster as the
// API projects it, so a seed run can report what the members endpoint will
// serve rather than what was written.
export async function readLiveRoster() {
  const rows = await sql`
    SELECT * FROM swarm_members WHERE id = ANY(${[...LIVE_ROSTER_IDS]}) ORDER BY id`;
  return rows.map(toMember);
}
