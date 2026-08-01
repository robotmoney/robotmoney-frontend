// Idempotency of joining the committee (scripts/lib/committee/roster-plan.ts).
//
// The bug these pin: the demo admitted its fixed newcomer list from an
// in-process counter that restarted at 0 with the process, so every restart
// re-admitted the same character. The standing demo's persistent database
// accumulated FIVE Helios rows — three active, two stranded in `applied` — one
// per boot, and the personas already there could never take a seat again.
//
// The rules under test:
//   1. A name already on the roster is NEVER admitted again, in any status.
//   2. An unreadable roster SKIPS rather than admits — a duplicate member is
//      permanent, a delayed admission is not.
//   3. Adoption seats each character AT MOST ONCE, even from a roster already
//      polluted with duplicates, and never touches a member that is not one of
//      the demo's own characters.
//   4. Repeating either decision over its own outcome changes nothing — the
//      property "idempotent" actually means, exercised over several boots.
import { describe, expect, test } from "bun:test";
import {
  decideAdmission,
  planAdoptions,
  takenNamesFrom,
  type RosterRow,
} from "../../lib/committee/roster-plan.ts";
import { NEWCOMER_NAMES } from "../../lib/demo-newcomers.ts";
import { personaIdentity } from "../../lib/committee/persona-keys.ts";

const row = (over: Partial<RosterRow> & { name: string }): RosterRow => ({
  id: over.id ?? `id-${over.name.toLowerCase()}`,
  lens: over.lens ?? null,
  status: over.status ?? "active",
  name: over.name,
});

const BUILT_IN = ["Athena", "Boreas", "Cygnus", "Draco"].map((name) => row({ name, id: name.toLowerCase() }));
const hasIdentity = (name: string) => Boolean(personaIdentity(name));

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
    // bug: seating all three would put one character on the committee 3 times.
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
    // Not one of the demo's characters: inventing a key for a real member is
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

describe("committed persona identities back every character the demo can seat", () => {
  test("every newcomer name has a committed keypair, so any of them can be adopted after a restart", () => {
    for (const name of NEWCOMER_NAMES) {
      const id = personaIdentity(name);
      expect(id, `${name} has no committed identity — it could never rejoin after a restart`).toBeDefined();
      expect(typeof id!.publicKeyB64).toBe("string");
      expect(id!.publicKeyB64.length).toBeGreaterThan(0);
    }
  });

  test("the built-in four are covered too", () => {
    for (const name of ["Athena", "Boreas", "Cygnus", "Draco"]) {
      expect(personaIdentity(name)).toBeDefined();
    }
  });

  test("every persona key is DISTINCT — a shared key would let one character sign as another", () => {
    const names = [...NEWCOMER_NAMES, "Athena", "Boreas", "Cygnus", "Draco"];
    const keys = names.map((n) => personaIdentity(n)!.publicKeyB64);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("lookup is case- and whitespace-insensitive, matching how names arrive from the API", () => {
    expect(personaIdentity("  HELIOS ")?.publicKeyB64).toBe(personaIdentity("helios")?.publicKeyB64);
  });
});
