// PROJECT FUSION RC2 — THE ANALYST'S OWN ALLOCATION, at the layer that authors it.
//
// The upstream half of the v0.5.0-rc.1 blocker: no analyst code path could
// state a bucket weight, so every `bucket_weights` receipt was silent about the
// allocation. This file pins the take-authoring CONTRACT hermetically (no
// spawn, no network, no database): the prompt asks for the vector only when the
// session asks for one, the parser accepts exactly the canonical four, and
// every malformed shape is a loud refusal rather than a fabricated allocation.
//
// The publish-side half — the vector reaching the receipt as 10,000 bps, and
// the named refusal when it does not — is pinned in
// backend/tests/swarm-analyst-weights-receipt.test.ts.
import { describe, expect, test } from "bun:test";
import { RECEIPT_CANONICAL_BUCKET_ORDER } from "@robotmoney/contract";
import {
  parseStanceFromBody,
  parseWeightsFromBody,
  promptFor,
  TAKE_SECTION_LEAD_INS,
  TAKE_WEIGHT_BUCKETS,
  TAKE_WEIGHTS_LEAD_IN,
} from "../../lib/swarm/inference.ts";

const CANON = [...RECEIPT_CANONICAL_BUCKET_ORDER];
const PERSONA = { memberId: "athena", name: "Athena", lens: "macro", bias: 0.2 };
const REGIME = { composite: 0.42 };

const PROSE = [
  "**REGIME**", "- composite 0.42 in the 38th percentile",
  "**ALLOCATION**", "- the 95/5/0/0 target is too defensive",
  "**SUBJECT**", "- woon is under-exposed to the agent sleeve",
].join("\n");

const weightsLine = (entries: string) => `${TAKE_WEIGHTS_LEAD_IN} ${entries}`;
const FOUR = "agent_tokens=0.15 | conservative_defi_yield=0.70 | protocol_tokens=0.10 | real_world_assets=0.05";

// ── The bucket vocabulary is DERIVED, never re-declared ─────────────────────
test("the take's buckets are the receipt's canonical four, by derivation", () => {
  expect(TAKE_WEIGHT_BUCKETS).toEqual(CANON);
});

describe("parseWeightsFromBody — the vector, or a loud refusal", () => {
  test("parses the four buckets and strips the control line from the stored body", () => {
    // The two control lines are the last two lines, STANCE last: each parser
    // reads the line the previous one uncovered.
    const parsed = parseStanceFromBody([PROSE, weightsLine(FOUR), "STANCE: constructive | CONFIDENCE: 0.62"].join("\n"));
    const withWeights = parseWeightsFromBody(parsed.body);
    expect(withWeights.weights).toEqual([
      { bucket: "agent_tokens", weight: 0.15 },
      { bucket: "conservative_defi_yield", weight: 0.7 },
      { bucket: "protocol_tokens", weight: 0.1 },
      { bucket: "real_world_assets", weight: 0.05 },
    ]);
    // THE DECIDING PROPERTY (see the RC2 bundle's two-designs run): the
    // allocation exists exactly ONCE in what gets signed — in `weights`, which a
    // receipt verifier can recompute — and NOT in `body`, which the receipt
    // copies verbatim into the judge's prose and nobody can recompute.
    expect(withWeights.body).toBe(PROSE);
    expect(withWeights.body).not.toContain(TAKE_WEIGHTS_LEAD_IN);
    // And the three prose sections survive intact, so the section contract is
    // still checked against the body the member actually stores.
    for (const lead of TAKE_SECTION_LEAD_INS) expect(withWeights.body).toContain(lead);
  });

  test("emits canonical bucket order whatever order the model wrote", () => {
    const scrambled = "real_world_assets=5 | agent_tokens=15 | protocol_tokens=10 | conservative_defi_yield=70";
    const parsed = parseWeightsFromBody([PROSE, weightsLine(scrambled)].join("\n"));
    expect(parsed.weights.map((w) => w.bucket)).toEqual(CANON);
    // Percentages and fractions are the SAME vector — the server normalizes by
    // the total — so the parser carries the numbers raw and rescales nothing.
    expect(parsed.weights.map((w) => w.weight)).toEqual([15, 70, 10, 5]);
  });

  test("accepts a zero bucket, which is a real allocation", () => {
    const zeroRwa = "agent_tokens=0.05 | conservative_defi_yield=0.95 | protocol_tokens=0 | real_world_assets=0";
    expect(parseWeightsFromBody([PROSE, weightsLine(zeroRwa)].join("\n")).weights.map((w) => w.weight))
      .toEqual([0.05, 0.95, 0, 0]);
  });

  // ── The decoration the STANCE parser already tolerates ────────────────────
  // `parseStanceFromBody` matches its control line ANYWHERE in the last line.
  // This one used to be anchored at the start, so markdown the stance parser
  // shrugs off cost the member its whole take — a re-sample, then ABSENT, and
  // with min_takes=3 against a three-member roster, the session's quorum.
  for (const [label, line] of [
    ["bold markdown around the label", "**WEIGHTS:** " + FOUR],
    ["a leading bullet", "- " + weightsLine(FOUR)],
    ["a leading asterisk bullet", "* " + weightsLine(FOUR)],
    ["comma separators", weightsLine(FOUR.replace(/ \| /g, ", "))],
    ["a trailing period", weightsLine(FOUR) + "."],
    ["bold, bulleted, comma-separated and full-stopped at once", "- **WEIGHTS:** " + FOUR.replace(/ \| /g, ", ") + "."],
  ] as const) {
    test(`tolerates ${label} — a formatting quirk costs a re-sample at worst, never a take`, () => {
      const parsed = parseWeightsFromBody([PROSE, line].join("\n"));
      expect(parsed.weights.map((w) => w.bucket)).toEqual(CANON);
      expect(parsed.weights.map((w) => w.weight)).toEqual([0.15, 0.7, 0.1, 0.05]);
      expect(parsed.body).toBe(PROSE);
    });
  }

  test("a sentence merely CONTAINING the word is still a missing line, not an unparseable one", () => {
    // The colon stays mandatory precisely so widening the match cannot turn
    // prose into a bad-entry refusal and hide which clause actually failed.
    const prosey = [PROSE, "The weights above should be revisited next week."].join("\n");
    expect(() => parseWeightsFromBody(prosey)).toThrow(/missing its trailing "WEIGHTS:/);
  });

  // ── One notation per line ─────────────────────────────────────────────────
  test("REFUSES a line that mixes percentages and fractions", () => {
    // The shape that silently produced a DIFFERENT allocation: `%` was stripped
    // and the value kept raw, so 10% / 0.85 / 0.04 / 0.01 normalized to
    // 91.74 / 7.80 / 0.37 / 0.09 — signed by the analyst and verifiable by the
    // receipt, because the verifier recomputes the same mean from the same
    // signed bytes. Nothing downstream could ever have caught it.
    const mixed = "agent_tokens=10% | conservative_defi_yield=0.85 | protocol_tokens=0.04 | real_world_assets=0.01";
    expect(() => parseWeightsFromBody([PROSE, weightsLine(mixed)].join("\n")))
      .toThrow(/MIXES percentages and fractions/);
  });

  test("all-percent and all-fraction are both fine, and are carried raw", () => {
    const allPct = "agent_tokens=15% | conservative_defi_yield=70% | protocol_tokens=10% | real_world_assets=5%";
    expect(parseWeightsFromBody([PROSE, weightsLine(allPct)].join("\n")).weights.map((w) => w.weight))
      .toEqual([15, 70, 10, 5]);
    expect(parseWeightsFromBody([PROSE, weightsLine(FOUR)].join("\n")).weights.map((w) => w.weight))
      .toEqual([0.15, 0.7, 0.1, 0.05]);
  });

  for (const [label, line, pattern] of [
    ["a missing control line", PROSE, /missing its trailing "WEIGHTS:/],
    ["a partial vector", weightsLine("agent_tokens=0.5 | conservative_defi_yield=0.5"), /missing protocol_tokens, real_world_assets/],
    ["an unknown bucket", weightsLine(`${FOUR} | gold=0.1`), /unsupported gold/],
    ["a duplicated bucket", weightsLine(`${FOUR} | agent_tokens=0.2`), /names bucket 'agent_tokens' twice/],
    ["a negative share", weightsLine("agent_tokens=0.15 | conservative_defi_yield=0.9 | protocol_tokens=0.1 | real_world_assets=-0.15"), /unparseable entry/],
    ["an all-zero vector", weightsLine("agent_tokens=0 | conservative_defi_yield=0 | protocol_tokens=0 | real_world_assets=0"), /allocates nothing/],
    ["prose where a number belongs", weightsLine("agent_tokens=a little | conservative_defi_yield=most"), /unparseable entry/],
  ] as const) {
    test(`refuses ${label} rather than fabricating an allocation`, () => {
      const text = line === PROSE ? PROSE : [PROSE, line].join("\n");
      expect(() => parseWeightsFromBody(text)).toThrow(pattern);
    });
  }
});

describe("promptFor — the ask matches what the session wants", () => {
  test("a bucket_weights subject is asked for the vector, by name, over all four buckets", () => {
    const prompt = promptFor(PERSONA, REGIME, "robotmoney-allocation", { requireWeights: true });
    expect(prompt).toContain(TAKE_WEIGHTS_LEAD_IN);
    for (const bucket of CANON) expect(prompt).toContain(bucket);
    // The WEIGHTS line comes BEFORE the STANCE line, because parseStanceFromBody
    // takes the LAST line and uncovers the weights line beneath it.
    expect(prompt.indexOf(TAKE_WEIGHTS_LEAD_IN)).toBeLessThan(prompt.lastIndexOf("STANCE:"));
    // The prompt's own last two lines are exactly the two control lines.
    const tail = prompt.trimEnd().split("\n").slice(-2);
    expect(tail[0].startsWith(TAKE_WEIGHTS_LEAD_IN)).toBe(true);
    expect(tail[1].startsWith("STANCE:")).toBe(true);
  });

  test("a position_actions subject is asked for nothing numeric", () => {
    const prompt = promptFor(PERSONA, REGIME, "woon");
    expect(prompt).not.toContain(TAKE_WEIGHTS_LEAD_IN);
    // Unchanged from the shipped prompt: one trailing control line.
    expect(prompt.trimEnd().split("\n").slice(-1)[0].startsWith("STANCE:")).toBe(true);
    // The three prose sections are demanded in both shapes.
    for (const lead of TAKE_SECTION_LEAD_INS) expect(prompt).toContain(lead);
  });
});
