// THE CONFORMANCE VECTOR, AND THE ASSEMBLER THAT PRODUCES IT (issue #754).
//
// WHAT THIS FILE IS FOR. robotmoney-core anchors keccak256 over the canonical
// bytes of a consensus receipt (robotmoney-core#1280), and this repository is
// the side that PRODUCES them. A golden that was typed out by hand proves the
// schema is self-consistent; it proves nothing about the code that will
// actually emit the bytes on the day a session is anchored. So the pinned
// golden is regenerated here BY THE SHIPPED ASSEMBLER from a committed input,
// and asserted byte for byte.
//
//   contract/src/__fixtures__/consensus-receipt.assembler-input.json
//     --assembleConsensusReceipt()-->
//   contract/src/__fixtures__/consensus-receipt.valid.json
//   contract/src/__fixtures__/consensus-receipt.valid.canonical.txt   <- the vector
//
// That is the "byte-stable across a rebuild" property the issue's test plan
// asks for: regenerating from the same take set reproduces the committed bytes
// exactly, so core has a fixed target rather than a moving one.
//
// NO KECCAK256 ASSERTION HERE, and that is not an omission. `contract/` has
// zero dependencies and keccak256 is unavailable to a zero-dependency Bun test
// (node:crypto and Bun.CryptoHasher offer SHA3/SHAKE only, and SHA3-256 is
// NIST-padded and a different function). The digest is a named CONSUMER
// obligation — consensus-receipt.canonicalization.json#digest_note — tracked as
// robotmoney-core#1280. This repo pins the bytes; whoever has keccak256 pins the
// digest of these exact bytes.
//
// The reference canonicalizer is IMPORTED, never re-derived: every rule about
// the bytes comes from @robotmoney/contract/consensus-receipt, which is shipped
// contract code for exactly this reason.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeSubmission } from "@robotmoney/contract";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import {
  ConsensusReceiptRefusal,
  assembleConsensusReceipt,
  verifyAssembledReceipt,
  type ConsensusReceiptAssemblyInput,
} from "../src/swarm/consensus-receipt.ts";

const FIXTURES = join(import.meta.dir, "../../contract/src/__fixtures__");
const readJson = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

const VECTOR_INPUT = "consensus-receipt.assembler-input.json";
const VECTOR_RECEIPT = "consensus-receipt.valid.json";
const VECTOR_BYTES = "consensus-receipt.valid.canonical.txt";

const input = (): ConsensusReceiptAssemblyInput => readJson(VECTOR_INPUT);

test("the conformance vector: the committed input reproduces the pinned receipt and its bytes EXACTLY", () => {
  const { receipt, canonicalBytes } = assembleConsensusReceipt(input());

  // The payload, field for field.
  expect(receipt).toEqual(readJson(VECTOR_RECEIPT));
  // And the bytes, which are the thing a digest is taken over. Read as a raw
  // string and compared with ===, so a changed byte anywhere — including the
  // domain prefix and the single trailing newline — fails.
  const golden = readFileSync(join(FIXTURES, VECTOR_BYTES), "utf8");
  expect(canonicalBytes).toBe(golden);
  expect(canonicalBytes.startsWith("robotmoney:consensus-receipt:v1\n")).toBe(true);
  expect(canonicalBytes.endsWith("}\n")).toBe(true);
});

test("the vector is byte-stable across a rebuild: re-assembling the same input twice is identical", () => {
  const first = assembleConsensusReceipt(input());
  const second = assembleConsensusReceipt(input());
  expect(second.canonicalBytes).toBe(first.canonicalBytes);
  // Nothing ambient leaks in — no clock, no ordering of object keys, no
  // database. Same input, same bytes, on any machine and in any process.
  expect(JSON.stringify(second.receipt)).toBe(JSON.stringify(first.receipt));
});

test("the four normalizations the producer really needs are all exercised by the vector", () => {
  const raw = input();
  // 1. `created_at` arrives with MILLISECONDS (what pg timestamptz -> Date ->
  //    toISOString() emits) and must be TRUNCATED to whole seconds, not passed
  //    through and not rounded.
  expect(raw.created_at).toContain(".487Z");
  // 2. The digests arrive BARE, as judge.ts emits them, and are 0x-prefixed.
  expect(raw.prompt_hash.startsWith("0x")).toBe(false);
  // 3. The stance rollup arrives SPARSE, as aggregateSession() writes it.
  expect(Object.keys(raw.stances).length).toBeLessThan(5);
  // 4. The analysts arrive OUT OF ORDER and are sorted by member_id.
  expect(raw.analysts.map((a) => a.member_id)).toEqual(["analyst-beta", "analyst-alpha"]);

  const { receipt } = assembleConsensusReceipt(raw);
  expect(receipt.created_at).toBe("2026-08-26T16:00:00Z");
  expect(receipt.prompt_hash).toBe(`0x${raw.prompt_hash}`);
  expect(receipt.stances).toEqual({ bearish: 0, cautious: 0, neutral: 1, constructive: 1, bullish: 0 });
  expect((receipt.analyst_signatures as any[]).map((s) => s.member_id)).toEqual(["analyst-alpha", "analyst-beta"]);
  // 5. Each entry states WHICH revision it carries — takes are amendable, so
  //    "member X's take" does not name a unique object without it.
  expect((receipt.analyst_signatures as any[]).map((s) => s.revision)).toEqual([1, 1]);
  // Round-half-up over the two integers, not the stored participation float.
  expect(receipt.quorum).toEqual({ active: 3, submitted: 2, absent: 1, participation_bps: 6667 });
});

test("bps conversion closes on exactly 10000 by LARGEST REMAINDER, and a zero last bucket is no longer a refusal", () => {
  // THE RULE CHANGED UNDER THIS TEST (#798/#801, robotmoney-core#1290). It used
  // to round the three prefix buckets half-up and settle `real_world_assets` to
  // 10000 minus the prefix; it is now largest remainder, so the leftover bp
  // goes to the LARGEST FRACTIONAL REMAINDER and ties are broken by canonical
  // bucket order rather than by position.
  //
  // THE TAKES MOVE WITH THE VECTOR, and they have to: `weights` is recomputed
  // from the embedded submissions by the shipped verifier, so a session-level
  // vector rewritten on its own is a refusal (see the test below). Both members
  // submitting the vector is what makes it the session's mean.
  const withVector = (vector: { bucket: string; weight: number }[]) => {
    const raw = input();
    for (const analyst of raw.analysts) analyst.payload.weights = structuredClone(vector);
    raw.weights = structuredClone(vector);
    return raw;
  };
  const vec = (a: number, c: number, p: number, r: number) => [
    { bucket: "agent_tokens", weight: a },
    { bucket: "conservative_defi_yield", weight: c },
    { bucket: "protocol_tokens", weight: p },
    { bucket: "real_world_assets", weight: r },
  ];

  // 1/3, 1/3, 1/3, 0 floors to 3333 + 3333 + 3333 + 0 = 9999. The three
  // remainders are an exact three-way tie, so canonical bucket order gives the
  // leftover bp to `agent_tokens` — NOT to the positionally last bucket.
  const { receipt } = assembleConsensusReceipt(withVector(vec(1 / 3, 1 / 3, 1 / 3, 0)));
  expect(receipt.weights).toEqual([
    { bucket: "agent_tokens", weight_bps: 3334 },
    { bucket: "conservative_defi_yield", weight_bps: 3333 },
    { bucket: "protocol_tokens", weight_bps: 3333 },
    { bucket: "real_world_assets", weight_bps: 0 },
  ]);

  // THE ZERO-RWA SHAPE THE SUPERSEDED RULE REFUSED, ASSEMBLED END TO END. Under
  // settle-the-last this vector rounded to a prefix of 4000 + 3001 + 3000 =
  // 10001 and settled `real_world_assets` to -1, so NO receipt could be
  // assembled for the session at all — and a zero `real_world_assets` is four
  // of the six real archived allocations. It now converts, and closes on
  // exactly 10000 with nothing negative in it.
  const zeroRwa = assembleConsensusReceipt(withVector(vec(0.4, 0.30005, 0.29995, 0))).receipt;
  const entries = zeroRwa.weights as { bucket: string; weight_bps: number }[];
  expect(entries).toEqual([
    { bucket: "agent_tokens", weight_bps: 4000 },
    { bucket: "conservative_defi_yield", weight_bps: 3001 },
    { bucket: "protocol_tokens", weight_bps: 2999 },
    { bucket: "real_world_assets", weight_bps: 0 },
  ]);
  expect(entries.reduce((sum, e) => sum + e.weight_bps, 0)).toBe(10_000);
  // Positive zero, not negative zero: the producer's settle emits -0 and the
  // clamp in `bucketSharesToBps` is written `share > 0 ? share : 0` precisely
  // so that -0 does not survive into a signed artifact.
  expect(Object.is(entries[3]!.weight_bps, -0)).toBe(false);
});

test("the aggregate is BOUND to the takes: a vector the submissions do not mean to is refused", () => {
  // THE FINDING. `stances` and `weights` are written at AGGREGATION time while
  // the signature set is derived at PUBLISH time, and the only cross-check was
  // cardinality — so an amended take (same member count, different content)
  // produced a receipt asserting an allocation the session no longer served,
  // served as `verified: true`. The recomputation lives in the shipped verifier
  // (@robotmoney/contract receiptSemanticErrors), so the assembler inherits it
  // and a stranger runs exactly the same check.
  const reweighted = input();
  reweighted.weights = [
    { bucket: "agent_tokens", weight: 0.9 },
    { bucket: "conservative_defi_yield", weight: 0.04 },
    { bucket: "protocol_tokens", weight: 0.04 },
    { bucket: "real_world_assets", weight: 0.02 },
  ];
  let raised: ConsensusReceiptRefusal | null = null;
  try { assembleConsensusReceipt(reweighted); } catch (e) { raised = e as ConsensusReceiptRefusal; }
  expect(raised).toBeInstanceOf(ConsensusReceiptRefusal);
  expect(raised!.reason).toBe("semantics_invalid");
  expect(raised!.details.join(" ")).toContain('"weight_bps":1250');

  // Same for the stance rollup, with the member COUNT left intact so the old
  // cardinality check stays satisfied.
  const restanced = input();
  restanced.stances = { bearish: 1, bullish: 1 };
  let stanceRefusal: ConsensusReceiptRefusal | null = null;
  try { assembleConsensusReceipt(restanced); } catch (e) { stanceRefusal = e as ConsensusReceiptRefusal; }
  expect(stanceRefusal!.reason).toBe("semantics_invalid");
  expect(stanceRefusal!.details).not.toContain("stances: counts do not sum to quorum.submitted");
  expect(stanceRefusal!.details.join(" ")).toContain("but the embedded submissions carry");
});

test("a shadow-mode judgement cannot be assembled into a receipt AT ALL", () => {
  // Even reaching the pure assembler with one — which loadAssemblyInput no
  // longer allows — the bytes are refused, because the invariant lives in the
  // shipped verifier rather than in a database query.
  const shadow = input();
  shadow.judge_mode = "shadow";
  let raised: ConsensusReceiptRefusal | null = null;
  try { assembleConsensusReceipt(shadow); } catch (e) { raised = e as ConsensusReceiptRefusal; }
  expect(raised).toBeInstanceOf(ConsensusReceiptRefusal);
  expect(raised!.reason).toBe("semantics_invalid");
  expect(raised!.details.join(" ")).toContain("never adopted by the session");

  // And the adopted case is disclosed in the bytes rather than merely implied.
  const { receipt, canonicalBytes } = assembleConsensusReceipt(input());
  expect((receipt.judge as any).mode).toBe("enforce");
  expect(canonicalBytes).toContain('"source":"model","mode":"enforce"');
});

test("a weights column that is not an array is a NAMED refusal, never a TypeError escaping as a 500", () => {
  // `swarm_recommendation.weights` is jsonb and nothing constrains its shape.
  // A non-array value used to reach `.map()` inside toBps() and escape as an
  // unnamed 500, which the module's own "every refusal is operator-visible"
  // rule forbids.
  for (const bad of [{ agent_tokens: 0.25 } as never, "0.25" as never, 42 as never]) {
    const raw = input();
    raw.weights = bad;
    let raised: ConsensusReceiptRefusal | null = null;
    try { assembleConsensusReceipt(raw); } catch (e) { raised = e as ConsensusReceiptRefusal; }
    expect(raised).toBeInstanceOf(ConsensusReceiptRefusal);
    expect(raised!.reason).toBe("weights_malformed");
  }
  // An array whose ENTRIES are the wrong shape is the same named refusal.
  const entries = input();
  entries.weights = [{ bucket: "agent_tokens", weight: "lots" } as never];
  let raised: ConsensusReceiptRefusal | null = null;
  try { assembleConsensusReceipt(entries); } catch (e) { raised = e as ConsensusReceiptRefusal; }
  expect(raised!.reason).toBe("weights_malformed");
  expect(raised!.details.join(" ")).toContain("bad entry");
});

test("no vector at all OMITS weights; a non-canonical vector REFUSES rather than omitting", () => {
  // meanTakeWeights() returned undefined — nobody submitted a vector. That is a
  // legal, byte-stable, judged-but-unweighted receipt.
  const none = input();
  none.weights = null;
  const { receipt, canonicalBytes } = assembleConsensusReceipt(none);
  expect("weights" in receipt).toBe(false);
  expect(canonicalBytes).not.toContain('"weights"');

  // A vector EXISTS but is not the canonical four. The producer really emits
  // this — optionalWeights() accepts any bucket set of any size — and omitting
  // `weights` here would publish a signed artifact saying the session produced
  // no allocation while GET /api/swarm/sessions/:id serves a concrete one.
  const three = input();
  three.weights = [
    { bucket: "agent_tokens", weight: 0.5 },
    { bucket: "conservative_defi_yield", weight: 0.3 },
    { bucket: "protocol_tokens", weight: 0.2 },
  ];
  let raised: ConsensusReceiptRefusal | null = null;
  try { assembleConsensusReceipt(three); } catch (e) { raised = e as ConsensusReceiptRefusal; }
  expect(raised).toBeInstanceOf(ConsensusReceiptRefusal);
  expect(raised!.reason).toBe("weights_not_canonical_four");
  expect(raised!.details.join(" ")).toContain("real_world_assets");

  // A bucket the schema does not know is the same refusal, not a quiet drop.
  const foreign = input();
  foreign.weights = [...(input().weights ?? []), { bucket: "memecoins", weight: 0 }];
  expect(() => assembleConsensusReceipt(foreign)).toThrow(/not the four canonical buckets/);
});

test("a replayed take is refused: a duplicated nonce, and a take signed over another subject", () => {
  const duplicate = input();
  duplicate.analysts = duplicate.analysts.map((a) => ({
    ...a,
    nonce: duplicate.analysts[0]!.nonce,
    payload: { ...a.payload, nonce: duplicate.analysts[0]!.nonce },
  }));
  expect(() => assembleConsensusReceipt(duplicate)).toThrow(/appears twice in one receipt/);

  // The nonce on the ROW and the nonce inside the SIGNED payload must agree —
  // otherwise a take's signature covers a marker other than the one the row is
  // filed under, which is what "this take belongs to this session" rests on.
  const swapped = input();
  swapped.analysts[0]!.nonce = "some-other-nonce";
  expect(() => assembleConsensusReceipt(swapped)).toThrow(/but was signed over/);

  // And a take signed over a DIFFERENT subject cannot be carried into this
  // receipt at all, however valid its signature is.
  const elsewhere = input();
  elsewhere.analysts[0]!.payload = { ...elsewhere.analysts[0]!.payload, subjectId: "some-other-subject" };
  expect(() => assembleConsensusReceipt(elsewhere)).toThrow(/not "treasury-allocation"/);

  // A take attributed to a member it was not signed by is refused for the same
  // reason: analyst identity in the receipt is the SIGNING identity.
  const misattributed = input();
  misattributed.analysts[0]!.member_id = "analyst-gamma";
  expect(() => assembleConsensusReceipt(misattributed)).toThrow(/was signed as/);
});

test("a session with no takes produces no receipt at all", () => {
  const empty = input();
  empty.analysts = [];
  let raised: ConsensusReceiptRefusal | null = null;
  try { assembleConsensusReceipt(empty); } catch (e) { raised = e as ConsensusReceiptRefusal; }
  expect(raised!.reason).toBe("no_takes");
});

test("an unparseable created_at and a malformed digest are refusals, never guessed defaults", () => {
  const badTime = input();
  badTime.created_at = "not a time";
  expect(() => assembleConsensusReceipt(badTime)).toThrow(/not a parseable instant/);

  const badHash = input();
  badHash.inputs_digest = "beef";
  expect(() => assembleConsensusReceipt(badHash)).toThrow(/not a 32-byte sha256 hex digest/);

  // Uppercase hex denotes the SAME digest and DIFFERENT bytes, so exactly one
  // spelling reaches the payload — it is normalized, not refused.
  const upper = input();
  upper.prompt_hash = upper.prompt_hash.toUpperCase().replace(/1/g, "A");
  expect((assembleConsensusReceipt(upper).receipt as any).prompt_hash).toBe(`0x${"a".repeat(64)}`);
});

// ── Read-time verification (3.4), including the two things signatures alone
// cannot catch ──────────────────────────────────────────────────────────────

test("a freshly assembled receipt verifies, signature by signature", async () => {
  const { receipt, canonicalBytes } = assembleConsensusReceipt(input());
  const verdict = await verifyAssembledReceipt(receipt, canonicalBytes);
  expect(verdict.unverifiedReasons).toEqual([]);
  expect(verdict.verified).toBe(true);
  expect(verdict.signatures).toEqual([
    { memberId: "analyst-alpha", verified: true },
    { memberId: "analyst-beta", verified: true },
  ]);
});

test("ONE signature from a key that did not sign marks the WHOLE receipt unverified", async () => {
  const { receipt, canonicalBytes } = assembleConsensusReceipt(input());
  const stranger = await generateKeyPair();
  (receipt.analyst_signatures as any[])[1]!.public_key = stranger.publicKeyB64;

  const verdict = await verifyAssembledReceipt(receipt, canonicalBytes);
  expect(verdict.verified).toBe(false);
  // NOT a partial pass: the other signature is still reported as good, and the
  // aggregate is still unverified.
  expect(verdict.signatures[0]!.verified).toBe(true);
  expect(verdict.signatures[1]!.verified).toBe(false);
  expect(verdict.unverifiedReasons.join(" ")).toContain("analyst-beta");
});

test("tampering with ANY payload field is caught, including fields no analyst signed over", async () => {
  const assembled = assembleConsensusReceipt(input());
  const bytes = assembled.canonicalBytes;

  // The judge's prose. No analyst signature covers it — each covers only that
  // analyst's own submission — so the canonical-bytes recomputation is the only
  // thing that can catch this, and it must.
  const proseEdited = assembleConsensusReceipt(input()).receipt;
  (proseEdited.judge as any).rationale = "A rationale nobody wrote.";
  let verdict = await verifyAssembledReceipt(proseEdited, bytes);
  expect(verdict.signatures.every((s) => s.verified)).toBe(true);
  expect(verdict.verified).toBe(false);
  expect(verdict.unverifiedReasons.join(" ")).toContain("no longer canonicalizes");

  // A weight. Same story, and it is the field an anchored digest exists to
  // commit to.
  const weightEdited = assembleConsensusReceipt(input()).receipt;
  (weightEdited.weights as any[])[0]!.weight_bps = 9999;
  verdict = await verifyAssembledReceipt(weightEdited, bytes);
  expect(verdict.verified).toBe(false);

  // A quorum number, which also breaks a RECOMPUTABLE invariant — so both
  // checks fire and the reasons say which.
  const quorumEdited = assembleConsensusReceipt(input()).receipt;
  (quorumEdited.quorum as any).participation_bps = 10_000;
  verdict = await verifyAssembledReceipt(quorumEdited, bytes);
  expect(verdict.verified).toBe(false);
  expect(verdict.unverifiedReasons.some((r) => r.startsWith("invariant:"))).toBe(true);
});

test("verification uses the EMBEDDED key, so a receipt survives a rotation of its signers' keys", async () => {
  // The rotation is modelled where it actually happens: the member's registry.
  // Nothing about the receipt changes, and nothing in verifyAssembledReceipt
  // consults the registry — which is the whole point of scope item 3.6. So the
  // strongest statement available here is that a receipt assembled from a key
  // that is no longer anybody's current key still verifies, and that is what
  // this asserts: the key below exists only inside the payload.
  const retired = await generateKeyPair();
  const raw = input();
  const payload = { ...raw.analysts[0]!.payload };
  const canonical = canonicalizeSubmission(payload as any);
  raw.analysts[0] = {
    ...raw.analysts[0]!,
    public_key: retired.publicKeyB64,
    signature: await signMessage(canonical, retired.privateKey),
  };
  const rotatedMember = raw.analysts[0]!.member_id;
  const { receipt, canonicalBytes } = assembleConsensusReceipt(raw);
  const verdict = await verifyAssembledReceipt(receipt, canonicalBytes);
  expect(verdict.verified).toBe(true);
  const embedded = (receipt.analyst_signatures as any[]).find((s) => s.member_id === rotatedMember);
  expect(embedded.public_key).toBe(retired.publicKeyB64);
});
