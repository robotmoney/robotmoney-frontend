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

describe("assertAuthoredTakes — live prose for the takes that landed, exact absent-set match", () => {
  test("accepts distinct structured takes with all members present", () => {
    expect(() => assertAuthoredTakes("session", [
      take("athena", body("Athena")),
      take("boreas", body("Boreas")),
    ], attendance([]), [])).not.toThrow();
  });

  test("accepts a session where the published absent set matches the observed failures", () => {
    // boreas timed out; the driver recorded it, the backend published it.
    expect(() => assertAuthoredTakes("session", [
      take("athena", body("Athena")),
    ], attendance(["boreas"]), ["boreas"])).not.toThrow();
  });

  test("fails loudly when a member the driver observed failing is absent from the published record", () => {
    // boreas failed in the harness but the published rollup says everyone was
    // present — an under-reported absence must be a failed session, not quiet.
    expect(() => assertAuthoredTakes("session", [
      take("athena", body("Athena")),
    ], attendance([]), ["boreas"])).toThrow(/does not match the .* observed failing/);
  });

  test("fails loudly when the published record names an absence the driver did not observe", () => {
    // The rollup claims boreas was absent although the driver saw it submit —
    // an over-reported absence hides a take that DID land.
    expect(() => assertAuthoredTakes("session", [
      take("athena", body("Athena")),
      take("boreas", body("Boreas")),
    ], attendance(["boreas"]), [])).toThrow(/does not match the .* observed failing/);
  });

  test("rejects the retired deterministic template fingerprint", () => {
    expect(() => assertAuthoredTakes("session", [
      take("athena", `${body("Athena")}\n- the spread, not the composite, is where the signal lives`),
    ], attendance([]), [])).toThrow("retired template fingerprint");
  });
});