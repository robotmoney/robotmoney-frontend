// Swarm-member take authorship via a REAL language-model call. This module
// shells out to
//
//   opencode run --model <resolved> --format json --auto \
//     --title <deterministic> --print-logs --log-level DEBUG \
//     "<persona + regime/subject brief>"
//
// parses the NDJSON transcript for the final assistant message text, and returns
// REGIME / ALLOCATION / SUBJECT prose ending in a parseable
// "STANCE: <...> | CONFIDENCE: <0-1>" control line (stripped from the stored body
// by `parseStanceFromBody`). Mirrors the reference authoring path in
// robotmoney-site scripts/swarm/generate-session.js.
//
// MODEL + CREDENTIAL: the model comes from AGENT_MODEL resolved against
// ../model-registry.ts (default `opencode/deepseek-v4-flash`); the credential is
// OPENCODE_API_KEY. The member-agent launcher injects both explicitly into the
// member container, and this module passes only its documented allowlist to
// the spawned CLI. No compose-service or host ambient credential fallback
// exists. See ../opencode-key.ts.
//
// MODEL CHOICE IS NOT NEUTRAL HERE. This prompt asks the model to hold an
// investment-swarm persona, and Zen's Claude family carries an OpenCode
// coding-assistant framing that fights it: `claude/haiku-4-5` refused the task
// outright ("I'm OpenCode, a coding assistant… not an investment analysis
// tool") and `claude/sonnet-5` went off-format. deepseek, kimi, and gpt all
// authored well-formed takes. Prefer those; see MODEL_FAMILIES notes.
//
// LOUD-SKIP CONTRACT: swarm authorship depends on the opencode CLI + a
// reachable model (external resources). When either is unavailable, this module
// THROWS — it NEVER falls back to a templated body.
import { RECEIPT_CANONICAL_BUCKET_ORDER, STANCES } from "@robotmoney/contract";
import type { Stance } from "@robotmoney/contract";
import {
  assistantTextParts, cliStreamErrorFromStderr, describeTranscriptError, extractAssistantText, transcriptErrors,
  transcriptSpend,
  type TranscriptError, type TranscriptSpend,
} from "../../agent/transcript.ts";
import {
  classifyInferenceFailure,
  InferenceFailure,
  inferenceFailureAction,
  renderInferenceDiagnostic,
} from "../../agent/inference-failure.ts";
import {
  buildOpenCodeRunArgs,
  buildOpenCodeSpawnEnv,
  resolveOpenCodeRun,
  type ResolvedOpenCodeRun,
} from "../../agent/opencode-run.ts";
import { DEFAULT_AGENT_MODEL } from "../model-registry.ts";
import { ZEN_KEY_ENV, zenApiKey } from "../opencode-key.ts";
import { redactTelemetryText } from "../onboarding-telemetry.ts";
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

export const DEFAULT_INFERENCE_MODEL = DEFAULT_AGENT_MODEL;

/** Scenario-neutral OpenCode runtime used by every swarm take. */
export function resolveInferenceOpenCodeRun(
  env: Record<string, string | undefined> = process.env,
): ResolvedOpenCodeRun {
  return resolveOpenCodeRun({ env, titleScope: "robotmoney-swarm" });
}

export type InferenceTelemetryMilestone =
  | "cli_spawn_requested"
  | "cli_spawned"
  | "inference_requested"
  | "first_stdout_byte"
  | "first_stderr_byte"
  | "first_ndjson_event"
  | "primary_stream_observed"
  | "first_assistant_text_part"
  | "auxiliary_title_error"
  | "primary_provider_error"
  | "timeout_reached"
  | "kill_signal"
  | "process_exit"
  | "stream_drain_timeout"
  | "completion";

export interface InferenceTelemetryEvent {
  version: 1;
  milestone: InferenceTelemetryMilestone;
  timestamp: string;
  provider: string;
  model: string;
  timeoutMs: number;
  primaryStreamObserved: boolean;
  detail?: string;
}

export type InferenceTelemetrySink = (event: InferenceTelemetryEvent) => void;

export interface AuthorTakeOptions {
  telemetry?: InferenceTelemetrySink;
  diagnosticArtifactPath?: string;
  // How many times to sample the model for a take that satisfies the section
  // contract below. See authorTake().
  structureAttempts?: number;
  // TRUE for a `bucket_weights` subject: the prompt then demands a four-bucket
  // WEIGHTS control line and `authorTake` refuses a take without one. The
  // caller reads this off the session's own brief (`body.subject
  // .recommendationType`) — never off an environment variable the harness
  // supplies, which would let the harness decide what a member was asked.
  requireWeights?: boolean;
}

// The three bold section headers `promptFor` demands, and the ONLY definition
// of them. session.ts's post-session `assertAuthoredTakes` reads this same
// tuple, so the prompt, the author-time check, and the harness assertion can
// never drift into disagreeing about what a well-formed take looks like.
export const TAKE_SECTION_LEAD_INS: readonly string[] = Object.freeze([
  "**REGIME**",
  "**ALLOCATION**",
  "**SUBJECT**",
]);

// Which required section headers a take body is missing ([] when well-formed).
// Pure and exported so the unit suite can pin it without a spawn.
export function missingSectionLeadIns(body: string): readonly string[] {
  return TAKE_SECTION_LEAD_INS.filter((lead) => !body.includes(lead));
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

// A model that drops a section is not a broken model, it is an unlucky sample:
// on 2026-08-06 the smoke run's athena returned a take with REGIME and
// ALLOCATION but no SUBJECT, was signed and accepted by the API, and only blew
// up at the end-of-session assertion — after the session had already published.
// Re-sampling is the honest fix (the assertion stays exactly as strict), and
// two attempts is enough for an omission this rare while keeping a stuck model
// from burning the session's window.
const DEFAULT_STRUCTURE_ATTEMPTS = 2;

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
  // Body with the trailing STANCE/CONFIDENCE control line removed.
  body: string;
  // The analyst's own four-bucket allocation, present only for a
  // `bucket_weights` subject (see TAKE_WEIGHTS_LEAD_IN). Raw as the model
  // stated it — the SERVER normalizes and averages; nothing here authors,
  // rescales or settles a weight.
  weights?: TakeWeight[];
}

/** One bucket's share as an analyst stated it. */
export interface TakeWeight {
  bucket: string;
  weight: number;
}

// Parse a trailing "STANCE: <...> | CONFIDENCE: <0-1>" line from a model take
// into { stance, confidence } and return the stored body with that control line
// stripped. A missing or malformed control line THROWS — it renders the member
// ABSENT, loudly (session.ts settles per-member failures into a no-show), and
// NEVER degrades to a fabricated neutral/0.5 stance. The silent default this
// function used to carry was a template remnant from the retired hermetic mode
// (#301/#319): a fabricated stance is a fabricated signed vote, which is worse
// than an honest absence. The happy-path parse still mirrors the reference
// parser (generate-session.js parseStanceFromBody) so submitted and API takes
// render identically.
export function parseStanceFromBody(body: string): ParsedTake {
  const trimmed = body.trim();
  const lines = trimmed.split("\n");
  const last = lines[lines.length - 1] ?? "";
  const m = last.match(/STANCE:\s*(\w+)\s*\|\s*CONFIDENCE:\s*([\d.]+)/i);
  if (!m) {
    throw new Error(
      `model take is missing its trailing "STANCE: <${STANCE_VALUES.join("|")}> | CONFIDENCE: <0-1>" control line — ` +
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
  return {
    stance,
    confidence: Math.max(0, Math.min(1, confidence)),
    body: lines.slice(0, -1).join("\n").trim(),
  };
}

// The `opencode run --format json` NDJSON parser now lives in
// scripts/agent/transcript.ts — one definition, shared with the member-agent
// outcome classifier (scripts/agent/classify-outcome.ts), which reads the same
// stream for the agent's FINAL message. Behaviour here is unchanged (the
// join-and-trim of every finalized assistant text part, "" for an empty/failed
// run so the caller can throw loudly), and it is pinned by
// scripts/tests/unit/member-agent-classify.test.ts. Re-exported so this file's
// own call site below and every external importer are untouched.
export { describeTranscriptError, extractAssistantText, transcriptErrors };
// The failure vocabulary the swarm boundary throws with (issue #527), re-exported
// so a consumer of this module never has to reach past it for the kind.
export {
  classifyInferenceFailure,
  InferenceFailure,
  type InferenceFailureKind,
  inferenceFailureAction,
} from "../../agent/inference-failure.ts";

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
  options: { requireWeights?: boolean } = {},
): string {
  const comp = regime.composite;
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
        `This session asks for a NUMBER as well as a view. State your own target split across ALL FOUR Robot Money vault buckets — ${TAKE_WEIGHT_BUCKETS.join(", ")} — as your ${TAKE_WEIGHTS_LEAD_IN} line below. Every bucket must appear exactly once, shares are non-negative, and they must not all be zero; write the split you would actually run, not the 95/5/0/0 target restated. Do not put these numbers anywhere else in the take.`,
      ]
    : [];
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
    `Vault allocation targets are 95/5/0/0 across Conservative DeFi Yield / Agent Tokens / Protocol Tokens / Real-World Assets; the Agent Tokens sleeve routes through rmUSDC vault receipts.`,
    ``,
    `# Your task`,
    `Write a structured take in exactly three bulleted sections, ~180-220 words total. Each section is a bold header line followed by 3 bullets, one claim per bullet. Reply with ONLY the take (no preamble, no tool calls). Format exactly:`,
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
    ...weightsBrief,
    ``,
    `Stay in your voice. Conclude with ${weightLines.length === 1 ? "one line" : `these ${weightLines.length} lines, in this order`} exactly, and nothing after ${weightLines.length === 1 ? "it" : "them"}:`,
    ...weightLines,
  ].join("\n");
}

// The EXACT environment a spawned `opencode` subprocess receives — an
// allowlist, never an inherit. The member client itself holds its scoped bearer
// token and may hold an owner-supplied keystore passphrase; neither belongs in
// the model subprocess. The external-actor rail's doctrine is one explicitly
// injected model credential and nothing else.
//
//   - PATH/HOME/TERM: what any CLI needs to run at all (binary resolution,
//     its default XDG dirs, terminal handling);
//   - OPENCODE_API_KEY (ZEN_KEY_ENV): the single model credential — the ONLY
//     secret that may reach the model subprocess.
//
// Pure and exported so the unit suite can pin the allowlist hermetically.
export { buildOpenCodeSpawnEnv as opencodeSpawnEnv } from "../../agent/opencode-run.ts";

// What we actually know about the model credential. This used to print
// "funded" whenever OPENCODE_API_KEY was merely SET — a claim the key cannot
// support and that was flatly false on 2026-08-05, when every swarm member died
// against a Zen workspace whose balance had run out while our own error text
// asserted the account was funded. A present key means a present key.
const keyLabel = () => (zenApiKey() ? `${ZEN_KEY_ENV} set` : `no ${ZEN_KEY_ENV} set`);

// HONEST cause attribution (issue #361 Phase 0, extended by issue #527). PURE
// and exported so the unit suite can pin every branch hermetically, with no
// spawn.
//
// The precedence below is strictly most-specific-first, and each rung is
// EVIDENCE rather than inference:
//
//  1. A structured `type:"error"` event in the JSON stream — the provider (or
//     the CLI) NAMED the failure, with a typed discriminator, an HTTP status
//     and its own retryability verdict. Never guess when this is present. This
//     rung is new: the previous version read only stderr, so the six e2e
//     failures of 2026-08-05 were all reported as a maybe-outage ("unreachable,
//     rate-limited, unfunded, or returned nothing") while stdout carried
//     `CreditsError: Insufficient balance … HTTP 401, NOT retryable` on every
//     one of them. Three autofix reruns were spent on a fault no retry could
//     clear, and nobody topped the workspace up because nothing said to.
//  2. Non-empty stderr — during the 2026-07-30 incident the captured stderr
//     showed the opencode CLI dying LOCALLY on its own SQLite migration before
//     any model call, so this outranks any provider-side speculation.
//  3. Neither — the only case in which the cause is genuinely unknown, and the
//     only one allowed to say so.
//
// The message text is rendered from the classified KIND, so the diagnosis and
// the machine-readable `InferenceFailure.kind` can never drift apart.
export function emptyTranscriptCause(stdout: string, stderr: string): string {
  const errors = transcriptErrors(stdout, [zenApiKey() ?? ""]);
  return renderInferenceDiagnostic(classifyInferenceFailure(errors, stderr), errors, stderr);
}

// The loud throw for a run that produced no assistant text, carrying the kind,
// the provider and the resolved model id alongside the rendered diagnosis.
function emptyTranscriptFailure(
  stdout: string,
  stderr: string,
  model: string,
  provider: string,
  exitCode: number,
): InferenceFailure {
  const errors = transcriptErrors(stdout, [zenApiKey() ?? ""]);
  const classification = classifyInferenceFailure(errors, stderr);
  return new InferenceFailure(
    `opencode inference produced an empty transcript (exit ${exitCode}) for model '${model}' ` +
      `(${keyLabel()}): no assistant text in the --format json stream; NO template fallback. ` +
      renderInferenceDiagnostic(classification, errors, stderr),
    {
      kind: classification.kind,
      provider,
      model,
      providerType: classification.error?.providerType ?? "",
      statusCode: classification.error?.statusCode ?? null,
      retryable: classification.retryable,
    },
  );
}

// Run the opencode CLI on a prompt and return the concatenated final assistant
// text plus the model resolved for that same run. Throws loudly (no template
// fallback) when the binary cannot be spawned or the run yields no text.
const DIAGNOSTIC_TAIL_BYTES = 12_000;
const TERMINATE_GRACE_MS = 500;
const KILL_GRACE_MS = 1_000;
const PIPE_DRAIN_GRACE_MS = 500;

function inferenceRedactions(prompt: string) {
  return [
    { value: zenApiKey(), placeholder: "<OPENCODE_API_KEY redacted>" },
    { value: prompt, placeholder: "<prompt redacted>" },
    { value: JSON.stringify(prompt).slice(1, -1), placeholder: "<escaped prompt redacted>" },
  ];
}

function boundedTail(value: string, prompt: string): string {
  const redacted = redactTelemetryText(value, inferenceRedactions(prompt));
  return redacted.slice(-DIAGNOSTIC_TAIL_BYTES);
}

async function runOpencode(
  prompt: string,
  options: AuthorTakeOptions = {},
): Promise<{ text: string; model: string; spend: TranscriptSpend | null }> {
  const run = resolveInferenceOpenCodeRun();
  const { executable: bin, model, timeoutMs: ms, provider } = run;
  let primaryStreamObserved = false;
  const emit = (milestone: InferenceTelemetryMilestone, detail?: string) => options.telemetry?.({
    version: 1,
    milestone,
    timestamp: new Date().toISOString(),
    provider,
    model,
    timeoutMs: ms,
    primaryStreamObserved,
    ...(detail ? { detail: redactTelemetryText(detail, inferenceRedactions(prompt)) } : {}),
  });
  // The prompt enters only the final execution argv; it is absent from the
  // resolved runtime metadata used by telemetry/artifacts.
  const argv = [bin, ...buildOpenCodeRunArgs(run, prompt)];
  let proc: ReturnType<typeof Bun.spawn>;
  emit("inference_requested", `provider=${provider} model=${model} timeoutMs=${ms}`);
  emit("cli_spawn_requested", `binary=${bin}`);
  try {
    proc = Bun.spawn(
      argv,
      // SCRUBBED environment (issue #361 Phase 0): the subprocess gets the
      // opencodeSpawnEnv allowlist (PATH/HOME/TERM + the single model
      // credential) — never a `process.env` spread, which handed every
      // member-model subprocess the stack's whole admin credential set
      // (ADMIN_TOKEN, ANALYTICS_TOKEN, …). OpenCode state stays in this
      // member container's isolated, persistent HOME.
      { stdout: "pipe", stderr: "pipe", env: buildOpenCodeSpawnEnv(process.env) },
    );
  } catch (err) {
    throw new Error(
      `opencode inference unavailable: failed to spawn '${bin}' (${err instanceof Error ? err.message : String(err)}). ` +
        `Swarm takes require a working opencode CLI; there is NO template fallback in this path.`,
    );
  }
  emit("cli_spawned", `pid=${proc.pid}`);

  let stdout = "";
  let stderr = "";
  let firstStdout = false;
  let firstStderr = false;
  let firstNdjson = false;
  let firstText = false;
  let auxiliaryTitleError = false;
  let primaryProviderError = false;
  // The CLI's own STDERR verdict on the primary stream. Set once; when it is
  // set the call is OVER — see cliStreamErrorFromStderr() for why waiting out
  // the remaining time bound buys nothing but a wrong diagnosis.
  let fatalStreamError: TranscriptError | null = null;
  let announceFatalStreamError: (() => void) | undefined;
  let stdoutReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stderrReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const requestedModelId = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  const referencedModel = (line: string): string | null => {
    const found = line.match(/model(?:ID)?[=: ]+(?:opencode\/)?([a-zA-Z0-9._-]+)/i)?.[1];
    return found?.toLowerCase() ?? null;
  };
  const isAuxiliaryTitleLine = (line: string): boolean => {
    const namedTitle = /agent[=: ]+title/i.test(line);
    const referenced = referencedModel(line);
    return namedTitle && referenced !== requestedModelId.toLowerCase();
  };
  const primaryProviderEvidence = (line: string): boolean => {
    const lower = line.toLowerCase();
    return lower.includes(model.toLowerCase()) || lower.includes(requestedModelId.toLowerCase()) ||
      (provider === "opencode" && /opencode\.ai\/zen\//i.test(line));
  };
  const inspectLine = (stream: "stdout" | "stderr", line: string) => {
    if (isAuxiliaryTitleLine(line)) {
      if (!auxiliaryTitleError && /error|disabled|fail/i.test(line)) {
        auxiliaryTitleError = true;
        emit("auxiliary_title_error", "OpenCode auxiliary title agent reported an error; this is not the primary model stream");
      }
      return;
    }
    if (stream === "stderr") {
      // THE ONE LINE THE STDOUT SCAN CAN NEVER SEE. A fatal provider stream
      // error here ends the call — the CLI will not answer, and the wait that
      // used to follow reported `cause=timed-out` for a provider that had
      // already refused in its own words.
      if (!fatalStreamError) {
        const parsed = cliStreamErrorFromStderr(line, [zenApiKey() ?? ""]);
        if (parsed && primaryProviderEvidence(line)) {
          fatalStreamError = parsed;
          // The primary stream WAS observed — it carried a refusal rather than
          // text, which is exactly the distinction this milestone exists for.
          if (!primaryStreamObserved) {
            primaryStreamObserved = true;
            emit("primary_stream_observed", "type=cli-stderr-stream-error");
          }
          if (!primaryProviderError) {
            primaryProviderError = true;
            emit("primary_provider_error", describeTranscriptError(parsed));
          }
          announceFatalStreamError?.();
        }
      }
      return;
    }
    let event: any;
    try { event = JSON.parse(line.trim()); } catch { return; }
    if (!firstNdjson) {
      firstNdjson = true;
      emit("first_ndjson_event", `type=${String(event?.type ?? "unknown")}`);
    }
    const assistantText = event?.type === "text" && typeof event?.part?.text === "string" && event.part.text.trim();
    const primaryError = event?.type === "error" && primaryProviderEvidence(line);
    if (!primaryStreamObserved && (assistantText || primaryError)) {
      primaryStreamObserved = true;
      emit("primary_stream_observed", `type=${String(event?.type ?? "unknown")}`);
    }
    if (!firstText && assistantText) {
      firstText = true;
      emit("first_assistant_text_part");
    }
    if (!primaryProviderError && primaryError) {
      primaryProviderError = true;
      const errors = transcriptErrors(line, [zenApiKey() ?? ""]);
      emit("primary_provider_error", errors[0] ? describeTranscriptError(errors[0]) : "structured primary error event");
    }
  };

  const drainIncrementally = async (stream: ReadableStream<Uint8Array>, which: "stdout" | "stderr") => {
    const reader = stream.getReader();
    if (which === "stdout") stdoutReader = reader; else stderrReader = reader;
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (which === "stdout") {
        if (!firstStdout) { firstStdout = true; emit("first_stdout_byte"); }
        stdout += chunk;
      } else {
        if (!firstStderr) { firstStderr = true; emit("first_stderr_byte"); }
        stderr += chunk;
      }
      pending += chunk;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        inspectLine(which, pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    }
    const rest = decoder.decode();
    if (rest) {
      if (which === "stdout") stdout += rest; else stderr += rest;
      pending += rest;
    }
    if (pending) inspectLine(which, pending);
  };
  const stdoutDrain = drainIncrementally(proc.stdout as ReadableStream<Uint8Array>, "stdout");
  const stderrDrain = drainIncrementally(proc.stderr as ReadableStream<Uint8Array>, "stderr");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), ms); });
  // The third way out, beside "it exited" and "the clock ran out": the provider
  // told us, on stderr, that it is not going to answer.
  const refusal = new Promise<"provider-error">((resolve) => {
    announceFatalStreamError = () => resolve("provider-error");
    if (fatalStreamError) resolve("provider-error");
  });
  const outcome = await Promise.race([proc.exited.then(() => "exited" as const), deadline, refusal]);
  if (timer !== undefined) clearTimeout(timer);
  let exitCode: number | null = null;
  if (outcome !== "exited") {
    if (outcome === "timeout") emit("timeout_reached");
    try {
      proc.kill(15);
      emit("kill_signal", "SIGTERM sent to OpenCode process");
    } catch {
      emit("kill_signal", "OpenCode process had already exited");
    }
    const afterTerm = await Promise.race([
      proc.exited.then((code) => ({ exited: true as const, code })),
      Bun.sleep(TERMINATE_GRACE_MS).then(() => ({ exited: false as const, code: null })),
    ]);
    if (afterTerm.exited) {
      exitCode = afterTerm.code;
    } else {
      try {
        proc.kill(9);
        emit("kill_signal", "SIGKILL sent after OpenCode ignored SIGTERM grace period");
      } catch {
        emit("kill_signal", "OpenCode process exited before SIGKILL escalation");
      }
      const afterKill = await Promise.race([
        proc.exited.then((code) => ({ exited: true as const, code })),
        Bun.sleep(KILL_GRACE_MS).then(() => ({ exited: false as const, code: null })),
      ]);
      if (afterKill.exited) exitCode = afterKill.code;
    }
  } else {
    exitCode = await proc.exited;
  }
  emit("process_exit", exitCode === null ? "exit state unknown after bounded SIGKILL grace" : `exitCode=${exitCode}`);
  const drains = Promise.all([stdoutDrain, stderrDrain]);
  // OpenCode can exit while a descendant retains its inherited pipes. This is
  // independent of the model timeout outcome: bound every drain, retain bytes
  // collected so far, and cancel readers after the grace period.
  const drained = await Promise.race([drains.then(() => true), Bun.sleep(PIPE_DRAIN_GRACE_MS).then(() => false)]);
  if (!drained) {
    emit("stream_drain_timeout", `stdout/stderr remained open after parent outcome=${outcome}; cancelling readers`);
    await Promise.allSettled([stdoutReader?.cancel(), stderrReader?.cancel()]);
  }
  await Promise.race([drains.catch(() => []), Bun.sleep(PIPE_DRAIN_GRACE_MS)]);
  if (outcome === "provider-error") {
    // FAIL FAST, AND SAY WHAT IT WAS. Classified through the same rules a
    // structured stdout error event goes through, so the machine-readable kind
    // and the prose can never drift apart — and so a status code the CLI
    // printed still decides the kind, while prose never does.
    const errors = fatalStreamError ? [fatalStreamError] : [];
    const classification = classifyInferenceFailure(errors, stderr);
    const artifact = options.diagnosticArtifactPath ? ` artifact=${options.diagnosticArtifactPath}.` : "";
    throw new InferenceFailure(
      `opencode inference stopped early for model '${model}' (${keyLabel()}): the CLI reported a fatal error on ` +
        `the PRIMARY model stream, so the remaining ${ms}ms of the time bound would have bought nothing but a ` +
        `wrong diagnosis. NO template fallback.${artifact} ` +
        renderInferenceDiagnostic(classification, errors, stderr),
      {
        kind: classification.kind,
        provider,
        model,
        providerType: classification.error?.providerType ?? "",
        statusCode: classification.error?.statusCode ?? null,
        retryable: classification.retryable,
      },
    );
  }
  if (outcome === "timeout") {
    const artifact = options.diagnosticArtifactPath ? ` artifact=${options.diagnosticArtifactPath}.` : "";
    throw new InferenceFailure(
      `opencode inference timed out after ${ms}ms for model '${model}' (${keyLabel()}); ` +
        `primaryStreamObserved=${primaryStreamObserved}. NO template fallback.${artifact} ` +
        `Bounded redacted diagnostic tail: stdout=${JSON.stringify(boundedTail(stdout, prompt))} ` +
        `stderr=${JSON.stringify(boundedTail(stderr, prompt))}. cause=timed-out — ${inferenceFailureAction("timed-out")}`,
      { kind: "timed-out", provider, model },
    );
  }
  const text = extractAssistantText(stdout);
  if (!text) {
    const diagnosticRedactions = inferenceRedactions(prompt);
    throw emptyTranscriptFailure(
      redactTelemetryText(stdout, diagnosticRedactions),
      redactTelemetryText(stderr, diagnosticRedactions),
      model,
      provider,
      exitCode!,
    );
  }
  // R19 — what this take COST, read out of the transcript the run already
  // produced. null when the CLI reported no `step_finish` step; never zeroes.
  const spend = transcriptSpend(stdout);
  emit(
    "completion",
    `assistantTextParts=${assistantTextParts(stdout).length}` +
      (spend ? ` tokens=${spend.totalTokens} costUsd=${spend.costUsd}` : " spend=unreported"),
  );
  return { text, model, spend };
}

export interface AuthoredTake extends ParsedTake {
  model: string;
  /**
   * What the provider says this take cost (R19), or null when it reported
   * nothing. Metadata ABOUT the take, never part of it: it is not digested,
   * not signed, and not shown to any model — the take's bytes are the member's
   * prose and nothing else.
   *
   * ON A RE-SAMPLE this is the spend of the ATTEMPT THAT WAS KEPT, not of every
   * attempt. A structure-contract retry is a discarded sample, and a figure
   * that silently summed discarded samples would make one member's take look
   * three times more expensive than another's identical one.
   */
  spend: TranscriptSpend | null;
}

// Author one swarm member's take with a REAL opencode-zen call.
// Throws (no fallback) when opencode is unavailable or the transcript is empty.
// Returns the stored body (control line stripped) plus the parsed
// stance/confidence.
//
// A sample that parses but omits a required section (see TAKE_SECTION_LEAD_INS)
// is re-sampled up to `structureAttempts` times. Only the SECTION contract is
// retried: parseStanceFromBody's own failures — a missing or out-of-vocabulary
// STANCE/CONFIDENCE control line — still throw on the first attempt, because
// #301/#319 settled that a member who cannot state a stance is ABSENT rather
// than coaxed. When every attempt omits a section the member is likewise
// rendered absent (session.ts settles per-member failures into a no-show); the
// take is never patched, re-headed, or otherwise fabricated into compliance.
export async function authorTake(
  p: Persona,
  regime: RegimeContext,
  subjectId: string,
  options: AuthorTakeOptions = {},
): Promise<AuthoredTake> {
  const attempts = Math.max(1, options.structureAttempts ?? DEFAULT_STRUCTURE_ATTEMPTS);
  const prompt = promptFor(p, regime, subjectId, { requireWeights: options.requireWeights });
  let shortfall = "";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const authored = await runOpencode(prompt, options);
    const parsed = parseStanceFromBody(authored.text);
    // THE ALLOCATION IS PART OF THE STRUCTURE CONTRACT, and is read FIRST —
    // `parseStanceFromBody` uncovered the WEIGHTS line by stripping the STANCE
    // line, and `missingSectionLeadIns` must run against the body the member
    // will actually STORE, i.e. with the WEIGHTS line already removed.
    //
    // A malformed vector RE-SAMPLES rather than throwing on the first attempt,
    // which is the `missingSectionLeadIns` rule and deliberately not the
    // `parseStanceFromBody` one: a dropped section and a dropped control line
    // are both unlucky samples, while a stance OUTSIDE the vocabulary is a model
    // saying something else entirely. Nothing is ever patched into compliance.
    let body = parsed.body;
    let weights: TakeWeight[] | undefined;
    if (options.requireWeights) {
      try {
        const withWeights = parseWeightsFromBody(parsed.body);
        weights = withWeights.weights;
        body = withWeights.body;
      } catch (err) {
        shortfall = err instanceof Error ? err.message : String(err);
        console.warn(`[inference] ${p.memberId}: take attempt ${attempt}/${attempts} — ${shortfall} — re-sampling`);
        continue;
      }
    }
    const missing = missingSectionLeadIns(body);
    if (missing.length === 0) {
      return { ...parsed, body, ...(weights ? { weights } : {}), model: authored.model, spend: authored.spend };
    }
    shortfall = `omitted the ${missing.join(", ")} section${missing.length === 1 ? "" : "s"}`;
    console.warn(
      `[inference] ${p.memberId}: take attempt ${attempt}/${attempts} omitted ${missing.join(", ")} — re-sampling`,
    );
  }

  throw new Error(
    `model take for ${p.memberId} failed the structure contract on all ${attempts} attempt${attempts === 1 ? "" : "s"} ` +
      `(${shortfall}) — the member is rendered ABSENT, never patched into compliance with a synthesized section ` +
      `or a synthesized allocation.`,
  );
}
