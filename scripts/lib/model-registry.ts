// The single authoritative map from a short, stable NAME an operator types to
// the exact OpenCode Zen model id we call — and the one env signal that selects
// between them.
//
// ── Why a registry instead of a raw model-id env var ────────────────────────
// Zen's catalogue churns: ids get version-bumped (`kimi-k2.6` → `kimi-k2.7-code`),
// models are retired upstream while still listed (`claude-sonnet-4` answers
// "not supported on the full model list"), and the free tier's naming is
// inconsistent (every keyless model carries a `-free` suffix EXCEPT
// `big-pickle`). Spreading raw ids across workflows, compose files, and four
// call sites means each one rots independently and silently.
//
// So the values live HERE, in versioned source, and the environment carries
// only a selector — one signal, not a knob per property. A CI workflow or a
// container says `AGENT_MODEL=deepseek`; which deepseek that is remains a code
// review away, not an `export` someone did months ago.
//
// ── The selector ───────────────────────────────────────────────────────────
//   AGENT_MODEL unset          → DEFAULT_AGENT_MODEL (deepseek's own default)
//   AGENT_MODEL=deepseek       → that family's pinned default member
//   AGENT_MODEL=deepseek/v4-pro→ that exact member
//   AGENT_MODEL=opencode/<id>  → raw escape hatch, straight through unmapped
//
// The escape hatch exists because Zen ships models faster than we review this
// file; it is deliberately the only form that bypasses validation, and it is
// obvious at a glance that it has.
//
// An unknown family or member THROWS, listing what is valid. It never falls
// back to the default — silently running a different model than the one asked
// for is how a benchmark result becomes a lie.

/** Env var selecting the model. One signal; values live in this file. */
export const AGENT_MODEL_ENV = "AGENT_MODEL";
/** How the opencode CLI namespaces every OpenCode Zen model. */
export const ZEN_PREFIX = "opencode/";

export interface ModelFamily {
  /** Member key used when the operator names the family alone. */
  default: string;
  /** Short member name → Zen model id (without the `opencode/` prefix). */
  models: Record<string, string>;
  /** True when every member is served by Zen's no-credential free tier. */
  keyless?: boolean;
  /** Why this family's default is what it is. */
  note: string;
}

// Verified live against Zen on 2026-07-28 with a funded key: every id below
// returned a real completion through the opencode CLI.
export const MODEL_FAMILIES: Record<string, ModelFamily> = {
  deepseek: {
    default: "v4-flash",
    models: { "v4-flash": "deepseek-v4-flash", "v4-pro": "deepseek-v4-pro" },
    note: "Repo default. Fast, cheap ($0.95/$4 per 1M), and — unlike the Claude family on Zen — it does NOT refuse the committee-take persona.",
  },
  kimi: {
    default: "k2.7-code",
    models: { "k2.7-code": "kimi-k2.7-code", "k2.6": "kimi-k2.6", "k2.5": "kimi-k2.5", k3: "kimi-k3" },
    note: "Strongest verified agentic tool-use in the member-agent container; recovered unaided from a missing-binary exit 127.",
  },
  claude: {
    default: "sonnet-5",
    models: { "sonnet-5": "claude-sonnet-5", "haiku-4-5": "claude-haiku-4-5", "opus-5": "claude-opus-5", "fable-5": "claude-fable-5" },
    note: "CAUTION: Zen's Claude models carry an OpenCode coding-assistant framing that fights persona prompts — haiku-4-5 refused the committee take outright, sonnet-5 went off-format. Fine for agentic/coding work, unreliable for persona authoring.",
  },
  gpt: {
    default: "5.4",
    models: { "5.4": "gpt-5.4", "5.4-mini": "gpt-5.4-mini", "5.4-nano": "gpt-5.4-nano", "5.5": "gpt-5.5", "5-codex": "gpt-5-codex", "5.3-codex": "gpt-5.3-codex" },
    note: "Authored a well-formed committee take. Codex members need the CLI (the raw OpenAI-compatible REST shape 400s for them).",
  },
  glm: { default: "5.2", models: { "5.2": "glm-5.2", "5.1": "glm-5.1", "5": "glm-5" }, note: "Verified working." },
  minimax: { default: "m3", models: { m3: "minimax-m3", "m2.7": "minimax-m2.7", "m2.5": "minimax-m2.5" }, note: "Verified working; verbose." },
  qwen: { default: "3.6-plus", models: { "3.6-plus": "qwen3.6-plus", "3.5-plus": "qwen3.5-plus" }, note: "Verified working; verbose." },
  grok: { default: "4.5", models: { "4.5": "grok-4.5", "build-0.1": "grok-build-0.1" }, note: "Verified working; verbose." },
  gemini: {
    default: "3-flash",
    models: { "3-flash": "gemini-3-flash", "3.6-flash": "gemini-3.6-flash", "3.1-pro": "gemini-3.1-pro" },
    note: "Works through the opencode CLI only — Zen's OpenAI-compatible REST endpoint wants native Gemini `contents` and 400s otherwise.",
  },
  // Cross-vendor by construction: this family groups by BILLING, not by maker —
  // "give me something that needs no credit". That is the property a caller
  // actually selects on when it must run unfunded.
  free: {
    default: "nemotron-3-ultra",
    models: {
      "nemotron-3-ultra": "nemotron-3-ultra-free",
      "ling-3.0-flash": "ling-3.0-flash-free",
      "north-mini-code": "north-mini-code-free",
      "big-pickle": "big-pickle",
    },
    keyless: true,
    note: "No credential, no credit. AVOID big-pickle: it is saturated upstream (429 on 5/5 and 3/3 probes from this host while sibling free models returned 200 at the same instant) and has no paid tier to escape to — its cost is 0 across every field with no paid sibling in Zen's catalogue.",
  },
};

/** The family used when AGENT_MODEL is unset. */
export const DEFAULT_FAMILY = "deepseek";

function fullId(family: ModelFamily, member: string): string {
  return `${ZEN_PREFIX}${family.models[member]}`;
}

/** The model every path uses with no AGENT_MODEL configured. */
export const DEFAULT_AGENT_MODEL = fullId(MODEL_FAMILIES[DEFAULT_FAMILY]!, MODEL_FAMILIES[DEFAULT_FAMILY]!.default);

/**
 * Resolve the configured selector to a full `opencode/<id>`.
 *
 * Throws on an unknown family or member rather than falling back — see the
 * module comment on why a silent substitution is worse than a hard failure.
 */
export function resolveAgentModel(env: Record<string, string | undefined> = process.env): string {
  const raw = env[AGENT_MODEL_ENV]?.trim();
  if (!raw) return DEFAULT_AGENT_MODEL;

  // Escape hatch: an explicit, fully-qualified Zen id goes through unmapped.
  if (raw.startsWith(ZEN_PREFIX)) return raw;

  const [familyName, memberName, ...rest] = raw.split("/");
  if (rest.length > 0) {
    throw new Error(
      `${AGENT_MODEL_ENV}=${raw} is malformed. Expected "<family>", "<family>/<model>", or a raw "${ZEN_PREFIX}<id>".`,
    );
  }
  const family = MODEL_FAMILIES[familyName!];
  if (!family) {
    throw new Error(
      `${AGENT_MODEL_ENV}=${raw} names an unknown model family "${familyName}". ` +
        `Known families: ${Object.keys(MODEL_FAMILIES).join(", ")}. ` +
        `Refusing to fall back to the default (${DEFAULT_AGENT_MODEL}) — a run must use the model it was asked for.`,
    );
  }
  const member = memberName?.trim() || family.default;
  if (!family.models[member]) {
    throw new Error(
      `${AGENT_MODEL_ENV}=${raw} names an unknown model "${member}" in family "${familyName}". ` +
        `Known ${familyName} models: ${Object.keys(family.models).join(", ")}.`,
    );
  }
  return fullId(family, member);
}

/**
 * True when `model` is served by Zen's free tier and so needs no credit.
 * Derived from the registry, never a second hand-maintained list.
 */
export function isKeylessModel(model: string): boolean {
  const id = model.startsWith(ZEN_PREFIX) ? model.slice(ZEN_PREFIX.length) : model;
  return Object.values(MODEL_FAMILIES).some((f) => f.keyless && Object.values(f.models).includes(id));
}

/** Human-readable catalogue, for `--help`-style output and error messages. */
export function describeFamilies(): string {
  return Object.entries(MODEL_FAMILIES)
    .map(([name, f]) => `  ${name}/${f.default} (default)  members: ${Object.keys(f.models).join(", ")}`)
    .join("\n");
}

/**
 * The pinned keyless model, for callers that must NOT hold a credential —
 * currently the contribution-advisory reviewer, which reads untrusted PR diffs
 * and posts model output publicly. Resolved from the `free` family so it tracks
 * the catalogue rather than rotting as a second hardcoded id.
 */
export function keylessModel(): string {
  const free = MODEL_FAMILIES.free!;
  return `${ZEN_PREFIX}${free.models[free.default]}`;
}
