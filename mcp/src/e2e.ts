// MCP-path end-to-end demo. Drives a full committee session where N independent
// agents participate THROUGH the MCP server (each its own key + token + MCP
// session). One member is a deliberate no-show. Admin lifecycle is driven over
// the backend's dev-only HTTP endpoints; no DB access here (clean boundary).
import { runAgent } from "./agent.ts";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8787";
const today = new Date().toISOString().slice(0, 10);
const SUBJECT = { id: "woon", name: "Woon Treasury" };

const MEMBERS = [
  { memberId: "athena", name: "Athena", lens: "macro risk", bias: -0.1, present: true },
  { memberId: "boreas", name: "Boreas", lens: "on-chain flows", bias: 0.0, present: true },
  { memberId: "cygnus", name: "Cygnus", lens: "momentum", bias: 0.15, present: true },
  { memberId: "draco", name: "Draco", lens: "contrarian", bias: 0.0, present: false }, // absent
];

const adminHeaders = process.env.ADMIN_TOKEN ? { "X-Admin-Token": process.env.ADMIN_TOKEN } : {};
const admin = (action: string, body: unknown = {}) =>
  fetch(`${BACKEND}/api/committee/admin/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders }, body: JSON.stringify(body),
  }).then((r) => r.json());

async function main() {
  console.log(`\n=== Committee MCP E2E (${today}) ===`);
  await admin("reset"); // re-runnable for today's subject
  await admin("regime", { asof: today });
  await admin("subject", SUBJECT);
  const session = await admin("open", { date: today, subjectId: SUBJECT.id });
  await admin("brief", { sessionId: session.id, windowMinutes: 60 });
  console.log(`session ${session.id}: brief published, window open`);

  // Independent agents participate via the MCP server (the no-show is skipped).
  const present = MEMBERS.filter((m) => m.present);
  const results = await Promise.all(
    present.map((m) => runAgent({ ...m, date: today, subjectId: SUBJECT.id })),
  );
  for (const r of results) {
    const ok = r.result?.verified ? "✓verified" : JSON.stringify(r.result);
    console.log(`  ${r.memberId}: ${r.stance} c=${r.confidence} → ${ok}`);
  }

  await admin("close", { sessionId: session.id });
  const agg = await admin("aggregate", { sessionId: session.id });
  await admin("publish", { sessionId: session.id });
  console.log(`\naggregate: ${JSON.stringify(agg.stances)} participation=${(agg.quorum.participation * 100).toFixed(0)}% absent=${JSON.stringify(agg.absent)}`);

  const pub = await fetch(`${BACKEND}/api/committee/sessions/${today}/${SUBJECT.id}`).then((r) => r.json());
  console.log(`published: state=${pub.session.state}, takes=${pub.takes.length}`);
  console.log(`synthesis: ${pub.session.synthesis}`);
  console.log("=== done ===\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
