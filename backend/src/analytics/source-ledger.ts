import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { Point } from "./types.ts";

export type CacheStatus = "disabled" | "hit" | "miss";
export type AcquisitionEventType = "started" | "succeeded" | "failed";

export interface SourceFetchEvidence {
  id: string;
  sequence: number;
  requestIdentity: { method: "GET"; url: string; headers: Record<string, string> };
  cacheStatus: CacheStatus;
  responseStatus: number | null;
  responseChecksum: string | null;
  payloadBase64: string | null;
  providerReleaseId: string | null;
  errorDetail: string | null;
}

export interface SourceValueEvidence {
  sourceKey: string;
  marketDate: string | null;
  marketInstant: string | null;
  value: number;
}

export interface SourceAcquisitionEvidence {
  id: string;
  provider: string;
  parserVersion: string;
  cacheIdentity: string;
  requestedByRunId: number | null;
  events: { type: AcquisitionEventType; detail: string | null }[];
  fetches: SourceFetchEvidence[];
  values: SourceValueEvidence[];
}

export interface AcquisitionSink {
  saveSourceAcquisition(evidence: SourceAcquisitionEvidence): Promise<{ acquisitionId: string; replayed: boolean }>;
}

interface ActiveAcquisition {
  evidence: SourceAcquisitionEvidence;
}

const active = new AsyncLocalStorage<ActiveAcquisition>();

const SECRET_QUERY_KEYS = /^(api_?key|token|access_?token|secret|password|credential|authorization)$/i;
const SECRET_HEADER_KEYS = /^(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)$/i;

export function redactRequestIdentity(urlText: string, headers: Record<string, string> = {}): SourceFetchEvidence["requestIdentity"] {
  const url = new URL(urlText);
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_QUERY_KEYS.test(key)) url.searchParams.set(key, "[REDACTED]");
  }
  const safeHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    safeHeaders[key.toLowerCase()] = SECRET_HEADER_KEYS.test(key) ? "[REDACTED]" : value;
  }
  return { method: "GET", url: url.toString(), headers: safeHeaders };
}

export function payloadChecksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeError(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error);
  text = text.replace(/([?&](?:api_?key|token|access_?token|secret|password|credential)=)[^&\s]+/gi, "$1[REDACTED]");
  text = text.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
  return text.slice(0, 2000);
}

export function recordSourceFetch(input: {
  url: string;
  headers?: Record<string, string>;
  cacheStatus: CacheStatus;
  responseStatus?: number | null;
  payload?: Uint8Array | null;
  providerReleaseId?: string | null;
  error?: unknown;
}): void {
  const state = active.getStore();
  if (!state) return;
  const payload = input.payload ?? null;
  state.evidence.fetches.push({
    id: randomUUID(),
    sequence: state.evidence.fetches.length + 1,
    requestIdentity: redactRequestIdentity(input.url, input.headers),
    cacheStatus: input.cacheStatus,
    responseStatus: input.responseStatus ?? null,
    responseChecksum: payload ? payloadChecksum(payload) : null,
    payloadBase64: payload ? Buffer.from(payload).toString("base64") : null,
    providerReleaseId: input.providerReleaseId ?? null,
    errorDetail: input.error === undefined ? null : safeError(input.error),
  });
}

export async function captureSourceAcquisition<T = Point[]>(
  input: {
    provider: string;
    sourceKey: string;
    parserVersion: string;
    cacheIdentity: string;
    requestedByRunId?: number | null;
    marketTime?: "date" | "instant";
    points?: (result: T) => Point[];
  },
  sink: AcquisitionSink,
  operation: () => Promise<T>,
): Promise<T> {
  const evidence: SourceAcquisitionEvidence = {
    id: randomUUID(),
    provider: input.provider,
    parserVersion: input.parserVersion,
    cacheIdentity: input.cacheIdentity,
    requestedByRunId: input.requestedByRunId ?? null,
    events: [{ type: "started", detail: null }],
    fetches: [],
    values: [],
  };
  let result: T;
  try {
    result = await active.run({ evidence }, operation);
  } catch (error) {
    evidence.events.push({ type: "failed", detail: safeError(error) });
    await sink.saveSourceAcquisition(evidence);
    throw error;
  }
  const points = input.points ? input.points(result) : result as Point[];
  evidence.values = points.map((point) => ({
    sourceKey: input.sourceKey,
    marketDate: input.marketTime === "instant" ? null : point.date,
    marketInstant: input.marketTime === "instant" ? new Date(point.date).toISOString() : null,
    value: point.value,
  }));
  evidence.events.push({ type: "succeeded", detail: null });
  await sink.saveSourceAcquisition(evidence);
  return result;
}
