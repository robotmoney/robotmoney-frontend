#!/usr/bin/env bun
// THE AGENT'S TAKE ONE-SHOT — the program a standing agent participant runs
// once per take (`RM_TAKE_COMMAND`, take-runner.ts; smoke-production-spec.md
// §6.2). scripts/lib/participant-compose.ts renders it into every agent's
// container environment, so the chain the take runner drives is a real one:
// fresh workspace → this process → a draft line → a signed submission.
//
// ── WHAT IT DOES, AND ONLY THAT ─────────────────────────────────────────────
//   1. Reads its own context over REST, with this member's bearer — the
//      harness supplies none: the member record (lens), the latest regime
//      snapshot, and the session's brief (sleeve targets, report binding).
//   2. Asks the model on this member's OWN key (`RM_INFERENCE_KEY`, from its
//      credential-file entry, D52), at the endpoint and model id the boot
//      resolved (`RM_INFERENCE_URL`, `RM_INFERENCE_WIRE_ID`). The prompt is
//      production's persona prompt (take-prompt.ts `promptFor`): lens, bias,
//      regime numbers, bold REGIME / ALLOCATION-or-SUBJECT sections, and a
//      STANCE control line. A take missing a section is asked for once more,
//      then refused.
//   3. Posts the take as the member's memo, then prints exactly one
//      `RM_TAKE_DRAFT {json}` line: memberId, date, subjectId, stance,
//      confidence, body, memoUrl — plus the allocation weights when the session
//      asks for them, and the brief's report binding when it has one. The take
//      runner signs and submits it; this process holds no signing key.
//
// ── IT REFUSES RATHER THAN INVENTS ──────────────────────────────────────────
// A model that cannot be reached, answers a status, or answers something that
// is not a well-formed take makes this process exit non-zero with the reason
// on stderr. The take runner reports that outcome and submits nothing. There
// is no default stance and no stock body: a take this member did not author is
// worse than no take.
import { classifyRegime, ROUTES, path as routePath } from "@robotmoney/contract";
import {
  IN_HOUSE_PERSONAS,
  missingSectionLeadIns,
  parseStanceFromBody,
  parseWeightsFromBody,
  promptFor,
  sleeveTargetsFromBrief,
  type Persona,
  type RegimeContext,
  type SleeveTarget,
  type TakeWeight,
} from "./take-prompt.ts";
import { TAKE_DRAFT_TAG } from "./take-runner.ts";

/** What this one-shot is handed (take-runner.ts `oneShotEnv`). */
export interface AuthorTakeEnv {
  apiUrl: string;
  memberId: string;
  memberName: string;
  token: string;
  sessionId: string;
  subjectId: string;
  date: string;
  inferenceKey: string;
  inferenceUrl: string;
  inferenceWireId: string;
}

/** Read the one-shot's environment, refusing by NAME on anything missing. */
export function readAuthorTakeEnv(env: Record<string, string | undefined>): AuthorTakeEnv {
  const need = (key: string): string => {
    const value = (env[key] ?? "").trim();
    if (value === "") throw new Error(`${key} was not handed to the take one-shot`);
    return value;
  };
  return {
    apiUrl: need("RM_API_URL").replace(/\/+$/, ""),
    memberId: need("RM_MEMBER_ID"),
    memberName: need("RM_MEMBER_NAME"),
    token: need("RM_MEMBER_TOKEN"),
    sessionId: need("RM_SESSION_ID"),
    subjectId: need("RM_SUBJECT_ID"),
    date: need("RM_SESSION_DATE"),
    inferenceKey: need("RM_INFERENCE_KEY"),
    inferenceUrl: need("RM_INFERENCE_URL"),
    inferenceWireId: need("RM_INFERENCE_WIRE_ID"),
  };
}

/** What the session tells this take: who is writing, the regime, the brief's targets, the report binding. */
export interface TakeContext {
  persona: Persona;
  regime: RegimeContext;
  requireWeights: boolean;
  targets: SleeveTarget[];
  reportSnapshotId?: string;
}

/**
 * Read what the prompt is built from, all over REST with this member's bearer
 * (the participant holds no database credential):
 *  - the member's own record, for its lens (a failed read falls back to the
 *    in-house table, then to a neutral lens, never to a made-up one);
 *  - the latest regime snapshot, the numbers every take cites;
 *  - the session's brief (404 is legitimate: no brief yet) for the sleeve
 *    targets in force, the report binding and, when the brief does not say which
 *    kind of recommendation it wants, the subject.
 */
export async function readTakeContext(cfg: AuthorTakeEnv, fetchImpl: typeof fetch = fetch): Promise<TakeContext> {
  const headers = { Authorization: `Bearer ${cfg.token}` };
  const memberRes = await fetchImpl(`${cfg.apiUrl}${routePath(ROUTES.swarm.member, { id: cfg.memberId })}`, { headers });
  const member = memberRes.ok ? ((await memberRes.json()) as { lens?: unknown } | null) : null;
  const known = IN_HOUSE_PERSONAS[cfg.memberId];
  const lens =
    typeof member?.lens === "string" && member.lens.trim() !== "" ? member.lens.trim() : (known?.lens ?? "generalist");

  const regimeRes = await fetchImpl(`${cfg.apiUrl}${ROUTES.dashboards.regimeSnapshots}?range=1`, { headers });
  if (!regimeRes.ok) throw new Error(`${ROUTES.dashboards.regimeSnapshots} answered HTTP ${regimeRes.status}`);
  const latest = ((await regimeRes.json()) as { latest?: Record<string, any> } | null)?.latest ?? {};
  const pick = (camel: string, snake: string) => latest[camel] ?? latest[snake] ?? null;
  const regime: RegimeContext = {
    composite: Number(latest.composite ?? 0.5),
    compositePercentile: pick("compositePercentile", "composite_percentile"),
    regime: latest.regime ?? null,
    macroRegime: pick("macroRegime", "macro_regime"),
    onchainRegime: pick("onchainRegime", "onchain_regime"),
    factorRegime: pick("factorRegime", "factor_regime"),
    macroPercentile: pick("macroPercentile", "macro_percentile"),
    onchainPercentile: pick("onchainPercentile", "onchain_percentile"),
    factorPercentile: pick("factorPercentile", "factor_percentile"),
  };

  const briefRes = await fetchImpl(`${cfg.apiUrl}${ROUTES.swarm.brief}?session=${encodeURIComponent(cfg.sessionId)}`, { headers });
  if (!briefRes.ok && briefRes.status !== 404) throw new Error(`${ROUTES.swarm.brief} answered HTTP ${briefRes.status}`);
  const brief = briefRes.ok ? ((await briefRes.json()) as { body?: { subject?: { recommendationType?: string | null } }; reportSnapshotId?: unknown }) : null;
  let recommendationType = brief?.body?.subject?.recommendationType ?? null;
  if (recommendationType == null) {
    const subjectRes = await fetchImpl(`${cfg.apiUrl}${routePath(ROUTES.swarm.subject, { id: cfg.subjectId })}`, { headers });
    if (subjectRes.ok) recommendationType = ((await subjectRes.json()) as { recommendationType?: string | null }).recommendationType ?? null;
  }
  const reportSnapshotId = typeof brief?.reportSnapshotId === "string" && brief.reportSnapshotId !== "" ? brief.reportSnapshotId : undefined;
  return {
    persona: { memberId: cfg.memberId, name: cfg.memberName, lens, bias: known?.bias ?? 0 },
    regime,
    requireWeights: recommendationType === "bucket_weights",
    targets: sleeveTargetsFromBrief(brief?.body),
    ...(reportSnapshotId === undefined ? {} : { reportSnapshotId }),
  };
}

/** The one prompt: production's persona prompt, built from this member's context. */
export function takePrompt(cfg: AuthorTakeEnv, context: TakeContext): string {
  return promptFor(context.persona, context.regime, cfg.subjectId, {
    requireWeights: context.requireWeights,
    targets: context.targets,
  });
}

/**
 * A readable answer that omits a required section or the allocation: an
 * unlucky sample, so the caller asks again and refuses once attempts run out.
 */
export class ShortTakeError extends Error {}

/** How many times the model is asked for a take that carries every section. Production's number. */
export const STRUCTURE_ATTEMPTS = 2;

/** The draft the take runner signs, or a refusal naming what was wrong. */
export function parseTakeAnswer(
  answer: string,
  cfg: AuthorTakeEnv,
  context: TakeContext,
): Record<string, unknown> {
  // A missing control line or a stance outside the vocabulary is the model
  // saying something else entirely: it throws here and is not re-sampled.
  const parsed = parseStanceFromBody(answer);
  let body = parsed.body;
  let weights: TakeWeight[] | undefined;
  if (context.requireWeights) {
    try {
      const withWeights = parseWeightsFromBody(body);
      weights = withWeights.weights;
      body = withWeights.body;
    } catch (err) {
      throw new ShortTakeError(err instanceof Error ? err.message : String(err));
    }
  }
  const missing = missingSectionLeadIns(body, { requireWeights: context.requireWeights });
  if (missing.length > 0) {
    throw new ShortTakeError(`the take omitted the ${missing.join(", ")} section${missing.length === 1 ? "" : "s"}`);
  }
  // Production's one provenance footnote, from the shared classifier.
  if (cfg.memberId === "cygnus") {
    body += `\n\n_Provenance: RM classifier: composite ${context.regime.composite.toFixed(3)} → ${classifyRegime(context.regime.composite)}_`;
  }
  const draft: Record<string, unknown> = {
    memberId: cfg.memberId,
    date: cfg.date,
    subjectId: cfg.subjectId,
    stance: parsed.stance,
    confidence: parsed.confidence,
    body,
  };
  if (weights) draft.weights = weights;
  if (context.reportSnapshotId !== undefined) draft.reportSnapshotId = context.reportSnapshotId;
  return draft;
}

/**
 * Post the take as this member's memo and return its url. Production posts the
 * memo before it submits, and a memo that cannot be posted fails the take.
 */
export async function postMemo(
  cfg: AuthorTakeEnv,
  body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const res = await fetchImpl(`${cfg.apiUrl}${ROUTES.swarm.memos}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify({ sessionId: cfg.sessionId, title: `${cfg.memberName}'s analysis of ${cfg.subjectId}`, body }),
  });
  const parsed = (await res.json().catch(() => null)) as { ok?: boolean; url?: string; error?: unknown } | null;
  if (!res.ok) throw new Error(`${ROUTES.swarm.memos} failed with HTTP ${res.status}${parsed?.error ? `: ${String(parsed.error)}` : ""}`);
  return parsed?.ok ? parsed.url : undefined;
}

/** One model call on this member's own key. Throws on any status or unreadable answer. */
export async function askModel(cfg: AuthorTakeEnv, prompt: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${cfg.inferenceUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.inferenceKey}` },
    body: JSON.stringify({ model: cfg.inferenceWireId, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`the model endpoint answered HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 400)}`);
  const content = ((await res.json()) as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") throw new Error("the model's answer carried no text");
  return content;
}

/** The whole one-shot: context, one model call, one draft line. */
export async function authorTakeDraft(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const cfg = readAuthorTakeEnv(env);
  const context = await readTakeContext(cfg, fetchImpl);
  const prompt = takePrompt(cfg, context);
  let shortfall = "";
  for (let attempt = 1; attempt <= STRUCTURE_ATTEMPTS; attempt++) {
    const answer = await askModel(cfg, prompt, fetchImpl);
    let draft: Record<string, unknown>;
    try {
      draft = parseTakeAnswer(answer, cfg, context);
    } catch (err) {
      if (!(err instanceof ShortTakeError)) throw err;
      shortfall = err.message;
      console.error(`take attempt ${attempt}/${STRUCTURE_ATTEMPTS}: ${shortfall}; asking again`);
      continue;
    }
    const memoUrl = await postMemo(cfg, String(draft.body), fetchImpl);
    return memoUrl === undefined ? draft : { ...draft, memoUrl };
  }
  throw new Error(
    `the take failed the structure contract on all ${STRUCTURE_ATTEMPTS} attempts (${shortfall}); nothing is published`,
  );
}

if (import.meta.main) {
  try {
    const draft = await authorTakeDraft(process.env);
    console.log(`${TAKE_DRAFT_TAG} ${JSON.stringify(draft)}`);
  } catch (err) {
    // No fallback: the take runner reports the refusal and submits nothing.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
