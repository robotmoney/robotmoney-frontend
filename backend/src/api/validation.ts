import type { ApplyInput, SubmissionInput } from "../committee/domain.ts";
import { STANCES, type canonicalizeSubmission } from "@robotmoney/contract";

export type JsonObject = Record<string, unknown>;

const STANCE_SET: ReadonlySet<string> = new Set(STANCES);

const SIGNING_KEYS = new Set([
  "memberId",
  "date",
  "subjectId",
  "nonce",
  "stance",
  "confidence",
  "body",
  "memoUrl",
  "weights",
]);

const SUBMISSION_KEYS = new Set([
  "memberId",
  "date",
  "subjectId",
  "nonce",
  "stance",
  "confidence",
  "body",
  "memoUrl",
  "weights",
  "signature",
]);

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

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

function optionalWeights(body: JsonObject): { bucket: string; weight: number }[] | null | undefined {
  if (body.weights == null) return undefined;
  if (!Array.isArray(body.weights) || body.weights.length === 0) return null;

  const seen = new Set<string>();
  const weights: { bucket: string; weight: number }[] = [];
  let total = 0;
  for (const entry of body.weights) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const bucket = requiredString(entry as JsonObject, "bucket", 100);
    const weight = (entry as JsonObject).weight;
    if (!bucket || seen.has(bucket) || typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) return null;
    seen.add(bucket);
    weights.push({ bucket, weight });
    total += weight;
  }
  return total > 0 && Number.isFinite(total) ? weights : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}


// §11 R2/R6 — the public onboarding shape carries NO client-supplied id: the
// server mints the member UUID at apply time. It DOES carry the rmpc
// signature over the canonical application payload (@robotmoney/contract);
// route-layer verification (backend/src/api/routes/committee.ts) rejects an
// unsigned/malformed request before ic.applyMember ever runs. `contact` is
// required here (non-empty, matching the canonical payload's required field —
// see contract/src/committee-application.js) — the route additionally checks
// email FORMAT on top of this non-empty check.
export function parseApply(body: JsonObject | null): ApplyInput | null {
  if (!body) return null;
  const name = requiredString(body, "name", 200);
  const contact = requiredString(body, "contact", 320);
  const publicKey = requiredString(body, "publicKey", 1000);
  const signature = requiredString(body, "signature", 2000);
  if (!name || !contact || !publicKey || !signature) return null;
  return {
    name,
    contact,
    publicKey,
    signature,
    lens: optionalString(body, "lens", 500),
  };
}

export function validateSubmission(
  body: JsonObject | null,
): ValidationResult<SubmissionInput> {
  if (!body) return { ok: false, error: "invalid submission" };

  const unknown = Object.keys(body).filter((k) => !SUBMISSION_KEYS.has(k));
  if (unknown.length) {
    return { ok: false, error: `unknown field: ${unknown.join(", ")}` };
  }

  const memberId = requiredString(body, "memberId", 100);
  const date = requiredString(body, "date", 10);
  const subjectId = requiredString(body, "subjectId", 100);
  const nonce = requiredString(body, "nonce", 200);
  const stance = requiredString(body, "stance", 100);
  const signature = requiredString(body, "signature", 2000);
  const confidence = body.confidence;
  const weights = optionalWeights(body);

  if (typeof body.stance === "string") {
    const s = body.stance.trim();
    if (!STANCE_SET.has(s)) {
      return {
        ok: false,
        error: `stance must be one of ${STANCES.join(", ")}`,
      };
    }
  }

  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: "date must be YYYY-MM-DD" };
  }

  if (
    confidence !== undefined &&
    (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
  ) {
    return { ok: false, error: "confidence must be a number between 0 and 1" };
  }

  if (weights === null) {
    return { ok: false, error: "invalid weights" };
  }

  if (
    !memberId || !date || !subjectId || !nonce || !stance || !signature ||
    typeof confidence !== "number"
  ) {
    return { ok: false, error: "invalid submission" };
  }

  return {
    ok: true,
    data: {
      memberId,
      date,
      subjectId,
      nonce,
      stance,
      confidence,
      signature,
      body: optionalString(body, "body", 10_000),
      memoUrl: optionalString(body, "memoUrl", 2000),
      weights,
    },
  };
}

export function parseSubmission(body: JsonObject | null): SubmissionInput | null {
  const res = validateSubmission(body);
  return res.ok ? res.data : null;
}

export function validateSigningDraft(
  body: JsonObject | null,
): ValidationResult<Parameters<typeof canonicalizeSubmission>[0]> {
  if (!body) return { ok: false, error: "invalid signing draft" };

  const unknown = Object.keys(body).filter((k) => !SIGNING_KEYS.has(k));
  if (unknown.length) {
    return { ok: false, error: `unknown field: ${unknown.join(", ")}` };
  }

  const memberId = requiredString(body, "memberId", 100);
  const date = requiredString(body, "date", 10);
  const subjectId = requiredString(body, "subjectId", 100);
  const nonce = requiredString(body, "nonce", 200);
  const stance = requiredString(body, "stance", 100);
  const confidence = body.confidence;
  const weights = optionalWeights(body);

  if (typeof body.stance === "string") {
    const s = body.stance.trim();
    if (!STANCE_SET.has(s)) {
      return {
        ok: false,
        error: `stance must be one of ${STANCES.join(", ")}`,
      };
    }
  }

  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: "date must be YYYY-MM-DD" };
  }

  if (
    confidence !== undefined &&
    (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
  ) {
    return { ok: false, error: "confidence must be a number between 0 and 1" };
  }

  if (weights === null) {
    return { ok: false, error: "invalid weights" };
  }

  if (
    !memberId || !date || !subjectId || !nonce || !stance ||
    typeof confidence !== "number"
  ) {
    return { ok: false, error: "invalid signing draft" };
  }

  return {
    ok: true,
    data: {
      memberId,
      date,
      subjectId,
      nonce,
      stance,
      confidence,
      body: optionalString(body, "body", 10_000),
      memoUrl: optionalString(body, "memoUrl", 2000),
      weights,
    },
  };
}

export function parseSigningDraft(
  body: JsonObject | null,
): Parameters<typeof canonicalizeSubmission>[0] | null {
  const res = validateSigningDraft(body);
  return res.ok ? res.data : null;
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
