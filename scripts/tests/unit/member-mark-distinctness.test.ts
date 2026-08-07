// Population coverage for the derived member mark (issue #560, RM-48).
//
// WHY THIS FILE EXISTS RATHER THAN ONLY THE BROWSER SPEC.
// frontend/test/browser/swarm-index.spec.ts asserts `new Set(shapes).size ===
// 3` over three hand-picked member ids. That shape of test cannot fail on a
// broken generator: it samples three seeds out of an unbounded space and asks
// only that those three disagree. It passed green while `memberMark("woon")`
// and `memberMark("noop-analyst")` — two ids on the committed roster in
// frontend/public/data/swarm/manifests/members/ — returned byte-identical SVG,
// because neither was one of the three it picked.
//
// The defect it missed: bytes() ended `out.push(h & 0xff)`. Math.imul is a
// multiply mod 2^32, so the low 8 bits of a product depend only on the low 8
// bits of the operands; with XOR being bitwise, the low byte of the FNV state
// evolved in a closed 8-bit system. Effective state: one byte. Measured over
// 50,000 random UUID seeds, the 40px form produced 140 distinct marks and the
// 20px form produced 4.
//
// So the assertion here is POPULATION-SHAPED: drive tens of thousands of
// generated seeds through the shipped module and require that almost all of
// them disagree. That is the only formulation that goes red on a generator
// whose output space has silently collapsed, whichever seeds happen to be on
// the roster on the day.
//
// The seed population is generated from a fixed-seed PRNG rather than
// crypto.randomUUID(), so a failure is reproducible and a pass is not luck.
//
// Runs in the required `unit.yml` job — `bun run test:unit`, and again in that
// workflow's `bun run test` sweep over scripts/tests. No external resource, no
// DOM, no network: memberMark() is pure, so there is nothing here to skip on.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MARK_PALETTE, memberMark, QUADRANT_MIN_PX } from "../../../frontend/public/assets/js/app/lib/member-mark.js";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

// ── A deterministic seed population ─────────────────────────────────────────
// xorshift32, fixed seed. Produces UUIDv4-shaped strings, which is the real
// shape of a funnel member's id (the manifest roster uses slugs; both are
// covered below).
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

function uuidPopulation(count: number, rngSeed = 0x5eed1234): string[] {
  const rng = makeRng(rngSeed);
  const hex = "0123456789abcdef";
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let s = "";
    for (let c = 0; c < 32; c++) {
      if (c === 8 || c === 12 || c === 16 || c === 20) s += "-";
      s += hex[rng() % 16];
    }
    out.push(s);
  }
  return out;
}

const POPULATION = 20_000;
const SEEDS = uuidPopulation(POPULATION);

// The two rendered sizes the shipped call sites actually ask for (40px in the
// roster row and the take byline, 80px on the profile hero) both take the
// four-quadrant branch. 20px is the small branch; it is measured here as well
// because QUADRANT_MIN_PX makes it reachable the moment a caller asks for it.
const LARGE = 40;
const SMALL = 20;

function distinct(seeds: string[], size: number): number {
  const seen = new Set<string>();
  for (const s of seeds) seen.add(memberMark(s, size));
  return seen.size;
}

describe("memberMark() produces a distinct mark per member across a whole population (#560)", () => {
  // Canary against a vacuous pass: if the population were empty or memberMark
  // returned "" for every seed, every distinctness assertion below would still
  // need something to have been computed.
  test("the population was really generated and really rendered", () => {
    expect(SEEDS.length).toBe(POPULATION);
    expect(new Set(SEEDS).size).toBe(POPULATION); // the seeds themselves are unique
    const rendered = SEEDS.slice(0, 50).map((s) => memberMark(s, LARGE));
    for (const svg of rendered) {
      expect(svg).toContain("<svg");
      expect(svg.length).toBeGreaterThan(64);
    }
  });

  // THE THRESHOLD. Measured over this exact 20,000-seed population:
  //   * the old `h & 0xff` extraction:       140 distinct marks (0.7%)
  //   * the shipped xor-fold extraction:  16,810 distinct marks (84.1%)
  // 16,000 (80%) sits two orders of magnitude above anything the broken
  // generator can reach and comfortably below what the working one delivers,
  // so this assertion is a genuine discriminator rather than a rubber stamp.
  // (84% rather than ~100% is the birthday cost of drawing 20,000 times from
  // an effective space of ~49,000 — see the ceiling note on the 20px test.)
  test(`at ${LARGE}px, ${POPULATION} distinct seeds yield near-distinct marks`, () => {
    const n = distinct(SEEDS, LARGE);
    expect(
      n,
      `memberMark() at ${LARGE}px produced only ${n} distinct marks over ${POPULATION} distinct seeds ` +
        `(${((n / POPULATION) * 100).toFixed(1)}%). Expected >= 16000. The working generator scores 16810; ` +
        `the pre-fix low-byte extraction (out.push(h & 0xff) in bytes()) scored 140. A number in that ` +
        `neighbourhood means the hash's effective state has collapsed again — see the "NEVER TAKE THE LOW ` +
        `BYTE" note in member-mark.js.`,
    ).toBeGreaterThanOrEqual(16_000);
  });

  // The small form is a TWO-cell mark, so its reachable space is small by
  // construction and no hash can widen it: enumerating every (hue pair, fill,
  // cell-mode) combination the encoder can emit gives EXACTLY 608 distinct
  // marks, and the shipped generator reaches all 608. That is an inherent
  // limit of the form, not of the generator. What this assertion catches is
  // the generator falling below the form's own ceiling — the broken extraction
  // reached 4.
  test(`at ${SMALL}px the two-cell form reaches its own ceiling, narrow as that ceiling is`, () => {
    const n = distinct(SEEDS, SMALL);
    expect(
      n,
      `memberMark() at ${SMALL}px produced only ${n} distinct marks over ${POPULATION} seeds. The two-cell ` +
        `form's measured ceiling with ideal random bytes is ~608, and the working generator reaches it; ` +
        `the pre-fix low-byte extraction reached 4. Expected >= 500.`,
    ).toBeGreaterThanOrEqual(500);
    // Stated plainly rather than left implicit: this branch IS narrow. ~608
    // marks means a 50-member roster has a ~94% chance of a duplicate pair at
    // this size. It is unreachable from the shipped call sites (all ask for
    // 40px or 80px, both >= QUADRANT_MIN_PX); anything that starts asking for
    // a sub-threshold size needs a wider small form, not a different hash.
    expect(QUADRANT_MIN_PX).toBeGreaterThan(SMALL);
  });

  // Independence of the population: a different PRNG seed must not change the
  // conclusion. Guards against a threshold that only clears for one lucky set.
  test(`the ${LARGE}px result holds on an independently generated population`, () => {
    const other = uuidPopulation(POPULATION, 0xc0ffee01);
    expect(new Set(other).size).toBe(POPULATION);
    const n = distinct(other, LARGE);
    // 16,811 working / 140 broken, i.e. the same verdict as population A.
    expect(n, `second population scored ${n} distinct marks; expected >= 16000`).toBeGreaterThanOrEqual(16_000);
  });

  // Slug-shaped ids, not just UUIDs. The committed manifest roster uses slugs
  // and the funnel uses UUIDs; both must spread.
  // Sequential slugs are the adversarial case for a weak mixer: 2,000 seeds
  // differing by one or two characters. Working: 1,964 distinct. Broken: 114.
  test("short slug-shaped ids spread too", () => {
    const slugs: string[] = [];
    for (let i = 0; i < 2_000; i++) slugs.push(`member-${i}`);
    const n = distinct(slugs, LARGE);
    expect(n, `2000 sequential slug ids produced only ${n} distinct marks; expected >= 1900`).toBeGreaterThanOrEqual(1_900);
  });
});

describe("the roster collisions that shipped under the low-byte extraction (#560 regression pins)", () => {
  // These four are real ids in frontend/public/data/swarm/manifests/members/.
  // Under `out.push(h & 0xff)` the first pair rendered IDENTICAL SVG at 40px,
  // and at 20px all four collapsed onto two marks. Pinned by name so the exact
  // reported defect cannot come back unnoticed.
  const ROSTER = ["woon", "noop-analyst", "athena", "robotmoney"];

  test("woon and noop-analyst do not share a mark", () => {
    const woon = memberMark("woon", LARGE);
    const noop = memberMark("noop-analyst", LARGE);
    expect(woon).not.toBe("");
    expect(
      woon,
      "memberMark('woon') === memberMark('noop-analyst'): the two committed roster members are rendering " +
        "the same mark. This is the exact defect the low-byte extraction shipped with.",
    ).not.toBe(noop);
    expect(memberMark("woon", SMALL)).not.toBe(memberMark("noop-analyst", SMALL));
  });

  test("the other reported colliding pairs are distinct", () => {
    for (const [a, b] of [["hermes", "kronos"], ["selene", "zephyr"]] as const) {
      expect(memberMark(a, LARGE), `memberMark(${a}) === memberMark(${b})`).not.toBe(memberMark(b, LARGE));
    }
  });

  test("every committed roster member has its own mark at both branch sizes", () => {
    for (const size of [LARGE, SMALL]) {
      const marks = ROSTER.map((id) => memberMark(id, size));
      const dupes = ROSTER.filter((id, i) => marks.indexOf(marks[i]) !== i);
      expect(dupes, `roster members sharing a mark at ${size}px: ${dupes.join(", ")}`).toEqual([]);
    }
  });

  test("a mark is a pure function of the seed", () => {
    for (const id of ROSTER) expect(memberMark(id, LARGE)).toBe(memberMark(id, LARGE));
    expect(memberMark("", LARGE)).toBe("");
  });

  // The covenant, re-asserted on the population rather than on four ids: no
  // fill a member can land on is outside the sanctioned palette, so the "cyan
  // is never a figure / beacon means loss" rule cannot be broken by a hash
  // change that reshuffles which member gets which hue.
  test("no seed in the population can produce a fill outside MARK_PALETTE", () => {
    const allowed = new Set(MARK_PALETTE.map((h: string) => h.toLowerCase()));
    expect(allowed.size).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const s of SEEDS.slice(0, 5_000)) {
      for (const m of memberMark(s, LARGE).matchAll(/fill="([^"]+)"/g)) seen.add(m[1].toLowerCase());
    }
    expect(seen.size).toBeGreaterThan(0);
    expect([...seen].filter((f) => !allowed.has(f)), "fills outside MARK_PALETTE").toEqual([]);
  });
});

// ── Call-site lockstep ──────────────────────────────────────────────────────
// member-mark.js's header promises "the same mark on every page". That holds
// only while every template seeds it with the same expression. session.html
// used to pass a bare `t.memberId` where the roster and profile pass
// `keyFingerprint || id` — identical today, since no projection carries a
// fingerprint, and silently divergent on the day one does.
describe("every memberMark() call site seeds it the same way", () => {
  const SITES = [
    "frontend/public/views/swarm.html",
    "frontend/public/views/swarm/member.html",
    "frontend/public/views/swarm/session.html",
  ];

  test("all three templates pass a `<keyFingerprint> || <id>` seed, never a bare id", () => {
    const calls: Array<{ file: string; seed: string }> = [];
    for (const rel of SITES) {
      const src = readFileSync(join(REPO_ROOT, rel), "utf8");
      for (const m of src.matchAll(/memberMark\(\s*([^,]+?)\s*,/g)) calls.push({ file: rel, seed: m[1] });
    }
    // Canary: if the templates stop calling memberMark(), or the regex stops
    // matching them, the filter below would pass over an empty list.
    expect(calls.length, "no memberMark() call sites found in the swarm templates").toBe(3);
    expect(new Set(calls.map((c) => c.file)).size).toBe(3);

    const bare = calls.filter(({ seed }) => !/KeyFingerprint\s*\|\|\s*\S/i.test(seed));
    expect(
      bare,
      "these memberMark() call sites pass a bare id instead of `<keyFingerprint> || <id>`, so their marks " +
        "will diverge from the rest of the site the moment a fingerprint reaches the projection:\n" +
        bare.map((b) => `  ${b.file}: memberMark(${b.seed}, ...)`).join("\n"),
    ).toEqual([]);
  });
});
