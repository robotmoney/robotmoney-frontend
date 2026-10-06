// THE TAKE PROMPT AND ITS PARSERS — the pure half of authoring a take.
//
// One definition, two callers. The in-house driver (scripts/lib/swarm/
// inference.ts) and the standing participants' take one-shot (author-take.ts)
// both write the SAME persona prompt and read the SAME answer shape from here,
// so production's voice and structure contract cannot drift between them. It
// lives under scripts/agent/participant/ because the participant image copies
// that directory and nothing else of scripts/lib: it imports only the contract.
import { RECEIPT_CANONICAL_BUCKET_ORDER, STANCES } from "@robotmoney/contract";
import type { Stance } from "@robotmoney/contract";

// Regime inputs passed to each live author. This used to live beside the retired
// deterministic memo template; it belongs with the only remaining authoring
// path so a future fallback cannot accidentally reappear through that module.
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

// The bold section headers `promptFor` demands, and the ONLY definition of
// them. session.ts's post-session `assertAuthoredTakes` reads the same sets, so
// the prompt, the author-time check, and the harness assertion can never drift
// into disagreeing about what the model is asked for. What a take must CARRY is
// `judgeShortfalls`, not these headers.
//
// THREE SECTIONS FOR EVERY TAKE (owner, 2026-10-06): REGIME, ALLOCATION, then
// SUBJECT, exactly production's v0.5.4 prompt. main's #1025 had made them follow
// the subject (two sections); the owner chose production's three. They shape what
// the model is asked for and are NOT enforced: see `judgeShortfalls`.
const TAKE_SECTIONS: readonly string[] = Object.freeze(["**REGIME**", "**ALLOCATION**", "**SUBJECT**"]);

/** The section headers every take is asked for, in order. `options` is kept for callers and changes nothing. */
export function takeSectionLeadIns(_options: { requireWeights?: boolean } = {}): readonly string[] {
  return TAKE_SECTIONS;
}

// Which section headers a take body lacks ([] when it has them all). GUIDANCE ONLY
// since 2026-10-06 (owner): the sections shape what the model is asked for, and
// nothing refuses a take for omitting one. What a take MUST carry is what the
// judge reads, `judgeShortfalls` below. In production (2026-09-26/27) Woon's
// takes carried no SUBJECT header and a header check threw after the session had
// already published, judged, with a receipt.
export function missingSectionLeadIns(body: string, options: { requireWeights?: boolean } = {}): readonly string[] {
  return takeSectionLeadIns(options).filter((lead) => !body.includes(lead));
}

/**
 * The fewest words a take body may have. The judge quotes a member's position as
 * evidence and finds disagreements between positions, so a stub gives it nothing
 * to read. Production's takes run about 140 to 180 words; this is a floor against
 * stubs, not a target.
 */
export const MIN_TAKE_WORDS = 40;

/**
 * THE JUDGE-READY CONTRACT (owner, 2026-10-06: "enforce not by section but by
 * what the judge needs"). The judge (backend/src/swarm/judge.ts) reads, per take,
 * the stance, the confidence, the body and the member's own proposed weights. It
 * needs each take to state a position it can quote and compare. What a take must
 * carry, and who checks it:
 *
 *  - a stance in the vocabulary and a confidence in [0, 1]: `parseStanceFromBody`
 *    (a missing control line is a member who cannot state a stance, not re-sampled);
 *  - on an allocation session, a valid four-bucket weight vector: `parseWeightsFromBody`;
 *  - a body of at least {@link MIN_TAKE_WORDS} words of prose: this function.
 *
 * Returns the reasons this body is not judge-ready ([] when it is). Pure, so the
 * unit suite can pin it, and the ONLY body check the author-time paths and the
 * post-session harness share.
 */
export function judgeShortfalls(body: string): string[] {
  const words = body.trim().split(/\s+/).filter((w) => w.length > 0).length;
  return words >= MIN_TAKE_WORDS ? [] : [`the take body has ${words} word(s); the judge needs at least ${MIN_TAKE_WORDS} to read a position from`];
}

// A sleeve target in force, as the session's own brief carried it
// (`body.allocation.buckets`, weights as fractions of the whole).
export interface SleeveTarget {
  id: string;
  name: string;
  weight: number;
  items?: string[];
}

// The targets a brief carried, in its order; [] when it carried none (a
// portfolio's brief, or one published before the framework was read). Never
// a default: a target the brief did not state is not handed to a member.
export function sleeveTargetsFromBrief(body: unknown): SleeveTarget[] {
  const buckets = (body as { allocation?: { buckets?: unknown } } | null | undefined)?.allocation?.buckets;
  if (!Array.isArray(buckets)) return [];
  return buckets
    .map((b: any) => ({
      id: String(b?.id ?? ""),
      name: String(b?.name ?? b?.id ?? ""),
      weight: Number(b?.target_weight),
      items: Array.isArray(b?.items) ? b.items.map((i: any) => String(i?.name ?? i?.id ?? "")).filter(Boolean) : [],
    }))
    .filter((b) => b.id && Number.isFinite(b.weight) && b.weight >= 0);
}

// "Conservative DeFi Yield 95% (Aave, Morpho, Compound, Sky) / Agent Tokens 5% …"
function targetsLine(targets: readonly SleeveTarget[]): string {
  return targets
    .map((t) => `${t.name} ${+(t.weight * 100).toFixed(1)}%${t.items?.length ? ` (${t.items.join(", ")})` : ""}`)
    .join(" / ");
}

// ── THE ALLOCATION VECTOR (Project Fusion, AC-FMT-03/04) ────────────────────
//
// A `bucket_weights` subject asks the swarm for a NUMBER, not only prose, and
// until this existed no analyst code path could state one: `AuthoredTake` was
// {body, stance, confidence} and the prompt asked for three PROSE sections, so
// `meanTakeWeights()` had nothing to average and every published receipt
// omitted `weights` — legally, silently, and with every layer below behaving
// correctly.
//
// THE CARRIER IS A CONTROL LINE, NOT AN EMBEDDED JSON BLOCK, and that was
// decided by test rather than taste (see the RC2 evidence bundle's
// D1-two-designs-weights-carrier). A fenced JSON block leaves the numbers in
// `body`, and `body` travels inside the signed canonical bytes AND is copied
// VERBATIM into the receipt's `judge.disagreements[].positions[].view`. The
// receipt verifier can recompute `weights` from the embedded submissions; it
// cannot recompute prose. So that design publishes the allocation twice in one
// signed artifact with only one half checkable. A control line is STRIPPED from
// the stored body exactly as `STANCE:` already is, so the vector exists exactly
// once in the payload — in the field a stranger can reproduce.
export const TAKE_WEIGHTS_LEAD_IN = "WEIGHTS:";

// The four buckets, in the receipt's canonical order — DERIVED from the
// contract constant, never re-declared, so the prompt, this parser and
// `RECEIPT_CANONICAL_BUCKET_ORDER` can never drift into disagreeing about which
// four vaults exist.
export const TAKE_WEIGHT_BUCKETS: readonly string[] = Object.freeze([...RECEIPT_CANONICAL_BUCKET_ORDER]);

/**
 * Parse a trailing `WEIGHTS: <bucket>=<n> | …` line into the canonical
 * four-bucket vector and return the body with that line stripped.
 *
 * Call it on the body `parseStanceFromBody()` already returned: the two control
 * lines are the last two lines of the take, STANCE last, so each parser reads
 * the line the previous one uncovered.
 *
 * THROWS on anything short of the exact four buckets — a missing line, a
 * partial vector, an unknown bucket, a duplicate, a negative or non-finite
 * share, or an all-zero vector. It NEVER fills a bucket in, defaults one to
 * zero, or renormalizes: a fabricated allocation is a fabricated signed vote,
 * which is the same rule `parseStanceFromBody` already applies to a fabricated
 * stance. `authorTake()` turns the throw into a RE-SAMPLE, exactly as it does
 * for a missing section, and an exhausted retry renders the member ABSENT.
 *
 * The values are carried RAW. Percentages (60/15/15/10) and fractions
 * (0.6/0.15/0.15/0.1) are the same vector: the server's
 * `normalizedTakeWeights()` divides by the total before averaging, so this
 * function's only arithmetic obligation is to refuse a vector that cannot be
 * normalized at all.
 *
 * THE UNIT IS A PROPERTY OF THE LINE, NOT OF EACH ENTRY. That is the one shape
 * where "carried raw" stops being harmless: `agent_tokens=10% |
 * conservative_defi_yield=0.85 | protocol_tokens=0.04 | real_world_assets=0.01`
 * used to parse, because `%` was stripped and the value kept, and then
 * normalized to 91.74 / 7.80 / 0.37 / 0.09 — an allocation nobody wrote,
 * signed by the analyst and verifiable by the receipt, because the verifier
 * recomputes the same mean from the same signed bytes. A line that mixes the
 * two notations is REFUSED and re-sampled, which is this module's existing rule
 * for anything it cannot read.
 *
 * AND IT TOLERATES THE DECORATION `STANCE:` ALREADY TOLERATES. `parseStanceFromBody`
 * matches its control line anywhere in the last line; anchoring this one at the
 * start of the line made markdown the stance parser shrugs off — `**WEIGHTS:**
 * …`, a leading `- `, comma separators, a trailing period — fatal, and the cost
 * of that asymmetry is a re-sample and then an ABSENT member, i.e. a session
 * dropping below quorum over a formatting quirk. The COLON is still required,
 * so a sentence merely containing the word stays a missing line rather than an
 * unparseable one.
 */
export function parseWeightsFromBody(body: string): { weights: TakeWeight[]; body: string } {
  const lines = body.trim().split("\n");
  const last = lines[lines.length - 1] ?? "";
  // Anywhere in the line, through optional `**` bold and after any bullet, but
  // the colon is mandatory — see the header. The payload is everything after it.
  const m = last.match(/WEIGHTS\s*\**\s*:\s*\**\s*(.+?)\s*$/i);
  if (!m) {
    throw new Error(
      `model take is missing its trailing "${TAKE_WEIGHTS_LEAD_IN} ` +
        `${TAKE_WEIGHT_BUCKETS.map((b) => `${b}=<0-1>`).join(" | ")}" line, which a bucket_weights subject requires — ` +
        `the take is re-sampled and, failing that, the member is rendered ABSENT; no allocation is ever synthesized. ` +
        `Last line of the take was: ${JSON.stringify(last.slice(0, 200))}`,
    );
  }
  const byBucket = new Map<string, number>();
  // `|`, `,` and `;` all separate entries. A comma cannot be ambiguous here:
  // every value is a bare decimal with a `.` radix point, so nothing an entry
  // can legally contain is a comma.
  const percentOf: boolean[] = [];
  for (const part of m[1].split(/[|,;]/)) {
    const kv = part.trim().match(/^\**\s*([A-Za-z_]+)\s*\**\s*[=:]\s*\**\s*([0-9]*\.?[0-9]+)\s*(%?)\s*\**\s*\.?$/);
    if (!kv) {
      throw new Error(
        `model take's ${TAKE_WEIGHTS_LEAD_IN} line carries the unparseable entry ${JSON.stringify(part.trim().slice(0, 80))} — ` +
          `each entry must read <bucket>=<number>. The take is re-sampled, never patched.`,
      );
    }
    const bucket = kv[1].toLowerCase();
    if (byBucket.has(bucket)) {
      throw new Error(`model take's ${TAKE_WEIGHTS_LEAD_IN} line names bucket '${bucket}' twice — the take is re-sampled, never de-duplicated.`);
    }
    const weight = Number(kv[2]);
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`model take's ${TAKE_WEIGHTS_LEAD_IN} line gives bucket '${bucket}' the share ${JSON.stringify(kv[2])}, which is not a finite non-negative number.`);
    }
    byBucket.set(bucket, weight);
    percentOf.push(kv[3] === "%");
  }
  // ONE NOTATION PER LINE. A mixture means the line does not state a single
  // vector at all, and stripping the `%` would silently turn it into a
  // different, plausible-looking one (see the header).
  if (percentOf.some(Boolean) && percentOf.some((p) => !p)) {
    throw new Error(
      `model take's ${TAKE_WEIGHTS_LEAD_IN} line MIXES percentages and fractions — ` +
        `${percentOf.filter(Boolean).length} of ${percentOf.length} entries carry '%'. ` +
        `The two notations mean different things for the same digits, so the line is re-sampled rather than read as one or the other; ` +
        `write all four entries in the same notation.`,
    );
  }
  const missing = TAKE_WEIGHT_BUCKETS.filter((bucket) => !byBucket.has(bucket));
  const extra = [...byBucket.keys()].filter((bucket) => !TAKE_WEIGHT_BUCKETS.includes(bucket));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `model take's ${TAKE_WEIGHTS_LEAD_IN} line is not the four canonical buckets ` +
        `{${TAKE_WEIGHT_BUCKETS.join(", ")}}` +
        `${missing.length ? ` — missing ${missing.join(", ")}` : ""}` +
        `${extra.length ? ` — unsupported ${extra.join(", ")}` : ""}. ` +
        `Schema 1.0's receipt can carry only those four, so a partial vector is re-sampled rather than padded with zeros.`,
    );
  }
  const total = TAKE_WEIGHT_BUCKETS.reduce((sum, bucket) => sum + byBucket.get(bucket)!, 0);
  if (!(total > 0) || !Number.isFinite(total)) {
    throw new Error(
      `model take's ${TAKE_WEIGHTS_LEAD_IN} line allocates nothing (the four shares total ${total}) — ` +
        `a vector that cannot be normalized is not an allocation, and the take is re-sampled.`,
    );
  }
  return {
    // EMITTED IN CANONICAL ORDER whatever order the model wrote them in, so two
    // members who agree on the allocation sign byte-identical vectors.
    weights: TAKE_WEIGHT_BUCKETS.map((bucket) => ({ bucket, weight: byBucket.get(bucket)! })),
    body: lines.slice(0, -1).join("\n").trim(),
  };
}

// Prompt-facing stance vocabulary (most bullish first), DERIVED from the
// canonical contract tuple (finding 027) — never re-declared locally.
export const STANCE_VALUES: readonly Stance[] = [...STANCES].reverse();
export type { Stance };

export interface Persona {
  memberId: string;
  name: string;
  lens: string;
  // Directional disposition in [-1, 1]; wired from the smoke roster's `bias`.
  bias: number;
}

export interface ParsedTake {
  stance: string;
  confidence: number;
  // Body with the trailing STANCE/CONFIDENCE/WEIGHTS control line removed.
  body: string;
  // The member's OWN proposed allocation. Carried on the submission so the
  // published vector is meanTakeWeights() over REAL member proposals (D42) —
  // without it a `bucket_weights` subject publishes a vector-less
  // recommendation and every verify gate over the pipeline fails. Raw as the
  // model stated it: the SERVER normalizes and averages; nothing here authors,
  // rescales or settles a weight.
  //
  // OPTIONAL, and the 2026-09-23 main merge is why. This branch declared it
  // REQUIRED with an inline type because its parser demanded a trailing
  // `| WEIGHTS:` clause on every control line; main declared it optional
  // because its parser emits a separate WEIGHTS line only for a
  // `requireWeights` session. BOTH declarations merged in with no conflict
  // marker, which tsc caught only from the backend project (its tsconfig
  // reaches into scripts/; the root one had already passed).
  //
  // Optional is the correct merged shape: the merged parser omits the key
  // entirely when no clause is present, so an unweighted session's take says
  // nothing about allocation rather than claiming a zeroed one. The
  // no-fabrication guarantee is enforced downstream instead —
  // member-session-client.ts signs a vector only when `weights?.length` is
  // truthy. Pinned by scripts/tests/unit/swarm-inference-opencode-argv.test.ts
  // ("omits weights entirely when the WEIGHTS clause is absent").
  weights?: TakeWeight[];
}

/** One bucket's share as an analyst stated it. */
export interface TakeWeight {
  bucket: string;
  weight: number;
}

// The allocation contract the member prompt demands: every take proposes a
// weight for each of the four canonical vault buckets (the SAME order the
// consensus receipt emits them in — contract's RECEIPT_CANONICAL_BUCKET_ORDER).
// `parseStanceFromBody` requires exactly this set, so a take that omits or
// renames a bucket is an ABSENT member, never a silently-partial proposal
// (the vector a member DID propose must be recomputable by anyone holding the
// take set, which a member whose weights a reader cannot rebuild would break).
export const TAKE_WEIGHTS_BUCKETS: readonly string[] = RECEIPT_CANONICAL_BUCKET_ORDER;

// Parse the WEIGHTS clause of a take's trailing control line into entries.
// The clause is `WEIGHTS: <bucket>=<fraction>, <bucket>=<fraction>, ...` and
// MUST name every bucket in TAKE_WEIGHTS_BUCKETS exactly once, each with a
// finite fraction in [0, 1], with the set summing to at least some positive
// total (normalization happens in the backend derivation, not here). Throws on
// any deviation — the member is ABSENT, never defaulted (same doctrine as
// stance/confidence, #301/#319).
export function parseWeightsClause(text: string): { bucket: string; weight: number }[] {
  const m = text.match(/WEIGHTS:\s*([^|]+)$/i);
  if (!m) {
    throw new Error(
      `model take is missing its trailing "WEIGHTS: <bucket>=<fraction>, ..." clause — ` +
        `the member is rendered ABSENT, never defaulted to a fabricated allocation.`,
    );
  }
  const pairs = m[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const entries: { bucket: string; weight: number }[] = [];
  const seen = new Set<string>();
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(
        `model take's WEIGHTS clause carries an unparseable pair ${JSON.stringify(pair)} — ` +
          `expected "<bucket>=<fraction>"; the member is rendered ABSENT, never defaulted.`,
      );
    }
    const bucket = pair.slice(0, eq).trim().toLowerCase();
    const weight = Number(pair.slice(eq + 1).trim());
    if (!bucket || seen.has(bucket)) {
      throw new Error(
        `model take's WEIGHTS clause names bucket ${JSON.stringify(bucket)} twice or empty — ` +
          `the member is rendered ABSENT, never defaulted.`,
      );
    }
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
      throw new Error(
        `model take's WEIGHTS clause carries weight ${JSON.stringify(pair.slice(eq + 1).trim())} for ` +
          `${JSON.stringify(bucket)} — expected a fraction in [0, 1]; the member is rendered ABSENT, never defaulted.`,
      );
    }
    seen.add(bucket);
    entries.push({ bucket, weight });
  }
  const missing = TAKE_WEIGHTS_BUCKETS.filter((b) => !seen.has(b));
  if (missing.length) {
    throw new Error(
      `model take's WEIGHTS clause omits the canonical bucket(s) ${missing.join(", ")} — ` +
        `expected exactly {${TAKE_WEIGHTS_BUCKETS.join(", ")}}; the member is rendered ABSENT, never defaulted.`,
    );
  }
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  if (!(total > 0)) {
    throw new Error(
      `model take's WEIGHTS clause sums to zero — the member is rendered ABSENT, never defaulted.`,
    );
  }
  return entries;
}

// Parse a trailing "STANCE: <...> | CONFIDENCE: <0-1> | WEIGHTS: <bucket>=<f>, ..." line
// from a model take into { stance, confidence, weights } and return the stored body
// with that control line stripped. A missing or malformed control line THROWS —
// it renders the member ABSENT, loudly (session.ts settles per-member failures
// into a no-show), and NEVER degrades to a fabricated neutral/0.5 stance or a
// fabricated allocation. The silent default this function used to carry was a
// template remnant from the retired hermetic mode (#301/#319): a fabricated
// stance is a fabricated signed vote, which is worse than an honest absence.
// The happy-path parse still mirrors the reference parser
// (generate-session.js parseStanceFromBody) so submitted and API takes render
// identically.
export function parseStanceFromBody(body: string): ParsedTake {
  const trimmed = body.trim();
  const lines = trimmed.split("\n");
  const last = lines[lines.length - 1] ?? "";
  const m = last.match(/STANCE:\s*(\w+)\s*\|\s*CONFIDENCE:\s*([\d.]+)/i);
  if (!m) {
    throw new Error(
      `model take is missing its trailing "STANCE: <${STANCE_VALUES.join("|")}> | CONFIDENCE: <0-1> | WEIGHTS: <bucket>=<fraction>, ..." control line — ` +
        `the member is rendered ABSENT, never defaulted to a fabricated neutral/0.5 stance. ` +
        `Last line of the take was: ${JSON.stringify(last.slice(0, 160))}`,
    );
  }
  const stance = m[1].toLowerCase();
  if (!(STANCES as readonly string[]).includes(stance)) {
    throw new Error(
      `model take's control line names stance '${stance}', which is outside {${[...STANCES].join(",")}} — ` +
        `the member is rendered ABSENT, never coerced onto the stance vocabulary.`,
    );
  }
  const confidence = parseFloat(m[2]);
  if (!Number.isFinite(confidence)) {
    throw new Error(
      `model take's control line carries unparseable confidence ${JSON.stringify(m[2])} — ` +
        `the member is rendered ABSENT, never defaulted.`,
    );
  }
  // THE ALLOCATION IS OPTIONAL HERE, AND STRICT WHEN PRESENT. Two shapes reach
  // this parser and both are honoured: the single control line that carries a
  // trailing `| WEIGHTS: …` clause, and the `bucket_weights` shape promptFor()
  // now asks for, where the WEIGHTS line sits on its OWN line directly above the
  // STANCE line and authorTake() reads it with parseWeightsFromBody() after this
  // function has stripped the control line. A take with no allocation at all is
  // a `position_actions` take, which was never asked for a vector — refusing it
  // here would render every such member ABSENT. A MALFORMED clause is still a
  // loud absence: nothing is defaulted or repaired.
  const weights = /WEIGHTS:/i.test(last) ? parseWeightsClause(last) : undefined;
  return {
    stance,
    confidence: Math.max(0, Math.min(1, confidence)),
    ...(weights ? { weights } : {}),
    body: lines.slice(0, -1).join("\n").trim(),
  };
}

function dispositionLabel(bias: number): string {
  if (bias >= 0.1) return "leans constructive; you look for reasons the position works before you fault it";
  if (bias <= -0.1) return "leans cautious; you price the bear case first and demand the position earn its risk";
  return "runs balanced; you weight the panel spread over the composite label and resist tilting off the mandate";
}

function pct(fraction: number | null | undefined, fallback: number): string {
  const f = typeof fraction === "number" ? fraction : fallback;
  return `${Math.round(Math.max(0, Math.min(1, f)) * 100)}th`;
}

// Build the full single-message prompt for opencode `run`. opencode `run` takes
// one positional prompt (no separate system message), so the persona framing,
// session brief, and formatting task are woven into one string.
export function promptFor(
  p: Persona,
  regime: RegimeContext,
  subjectId: string,
  options: { requireWeights?: boolean; targets?: readonly SleeveTarget[] } = {},
): string {
  const comp = regime.composite;
  const inForce = options.targets?.length ? targetsLine(options.targets) : "";
  // The allocation ask, and the ONLY place the WEIGHTS line's shape is written
  // for the model. A `position_actions` subject is asked for nothing numeric —
  // it was never asked for a bucket vector, and inventing one would put an
  // unrequested allocation inside that session's signed bytes.
  const weightLines = options.requireWeights
    ? [
        `${TAKE_WEIGHTS_LEAD_IN} ${TAKE_WEIGHT_BUCKETS.map((b) => `${b}=<0-1>`).join(" | ")}`,
        `STANCE: <${STANCE_VALUES.join("|")}> | CONFIDENCE: <0-1>`,
      ]
    : [`STANCE: <${STANCE_VALUES.join("|")}> | CONFIDENCE: <0-1>`];
  const weightsBrief = options.requireWeights
    ? [
        ``,
        `# Your allocation`,
        `This session asks for a NUMBER as well as a view. State your own target split across ALL FOUR Robot Money vault buckets — ${TAKE_WEIGHT_BUCKETS.join(", ")} — as your ${TAKE_WEIGHTS_LEAD_IN} line below. Every bucket must appear exactly once, shares are non-negative, and they must not all be zero; write the split you would actually run, not the targets in force restated. Do not put these numbers anywhere else in the take.`,
      ]
    : [];
  // Production's ALLOCATION and SUBJECT sections, asked of every take. The sleeve
  // targets come from the session's own brief when it carries them (main's 1025),
  // where production wrote 95/5/0/0 into the prompt whatever the brief said.
  const allocationSection = [
    `**ALLOCATION**`,
    `- What tilt the regime implies for the sleeve targets${inForce ? " in force" : ""}, and why`,
    `- Which sleeve or constituent moves first and the mechanism`,
    `- The one flip trigger that would change the read`,
  ];
  const subjectSection = [
    `**SUBJECT**`,
    `- Where ${subjectId} is over- or under-exposed vs the regime-appropriate allocation`,
    `- The specific concentration or mechanism risk you underwrite`,
    `- The first move you would make, with a trigger`,
  ];
  return [
    `You are ${p.name}, an autonomous voice on the Robot Money Investment Swarm.`,
    `You read every session through a ${p.lens} lens — that lens, not the headline composite, sets your conviction.`,
    `Your disposition ${dispositionLabel(p.bias)}.`,
    `Write in your own distinct voice, one claim per bullet, no hedging boilerplate; cite specific numbers, panels, and mechanisms, never vibes.`,
    ``,
    `# Session brief`,
    `Subject under review: ${subjectId}`,
    `Composite ${comp.toFixed(3)} (${pct(regime.compositePercentile, comp)} percentile of trailing 3y) -> bucket ${regime.regime ?? "unlabeled"}.`,
    `  Macro panel:    ${pct(regime.macroPercentile, comp + 0.08)} percentile, bucket ${regime.macroRegime ?? "n/a"}`,
    `  On-chain panel: ${pct(regime.onchainPercentile, comp - 0.2)} percentile, bucket ${regime.onchainRegime ?? "n/a"}`,
    `  Equity factor:  ${pct(regime.factorPercentile, comp + 0.15)} percentile, bucket ${regime.factorRegime ?? "n/a"}`,
    ...(inForce ? [`Sleeve targets in force: ${inForce}.`] : []),
    ``,
    `# Your task`,
    `Write a structured take in exactly three bulleted sections, ~180-220 words total. Each section is a bold header line followed by 3 bullets, one claim per bullet. Reply with ONLY the take (no preamble, no tool calls). Format exactly:`,
    ``,
    `**REGIME**`,
    `- One concrete number from the brief and what it means through your lens`,
    `- The macro vs on-chain (or factor) divergence, if the panels disagree`,
    `- The trailing direction you read`,
    ``,
    ...allocationSection,
    ``,
    ...subjectSection,
    ``,
    ...weightsBrief,
    ``,
    `Stay in your voice. Conclude with ${weightLines.length === 1 ? "one line" : `these ${weightLines.length} lines, in this order`} exactly, and nothing after ${weightLines.length === 1 ? "it" : "them"}:`,
    ...weightLines,
  ].join("\n");
}

/**
 * The four in-house analysts' lens and numeric disposition, as production runs
 * them (scripts/lib/smoke-mode.ts DEMO_MEMBERS carries the same numbers; a unit
 * test pins the two together). The member record on the API carries the lens but
 * no numeric bias, and the participant holds no database credential, so a
 * member this table does not name runs balanced (bias 0) as production ran it.
 */
export const IN_HOUSE_PERSONAS: Readonly<Record<string, { lens: string; bias: number }>> = Object.freeze({
  athena: { lens: "macro risk", bias: -0.1 },
  boreas: { lens: "on-chain flows", bias: 0 },
  cygnus: { lens: "momentum", bias: 0.15 },
  draco: { lens: "contrarian", bias: 0 },
});
