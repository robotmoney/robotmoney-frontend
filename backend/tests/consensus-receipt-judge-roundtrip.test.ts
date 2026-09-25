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
// NO MOCKING OF EITHER SIDE. `parseJudgeResponse` is the shipped parser the API
// runs over every judgement, the model's answer arrives through the shipped
// participant runner (`scripts/agent/participant/judge-runner.ts`) on its real
// transport against a local vendor-shaped endpoint, and the validator is the
// same `contract/src/consensus-receipt.js` module the contract fixture test and
// issue #754's assembler use. The backend `judge()` this file used to drive is
// deleted (D53 point 4): the judge is a participant, and this is its path.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalizeReceipt,
  participationBps,
  receiptSemanticErrors,
  validateReceipt,
} from "@robotmoney/contract";
import {
  inputsDigest, parseJudgeResponse, renderJudgePrompt,
  type JudgeInput, type JudgeOpinion,
} from "../src/swarm/judge.ts";
import { runJudge } from "../../scripts/agent/participant/judge-runner.ts";
import { judgeInputFromFrozen, TAKE_REVISION_DEFAULT, takeRevision, type FrozenTakeSet } from "../src/swarm/domain.ts";
import { toTake } from "../src/swarm/projections.ts";
import type { DbHandle } from "../src/db/client.ts";

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

/** Run the participant's runner against a local endpoint answering `status`/`body`. */
async function throughTheRunner(status: number, body: string) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(body, { status, headers: { "content-type": "application/json" } }),
  });
  const dir = mkdtempSync(join(tmpdir(), "rm-roundtrip-"));
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, renderJudgePrompt(input));
  try {
    return await runJudge({
      promptFile, endpoint: `http://127.0.0.1:${server.port}`, model: "deepseek-v4-flash", apiKey: "k", timeoutMs: 5_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    server.stop(true);
  }
}

// ISSUE #969 REMOVED ONE OF THE TWO SOURCES, AND D53 DELETED THE CODE THAT HAD
// IT. A receipt is a signed attestation, and one carrying template prose under
// the judge's name attests to a judging that never happened. A NEW receipt can
// carry exactly one source: a model's answer, parsed by the API.
test("a model judgement round-trips into an anchorable receipt, and `source` records that it was one", async () => {
  // The MODEL path, as it runs now: the participant's runner receives the
  // model's text on its real transport, and the API's parser turns it into
  // the opinion the session adopts.
  const answer = await throughTheRunner(200, JSON.stringify({ choices: [{ message: { content: ONE_POSITION_ANSWER } }] }));
  expect(answer).toEqual({ kind: "ok", body: ONE_POSITION_ANSWER });
  const opinion = parseJudgeResponse(answer.kind === "ok" ? answer.body : "", input);
  expect(opinion.disagreements[0].positions).toHaveLength(1);

  // THERE IS NO SECOND PATH. A vendor that refuses produces no text at all —
  // the runner reports the status and there is nothing to parse, so nothing
  // can reach a receipt.
  const refused = await throughTheRunner(402, '{"error":"Payment Required"}');
  expect(refused.kind).toBe("model_status");

  const receipt = assembleReceipt(opinion, "model");
  assertAnchorable(receipt);
  expect(receipt.judge.source).toBe("model");
  expect(canonicalizeReceipt(receipt, spec)).toContain('"source":"model"');
});

// …but a receipt WRITTEN BEFORE the fallback was removed must still read and
// validate. Those rows are append-only history and some of them are already
// signed and served, so the schema keeps `source: "fallback"` legal even
// though nothing emits it any more. The opinion below is written out as such a
// row held it — nothing in the codebase can produce one now.
test("a pre-#969 fallback receipt still validates — history stays readable", () => {
  const HISTORICAL_FALLBACK: JudgeOpinion = {
    rationale: "Treasury allocation: 1 constructive, 1 neutral across 2 takes (mean confidence 0.78).",
    disagreements: [],
    release_safety: { release: "safe", thinly_supported: false, take_count: 2, min_takes: 2, concerns: [] },
  };
  const historical = assembleReceipt(HISTORICAL_FALLBACK, "fallback");
  assertAnchorable(historical);
  expect(historical.judge.source).toBe("fallback");
  expect(canonicalizeReceipt(historical, spec)).toContain('"source":"fallback"');
});

test("every JudgeOpinion field has a receipt field, and the receipt invents none", () => {
  // A drift guard on the SHAPE rather than on one bound: the judge block's
  // property set is the opinion's property set plus exactly the two ENVELOPE
  // fields — `source` (which produced the prose) and `mode` (whether the
  // session adopted it). Neither is part of JudgeOpinion; both come off the
  // judgement row, so the split is stated here
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

// ── ONE REVISION DEFAULT, ONE DIGEST (criterion 128, D51) ───────────────────
//
// D51: "Two paths already default `revision` differently, `?? 0` in
// `judge-session.ts` and `?? 1` in `projections.ts` and `consensus-receipt.ts`.
// The same take set can therefore produce two different digests." The judge's
// input is now built in domain.ts (`judgeInputFromFrozen`, served to the
// participant judge, which signs `inputsDigest` over exactly that object), and
// every reader resolves an absent revision through `takeRevision()`.
test("a take with an ABSENT revision digests exactly as one at the database default, and every path reads the same value", async () => {
  // judgeInputFromFrozen reads the session's brief through the handle it is
  // given; this one has no brief to return, and touches no database.
  const noBrief = (async () => []) as unknown as DbHandle;
  const frozenFor = (revision: unknown): FrozenTakeSet => ({
    session: {
      id: input.sessionId,
      date: input.date,
      subject_id: input.subjectId,
      subject_name: input.subjectLabel,
      swarm_recommendation: { stances: input.byStance, meanConfidence: input.meanConfidence },
      regime_summary: null,
    },
    takes: input.takes.map((t) => ({ ...t, revision })),
    activeMembers: input.takes.map((t) => ({ id: t.member_id })),
    rosterFrozen: false,
  });

  const absent = await judgeInputFromFrozen(frozenFor(undefined), input.minTakes, noBrief);
  const nulled = await judgeInputFromFrozen(frozenFor(null), input.minTakes, noBrief);
  const atDefault = await judgeInputFromFrozen(frozenFor(TAKE_REVISION_DEFAULT), input.minTakes, noBrief);
  expect(TAKE_REVISION_DEFAULT).toBe(1); // migration 0028: `revision integer NOT NULL DEFAULT 1`
  expect(absent.takes.map((t) => t.revision)).toEqual([1, 1]);
  expect(inputsDigest(absent)).toBe(inputsDigest(atDefault));
  expect(inputsDigest(nulled)).toBe(inputsDigest(atDefault));

  // RED CONTROL: the retired `?? 0` default is a DIFFERENT digest, so the
  // equality above is the one-default property, not a digest blind to revision.
  const atZero = await judgeInputFromFrozen(frozenFor(0), input.minTakes, noBrief);
  expect(inputsDigest(atZero)).not.toBe(inputsDigest(absent));

  // The public projection (and so the served session and receipt page) and
  // the consensus receipt's analyst entry read the same default.
  const row = { id: "t1", member_id: "analyst-alpha", member_name: "Alpha", stance: "constructive", body: ALPHA_BODY, verified: true };
  expect(toTake(row).revision).toBe(absent.takes[0]!.revision);
  expect(toTake({ ...row, revision: null }).revision).toBe(absent.takes[0]!.revision);
  expect(takeRevision(undefined)).toBe(absent.takes[0]!.revision);

  // And no reader spells its own default: every `revision` fallback in the
  // three digest paths goes through takeRevision().
  for (const file of ["src/swarm/domain.ts", "src/swarm/projections.ts", "src/swarm/consensus-receipt.ts"]) {
    const text = readFileSync(join(import.meta.dir, "..", file), "utf8");
    expect(text, file).not.toMatch(/revision\s*\?\?\s*\d/);
    expect(text, file).not.toMatch(/revision\s*==\s*null\s*\?\s*\d/);
  }
});
