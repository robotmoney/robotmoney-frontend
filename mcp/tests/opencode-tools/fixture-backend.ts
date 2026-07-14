const PORT = 8787;
const MEMBER_ID = "fixture-agent";
const TOKEN = "fixture-member-token";

const observed = {
  register: 0,
  verifyToken: 0,
  regime: 0,
  brief: 0,
  memo: 0,
  memoBody: "",
};

const json = (data: unknown, status = 200) => Response.json(data, { status });

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/__observed") return json(observed);

    if (url.pathname === "/api/committee/register" && req.method === "POST") {
      observed.register++;
      const body = await req.json() as { memberId?: string };
      if (body.memberId !== MEMBER_ID) return json({ error: "unexpected member" }, 400);
      return json({ token: TOKEN });
    }

    if (url.pathname === "/api/committee/verify-token") {
      observed.verifyToken++;
      if (req.headers.get("Authorization") !== `Bearer ${TOKEN}`) return json({ error: "invalid token" }, 401);
      return json({ memberId: MEMBER_ID });
    }

    if (url.pathname === "/api/dashboards/regime-snapshots") {
      observed.regime++;
      return json({ latest: { composite: 0.731, regime: "risk_on" } });
    }

    if (url.pathname === "/api/committee/brief") {
      observed.brief++;
      return json({
        date: "2026-07-14",
        subjectId: "fixture-treasury",
        evidence: "FIXTURE_MCP_EVIDENCE_731",
        summary: "Fixture treasury is underweight its published Agent Tokens sleeve.",
      });
    }

    if (url.pathname === "/api/committee/memos" && req.method === "POST") {
      observed.memo++;
      const body = await req.json() as { body?: string };
      observed.memoBody = body.body ?? "";
      return json({ ok: true, url: "/api/committee/memos/fixture-memo" });
    }

    return json({ error: `unhandled fixture route: ${req.method} ${url.pathname}` }, 404);
  },
});

console.log(`OpenCode tools fixture backend listening on :${PORT}`);

