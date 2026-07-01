import type { ApplyInput, SubmissionInput } from "../committee/domain.ts";
import type { canonicalizeSubmission } from "@robotmoney/contract";

export type JsonObject = Record<string, unknown>;

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

export function parseApply(body: JsonObject | null): ApplyInput | null {
  if (!body) return null;
  const memberId = requiredString(body, "memberId", 100);
  const name = requiredString(body, "name", 200);
  const publicKey = requiredString(body, "publicKey", 1000);
  if (!memberId || !name || !publicKey) return null;
  return {
    memberId,
    name,
    publicKey,
    lens: optionalString(body, "lens", 500),
    contact: optionalString(body, "contact", 320),
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
  if (
    !memberId || !date || !subjectId || !nonce || !stance || !signature ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    typeof confidence !== "number" || !Number.isFinite(confidence) ||
    confidence < 0 || confidence > 1
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
  if (
    !memberId || !date || !subjectId || !nonce || !stance ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    typeof confidence !== "number" || !Number.isFinite(confidence) ||
    confidence < 0 || confidence > 1
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
  };
}

export function parsePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
