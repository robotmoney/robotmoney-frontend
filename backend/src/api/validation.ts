import type { ApplyInput, SubmissionInput } from "../committee/domain.ts";
import type { canonicalizeSubmission } from "@robotmoney/contract";

export type JsonObject = Record<string, unknown>;

function optionalWeights(value: unknown): Record<string, number> | undefined | null {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 32) return null;
  const out: Record<string, number> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim();
    if (!key || key.length > 100 || typeof rawValue !== "number" || !Number.isFinite(rawValue)) return null;
    out[key] = rawValue;
  }
  return out;
}

export async function readJsonObject(req: Request): Promise<JsonObject | null> {
  const value = await req.json().catch(() => null);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

export function requiredString(
  body: JsonObject,
  key: string,
  max = 4000,
): string | null {
  const value = body[key];
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : null;
}

export function optionalString(
  body: JsonObject,
  key: string,
  max = 4000,
): string | undefined {
  if (body[key] == null || body[key] === "") return undefined;
  const value = requiredString(body, key, max);
  return value ?? undefined;
}

function optionalStringArray(body: JsonObject, key: string, maxItems = 20, maxLength = 500): string[] | undefined | null {
  if (body[key] == null) return undefined;
  if (!Array.isArray(body[key]) || body[key].length > maxItems) return null;
  const values = body[key].map((value) => typeof value === "string" ? value.trim() : "");
  if (values.some((value) => !value || value.length > maxLength)) return null;
  return values;
}

export function parseApply(body: JsonObject | null): ApplyInput | null {
  if (!body) return null;
  const memberId = requiredString(body, "memberId", 100);
  const name = requiredString(body, "name", 200);
  const publicKey = requiredString(body, "publicKey", 1000);
  const keyProofSignature = requiredString(body, "keyProofSignature", 2000);
  const biases = optionalStringArray(body, "biases");
  const wallets = optionalStringArray(body, "wallets", 20, 200);
  if (!memberId || !name || !publicKey || !keyProofSignature || biases === null || wallets === null) return null;
  return {
    memberId,
    name,
    publicKey,
    keyProofSignature,
    lens: optionalString(body, "lens", 500),
    contact: optionalString(body, "contact", 320),
    operator: optionalString(body, "operator", 200),
    thesis: optionalString(body, "thesis", 1000),
    mandate: optionalString(body, "mandate", 2000),
    biases,
    voiceMd: optionalString(body, "voiceMd", 10_000),
    wallets,
    avatar: optionalString(body, "avatar", 2000),
  };
}

export function parseSubmission(body: JsonObject | null): SubmissionInput | null {
  if (!body) return null;
  const memberId = requiredString(body, "memberId", 100);
  const date = requiredString(body, "date", 10);
  const subjectId = requiredString(body, "subjectId", 100);
  const nonce = requiredString(body, "nonce", 200);
  const stance = requiredString(body, "stance", 100);
  const signature = requiredString(body, "signature", 2000);
  const confidence = body.confidence;
  const proposedWeights = optionalWeights(body.proposedWeights);
  if (
    !memberId || !date || !subjectId || !nonce || !stance || !signature ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    typeof confidence !== "number" || !Number.isFinite(confidence) ||
    confidence < 0 || confidence > 1 || proposedWeights === null
  ) return null;
  return {
    memberId,
    date,
    subjectId,
    nonce,
    stance,
    confidence,
    signature,
    body: optionalString(body, "body", 10_000),
    memoUrl: optionalString(body, "memoUrl", 2000),
    proposedWeights,
  };
}

export function parseSigningDraft(
  body: JsonObject | null,
): Parameters<typeof canonicalizeSubmission>[0] | null {
  if (!body) return null;
  const memberId = requiredString(body, "memberId", 100);
  const date = requiredString(body, "date", 10);
  const subjectId = requiredString(body, "subjectId", 100);
  const nonce = requiredString(body, "nonce", 200);
  const stance = requiredString(body, "stance", 100);
  const confidence = body.confidence;
  const proposedWeights = optionalWeights(body.proposedWeights);
  if (
    !memberId || !date || !subjectId || !nonce || !stance ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    typeof confidence !== "number" || !Number.isFinite(confidence) ||
    confidence < 0 || confidence > 1 || proposedWeights === null
  ) return null;
  return {
    memberId,
    date,
    subjectId,
    nonce,
    stance,
    confidence,
    body: optionalString(body, "body", 10_000),
    memoUrl: optionalString(body, "memoUrl", 2000),
    proposedWeights,
  };
}

export function parsePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

// ── Admin surface DTOs (issue #152) ─────────────────────────────────────────

export function parseSubjectCreate(body: JsonObject | null): {
  id: string; name: string; operator?: string; homepage?: string; xHandle?: string; thesisBlurb?: string;
  wallets?: unknown; nftContracts?: unknown; source?: unknown; recommendationType?: string;
  linkedMemberId?: string; structuralNotes?: unknown; lastReviewed?: string;
} | null {
  if (!body) return null;
  const id = requiredString(body, "id", 100);
  const name = requiredString(body, "name", 200);
  if (!id || !name) return null;
  return {
    id, name,
    operator: optionalString(body, "operator", 200),
    homepage: optionalString(body, "homepage", 500),
    xHandle: optionalString(body, "xHandle", 200),
    thesisBlurb: optionalString(body, "thesisBlurb", 4000),
    wallets: body.wallets,
    nftContracts: body.nftContracts,
    source: body.source,
    recommendationType: optionalString(body, "recommendationType", 100),
    linkedMemberId: optionalString(body, "linkedMemberId", 100),
    structuralNotes: body.structuralNotes,
    lastReviewed: optionalString(body, "lastReviewed", 10),
  };
}

export function parseExpectedVersion(body: JsonObject | null): number | null {
  const v = body?.expectedVersion;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
}

export function parseManualMember(body: JsonObject | null): {
  memberId: string; name: string; publicKey: string; lens?: string; contact?: string;
} | null {
  if (!body) return null;
  const memberId = requiredString(body, "memberId", 100);
  const name = requiredString(body, "name", 200);
  const publicKey = requiredString(body, "publicKey", 1000);
  if (!memberId || !name || !publicKey) return null;
  return { memberId, name, publicKey, lens: optionalString(body, "lens", 500), contact: optionalString(body, "contact", 320) };
}

export function parseSessionCreate(body: JsonObject | null): {
  date: string; subjectId: string; briefOpensAt: string; windowClosesAt: string; publishAt: string;
} | null {
  if (!body) return null;
  const date = requiredString(body, "date", 10);
  const subjectId = requiredString(body, "subjectId", 100);
  const briefOpensAt = requiredString(body, "briefOpensAt", 40);
  const windowClosesAt = requiredString(body, "windowClosesAt", 40);
  const publishAt = requiredString(body, "publishAt", 40);
  if (!date || !subjectId || !briefOpensAt || !windowClosesAt || !publishAt) return null;
  return { date, subjectId, briefOpensAt, windowClosesAt, publishAt };
}
