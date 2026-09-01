// THE RECEIPT MUST CARRY EVERY OPINION THE JUDGE REALLY PRODUCES (issue #775).
//
// WHY THIS FILE EXISTS. The consensus receipt schema lives in `contract/` and
// the judge lives in `backend/`, so nothing structural stops the two from
// drifting — and they did. The 1.0 draft required a disagreement to carry at
// least TWO positions, while `parseJudgeResponse()` refuses only an EMPTY
// positions array. A model answer naming a single member under a topic is a
// routine parseable response: it parses, it is persisted into
// `swarm_session_judgements.opinion`, and migration 0032 makes that table
// append-only, so the row can never be removed. Under the draft schema that
// session was then un-anchorable forever, and the assembler's only alternative
// was to pad or drop the disagreement and sign bytes that no longer said what
// the judge said — which is the one property the receipt exists to guarantee.
//
// Reconciled toward the PRODUCER: the schema now says `minItems: 1`, verbatim
// what the parser enforces. This file is the thing that keeps them verbatim.
// It runs a real model answer through the real parser and feeds the resulting
// opinion through the real receipt validator, at BOTH bounds — one position
// must round-trip, zero positions must be refused by both sides — so a future
// change to either bound turns this red rather than producing an opinion the
// signed artifact cannot represent.
//
// NO MOCKING OF EITHER SIDE. `parseJudgeResponse` and `judge()` are the shipped
// functions, the transport is injected rather than reached over a network, and
// the validator is the same `contract/src/consensus-receipt.js` module the
// contract fixture test and issue #754's assembler use.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalizeReceipt,
  participationBps,
  receiptSemanticErrors,
  validateReceipt,
} from "@robotmoney/contract";
import {
  judge, parseJudgeResponse,
  type JudgeInput, type JudgeOpinion, type JudgeOutcome, type JudgeTransport,
} from "../src/swarm/judge.ts";

const FIXTURES = join(import.meta.dir, "../../contract/src/__fixtures__");
const readJson = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

const schema = readJson("consensus-receipt.schema.json");
const spec = readJson("consensus-receipt.canonicalization.json");
const template = readJson("consensus-receipt.valid.json");

const ALPHA_BODY = "Prefer stable yield while retaining measured protocol and agent exposure.";
const BETA_BODY = "Keep a diversified allocation with a larger stable-yield reserve.";

const input: JudgeInput = {
  sessionId: "12440000-0000-4000-8000-000000000001",
  date: "2026-08-26",
  subjectId: "treasury-allocation",
  subjectLabel: "Treasury allocation",
  brief: { prompt: "Allocate the treasury across the four vaults." },
  minTakes: 2,
  byStance: { neutral: 1, constructive: 1 },
  meanConfidence: 0.78,
  regimeSummary: null,
  takes: [
    { member_id: "analyst-alpha", member_name: "Alpha", revision: 1, stance: "constructive", confidence: 0.82, body: ALPHA_BODY },
    { member_id: "analyst-beta", member_name: "Beta", revision: 1, stance: "neutral", confidence: 0.74, body: BETA_BODY },
  ],
};

/** A model answer whose single disagreement names exactly ONE member. */
const ONE_POSITION_ANSWER = JSON.stringify({
  rationale: "Alpha alone argues the stable-yield reserve is oversized; nobody contests it directly.",
  disagreements: [
    {
      topic: "Size of the stable-yield reserve",
      positions: [{ member_id: "analyst-alpha", view: "(discarded — the member's own body is used)" }],
      what_settles: "The next session's regime and liquidity inputs.",
    },
  ],
  release_safety: { release: "safe", concerns: [] },
});

/**
 * The assembler, reduced to exactly the obligations
 * consensus-receipt.canonicalization.json#assembler_obligations states: the
 * judge block is a VERBATIM copy of JudgeOpinion plus the two ENVELOPE fields
 * (`source` and `mode`), `stances` is zero-filled from the sparse rollup, and
 * participation_bps is round-half-up. Nothing here reshapes, pads, or truncates
 * the opinion — that is the point.
 */
function assembleReceipt(opinion: JudgeOpinion, source: "model" | "fallback"): any {
  const submitted = input.takes.length;
  const active = input.takes.length;
  return {
    schema_version: "1.0",
    session_id: input.sessionId,
    subject_id: input.subjectId,
    created_at: "2026-08-26T16:00:00Z",
    prompt_hash: `0x${"1".repeat(64)}`,
    inputs_digest: `0x${"2".repeat(64)}`,
    quorum: { active, submitted, absent: active - submitted, participation_bps: participationBps(submitted, active) },
    stances: {
      bearish: input.byStance.bearish ?? 0,
      cautious: input.byStance.cautious ?? 0,
      neutral: input.byStance.neutral ?? 0,
      constructive: input.byStance.constructive ?? 0,
      bullish: input.byStance.bullish ?? 0,
    },
    // `mode` is always "enforce" in a publishable receipt: the assembler embeds
    // only the judgement the session ADOPTED, and shadow judgements are never
    // applied. See consensus-receipt.ts loadAssemblyInput.
    judge: { ...opinion, source, mode: "enforce" },
    analyst_signatures: template.analyst_signatures,
    weights: template.weights,
  };
}

function assertAnchorable(receipt: any) {
  expect(validateReceipt(receipt, schema)).toEqual([]);
  expect(receiptSemanticErrors(receipt, spec)).toEqual([]);
  expect(canonicalizeReceipt(receipt, spec).startsWith(spec.domain_separator)).toBe(true);
}

test("a ONE-position model answer parses, and the receipt schema accepts it verbatim", () => {
  const opinion = parseJudgeResponse(ONE_POSITION_ANSWER, input);

  // The producer half: one position, and the view is the member's OWN body,
  // not the model's text.
  expect(opinion.disagreements).toHaveLength(1);
  expect(opinion.disagreements[0].positions).toHaveLength(1);
  expect(opinion.disagreements[0].positions[0]).toEqual({ member_id: "analyst-alpha", view: ALPHA_BODY });

  // The receipt half: no error at all, and specifically not the minItems error
  // the 1.0 draft produced for exactly this opinion.
  const receipt = assembleReceipt(opinion, "model");
  const errors = validateReceipt(receipt, schema);
  expect(errors).toEqual([]);
  expect(errors.join(" ")).not.toContain("positions: minItems");
  assertAnchorable(receipt);

  // VERBATIM, asserted as such: the receipt's judge block is the opinion plus
  // one field. Nothing is reshaped on the way in.
  expect(receipt.judge).toEqual({ ...opinion, source: "model", mode: "enforce" });
  expect(Object.keys(receipt.judge)).toEqual(schema.properties.judge.required);
  expect(canonicalizeReceipt(receipt, spec)).toContain(JSON.stringify(ALPHA_BODY).slice(1, -1));
});

test("the two lower bounds coincide: zero positions is refused by the parser AND by the schema", () => {
  const empty = JSON.stringify({
    rationale: "A rationale.",
    disagreements: [{ topic: "T", positions: [], what_settles: "W" }],
    release_safety: { release: "safe", concerns: [] },
  });
  expect(() => parseJudgeResponse(empty, input)).toThrow("malformed_disagreement");

  const receipt = assembleReceipt(
    {
      rationale: "A rationale.",
      disagreements: [{ topic: "T", positions: [], what_settles: "W" }],
      release_safety: { release: "safe", thinly_supported: false, take_count: 2, min_takes: 2, concerns: [] },
    },
    "model",
  );
  expect(validateReceipt(receipt, schema)).toEqual(["/judge/disagreements/0/positions: minItems 1"]);
  expect(schema.definitions.disagreement.properties.positions.minItems).toBe(1);
});

test("both judge() sources round-trip into an anchorable receipt, and source records which ran", async () => {
  // The MODEL path, through the shipped orchestration rather than the parser
  // alone: a transport that returns the one-position answer.
  const transport: JudgeTransport = { model: "test-model", complete: async () => ONE_POSITION_ANSWER };
  const modelOutcome: JudgeOutcome = await judge(input, { transport, timeoutMs: 5_000 });
  expect(modelOutcome.source).toBe("model");
  expect(modelOutcome.opinion.disagreements[0].positions).toHaveLength(1);

  // The FALLBACK path: no transport at all. templateOpinion() is the same prose
  // the aggregator produces, so nothing but `source` distinguishes the two.
  const fallbackOutcome: JudgeOutcome = await judge(input, { transport: null });
  expect(fallbackOutcome.source).toBe("fallback");
  expect(fallbackOutcome.fallbackReason).toBe("model_unconfigured");

  // THE FIELD EARNS ITS PLACE: every other pinned field is byte-identical
  // across the two paths, so a receipt without `source` could not tell them
  // apart at all.
  expect(fallbackOutcome.promptHash).toBe(modelOutcome.promptHash);
  expect(fallbackOutcome.inputsDigest).toBe(modelOutcome.inputsDigest);

  for (const outcome of [modelOutcome, fallbackOutcome]) {
    const receipt = assembleReceipt(outcome.opinion, outcome.source);
    assertAnchorable(receipt);
    expect(receipt.judge.source).toBe(outcome.source);
    expect(canonicalizeReceipt(receipt, spec)).toContain(`"source":"${outcome.source}"`);
  }
});

test("every JudgeOpinion field has a receipt field, and the receipt invents none", () => {
  // A drift guard on the SHAPE rather than on one bound: the judge block's
  // property set is the opinion's property set plus exactly the two ENVELOPE
  // fields — `source` (which produced the prose) and `mode` (whether the
  // session adopted it). Neither is part of JudgeOpinion; both come off the
  // JudgeOutcome envelope and the judgement row, so the split is stated here
  // rather than left to whichever list happens to be longer.
  const ENVELOPE = ["source", "mode"];
  const opinion = parseJudgeResponse(ONE_POSITION_ANSWER, input);
  const receiptKeys = Object.keys(schema.properties.judge.properties);
  expect(receiptKeys.filter((key) => !ENVELOPE.includes(key)).sort()).toEqual(Object.keys(opinion).sort());
  for (const key of ENVELOPE) expect(receiptKeys).toContain(key);
  expect(schema.properties.judge.additionalProperties).toBe(false);

  const rs = opinion.release_safety;
  expect(Object.keys(rs).sort()).toEqual(
    Object.keys(schema.properties.judge.properties.release_safety.properties).sort(),
  );
  expect(Object.keys(opinion.disagreements[0]).sort()).toEqual(
    Object.keys(schema.definitions.disagreement.properties).sort(),
  );
  expect(Object.keys(opinion.disagreements[0].positions[0]).sort()).toEqual(
    Object.keys(schema.definitions.disagreement.properties.positions.items.properties).sort(),
  );
});
