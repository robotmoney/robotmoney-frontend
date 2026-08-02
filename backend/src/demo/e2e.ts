// End-to-end swarm demo / integration test. No mocks of the submit path; no
// host-authored takes. Seeds members (each with its own ed25519 key + bearer
// token) + a subject, ensures a regime snapshot, opens a session + brief, then
// runs N independent "agents" that each read the regime, decide a stance, SIGN
// the canonical payload with their own key, and POST /api/swarm/submit over
// HTTP. One member is a deliberate no-show (recorded absent). Then close →
// aggregate → publish, and print the result.
import { sql, closeDb } from "../db/client.ts";
import { hashKey } from "../lib/keys.ts";
import { generateKeyPair, signMessage } from "../lib/signing.ts";
import { canonicalizeSubmission, demoAttends, ROUTES, stanceFor } from "@robotmoney/contract";
import * as ic from "../swarm/domain.ts";
import { runAnalytics } from "../analytics/index.ts";
import { hermeticDataSource } from "../analytics/access/hermetic-source.ts";
// This demo driver already holds DB credentials (it seeds members via SQL), so
// it persists analytics through the API-owned direct service rather than the
// worker's HTTP client (issue #106) — demo/e2e tooling, not an updater process.
import { directAnalyticsPersistence } from "../analytics/store/direct.ts";

// Backend base URL. BACKEND_URL is the canonical variable every other driver
// honors (scripts/demo-frontend-check.ts, scripts/rmpc-release-e2e.ts,
// scripts/lib/swarm/session.ts) — this file historically read a one-off
// API_BASE name, so `export BACKEND_URL=…` silently failed to repoint it.
// API_BASE is DEPRECATED and accepted only as a one-release fallback for any
// existing invocation; set BACKEND_URL instead. Exported + env-injectable so
// the precedence is unit-testable hermetically (tests/demo-e2e-env.test.ts).
export function resolveBackendBase(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.BACKEND_URL ?? env.API_BASE ?? "http://localhost:8787";
}
const API = resolveBackendBase();
const today = new Date().toISOString().slice(0, 10);
const SUBJECT = { id: "woon", name: "Woon Treasury" };

// Attendance (the demo no-show rule) and the deterministic stance ladder both
// come from the shared contract (contract/src/swarm.js) — the swarm session e2e
// consumes the SAME rule/ladder, so the two drivers can no longer drift
// (finding 008 retired the comment-enforced mirrors). The roster outcome stays
// fixed (draco absent; athena/boreas/cygnus present).

// Members. `bias` shifts the stance vs. the regime; `present:false` = no-show.
const MEMBERS = [
  { id: "athena", name: "Athena", lens: "macro risk", bias: -0.1, present: demoAttends("athena") },
  { id: "boreas", name: "Boreas", lens: "on-chain flows", bias: 0.0, present: demoAttends("boreas") },
  { id: "cygnus", name: "Cygnus", lens: "momentum", bias: 0.15, present: demoAttends("cygnus") },
  { id: "draco", name: "Draco", lens: "contrarian", bias: 0.0, present: demoAttends("draco") },
];

async function seed() {
  await sql`INSERT INTO swarm_subjects (id, status, name, recommendation_type)
            VALUES (${SUBJECT.id}, 'active', ${SUBJECT.name}, 'bucket_weights')
            ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`;
  const identities: Record<string, { token: string; privateKey: CryptoKey }> = {};
  for (const m of MEMBERS) {
    const { publicKeyB64, privateKey } = await generateKeyPair();
    const token = `tok_${m.id}_${crypto.randomUUID().slice(0, 8)}`;
    await sql`INSERT INTO swarm_members (id, status, name, lens)
              VALUES (${m.id}, 'active', ${m.name}, ${m.lens})
              ON CONFLICT (id) DO UPDATE SET status = 'active', name = EXCLUDED.name`;
    await sql`DELETE FROM swarm_member_keys WHERE member_id = ${m.id}`;
    await sql`INSERT INTO swarm_member_keys (member_id, public_key, token_hash)
              VALUES (${m.id}, ${publicKeyB64}, ${hashKey(token)})`;
    identities[m.id] = { token, privateKey };
  }
  return identities;
}

async function agentSubmit(member: typeof MEMBERS[number], idn: { token: string; privateKey: CryptoKey }, composite: number) {
  // read the brief (proves the read path); decide; sign; submit.
  await fetch(`${API}${ROUTES.swarm.brief}?date=${today}&subject=${SUBJECT.id}`).then((r) => r.json());
  const { stance, confidence } = stanceFor(composite, member.bias);
  const submission = {
    memberId: member.id, date: today, subjectId: SUBJECT.id,
    nonce: crypto.randomUUID(), stance, confidence,
    body: `${member.name} (${member.lens}): regime composite ${composite.toFixed(2)} → ${stance}.`,
  };
  const signature = await signMessage(canonicalizeSubmission(submission), idn.privateKey);
  const res = await fetch(`${API}${ROUTES.swarm.submit}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idn.token}` },
    body: JSON.stringify({ ...submission, signature }),
  });
  return { member: member.id, stance, confidence, status: res.status, body: await res.json() };
}

async function main() {
  console.log(`\n=== Swarm E2E demo (${today}) ===`);
  // Demo/e2e MUST be hermetic + offline (demo spec: no FRED/Yahoo/EDGAR/... calls).
  // Pass the deterministic seeded source explicitly so this path never fires the
  // ~200 live EDGAR/fetcher requests the prod `liveDataSource` would.
  await runAnalytics(today, undefined, hermeticDataSource, directAnalyticsPersistence);
  const regime = (await sql`SELECT composite, regime FROM regime_snapshots ORDER BY date DESC LIMIT 1`)[0];
  const composite = Number(regime.composite);
  console.log(`regime: composite=${composite.toFixed(3)} (${regime.regime})`);

  const identities = await seed();
  // No date argument: Postgres stamps convened_at and derives the date from it
  // (migration 0022). `today` above is still this script's own regime/analytics
  // as-of day, which is a different thing from when a session convened.
  const session = await ic.openSession(SUBJECT.id);
  await ic.publishBrief(session.id, 60);
  console.log(`session ${session.id} → brief published, window open`);

  // Independent agents submit concurrently (the no-show is skipped).
  const present = MEMBERS.filter((m) => m.present);
  const results = await Promise.all(present.map((m) => agentSubmit(m, identities[m.id], composite)));
  for (const r of results) console.log(`  ${r.member}: ${r.stance} c=${r.confidence} → HTTP ${r.status} ${r.body.verified ? "✓verified" : JSON.stringify(r.body)}`);

  await ic.closeWindow(session.id);
  const agg = await ic.aggregateSession(session.id);
  await ic.publishSession(session.id);
  console.log(`\naggregate: ${JSON.stringify(agg.stances)}  participation=${(agg.quorum.participation * 100).toFixed(0)}%  absent=${JSON.stringify(agg.absent)}`);

  const published = await ic.getSession(today, SUBJECT.id);
  console.log(`\npublished session state=${published!.session.state}, takes=${published!.takes.length}`);
  console.log(`synthesis: ${published!.session.synthesis}`);
  console.log("=== done ===\n");
}

// Only run the full demo flow when this file is the entry point (e.g.
// `bun run src/demo/e2e.ts`). Guarded (same pattern as scripts/lib/swarm/session.ts) so unit
// tests can `import { resolveBackendBase }` WITHOUT triggering a live-DB demo
// run. Entry-point behaviour is unchanged.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(closeDb).catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
}
