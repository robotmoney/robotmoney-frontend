import { describe, expect, test } from "bun:test";
import { assertAuthoredTakes, type AbsenceReport } from "../../lib/swarm/session.ts";

const take = (memberId: string, body: string) => ({
  memberId,
  body,
  stance: "neutral",
  confidence: 0.5,
});

const body = (detail: string) => [
  "**REGIME**", `- ${detail} regime`,
  "**ALLOCATION**", `- ${detail} allocation`,
  "**SUBJECT**", `- ${detail} subject`,
].join("\n");

// Published-attendance shape; absent list is what the backend rollup said.
const attendance = (absent: string[]): AbsenceReport => ({
  active: 4,
  submitted: 4 - absent.length,
  absent,
});

describe("assertAuthoredTakes — live prose for the takes that landed, directional absent-set truthfulness", () => {
  test("accepts distinct structured takes with all members present", () => {
    expect(() => assertAuthoredTakes("session", [
      take("athena", body("Athena")),
      take("boreas", body("Boreas")),
    ], attendance([]), [], ["athena", "boreas"])).not.toThrow();
  });

  test("accepts a session where the published absent list covers every observed failure", () => {
    // boreas timed out; the driver recorded it, the backend published it.
    expect(() => assertAuthoredTakes("session", [
      take("athena", body("Athena")),
    ], attendance(["boreas"]), ["boreas"], ["athena"])).not.toThrow();
  });

  test("accepts a published absent list with extra members the driver never ran", () => {
    // cross-role-test registers mid-run and never submits; the backend counts
    // it absent, but the driver ran no container for it — no ground truth, so
    // the gate must not fail on it.
    expect(() => assertAuthoredTakes("session", [
      take("athena", body("Athena")),
    ], attendance(["boreas", "cross-role-test"]), ["boreas"], ["athena"])).not.toThrow();
  });

  test("fails loudly when a member the driver observed failing is absent from the published record", () => {
    // boreas failed in the harness but the published rollup says everyone was
    // present — an under-reported absence must be a failed session, not quiet.
    expect(() => assertAuthoredTakes("session", [
      take("athena", body("Athena")),
    ], attendance([]), ["boreas"], ["athena"])).toThrow(/omits .* observed failing/);
  });

  test("fails loudly when the published record names a fulfilled member as absent", () => {
    // The rollup claims boreas was absent although the driver saw it submit —
    // an over-reported absence hides a take that DID land.
    expect(() => assertAuthoredTakes("session", [
      take("athena", body("Athena")),
      take("boreas", body("Boreas")),
    ], attendance(["boreas"]), [], ["athena", "boreas"])).toThrow(/names .* that this driver saw submit/);
  });

  test("fails loudly when a fulfilled member's take never landed in the published payload", () => {
    // boreas's container resolved with a verified take, the record does not
    // list it absent, yet the payload has no take row for it — a submission
    // the driver verified did not land.
    expect(() => assertAuthoredTakes("session", [
      take("athena", body("Athena")),
    ], attendance([]), [], ["athena", "boreas"])).toThrow(/fulfilled member .* has no live-authored take/);
  });

  test("rejects the retired deterministic template fingerprint", () => {
    expect(() => assertAuthoredTakes("session", [
      take("athena", `${body("Athena")}\n- the spread, not the composite, is where the signal lives`),
    ], attendance([]), [], ["athena"])).toThrow("retired template fingerprint");
  });
});