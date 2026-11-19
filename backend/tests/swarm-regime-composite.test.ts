// Issue 1660 (D86): members and the judge are served the regime composite, not
// its 3-year percentile.
//
// The consensus, rationale and disagreement text is a function of the STORED
// regime_summary. A summary written before 1660 carries `composite_percentile`
// and re-derives its old sentence byte for byte; one written after carries a
// null percentile and reads the composite to 2 decimals.
import { expect, test } from "bun:test";
import { canonicalizeSubmission, RECEIPT_HARD_ASSETS_BUCKET_ORDER } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import * as ic from "../src/swarm/domain.ts";
import { buildConsensus, buildRationale } from "../src/swarm/domain.ts";
import { checkRationaleLadder } from "../src/swarm/judge-replay.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

// The 16 Nov treasury session: composite 0.3767, its rank 0.0306.
const NEW_SUMMARY = { composite: 0.3767, composite_percentile: null, regime: "risk_off" };
const OLD_SUMMARY = { composite: 0.3767, composite_percentile: 0.0306, regime: "risk_off" };
const STANCES = { cautious: 5, neutral: 1 };
// Subjects convene for an allocation by default, so a take carries the four buckets.
const W = [...RECEIPT_HARD_ASSETS_BUCKET_ORDER].map((bucket) => ({ bucket, weight: 1 }));

test("buildConsensus reads the composite on a new summary and the percentile on a stored one", () => {
  const fresh = buildConsensus(6, 6, 1, STANCES, 0.6, NEW_SUMMARY);
  expect(fresh).toContain("Regime composite 0.38 (risk_off).");
  expect(fresh.join(" ")).not.toContain("percentile");

  const stored = buildConsensus(6, 6, 1, STANCES, 0.6, OLD_SUMMARY);
  expect(stored).toContain("Regime composite at the 3rd percentile (risk_off).");

  // Neither number: no regime line, as before.
  const none = buildConsensus(6, 6, 1, STANCES, 0.6, { composite: null, composite_percentile: null, regime: "neutral" });
  expect(none.some((p) => p.startsWith("Regime"))).toBe(false);
  expect(buildConsensus(6, 6, 1, STANCES, 0.6, null).some((p) => p.startsWith("Regime"))).toBe(false);
});

test("buildRationale reads the composite on a new summary and the percentile on a stored one", () => {
  expect(buildRationale("Treasury", STANCES, 6, 0.6, NEW_SUMMARY))
    .toBe("Majority stance is cautious (5 of 6 submitted takes), mean confidence 0.60, regime composite 0.38 on Treasury.");
  expect(buildRationale("Treasury", STANCES, 6, 0.6, OLD_SUMMARY))
    .toBe("Majority stance is cautious (5 of 6 submitted takes), mean confidence 0.60, regime composite at the 3rd percentile on Treasury.");
  expect(buildRationale("Treasury", STANCES, 6, 0.6, null))
    .toBe("Majority stance is cautious (5 of 6 submitted takes), mean confidence 0.60 on Treasury.");
});

test("the rationale ladder check re-derives the stored rationale of a session written with a percentile summary", () => {
  // A recommendation exactly as it was stored before 1660.
  const rec = {
    stances: STANCES,
    quorum: { submitted: 6 },
    meanConfidence: 0.6,
    rationale: "Majority stance is cautious (5 of 6 submitted takes), mean confidence 0.60, regime composite at the 3rd percentile on Treasury.",
  };
  const check = checkRationaleLadder(rec, "Treasury", OLD_SUMMARY);
  expect(check.storedRationaleShape).toBe("template");
  expect(check.rederivedRationale).toBe(rec.rationale);
  expect(check.disagrees).toBe(false);
});

test("an aggregated session's what_settles reads the composite, and its summary and text carry no percentile", async () => {
  await sql`
    INSERT INTO regime_snapshots (date, composite, composite_percentile, regime)
    VALUES ((clock_timestamp() AT TIME ZONE 'UTC')::date, 0.3767, 0.0306, 'risk_off')`;
  const subj = rid("rc");
  await ic.ensureSubject(subj, "Regime composite subject");
  const session = await ic.openSession(subj);
  await ic.publishBrief(session.id, 60);
  const date = session.date instanceof Date ? session.date.toISOString().slice(0, 10) : String(session.date).slice(0, 10);
  for (const stance of ["cautious", "bullish"]) {
    const id = rid("m");
    const { publicKeyB64, privateKey } = await generateKeyPair();
    const reg = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
    if (!("token" in reg) || !reg.token) throw new Error(`registerMember failed: ${JSON.stringify(reg)}`);
    const sub = { memberId: id, date, subjectId: subj, nonce: rid("n"), stance, confidence: 0.6, body: `${stance} take`, weights: W };
    const signature = await signMessage(canonicalizeSubmission(sub), privateKey);
    const res = await ic.submitRecommendation(reg.token, { ...sub, signature });
    if (res.status !== 201) throw new Error(`submit failed: ${JSON.stringify(res)}`);
  }
  await ic.closeWindow(session.id);
  await ic.aggregateSession(session.id);

  const [row] = (await sql`SELECT regime_summary, swarm_recommendation FROM swarm_sessions WHERE id = ${session.id}`) as any[];
  expect(row.regime_summary.composite).toBe(0.3767);
  expect(row.regime_summary.composite_percentile).toBeNull();
  const rec = row.swarm_recommendation;
  expect(rec.disagreements.length).toBe(1);
  expect(rec.disagreements[0].what_settles).toContain("composite moves toward");
  expect(rec.disagreements[0].what_settles).not.toContain("percentile");
  expect(rec.consensus).toContain("Regime composite 0.38 (risk_off).");
  expect(rec.rationale).toContain("regime composite 0.38");
  expect(JSON.stringify(rec.consensus) + rec.rationale).not.toContain("percentile");
});
