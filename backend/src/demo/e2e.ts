// End-to-end committee demo / integration test. No mocks of the submit path; no
// host-authored takes. Seeds members (each with its own ed25519 key + bearer
// token) + a subject, ensures a regime snapshot, opens a session + brief, then
// runs N independent "agents" that each read the regime, decide a stance, SIGN
// the canonical payload with their own key, and POST /api/committee/submit over
// HTTP. One member is a deliberate no-show (recorded absent). Then close →
// aggregate → publish, and print the result.
import { sql, closeDb } from "../db/client.ts";
import { hashKey } from "../lib/keys.ts";
import { generateKeyPair, signMessage } from "../lib/signing.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";
import * as ic from "../committee/domain.ts";
import { runAnalytics } from "../analytics/index.ts";
import { hermeticDataSource } from "../analytics/access/hermetic-source.ts";

const API = process.env.API_BASE ?? "http://localhost:8787";
const today = new Date().toISOString().slice(0, 10);
const SUBJECT = { id: "woon", name: "Woon Treasury" };

// Deterministic attendance stand-in for a real no-show simulation. Absence
// emerges from a RULE (a curated set of habitual no-shows), not a baked boolean:
// the contrarian member (draco) models an occasional no-show. Kept deterministic
// (no Math.random / Date) so this hermetic e2e stays reproducible — the roster
// outcome is fixed (draco absent; athena/boreas/cygnus present). MIRROR of the mcp
// demo e2e's attends() — keep the two in sync.
const NO_SHOWS = new Set(["draco"]);
function attends(memberId: string): boolean {
  return !NO_SHOWS.has(memberId);
}

// Members. `bias` shifts the stance vs. the regime; `present:false` = no-show.
const MEMBERS = [
  { id: "athena", name: "Athena", lens: "macro risk", bias: -0.1, present: attends("athena") },
  { id: "boreas", name: "Boreas", lens: "on-chain flows", bias: 0.0, present: attends("boreas") },
  { id: "cygnus", name: "Cygnus", lens: "momentum", bias: 0.15, present: attends("cygnus") },
  { id: "draco", name: "Draco", lens: "contrarian", bias: 0.0, present: attends("draco") },
];

function stanceFor(composite: number, bias: number): { stance: string; confidence: number } {
  const x = composite + bias;
  const stance = x >= 0.67 ? "bullish" : x >= 0.55 ? "constructive" : x >= 0.45 ? "neutral" : x >= 0.33 ? "cautious" : "bearish";
  const confidence = Math.round(Math.min(1, Math.abs(x - 0.5) * 2 + 0.4) * 100) / 100;
  return { stance, confidence };
}

async function seed() {
  await sql`INSERT INTO committee_subjects (id, status, name, recommendation_type)
            VALUES (${SUBJECT.id}, 'active', ${SUBJECT.name}, 'bucket_weights')
            ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`;
  const identities: Record<string, { token: string; privateKey: CryptoKey }> = {};
  for (const m of MEMBERS) {
    const { publicKeyB64, privateKey } = await generateKeyPair();
    const token = `tok_${m.id}_${crypto.randomUUID().slice(0, 8)}`;
    await sql`INSERT INTO committee_members (id, status, name, lens)
              VALUES (${m.id}, 'active', ${m.name}, ${m.lens})
              ON CONFLICT (id) DO UPDATE SET status = 'active', name = EXCLUDED.name`;
    await sql`DELETE FROM committee_member_keys WHERE member_id = ${m.id}`;
    await sql`INSERT INTO committee_member_keys (member_id, public_key, token_hash)
              VALUES (${m.id}, ${publicKeyB64}, ${hashKey(token)})`;
    identities[m.id] = { token, privateKey };
  }
  return identities;
}

async function agentSubmit(member: typeof MEMBERS[number], idn: { token: string; privateKey: CryptoKey }, composite: number) {
  // read the brief (proves the read path); decide; sign; submit.
  await fetch(`${API}/api/committee/brief?date=${today}&subject=${SUBJECT.id}`).then((r) => r.json());
  const { stance, confidence } = stanceFor(composite, member.bias);
  const submission = {
    memberId: member.id, date: today, subjectId: SUBJECT.id,
    nonce: crypto.randomUUID(), stance, confidence,
    body: `${member.name} (${member.lens}): regime composite ${composite.toFixed(2)} → ${stance}.`,
  };
  const signature = await signMessage(canonicalizeSubmission(submission), idn.privateKey);
  const res = await fetch(`${API}/api/committee/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idn.token}` },
    body: JSON.stringify({ ...submission, signature }),
  });
  return { member: member.id, stance, confidence, status: res.status, body: await res.json() };
}

async function main() {
  console.log(`\n=== Committee E2E demo (${today}) ===`);
  // Demo/e2e MUST be hermetic + offline (demo spec: no FRED/Yahoo/EDGAR/... calls).
  // Pass the deterministic seeded source explicitly so this path never fires the
  // ~200 live EDGAR/fetcher requests the prod `liveDataSource` would.
  await runAnalytics(today, undefined, hermeticDataSource);
  const regime = (await sql`SELECT composite, regime FROM regime_snapshots ORDER BY date DESC LIMIT 1`)[0];
  const composite = Number(regime.composite);
  console.log(`regime: composite=${composite.toFixed(3)} (${regime.regime})`);

  const identities = await seed();
  const session = await ic.openSession(today, SUBJECT.id);
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

main().then(closeDb).catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
