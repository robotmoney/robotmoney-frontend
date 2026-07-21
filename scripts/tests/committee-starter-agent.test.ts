import { expect, test } from "bun:test";
import { canonicalizeSubmission } from "@robotmoney/contract";
import { draftFromBrief } from "../committee-starter-agent.ts";

test("starter agent emits a canonical, schema-valid equal-weight proposal", () => {
  const draft = draftFromBrief("athena", { date: "2026-07-21", subjectId: "woon", subjectName: "Woon" }, {
    responseSchema: { proposedWeights: { buckets: ["conservative", "agent_tokens", "protocol_tokens"] } },
  });
  expect(Object.values(draft.proposedWeights!).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
  expect(draft.body).toContain("**REGIME**");
  expect(canonicalizeSubmission(draft)).toContain('"proposedWeights":');
});
