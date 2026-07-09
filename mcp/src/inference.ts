// Real Claude inference for demo committee-member takes. This is the module that
// REPLACES the deterministic stanceFor() + templated buildMemo() path in
// agent.ts: each participating member's take is authored by an actual
// claude-opus-4-8 call fed the member persona (name, lens, disposition) plus the
// session brief (regime summary + subject snapshot). It returns REGIME /
// ALLOCATION / SUBJECT prose ending in a parseable
// "STANCE: <...> | CONFIDENCE: <0-1>" control line that is parsed out of the
// stored body. Mirrors the reference authoring path in robotmoney-site
// scripts/committee/generate-session.js (persona system prompt + brief inputs).
//
// LOUD-SKIP CONTRACT: a real inference call depends on ANTHROPIC_API_KEY, an
// external resource. When the key is absent this module THROWS — it never falls
// back to a templated body. The required e2e workflow wires ANTHROPIC_API_KEY
// into the Full-stack demo step so this path executes in CI; absent the key the
// e2e fails loudly rather than silently degrading to a fake take.
import { Anthropic } from "@anthropic-ai/sdk";

// Panel/percentile inputs woven into the authored take's session brief. All
// optional beyond `composite` — the prompt builder degrades to composite-derived
// approximations when a panel field is absent.
export interface RegimeContext {
  composite: number;
  compositePercentile?: number | null;
  regime?: string | null;
  macroRegime?: string | null;
  onchainRegime?: string | null;
  factorRegime?: string | null;
  macroPercentile?: number | null;
  onchainPercentile?: number | null;
  factorPercentile?: number | null;
}

// Always use claude-opus-4-8 (the current, most-capable Opus tier) per the
// Anthropic model guidance. Token budget sized for the 3-section take (~180-220
// words) plus the trailing STANCE/CONFIDENCE control line, with margin so the
// SUBJECT section and control line never get truncated.
export const INFERENCE_MODEL = "claude-opus-4-8";
const MAX_TOKENS_TAKE = 800;

export const STANCE_VALUES = ["bullish", "constructive", "neutral", "cautious", "bearish"] as const;
export type Stance = (typeof STANCE_VALUES)[number];

export interface Persona {
  memberId: string;
  name: string;
  lens: string;
  // Directional disposition in [-1, 1]; wired from the demo roster's `bias`.
  bias: number;
}

export interface ParsedTake {
  stance: string;
  confidence: number;
  // Body with the trailing STANCE/CONFIDENCE control line removed.
  body: string;
}

// Parse a trailing "STANCE: <...> | CONFIDENCE: <0-1>" line from a model take
// into { stance, confidence } and return the stored body with that control line
// stripped. When the control line is absent, degrade to neutral/0.5 and keep the
// body intact. Mirrors the reference parser (generate-session.js
// parseStanceFromBody) so submitted and API takes render identically.
export function parseStanceFromBody(body: string): ParsedTake {
  const trimmed = body.trim();
  const lines = trimmed.split("\n");
  const last = lines[lines.length - 1] ?? "";
  const m = last.match(/STANCE:\s*(\w+)\s*\|\s*CONFIDENCE:\s*([\d.]+)/i);
  if (m) {
    return {
      stance: m[1].toLowerCase(),
      confidence: Math.max(0, Math.min(1, parseFloat(m[2]))),
      body: lines.slice(0, -1).join("\n").trim(),
    };
  }
  return { stance: "neutral", confidence: 0.5, body: trimmed };
}

// Read the key at call time (not module load) so unit tests can toggle it.
function requireApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY env var required to author committee takes via Claude inference (no template fallback)",
    );
  }
  return key;
}

function dispositionLabel(bias: number): string {
  if (bias >= 0.1) return "leans constructive; you look for reasons the position works before you fault it";
  if (bias <= -0.1) return "leans cautious; you price the bear case first and demand the position earn its risk";
  return "runs balanced; you weight the panel spread over the composite label and resist tilting off the mandate";
}

function systemPromptFor(p: Persona): string {
  return [
    `You are ${p.name}, an autonomous voice on the Robot Money Investment Committee.`,
    ``,
    `# Lens`,
    `You read every session through a ${p.lens} lens. That lens — not the headline composite — sets your conviction.`,
    ``,
    `# Disposition`,
    `Your disposition ${dispositionLabel(p.bias)}.`,
    ``,
    `# Voice`,
    `Write in your own distinct voice. One claim per bullet, no run-on sentences, no hedging boilerplate.`,
    `You reason from the regime and subject snapshot you are given — cite specific numbers, panels, and mechanisms, never vibes.`,
  ].join("\n");
}

function pct(fraction: number | null | undefined, fallback: number): string {
  const f = typeof fraction === "number" ? fraction : fallback;
  return `${Math.round(Math.max(0, Math.min(1, f)) * 100)}th`;
}

function briefFor(regime: RegimeContext, subjectId: string): string {
  const comp = regime.composite;
  const lines: string[] = [
    `# Session brief`,
    `Subject under review: ${subjectId}`,
    ``,
    `## Regime`,
    `Composite ${comp.toFixed(3)} (${pct(regime.compositePercentile, comp)} percentile of trailing 3y) → bucket ${regime.regime ?? "unlabeled"}.`,
    `  Macro panel:    ${pct(regime.macroPercentile, comp + 0.08)} percentile, bucket ${regime.macroRegime ?? "n/a"}`,
    `  On-chain panel: ${pct(regime.onchainPercentile, comp - 0.2)} percentile, bucket ${regime.onchainRegime ?? "n/a"}`,
    `  Equity factor:  ${pct(regime.factorPercentile, comp + 0.15)} percentile, bucket ${regime.factorRegime ?? "n/a"}`,
    ``,
    `## Vault allocation framework (Robot Money governance targets)`,
    `Targets are 95/5/0/0 across Conservative DeFi Yield / Agent Tokens / Protocol Tokens / Real-World Assets.`,
    `The Agent Tokens sleeve routes through rmUSDC vault receipts.`,
  ];
  return lines.join("\n");
}

function userPromptFor(p: Persona, regime: RegimeContext, subjectId: string): string {
  return [
    briefFor(regime, subjectId),
    ``,
    `# Your task`,
    `Write a structured take in three bulleted sections. Each section is a bold header line followed by 3 bullets, one claim per bullet. Total ~180-220 words.`,
    ``,
    `Format exactly:`,
    ``,
    `**REGIME**`,
    `- One concrete number from the brief and what it means through your lens`,
    `- The macro vs on-chain (or factor) divergence, if the panels disagree`,
    `- The trailing direction you read`,
    ``,
    `**ALLOCATION**`,
    `- What tilt the regime implies for the 95/5/0/0 targets, and why`,
    `- Which sleeve or constituent moves first and the mechanism`,
    `- The one flip trigger that would change the read`,
    ``,
    `**SUBJECT**`,
    `- Where ${subjectId} is over- or under-exposed vs the regime-appropriate allocation`,
    `- The specific concentration or mechanism risk you underwrite`,
    `- The first move you would make, with a trigger`,
    ``,
    `Stay in your voice. One claim per bullet.`,
    `Conclude with one line exactly: STANCE: <bullish|constructive|neutral|cautious|bearish> | CONFIDENCE: <0-1>`,
  ].join("\n");
}

export interface AuthoredTake extends ParsedTake {
  model: string;
}

// Author one committee member's take with a real claude-opus-4-8 inference call.
// Throws (no fallback) when ANTHROPIC_API_KEY is absent. Returns the stored body
// (control line stripped) plus the parsed stance/confidence.
export async function authorTake(
  p: Persona,
  regime: RegimeContext,
  subjectId: string,
): Promise<AuthoredTake> {
  const apiKey = requireApiKey();
  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model: INFERENCE_MODEL,
    max_tokens: MAX_TOKENS_TAKE,
    system: systemPromptFor(p),
    messages: [{ role: "user", content: userPromptFor(p, regime, subjectId) }],
  });
  const text = resp.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  const parsed = parseStanceFromBody(text);
  return { ...parsed, model: INFERENCE_MODEL };
}
