import { canonicalizeSubmission } from "@robotmoney/contract";

const PORT = 8787;
const MEMBER_ID = "fixture-agent";
const TOKEN = "fixture-member-token";

interface Scenario {
  sessionId: string;
  date: string;
  subjectId: string;
  composite: number;
  evidence: string;
}

const observed = {
  apply: 0,
  activate: 0,
  verifyToken: 0,
  openSession: 0,
  regime: 0,
  brief: 0,
  memo: 0,
  submit: 0,
  verifiedSubmissions: 0,
  publicKey: "",
  memos: [] as Array<{ sessionId?: string; body?: string }>,
  submissions: [] as Array<Record<string, unknown>>,
};

let application: "none" | "pending" | "active" = "none";
let scenario: Scenario = {
  sessionId: "fixture-first-session",
  date: "2026-07-14",
  subjectId: "fixture-treasury",
  composite: 0.731,
  evidence: "FIXTURE_FIRST_EVIDENCE_731",
};
const submissionKeys = new Set<string>();

const json = (data: unknown, status = 200) => Response.json(data, { status });

async function verifySubmission(input: Record<string, unknown>): Promise<boolean> {
  const signature = String(input.signature ?? "");
  const { signature: _signature, ...draft } = input;
  try {
    const publicKey = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(Buffer.from(observed.publicKey, "base64")),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      Uint8Array.from(Buffer.from(signature, "base64")),
      new TextEncoder().encode(canonicalizeSubmission(draft as any)),
    );
  } catch {
    return false;
  }
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/__observed") return json({ ...observed, application, scenario });

    if (url.pathname === "/__scenario" && req.method === "POST") {
      scenario = await req.json() as Scenario;
      return json({ ok: true, scenario });
    }

    if (url.pathname === "/api/committee/apply" && req.method === "POST") {
      observed.apply++;
      const body = await req.json() as { memberId?: string; publicKey?: string };
      if (body.memberId !== MEMBER_ID || !body.publicKey) return json({ error: "invalid application" }, 400);
      if (application !== "none") return json({ error: "already applied" }, 409);
      observed.publicKey = body.publicKey;
      application = "pending";
      return json({ ok: true, status: "pending" }, 201);
    }

    if (url.pathname === "/api/committee/admin/activate" && req.method === "POST") {
      observed.activate++;
      if (application !== "pending") return json({ error: "not pending" }, 409);
      application = "active";
      return json({ ok: true, token: TOKEN });
    }

    if (url.pathname === "/api/committee/verify-token") {
      observed.verifyToken++;
      if (application !== "active" || req.headers.get("Authorization") !== `Bearer ${TOKEN}`) {
        return json({ error: "invalid token" }, 401);
      }
      return json({ memberId: MEMBER_ID });
    }

    if (url.pathname === "/api/committee/open-session") {
      observed.openSession++;
      return json({ id: scenario.sessionId, date: scenario.date, subjectId: scenario.subjectId, state: "collecting" });
    }

    if (url.pathname === "/api/dashboards/regime-snapshots") {
      observed.regime++;
      return json({ latest: { composite: scenario.composite, regime: "risk_on" } });
    }

    if (url.pathname === "/api/committee/brief") {
      observed.brief++;
      return json({
        date: scenario.date,
        subjectId: scenario.subjectId,
        evidence: scenario.evidence,
        summary: `${scenario.subjectId} is underweight its published Agent Tokens sleeve.`,
      });
    }

    if (url.pathname === "/api/committee/memos" && req.method === "POST") {
      observed.memo++;
      const body = await req.json() as { sessionId?: string; body?: string };
      observed.memos.push(body);
      return json({ ok: true, url: `/api/committee/memos/${scenario.sessionId}` });
    }

    if (url.pathname === "/api/committee/submit" && req.method === "POST") {
      observed.submit++;
      const body = await req.json() as Record<string, unknown>;
      const key = `${body.memberId}/${body.date}/${body.subjectId}`;
      if (submissionKeys.has(key)) return json({ ok: false, error: "duplicate" }, 409);
      const verified = await verifySubmission(body);
      if (!verified) return json({ ok: false, verified: false, error: "invalid signature" }, 400);
      submissionKeys.add(key);
      observed.verifiedSubmissions++;
      observed.submissions.push(body);
      return json({ ok: true, verified: true }, 201);
    }

    return json({ error: `unhandled fixture route: ${req.method} ${url.pathname}` }, 404);
  },
});

console.log(`OpenCode tools fixture backend listening on :${PORT}`);
