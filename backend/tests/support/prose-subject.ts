// A subject whose sessions ask for PROSE ONLY.
//
// WHY THIS EXISTS (T17). `ic.ensureSubject()` — the legacy/smoke creation path
// every fixture here reaches for — types the subjects it creates
// `bucket_weights`, and since T17 a take filed against a `bucket_weights`
// subject MUST carry the canonical-four weight vector or it is refused at
// submission with a 400. That is the point of the change: a weightless take
// used to be accepted and then blocked the session's consensus receipt
// forever.
//
// So a fixture has to SAY which kind of session it wants. A test whose subject
// is scenery — it needs a session to submit into and never asserts on an
// allocation — wants this one, and its takes stay weightless exactly as they
// were. A test about allocations keeps `ensureSubject` (or sets the type
// itself) and submits the four-bucket vector.
import * as ic from "../../src/swarm/domain.ts";
import { sql } from "../../src/db/client.ts";

export async function ensureProseSubject(id: string, name: string) {
  const subject = await ic.ensureSubject(id, name);
  await sql`UPDATE swarm_subjects SET recommendation_type = 'position_actions' WHERE id = ${id}`;
  return subject;
}
