// Idempotency of joining the swarm (scripts/lib/swarm/roster-plan.ts).
//
// The bug these pin: the smoke admitted its fixed newcomer list from an
// in-process counter that restarted at 0 with the process, so every restart
// re-admitted the same character. The standing smoke's persistent database
// accumulated FIVE Helios rows — three active, two stranded in `applied` — one
// per boot, and the personas already there could never take a seat again.
//
// The rules under test:
//   1. A name already on the roster is NEVER admitted again, in any status.
//   2. An unreadable roster SKIPS rather than admits — a duplicate member is
//      permanent, a delayed admission is not.
//   3. Adoption seats each character AT MOST ONCE, even from a roster already
//      polluted with duplicates, and never touches a member this host holds no
//      credential for.
//   4. Repeating either decision over its own outcome changes nothing — the
//      property "idempotent" actually means, exercised over several boots.
//
// THE CREDENTIAL FILE IS THE ONLY IDENTITY SOURCE (issue #1026, spec §6.1).
// Adoption used to ask a committed fixture of persona keys whether a member
// was "ours"; that fixture held eleven usable private keys, three of them
// production-seated members, and it is gone. The question is now asked of the
// credential file's `agents` handles, which a test hands in as a set.
import { describe, expect, test } from "bun:test";
import {
  admissionDelayMs,
  decideAdmission,
  planAdoptions,
  takenNamesFrom,
  type RosterRow,
} from "../../lib/swarm/roster-plan.ts";
import { NEWCOMER_NAMES } from "../../lib/smoke-newcomers.ts";
import {
  SMOKE_MEMBERS,
  adoptRestoredRoster,
  adoptionFilter,
  credentialHandlesOf,
  resolveSeatAllRestored,
  scenarioPlan,
  simulatedSigners,
  unseatedActiveCharacters,
} from "../../lib/smoke-mode.ts";
import type { RosterMember } from "../../lib/swarm/session.ts";

/** A display name's handle, the way slugifyMemberName derives it for these fixtures. */
const slug = (name: string) => name.trim().toLowerCase().replace(/\s+/g, "-");

const row = (over: Partial<RosterRow> & { name: string }): RosterRow => ({
  id: over.id ?? `id-${over.name.toLowerCase()}`,
  handle: over.handle ?? slug(over.name),
  lens: over.lens ?? null,
  status: over.status ?? "active",
  name: over.name,
});

const BUILT_IN = ["Athena", "Boreas", "Cygnus", "Draco"].map((name) => row({ name, id: name.toLowerCase() }));
/** A simulation host's credential file: an `agents` entry for every character it runs. */
const HELD = credentialHandlesOf([...BUILT_IN.map((m) => ({ name: m.handle! })), ...NEWCOMER_NAMES.map((n) => ({ name: slug(n) }))]);
const hasIdentity = adoptionFilter(false, { credentialHandles: HELD });
/** Production's in-house `agents` namespace (the judge `themis` is under `judges`). */
const IN_HOUSE = credentialHandlesOf([{ name: "athena" }, { name: "robot-money" }, { name: "noop-analyst" }]);

describe("decideAdmission — a character joins at most once, ever", () => {
  test("a free name is admitted", () => {
    expect(decideAdmission("Helios", new Set())).toEqual({ admit: true });
  });

  test("a name already on the roster is refused", () => {
    expect(decideAdmission("Helios", new Set(["helios"]))).toEqual({
      admit: false,
      reason: "already-on-roster",
    });
  });

  test("matching ignores case and surrounding whitespace — 'Helios' is 'helios' is ' HELIOS '", () => {
    const taken = new Set(["helios"]);
    for (const spelling of ["Helios", "helios", "HELIOS", "  Helios  "]) {
      expect(decideAdmission(spelling, taken).admit).toBe(false);
    }
  });

  test("an UNREADABLE roster refuses rather than risking a duplicate", () => {
    expect(decideAdmission("Helios", null)).toEqual({ admit: false, reason: "roster-unreadable" });
  });

  test("a name held by a STRANDED application still blocks re-admission", () => {
    // The observed database had two Helios rows stuck at `applied` beside the
    // active ones. Re-admitting such a name just makes a third stranded row.
    const roster = [row({ name: "Helios", id: "u1", status: "applied" })];
    expect(decideAdmission("Helios", takenNamesFrom(roster)).admit).toBe(false);
  });

  test("IDEMPOTENT over boots: the fixed newcomer list drains once and never refills", () => {
    // Boot 1 on an empty database admits the whole list, one per pass.
    const taken = new Set<string>();
    const admitted: string[] = [];
    for (const name of NEWCOMER_NAMES) {
      if (decideAdmission(name, taken).admit) {
        admitted.push(name);
        taken.add(name.toLowerCase()); // the server now holds this member
      }
    }
    expect(admitted).toEqual([...NEWCOMER_NAMES]);

    // Boots 2..5 against that same database admit NOBODY. This is the exact
    // loop that produced one duplicate Helios per restart.
    for (let boot = 0; boot < 4; boot++) {
      for (const name of NEWCOMER_NAMES) {
        expect(decideAdmission(name, taken).admit).toBe(false);
      }
    }
    expect(taken.size).toBe(NEWCOMER_NAMES.length);
  });
});

describe("planAdoptions — every persona takes exactly one seat", () => {
  test("a fresh boot against the built-in roster adopts nobody (they are already seated)", () => {
    const seated = new Set(BUILT_IN.map((m) => m.id));
    expect(planAdoptions(BUILT_IN, seated, hasIdentity).adopt).toEqual([]);
  });

  test("a persona the database knows but this process does not is adopted", () => {
    const roster = [...BUILT_IN, row({ name: "Helios", id: "uuid-helios" })];
    const plan = planAdoptions(roster, new Set(BUILT_IN.map((m) => m.id)), hasIdentity);
    expect(plan.adopt.map((m) => m.name)).toEqual(["Helios"]);
    expect(plan.adopt[0].id).toBe("uuid-helios"); // the id the DATABASE minted, not an invented one
  });

  test("three active Helios rows yield ONE seat and two reported duplicates", () => {
    // Exactly the state the hosted database is in after the duplicate-admission
    // bug: seating all three would put one character on the swarm 3 times.
    const roster = [
      ...BUILT_IN,
      row({ name: "Helios", id: "uuid-1" }),
      row({ name: "Helios", id: "uuid-2" }),
      row({ name: "Helios", id: "uuid-3" }),
    ];
    const plan = planAdoptions(roster, new Set(BUILT_IN.map((m) => m.id)), hasIdentity);
    expect(plan.adopt.map((m) => m.id)).toEqual(["uuid-1"]);
    expect(plan.duplicates.map((m) => m.id)).toEqual(["uuid-2", "uuid-3"]);
  });

  test("non-active rows are never seated", () => {
    const roster = [
      row({ name: "Selene", id: "u-applied", status: "applied" }),
      row({ name: "Rhea", id: "u-deact", status: "deactivated" }),
    ];
    expect(planAdoptions(roster, new Set(), hasIdentity).adopt).toEqual([]);
  });

  test("a member with no committed identity is left alone", () => {
    // Not one of the smoke's characters: inventing a key for a real member is
    // the duplicate-making behaviour this replaces.
    const roster = [row({ name: "Some Real Member", id: "uuid-real" })];
    expect(planAdoptions(roster, new Set(), hasIdentity).adopt).toEqual([]);
  });

  test("IDEMPOTENT over boots: adopting, then re-planning with those seats, adopts nobody new", () => {
    const roster = [...BUILT_IN, row({ name: "Helios", id: "uuid-helios" }), row({ name: "Selene", id: "uuid-selene" })];
    const seated = new Set(BUILT_IN.map((m) => m.id));
    const first = planAdoptions(roster, seated, hasIdentity);
    expect(first.adopt.map((m) => m.name).sort()).toEqual(["Helios", "Selene"]);
    for (const m of first.adopt) seated.add(m.id);
    // Boot 2, same database, same personas: nothing further to adopt, and no
    // seat is taken twice.
    for (let boot = 0; boot < 3; boot++) {
      expect(planAdoptions(roster, seated, hasIdentity).adopt).toEqual([]);
    }
    expect(seated.size).toBe(BUILT_IN.length + 2);
  });

  test("adoption and admission agree: an adopted persona is also refused re-admission", () => {
    // The two decisions must never disagree — that gap is what let a character
    // be seated AND re-admitted as a second member on the same boot.
    const roster = [...BUILT_IN, row({ name: "Helios", id: "uuid-helios" })];
    const plan = planAdoptions(roster, new Set(BUILT_IN.map((m) => m.id)), hasIdentity);
    expect(plan.adopt.map((m) => m.name)).toEqual(["Helios"]);
    expect(decideAdmission("Helios", takenNamesFrom(roster)).admit).toBe(false);
  });
});

describe("the credential file's handles are the only thing adoption asks (persona-keys.json is gone)", () => {
  test("a character is adoptable exactly when the host's credential file names its handle", () => {
    for (const name of [...NEWCOMER_NAMES, "Athena", "Boreas", "Cygnus", "Draco"]) {
      expect(hasIdentity(row({ name })), `${name} is in the credential file`).toBe(true);
    }
    // The SAME character on a host whose file does not name it: not adoptable,
    // whatever a repository once committed under its name.
    const withoutHelios = adoptionFilter(false, { credentialHandles: new Set([...HELD].filter((h) => h !== "helios")) });
    expect(withoutHelios(row({ name: "Helios" }))).toBe(false);
  });

  test("with no credential file configured, a simulation host adopts nobody", () => {
    const roster = [...BUILT_IN, row({ name: "Helios", id: "uuid-helios" })];
    expect(planAdoptions(roster, new Set(), adoptionFilter(false)).adopt).toEqual([]);
    expect(planAdoptions(roster, new Set(), adoptionFilter(false, { credentialHandles: new Set() })).adopt).toEqual([]);
  });

  test("the handle is matched case- and whitespace-insensitively, as the credential file's roster matches names", () => {
    expect(hasIdentity(row({ name: "Helios", handle: "  HELIOS " }))).toBe(true);
    expect(credentialHandlesOf([{ name: " Athena " }]).has("athena")).toBe(true);
  });

  test("a row with no handle falls back to its id, never to its display name", () => {
    const noHandle: RosterRow = { id: "uuid-helios", name: "Helios", status: "active" };
    expect(hasIdentity(noHandle)).toBe(false);
    expect(adoptionFilter(false, { credentialHandles: new Set(["uuid-helios"]) })(noHandle)).toBe(true);
  });
});

describe("admissionDelayMs — a skipped name costs nothing", () => {
  const FIRST = 60_000;
  const INTERVAL = 6 * 3_600_000; // the --stage profile

  test("the first admission of a boot is prompt", () => {
    expect(admissionDelayMs(0, FIRST, INTERVAL)).toBe(FIRST);
  });

  test("later admissions ride the steady interval", () => {
    expect(admissionDelayMs(1, FIRST, INTERVAL)).toBe(INTERVAL);
    expect(admissionDelayMs(4, FIRST, INTERVAL)).toBe(INTERVAL);
  });

  test("skips do not advance the counter, so a restarted smoke still admits promptly", () => {
    // Four personas already in the database: the driver passes over all four
    // without spending an interval on any of them, and the FIRST real admission
    // (the fifth name) is still the prompt one. Counting loop passes instead of
    // admissions would have made this 4 x 6h = a full day of idling.
    const taken = new Set(["helios", "selene", "rhea", "nyx"]);
    let admitted = 0;
    let waited = 0;
    for (const name of NEWCOMER_NAMES) {
      if (!decideAdmission(name, taken).admit) continue; // costs nothing
      waited += admissionDelayMs(admitted, FIRST, INTERVAL);
      admitted++;
    }
    expect(admitted).toBe(1); // only Eos was new
    expect(waited).toBe(FIRST); // …and it arrived on the prompt delay
  });

  test("a fresh database still paces admissions: prompt, then one interval each", () => {
    let admitted = 0;
    const waits: number[] = [];
    for (const name of NEWCOMER_NAMES) {
      if (!decideAdmission(name, new Set()).admit) continue;
      waits.push(admissionDelayMs(admitted, FIRST, INTERVAL));
      admitted++;
    }
    expect(waits).toEqual([FIRST, INTERVAL, INTERVAL, INTERVAL, INTERVAL]);
  });
});

// ── Smoke adoption: the allowlist, exercised through the real planner ───────
// Issue #537. `bun smoke` boots a PRODUCTION-shaped stack whose database holds
// exactly what the production bootstrap put there. A persistent database can
// also carry members from an earlier `bun smoke` boot or from a real
// onboarding, and a smoke session must seat NONE of them, however good their
// credentials are. These drive scripts/lib/smoke-mode.ts's adoptionFilter
// through planAdoptions() — the same call smoke-mode.ts's adoptRestoredRoster
// makes — rather than re-asserting the predicate alone.
describe("planAdoptions under the smoke allowlist (issue #537)", () => {
  const smokeTwinFilter = adoptionFilter(true, { credentialHandles: IN_HOUSE });
  const smokeFilter = adoptionFilter(false, { credentialHandles: IN_HOUSE });
  const RESTORED = [
    row({ name: "Athena", id: "athena" }),
    row({ name: "Robot Money", id: "robotmoney" }),
    row({ name: "Noop analyst", id: "woon" }),
  ];

  test("the three restored personas the credential file names are seated, by id", () => {
    const plan = planAdoptions(RESTORED, new Set(), smokeFilter);
    expect(plan.adopt.map((m) => m.id).sort()).toEqual(["athena", "robotmoney", "woon"]);
    // The ALLOWLIST is spelled in handles, not ids (issue #685): member ids are
    // generated per deployment now, so a literal id list here could only be
    // satisfied by a seed that hardcoded slugs.
    // The allowlist itself names FOUR in-house members (themis, the judge, is
    // the fourth) — this fixture seats three because themis is a `judges`
    // entry, never an `agents` one, so no take seat is hers.
    expect([...SMOKE_MEMBERS].map((m) => m.handle).sort()).toEqual(["athena", "noop-analyst", "robot-money", "themis"]);
    expect([...SMOKE_MEMBERS].some((m) => "id" in m)).toBe(false);
  });

  test("every persisted member outside the allowlist is REJECTED — even one the credential file holds", () => {
    // Boreas/Cygnus/Draco/Helios all HAVE a credential entry on this host, so
    // the plain simulation filter adopts them. That is exactly why the smoke
    // filter has to be an allowlist and not just "does the file hold a key".
    const heldToo = new Set([...IN_HOUSE, "boreas", "cygnus", "draco", "helios"]);
    const outsiders = [
      row({ name: "Boreas", id: "boreas" }),
      row({ name: "Cygnus", id: "cygnus" }),
      row({ name: "Draco", id: "draco" }),
      row({ name: "Helios", id: "helios" }),
      row({ name: "Some Real Member", id: "real-1" }),
    ];
    const smokeTwin = planAdoptions([...RESTORED, ...outsiders], new Set(), adoptionFilter(true, { credentialHandles: heldToo }));
    expect(smokeTwin.adopt.map((m) => m.id).sort()).toEqual(["athena", "robotmoney", "woon"]);
    for (const o of outsiders) expect(smokeTwin.adopt.some((m) => m.id === o.id)).toBe(false);

    // …and the simulation path adopts every character whose key the host holds,
    // and nobody else.
    const smoke = planAdoptions([...RESTORED, ...outsiders], new Set(), adoptionFilter(false, { credentialHandles: heldToo }));
    expect(smoke.adopt.some((m) => m.id === "boreas")).toBe(true);
    expect(smoke.adopt.some((m) => m.id === "real-1")).toBe(false);
  });

  test("an allowlisted persona the credential file does not name is REJECTED", () => {
    // Adoption seats a member that must be able to SIGN, and the credential
    // file is the only place this host keeps a key.
    const withoutNoop = adoptionFilter(true, { credentialHandles: new Set(["athena", "robot-money"]) });
    expect(planAdoptions(RESTORED, new Set(), withoutNoop).adopt.map((m) => m.id).sort()).toEqual(["athena", "robotmoney"]);
  });

  test("names are matched case- and whitespace-insensitively, and only active rows count", () => {
    const roster = [
      row({ name: "  robot money  ", id: "robotmoney", handle: "robot-money" }),
      row({ name: "ATHENA", id: "athena", handle: "athena" }),
      row({ name: "Noop analyst", id: "woon-applied", status: "applied" }),
    ];
    const plan = planAdoptions(roster, new Set(), smokeTwinFilter);
    expect(plan.adopt.map((m) => m.id).sort()).toEqual(["athena", "robotmoney"]);
  });

  test("a duplicate row for a restored persona takes no second seat", () => {
    const roster = [...RESTORED, row({ name: "Athena", id: "athena-dupe" })];
    const plan = planAdoptions(roster, new Set(), smokeFilter);
    expect(plan.adopt.map((m) => m.id).sort()).toEqual(["athena", "robotmoney", "woon"]);
    expect(plan.duplicates.map((m) => m.id)).toEqual(["athena-dupe"]);
  });

  test("adoption creates and rotates NO credential — it only reads the credential file's handles", () => {
    // The filter's whole job is to answer a question. Freeze the handle set
    // before and after a full plan: if any path added, rotated or removed a
    // member, this changes.
    const before = JSON.stringify([...IN_HOUSE]);
    const plan = planAdoptions([...RESTORED, row({ name: "Helios", id: "helios" })], new Set(), smokeTwinFilter);
    expect(plan.adopt.length).toBe(3);
    expect(JSON.stringify([...IN_HOUSE])).toBe(before);
    // Every seated persona signs with a key this host ALREADY holds.
    for (const m of plan.adopt) expect(IN_HOUSE.has(m.handle!)).toBe(true);
  });
});

// ── A TWIN seats the WHOLE restored roster ──────────────────────────────────
// The stage twin ran sessions with three seats while its restored roster showed
// seven active members: the four real ones (DualMint, Maximus, ShodAI, Woon)
// were filtered out for having no key on this host, and the page gave no hint
// that anyone was missing. A twin database is a throwaway copy restored per
// boot, so neither reason for that filter applies to it — see adoptionFilter's
// comment.
describe("planAdoptions on a twin (the whole restored roster)", () => {
  const twinFilter = adoptionFilter(true, { seatAllActive: true });
  // The live stage roster, as the restored production dump actually holds it.
  const RESTORED = [
    row({ name: "Athena", id: "athena" }),
    row({ name: "Robot Money", id: "robotmoney" }),
    row({ name: "Noop analyst", id: "woon-archive" }),
    row({ name: "DualMint", id: "dualmint" }),
    row({ name: "Maximus", id: "maximus" }),
    row({ name: "ShodAI", id: "shodai" }),
    row({ name: "Woon", id: "woon" }),
  ];

  test("every active member is seated, credential or not", () => {
    const plan = planAdoptions(RESTORED, new Set(), twinFilter);
    expect(plan.adopt.map((m) => m.id).sort()).toEqual(
      ["athena", "dualmint", "maximus", "robotmoney", "shodai", "woon", "woon-archive"],
    );
  });

  test("the smoke allowlist is what it replaces — same roster, three seats", () => {
    const plan = planAdoptions(RESTORED, new Set(), adoptionFilter(true, { credentialHandles: IN_HOUSE }));
    expect(plan.adopt.map((m) => m.id).sort()).toEqual(["athena", "robotmoney", "woon-archive"]);
  });

  test("still ACTIVE only, still one seat per character", () => {
    const plan = planAdoptions(
      [
        ...RESTORED,
        row({ name: "Applicant", id: "applied-1", status: "applied" }),
        row({ name: "Retired", id: "gone-1", status: "deactivated" }),
        row({ name: "DualMint", id: "dualmint-dup" }),
      ],
      new Set(),
      twinFilter,
    );
    expect(plan.adopt.some((m) => m.id === "applied-1")).toBe(false);
    expect(plan.adopt.some((m) => m.id === "gone-1")).toBe(false);
    expect(plan.adopt.filter((m) => m.name === "DualMint")).toHaveLength(1);
    expect(plan.duplicates.map((m) => m.id)).toEqual(["dualmint-dup"]);
  });

  test("simulatedSigners names exactly those this host holds no credential for", () => {
    // Athena / Robot Money / Noop analyst have credential-file entries; the four
    // real members do not, so their takes carry OUR signature and the boot says so.
    expect(simulatedSigners(RESTORED, IN_HOUSE).sort()).toEqual(["DualMint", "Maximus", "ShodAI", "Woon"]);
    expect(simulatedSigners([row({ name: "Athena" })], IN_HOUSE)).toEqual([]);
    // With no credential file, every seated member is simulated.
    expect(simulatedSigners([row({ name: "Athena" })], new Set())).toEqual(["Athena"]);
  });
});

describe("unseatedActiveCharacters (the twin's coverage invariant)", () => {
  const roster = [
    row({ name: "Athena" }),
    row({ name: "DualMint" }),
    row({ name: "Retired", status: "deactivated" }),
  ];

  test("empty when every active character is seated", () => {
    expect(unseatedActiveCharacters(roster, [{ name: "Athena" }, { name: "DualMint" }])).toEqual([]);
  });

  test("names whoever was left out — the failure that is otherwise silent", () => {
    expect(unseatedActiveCharacters(roster, [{ name: "Athena" }])).toEqual(["DualMint"]);
  });

  test("an inactive row is not owed a seat, and a name is reported once", () => {
    expect(unseatedActiveCharacters([...roster, row({ name: "DualMint", id: "dup" })], [])).toEqual(
      ["Athena", "DualMint"],
    );
  });

  test("matching is case- and whitespace-insensitive, as planAdoptions is", () => {
    expect(unseatedActiveCharacters(roster, [{ name: " athena " }, { name: "DUALMINT" }])).toEqual([]);
  });
});

// ── seat-all: the twin/stage full-committee restoral ─────────────────────────
// A production-shaped boot on the pinned tunnel port seats the FULL active
// restored committee, not just the three committed personas. Enrollment then
// rotates each restored member's key (register rebinds by member id), so every
// member's agent can sign a real take — the capability these seats exist for.
// The plain simulation smoke stays on the 3-persona allowlist. These pin the
// pure half of the gate (smoke-mode.ts's adoptionFilter seatAllActive +
// adoptRestoredRoster opts) through the same planner smoke-main.ts runs.
describe("seatAllActive — twin/stage seats the full restored committee", () => {
  const RESTORED_FULL: RosterMember[] = [
    { id: "a1", handle: "athena", name: "Athena", lens: null, status: "active" },
    { id: "r1", handle: "robot-money", name: "Robot Money", lens: null, status: "active" },
    { id: "n1", handle: "noop-analyst", name: "Noop Analyst", lens: null, status: "active" },
    // `themis` is the FOURTH in-house member (SMOKE_MEMBERS, issue #922):
    // the named judge, a real LIVE_ROSTER member, so a restored production
    // roster carries it. It is a `judges` entry, never an `agents` one, so
    // seat-all adopts it and the plain smoke allowlist does not — the two
    // expectations below differ for exactly that reason.
    { id: "t1", handle: "themis", name: "Themis", lens: null, status: "active" },
    { id: "d1", handle: "dualmint", name: "DualMint", lens: null, status: "active" },
    { id: "m1", handle: "maximus", name: "Maximus", lens: null, status: "active" },
    { id: "s1", handle: "shodai", name: "ShodAI", lens: null, status: "active" },
    { id: "w1", handle: "woon", name: "Woon", lens: null, status: "active" },
    { id: "nat1", handle: "nat", name: "nat", lens: null, status: "inactive" },
  ];

  test("the seat-all filter adopts every ACTIVE member, credential or not", () => {
    const plan = planAdoptions([...RESTORED_FULL], new Set(), adoptionFilter(true, { seatAllActive: true }));
    expect(plan.adopt.map((m) => m.id).sort()).toEqual(["a1", "d1", "m1", "n1", "r1", "s1", "t1", "w1"]);
  });

  test("the allowlist still excludes the same members when seat-all is OFF", () => {
    const plan = planAdoptions([...RESTORED_FULL], new Set(), adoptionFilter(true, { credentialHandles: IN_HOUSE }));
    expect(plan.adopt.map((m) => m.id).sort()).toEqual(["a1", "n1", "r1"]);
  });

  test("adoptRestoredRoster seats every active restored member and keeps the in-house handles", () => {
    const seated = adoptRestoredRoster(scenarioPlan(true), RESTORED_FULL, [], { seatAllActive: true });
    expect(seated.map((m) => m.memberId).sort()).toEqual(["a1", "d1", "m1", "n1", "r1", "s1", "t1", "w1"]);
    expect(seated.every((m) => m.present)).toBe(true);
  });

  test("seat-all still THROWS when an in-house persona is missing from the restore", () => {
    const noNoop = RESTORED_FULL.filter((m) => m.handle !== "noop-analyst");
    expect(() => adoptRestoredRoster(scenarioPlan(true), noNoop, [], { seatAllActive: true })).toThrow(/no 'noop-analyst'/);
  });

  // THREE, not four: `themis` is allowlisted but is a `judges` entry, so the
  // non-seat-all filter refuses it (see the RESTORED_FULL comment above).
  test("the plain smoke path seats exactly the three personas the credential file's agents name", () => {
    const seated = adoptRestoredRoster(scenarioPlan(true), RESTORED_FULL, [], { credentialHandles: IN_HOUSE });
    expect(seated.map((m) => m.memberId).sort()).toEqual(["a1", "n1", "r1"]);
  });

  test("with no credential file the plain smoke path seats nobody — no key is conjured for a member", () => {
    expect(adoptRestoredRoster(scenarioPlan(true), RESTORED_FULL, [])).toEqual([]);
  });
});

describe("resolveSeatAllRestored — which boots may re-key the committee", () => {
  // Seat-all drops the in-house allowlist AND the credential-file membership
  // check, then enrollment rebinds every seated member's key. So the gate is a
  // safety boundary, not a convenience: it must key off the DATABASE this boot
  // owns, never off the flags alone.
  test("a smoke-twin boot qualifies — a disposable restored copy", () => {
    expect(resolveSeatAllRestored({ smoke: true, stage: false, dataPath: { kind: "smoke-twin" } })).toBe(true);
  });

  test("a --stage boot on this boot's own ephemeral postgres qualifies", () => {
    expect(resolveSeatAllRestored({ smoke: true, stage: true, dataPath: { kind: "ephemeral" } })).toBe(true);
  });

  test("--db external NEVER qualifies, even with --stage", () => {
    // The regression this gate exists for: printResumeHint() suggests
    // `--static-port --db external`, and --static-port is just a CLI flag that
    // stagePreflight() never checks a database against. Re-keying every active
    // member of a real restored server is not something a flag should buy.
    expect(resolveSeatAllRestored({ smoke: true, stage: true, dataPath: { kind: "external" } })).toBe(false);
    expect(resolveSeatAllRestored({ smoke: true, stage: false, dataPath: { kind: "external" } })).toBe(false);
  });

  test("a plain simulation boot never qualifies, whatever the database", () => {
    for (const kind of ["ephemeral", "external", "smoke-twin"] as const) {
      expect(resolveSeatAllRestored({ smoke: false, stage: true, dataPath: { kind } })).toBe(false);
    }
  });

  test("an ordinary ephemeral smoke without --stage still seats only the three personas", () => {
    expect(resolveSeatAllRestored({ smoke: true, stage: false, dataPath: { kind: "ephemeral" } })).toBe(false);
  });
});

// ── C-26: scenarioPlan's `kind` must distinguish restore from seed ──────────
// The bug: an earlier demo→smoke rename blindly replaced the literal "demo"
// with "smoke", collapsing `kind: "demo" | "smoke"` into `kind: "smoke" |
// "smoke"`. adoptRestoredRoster() branches on `plan.kind === "smoke"` to run
// the archive-continuity check ("we restored an archive, so the three
// committed personas MUST be present"). With the union collapsed, that check
// ran even for a plain simulation boot (no `--smoke`, nothing restored), so
// `bun run smoke:stage` against a fresh database failed at startup with
// "smoke initializer expected restored IC handles [...], got [none]" although
// nothing was ever supposed to be restored.
describe("scenarioPlan — kind distinguishes archive-restore from a plain simulation boot", () => {
  test("the two boot plans carry genuinely distinct kinds", () => {
    expect(scenarioPlan(false).kind).not.toBe(scenarioPlan(true).kind);
  });

  test("a plain simulation boot with nothing restored does not run the archive-continuity check", () => {
    expect(() => adoptRestoredRoster(scenarioPlan(false), [])).not.toThrow();
  });

  test("a real archive-restore boot still requires every persona the credential file names", () => {
    expect(() => adoptRestoredRoster(scenarioPlan(true), [], [], { credentialHandles: IN_HOUSE })).toThrow(
      /expected restored IC handles \[athena,noop-analyst,robot-money\]/,
    );
  });
});

describe("judge-role members are never seats (2026-09-25 twin: Themis refused judge_role_cannot_submit_takes every session)", () => {
  test("planAdoptions skips an active judge", () => {
    const roster = [
      { id: "a", handle: "athena", name: "Athena", status: "active", role: "member" },
      { id: "t", handle: "themis", name: "Themis", status: "active", role: "judge" },
    ];
    const plan = planAdoptions(roster, new Set(), () => true);
    expect(plan.adopt.map((m) => m.handle)).toEqual(["athena"]);
  });

  test("a row with no role is an analyst, as before the role column", () => {
    expect(planAdoptions([{ id: "a", name: "Athena", status: "active" }], new Set(), () => true).adopt).toHaveLength(1);
  });

  test("an unseated judge is not an unseated character", () => {
    const roster = [
      { name: "Athena", status: "active", role: "member" },
      { name: "Themis", status: "active", role: "judge" },
    ];
    expect(unseatedActiveCharacters(roster, [{ name: "Athena" }])).toEqual([]);
  });
});
