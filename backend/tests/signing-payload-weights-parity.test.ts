// POST /api/swarm/signing-payload applies the same weights rule as POST
// /api/swarm/submit (post-mortem 2026-10-09, finding 10).
//
// The onboarding skill tells an agent to use signing-payload "to validate a
// draft's shape before a window is open". Until this rule was shared the route
// returned 200 for a weightless or two-bucket draft on a bucket_weights subject
// and the agent's submit then failed 400, on every attempt (ShodAI's log:
// signing-payload 200, then submit 400 within one second, three times). The
// cases below are the live probes of that finding.
import { expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import * as ic from "../src/swarm/domain.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

const BUCKETS = ["agent_tokens", "conservative_defi_yield", "protocol_tokens", "real_world_assets"];
const four = BUCKETS.map((bucket) => ({ bucket, weight: 0.25 }));

async function subject(id: string, type: "bucket_weights" | "position_actions") {
  await fixtureDb`
    INSERT INTO swarm_subjects (id, status, name, recommendation_type) VALUES (${id}, 'active', ${id}, ${type})
    ON CONFLICT (id) DO UPDATE SET recommendation_type = EXCLUDED.recommendation_type`;
}

async function draft(subjectId: string, weights?: unknown): Promise<{ status: number; body: any }> {
  const res = await handleSwarm(
    new Request(`http://localhost${ROUTES.swarm.signingPayload}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        memberId: "m1", date: "2026-10-09", subjectId, nonce: "n1", stance: "neutral", confidence: 0.5, body: "probe",
        ...(weights === undefined ? {} : { weights }),
      }),
    }),
    new URL(`http://localhost${ROUTES.swarm.signingPayload}`),
  );
  if (!res || res instanceof Response) throw new Error("signing-payload was not handled");
  return { status: res.status, body: res.body };
}

test("a bucket_weights subject: no weights and a two-bucket vector are refused, exactly four are signed", async () => {
  await subject("parity_alloc", "bucket_weights");
  const none = await draft("parity_alloc");
  expect(none.status).toBe(400);
  expect(none.body.error).toContain("weights_required_for_bucket_weights_subject");
  const two = await draft("parity_alloc", four.slice(0, 2));
  expect(two.status).toBe(400);
  expect(two.body.error).toContain("weights_not_canonical_four");
  const ok = await draft("parity_alloc", four);
  expect(ok.status).toBe(200);
  expect(typeof ok.body.canonical).toBe("string");
});

test("the refusal text is submit's: one function answers both routes", async () => {
  await subject("parity_alloc", "bucket_weights");
  const refused = await ic.weightsRefusal("parity_alloc", undefined);
  expect(refused).not.toBeNull();
  const route = await draft("parity_alloc");
  expect(route.body.error).toBe(refused!.error);
});

test("a position_actions subject takes no vector: a weightless draft is signed, and so is a canonical one", async () => {
  await subject("parity_prose", "position_actions");
  expect((await draft("parity_prose")).status).toBe(200);
  expect((await draft("parity_prose", four.slice(0, 2))).status).toBe(200);
});

test("shape errors keep their own messages on every subject: empty array, unknown bucket, five entries", async () => {
  await subject("parity_alloc", "bucket_weights");
  await subject("parity_prose", "position_actions");
  const empty = await draft("parity_alloc", []);
  expect(empty.status).toBe(400);
  expect(empty.body.error).toBe("invalid weights");
  const unknown = await draft("parity_prose", [{ bucket: "stables", weight: 1 }]);
  expect(unknown.status).toBe(400);
  expect(unknown.body.error).toContain("weights_bucket_not_canonical");
  const five = await draft("parity_alloc", [...four, { bucket: "cash", weight: 0.2 }]);
  expect(five.status).toBe(400);
  expect(five.body.error).toContain("weights_not_canonical_four");
});

test("a subject the server does not know is signed as before: the rule belongs to subjects typed bucket_weights", async () => {
  expect((await draft("parity_unknown_subject")).status).toBe(200);
});

test("red control: a retyped vault stops needing a vector, allocation keeps needing one", async () => {
  await subject("parity_vault", "bucket_weights");
  expect((await draft("parity_vault")).status).toBe(400);
  await fixtureDb`UPDATE swarm_subjects SET recommendation_type = 'position_actions' WHERE id = 'parity_vault'`;
  expect((await draft("parity_vault")).status).toBe(200);
  expect((await draft("parity_alloc")).status).toBe(400);
});
