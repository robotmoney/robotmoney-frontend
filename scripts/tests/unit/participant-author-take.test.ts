// The standing participants' take one-shot writes PRODUCTION's take (issue 1116).
//
// Production's analysts wrote persona-voiced, sectioned takes with a memo:
// the prompt carries the member's lens and bias, the regime numbers and the
// three bold sections (guidance, owner 2026-10-06), a take the judge cannot read
// marks the member absent, and every take posts a memo whose url rides the signed draft. The one-shot used to ask
// one generic "your reasoning in plain prose" question. These tests pin the
// production shape at the one-shot's own seams, with a stubbed `fetch`.
//
// Cost class `unit` (docs/architecture.md §3 L1): no Docker, no network.
import { describe, expect, test } from "bun:test";
import { RECEIPT_CANONICAL_BUCKET_ORDER, ROUTES } from "@robotmoney/contract";
import {
  authorTakeDraft,
  readAuthorTakeEnv,
  readTakeContext,
  STRUCTURE_ATTEMPTS,
  takePrompt,
} from "../../agent/participant/author-take.ts";
import { IN_HOUSE_PERSONAS, judgeShortfalls, MIN_TAKE_WORDS, promptFor, takeSectionLeadIns } from "../../agent/participant/take-prompt.ts";
import { DEMO_MEMBERS } from "../../lib/smoke-mode.ts";

const ENV = {
  RM_API_URL: "http://api.test",
  RM_MEMBER_ID: "athena",
  RM_MEMBER_NAME: "Athena",
  RM_MEMBER_TOKEN: "tok",
  RM_SESSION_ID: "s-1",
  RM_SUBJECT_ID: "woon",
  RM_SESSION_DATE: "2026-10-03",
  RM_INFERENCE_KEY: "k",
  RM_INFERENCE_URL: "http://model.test/v1",
  RM_INFERENCE_WIRE_ID: "w",
};

const WEIGHTS_LINE = `WEIGHTS: ${RECEIPT_CANONICAL_BUCKET_ORDER.map((b, i) => `${b}=${[0.55, 0.15, 0.2, 0.1][i]}`).join(" | ")}`;
/** A body of `n` words of plain prose: enough for the judge to read a position from. */
const prose = (n: number): string => Array.from({ length: n }, (_, i) => (i % 9 === 8 ? "cautious," : "tape")).join(" ");
const ENOUGH = prose(MIN_TAKE_WORDS + 20);
const GOOD_SUBJECT = `**REGIME**\n- composite 0.41\n\n**ALLOCATION**\n- Tilt to yield.\n\n**SUBJECT**\n- Woon is long beta into a cautious tape: ${ENOUGH}\n\nSTANCE: cautious | CONFIDENCE: 0.6`;
const GOOD_ALLOCATION = `**REGIME**\n- composite 0.41\n\n**ALLOCATION**\n- Tilt to yield: ${ENOUGH}\n\n${WEIGHTS_LINE}\nSTANCE: cautious | CONFIDENCE: 0.6`;

interface Api {
  recommendationType: string;
  answers: string[];
  memoStatus?: number;
  calls: { memos: Record<string, unknown>[]; model: number; prompts: string[] };
}

function fakeFetch(api: Api): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === ROUTES.swarm.brief) {
      return Response.json({
        body: {
          subject: { recommendationType: api.recommendationType },
          allocation: { buckets: [{ id: "agent_tokens", name: "Agent Tokens", target_weight: 0.05, items: [{ name: "Virtuals" }] }] },
        },
      });
    }
    if (url.pathname === ROUTES.dashboards.regimeSnapshots) {
      return Response.json({ latest: { composite: 0.412, regime: "neutral", macro_regime: "tight", macro_percentile: 0.7 } });
    }
    if (url.pathname.startsWith("/api/swarm/members/")) return Response.json({ id: "athena", lens: "macro risk" });
    if (url.pathname === ROUTES.swarm.memos) {
      api.calls.memos.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, url: "https://example.test/memo/1" }, { status: api.memoStatus ?? 200 });
    }
    if (url.pathname === "/v1/chat/completions") {
      api.calls.model += 1;
      api.calls.prompts.push(JSON.parse(String(init?.body)).messages[0].content);
      const content = api.answers.shift() ?? "";
      return Response.json({ choices: [{ message: { content } }] });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const newApi = (answers: string[], recommendationType = "stance"): Api => ({
  recommendationType,
  answers,
  calls: { memos: [], model: 0, prompts: [] },
});

describe("the take prompt is production's persona prompt", () => {
  test("athena's prompt carries her lens, her cautious bias, the regime numbers and the sections", async () => {
    const cfg = readAuthorTakeEnv(ENV);
    const context = await readTakeContext(cfg, fakeFetch(newApi([])));
    const prompt = takePrompt(cfg, context);
    expect(prompt).toBe(
      promptFor({ memberId: "athena", name: "Athena", lens: "macro risk", bias: -0.1 }, context.regime, "woon", {
        requireWeights: false,
        targets: context.targets,
      }),
    );
    expect(prompt).toContain("You are Athena, an autonomous voice on the Robot Money Investment Swarm.");
    expect(prompt).toContain("through a macro risk lens");
    expect(prompt).toContain("leans cautious");
    expect(prompt).toContain("Composite 0.412");
    // Three sections for every take, production's (owner 2026-10-06), whatever the subject.
    for (const section of ["**REGIME**", "**ALLOCATION**", "**SUBJECT**"]) expect(prompt).toContain(section);
    expect(prompt).toContain("exactly three bulleted sections");
    expect(prompt).not.toContain("your reasoning in plain prose");
  });

  test("a bucket_weights subject asks for the four-weight line and the brief's own targets", async () => {
    const cfg = readAuthorTakeEnv(ENV);
    const context = await readTakeContext(cfg, fakeFetch(newApi([], "bucket_weights")));
    expect(context.requireWeights).toBe(true);
    const prompt = takePrompt(cfg, context);
    for (const section of ["**REGIME**", "**ALLOCATION**", "**SUBJECT**"]) expect(prompt).toContain(section);
    expect(prompt).toContain("Sleeve targets in force: Agent Tokens 5% (Virtuals)");
    for (const bucket of RECEIPT_CANONICAL_BUCKET_ORDER) expect(prompt).toContain(`${bucket}=<0-1>`);
  });

  test("the in-house lens and bias table is the one the scenario roster uses", () => {
    for (const [id, persona] of Object.entries(IN_HOUSE_PERSONAS)) {
      const member = DEMO_MEMBERS.find((m) => m.memberId === id);
      expect({ id, lens: member?.lens, bias: member?.bias }).toEqual({ id, lens: persona.lens, bias: persona.bias });
    }
  });
});

describe("the one-shot refuses a take the judge cannot read, and posts a memo for one it can", () => {
  test("a stub is asked for again, then refused: no memo, no draft", async () => {
    const api = newApi(["Athena thinks it is fine.\nSTANCE: cautious | CONFIDENCE: 0.6", "Still a stub.\nSTANCE: cautious | CONFIDENCE: 0.6"]);
    await expect(authorTakeDraft(ENV, fakeFetch(api))).rejects.toThrow(new RegExp(`at least ${MIN_TAKE_WORDS}`));
    expect(api.calls.model).toBe(STRUCTURE_ATTEMPTS);
    expect(api.calls.memos).toEqual([]);
  });

  test("a take with no section headers is NOT refused for that: sections are guidance, the judge reads the prose", async () => {
    const api = newApi([`${ENOUGH}\nSTANCE: cautious | CONFIDENCE: 0.6`]);
    const draft = await authorTakeDraft(ENV, fakeFetch(api));
    expect(api.calls.model).toBe(1);
    expect(draft).toMatchObject({ memberId: "athena", stance: "cautious", confidence: 0.6, memoUrl: "https://example.test/memo/1" });
  });

  test("a stub is re-sampled, and the second, readable sample is published", async () => {
    const api = newApi(["**REGIME**\n- only this\n\nSTANCE: cautious | CONFIDENCE: 0.6", GOOD_SUBJECT]);
    const draft = await authorTakeDraft(ENV, fakeFetch(api));
    expect(api.calls.model).toBe(2);
    expect(draft).toMatchObject({ memberId: "athena", subjectId: "woon", stance: "cautious", confidence: 0.6, memoUrl: "https://example.test/memo/1" });
  });

  test("a good take posts its body as the member's memo and carries the memo url", async () => {
    const api = newApi([GOOD_SUBJECT]);
    const draft = await authorTakeDraft(ENV, fakeFetch(api));
    expect(api.calls.memos).toEqual([{ sessionId: "s-1", title: "Athena's analysis of woon", body: draft.body }]);
    expect(draft.memoUrl).toBe("https://example.test/memo/1");
    expect(String(draft.body)).toContain("**SUBJECT**");
    expect(String(draft.body)).not.toContain("STANCE:");
    expect(draft).not.toHaveProperty("weights");
  });

  test("a memo that cannot be posted fails the take", async () => {
    const api = newApi([GOOD_SUBJECT]);
    api.memoStatus = 500;
    await expect(authorTakeDraft(ENV, fakeFetch(api))).rejects.toThrow(/memos failed with HTTP 500/);
  });

  test("a bucket_weights take carries exactly the four weights, and one without them is refused", async () => {
    const ok = newApi([GOOD_ALLOCATION], "bucket_weights");
    const draft = await authorTakeDraft(ENV, fakeFetch(ok));
    expect(draft.weights).toEqual(RECEIPT_CANONICAL_BUCKET_ORDER.map((bucket, i) => ({ bucket, weight: [0.55, 0.15, 0.2, 0.1][i] })));
    expect(String(draft.body)).not.toContain("WEIGHTS");

    const noWeights = `**REGIME**\n- x\n\n**ALLOCATION**\n- ${ENOUGH}\n\nSTANCE: cautious | CONFIDENCE: 0.6`;
    const bad = newApi([noWeights, noWeights], "bucket_weights");
    await expect(authorTakeDraft(ENV, fakeFetch(bad))).rejects.toThrow(/WEIGHTS/);
    expect(bad.calls.memos).toEqual([]);
  });

  test("a missing control line is not re-sampled: the member is absent", async () => {
    const api = newApi([`**REGIME**\n- x\n\n**SUBJECT**\n- ${ENOUGH}`]);
    await expect(authorTakeDraft(ENV, fakeFetch(api))).rejects.toThrow(/control line/);
    expect(api.calls.model).toBe(1);
  });

  test("cygnus keeps production's provenance footnote on the stored body and the memo; no other member gets it", async () => {
    const api = newApi([GOOD_SUBJECT]);
    const draft = await authorTakeDraft({ ...ENV, RM_MEMBER_ID: "cygnus", RM_MEMBER_NAME: "Cygnus" }, fakeFetch(api));
    expect(String(draft.body)).toEndWith("_Provenance: RM classifier: composite 0.412 → neutral_");
    expect(api.calls.memos[0]?.body).toBe(draft.body);
    const other = await authorTakeDraft(ENV, fakeFetch(newApi([GOOD_SUBJECT])));
    expect(String(other.body)).not.toContain("Provenance");
  });
});

describe("judgeShortfalls: what a take must carry is what the judge reads", () => {
  test("the word floor is the whole body check: at the floor passes, one under fails", () => {
    expect(judgeShortfalls(prose(MIN_TAKE_WORDS))).toEqual([]);
    expect(judgeShortfalls(prose(MIN_TAKE_WORDS - 1))).toEqual([
      `the take body has ${MIN_TAKE_WORDS - 1} word(s); the judge needs at least ${MIN_TAKE_WORDS} to read a position from`,
    ]);
    expect(judgeShortfalls("   \n  ")).toHaveLength(1);
  });

  test("no section header is required, whatever the subject, and the prompt still asks for all three", () => {
    expect(judgeShortfalls(prose(MIN_TAKE_WORDS + 5))).toEqual([]);
    expect(takeSectionLeadIns({ requireWeights: true })).toEqual(["**REGIME**", "**ALLOCATION**", "**SUBJECT**"]);
    expect(takeSectionLeadIns({ requireWeights: false })).toEqual(["**REGIME**", "**ALLOCATION**", "**SUBJECT**"]);
  });
});
