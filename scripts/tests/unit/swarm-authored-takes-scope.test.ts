// The post-publish format checks grade only the takes the driver itself ran.
// Production 2026-09-26/27: an outside member's take without the **SUBJECT**
// lead-in made the driver log `swarm session failed` after the session had
// already published, judged, with a receipt.
import { describe, expect, test } from "bun:test";
import { assertAuthoredTakes } from "../../lib/swarm/session.ts";

const good = (id: string) => ({
  memberId: id,
  stance: "constructive",
  confidence: 0.6,
  body: `**REGIME**\n- composite for ${id}\n\n**ALLOCATION**\n- 95/5/0/0 for ${id}\n\n**SUBJECT**\n- subject read by ${id}`,
});
const outside = { memberId: "woon", stance: "constructive", confidence: 0.7, body: "Woon's own format: no lead-ins at all." };
const attendance = { active: 3, submitted: 3, absent: [] as string[] };

describe("assertAuthoredTakes scope", () => {
  test("an outside member's take in its own format does not fail the session", () => {
    expect(() => assertAuthoredTakes("[t]", [good("a"), good("b"), outside], attendance, [], ["a", "b"])).not.toThrow();
  });

  test("a driver-run take missing a lead-in still fails", () => {
    const bad = { ...good("a"), body: "**REGIME**\n- x\n\n**ALLOCATION**\n- y" };
    expect(() => assertAuthoredTakes("[t]", [bad, good("b")], attendance, [], ["a", "b"])).toThrow("missing the **SUBJECT** lead-in");
  });

  test("attendance truthfulness still covers members the driver ran", () => {
    expect(() => assertAuthoredTakes("[t]", [good("a")], { ...attendance, absent: ["a"] }, [], ["a"])).toThrow("names");
  });
});
